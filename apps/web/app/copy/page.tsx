"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useRows } from "@/lib/useRows";
import { eligible, plan as planCopy, queueOrders, rooms } from "@/lib/copy";
import { istDay, todayIst } from "@/lib/derive";
import type { CopyRoute, NewsEvent, Order, Signal, TradingAccount } from "@/lib/types";
import { money, num, timeShort } from "@/lib/fmt";
import { useMe } from "@/components/Shell";
import { Card, Chip, Empty, ErrorNote, Note, Table, Toggle } from "@/components/ui";

const pctl = (xs: number[], p: number) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(xs.length * p))]! : null);
const FIRM_RULE: Record<string, string> = { allowed: "Copying allowed", own_only: "Own accounts only", banned: "Copying banned — manual only" };

function CopyEngine() {
  const me = useMe();
  const params = useSearchParams();
  const signals = useRows<Signal>({ table: "signals", order: "created_at", limit: 30 });
  const accounts = useRows<TradingAccount>({ table: "trading_accounts", order: "created_at", ascending: true });
  const orders = useRows<Order>({ table: "orders", order: "created_at", limit: 300 });
  const routes = useRows<CopyRoute>({ table: "copy_routes", order: "created_at", ascending: true });
  const news = useRows<NewsEvent>({ table: "news_events", order: "at", limit: 30 });
  const [picked, setPicked] = useState<string | null>(params.get("s"));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const [nr, setNr] = useState({ instrument: "XAUUSD", master: "", target: "", risk: "", symbol: "" });
  const [adding, setAdding] = useState(false);

  const acc = accounts.rows ?? [];
  const name = (id: string) => acc.find((a) => a.id === id)?.name ?? "—";
  const sig = (signals.rows ?? []).find((s) => s.id === picked) ?? (signals.rows ?? [])[0] ?? null;
  const ord = orders.rows ?? [];
  const today = ord.filter((o) => istDay(o.created_at) === todayIst());
  const filledToday = today.filter((o) => o.status === "filled" || o.status === "partial").length;
  const blockedToday = today.filter((o) => o.action === "BLOCK").length;
  const lat = ord.map((o) => o.latency_ms).filter((x): x is number => x !== null).sort((a, b) => a - b);
  const slips = ord.filter((o) => o.fill_price !== null).slice(0, 30).map((o) => Math.abs(Number(o.fill_price) - Number(o.entry)) / Math.abs(Number(o.entry) - Number(o.stop)));
  const avgSlip = slips.length ? slips.reduce((s, x) => s + x, 0) / slips.length : null;
  const copying = acc.filter((a) => a.active && a.type !== "master" && a.copy_policy !== "BLOCKED");
  const nonMaster = acc.filter((a) => a.type !== "master");

  const fan = sig ? planCopy(eligible(acc), sig.instrument, { entry: Number(sig.entry), stop: Number(sig.stop), target: Number(sig.target) }, undefined, me.settings) : { decisions: [], error: null };
  const sigOrders = sig ? ord.filter((o) => o.signal_id === sig.id) : [];
  const t0 = sig ? +new Date(sig.created_at) : 0;
  const queuedAt = sigOrders.length ? Math.min(...sigOrders.map((o) => +new Date(o.created_at))) : null;
  const fills = sigOrders.filter((o) => o.filled_at).map((o) => +new Date(o.filled_at!));
  const newsNow = (news.rows ?? []).some((n) => n.impact === "high" && Math.abs(+new Date(n.at) - Date.now()) <= 15 * 60_000);

  const send = async () => {
    if (!sig) return;
    setBusy(true); setMsg(null);
    const e = await queueOrders({ id: sig.id, side: sig.side, entry: Number(sig.entry), stop: Number(sig.stop), target: Number(sig.target) }, fan.decisions, me.settings);
    setBusy(false);
    setMsg(e ? { ok: false, t: e } : { ok: true, t: "Orders queued" });
    orders.reload();
  };
  const addRoute = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nr.master || !nr.target || nr.master === nr.target) return setMsg({ ok: false, t: "Pick a master and a different target" });
    const { error } = await supabase.from("copy_routes").insert({ instrument: nr.instrument, master_account_id: nr.master, target_account_id: nr.target, risk_pct: Number(nr.risk) || null, symbol: nr.symbol || null });
    if (error) return setMsg({ ok: false, t: error.message });
    setAdding(false); routes.reload();
  };
  const toggleRoute = async (r: CopyRoute) => { await supabase.from("copy_routes").update({ enabled: !r.enabled }).eq("id", r.id); routes.reload(); };

  const stages = [
    { n: "01", b: "Signal", d: "Engine GO or a manual order on the master", m: sig ? "+0 ms" : "—" },
    { n: "02", b: "Pre-trade guard", d: "Firm rules, limits, news, min size per account", m: sig ? `${fan.decisions.length} checked` : "—" },
    { n: "03", b: "Size per account", d: "Risk % on own equity, step + min-notional rounding", m: sig ? `${fan.decisions.filter((d) => d.size > 0).length} sized` : "—" },
    { n: "04", b: "Route", d: "Venue adapters per account", m: queuedAt ? `+${Math.max(0, queuedAt - t0)} ms` : "not queued" },
    { n: "05", b: "Fill & reconcile", d: "Acks, partials, retries, drift repair", m: fills.length ? `+${Math.max(...fills) - t0} ms` : "waiting for worker" },
    { n: "06", b: "Publish", d: "Journal, investor app, Telegram", m: fills.length ? "on fill" : "—" },
  ];
  const latRows = sigOrders.filter((o) => o.latency_ms !== null);
  const scale = Math.max(200, ...latRows.map((o) => o.latency_ms!));
  const cell = (k: "p" | "f" | "w" | "n", t: string) => (
    <span className="mono" style={{ display: "grid", placeItems: "center", height: 24, borderRadius: 7, fontSize: 11, fontWeight: 600, background: k === "p" ? "var(--up-bg)" : k === "f" ? "var(--down-bg)" : k === "w" ? "var(--warn-bg)" : "var(--surface-3)", color: k === "p" ? "var(--up)" : k === "f" ? "var(--down)" : k === "w" ? "var(--warn)" : "var(--faint)" }}>{t}</span>
  );
  const grid = { display: "grid", gridTemplateColumns: "minmax(0,1.3fr) repeat(6, minmax(48px, 1fr))", gap: 5, alignItems: "center", fontSize: 12 } as const;

  return (
    <>
      <ErrorNote error={signals.error || accounts.error || orders.error || fan.error} />
      {msg && <Note tone={msg.ok ? "up" : "down"}>{msg.t}</Note>}
      <section className="auto-s" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(170px, 100%), 1fr))" }}>
        <div className="card"><div className="lbl">Fan-out latency p50 / p95</div><div className="kv sm" style={{ marginTop: 4 }}>{pctl(lat, 0.5) ?? "—"} / {pctl(lat, 0.95) ?? "—"} ms</div><div className="faint" style={{ fontSize: 11 }}>master fill → copy ack</div></div>
        <div className="card"><div className="lbl">Copies today</div><div className="kv sm" style={{ marginTop: 4 }}>{filledToday} / {today.length}</div><div className="faint" style={{ fontSize: 11 }}>{blockedToday} blocked by guard</div></div>
        <div className="card"><div className="lbl">Avg slippage vs master</div><div className="kv sm" style={{ marginTop: 4 }}>{avgSlip !== null ? `${num(avgSlip, 2)} R` : "—"}</div><div className="faint" style={{ fontSize: 11 }}>last {slips.length} fills</div></div>
        <div className="card"><div className="lbl">Mode</div><div className={`kv sm ${me.settings?.mode === "LIVE" ? "down" : "info"}`} style={{ marginTop: 4 }}>{me.settings?.mode ?? "—"}</div><div className="faint" style={{ fontSize: 11 }}>{me.settings?.kill_switch ? "kill switch ON" : "kill switch off"}</div></div>
        <div className="card"><div className="lbl">Accounts copying</div><div className="kv sm" style={{ marginTop: 4 }}>{copying.length} / {nonMaster.length}</div><div className="faint" style={{ fontSize: 11 }}>blocked policy excluded</div></div>
      </section>

      <section className="card">
        <div className="ch">
          <h3>Pipeline{sig ? ` · ${sig.instrument} ${sig.side}, ${timeShort(t0, "Asia/Kolkata")} IST` : ""}</h3><span className="sp" />
          <div className="inp" style={{ width: 260, height: 32 }}>
            <select aria-label="Signal" value={sig?.id ?? ""} onChange={(e) => setPicked(e.target.value)}>
              {(signals.rows ?? []).map((s) => <option key={s.id} value={s.id}>{s.instrument} {s.side} · {s.grade} · {new Date(s.created_at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })}</option>)}
            </select>
          </div>
          <button className="btn pri sm" disabled={!sig || busy || !!me.settings?.kill_switch} onClick={send}>{busy ? "Queueing…" : "Queue orders"}</button>
        </div>
        {!sig ? <Empty>No signals yet — arm one in the copilot</Empty> : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(150px, 1fr))", gap: 10, overflowX: "auto", paddingBottom: 4 }}>
            {stages.map((s) => (
              <div key={s.n} style={{ padding: 12, borderRadius: 14, background: "var(--surface-2)", border: "1px solid var(--line)", display: "flex", flexDirection: "column", gap: 4 }}>
                <span className="mono faint" style={{ fontSize: 10.5 }}>{s.n}</span><b style={{ fontSize: 13 }}>{s.b}</b>
                <span className="muted" style={{ fontSize: 12 }}>{s.d}</span><span className="mono acc" style={{ fontSize: 12 }}>{s.m}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="g12">
        <Card span={6} title="Fan-out timing · per account" right={<span className="faint" style={{ fontSize: 12 }}>0–{scale} ms</span>}>
          {latRows.length === 0 ? <Empty>No acknowledged copies for this signal yet</Empty> : latRows.map((o) => {
            const ack = o.latency_ms!;
            return (
              <div key={o.id} style={{ display: "grid", gridTemplateColumns: "170px minmax(0,1fr) 70px", gap: 10, alignItems: "center", fontSize: 12, padding: "6px 0" }}>
                <span>{name(o.account_id)}</span>
                <div style={{ position: "relative", height: 14, borderRadius: 5, background: "var(--surface-2)" }}><i style={{ position: "absolute", top: 2, bottom: 2, left: 0, width: `${(ack / scale) * 100}%`, borderRadius: 4, background: ack > 150 ? "var(--warn)" : "var(--accent)" }} /></div>
                <span className="mono" style={{ textAlign: "right" }}>{ack} ms</span>
              </div>
            );
          })}
        </Card>
        <Card span={6} title={`Pre-trade guard${sig ? ` · ${sig.instrument} ${sig.side} ${num(Number(sig.entry), 2)}` : ""}`} right={fan.decisions.some((d) => d.action === "BLOCK") ? <Chip tone="warn">{fan.decisions.filter((d) => d.action === "BLOCK").length} blocked</Chip> : null}>
          {!sig || fan.decisions.length === 0 ? <Empty>No copy targets</Empty> : (
            <div className="tbl-w">
              <div style={{ minWidth: 480 }}>
                <div style={{ ...grid, paddingBottom: 8 }}>
                  {["Account", "Daily room", "Max DD", "News", "Min size", "Firm rule", "Result"].map((h, i) => <span key={h} className="lbl" style={{ textAlign: i ? "center" : undefined }}>{h}</span>)}
                </div>
                {fan.decisions.map((d) => {
                  const a = acc.find((x) => x.id === d.accountId)!;
                  const r = rooms(a);
                  const rule = (a.firm_rules as Record<string, unknown>)?.copy_rule as string | undefined;
                  const shrunk = d.reasons.some((x) => x.startsWith("risk cut"));
                  return (
                    <div key={d.accountId} style={{ ...grid, padding: "8px 0", borderTop: "1px solid var(--line)" }}>
                      <div className="col" style={{ gap: 1 }}><b style={{ fontWeight: 500 }}>{a.name}</b><span className="faint" style={{ fontSize: 11 }}>{money(d.riskAmount)} · {a.copy_policy}</span></div>
                      {r.dailyLossRoom === undefined ? cell("n", "—") : cell(shrunk ? "w" : "p", money(r.dailyLossRoom, "USD", 0))}
                      {r.maxLossRoom === undefined ? cell("n", "—") : cell(r.maxLossRoom <= 0 ? "f" : "p", money(r.maxLossRoom, "USD", 0))}
                      {cell(newsNow ? "f" : "p", newsNow ? "block" : "clear")}
                      {cell(d.reasons.some((x) => x.includes("minimum")) ? "f" : "p", d.size > 0 ? num(d.size, sig.instrument.startsWith("BTC") ? 3 : 2) : "0")}
                      {cell(rule === "banned" ? "f" : rule === "own_only" ? "w" : rule ? "p" : "n", rule ? rule.replace("_", " ") : "—")}
                      {cell(d.action === "BLOCK" ? "f" : d.shrunk ? "w" : "p", d.action === "BLOCK" ? "block" : d.shrunk ? "shrink" : d.action.toLowerCase())}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </Card>
      </section>

      <section className="card flush">
        <div className="ch" style={{ padding: "14px 16px 0" }}><h3>Routing map</h3><span className="sp" /><button className="btn sm" onClick={() => setAdding((v) => !v)}>{adding ? "Close" : "Add route"}</button></div>
        {adding && (
          <form onSubmit={addRoute} className="auto-s" style={{ padding: "12px 16px" }}>
            <label className="fld"><span>Instrument</span><div className="inp"><select value={nr.instrument} onChange={(e) => setNr({ ...nr, instrument: e.target.value })}><option>XAUUSD</option><option>BTCUSDT.P</option></select></div></label>
            <label className="fld"><span>Master</span><div className="inp"><select value={nr.master} onChange={(e) => setNr({ ...nr, master: e.target.value })}><option value="">—</option>{acc.filter((a) => a.type === "master").map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div></label>
            <label className="fld"><span>Target</span><div className="inp"><select value={nr.target} onChange={(e) => setNr({ ...nr, target: e.target.value })}><option value="">—</option>{acc.filter((a) => a.type !== "master").map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div></label>
            <label className="fld"><span>Risk % (blank = account)</span><div className="inp"><input inputMode="decimal" value={nr.risk} onChange={(e) => setNr({ ...nr, risk: e.target.value })} /></div></label>
            <label className="fld"><span>Symbol at venue</span><div className="inp"><input value={nr.symbol} placeholder="XAUUSD.r" onChange={(e) => setNr({ ...nr, symbol: e.target.value })} /></div></label>
            <div style={{ alignSelf: "end" }}><button className="btn pri sm">Save route</button></div>
          </form>
        )}
        {(routes.rows ?? []).length === 0 && !adding ? <div style={{ padding: 16 }}><Empty>No routes yet</Empty></div> : (
          <Table head={["Instrument", "Master", "Target", "Type", "Sizing", "Symbol", "Firm copy rule", "Mode", "On"]}>
            {(routes.rows ?? []).map((r) => {
              const t = acc.find((a) => a.id === r.target_account_id);
              const rule = (t?.firm_rules as Record<string, unknown> | undefined)?.copy_rule as string | undefined;
              return (
                <tr key={r.id}>
                  <td><b style={{ fontWeight: 500 }}>{r.instrument}</b></td>
                  <td className="muted">{name(r.master_account_id)}</td>
                  <td>{t?.name ?? "—"}</td>
                  <td><Chip>{t?.type ?? "—"}</Chip></td>
                  <td className="muted">{r.risk_pct ? `${num(Number(r.risk_pct), 2)}% risk` : t ? `${num(Number(t.risk_pct), 2)}% risk` : "—"}</td>
                  <td className="mono faint">{r.symbol ?? r.instrument}</td>
                  <td className="muted wrap" style={{ minWidth: 180 }}>{rule ? FIRM_RULE[rule] ?? rule : "Not set"}</td>
                  <td><Chip tone={t?.copy_policy === "AUTO" ? "up" : t?.copy_policy === "CONFIRM" ? "info" : t?.copy_policy === "MANUAL" ? "warn" : t?.copy_policy === "BLOCKED" ? "down" : ""}>{t?.copy_policy ?? "—"}</Chip></td>
                  <td><Toggle on={r.enabled} onChange={() => toggleRoute(r)} label={`Route ${r.instrument} to ${t?.name ?? ""}`} /></td>
                </tr>
              );
            })}
          </Table>
        )}
      </section>
    </>
  );
}

export default function Page() {
  return <Suspense><CopyEngine /></Suspense>;
}
