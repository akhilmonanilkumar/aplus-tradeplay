"use client";

import { useState } from "react";
import { EDGE_RULES, canChangeRules, diagnose, guardrails, personalLimits, summarize } from "@aplus/engine";
import { supabase } from "@/lib/supabase";
import { useRows } from "@/lib/useRows";
import { drawdown, rooms } from "@/lib/copy";
import { istDay, riskAmount, todayIst } from "@/lib/derive";
import type { Order, Signal, Trade, TradingAccount } from "@/lib/types";
import { money, num, pct } from "@/lib/fmt";
import { useMe } from "@/components/Shell";
import { Bar, Card, Chip, Empty, ErrorNote, Table, Toggle } from "@/components/ui";

type Lim = { n: string; d: string; used: number; limit: number; usedLabel: string; limLabel: string };

function LimitRow({ m }: { m: Lim }) {
  const p = m.limit > 0 ? (m.used / m.limit) * 100 : 0;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.3fr) minmax(0,1fr) 110px", gap: 12, alignItems: "center", padding: "10px 0", borderBottom: "1px solid var(--line)", fontSize: 12.5 }}>
      <div className="col" style={{ gap: 1 }}><b style={{ fontWeight: 500 }}>{m.n}</b><span className="faint" style={{ fontSize: 11 }}>{m.d}</span></div>
      <div className="col" style={{ gap: 4 }}><Bar pct={p} tone={p >= 100 ? "down" : p >= 70 ? "warn" : "up"} /><span className="mono faint" style={{ fontSize: 11 }}>{m.usedLabel}</span></div>
      <span className="mono" style={{ textAlign: "right" }}>{m.limLabel}</span>
    </div>
  );
}

