"use client";

import { useState } from "react";
import { INSTRUMENTS, type InstrumentId } from "@aplus/engine";
import { supabase } from "@/lib/supabase";
import { useRows } from "@/lib/useRows";
import { staffPost } from "@/lib/market";
import { ownerOf } from "@/lib/accounts";
import type { AutopilotConfig, AutopilotMode, AutopilotRun, Investor, Order, Strategy, TradingAccount } from "@/lib/types";
import { money, num, timeShort } from "@/lib/fmt";
import { useMe } from "@/components/Shell";
import { Card, Chip, Empty, ErrorNote, Note, Seg, Table, Toggle } from "@/components/ui";
import SelectorCard from "@/components/SelectorCard";

const MODES: { v: AutopilotMode; l: string; d: string }[] = [
  { v: "off", l: "Off", d: "Nothing runs" },
  { v: "alerts", l: "Alerts", d: "Telegram on state changes; tradeable setups go to the Bot log" },
  { v: "paper", l: "Paper", d: "Alerts + paper orders filled on live candles" },
  { v: "confirm", l: "Confirm", d: "Alerts + orders that wait for your tap" },
  { v: "auto", l: "Auto", d: "Live adapters next release — acts as Confirm" },
];
const EVENTS = ["IN_POI", "SWEPT", "SHIFTED", "ARMED", "CLOSED"];

