"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useRows } from "@/lib/useRows";
import { useApi } from "@/lib/useApi";
import { matchesOwner, ownerOptions } from "@/lib/accounts";
import { equitySeries, istDay, todayIst } from "@/lib/derive";
import type { CalEvent } from "@/lib/server/news";
import type { Investor, TelegramAlert, Trade, TradingAccount } from "@/lib/types";
import type { CandidateStats } from "@/lib/promotion";
import { money, num, pct, timeShort } from "@/lib/fmt";
import { Card, Chip, Empty, ErrorNote, Icon } from "@/components/ui";
import { ICONS, sessionName, useMe } from "@/components/Shell";
import { useOpenTrades, type LiveRow } from "@/components/DashboardLive";
import { arenaOf, type ArenaId } from "@/lib/arenas";

const REFRESH_MS = 30_000;

const ARENAS: { id: ArenaId; name: string; ac: string }[] = [
  { id: "cfd", name: "CFD Arena", ac: "--cfd" }, { id: "delta", name: "Delta Arena", ac: "--delta" },
  { id: "coinswitch", name: "CoinSwitch Arena", ac: "--cs" }, { id: "fyers", name: "Fyers Arena", ac: "--fyers" },
];
const tone = (v: number) => (v > 0 ? "up" : v < 0 ? "down" : "");
const signedMoney = (v: number, ccy = "USD") => `${v > 0 ? "+" : ""}${money(v, ccy, 0)}`;

type Candidate = { key: string; instrument: string; model: string; strategy: string | null; status: "paper" | "live" | "benched"; stats: Partial<CandidateStats> };
type Signal = { id: string; instrument: string; side: string | null; created_at: string };

/** Smooth area chart drawn to scale, one series, three faint gridlines. */
function AreaChart({ vals, labels, h = 220 }: { vals: number[]; labels: string[]; h?: number }) {
  const W = 800, H = h, padR = 64, padB = 22, padT = 10;
  if (vals.length < 2) return <Empty>Not enough history yet</Empty>;
  let mn = Math.min(...vals), mx = Math.max(...vals); const rg = mx - mn || Math.max(1, mx * 0.01); mn -= rg * 0.08; mx += rg * 0.08;
  const X = (i: number) => (i / (vals.length - 1)) * (W - padR), Y = (v: number) => padT + ((mx - v) / (mx - mn)) * (H - padT - padB);
  const d = vals.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
  const ticks = [0, 1, 2, 3].map((i) => mn + ((mx - mn) * i) / 3);
  const step = Math.ceil(labels.length / 5);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }} role="img" aria-label="Equity curve">
      <defs><linearGradient id="eqfill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="var(--accent)" stopOpacity=".18" /><stop offset="1" stopColor="var(--accent)" stopOpacity="0" /></linearGradient></defs>
      {ticks.map((v) => <g key={v}><line x1={0} x2={W - padR} y1={Y(v)} y2={Y(v)} stroke="var(--line)" strokeDasharray="2 5" /><text x={W - padR + 10} y={Y(v) + 4} fill="var(--faint)" style={{ font: "11px var(--font-geist-mono), monospace" }}>{v >= 1000 ? `$${num(v / 1000, 0)}k` : `$${num(v, 0)}`}</text></g>)}
      {labels.map((l, i) => i % step === 0 && i < labels.length - step / 2 ? <text key={i} x={X(i)} y={H - 4} textAnchor="middle" fill="var(--faint)" style={{ font: "11px var(--font-geist-mono), monospace" }}>{l}</text> : null)}
      <path d={`${d} L${X(vals.length - 1)},${H - padB} L0,${H - padB} Z`} fill="url(#eqfill)" />
      <path d={d} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      <circle cx={X(vals.length - 1)} cy={Y(vals.at(-1)!)} r={4} fill="var(--accent)" stroke="var(--surface)" strokeWidth={2} />
    </svg>
  );
}

function Sparkline({ vals, color }: { vals: number[]; color: string }) {
  if (vals.length < 2) return <div style={{ height: 34 }} />;
  const mn = Math.min(...vals), mx = Math.max(...vals);
  const d = vals.map((v, i) => `${i ? "L" : "M"}${((i / (vals.length - 1)) * 120).toFixed(1)},${(31 - ((v - mn) / (mx - mn || 1)) * 28).toFixed(1)}`).join(" ");
  return <svg viewBox="0 0 120 34" preserveAspectRatio="none" style={{ width: "100%", height: 34, display: "block" }}><path d={d} fill="none" stroke={color} strokeWidth={1.8} vectorEffect="non-scaling-stroke" /></svg>;
}

