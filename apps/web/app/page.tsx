"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { DESKS, INSTRUMENTS, type DeskId, type InstrumentId } from "@aplus/engine";
import LivePnl from "@/components/LivePnl";
import { useRows } from "@/lib/useRows";
import { useApi } from "@/lib/useApi";
import { drawdown, matchesOwner, ownerOf, ownerOptions } from "@/lib/accounts";
import { equitySeries, istDay, riskAmount, todayIst } from "@/lib/derive";
import type { CalEvent } from "@/lib/server/news";
import type { AutopilotConfig, AutopilotRun, CashFlow, Investor, TelegramAlert, Trade, TradingAccount } from "@/lib/types";
import { money, num, pct, signed, timeShort } from "@/lib/fmt";
import { Card, Chip, Empty, ErrorNote, Kpi, Table } from "@/components/ui";
import SessionsCard from "@/components/SessionsCard";

type Quote = { last: number; source: string; approx: boolean };
const STATE_TONE: Record<string, "up" | "warn" | "down" | ""> = { ARMED: "up", SHIFTED: "warn", SWEPT: "warn", IN_POI: "", ERROR: "down" };

function QuoteCell({ id }: { id: InstrumentId }) {
  const q = useApi<Quote>(`/api/market/quote?i=${encodeURIComponent(id)}`, 15_000);
  return <span className="mono" style={{ fontWeight: 600 }}>{q.data ? num(q.data.last, INSTRUMENTS[id].digits) : q.error ? "—" : "…"}</span>;
}

function DeskCard({ desk, runs, configs, trades }: { desk: DeskId; runs: AutopilotRun[]; configs: AutopilotConfig[]; trades: Trade[] }) {
  const d = DESKS[desk];
  const today = todayIst();
  return (
    <Card span={6} title={d.name} right={<><Link className="btn sm" href={`/lab/${desk}`}>Lab</Link><Link className="btn pri sm" href={`/desk/${desk}`}>Open desk</Link></>}>
      <Table head={["Instrument", "Price", "State", "Autopilot", "Today"]} right={[1, 4]}>
        {d.instruments.map((id) => {
          const r = runs.find((x) => x.instrument === id);
          const c = configs.find((x) => x.instrument === id);
          const t = trades.filter((x) => x.instrument === id && istDay(x.opened_at) === today);
          const p = t.reduce((s, x) => s + Number(x.pnl ?? 0), 0);
          return (
            <tr key={id}>
              <td><Link href={`/desk/${desk}?i=${encodeURIComponent(id)}`}><b style={{ fontWeight: 500 }}>{INSTRUMENTS[id].label}</b></Link></td>
              <td className="r"><QuoteCell id={id} /></td>
              <td>{r ? <Chip tone={STATE_TONE[r.state] ?? ""}>{r.state}{r.grade ? ` · ${r.grade.replace("_", " ")}` : ""}</Chip> : <Chip>—</Chip>} {r && <span className="faint mono" style={{ fontSize: 10.5 }}>{timeShort(+new Date(r.at), "Asia/Kolkata")}</span>}</td>
              <td><Chip tone={c?.mode === "off" || !c ? "" : c.mode === "paper" ? "info" : "acc"}>{c?.mode ?? "off"}</Chip></td>
              <td className={`r mono ${signed(p)}`}>{t.length ? `${t.length} · ${money(p, "USD", 0)}` : "—"}</td>
            </tr>
          );
        })}
      </Table>
    </Card>
  );
}

