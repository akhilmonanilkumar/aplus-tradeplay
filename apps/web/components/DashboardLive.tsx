"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { staffGet } from "@/lib/market";
import { useApi } from "@/lib/useApi";
import { istDay, todayIst } from "@/lib/derive";
import type { AutopilotRun, Trade, TradingAccount } from "@/lib/types";
import { money, num, pct, r as fmtR } from "@/lib/fmt";
import { Bar, Chip, Empty, ErrorNote } from "@/components/ui";

/**
 * Dashboard cards: live feed status per market, paper and real P&L, and what is in a trade right now.
 * Feeds poll every 15 s, open trades every 5 s while the tab is visible.
 */

interface Market {
  id: string; label: string; desk: string; digits: number; open: boolean; status: "live" | "closed" | "stale" | "down";
  feed: string | null; approx: boolean | null; barAgeMin: number | null; error: string | null; price: number | null; priceSource: string | null; quoteAgeSec: number | null;
}
export interface LiveRow {
  id: string; kind: "paper" | "ledger"; instrument: string; side: "long" | "short"; model: string | null; account: string | null;
  entry: number; stop: number; target: number | null; plannedR: number | null; openedAt: string; price: number | null; uR: number | null; uPnl: number | null; digits: number;
}
export interface Live { at: number; trades: LiveRow[]; tracked: LiveRow[]; pending: unknown[]; totals: { open: number; uPnl: number; uR: number; tracked: number; trackedR: number } }

