"use client";

import { Fragment, useMemo, useState } from "react";
import { LIVE_INSTRUMENT_IDS as INSTRUMENT_IDS } from "@aplus/engine";
import { useRows } from "@/lib/useRows";
import { matchesOwner, ownerOf, ownerOptions } from "@/lib/accounts";
import { istDay } from "@/lib/derive";
import type { CashFlow, Investor, Trade, TradingAccount } from "@/lib/types";
import { money, num, pct } from "@/lib/fmt";
import { Bar, Card, Empty, ErrorNote, Seg, Table } from "@/components/ui";
import EdgeAnalytics from "@/components/EdgeAnalytics";

const RANGES = [{ v: "7", l: "7D" }, { v: "30", l: "30D" }, { v: "90", l: "90D" }, { v: "365", l: "1Y" }, { v: "0", l: "All" }] as const;
const WIN: Record<string, string> = { london_q: "London Q", ny_q: "NY Q", asia_q: "Asia", london_close: "London close" };
const net = (t: Trade) => Number(t.pnl ?? 0);
const holdMin = (t: Trade) => (t.closed_at ? (+new Date(t.closed_at) - +new Date(t.opened_at)) / 60000 : 0);

function group(trades: Trade[], key: (t: Trade) => string) {
  const m = new Map<string, Trade[]>();
  for (const t of trades) m.set(key(t), [...(m.get(key(t)) ?? []), t]);
  const rows = [...m].map(([k, xs]) => {
    const p = xs.reduce((s, t) => s + net(t), 0);
    const w = xs.filter((t) => net(t) > 0);
    const gl = xs.filter((t) => net(t) < 0).reduce((s, t) => s + net(t), 0);
    return { k, n: xs.length, pnl: p, wr: xs.length ? w.length / xs.length : 0, pf: gl ? w.reduce((s, t) => s + net(t), 0) / Math.abs(gl) : null, avg: xs.length ? p / xs.length : 0 };
  }).sort((a, b) => b.pnl - a.pnl);
  return { rows, max: Math.max(1e-9, ...rows.map((r) => Math.abs(r.pnl))) };
}

