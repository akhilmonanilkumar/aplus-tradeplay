"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ENTRY_MODELS, normalizeModel } from "@aplus/engine";
import { useRows } from "@/lib/useRows";
import type { AlertLog, NewsEvent, Signal, Trade, TradingAccount } from "@/lib/types";
import { equitySeries, istDay, riskAmount, todayIst, type Group } from "@/lib/derive";
import { money, num, pct, signed, timeShort } from "@/lib/fmt";
import { Card, Chip, Empty, ErrorNote, Kpi, Seg, StateRail } from "@/components/ui";
import SessionsCard from "@/components/SessionsCard";

const INSTRUMENTS = [
  { id: "XAUUSD", tf: "1H · 15M · 5M" },
  { id: "BTCUSDT.P", tf: "4H · 15M · 5M · mark price" },
] as const;
const POLICY_TONE: Record<string, "up" | "acc" | "info" | "down" | ""> = { AUTO: "up", CONFIRM: "acc", MANUAL: "info", PAPER: "", BLOCKED: "down" };

function CopilotCard({ inst, tf, signal }: { inst: string; tf: string; signal: Signal | undefined }) {
  const go = signal && signal.grade === "A+" && signal.state === "ARMED";
  const pending = signal?.gate?.filter((b) => b.status === "pending") ?? [];
  const passed = signal?.gate?.filter((b) => b.status === "pass" || b.status === "warn").length ?? 0;
  return (
    <div className="card s6 col" style={{ gap: 12 }}>
      <div className="between">
        <div className="row"><b style={{ fontSize: 15 }}>{inst}</b><span className="faint" style={{ fontSize: 12 }}>{tf}</span></div>
        <div className="row">
          {signal ? <Chip tone={go ? "up" : "warn"} dot>{signal.state}</Chip> : <Chip dot>IDLE</Chip>}
          {signal && <Chip tone={go ? "solid" : ""}>{signal.grade.replace("_", " ")}{go ? " · GO" : " · WAIT"}</Chip>}
        </div>
      </div>
      <StateRail state={signal?.state ?? "IDLE"} />
      {signal ? (
        <>
          {pending.length > 0 ? (
            <div className="col" style={{ gap: 6 }}>
              <span className="lbl-u">Waiting for</span>
              <div className="row" style={{ gap: 6 }}>{pending.map((b) => <Chip key={b.n} tone="warn">{b.reason}</Chip>)}</div>
            </div>
          ) : (
            <div className="px">
              <div><span className="lbl">Entry (limit)</span><b className="mono">{num(Number(signal.entry), 2)}</b></div>
              <div><span className="lbl">Stop</span><b className="mono down">{num(Number(signal.stop), 2)}</b></div>
              <div><span className="lbl">Target</span><b className="mono up">{num(Number(signal.target), 2)}</b></div>
              <div><span className="lbl">R:R</span><b className="mono acc">{signal.rr !== null ? num(Number(signal.rr), 2) : "—"}</b></div>
            </div>
          )}
          <div className="between">
            <span className="muted" style={{ fontSize: 12.5 }}>Model {normalizeModel(signal.model)} · {ENTRY_MODELS[normalizeModel(signal.model)].name} · {passed}/7 gate{signal.session_window ? ` · ${signal.session_window === "ny_q" ? "NY Q" : "London Q"}` : ""}</span>
            <Link className={`btn sm${go ? " pri" : ""}`} href={go ? `/copy?s=${signal.id}` : "/copilot"}>{go ? "Open ticket" : "View setup"}</Link>
          </div>
        </>
      ) : (
        <div className="between">
          <span className="muted" style={{ fontSize: 12.5 }}>No plan today</span>
          <Link className="btn sm" href="/bias">Write bias</Link>
        </div>
      )}
    </div>
  );
}