const STATUS: Record<Market["status"], { tone: "up" | "warn" | "down" | ""; l: string }> = {
  live: { tone: "up", l: "live" }, closed: { tone: "", l: "closed" }, stale: { tone: "warn", l: "stale" }, down: { tone: "down", l: "down" },
};
const RUN_TONE: Record<string, "up" | "warn" | "down" | "info" | ""> = { ARMED: "up", SHIFTED: "warn", SWEPT: "warn", IN_POI: "info", ERROR: "down" };
const ago = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d`;
};
const tone = (v: number) => (v > 0 ? "up" : v < 0 ? "down" : "");

/** Open paper and tracked trades with live prices; polls while the tab is visible. */
export function useOpenTrades(everyMs = 5_000) {
  const [d, setD] = useState<Live | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      if (document.visibilityState === "visible") {
        try { const x = await staffGet<Live>("/api/paper/live"); if (!stop) { setD(x); setError(null); } } catch (e) { if (!stop) setError((e as Error).message); }
      }
      if (!stop) timer = setTimeout(load, everyMs);
    };
    load();
    return () => { stop = true; clearTimeout(timer); };
  }, [everyMs]);
  return { d, error };
}

/** One card per market: price, feed health and the autopilot's last state. */
export function FeedCards({ runs }: { runs: AutopilotRun[] }) {
  const s = useApi<{ at: number; markets: Market[] }>("/api/market/status", 15_000);
  const ms = s.data?.markets ?? [];
  const counts = { live: ms.filter((m) => m.status === "live").length, closed: ms.filter((m) => m.status === "closed").length, bad: ms.filter((m) => m.status === "stale" || m.status === "down").length };
  return (
    <section className="col" style={{ gap: 10 }}>
      <div className="between">
        <h3 style={{ margin: 0, fontSize: 14 }}>Live feeds</h3>
        <span className="row" style={{ gap: 6 }}>
          {s.data && <Chip tone={counts.bad ? "down" : "up"} dot>{counts.live} live · {counts.closed} closed{counts.bad ? ` · ${counts.bad} need attention` : ""}</Chip>}
          <span className="faint mono" style={{ fontSize: 11 }}>{s.data ? new Date(s.data.at).toLocaleTimeString("en-GB") : s.error ? "unavailable" : "loading…"} · 15s</span>
        </span>
      </div>
      <ErrorNote error={s.error} />
      <div className="auto-s" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(190px, 100%), 1fr))" }}>
        {ms.map((m) => {
          const run = runs.find((r) => r.instrument === m.id);
          const st = STATUS[m.status];
          return (
            <Link key={m.id} href="/arena/cfd" className="card" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 4, textDecoration: "none", color: "inherit" }}>
              <div className="between">
                <b style={{ fontWeight: 500, fontSize: 12.5 }}>{m.label}</b>
                <Chip tone={st.tone} dot>{st.l}</Chip>
              </div>
              <div className="kv sm">{m.price === null ? "—" : num(m.price, m.digits)}</div>
              <div className="faint" style={{ fontSize: 11, lineHeight: 1.35 }} title={m.error ?? m.priceSource ?? undefined}>
                {m.status === "down" ? (m.error ?? "no feed") : <>{m.feed}{m.approx ? " · approx" : ""}{m.barAgeMin !== null && m.open ? ` · bar ${Math.max(0, m.barAgeMin)}m ago` : ""}</>}
              </div>
              {run && <div><Chip tone={RUN_TONE[run.state] ?? ""}>{run.state}</Chip> <span className="faint mono" style={{ fontSize: 10.5 }}>{ago(run.at)}</span></div>}
            </Link>
          );
        })}
        {!s.data && !s.error && <div className="card faint" style={{ padding: 12, fontSize: 12 }}>Checking feeds…</div>}
      </div>
    </section>
  );
}

/** P&L cards: paper account, today, open, closed record and the tracked ledger. */
export function PnlCards({ trades, accounts, live }: { trades: Trade[]; accounts: TradingAccount[]; live: Live | null }) {
  const today = todayIst();
  const closed = trades.filter((t) => t.closed_at && t.pnl !== null);
  const paper = closed.filter((t) => t.source === "paper");
  const real = closed.filter((t) => t.source !== "paper");
  const sum = (xs: Trade[]) => xs.reduce((s, t) => s + Number(t.pnl ?? 0), 0);
  const todayPaper = paper.filter((t) => istDay(t.closed_at!) === today), todayReal = real.filter((t) => istDay(t.closed_at!) === today);
  const paperAccs = accounts.filter((a) => trades.some((t) => t.account_id === a.id && t.source === "paper"));
  const paperEq = paperAccs.reduce((s, a) => s + Number(a.equity), 0), paperStart = paperAccs.reduce((s, a) => s + Number(a.start_balance), 0);
  const wins = paper.filter((t) => Number(t.pnl) > 0).length;
  const netR = paper.reduce((s, t) => s + Number(t.realized_r ?? 0), 0);
  const t = live?.totals;
  const cards = [
    { l: "Paper equity", v: paperAccs.length ? money(paperEq, "USD", 0) : "—", tone: tone(paperEq - paperStart), n: paperAccs.length ? `${paperEq - paperStart >= 0 ? "+" : ""}${money(paperEq - paperStart, "USD", 0)} · ${paperStart ? pct((paperEq - paperStart) / paperStart, 2) : "—"} since start` : "no paper account" },
    { l: "Today realised", v: money(sum(todayPaper) + sum(todayReal)), tone: tone(sum(todayPaper) + sum(todayReal)), n: `paper ${money(sum(todayPaper), "USD", 0)} (${todayPaper.length}) · real ${money(sum(todayReal), "USD", 0)} (${todayReal.length})` },
    { l: "Open P&L", v: t ? money(t.uPnl) : "…", tone: tone(t?.uPnl ?? 0), n: t ? `${t.open} open · ${fmtR(t.uR)}${live && live.pending.length ? ` · ${live.pending.length} pending` : ""}` : "" },
    { l: "Paper record", v: paper.length ? `${fmtR(netR)}` : "—", tone: tone(netR), n: paper.length ? `${paper.length} closed · ${pct(wins / paper.length, 0)} win · ${money(sum(paper), "USD", 0)}` : "no closed paper trades" },
    { l: "Tracked setups", v: t ? `${t.tracked} open` : "…", tone: "", n: t && t.tracked ? `open ${fmtR(t.trackedR)} · followed on candles, no orders` : "nothing being tracked" },
  ];
  return (
    <section className="col" style={{ gap: 10 }}>
      <div className="between">
        <h3 style={{ margin: 0, fontSize: 14 }}>P&amp;L</h3>
        <Link className="btn ghost sm" href="/analytics">Analytics</Link>
      </div>
      <div className="auto-s" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(180px, 100%), 1fr))" }}>
        {cards.map((c) => (
          <div key={c.l} className="card" style={{ padding: 12 }}>
            <div className="lbl">{c.l}</div>
            <div className={`kv ${c.tone}`} style={{ marginTop: 4 }}>{c.v}</div>
            <div className="faint" style={{ fontSize: 11, marginTop: 2 }}>{c.n}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Progress from stop (0%) to target (100%) at the current price. */
const progress = (x: LiveRow) => {
  if (x.price === null || x.target === null) return null;
  const p = (x.side === "long" ? x.price - x.stop : x.stop - x.price) / Math.abs(x.target - x.stop);
  return Math.max(0, Math.min(1, p));
};

/** Open trades (paper first, then tracked setups) and the latest closed paper trades, as cards. */
export function TradeCards({ trades, live, error }: { trades: Trade[]; live: Live | null; error: string | null }) {
  const [showTracked, setShowTracked] = useState(false);
  const open = live ? [...live.trades, ...(showTracked ? live.tracked : [])] : [];
  const recent = trades.filter((t) => t.closed_at && t.source === "paper").sort((a, b) => Date.parse(b.closed_at!) - Date.parse(a.closed_at!)).slice(0, 6);
  return (
    <section className="col" style={{ gap: 10 }}>
      <div className="between">
        <h3 style={{ margin: 0, fontSize: 14 }}>Trades</h3>
        <span className="row" style={{ gap: 6 }}>
          {live && live.tracked.length > 0 && <button type="button" className="btn ghost sm" onClick={() => setShowTracked((v) => !v)}>{showTracked ? "Hide" : "Show"} {live.tracked.length} tracked</button>}
          <Link className="btn ghost sm" href="/edge">Edge Analytics</Link>
        </span>
      </div>
      <ErrorNote error={error} />
      <div className="auto-s" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(220px, 100%), 1fr))" }}>
        {open.map((x) => {
          const p = progress(x);
          return (
            <div key={x.id} className="card" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 6 }}>
              <div className="between">
                <b style={{ fontWeight: 500, fontSize: 12.5 }}>{x.instrument}</b>
                <span className="row" style={{ gap: 4 }}><Chip tone={x.side === "long" ? "up" : "down"}>{x.side}</Chip><Chip tone={x.kind === "paper" ? "acc" : ""}>{x.kind === "paper" ? "paper" : "tracked"}</Chip></span>
              </div>
              <div className="between">
                <span className={`kv sm ${tone(x.uR ?? 0)}`}>{x.uR === null ? "—" : fmtR(x.uR)}</span>
                <span className={`mono ${tone(x.uPnl ?? 0)}`} style={{ fontSize: 13 }}>{x.uPnl === null ? "" : money(x.uPnl)}</span>
              </div>
              {p !== null && <Bar pct={p * 100} tone={(x.uR ?? 0) >= 0 ? "up" : "down"} />}
              <div className="faint mono" style={{ fontSize: 10.5 }}>{num(x.entry, x.digits)} → {x.price === null ? "—" : num(x.price, x.digits)} · SL {num(x.stop, x.digits)}{x.target !== null ? ` · TP ${num(x.target, x.digits)}` : ""}</div>
              <div className="faint" style={{ fontSize: 11 }}>{x.model ?? "—"} · {ago(x.openedAt)}</div>
            </div>
          );
        })}
        {live && open.length === 0 && <div className="card" style={{ padding: 12 }}><Empty>Nothing in a trade{live.pending.length ? ` · ${live.pending.length} waiting for a fill` : ""}</Empty></div>}
        {recent.map((t) => {
          const pnl = Number(t.pnl ?? 0);
          return (
            <div key={t.id} className="card" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 6, opacity: 0.85 }}>
              <div className="between">
                <b style={{ fontWeight: 500, fontSize: 12.5 }}>{t.instrument}</b>
                <span className="row" style={{ gap: 4 }}><Chip tone={t.side === "long" ? "up" : "down"}>{t.side}</Chip><Chip>closed</Chip></span>
              </div>
              <div className="between">
                <span className={`kv sm ${tone(Number(t.realized_r ?? 0))}`}>{fmtR(Number(t.realized_r ?? 0))}</span>
                <span className={`mono ${tone(pnl)}`} style={{ fontSize: 13 }}>{money(pnl)}</span>
              </div>
              <div className="faint" style={{ fontSize: 11 }}>{ago(t.closed_at!)} ago · fees {money(Number(t.fees ?? 0), "USD", 0)}</div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** The three sections together, sharing one live-trade poll. */
export default function DashboardLive({ trades, accounts, runs }: { trades: Trade[]; accounts: TradingAccount[]; runs: AutopilotRun[] }) {
  const { d, error } = useOpenTrades();
  return (
    <>
      <FeedCards runs={runs} />
      <PnlCards trades={trades} accounts={accounts} live={d} />
      <TradeCards trades={trades} live={d} error={error} />
    </>
  );
}
