"use client";

import { useMemo, useState } from "react";
import { INSTRUMENTS, LIVE_INSTRUMENT_IDS, summarize, type InstrumentId } from "@aplus/engine";
import { useRows } from "@/lib/useRows";
import type { Signal } from "@/lib/types";
import { money, num, pct, r as fmtR } from "@/lib/fmt";
import { Card, Chip, Empty, ErrorNote, Kpi, Seg, Table } from "@/components/ui";

/**
 * Bot log: every signal the autopilot and the selector produced, with its outcome tracked on
 * candles (fill, stop, target) whether or not an account traded it, plus paper P&L where it did.
 */

type Range = "7" | "30" | "90" | "all";
type Src = "all" | "selector" | "autopilot";
type Take = "all" | "tradeable" | "rejected";
type Row = Signal & { paperPnl: number | null; paperTrades: number; telegram: "sent" | "failed" | null };

const OUTCOME: Record<string, { l: string; tone: "up" | "down" | "info" | "warn" | "" }> = {
  win: { l: "Target", tone: "up" }, loss: { l: "Stop", tone: "down" }, filled: { l: "In trade", tone: "info" },
  pending: { l: "Waiting fill", tone: "warn" }, expired: { l: "Expired", tone: "" }, ran_away: { l: "Ran away", tone: "" }, cancelled: { l: "Cancelled", tone: "" },
};
const WINDOW: Record<string, string> = { london_q: "London Q", ny_q: "NY Q", asia_q: "Asia Q", london_close: "London close" };
const closed = (s: Signal) => s.outcome === "win" || s.outcome === "loss";
const ist = (iso: string) => new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
/** Model letter, or the session strategy id for model S. */
const modelOf = (s: Signal) => (s.model === "S" ? `S · ${s.meta?.strategy ?? "session"}` : s.model);
const gateOf = (s: Signal) => (s.meta?.tradeable === undefined ? "—" : s.meta.tradeable ? "would trade" : s.meta.paper?.blockers?.[0] ?? (s.meta.paper?.waitingFor?.length ? "gate not complete" : `grade ${s.grade}`));
const bucket = (score: number | undefined) => (score === undefined ? "—" : score >= 80 ? "80+" : score >= 70 ? "70–79" : score >= 60 ? "60–69" : "< 60");

function group(rows: Row[], key: (s: Row) => string) {
  const m = new Map<string, Row[]>();
  for (const s of rows) m.set(key(s), [...(m.get(key(s)) ?? []), s]);
  return [...m.entries()].map(([k, list]) => {
    const done = list.filter(closed);
    const filled = list.filter((s) => s.filled_at).length;
    const st = summarize(done.map((s) => Number(s.net_r ?? 0)));
    return { k, n: list.length, filled, st };
  }).sort((a, b) => b.st.netR - a.st.netR || b.n - a.n);
}