export default function Risk() {
  const me = useMe();
  const accounts = useRows<TradingAccount>({ table: "trading_accounts", order: "created_at", ascending: true });
  const trades = useRows<Trade>({ table: "trades", order: "opened_at", limit: 3000 });
  const orders = useRows<Order>({ table: "orders", order: "created_at", limit: 300 });
  const signals = useRows<Signal>({ table: "signals", select: "id,instrument", limit: 200 });
  const [level, setLevel] = useState<string>("combined");
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const acc = (accounts.rows ?? []).filter((a) => a.active);
  const usd = acc.filter((a) => a.currency !== "INR");
  const tr = trades.rows ?? [];
  const scope = level === "combined" ? usd : acc.filter((a) => a.id === level);
  const ids = new Set(scope.map((a) => a.id));
  const todayTr = tr.filter((t) => ids.has(t.account_id) && istDay(t.opened_at) === todayIst());
  const closedTodayPnl = tr.filter((t) => ids.has(t.account_id) && t.closed_at && istDay(t.closed_at) === todayIst()).reduce((s, t) => s + Number(t.pnl ?? 0), 0);
  const equity = scope.reduce((s, a) => s + Number(a.equity), 0);
  const peak = scope.reduce((s, a) => s + Math.max(Number(a.hwm ?? 0), Number(a.equity), Number(a.start_balance)), 0);
  const master = acc.find((a) => a.type === "master");
  const masterToday = tr.filter((t) => master && t.account_id === master.id && istDay(t.opened_at) === todayIst());
  const g = guardrails({ dayStartBalance: equity - closedTodayPnl || 1, equity, peakEquity: peak || 1, tradesToday: masterToday.length, lossesToday: masterToday.filter((t) => Number(t.realized_r) < 0).length });
  const open = tr.filter((t) => ids.has(t.account_id) && t.exit === null);
  const openRisk = open.reduce((s, t) => s + riskAmount(t), 0);
  const maxRiskPct = Math.max(0, ...scope.map((a) => Number(a.risk_pct)));

  const lims: Lim[] = [
    { n: "Daily loss", d: `Stop for the day at −${EDGE_RULES.dailyLossCapPct}%`, used: Math.max(0, -g.dayPnlPct), limit: EDGE_RULES.dailyLossCapPct, usedLabel: `${money(g.dayPnl)} · ${num(g.dayPnlPct, 2)}%`, limLabel: `${EDGE_RULES.dailyLossCapPct}%` },
    { n: "Drawdown from peak", d: `Pause and review at ${EDGE_RULES.maxDrawdownPausePct}%`, used: g.drawdownPct, limit: EDGE_RULES.maxDrawdownPausePct, usedLabel: `${num(g.drawdownPct, 2)}%`, limLabel: `${EDGE_RULES.maxDrawdownPausePct}%` },
    { n: "A+ trades today", d: "Per instrument on the master", used: masterToday.length, limit: EDGE_RULES.maxAPlusTradesPerDay * 2, usedLabel: `${masterToday.length} taken`, limLabel: `${EDGE_RULES.maxAPlusTradesPerDay} × 2` },
    { n: "Losses today", d: "Stop after 2", used: masterToday.filter((t) => Number(t.realized_r) < 0).length, limit: EDGE_RULES.stopAfterLosses, usedLabel: `${masterToday.filter((t) => Number(t.realized_r) < 0).length} losses`, limLabel: String(EDGE_RULES.stopAfterLosses) },
    { n: "Open risk", d: "If every open stop is hit", used: equity ? (openRisk / equity) * 100 : 0, limit: 1.5, usedLabel: `${money(openRisk)} · ${equity ? num((openRisk / equity) * 100, 2) : "0"}%`, limLabel: "1.5%" },
    { n: "Risk per trade", d: "Source guideline ≤ 1%", used: maxRiskPct, limit: 1, usedLabel: `highest ${num(maxRiskPct, 2)}%`, limLabel: "1%" },
  ];
  const breached = lims.some((m) => m.used >= m.limit);

  // engine suggestions (can lower risk, never raise it)
  type Sug = { id: string; t: string; tag: string; tone: "warn" | "info" | ""; body: string; apply?: () => Promise<void> };
  const sugs: Sug[] = [];
  for (const a of acc) {
    const r = rooms(a);
    if (r.dailyLossRoom === undefined) continue;
    const perTrade = (Number(a.balance) * Number(a.risk_pct)) / 100;
    if (perTrade * 3 > r.dailyLossRoom && Number(a.risk_pct) > 0.25) {
      const safe = Math.max(0.25, Math.floor(((r.dailyLossRoom / 3 / Number(a.balance)) * 100) / 0.05) * 0.05);
      if (safe < Number(a.risk_pct)) sugs.push({
        id: `risk-${a.id}`, t: `${a.name}: drop to ${num(safe, 2)}% per trade`, tag: "Prop", tone: "warn",
        body: `Daily room is ${money(r.dailyLossRoom)}. At ${num(Number(a.risk_pct), 2)}% (${money(perTrade)}) three losses breach it; at ${num(safe, 2)}% the 2-loss stop ends the day first.`,
        apply: async () => { await supabase.from("trading_accounts").update({ risk_pct: safe }).eq("id", a.id); accounts.reload(); },
      });
    }
    const pl = personalLimits({ dailyLossPct: a.firm_rules?.daily_loss_pct, maxLossPct: a.firm_rules?.max_loss_pct });
    if (a.firm_rules?.daily_loss_pct && drawdown(a) * 100 > pl.maxDrawdownPct) sugs.push({ id: `dd-${a.id}`, t: `${a.name}: past the personal drawdown line`, tag: "Prop", tone: "warn", body: `Down ${pct(drawdown(a), 2)} from peak; personal limit is ${num(pl.maxDrawdownPct, 2)}% (half the firm's). Equity throttle halves risk until a new high.` });
  }
  const pendingByInst = new Map<string, Set<string>>();
  const live = (orders.rows ?? []).filter((o) => ["queued", "sent", "awaiting_confirm", "manual_pending"].includes(o.status));
  for (const o of live) { const s = (signals.rows ?? []).find((x) => x.id === o.signal_id); const k = `${s?.instrument ?? "manual"}|${o.side}`; pendingByInst.set(k, (pendingByInst.get(k) ?? new Set()).add(o.account_id)); }
  for (const [k, set] of pendingByInst) if (set.size >= 3) sugs.push({ id: `corr-${k}`, t: `Treat ${k.split("|")[0]} ${k.split("|")[1]} as one position`, tag: "Correlation", tone: "info", body: `${set.size} accounts are on the same trade. Cap the combined open risk at 1.5%.` });
  const masterAll = master ? tr.filter((t) => t.account_id === master.id) : [];
  const n = masterAll.length;
  if (n < EDGE_RULES.setAndForgetFirstN) sugs.push({ id: "saf", t: `Keep set-and-forget until trade ${EDGE_RULES.setAndForgetFirstN}`, tag: "Process", tone: "", body: `Trade ${n + 1} of ${EDGE_RULES.setAndForgetFirstN} in the data phase. Breakeven rules stay locked so the test stays clean.` });
  const rs = masterAll.filter((t) => t.realized_r !== null).map((t) => Number(t.realized_r));
  const months = masterAll.length ? (Date.now() - +new Date(masterAll[masterAll.length - 1]!.opened_at)) / (30 * 86_400_000) : 0;
  for (const d of diagnose(summarize(rs))) sugs.push({ id: `dx-${d}`, t: d, tag: "Review", tone: "", body: canChangeRules(rs.length, Math.floor(months)).reason });
  const shown = sugs.filter((s) => !dismissed.has(s.id));

  // exposure if every pending order fills
  const exp = new Map<string, { dir: string; accts: Set<string>; risk: number }>();
  for (const o of live) {
    const s = (signals.rows ?? []).find((x) => x.id === o.signal_id);
    const k = s?.instrument ?? "manual";
    const e = exp.get(k) ?? { dir: o.side, accts: new Set(), risk: 0 };
    e.accts.add(o.account_id); e.risk += Number(o.risk_amount ?? 0);
    exp.set(k, e);
  }
  for (const t of tr.filter((t) => t.exit === null)) {
    const e = exp.get(t.instrument) ?? { dir: t.side, accts: new Set(), risk: 0 };
    e.accts.add(t.account_id); e.risk += riskAmount(t);
    exp.set(t.instrument, e);
  }
  const combined = usd.reduce((s, a) => s + Number(a.equity), 0);
  const expTotal = Array.from(exp.values()).reduce((s, e) => s + e.risk, 0);
  const props = acc.filter((a) => a.firm_rules?.daily_loss_pct || a.firm_rules?.max_loss_pct);

  const rule = (k: string, t: string, d: string, on: boolean, locked: boolean, set?: (v: boolean) => void) => (
    <div key={k} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: 12, alignItems: "center", padding: "10px 0", borderBottom: "1px solid var(--line)", fontSize: 12.5 }}>
      <div className="col" style={{ gap: 1 }}><b style={{ fontWeight: 500 }}>{t}</b><span className="faint" style={{ fontSize: 11 }}>{d}{locked ? " · edge rule, always on" : ""}</span></div>
      {locked ? <Chip tone="up">on</Chip> : <Toggle on={on} onChange={(v) => set?.(v)} label={t} />}
    </div>
  );

  return (
    <>
      <ErrorNote error={accounts.error || trades.error} />
      <section className="g12">
        <Card span={7} title={`Limits · ${level === "combined" ? "combined (USD)" : acc.find((a) => a.id === level)?.name ?? ""}`} right={<>
          <div className="inp" style={{ width: 200, height: 30 }}><select aria-label="Level" value={level} onChange={(e) => setLevel(e.target.value)}><option value="combined">Combined</option>{acc.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div>
          <Chip tone={breached ? "down" : "up"}>{breached ? "Limit reached" : "All within limits"}</Chip>
        </>}>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.3fr) minmax(0,1fr) 110px", gap: 12, paddingBottom: 4 }}><span className="lbl">Rule</span><span className="lbl">Used</span><span className="lbl" style={{ textAlign: "right" }}>Limit</span></div>
          {scope.length === 0 ? <Empty>No accounts</Empty> : lims.map((m) => <LimitRow key={m.n} m={m} />)}
        </Card>
        <Card span={5} title="Engine suggestions" right={<>{shown.length > 0 && <Chip tone="acc">{shown.length}</Chip>}<span className="faint" style={{ fontSize: 11.5 }}>Can lower risk, never raise it</span></>}>
          {shown.length === 0 ? <Empty>Nothing to change</Empty> : (
            <div className="col" style={{ gap: 10 }}>
              {shown.map((s) => (
                <div key={s.id} style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12, borderRadius: 14, border: "1px solid var(--line)", background: "var(--surface-2)" }}>
                  <div className="between"><b style={{ fontSize: 12.5 }}>{s.t}</b><Chip tone={s.tone}>{s.tag}</Chip></div>
                  <span className="muted" style={{ fontSize: 12 }}>{s.body}</span>
                  <div className="row">
                    {s.apply && <button className="btn pri sm" onClick={async () => { await s.apply!(); setDismissed(new Set(dismissed).add(s.id)); }}>Approve</button>}
                    <button className="btn sm" onClick={() => setDismissed(new Set(dismissed).add(s.id))}>{s.apply ? "Dismiss" : "Got it"}</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </section>

      <section className="card">
        <div className="ch"><h3>Prop-firm limits · from balances and equity</h3><span className="sp" /><span className="faint" style={{ fontSize: 12 }}>Rules as entered · verify against each firm&apos;s terms</span></div>
        {props.length === 0 ? <Empty>No accounts with firm rules</Empty> : (
          <div className="auto" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(320px, 100%), 1fr))", gap: 12 }}>
            {props.map((a) => {
              const r = rooms(a);
              const start = Number(a.start_balance);
              const daily = a.firm_rules.daily_loss_pct ? (start * a.firm_rules.daily_loss_pct) / 100 : null;
              const floor = a.firm_rules.max_loss_pct ? start * (1 - a.firm_rules.max_loss_pct / 100) : null;
              return (
                <div key={a.id} style={{ display: "flex", flexDirection: "column", gap: 10, padding: 12, borderRadius: 14, border: "1px solid var(--line)", background: "var(--surface-2)" }}>
                  <div className="between"><b>{a.name}</b><Chip>{a.venue}</Chip></div>
                  {daily !== null && r.dailyLossRoom !== undefined && (
                    <div className="col" style={{ gap: 4 }}><div className="between" style={{ fontSize: 12 }}><span className="muted">Daily loss · {a.firm_rules.daily_loss_pct}%</span><span className="mono">{money(r.dailyLossRoom)} room</span></div><Bar pct={(r.dailyLossRoom / daily) * 100} tone="up" /></div>
                  )}
                  {floor !== null && r.maxLossRoom !== undefined && (
                    <div className="col" style={{ gap: 4 }}><div className="between" style={{ fontSize: 12 }}><span className="muted">Max loss · {a.firm_rules.max_loss_pct}%</span><span className="mono">floor {money(floor)}</span></div><Bar pct={(r.maxLossRoom / (start - floor)) * 100} tone="warn" /></div>
                  )}
                  <div className="between" style={{ fontSize: 12 }}><span className="muted">Equity {money(Number(a.equity), a.currency)}</span><span className="mono faint">risk {num(Number(a.risk_pct), 2)}%</span></div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="g12">
        <Card span={6} title="Dynamic rules">
          {rule("throttle", "Equity-curve throttle", "If drawdown from peak > 3%, halve risk until a new equity high", me.settings?.equity_throttle ?? true, false, (v) => me.updateSettings({ equity_throttle: v }))}
          {rule("stop2", "Stop after 2 losses", "Blocks new entries for the day on every account", true, true)}
          {rule("cap2", "Max 2 A+ trades per instrument", "Counted per instrument, not per account", true, true)}
          {rule("buffer", "Prop buffer", "Shrink or block an order if its stop would use more than 50% of remaining daily room", me.settings?.prop_buffer ?? true, false, (v) => me.updateSettings({ prop_buffer: v }))}
          {rule("news", "News block", "Never move stops for news; only block new entries ±15 min", true, true)}
        </Card>
        <Card span={6} title="Exposure by instrument" right={<span className="faint" style={{ fontSize: 12 }}>Open trades + every pending order</span>}>
          {exp.size === 0 ? <Empty>Flat</Empty> : (
            <Table head={["Instrument", "Direction", "Accounts", "Risk at stop", "% of combined"]} right={[2, 3, 4]}>
              {Array.from(exp.entries()).map(([k, e]) => (
                <tr key={k}><td><b>{k}</b></td><td><Chip tone={e.dir === "long" ? "up" : "down"}>{e.dir === "long" ? "Long" : "Short"}</Chip></td><td className="r mono">{e.accts.size}</td><td className="r mono">{money(e.risk)}</td><td className="r mono">{combined ? pct(e.risk / combined, 2) : "—"}</td></tr>
              ))}
              <tr><td><b>Total</b></td><td /><td className="r mono">{Array.from(exp.values()).reduce((s, e) => s + e.accts.size, 0)}</td><td className="r mono">{money(expTotal)}</td><td className="r mono">{combined ? pct(expTotal / combined, 2) : "—"}</td></tr>
            </Table>
          )}
        </Card>
      </section>
    </>
  );
}
