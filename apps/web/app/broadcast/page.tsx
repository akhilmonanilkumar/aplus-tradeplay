"use client";

import { useState } from "react";
import { normalizeModel, ENTRY_MODELS, mrr } from "@aplus/engine";
import { supabase } from "@/lib/supabase";
import { useRows } from "@/lib/useRows";
import { istDay } from "@/lib/derive";
import type { Plan, Signal, TgMember, TgPost } from "@/lib/types";
import { money, num, timeShort } from "@/lib/fmt";
import { useMe, type Settings } from "@/components/Shell";
import { Card, Chip, Empty, ErrorNote, Note, Table, Toggle } from "@/components/ui";

const EVENTS: { k: string; n: string; d: string }[] = [
  { k: "armed", n: "Signal armed", d: "Entry, stop, target, R:R the moment the gate says GO" },
  { k: "filled", n: "Order filled", d: "Fill price on the master" },
  { k: "closed", n: "Trade closed", d: "Result in R, net of fees — wins and losses" },
  { k: "bias", n: "Daily bias report", d: "Allowed direction, magnet, invalidation" },
  { k: "invalid", n: "Setup invalidated", d: "When a planned idea fails a box" },
  { k: "weekly", n: "Weekly recap", d: "Every signal of the week with results" },
  { k: "delay_free", n: "Delay free group", d: "Free group sees a signal only after it closes" },
];
const INSTS = [{ k: "XAUUSD", why: "NY Q · 1H/15M/5M" }, { k: "BTCUSDT.P", why: "NY Q · 4H/15M/5M · mark price" }, { k: "GOLDM", why: "MCX · own account only" }];

function preview(s: Signal | null) {
  if (!s) return "No armed signal yet.";
  const m = normalizeModel(s.model);
  return [
    `${s.instrument} · ${s.side.toUpperCase()} · ARMED`,
    `Model ${m} · ${ENTRY_MODELS[m].name}`,
    `Entry ${num(Number(s.entry), 2)} (limit)`,
    `Stop  ${num(Number(s.stop), 2)}`,
    `Target ${num(Number(s.target), 2)}`,
    `R:R   ${s.rr ? num(Number(s.rr), 2) : "—"}`,
    "",
    "Risk a fixed % · no chasing · educational, not advice",
  ].join("\n");
}