function EquityChart({ accounts, trades }: { accounts: TradingAccount[]; trades: Trade[] }) {
  const [g, setG] = useState<Group>("combined");
  const s = useMemo(() => equitySeries(accounts, trades, g), [accounts, trades, g]);
  const W = 800, H = 220;
  const min = Math.min(...s.vals), max = Math.max(...s.vals);
  const span = max - min || Math.max(1, max * 0.01);
  const y = (v: number) => H - 10 - ((v - min) / span) * (H - 20);
  const x = (i: number) => (i / (s.vals.length - 1)) * W;
  const line = s.vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const maxDdv = Math.max(0.0001, ...s.dd);
  const dd = s.dd.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${(H - 4 - (v / maxDdv) * 40).toFixed(1)}`).join(" ");
  return (
    <Card span={8} title="Equity · last 30 days" right={<Seg label="Equity view" value={g} onChange={setG} options={[{ v: "combined", l: "Combined" }, { v: "master", l: "Master" }, { v: "copy", l: "Copy group" }, { v: "investors", l: "Investors" }]} />}>
      {s.end === 0 ? <Empty>No accounts in this group</Empty> : (
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
            <span className="mono faint" style={{ fontSize: 12 }}>30d {s.ret >= 0 ? "+" : ""}{pct(s.ret, 2)} · max DD {pct(s.maxDd, 2)}</span>
          </div>
        </>
      )}
    </Card>
  );
}

export default function Command() {
  const accounts = useRows<TradingAccount>({ table: "trading_accounts", order: "created_at", ascending: true });
  const trades = useRows<Trade>({ table: "trades", order: "opened_at", limit: 3000 });
  const signals = useRows<Signal>({ table: "signals", order: "created_at", limit: 40 });
  const news = useRows<NewsEvent>({ table: "news_events", order: "at", ascending: true, limit: 50 });
  const alerts = useRows<AlertLog>({ table: "alert_log", order: "at", limit: 8 });

  const acc = (accounts.rows ?? []).filter((a) => a.active);
  const usd = acc.filter((a) => a.currency !== "INR");
  const equity = usd.reduce((s, a) => s + Number(a.equity), 0);
  const invEq = usd.filter((a) => a.type === "investor").reduce((s, a) => s + Number(a.equity), 0);
  const tr = trades.rows ?? [];
  const today = todayIst();
  const usdIds = new Set(usd.map((a) => a.id));
  const closedToday = tr.filter((t) => t.closed_at && istDay(t.closed_at) === today && usdIds.has(t.account_id));
  const pnlToday = closedToday.reduce((s, t) => s + Number(t.pnl ?? 0), 0);
  const open = tr.filter((t) => t.exit === null && usdIds.has(t.account_id));
  const openRisk = open.reduce((s, t) => s + riskAmount(t), 0);
  const openR = open.reduce((s, t) => s + 1, 0);
  const master = new Set(acc.filter((a) => a.type === "master").map((a) => a.id));
  const masterToday = tr.filter((t) => master.has(t.account_id) && istDay(t.opened_at) === today);
  const aPlus = (i: string) => masterToday.filter((t) => t.instrument === i).length;
  const losses = masterToday.filter((t) => Number(t.realized_r) < 0).length;

  const sigToday = (signals.rows ?? []).filter((s) => istDay(s.created_at) === today);
  const upcoming = (news.rows ?? []).filter((n) => +new Date(n.at) > Date.now() - 15 * 60_000 && n.impact === "high").slice(0, 4);

  const feed = [
    ...(signals.rows ?? []).slice(0, 6).map((s) => ({ at: s.created_at, title: `${s.instrument} → ${s.state}.`, body: `Model ${normalizeModel(s.model)} · ${s.side} · entry ${num(Number(s.entry), 2)} · stop ${num(Number(s.stop), 2)} · target ${num(Number(s.target), 2)}${s.rr ? ` (${num(Number(s.rr), 2)}R)` : ""} · ${s.grade.replace("_", " ")}` })),
    ...(alerts.rows ?? []).map((a) => ({ at: a.at, title: a.title, body: a.body ?? "" })),
  ].sort((a, b) => +new Date(b.at) - +new Date(a.at)).slice(0, 6);

  return (
    <>
      <ErrorNote error={accounts.error || trades.error || signals.error} />
      <section className="g12">
        <Kpi label={`Combined equity · ${acc.length} live accounts`} value={money(equity)} foot={<span className="faint mono">own {money(equity - invEq)} · investors {money(invEq)}</span>} />
        <Kpi label="Today P&L" value={`${pnlToday > 0 ? "+" : ""}${money(pnlToday)}`} tone={signed(pnlToday)} foot={<><span className={`chip ${pnlToday >= 0 ? "up" : "down"}`}>{equity ? `${pnlToday >= 0 ? "+" : ""}${pct(pnlToday / (equity - pnlToday || 1), 2)}` : "—"}</span><span className="faint">{closedToday.length} closed</span></>} />
        <Kpi label="Open risk" value={`${num(openR, 1)} R`} foot={<span className="faint mono">{money(openRisk)} at stop · {equity ? pct(openRisk / equity, 2) : "—"} of equity</span>} />
        <div className="card s3">
          <div className="lbl">Edge discipline today</div>
          <div className="col" style={{ marginTop: 8, gap: 7 }}>
            <div className="between"><span className="muted" style={{ fontSize: 12.5 }}>XAUUSD A+ trades</span><span className="mono" style={{ fontWeight: 600 }}>{aPlus("XAUUSD")} / 2</span></div>
            <div className="between"><span className="muted" style={{ fontSize: 12.5 }}>BTCUSDT.P A+ trades</span><span className="mono" style={{ fontWeight: 600 }}>{aPlus("BTCUSDT.P")} / 2</span></div>
            <div className="between"><span className="muted" style={{ fontSize: 12.5 }}>Losses (stop at 2)</span><span className={`mono ${losses >= 2 ? "down" : "up"}`} style={{ fontWeight: 600 }}>{losses} / 2</span></div>
          </div>
        </div>
      </section>

      <section className="g12">
        {INSTRUMENTS.map((i) => <CopilotCard key={i.id} inst={i.id} tf={i.tf} signal={sigToday.find((s) => s.instrument === i.id)} />)}
      </section>

      <section className="g12">
        <SessionsCard />
        <Card span={4} title="Agent feed" right={<><Chip tone="acc" dot>engine</Chip><Link className="btn ghost sm" href="/copilot">Open</Link></>}>
          {feed.length === 0 ? <Empty>Nothing yet today</Empty> : (
            <div className="feed">
              {feed.map((f, i) => (
                <div key={i} className="fi">
                  <span className="t">{timeShort(+new Date(f.at), "Asia/Kolkata")}</span>
                  <div><b style={{ fontSize: 12.5 }}>{f.title}</b> <span className="muted" style={{ fontSize: 12.5 }}>{f.body}</span></div>
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card span={4} title="News & no-trade zones" right={<Link className="btn ghost sm" href="/news">Calendar</Link>}>
          {upcoming.length === 0 ? <Empty>No high-impact releases scheduled</Empty> : (
            <div className="col" style={{ gap: 10 }}>
              {upcoming.map((n) => {
                const t = +new Date(n.at);
                return (
                  <div key={n.id} className="between">
                    <div className="col" style={{ gap: 2 }}>
                      <b style={{ fontSize: 12.5 }}>{n.title}</b>
                      <span className="mono faint" style={{ fontSize: 11.5 }}>{new Date(t).toLocaleDateString("en-GB", { weekday: "short", timeZone: "America/New_York" })} · {timeShort(t, "America/New_York")} ET · no-trade {timeShort(t - 15 * 60_000, "America/New_York")}–{timeShort(t + 15 * 60_000, "America/New_York")} ET</span>
                    </div>
                    <Chip tone="down">High</Chip>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </section>

      <section className="g12">
        <EquityChart accounts={accounts.rows ?? []} trades={tr} />
        <Card span={4} title="Accounts" right={<Link className="btn ghost sm" href="/accounts">Manage</Link>}>
          {acc.length === 0 ? <Empty><Link className="btn sm" href="/accounts">Add account</Link></Empty> : (
            <div className="col" style={{ gap: 0 }}>
              {acc.slice(0, 8).map((a) => {
                const p = Number(a.equity) - Number(a.start_balance);
                return (
                  <div key={a.id} className="between" style={{ padding: "8px 0", borderBottom: "1px solid var(--line)" }}>
                    <div className="col" style={{ gap: 1, minWidth: 0 }}>
                      <span style={{ fontSize: 12.5, fontWeight: 500 }}>{a.name}</span>
                      <span className="faint" style={{ fontSize: 11 }}>{a.venue} · {a.type}</span>
                    </div>
                    <div className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                      <span className={`mono ${signed(p)}`} style={{ fontSize: 12 }}>{p > 0 ? "+" : ""}{money(p, a.currency)}</span>
                      <Chip tone={POLICY_TONE[a.copy_policy]}>{a.copy_policy}</Chip>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </section>
    </>
  );
}