export default function Autopilot() {
  const me = useMe();
  const cfg = useRows<AutopilotConfig>({ table: "autopilot_config", order: "instrument", ascending: true });
  const runs = useRows<AutopilotRun>({ table: "autopilot_runs", order: "at", limit: 120 });
  const accounts = useRows<TradingAccount>({ table: "trading_accounts", order: "created_at", ascending: true });
  const investors = useRows<Investor>({ table: "investors", select: "id,name", order: "name", ascending: true });
  const strategies = useRows<Strategy>({ table: "strategies", select: "id,name,instrument", order: "updated_at" });
  const pending = useRows<Order & { signals: { instrument: string } | null }>({ table: "orders", select: "*, signals(instrument)", eq: ["status", "awaiting_confirm"], order: "created_at", limit: 50 });
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (c: AutopilotConfig, patch: Partial<AutopilotConfig>) => {
    const { error } = await supabase.from("autopilot_config").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", c.id);
    if (error) setMsg({ ok: false, t: error.message }); else cfg.reload();
  };
  const tick = async () => {
    setBusy(true);
    try {
      const r = await staffPost<{ results: { instrument: string; state: string; action: string }[]; selector: { picks: { instrument: string; side: string; score: number }[]; ranked: unknown[] } | null }>("/api/autopilot/tick", {});
      const parts = r.results.map((x) => `${x.instrument}: ${x.state}${x.action !== "none" ? ` (${x.action})` : ""}`);
      if (r.selector) parts.push(r.selector.picks.length ? `Selector picked ${r.selector.picks.map((p) => `${p.instrument} ${p.side} ${p.score}/100`).join(", ")}` : `Selector: no trade (${r.selector.ranked.length} scanned)`);
      setMsg({ ok: true, t: parts.length ? parts.join(" · ") : "Nothing enabled" });
      runs.reload(); pending.reload();
    } catch (e) { setMsg({ ok: false, t: (e as Error).message }); }
    setBusy(false);
  };
  const confirmOrder = async (o: Order, ok: boolean) => {
    const { error } = await supabase.from("orders").update(ok ? { status: "manual_pending", reasons: [...o.reasons, "confirmed by staff"] } : { status: "cancelled", reasons: [...o.reasons, "rejected by staff"] }).eq("id", o.id);
    if (error) setMsg({ ok: false, t: error.message }); else pending.reload();
  };

  const acc = (accounts.rows ?? []).filter((a) => a.active && a.currency !== "INR");
  const last = (i: string) => (runs.rows ?? []).find((r) => r.instrument === i);

  return (
    <>
      <ErrorNote error={cfg.error || runs.error} />
      {msg && <Note tone={msg.ok ? "up" : "down"}>{msg.t}</Note>}
      {me.settings?.kill_switch && <Note tone="down">Kill switch is on: autopilot still evaluates and alerts, but creates no orders.</Note>}
      <Card title="How autopilot runs" right={<button className="btn pri sm" onClick={tick} disabled={busy}>{busy ? "Running…" : "Run a pass now"}</button>}>
        <p className="muted" style={{ fontSize: 12.5 }}>
          Every 5 minutes a scheduler calls <span className="mono">/api/autopilot/tick</span> with <span className="mono">AUTOPILOT_SECRET</span>. Each pass runs the same detector and A+ gate as the desks on server-side candles, logs every state change below, sends Telegram on the events you pick, and in Paper mode fills and closes orders against live candles (stop checked before target). Nothing acts twice on the same state. The selector then ranks the same evaluations across both desks. Every tradeable setup either of them finds is written to the <a href="/bot">Bot log</a>, where its fill, stop or target is tracked on candles.
        </p>
      </Card>

      <SelectorCard runs={runs.rows ?? []} accounts={accounts.rows ?? []} investors={investors.rows ?? []} />

      <section className="g12">
        {(cfg.rows ?? []).map((c) => {
          const def = INSTRUMENTS[c.instrument as InstrumentId];
          const l = last(c.instrument);
          return (
            <Card key={c.id} span={6} title={<>{c.instrument} <span className="faint" style={{ fontWeight: 400, fontSize: 12 }}>{def?.label.split("·")[1] ?? ""}</span></>} right={l ? <Chip tone={l.state === "ARMED" ? "up" : l.state === "ERROR" ? "down" : ""}>{l.state} · {timeShort(+new Date(l.at), "Asia/Kolkata")}</Chip> : <Chip>no runs</Chip>}>
              <Seg label="Mode" value={c.mode} onChange={(v) => save(c, { mode: v })} options={MODES.map((x) => ({ v: x.v, l: x.l }))} />
              <p className="faint" style={{ fontSize: 11.5, margin: "6px 0 10px" }}>{MODES.find((x) => x.v === c.mode)?.d}</p>
              <div className="lbl-u" style={{ marginBottom: 6 }}>Telegram on</div>
              <div className="row" style={{ gap: 6 }}>
                {EVENTS.map((e) => <button key={e} type="button" className={`chip ${c.events.includes(e) ? "acc" : ""}`} onClick={() => save(c, { events: c.events.includes(e) ? c.events.filter((x) => x !== e) : [...c.events, e] })}>{e}</button>)}
              </div>
              <div className="auto-s" style={{ gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: 10, marginTop: 12 }}>
                <label className="fld"><span>Risk per account</span><div className="inp"><input inputMode="decimal" defaultValue={c.risk_pct} onBlur={(e) => { const v = Number(e.target.value); if (v > 0 && v <= 2 && v !== Number(c.risk_pct)) save(c, { risk_pct: v }); }} /><span className="u">%</span></div></label>
                <label className="fld"><span>Strategy</span><div className="inp"><select value={c.strategy_id ?? ""} onChange={(e) => save(c, { strategy_id: e.target.value || null })}><option value="">Edge default</option>{(strategies.rows ?? []).filter((s) => s.instrument === c.instrument).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div></label>
              </div>
              <div className="between" style={{ marginTop: 10 }}><span style={{ fontSize: 12.5 }}>Also act on grade A (one soft miss)</span><Toggle on={!!c.filters?.allowGradeA} onChange={(v) => save(c, { filters: { ...c.filters, allowGradeA: v } })} label="Grade A" /></div>
              <div className="lbl-u" style={{ margin: "12px 0 4px" }}>Accounts it trades ({c.account_ids.length})</div>
              {acc.length === 0 ? <p className="faint" style={{ fontSize: 12 }}>No accounts yet.</p> : (
                <div className="row" style={{ gap: 6 }}>
                  {acc.filter((a) => !a.instruments?.length || a.instruments.includes(c.instrument)).map((a) => {
                    const on = c.account_ids.includes(a.id);
                    return <button key={a.id} type="button" className={`chip ${on ? "acc" : ""}`} onClick={() => save(c, { account_ids: on ? c.account_ids.filter((x) => x !== a.id) : [...c.account_ids, a.id] })}>{a.name} · {ownerOf(a, investors.rows ?? []).label}</button>;
                  })}
                </div>
              )}
              {l?.detail && (l.detail as { waitingFor?: string[] }).waitingFor?.length ? <p className="faint" style={{ fontSize: 11.5, marginTop: 10 }}>Waiting for: {((l.detail as { waitingFor?: string[] }).waitingFor ?? []).join(" · ")}</p> : null}
            </Card>
          );
        })}
      </section>

      <section className="g12">
        <Card span={5} title="Orders waiting for confirmation" right={<Chip>{(pending.rows ?? []).length}</Chip>}>
          {(pending.rows ?? []).length === 0 ? <Empty>Nothing to confirm</Empty> : (pending.rows ?? []).map((o) => (
            <div key={o.id} style={{ padding: "8px 0", borderBottom: "1px solid var(--line)", fontSize: 12.5 }}>
              <div className="between"><b>{o.signals?.instrument} · {o.side} {num(Number(o.qty), 3)}</b><span className="mono faint">{timeShort(+new Date(o.created_at), "Asia/Kolkata")}</span></div>
              <div className="mono faint" style={{ fontSize: 11.5 }}>entry {num(Number(o.entry), 2)} · SL {num(Number(o.stop), 2)} · TP {num(Number(o.target), 2)} · risk {money(Number(o.risk_amount))} · {(accounts.rows ?? []).find((a) => a.id === o.account_id)?.name}</div>
              <div className="row" style={{ marginTop: 6 }}><button className="btn sm buy" onClick={() => confirmOrder(o, true)}>Confirm (execute on venue)</button><button className="btn sm ghost" onClick={() => confirmOrder(o, false)}>Reject</button></div>
            </div>
          ))}
        </Card>
        <Card span={7} title="Run log" right={<button className="btn ghost sm" onClick={() => runs.reload()}>Refresh</button>}>
          {(runs.rows ?? []).length === 0 ? <Empty>No passes yet — run one now or set up the scheduler</Empty> : (
            <Table head={["Time", "Instrument", "State", "Grade", "Price", "Action"]} right={[4]}>
              {(runs.rows ?? []).map((r) => (
                <tr key={r.id}>
                  <td className="mono faint">{new Date(r.at).toLocaleString("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</td>
                  <td>{r.instrument} {r.side && <span className="faint">{r.side}</span>}</td>
                  <td><Chip tone={r.state === "ARMED" ? "up" : r.state === "ERROR" ? "down" : r.state === "SHIFTED" || r.state === "SWEPT" ? "warn" : ""}>{r.state}</Chip></td>
                  <td>{r.grade?.replace("_", " ") ?? "—"}</td>
                  <td className="r mono">{r.price !== null ? num(Number(r.price), 2) : "—"}</td>
                  <td className="wrap faint" style={{ fontSize: 11.5 }}>{r.action}{r.state === "ERROR" ? ` · ${(r.detail as { error?: string }).error ?? ""}` : ""}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </section>
    </>
  );
}