/** Stop → target bar with the entry marked; fill runs from entry to the current price. */
function RBar({ x }: { x: LiveRow }) {
  if (x.price === null || x.target === null) return <span className="faint">—</span>;
  const lo = Math.min(x.stop, x.target), hi = Math.max(x.stop, x.target), P = (v: number) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
  const e = P(x.entry), n = P(x.price);
  return <div className="rbar"><i style={{ left: `${Math.min(e, n)}%`, width: `${Math.abs(n - e)}%`, background: `var(${(x.uR ?? 0) >= 0 ? "--up" : "--down"})` }} /><b style={{ left: `${e}%` }} /></div>;
}

export default function Dashboard() {
  const me = useMe();
  const accounts = useRows<TradingAccount>({ table: "trading_accounts", order: "created_at", ascending: true });
  const investors = useRows<Investor>({ table: "investors", select: "id,name,stage,fee_rate", order: "name", ascending: true });
  const trades = useRows<Trade>({ table: "trades", order: "opened_at", limit: 5000 });
  const alerts = useRows<TelegramAlert>({ table: "telegram_alerts", order: "at", limit: 20 });
  const cands = useRows<Candidate>({ table: "strategy_candidates", order: "updated_at" });
  const armed = useRows<Signal>({ table: "signals", select: "id,instrument,side,created_at", eq: ["state", "ARMED"], order: "created_at", limit: 10 });
  const cal = useApi<{ items: CalEvent[] }>("/api/calendar", 1_800_000);
  const open = useOpenTrades();
  const [owner, setOwner] = useState("all");
  const [days, setDays] = useState(90);

  const reloads = [accounts.reload, trades.reload, armed.reload];
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === "visible") reloads.forEach((f) => f()); }, REFRESH_MS);
    return () => clearInterval(t);
  }, [accounts.reload, trades.reload, armed.reload]); // eslint-disable-line react-hooks/exhaustive-deps

  const all = (accounts.rows ?? []).filter((a) => a.active);
  const usd = all.filter((a) => a.currency !== "INR");
  const ids = new Set(usd.map((a) => a.id));
  const allTrades = trades.rows ?? [];
  const real = allTrades.filter((t) => ids.has(t.account_id) && t.source !== "paper");
  const today = todayIst();
  const closed = (xs: Trade[], f: (d: string) => boolean) => xs.filter((t) => t.closed_at && t.pnl !== null && f(istDay(t.closed_at)));
  const sum = (xs: Trade[]) => xs.reduce((s, t) => s + Number(t.pnl ?? 0), 0);
  const aum = usd.reduce((s, a) => s + Number(a.equity), 0);
  const pnlToday = sum(closed(real, (d) => d === today));
  const s = useMemo(() => equitySeries(usd, real, (a) => matchesOwner(a, owner), days), [usd, real, owner, days]); // eslint-disable-line react-hooks/exhaustive-deps
  const labels = s.vals.map((_, i) => new Date(Date.now() - (s.vals.length - 1 - i) * 86_400_000).toLocaleDateString("en-GB", { day: "numeric", month: "short" }));
  const win = closed(real, (d) => d >= istDay(Date.now() - days * 86_400_000));
  const wins = win.filter((t) => Number(t.pnl) > 0), losses = win.filter((t) => Number(t.pnl) < 0);
  const gross = (xs: Trade[]) => Math.abs(sum(xs));
  const pf = gross(losses) ? gross(wins) / gross(losses) : null;
  const exp = win.length ? win.reduce((t, x) => t + Number(x.realized_r ?? 0), 0) / win.length : null;

  // Things that need the owner now, most urgent first.
  const now = Date.now();
  const recentArmed = (armed.rows ?? []).filter((x) => Date.parse(x.created_at) > now - 6 * 3_600_000);
  const nextHigh = (cal.data?.items ?? []).find((e) => e.impact === "high" && e.at > now - 15 * 60_000 && e.at < now + 24 * 3_600_000);
  const failed = (alerts.rows ?? []).filter((a) => a.status === "failed" && Date.parse(a.at) > now - 24 * 3_600_000);
  const benched = (cands.rows ?? []).filter((c) => c.status === "benched").slice(0, 1);
  const attention: { c: string; i: string; t: string; s: string; b: string; h: string }[] = [
    ...(me.settings?.kill_switch ? [{ c: "--down", i: ICONS.power, t: "Kill switch is on", s: "No orders go to any account", b: "Review", h: "/risk" }] : []),
    ...recentArmed.map((x) => ({ c: "--accent", i: ICONS.cfd, t: `${x.instrument} ${x.side ?? ""} is armed`.trim(), s: `Armed ${timeShort(Date.parse(x.created_at), "Asia/Kolkata")} IST`, b: "Open", h: "/arena/cfd" })),
    ...(nextHigh ? [{ c: "--warn", i: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM12 7v5l3 2", t: `${nextHigh.currency} ${nextHigh.title}`, s: `${timeShort(nextHigh.at, "Asia/Kolkata")} IST · engines pause ±15 min`, b: "View", h: "/arena/cfd?tab=bias" }] : []),
    ...(failed.length ? [{ c: "--down", i: ICONS.send, t: `${failed.length} Telegram alert${failed.length > 1 ? "s" : ""} failed`, s: "In the last 24 hours", b: "Check", h: "/alerts" }] : []),
    ...benched.map((c) => ({ c: "--down", i: ICONS.league, t: `${c.strategy ?? c.model} benched`, s: `${c.instrument} · back on paper`, b: "Review", h: "/league" })),
  ].slice(0, 5);

  const arenaStats = ARENAS.map((ar) => {
    const accs = all.filter((a) => arenaOf(a) === ar.id);
    const aIds = new Set(accs.map((a) => a.id));
    const tr = allTrades.filter((t) => aIds.has(t.account_id));
    const td = sum(closed(tr, (d) => d === today));
    const series = Array.from({ length: 30 }, (_, i) => istDay(now - (29 - i) * 86_400_000)).map((d) => sum(closed(tr, (x) => x === d))).reduce<number[]>((acc, v) => [...acc, (acc.at(-1) ?? 0) + v], []);
    const ccy = accs[0]?.currency ?? "USD";
    const liveC = (cands.rows ?? []).filter((c) => c.status === "live").length;
    return { ...ar, accs, td, series, ccy, open: tr.filter((t) => t.exit === null).length, liveC };
  });

  const props = all.filter((a) => a.type === "eval" || a.firm_rules?.profit_target_pct);
  const league = [...(cands.rows ?? [])].filter((c) => c.status !== "benched").sort((a, b) => (b.stats.expectancy ?? -9) - (a.stats.expectancy ?? -9)).slice(0, 5);
  const events = (cal.data?.items ?? []).filter((e) => e.impact !== "low" && e.at > now - 30 * 60_000).slice(0, 6);
  const liveRows = open.d ? open.d.trades : [];

  return (
    <>
      <ErrorNote error={accounts.error || trades.error} />
      <div className="page-h">
        <div><h1>Good {new Date().getHours() < 12 ? "morning" : new Date().getHours() < 17 ? "afternoon" : "evening"}, {me.name.split(/[\s._-]/)[0]}</h1>
          <p>{new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })} · {sessionName() === "Weekend" ? "Weekend, crypto markets only" : `${sessionName()} session`}</p></div>
        <div className="sp" />
        <div className="inp" style={{ width: 170, height: 32 }}><select aria-label="Owner" value={owner} onChange={(e) => setOwner(e.target.value)}>{ownerOptions(investors.rows ?? []).map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}</select></div>
        <div className="seg" role="group" aria-label="Period">{[30, 90, 365].map((d) => <button key={d} type="button" className={days === d ? "on" : ""} onClick={() => setDays(d)}>{d === 365 ? "1Y" : `${d}D`}</button>)}</div>
      </div>

      <section className="g12">
        <Card span={8}>
          <div className="muted">Total equity · {usd.length} live account{usd.length === 1 ? "" : "s"}</div>
          <div className="kv xl" style={{ marginTop: 8 }}>{money(aum, "USD", 0)}</div>
          <div className="hero-num">
            {s.end > 0 && <Chip tone={s.ret >= 0 ? "up" : "down"}>{s.ret >= 0 ? "+" : ""}{pct(s.ret, 2)} in {days === 365 ? "a year" : `${days} days`}</Chip>}
            <span className="muted">Today <span className={`mono ${tone(pnlToday)}`}>{signedMoney(pnlToday)}</span></span>
          </div>
          <div style={{ margin: "16px 0" }}>{s.end === 0 ? <Empty><Link className="btn sm" href="/accounts">Add an account</Link></Empty> : <AreaChart vals={s.vals} labels={labels} />}</div>
          <div className="stats4">
            <div className="stat"><div className="k">Win rate</div><div className="v">{win.length ? pct(wins.length / win.length, 1) : "—"}</div><div className="s">{win.length} closed trades</div></div>
            <div className="stat"><div className="k">Profit factor</div><div className="v">{pf === null ? "—" : num(pf, 2)}</div><div className="s">after fees</div></div>
            <div className="stat"><div className="k">Expectancy</div><div className={`v ${tone(exp ?? 0)}`}>{exp === null ? "—" : `${exp >= 0 ? "+" : ""}${num(exp, 2)}R`}</div><div className="s">per trade</div></div>
            <div className="stat"><div className="k">Max drawdown</div><div className="v">{s.end ? pct(s.maxDd, 1) : "—"}</div><div className="s">from peak</div></div>
          </div>
        </Card>
        <Card span={4} title="Needs your attention" right={attention.length ? <Chip>{attention.length}</Chip> : undefined}>
          {attention.length === 0 ? <Empty>All clear. Nothing armed, no alerts failed, no high-impact news in the next 24 hours.</Empty> : (
            <div className="att">
              {attention.map((x, i) => (
                <Link key={i} className="att-i" href={x.h}>
                  <span className="ic" style={{ background: `color-mix(in srgb, var(${x.c}) 14%, transparent)`, color: `var(${x.c})` }}><Icon d={x.i} /></span>
                  <div style={{ minWidth: 0 }}><b>{x.t}</b><span className="s">{x.s}</span></div>
                  <span className="btn sm">{x.b}</span>
                </Link>
              ))}
            </div>
          )}
        </Card>
      </section>

      <section className="g12">
        {arenaStats.map((a) => (
          <Link key={a.id} href={`/arena/${a.id}`} className="card s3 arena-card" style={{ "--ac": `var(${a.ac})` } as CSSProperties}>
            <div className="row"><i className="tag" style={{ background: `var(${a.ac})` }} /><b style={{ fontWeight: 500 }}>{a.name}</b><span style={{ flex: 1 }} /><span className={`led ${a.accs.length ? "live" : ""}`} /></div>
            <div><div className="muted" style={{ fontSize: 12.5 }}>Today</div><div className={`kv ${tone(a.td)}`}>{a.accs.length ? signedMoney(a.td, a.ccy) : "—"}</div></div>
            <Sparkline vals={a.series} color={`var(${a.ac})`} />
            <div className="meta"><span>{a.accs.length ? `${a.accs.length} account${a.accs.length > 1 ? "s" : ""}` : "No account yet"}</span><span>{a.open ? `${a.open} open` : a.id === "cfd" ? "Alerts only" : "Paper"}</span></div>
          </Link>
        ))}
      </section>

      <section className="g12">
        <Card span={7} title="Open positions" right={<><span className="faint" style={{ fontSize: 12.5 }}>{open.d ? `${money(open.d.totals.uPnl)} · ${num(open.d.totals.uR, 2)}R` : ""}</span><Link className="btn ghost sm" href="/risk">Risk</Link></>}>
          <ErrorNote error={open.error} />
          {liveRows.length === 0 ? <Empty>Nothing in a trade right now</Empty> : (
            <div className="tbl-w"><table className="tbl"><thead><tr><th>Market</th><th>Side</th><th className="r">P&amp;L</th><th>Stop → target</th><th className="r">R</th></tr></thead><tbody>
              {liveRows.map((x) => (
                <tr key={x.id}>
                  <td><b style={{ fontWeight: 500 }}>{x.instrument}</b><div className="faint" style={{ fontSize: 12 }}>{x.account ?? (x.kind === "paper" ? "Paper" : "Tracked")} · {x.model ?? "—"}</div></td>
                  <td><Chip tone={x.side === "long" ? "up" : "down"}>{x.side}</Chip></td>
                  <td className={`r mono ${tone(x.uPnl ?? 0)}`}>{x.uPnl === null ? "—" : money(x.uPnl)}</td>
                  <td style={{ minWidth: 140 }}><RBar x={x} /></td>
                  <td className={`r mono ${tone(x.uR ?? 0)}`}>{x.uR === null ? "—" : `${x.uR >= 0 ? "+" : ""}${num(x.uR, 2)}`}</td>
                </tr>
              ))}
            </tbody></table></div>
          )}
        </Card>
        <Card span={5} title="Prop challenges" right={<Link className="btn ghost sm" href="/arena/cfd?tab=challenge">Details</Link>}>
          {props.length === 0 ? <Empty>Add your FundedHive and The5ers accounts as evaluation accounts with their rules</Empty> : props.map((a, i) => {
            const st = Number(a.start_balance), eq = Number(a.equity), p = eq - st;
            const tgt = st * (a.firm_rules.profit_target_pct ?? 10) / 100;
            const dCap = st * (a.firm_rules.daily_loss_pct ?? 5) / 100;
            const lossToday = Math.max(0, -sum(closed(allTrades.filter((t) => t.account_id === a.id), (d) => d === today)));
            const floor = st * (1 - (a.firm_rules.max_loss_pct ?? 10) / 100);
            return (
              <div key={a.id} className="col" style={{ gap: 10, paddingTop: i ? 14 : 0, marginTop: i ? 14 : 0, borderTop: i ? "1px solid var(--line)" : 0 }}>
                <div className="between"><b style={{ fontWeight: 500 }}>{a.name}</b><span className={`mono ${tone(p)}`}>{signedMoney(p, a.currency)}</span></div>
                <div className="g12" style={{ gap: 12, fontSize: 12.5 }}>
                  <div className="s4 col" style={{ gap: 6 }}><span className="muted">Target</span><div className="bar"><i style={{ width: `${Math.max(0, Math.min(100, (p / tgt) * 100))}%` }} /></div><span className="mono">{Math.round((p / tgt) * 100)}% of {money(tgt, a.currency, 0)}</span></div>
                  <div className="s4 col" style={{ gap: 6 }}><span className="muted">Daily room</span><div className="bar warn"><i style={{ width: `${Math.max(0, ((dCap - lossToday) / dCap) * 100)}%` }} /></div><span className="mono">{money(dCap - lossToday, a.currency, 0)} left</span></div>
                  <div className="s4 col" style={{ gap: 6 }}><span className="muted">Max-loss room</span><div className="bar info"><i style={{ width: `${Math.max(0, Math.min(100, ((eq - floor) / (st - floor + Math.max(0, p))) * 100))}%` }} /></div><span className="mono">{money(eq - floor, a.currency, 0)} left</span></div>
                </div>
              </div>
            );
          })}
        </Card>
      </section>

      <section className="g12">
        <Card span={5} title="Strategy League" right={<Link className="btn ghost sm" href="/league">All</Link>}>
          {league.length === 0 ? <Empty>No strategies on record yet. They appear after their first paper trades.</Empty> : (
            <div className="tbl-w"><table className="tbl"><tbody>
              {league.map((c) => (
                <tr key={c.key}>
                  <td><b style={{ fontWeight: 500 }}>{c.strategy ?? `Model ${c.model}`}</b><div className="faint" style={{ fontSize: 12 }}>{c.instrument} · {c.stats.n ?? 0} trades</div></td>
                  <td className={`r mono ${tone(c.stats.expectancy ?? 0)}`}>{c.stats.expectancy === undefined ? "—" : `${c.stats.expectancy >= 0 ? "+" : ""}${num(c.stats.expectancy, 2)}R`}</td>
                  <td className="r"><Chip tone={c.status === "live" ? "up" : "info"}>{c.status === "live" ? "Live" : "Paper"}</Chip></td>
                </tr>
              ))}
            </tbody></table></div>
          )}
        </Card>
        <Card span={7} title="Calendar" right={<Chip>IST</Chip>}>
          {events.length === 0 ? <Empty>{cal.error ?? "Nothing important scheduled"}</Empty> : events.map((e) => (
            <div key={e.id} style={{ display: "grid", gridTemplateColumns: "4px 92px minmax(0,1fr) auto", gap: 12, alignItems: "center", padding: "8px 0", borderTop: "1px solid var(--line)" }}>
              <i style={{ height: 28, borderRadius: 2, background: `var(${e.impact === "high" ? "--down" : "--warn"})` }} />
              <span className="mono faint" style={{ fontSize: 12 }}>{new Date(e.at).toLocaleDateString("en-GB", { weekday: "short", timeZone: "Asia/Kolkata" })} {timeShort(e.at, "Asia/Kolkata")}</span>
              <b style={{ fontWeight: 500 }}>{e.currency} · {e.title}</b>
              <span className="faint" style={{ fontSize: 12 }}>{e.desks.join(" · ") || "—"}</span>
            </div>
          ))}
        </Card>
      </section>
    </>
  );
}