function GroupCard({ title, trades, keyFn, span = 6 }: { title: string; trades: Trade[]; keyFn: (t: Trade) => string; span?: 4 | 6 }) {
  const g = group(trades, keyFn);
  return (
    <div className={`card flush s${span}`}>
      <div className="ch" style={{ padding: "14px 16px 0" }}><h3>{title}</h3></div>
      {g.rows.length === 0 ? <div style={{ padding: 16 }}><Empty>No closed trades</Empty></div> : (
        <Table head={["", "Trades", "Win", "PF", "Avg", "Net P&L", ""]} right={[1, 2, 3, 4, 5]}>
          {g.rows.map((r) => (
            <tr key={r.k}>
              <td><b style={{ fontWeight: 500 }}>{r.k}</b></td>
              <td className="r mono">{r.n}</td>
              <td className="r mono">{pct(r.wr, 0)}</td>
              <td className="r mono">{r.pf === null ? "—" : num(r.pf, 2)}</td>
              <td className={`r mono ${r.avg >= 0 ? "up" : "down"}`}>{money(r.avg)}</td>
              <td className={`r mono ${r.pnl >= 0 ? "up" : "down"}`}>{money(r.pnl)}</td>
              <td style={{ width: "22%" }}><Bar pct={(Math.abs(r.pnl) / g.max) * 100} tone={r.pnl >= 0 ? "up" : "down"} /></td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}

export default function Analytics() {
  const trades = useRows<Trade>({ table: "trades", order: "opened_at", ascending: true, limit: 10000 });
  const accounts = useRows<TradingAccount>({ table: "trading_accounts", order: "created_at", ascending: true });
  const investors = useRows<Investor>({ table: "investors", select: "id,name", order: "name", ascending: true });
  const flows = useRows<CashFlow>({ table: "cash_flows", order: "at", ascending: true, limit: 5000 });
  const [owner, setOwner] = useState("all");
  const [account, setAccount] = useState("all");
  const [inst, setInst] = useState("all");
  const [range, setRange] = useState<(typeof RANGES)[number]["v"]>("30");
  const [tab, setTab] = useState<"pnl" | "edge">("pnl");
  const [source, setSource] = useState<"real" | "paper" | "all">("real");

  const accs = (accounts.rows ?? []).filter((a) => a.currency !== "INR" && matchesOwner(a, owner) && (account === "all" || a.id === account));
  const ids = new Set(accs.map((a) => a.id));
  const since = range === "0" ? 0 : Date.now() - Number(range) * 86_400_000;
  const closed = useMemo(() => (trades.rows ?? []).filter((t) => t.closed_at && t.pnl !== null && ids.has(t.account_id) && (inst === "all" || t.instrument === inst) && +new Date(t.closed_at) >= since && (source === "all" || (source === "paper" ? t.source === "paper" : t.source !== "paper"))), [trades.rows, accs, inst, since, source]); // eslint-disable-line react-hooks/exhaustive-deps

  // money statistics
  const pnl = closed.reduce((s, t) => s + net(t), 0);
  const wins = closed.filter((t) => net(t) > 0), losses = closed.filter((t) => net(t) < 0);
  const gp = wins.reduce((s, t) => s + net(t), 0), gl = losses.reduce((s, t) => s + net(t), 0);
  const fees = closed.reduce((s, t) => s + Number(t.fees ?? 0) + Number(t.funding ?? 0), 0);
  const avgWin = wins.length ? gp / wins.length : 0, avgLoss = losses.length ? gl / losses.length : 0;
  const equityNow = accs.reduce((s, a) => s + Number(a.equity), 0);
  const fl = (flows.rows ?? []).filter((f) => ids.has(f.account_id) && +new Date(f.at) >= since);
  const netFlows = fl.reduce((s, f) => s + (f.kind === "deposit" ? 1 : f.kind === "withdrawal" || f.kind === "payout" || f.kind === "fee" ? -1 : 0) * Number(f.amount), 0);
  const startEq = equityNow - pnl - netFlows;
  const ret = startEq > 0 ? pnl / startEq : null;

  // daily series
  const byDay = new Map<string, number>();
  for (const t of closed) byDay.set(istDay(t.closed_at!), (byDay.get(istDay(t.closed_at!)) ?? 0) + net(t));
  const days = [...byDay.keys()].sort();
  const daily = days.map((d) => byDay.get(d)!);
  let cum = 0, peak = 0, maxDd = 0, streak = 0, worstStreak = 0;
  const curve = daily.map((v) => { cum += v; peak = Math.max(peak, cum); maxDd = Math.max(maxDd, peak - cum); return cum; });
  for (const t of closed) { if (net(t) < 0) { streak++; worstStreak = Math.max(worstStreak, streak); } else if (net(t) > 0) streak = 0; }
  const mean = daily.length ? daily.reduce((a, b) => a + b, 0) / daily.length : 0;
  const sd = daily.length > 1 ? Math.sqrt(daily.reduce((a, b) => a + (b - mean) ** 2, 0) / (daily.length - 1)) : 0;
  const dsd = daily.length > 1 ? Math.sqrt(daily.filter((x) => x < 0).reduce((a, b) => a + b * b, 0) / (daily.length - 1)) : 0;
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(365) : null, sortino = dsd > 0 ? (mean / dsd) * Math.sqrt(365) : null;
  const best = days.length ? days.reduce((a, d) => (byDay.get(d)! > byDay.get(a)! ? d : a)) : null;
  const worst = days.length ? days.reduce((a, d) => (byDay.get(d)! < byDay.get(a)! ? d : a)) : null;
  const avgHold = closed.length ? closed.reduce((s, t) => s + holdMin(t), 0) / closed.length : 0;

  const kpis = [
    { l: "Net P&L", v: money(pnl), n: ret !== null ? `${ret >= 0 ? "+" : ""}${pct(ret, 2)} on ${money(startEq, "USD", 0)}` : "", c: pnl >= 0 ? "up" : "down" },
    { l: "Trades · win rate", v: `${closed.length} · ${pct(closed.length ? wins.length / closed.length : 0, 0)}`, n: `${wins.length} W · ${losses.length} L`, c: "" },
    { l: "Profit factor", v: gl ? num(gp / Math.abs(gl), 2) : "—", n: `${money(gp, "USD", 0)} / ${money(gl, "USD", 0)}`, c: "" },
    { l: "Expectancy / trade", v: money(closed.length ? pnl / closed.length : 0), n: `avg win ${money(avgWin, "USD", 0)} · loss ${money(avgLoss, "USD", 0)}`, c: pnl >= 0 ? "up" : "down" },
    { l: "Payoff ratio", v: avgLoss ? num(avgWin / Math.abs(avgLoss), 2) : "—", n: `largest ${money(Math.max(0, ...closed.map(net)), "USD", 0)} / ${money(Math.min(0, ...closed.map(net)), "USD", 0)}`, c: "" },
    { l: "Max drawdown", v: money(-maxDd, "USD", 0), n: `losing streak ${worstStreak}`, c: maxDd ? "down" : "" },
    { l: "Sharpe · Sortino", v: `${sharpe === null ? "—" : num(sharpe, 2)} · ${sortino === null ? "—" : num(sortino, 2)}`, n: "daily, annualised √365", c: "" },
    { l: "Costs", v: money(-fees), n: `avg hold ${avgHold >= 60 ? `${(avgHold / 60).toFixed(1)} h` : `${avgHold.toFixed(0)} min`}`, c: fees ? "down" : "" },
  ];

  // monthly
  const months = new Map<string, { n: number; p: number }>();
  for (const t of closed) { const k = istDay(t.closed_at!).slice(0, 7); const m = months.get(k) ?? { n: 0, p: 0 }; m.n++; m.p += net(t); months.set(k, m); }

  // calendar: last 8 weeks, Mon–Sun (crypto trades weekends)
  const monday = new Date(); monday.setHours(12, 0, 0, 0); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7) - 49);
  const weeks = Array.from({ length: 8 }, (_, w) => Array.from({ length: 7 }, (_, d) => { const x = new Date(monday); x.setDate(monday.getDate() + w * 7 + d); return istDay(+x); }));
  const allByDay = new Map<string, number>();
  for (const t of (trades.rows ?? []).filter((t) => t.closed_at && t.pnl !== null && ids.has(t.account_id) && (inst === "all" || t.instrument === inst) && (source === "all" || (source === "paper" ? t.source === "paper" : t.source !== "paper")))) allByDay.set(istDay(t.closed_at!), (allByDay.get(istDay(t.closed_at!)) ?? 0) + net(t));
  const cmax = Math.max(1, ...[...allByDay.values()].map(Math.abs));

  // charts
  const W = 800, H = 220;
  const lo = Math.min(0, ...curve), hi = Math.max(0, ...curve), sp = hi - lo || 1;
  const path = curve.map((y, i) => `${i ? "L" : "M"}${((i / Math.max(1, curve.length - 1)) * W).toFixed(1)},${(H - 10 - ((y - lo) / sp) * (H - 20)).toFixed(1)}`).join(" ");
  const zeroY = H - 10 - ((0 - lo) / sp) * (H - 20);
  const dmax = Math.max(1e-9, ...daily.map(Math.abs));
  const invs = investors.rows ?? [];
  const accName = (id: string) => (accounts.rows ?? []).find((a) => a.id === id)?.name ?? "—";
  const accOwner = (id: string) => { const a = (accounts.rows ?? []).find((x) => x.id === id); return a ? ownerOf(a, invs).label : "—"; };
  const label = owner === "all" ? "all accounts" : owner === "own" ? "own accounts" : invs.find((i) => i.id === owner)?.name ?? "investor";

  return (
    <>
      <ErrorNote error={trades.error || accounts.error} />
      <div className="row">
        <Seg label="View" value={tab} onChange={setTab} options={[{ v: "pnl", l: "P&L ($)" }, { v: "edge", l: "Edge (R)" }]} />
        <div className="inp" style={{ width: 170, height: 32 }}><select aria-label="Owner" value={owner} onChange={(e) => { setOwner(e.target.value); setAccount("all"); }}>{ownerOptions(invs).map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}</select></div>
        <div className="inp" style={{ width: 190, height: 32 }}><select aria-label="Account" value={account} onChange={(e) => setAccount(e.target.value)}><option value="all">Every account</option>{(accounts.rows ?? []).filter((a) => matchesOwner(a, owner)).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div>
        <div className="inp" style={{ width: 140, height: 32 }}><select aria-label="Instrument" value={inst} onChange={(e) => setInst(e.target.value)}><option value="all">All pairs</option>{INSTRUMENT_IDS.map((i) => <option key={i} value={i}>{i}</option>)}</select></div>
        <Seg label="Trades" value={source} onChange={setSource} options={[{ v: "real", l: "Real" }, { v: "paper", l: "Paper" }, { v: "all", l: "Both" }]} />
        <span style={{ flex: 1 }} />
        <Seg label="Range" value={range} onChange={setRange} options={RANGES} />
      </div>

      {tab === "edge" ? <EdgeAnalytics trades={closed} label={label} /> : (
        <>
          <section className="auto-s" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(170px, 100%), 1fr))" }}>
            {kpis.map((k) => <div key={k.l} className="card"><div className="lbl">{k.l}</div><div className={`kv sm ${k.c}`} style={{ marginTop: 4 }}>{k.v}</div><div className="faint" style={{ fontSize: 11 }}>{k.n}</div></div>)}
          </section>

          <section className="g12">
            <Card span={8} title={`Cumulative P&L · ${label}`} right={<span className="faint mono" style={{ fontSize: 11 }}>{best ? `best ${best} ${money(byDay.get(best)!, "USD", 0)} · worst ${worst} ${money(byDay.get(worst!)!, "USD", 0)}` : ""}</span>}>
              {curve.length < 2 ? <Empty>Not enough closed trades in this range</Empty> : (
                <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: 220, display: "block" }} role="img" aria-label="Cumulative P&L">
                  <line x1="0" x2={W} y1={zeroY} y2={zeroY} stroke="var(--line-2)" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
                  <path d={`${path} L${W},${zeroY} L0,${zeroY} Z`} fill="var(--accent-bg)" />
                  <path d={path} stroke="var(--accent)" strokeWidth="2.2" fill="none" vectorEffect="non-scaling-stroke" />
                </svg>
              )}
            </Card>
            <Card span={4} title="Daily P&L">
              {daily.length === 0 ? <Empty>No days</Empty> : (
                <svg viewBox={`0 0 ${Math.max(10, daily.length * 10)} 120`} preserveAspectRatio="none" style={{ width: "100%", height: 220, display: "block" }} role="img" aria-label="Daily P&L bars">
                  <line x1="0" x2={daily.length * 10} y1="60" y2="60" stroke="var(--line-2)" vectorEffect="non-scaling-stroke" />
                  {daily.map((v, i) => { const h = (Math.abs(v) / dmax) * 56; return <rect key={i} x={i * 10 + 1.5} width="7" y={v >= 0 ? 60 - h : 60} height={Math.max(0.8, h)} rx="1.5" fill={v >= 0 ? "var(--up)" : "var(--down)"} />; })}
                </svg>
              )}
            </Card>
          </section>

          <section className="g12">
            <Card span={7} title="Calendar · last 8 weeks (IST)">
              <div style={{ display: "grid", gridTemplateColumns: "34px repeat(7, minmax(0,1fr))", gap: 4 }}>
                {["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((h, i) => <span key={i} className="faint" style={{ height: 26, display: "grid", placeItems: "center", fontSize: 10.5 }}>{h}</span>)}
                {weeks.map((wk, wi) => (
                  <Fragment key={wi}>
                    <span className="mono faint" style={{ height: 30, display: "grid", placeItems: "center", fontSize: 10 }}>{wk[0]!.slice(5)}</span>
                    {wk.map((d) => {
                      const v = allByDay.get(d);
                      const a = v === undefined ? 0 : Math.round((Math.abs(v) / cmax) * 60) + 15;
                      return <span key={d} className="mono" title={`${d}${v !== undefined ? ` · ${money(v)}` : ""}`} style={{ height: 30, borderRadius: 7, display: "grid", placeItems: "center", fontSize: 10, background: v === undefined ? "var(--surface-2)" : `color-mix(in srgb, ${v >= 0 ? "var(--up)" : "var(--down)"} ${a}%, var(--surface-2))`, color: v === undefined ? "var(--faint)" : "var(--text)" }}>{v === undefined ? "·" : Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0)}</span>;
                    })}
                  </Fragment>
                ))}
              </div>
            </Card>
            <Card span={5} title="By month">
              {months.size === 0 ? <Empty>No closed trades</Empty> : (
                <Table head={["Month", "Trades", "Net P&L"]} right={[1, 2]}>
                  {[...months].sort((a, b) => b[0].localeCompare(a[0])).map(([k, m]) => <tr key={k}><td className="mono">{k}</td><td className="r mono">{m.n}</td><td className={`r mono ${m.p >= 0 ? "up" : "down"}`}>{money(m.p)}</td></tr>)}
                </Table>
              )}
              {fl.length > 0 && <p className="faint" style={{ fontSize: 11.5, marginTop: 8 }}>Net cash flows in range: {money(netFlows)} (excluded from P&L and return).</p>}
            </Card>
          </section>

          <section className="g12">
            <GroupCard title="By account" trades={closed} keyFn={(t) => accName(t.account_id)} />
            <GroupCard title="By owner" trades={closed} keyFn={(t) => accOwner(t.account_id)} />
            <GroupCard title="By instrument" trades={closed} keyFn={(t) => t.instrument} />
            <GroupCard title="By session" trades={closed} keyFn={(t) => WIN[t.session_window ?? ""] ?? "Outside window"} />
            <GroupCard title="By weekday (IST)" trades={closed} keyFn={(t) => new Date(t.opened_at).toLocaleDateString("en-GB", { weekday: "short", timeZone: "Asia/Kolkata" })} />
            <GroupCard title="By hour opened (IST)" trades={closed} keyFn={(t) => `${new Date(t.opened_at).toLocaleTimeString("en-GB", { hour: "2-digit", hour12: false, timeZone: "Asia/Kolkata" })}:00`} />
            <GroupCard title="By side" trades={closed} keyFn={(t) => t.side} />
            <GroupCard title="By model & grade" trades={closed} keyFn={(t) => `${t.model ?? "—"} · ${t.grade ?? "ungraded"}`} />
          </section>
        </>
      )}
    </>
  );
}