function EquityCurve({ points }: { points: number[] }) {
  if (points.length < 2) return <Empty>The curve starts after the first two closed signals</Empty>;
  const w = 600, h = 140, lo = Math.min(0, ...points), hi = Math.max(0, ...points), span = hi - lo || 1;
  const y = (v: number) => h - 6 - ((v - lo) / span) * (h - 12);
  const d = points.map((v, i) => `${i ? "L" : "M"}${((i / (points.length - 1)) * w).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: "100%", height: 140, display: "block" }} role="img" aria-label={`Cumulative ${points.at(-1)!.toFixed(2)}R over ${points.length} closed signals`}>
      <line x1="0" x2={w} y1={y(0)} y2={y(0)} stroke="var(--line-2)" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
      <path d={d} fill="none" stroke={points.at(-1)! >= 0 ? "var(--up)" : "var(--down)"} strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Breakdown({ title, rows }: { title: string; rows: ReturnType<typeof group> }) {
  return (
    <Card span={6} title={title}>
      {rows.length === 0 ? <Empty>No signals</Empty> : (
        <Table head={["", "Signals", "Filled", "W / L", "Win rate", "Net R", "Avg R"]} right={[1, 2, 3, 4, 5, 6]}>
          {rows.map((g) => (
            <tr key={g.k}>
              <td>{g.k}</td>
              <td className="r mono">{g.n}</td>
              <td className="r mono">{g.filled}</td>
              <td className="r mono">{g.st.wins} / {g.st.losses}</td>
              <td className="r mono">{g.st.n ? pct(g.st.winRate, 0) : "—"}</td>
              <td className={`r mono ${g.st.netR > 0 ? "up" : g.st.netR < 0 ? "down" : ""}`}>{g.st.n ? fmtR(g.st.netR) : "—"}</td>
              <td className="r mono">{g.st.n ? fmtR(g.st.avgR) : "—"}</td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

export default function BotLog() {
  const [range, setRange] = useState<Range>("30");
  const [src, setSrc] = useState<Src>("all");
  const [inst, setInst] = useState<"all" | InstrumentId>("all");
  const [take, setTake] = useState<Take>("all");
  const signals = useRows<Signal>({ table: "signals", inList: ["source", ["autopilot", "selector"]], order: "created_at", limit: 2000 });
  const trades = useRows<{ signal_id: string | null; pnl: number | null; exit: number | null }>({ table: "trades", select: "signal_id,pnl,exit", notNull: "signal_id", order: "opened_at", limit: 5000 });
  const alerts = useRows<{ signal_id: string | null; status: string }>({ table: "telegram_alerts", select: "signal_id,status", notNull: "signal_id", order: "at", limit: 5000 });

  const rows: Row[] = useMemo(() => {
    const since = range === "all" ? 0 : Date.now() - Number(range) * 86_400_000;
    const pnl = new Map<string, { sum: number; n: number }>();
    for (const t of trades.rows ?? []) if (t.signal_id && t.exit !== null) { const p = pnl.get(t.signal_id) ?? { sum: 0, n: 0 }; pnl.set(t.signal_id, { sum: p.sum + Number(t.pnl ?? 0), n: p.n + 1 }); }
    const tg = new Map<string, "sent" | "failed">();
    for (const a of alerts.rows ?? []) if (a.signal_id && tg.get(a.signal_id) !== "sent") tg.set(a.signal_id, a.status === "sent" ? "sent" : "failed");
    return (signals.rows ?? [])
      .filter((s) => Date.parse(s.created_at) >= since && (src === "all" || s.source === src) && (inst === "all" || s.instrument === inst)
        && (take === "all" || (take === "tradeable" ? s.meta?.tradeable !== false : s.meta?.tradeable === false)))
      .map((s) => ({ ...s, paperPnl: pnl.get(s.id)?.sum ?? null, paperTrades: pnl.get(s.id)?.n ?? 0, telegram: tg.get(s.id) ?? null }));
  }, [signals.rows, trades.rows, alerts.rows, range, src, inst, take]);

  const done = rows.filter(closed).sort((a, b) => Date.parse(a.closed_at ?? a.created_at) - Date.parse(b.closed_at ?? b.created_at));
  const st = summarize(done.map((s) => Number(s.net_r ?? 0)));
  const curve = done.reduce<number[]>((acc, s) => [...acc, (acc.at(-1) ?? 0) + Number(s.net_r ?? 0)], []);
  const filled = rows.filter((s) => s.filled_at).length;
  const resolvedFills = rows.filter((s) => s.outcome && s.outcome !== "pending").length;
  const open = rows.filter((s) => s.outcome === "pending" || s.outcome === "filled").length;
  const paper = rows.reduce((sum, s) => sum + (s.paperPnl ?? 0), 0);
  const paperN = rows.reduce((n, s) => n + s.paperTrades, 0);
  const untracked = rows.filter((s) => !s.outcome).length;

  return (
    <>
      <ErrorNote error={signals.error || trades.error || alerts.error} />
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <Seg label="Range" value={range} onChange={setRange} options={[{ v: "7", l: "7d" }, { v: "30", l: "30d" }, { v: "90", l: "90d" }, { v: "all", l: "All" }]} />
        <Seg label="Source" value={src} onChange={setSrc} options={[{ v: "all", l: "All bots" }, { v: "selector", l: "Selector" }, { v: "autopilot", l: "Autopilot" }]} />
        <Seg label="Gate" value={take} onChange={setTake} options={[{ v: "all", l: "All logged" }, { v: "tradeable", l: "Would trade" }, { v: "rejected", l: "Rejected" }]} />
        <Seg label="Instrument" value={inst} onChange={setInst} options={[{ v: "all", l: "All" }, ...LIVE_INSTRUMENT_IDS.map((i) => ({ v: i, l: i }))]} />
        <span style={{ flex: 1 }} />
        <button className="btn ghost sm" onClick={() => { signals.reload(); trades.reload(); alerts.reload(); }}>Refresh</button>
      </div>

      <section className="g12">
        <Kpi span={3} label="Signals" value={rows.length} foot={<span className="faint">{open} open · {untracked ? `${untracked} untracked · ` : ""}{filled} filled</span>} />
        <Kpi span={3} label="Fill rate" value={resolvedFills ? pct(filled / resolvedFills, 0) : "—"} foot={<span className="faint">{rows.filter((s) => s.outcome === "ran_away").length} ran away · {rows.filter((s) => s.outcome === "expired").length} expired</span>} />
        <Kpi span={3} label="Win rate" value={st.n ? pct(st.winRate, 0) : "—"} tone={st.n ? (st.avgR >= 0 ? "up" : "down") : ""} foot={<span className="faint">{st.wins} targets · {st.losses} stops</span>} />
        <Kpi span={3} label="Net R (after costs)" value={st.n ? fmtR(st.netR) : "—"} tone={st.netR > 0 ? "up" : st.netR < 0 ? "down" : ""} foot={<span className="faint">expectancy {st.n ? fmtR(st.avgR) : "—"} / trade</span>} />
        <Kpi span={3} size="md" label="Profit factor" value={st.profitFactor !== null ? num(st.profitFactor, 2) : "—"} foot={<span className="faint">avg win {fmtR(st.avgWin)} · avg loss {fmtR(st.avgLoss)}</span>} />
        <Kpi span={3} size="md" label="Max drawdown" value={st.n ? fmtR(-st.maxDrawdownR) : "—"} foot={<span className="faint">longest losing run {st.longestLosingStreak}</span>} />
        <Kpi span={3} size="md" label="Paper P&L" value={paperN ? money(paper) : "—"} tone={paper > 0 ? "up" : paper < 0 ? "down" : ""} foot={<span className="faint">{paperN} closed paper trade{paperN === 1 ? "" : "s"}</span>} />
        <Kpi span={3} size="md" label="Telegram" value={rows.filter((s) => s.telegram === "sent").length} foot={<span className="faint">signals delivered · {rows.filter((s) => s.telegram === "failed").length} failed</span>} />
      </section>

      <Card title="Equity curve (net R, closed signals)" right={<Chip>{done.length} closed</Chip>}>
        <EquityCurve points={curve} />
      </Card>

      <section className="g12">
        <Breakdown title="By bot" rows={group(rows, (s) => (s.source === "selector" ? "Selector" : "Autopilot"))} />
        <Breakdown title="By entry model / strategy" rows={group(rows, modelOf)} />
        <Breakdown title="By gate result" rows={group(rows, gateOf)} />
        <Breakdown title="By stop anchor" rows={group(rows.filter((s) => s.meta?.stopAnchor), (s) => s.meta!.stopAnchor!.replace(/sweep of .*/, "sweep wick"))} />
        <Breakdown title="By instrument" rows={group(rows, (s) => s.instrument)} />
        <Breakdown title="By session" rows={group(rows, (s) => WINDOW[s.session_window ?? ""] ?? "Outside window")} />
        <Breakdown title="By side & grade" rows={group(rows, (s) => `${s.side} · ${s.grade}`)} />
        {rows.some((s) => s.meta?.score !== undefined) && <Breakdown title="Selector score" rows={group(rows.filter((s) => s.source === "selector"), (s) => bucket(s.meta?.score))} />}
      </section>

      <Card title="Signal log" right={<Chip>{rows.length}</Chip>}>
        {rows.length === 0 ? <Empty>No bot signals in this range yet. The autopilot logs every entry-model setup and session-strategy signal it detects; the selector logs its picks.</Empty> : (
          <Table head={["Time (IST)", "Bot", "Setup", "Grade / score", "Entry · SL · TP", "R:R", "Outcome", "Result", "Paper P&L", "Telegram"]} right={[5, 7, 8]}>
            {rows.slice(0, 300).map((s) => {
              const d = INSTRUMENTS[s.instrument as InstrumentId]?.digits ?? 2;
              const o = OUTCOME[s.outcome ?? ""] ?? { l: "Untracked", tone: "" as const };
              return (
                <tr key={s.id} title={s.meta?.why?.join(" · ") ?? s.meta?.detail}>
                  <td className="mono faint">{ist(s.created_at)}</td>
                  <td><Chip tone={s.source === "selector" ? "acc" : ""}>{s.source === "selector" ? "Selector" : `Autopilot${s.meta?.mode ? ` · ${s.meta.mode}` : ""}`}</Chip></td>
                  <td>{s.instrument} <span className={s.side === "long" ? "up" : "down"}>{s.side}</span> <Chip>{modelOf(s)}</Chip> <span className="faint">{WINDOW[s.session_window ?? ""] ?? ""}</span>{s.meta?.tradeable === false ? <span className="faint" style={{ fontSize: 11 }}> · {gateOf(s)}</span> : null}</td>
                  <td>{s.grade}{s.meta?.score !== undefined ? <span className="faint"> · {s.meta.score}/100</span> : null}</td>
                  <td className="mono faint">{num(Number(s.entry), d)} · {num(Number(s.stop), d)} · {num(Number(s.target), d)}</td>
                  <td className="r mono">{s.rr !== null ? num(Number(s.rr), 2) : "—"}</td>
                  <td><Chip tone={o.tone}>{o.l}</Chip>{s.closed_at && (s.outcome === "win" || s.outcome === "loss") ? <span className="faint mono" style={{ fontSize: 11 }}> {ist(s.closed_at)}</span> : null}</td>
                  <td className={`r mono ${Number(s.net_r) > 0 ? "up" : Number(s.net_r) < 0 ? "down" : ""}`}>{s.net_r !== null && s.net_r !== undefined ? fmtR(Number(s.net_r)) : "—"}</td>
                  <td className={`r mono ${Number(s.paperPnl) > 0 ? "up" : Number(s.paperPnl) < 0 ? "down" : ""}`}>{s.paperPnl !== null ? money(s.paperPnl) : "—"}</td>
                  <td>{s.telegram === "sent" ? <Chip tone="up">sent</Chip> : s.telegram === "failed" ? <Chip tone="down">failed</Chip> : <span className="faint">—</span>}</td>
                </tr>
              );
            })}
          </Table>
        )}
        <p className="faint" style={{ fontSize: 11.5, marginTop: 8 }}>
          Outcomes are tracked on the instrument&apos;s 5M candles with the backtester&apos;s rules: limit fills on touch, a target before the fill is &quot;ran away&quot;, no fill in 12 bars is &quot;expired&quot;, stop checked before target. Net R subtracts the instrument&apos;s round-trip cost. Market entries (model E, session strategies) fill when logged. Rejected setups are tracked too, to show what each rule costs or saves. Hover a row for the trigger or the selector&apos;s reasons.
        </p>
      </Card>
    </>
  );
}