export default function Broadcast() {
  const me = useMe();
  const members = useRows<TgMember>({ table: "tg_members", select: "id,status,paid_until,plan_id", limit: 10000 });
  const posts = useRows<TgPost>({ table: "tg_posts", order: "created_at", limit: 30 });
  const signals = useRows<Signal>({ table: "signals", order: "created_at", limit: 60 });
  const plans = useRows<Plan>({ table: "subscription_plans", order: "months", ascending: true });
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const b: Settings["broadcast"] = me.settings?.broadcast ?? { vip: true, free: true, instruments: {}, events: {} };
  const setB = (patch: Partial<Settings["broadcast"]>) => me.updateSettings({ broadcast: { ...b, ...patch } });

  const m = members.rows ?? [];
  const active = m.filter((x) => x.status === "active" || x.status === "expiring");
  const expiring = m.filter((x) => x.paid_until && +new Date(x.paid_until) - Date.now() < 7 * 86_400_000 && +new Date(x.paid_until) > Date.now()).length;
  const since30 = Date.now() - 30 * 86_400_000;
  const published = (posts.rows ?? []).filter((p) => p.status === "sent" && p.sent_at && +new Date(p.sent_at) >= since30 && p.kind.toLowerCase().includes("signal")).length;
  const activeOn = (id: string) => active.filter((x) => x.plan_id === id).length;
  const monthly = mrr((plans.rows ?? []).map((p) => ({ price: Number(p.price_inr), months: p.months, active: activeOn(p.id) })));
  const armed = (signals.rows ?? []).find((s) => s.state === "ARMED") ?? null;

  const queue = async () => {
    if (!armed) return;
    if (!b.instruments[armed.instrument]) return setMsg({ ok: false, t: `${armed.instrument} is switched off for publishing` });
    const destination = b.vip && b.free && !b.events.delay_free ? "both" : b.vip ? "vip" : "free";
    const { error } = await supabase.from("tg_posts").insert({ destination, kind: `${armed.instrument} ${armed.side} · ARMED`, signal_id: armed.id, status: "queued" });
    setMsg(error ? { ok: false, t: error.message } : { ok: true, t: "Queued for the Telegram bot" });
    posts.reload();
  };

  const row = (k: string, n: string, d: string, on: boolean, set: (v: boolean) => void) => (
    <div key={k} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: 10, alignItems: "center", padding: "10px 0", borderBottom: "1px solid var(--line)", fontSize: 12.5 }}>
      <div className="col" style={{ gap: 1 }}><b style={{ fontWeight: 500 }}>{n}</b><span className="faint" style={{ fontSize: 11.5 }}>{d}</span></div>
      <Toggle on={on} onChange={set} label={n} />
    </div>
  );

  return (
    <>
      <ErrorNote error={members.error || posts.error} />
      {msg && <Note tone={msg.ok ? "up" : "down"}>{msg.t}</Note>}
      <section className="g12">
        <div className="card s3"><div className="lbl">Active subscribers</div><div className="kv" style={{ marginTop: 6 }}>{active.length}</div><div className="faint" style={{ fontSize: 12 }}>VIP channel · {expiring} expiring this week</div></div>
        <div className="card s3"><div className="lbl">Group members</div><div className="kv" style={{ marginTop: 6 }}>{m.filter((x) => x.status === "free").length}</div><div className="faint" style={{ fontSize: 12 }}>Free group · delayed posts</div></div>
        <div className="card s3"><div className="lbl">Signals published · 30d</div><div className="kv" style={{ marginTop: 6 }}>{published}</div><div className="faint" style={{ fontSize: 12 }}>every signal, wins and losses</div></div>
        <div className="card s3"><div className="lbl">Monthly revenue</div><div className="kv" style={{ marginTop: 6 }}>{(plans.rows ?? []).length ? money(monthly, "INR", 0) : "Set prices"}</div><div className="faint" style={{ fontSize: 12 }}>MRR from plan prices</div></div>
      </section>

      <section className="g12">
        <Card span={4} title="Destinations">
          {row("vip", "A+ Tradeplay VIP · channel", "Paid · instant posts · bot is admin", b.vip, (v) => setB({ vip: v }))}
          {row("free", "A+ Tradeplay Community · group", "Free · posts delayed until the trade closes", b.free, (v) => setB({ free: v }))}
          <div className="lbl-u" style={{ margin: "14px 0 4px" }}>Publish by instrument</div>
          {INSTS.map((i) => row(i.k, i.k === "GOLDM" ? "MCX GOLDM" : i.k, i.why, !!b.instruments[i.k], (v) => setB({ instruments: { ...b.instruments, [i.k]: v } })))}
        </Card>
        <Card span={4} title="What gets posted">
          {EVENTS.map((e) => row(e.k, e.n, e.d, !!b.events[e.k], (v) => setB({ events: { ...b.events, [e.k]: v } })))}
        </Card>
        <Card span={4} title="Preview · ARMED signal" right={<Chip>VIP</Chip>}>
          <div style={{ maxWidth: 420, borderRadius: "16px 16px 16px 4px", background: "var(--surface-2)", border: "1px solid var(--line)", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
            <b>A+ Tradeplay Signals</b>
            <pre className="mono" style={{ margin: 0, fontSize: 12, whiteSpace: "pre-wrap", color: "var(--text)" }}>{preview(armed)}</pre>
            <span className="faint mono" style={{ fontSize: 10.5, textAlign: "right" }}>{armed ? `${timeShort(+new Date(armed.created_at), "Asia/Kolkata")} IST` : ""}</span>
          </div>
          <button className="btn pri sm" style={{ marginTop: 12 }} disabled={!armed} onClick={queue}>Queue post</button>
        </Card>
      </section>

      <section className="g12">
        <Card span={5} title="Plans & access">
          {(plans.rows ?? []).length === 0 ? <Empty>Add plans in Subscriptions</Empty> : (
            <Table head={["Plan", "Price", "Active", "Billing"]} right={[1, 2]}>
              {(plans.rows ?? []).map((p) => <tr key={p.id}><td>{p.name}</td><td className="r mono">{money(Number(p.price_inr), "INR", 0)}</td><td className="r mono">{activeOn(p.id)}</td><td>{p.months === 1 ? "Monthly · invite link" : `Every ${p.months} months · invite link`}</td></tr>)}
            </Table>
          )}
        </Card>
        <div className="card flush s7">
          <div className="ch" style={{ padding: "14px 16px 0" }}><h3>Post log</h3><span className="sp" /><span className="faint" style={{ fontSize: 12 }}>Delivery status from Telegram</span></div>
          {(posts.rows ?? []).length === 0 ? <div style={{ padding: 16 }}><Empty>Nothing posted yet</Empty></div> : (
            <Table head={["Time (IST)", "Destination", "Post", "Status"]}>
              {(posts.rows ?? []).map((p) => {
                const t = +new Date(p.sent_at ?? p.created_at);
                const today = istDay(t) === istDay(Date.now());
                return (
                  <tr key={p.id}>
                    <td className="mono faint">{today ? timeShort(t, "Asia/Kolkata") : new Date(t).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })}</td>
                    <td>{p.destination === "both" ? "VIP + group" : p.destination === "vip" ? "VIP" : "Group"}</td>
                    <td>{p.kind}</td>
                    <td><Chip tone={p.status === "sent" ? "up" : p.status === "failed" ? "down" : p.status === "queued" ? "info" : ""}>{p.status === "sent" ? "Delivered" : p.status === "blocked" ? "Not posted" : p.status.replace(/^\w/, (c) => c.toUpperCase())}</Chip></td>
                  </tr>
                );
              })}
            </Table>
          )}
        </div>
      </section>
    </>
  );
}
