"use client";

import { Fragment, useState } from "react";
import { breakevenWinRate, complianceRate, summarize } from "@aplus/engine";
import { useRows } from "@/lib/useRows";
import { istDay, riskAmount } from "@/lib/derive";
import type { Trade, TradingAccount } from "@/lib/types";
import { num, pct } from "@/lib/fmt";
import { Bar, Card, Empty, ErrorNote, Seg, Table } from "@/components/ui";

const rfmt = (v: number, d = 2) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}R`;
const WIN: Record<string, string> = { london_q: "London Q", ny_q: "NY Q", other: "Outside window" };

/** Net R = gross R − fees expressed in R. */
function netR(t: Trade) {
  const g = Number(t.realized_r);
  const risk = riskAmount(t);
  return t.fees && risk > 0 ? g - Number(t.fees) / risk : g;
}

export default function Analytics() {
  const trades = useRows<Trade>({ table: "trades", order: "opened_at", ascending: true, limit: 5000 });
  const accounts = useRows<TradingAccount>({ table: "trading_accounts", select: "id,name,type" });
  const [scope, setScope] = useState<"master" | "all">("master");
  const masters = new Set((accounts.rows ?? []).filter((a) => a.type === "master").map((a) => a.id));
  const closed = (trades.rows ?? []).filter((t) => t.realized_r !== null && (scope === "all" || masters.has(t.account_id)));
  const gross = closed.map((t) => Number(t.realized_r));
  const net = closed.map(netR);
  const sg = summarize(gross), sn = summarize(net);
  const comp = complianceRate(closed.filter((t) => t.plan_followed !== null).map((t) => ({ planFollowed: !!t.plan_followed })));
  const avgPlanned = closed.filter((t) => t.planned_r).reduce((s, t, _, a) => s + Number(t.planned_r) / a.length, 0);
  const small = closed.length < 30;

  const kpis = [
    { l: "Trades", v: String(sn.n), n: small ? "small sample" : "closed", c: "" },
    { l: "Win rate", v: pct(sn.winRate, 1), n: avgPlanned ? `break-even ${pct(breakevenWinRate(avgPlanned), 1)}` : "", c: "" },
    { l: "Expectancy · net", v: rfmt(sn.avgR, 3), n: `gross ${rfmt(sg.avgR, 3)}`, c: sn.avgR >= 0 ? "up" : "down" },
    { l: "Net R", v: rfmt(sn.netR, 1), n: `gross ${rfmt(sg.netR, 1)}`, c: sn.netR >= 0 ? "up" : "down" },
    { l: "Profit factor", v: sn.profitFactor === null ? "—" : num(sn.profitFactor, 2), n: "net", c: "" },
    { l: "Max drawdown", v: `${num(sn.maxDrawdownR, 2)}R`, n: `recovery ${sn.recoveryFactor === null ? "—" : num(sn.recoveryFactor, 2)}`, c: "" },
    { l: "Sharpe / trade", v: sn.sharpePerTrade === null ? "—" : num(sn.sharpePerTrade, 2), n: "not annualised", c: "" },
    { l: "Compliance", v: closed.some((t) => t.plan_followed !== null) ? pct(comp, 0) : "—", n: `losing streak ${sn.longestLosingStreak}`, c: comp < 0.9 && closed.some((t) => t.plan_followed !== null) ? "warn" : "" },
  ];

  // curves
  const W = 800, H = 240;
  const cum = (xs: number[]) => { let c = 0; return [0, ...xs.map((x) => (c += x))]; };
  const cg = cum(gross), cn = cum(net);
  const lo = Math.min(0, ...cg, ...cn), hi = Math.max(0, ...cg, ...cn), sp = hi - lo || 1;
  const path = (v: number[]) => v.map((y, i) => `${i ? "L" : "M"}${((i / Math.max(1, v.length - 1)) * W).toFixed(1)},${(H - 10 - ((y - lo) / sp) * (H - 20)).toFixed(1)}`).join(" ");
  const zeroY = H - 10 - ((0 - lo) / sp) * (H - 20);

  // histogram
  const buckets = [
    { l: "≤ −1", f: (r: number) => r <= -1, col: "var(--down)" }, { l: "−1–0", f: (r: number) => r > -1 && r < 0, col: "var(--down)" },
    { l: "0–1", f: (r: number) => r >= 0 && r < 1, col: "var(--faint)" }, { l: "1–2", f: (r: number) => r >= 1 && r < 2, col: "var(--up)" },
    { l: "2–3", f: (r: number) => r >= 2 && r < 3, col: "var(--up)" }, { l: "≥ 3", f: (r: number) => r >= 3, col: "var(--accent)" },
  ].map((b) => ({ ...b, c: net.filter(b.f).length }));
  const hmax = Math.max(1, ...buckets.map((b) => b.c));

  const breakdown = (t: string, key: (x: Trade) => string) => {
    const m = new Map<string, Trade[]>();
    for (const x of closed) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
    const rows = Array.from(m, ([k, xs]) => { const g = summarize(xs.map((x) => Number(x.realized_r))), n = summarize(xs.map(netR)); return { k, n: g.n, wr: n.winRate, eg: g.avgR, en: n.avgR, net: n.netR }; }).sort((a, b) => b.net - a.net);
    const mx = Math.max(0.0001, ...rows.map((r) => Math.abs(r.net)));
    return { t, rows, mx };
  };
  const bds = [
    breakdown("Model", (x) => x.model ?? "—"),
    breakdown("Window", (x) => WIN[x.session_window ?? ""] ?? "—"),
    breakdown("Instrument", (x) => x.instrument),
    breakdown("Grade", (x) => x.grade ?? "ungraded"),
  ];

  // calendar: last 5 weeks, Mon–Fri
  const byDay = new Map<string, number>();
  for (const t of closed) { const d = istDay(t.closed_at ?? t.opened_at); byDay.set(d, (byDay.get(d) ?? 0) + netR(t)); }
  const monday = new Date(); monday.setHours(12, 0, 0, 0); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7) - 28);
  const weeks = Array.from({ length: 5 }, (_, w) => Array.from({ length: 5 }, (_, d) => { const x = new Date(monday); x.setDate(monday.getDate() + w * 7 + d); return istDay(+x); }));
  const cmax = Math.max(1, ...Array.from(byDay.values()).map(Math.abs));

  return (
    <>
      <ErrorNote error={trades.error} />
      <div className="row"><Seg label="Scope" value={scope} onChange={setScope} options={[{ v: "master", l: "Master" }, { v: "all", l: "All accounts" }]} /></div>
      <section className="auto-s" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(150px, 100%), 1fr))" }}>
        {kpis.map((k) => <div key={k.l} className="card"><div className="lbl">{k.l}</div><div className={`kv sm ${k.c}`} style={{ marginTop: 4 }}>{k.v}</div><div className="faint" style={{ fontSize: 11 }}>{k.n}</div></div>)}
      </section>

      <section className="g12">
        <Card span={8} title={`Equity in R · ${scope === "master" ? "master" : "all accounts"}`} right={<span className="row" style={{ fontSize: 12, gap: 12 }}><span className="row"><span className="dot acc" />Net of fees</span><span className="row"><span className="dot faint" />Gross</span></span>}>
          {closed.length < 2 ? <Empty>No closed trades yet</Empty> : (
            <>
              <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: 240, display: "block" }} role="img" aria-label="Cumulative R, gross and net">
                <line x1="0" x2={W} y1={zeroY} y2={zeroY} stroke="var(--line-2)" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
                <path d={path(cg)} stroke="var(--faint)" strokeWidth="1.5" fill="none" vectorEffect="non-scaling-stroke" />
                <path d={path(cn)} stroke="var(--accent)" strokeWidth="2.2" fill="none" vectorEffect="non-scaling-stroke" />
              </svg>
              <div className="between mono faint" style={{ fontSize: 11 }}><span>trade 1</span><span>trade {closed.length}</span></div>
            </>
          )}
        </Card>
        <Card span={4} title="R distribution">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0,1fr))", gap: 10, alignItems: "end", height: 170 }}>
            {buckets.map((b) => (
              <div key={b.l} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, height: "100%", justifyContent: "flex-end" }}>
                <span className="mono faint" style={{ fontSize: 11 }}>{b.c}</span>
                <i style={{ display: "block", width: "100%", borderRadius: "7px 7px 2px 2px", height: `${(b.c / hmax) * 100}%`, minHeight: b.c ? 4 : 0, background: b.col }} />
                <span className="mono" style={{ fontSize: 11 }}>{b.l}</span>
              </div>
            ))}
          </div>
        </Card>
      </section>

      <section className="g12">
        {bds.map((b) => (
          <div key={b.t} className="card flush s6">
            <div className="ch" style={{ padding: "14px 16px 0" }}><h3>By {b.t.toLowerCase()}</h3></div>
            {b.rows.length === 0 ? <div style={{ padding: 16 }}><Empty>No closed trades</Empty></div> : (
              <Table head={[b.t, "Trades", "Win %", "Exp. gross", "Exp. net", "Net R"]} right={[1, 2, 3, 4]}>
                {b.rows.map((r) => (
                  <tr key={r.k}><td><b style={{ fontWeight: 500 }}>{r.k}</b></td><td className="r mono">{r.n}</td><td className="r mono">{pct(r.wr, 0)}</td><td className="r mono">{rfmt(r.eg)}</td><td className={`r mono ${r.en >= 0 ? "up" : "down"}`}>{rfmt(r.en)}</td><td style={{ width: "30%" }}><Bar pct={(Math.abs(r.net) / b.mx) * 100} tone={r.net >= 0 ? "up" : "down"} /></td></tr>
                ))}
              </Table>
            )}
          </div>
        ))}
      </section>

      <section className="g12">
        <Card span={6} title="Daily net R · last 5 weeks">
          <div style={{ display: "grid", gridTemplateColumns: "36px repeat(5, minmax(0,1fr))", gap: 5 }}>
            {["", "Mon", "Tue", "Wed", "Thu", "Fri"].map((h, i) => <span key={i} className="faint" style={{ height: 30, display: "grid", placeItems: "center", fontSize: 10.5 }}>{h}</span>)}
            {weeks.map((wk, wi) => (
              <Fragment key={`w${wi}`}>
                <span className="mono faint" style={{ height: 30, display: "grid", placeItems: "center", fontSize: 10.5 }}>W{wi + 1}</span>
                {wk.map((d) => {
                  const v = byDay.get(d);
                  const a = v === undefined ? 0 : Math.round((Math.abs(v) / cmax) * 60) + 15;
                  return <span key={d} className="mono" title={d} style={{ height: 30, borderRadius: 7, display: "grid", placeItems: "center", fontSize: 10.5, background: v === undefined ? "var(--surface-2)" : `color-mix(in srgb, ${v >= 0 ? "var(--up)" : "var(--down)"} ${a}%, var(--surface-2))`, color: v === undefined ? "var(--faint)" : "var(--text)" }}>{v === undefined ? "·" : rfmt(v, 1)}</span>;
                })}
              </Fragment>
            ))}
          </div>
        </Card>
        <Card span={6} title="How these are calculated">
          <div className="col" style={{ gap: 7, fontSize: 12 }}>
            {[["Expectancy", "mean R per trade"], ["Break-even win rate at 3R", "1 ÷ (1 + 3) = 25%"], ["With cost c (in R)", "(1 + c) ÷ (R + 1)"], ["Net R", "gross R − fees ÷ money at risk"], ["Profit factor", "gross wins ÷ |gross losses|"], ["Max drawdown", "largest peak-to-trough in R"], ["Sharpe (per trade)", "mean R ÷ stdev R · not annualised"], ["Recovery factor", "net R ÷ max DD R"]].map(([k, v]) => (
              <div key={k} className="between"><span className="muted">{k}</span><span className="mono">{v}</span></div>
            ))}
            <div className="divider" />
            <span className="faint">Judge the system on 100 trades and any rule change on 30+.</span>
          </div>
        </Card>
      </section>
    </>
  );
}