function EquityCard({ accounts, trades, investors }: { accounts: TradingAccount[]; trades: Trade[]; investors: Investor[] }) {
  const [owner, setOwner] = useState("all");
  const [days, setDays] = useState(30);
  const s = useMemo(() => equitySeries(accounts, trades, (a) => matchesOwner(a, owner), days), [accounts, trades, owner, days]);
  const W = 800, H = 220;
  const min = Math.min(...s.vals), max = Math.max(...s.vals);
  const span = max - min || Math.max(1, max * 0.01);
  const y = (v: number) => H - 10 - ((v - min) / span) * (H - 20);
  const x = (i: number) => (i / (s.vals.length - 1)) * W;
  const line = s.vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const maxDdv = Math.max(0.0001, ...s.dd);
  const dd = s.dd.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${(H - 4 - (v / maxDdv) * 40).toFixed(1)}`).join(" ");
  return (
    <Card span={8} title="Equity" right={<>
      <div className="inp" style={{ width: 170, height: 30 }}><select aria-label="Owner" value={owner} onChange={(e) => setOwner(e.target.value)}>{ownerOptions(investors).map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}</select></div>
      <div className="seg">{[30, 90].map((d) => <button key={d} type="button" className={days === d ? "on" : ""} onClick={() => setDays(d)}>{d}D</button>)}</div>
    </>}>
      {s.end === 0 ? <Empty>No accounts for this owner</Empty> : (
        <>
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: 220, display: "block" }} role="img" aria-label="Equity curve">
            <path d={`${line} L${W},${H} L0,${H} Z`} fill="var(--accent-bg)" />
            <path d={line} fill="none" stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
            <path d={dd} fill="none" stroke="var(--down)" strokeWidth="1.2" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
          </svg>
          <div className="row" style={{ gap: 16, marginTop: 10 }}>
            <span className="row" style={{ fontSize: 12 }}><span className="dot acc" />Equity</span>
            <span className="row" style={{ fontSize: 12 }}><span className="dot down" />Drawdown from peak</span>
            <span style={{ flex: 1 }} />
            <span className="mono faint" style={{ fontSize: 12 }}>{money(s.start, "USD", 0)} → {money(s.end, "USD", 0)} · {s.ret >= 0 ? "+" : ""}{pct(s.ret, 2)} · max DD {pct(s.maxDd, 2)}</span>
          </div>
        </>
      )}
    </Card>
  );
}

export default function Dashboard() {
  const accounts = useRows<TradingAccount>({ table: "trading_accounts", order: "created_at", ascending: true });
  const investors = useRows<Investor>({ table: "investors", select: "id,name,stage,fee_rate", order: "name", ascending: true });
  const trades = useRows<Trade>({ table: "trades", order: "opened_at", limit: 5000 });
  const flows = useRows<CashFlow>({ table: "cash_flows", order: "at", limit: 5000 });
  const runs = useRows<AutopilotRun>({ table: "autopilot_runs", order: "at", limit: 50 });
  const configs = useRows<AutopilotConfig>({ table: "autopilot_config", order: "instrument", ascending: true });
  const alerts = useRows<TelegramAlert>({ table: "telegram_alerts", order: "at", limit: 6 });
  const cal = useApi<{ items: CalEvent[] }>("/api/calendar", 1_800_000);

  const invs = investors.rows ?? [];
  const acc = (accounts.rows ?? []).filter((a) => a.active && a.currency !== "INR");
  const ids = new Set(acc.map((a) => a.id));
  const tr = (trades.rows ?? []).filter((t) => ids.has(t.account_id));
  const real = tr.filter((t) => t.source !== "paper");
  const aum = acc.reduce((s, a) => s + Number(a.equity), 0);
  const own = acc.filter((a) => !a.investor_id).reduce((s, a) => s + Number(a.equity), 0);
  const today = todayIst();
  const month = today.slice(0, 7);
  const closedIn = (f: (d: string) => boolean) => real.filter((t) => t.closed_at && t.pnl !== null && f(istDay(t.closed_at)));
  const pnlToday = closedIn((d) => d === today).reduce((s, t) => s + Number(t.pnl), 0);
  const mtd = closedIn((d) => d.startsWith(month));
  const pnlMtd = mtd.reduce((s, t) => s + Number(t.pnl), 0);
  const last30 = closedIn((d) => d >= istDay(Date.now() - 30 * 86_400_000));
  const wr30 = last30.length ? last30.filter((t) => Number(t.pnl) > 0).length / last30.length : 0;
  const open = tr.filter((t) => t.exit === null);
  const openRisk = open.reduce((s, t) => s + riskAmount(t), 0);
  const upcoming = (cal.data?.items ?? []).filter((e) => e.impact === "high" && e.desks.length && e.at > Date.now() - 15 * 60_000).slice(0, 5);

  // per owner (own + each investor): capital, net deposits, growth
  const owners = [{ id: "own", name: "Own (firm)" }, ...invs.map((i) => ({ id: i.id, name: i.name }))].map((o) => {
    const a = acc.filter((x) => matchesOwner(x, o.id));
    const aIds = new Set(a.map((x) => x.id));
    const eq = a.reduce((s, x) => s + Number(x.equity), 0);
    // Capital = net deposits where the account has a cash-flow ledger, else its opening balance.
    const capital = a.reduce((s, x) => {
      const fl = (flows.rows ?? []).filter((f) => f.account_id === x.id);
      if (!fl.length) return s + Number(x.start_balance);
      return s + fl.reduce((t, f) => t + (f.kind === "deposit" ? 1 : f.kind === "withdrawal" || f.kind === "payout" ? -1 : 0) * Number(f.amount), 0);
    }, 0);
    const m = real.filter((t) => aIds.has(t.account_id) && t.closed_at && istDay(t.closed_at).startsWith(month)).reduce((s, t) => s + Number(t.pnl ?? 0), 0);
    return { ...o, n: a.length, eq, capital, growth: capital > 0 ? (eq - capital) / capital : 0, mtd: m };
  }).filter((o) => o.n > 0);

  return (
    <>
      <ErrorNote error={accounts.error || trades.error} />
      <section className="g12"><LivePnl /></section>
      <section className="g12">
        <Kpi label={`Assets under management · ${acc.length} accounts`} value={money(aum, "USD", 0)} foot={<span className="faint mono">own {money(own, "USD", 0)} · investors {money(aum - own, "USD", 0)}</span>} />
        <Kpi label="Today P&L" value={`${pnlToday > 0 ? "+" : ""}${money(pnlToday)}`} tone={signed(pnlToday)} foot={<span className="faint">{closedIn((d) => d === today).length} closed today</span>} />
        <Kpi label="Month to date" value={`${pnlMtd > 0 ? "+" : ""}${money(pnlMtd, "USD", 0)}`} tone={signed(pnlMtd)} foot={<span className="faint">{mtd.length} trades · {aum ? `${pnlMtd >= 0 ? "+" : ""}${pct(pnlMtd / Math.max(1, aum - pnlMtd), 2)}` : "—"}</span>} />
        <Kpi label="Open risk · 30d win rate" value={money(openRisk, "USD", 0)} foot={<span className="faint mono">{open.length} open · {aum ? pct(openRisk / aum, 2) : "—"} of AUM · win {pct(wr30, 0)} ({last30.length})</span>} />
      </section>

      <section className="g12">
        <DeskCard desk="gold" runs={runs.rows ?? []} configs={configs.rows ?? []} trades={tr} />
        <DeskCard desk="btc" runs={runs.rows ?? []} configs={configs.rows ?? []} trades={tr} />
      </section>

      <section className="g12">
        <EquityCard accounts={acc} trades={real} investors={invs} />
        <Card span={4} title="Capital by owner" right={<Link className="btn ghost sm" href="/investors">Investors</Link>}>
          {owners.length === 0 ? <Empty><Link className="btn sm" href="/accounts">Add an account</Link></Empty> : owners.map((o) => (
            <div key={o.id} style={{ padding: "8px 0", borderBottom: "1px solid var(--line)" }}>
              <div className="between"><b style={{ fontSize: 12.5, fontWeight: 500 }}>{o.name} <span className="faint" style={{ fontWeight: 400 }}>· {o.n}</span></b><span className="mono" style={{ fontSize: 12.5 }}>{money(o.eq, "USD", 0)}</span></div>
              <div className="between faint mono" style={{ fontSize: 11 }}><span>capital {money(o.capital, "USD", 0)}</span><span className={signed(o.growth)}>{o.growth >= 0 ? "+" : ""}{pct(o.growth, 2)} · MTD {money(o.mtd, "USD", 0)}</span></div>
            </div>
          ))}
        </Card>
      </section>

      <section className="g12">
        <Card span={8} title="Accounts" right={<><Link className="btn ghost sm" href="/analytics">P&L analytics</Link><Link className="btn sm" href="/accounts">Manage</Link></>}>
          {acc.length === 0 ? <Empty><Link className="btn sm" href="/accounts">Add an account</Link></Empty> : (
            <Table head={["Account", "Owner", "Equity", "Today", "MTD", "From peak", "Risk"]} right={[2, 3, 4, 5, 6]}>
              {acc.map((a) => {
                const t = real.filter((x) => x.account_id === a.id && x.closed_at);
                const d1 = t.filter((x) => istDay(x.closed_at!) === today).reduce((s, x) => s + Number(x.pnl ?? 0), 0);
                const m = t.filter((x) => istDay(x.closed_at!).startsWith(month)).reduce((s, x) => s + Number(x.pnl ?? 0), 0);
                const o = ownerOf(a, invs);
                return (
                  <tr key={a.id}>
                    <td><b style={{ fontWeight: 500 }}>{a.name}</b> <span className="faint" style={{ fontSize: 11 }}>{a.venue} · {a.type}</span></td>
                    <td><Chip tone={o.own ? "acc" : "info"}>{o.label}</Chip></td>
                    <td className="r mono">{money(Number(a.equity), a.currency)}</td>
                    <td className={`r mono ${signed(d1)}`}>{d1 ? money(d1) : "—"}</td>
                    <td className={`r mono ${signed(m)}`}>{m ? money(m) : "—"}</td>
                    <td className={`r mono ${drawdown(a) > 0.03 ? "down" : "faint"}`}>{pct(-drawdown(a), 1)}</td>
                    <td className="r mono">{num(Number(a.risk_pct), 2)}%</td>
                  </tr>
                );
              })}
            </Table>
          )}
        </Card>
        <div className="s4 col" style={{ gap: 16 }}>
          <Card title="High-impact events" right={<Chip>IST</Chip>}>
            {upcoming.length === 0 ? <Empty>{cal.error ?? "Nothing high-impact scheduled"}</Empty> : upcoming.map((e) => (
              <div key={e.id} className="between" style={{ padding: "6px 0", borderBottom: "1px solid var(--line)", fontSize: 12.5 }}>
                <span className="col" style={{ gap: 0 }}><b style={{ fontWeight: 500 }}>{e.currency} · {e.title}</b><span className="faint mono" style={{ fontSize: 11 }}>{new Date(e.at).toLocaleDateString("en-GB", { weekday: "short", timeZone: "Asia/Kolkata" })} {timeShort(e.at, "Asia/Kolkata")} · no-trade ±15 min</span></span>
                <Chip tone="down">High</Chip>
              </div>
            ))}
          </Card>
          <Card title="Telegram alerts" right={<Link className="btn ghost sm" href="/alerts">All</Link>}>
            {(alerts.rows ?? []).length === 0 ? <Empty>No alerts sent yet</Empty> : (alerts.rows ?? []).map((a) => (
              <div key={a.id} className="fi">
                <span className="t">{timeShort(+new Date(a.at), "Asia/Kolkata")}</span>
                <div style={{ fontSize: 12, minWidth: 0 }}><b>{a.instrument ?? a.kind}</b> <span className="muted">{a.text.replace(/<[^>]+>/g, "").split("\n")[0]}</span>{a.status === "failed" && <Chip tone="down">failed</Chip>}</div>
              </div>
            ))}
          </Card>
        </div>
      </section>

      <section className="g12">
        <SessionsCard span={12} />
      </section>
    </>
  );
}
