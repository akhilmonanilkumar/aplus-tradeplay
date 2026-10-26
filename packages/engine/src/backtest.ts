import type { Candle } from './smc.js';
import { analyzeSetup, type SetupAnalysis } from './setup.js';
import { evaluateGate, type Grade } from './gate.js';
import { ALL_WINDOWS, NY, isInWindow, windowOnDateOf, zonedParts } from './sessions.js';
import { INSTRUMENTS, TF_MS, costInR, type InstrumentId } from './instruments.js';
import { summarize, type RStats } from './stats.js';

/**
 * Walk-forward backtest of the edge. At every closed entry-TF bar the detector only sees
 * candles that had closed by then (no look-ahead), the A+ gate decides, and a limit order
 * at the shift zone is simulated. Stops are checked before targets inside a bar
 * (pessimistic), and costs are charged in R.
 */

export interface StrategyParams {
  sides: 'both' | 'long' | 'short';
  minRR: number;
  /** Session windows the strategy trades: london_q, ny_q, asia_q, london_close. */
  windows: string[];
  /** Also take grade A (one soft miss) at base risk. */
  allowGradeA: boolean;
  /** Drop the POI requirement (box 3) to measure what it is worth. */
  requirePoi: boolean;
  maxTradesPerDay: number;
  stopAfterLosses: number;
  /** Limit order lifetime after the shift, in entry-TF bars. */
  expiryBars: number;
  /** Entry-TF bars searched for a sweep. */
  sweepLookback: number;
  /** Move the stop to break-even once price reaches this R (null = set and forget). */
  breakevenAtR: number | null;
  /** Minimum stop distance in % (default: instrument rule). */
  minStopPct: number | null;
  /** Round-trip cost as a fraction of notional (default: instrument). */
  costRate: number | null;
  newsBlockMinutes: number;
  riskPct: number;
  startBalance: number;
}

export const DEFAULT_STRATEGY: StrategyParams = {
  sides: 'both',
  minRR: 3,
  windows: ['london_q', 'ny_q'],
  allowGradeA: false,
  requirePoi: true,
  maxTradesPerDay: 2,
  stopAfterLosses: 2,
  expiryBars: 12,
  sweepLookback: 36,
  breakevenAtR: null,
  minStopPct: null,
  costRate: null,
  newsBlockMinutes: 15,
  riskPct: 0.5,
  startBalance: 10_000,
};

export interface BacktestTrade {
  side: 'long' | 'short';
  signalAt: number;
  entryAt: number;
  exitAt: number | null;
  entry: number;
  stop: number;
  target: number;
  exit: number | null;
  plannedR: number;
  rGross: number;
  rNet: number;
  costR: number;
  outcome: 'win' | 'loss' | 'breakeven' | 'open';
  grade: Grade;
  window: string;
  sweep: string;
  targetLabel: string;
  zone: string;
  weekday: string;
  hourNy: number;
}

export interface BacktestResult {
  instrument: InstrumentId;
  params: StrategyParams;
  from: number;
  to: number;
  bars: number;
  trades: BacktestTrade[];
  stats: RStats;
  grossStats: RStats;
  /** Account equity after each closed trade (compounded at riskPct). */
  equity: { t: number; v: number }[];
  returnPct: number;
  maxDrawdownPct: number;
  signals: number;
  /** Why gated signals were not taken: first failing box, blocker or grade. */
  rejected: Record<string, number>;
  cancelled: { expired: number; ranAway: number; windowClosed: number };
}

export interface BacktestData {
  htf: readonly Candle[];
  poi: readonly Candle[];
  ltf: readonly Candle[];
  /** High-impact release times (ms). */
  news?: readonly number[];
}

const WINDOW_BY_ID = new Map(ALL_WINDOWS.map((w) => [w.id, w]));

function dayKey(t: number) {
  const p = zonedParts(t, NY);
  return `${p.year}-${p.month}-${p.day}`;
}

export function runBacktest(instrumentId: InstrumentId, data: BacktestData, params: Partial<StrategyParams> = {}): BacktestResult {
  const def = INSTRUMENTS[instrumentId];
  const p: StrategyParams = { ...DEFAULT_STRATEGY, ...params };
  const ltfMs = TF_MS[def.ltf], poiMs = TF_MS[def.poi], htfMs = TF_MS[def.htf];
  const windows = p.windows.map((id) => WINDOW_BY_ID.get(id)).filter((w): w is NonNullable<typeof w> => !!w);
  const sides: ('long' | 'short')[] = p.sides === 'both' ? ['long', 'short'] : [p.sides];
  const costRate = p.costRate ?? def.costRate;
  const minStopPct = p.minStopPct ?? def.minStopPct;
  const news = [...(p.newsBlockMinutes > 0 ? data.news ?? [] : [])].sort((a, b) => a - b);
  const blockMs = p.newsBlockMinutes * 60_000;

  const { htf, poi, ltf } = data;
  const trades: BacktestTrade[] = [];
  const used = new Set<string>();
  const cancelled = { expired: 0, ranAway: 0, windowClosed: 0 };
  let signals = 0;
  const rejected: Record<string, number> = {};
  let pending: (Omit<BacktestTrade, 'entryAt' | 'exitAt' | 'exit' | 'rGross' | 'rNet' | 'outcome'> & { createdIdx: number; windowEnd: number }) | null = null;
  let open: (BacktestTrade & { beMoved: boolean; risk: number }) | null = null;
  const perDay = new Map<string, { trades: number; losses: number }>();
  const day = (t: number) => { const k = dayKey(t); let d = perDay.get(k); if (!d) { d = { trades: 0, losses: 0 }; perDay.set(k, d); } return d; };

  let hi = 0, pi = 0;
  const warm = 300;

  const closeTrade = (exit: number, at: number, i: number) => {
    const o = open!;
    const rGross = ((o.side === 'long' ? 1 : -1) * (exit - o.entry)) / o.risk;
    const rNet = rGross - o.costR;
    const outcome: BacktestTrade['outcome'] = Math.abs(rGross) < 0.05 ? 'breakeven' : rGross > 0 ? 'win' : 'loss';
    trades.push({ ...o, exit, exitAt: at, rGross, rNet, outcome });
    if (outcome === 'loss') day(ltf[i]!.t).losses++;
    open = null;
  };

  for (let i = warm; i < ltf.length; i++) {
    const bar = ltf[i]!;
    const T = bar.t + ltfMs; // close time of this bar

    // 1 — manage the open position on this bar (stop first: pessimistic).
    if (open) {
      const o = open;
      const hitStop = o.side === 'long' ? bar.l <= o.stop : bar.h >= o.stop;
      const hitTarget = o.side === 'long' ? bar.h >= o.target : bar.l <= o.target;
      if (hitStop) closeTrade(o.stop, T, i);
      else if (hitTarget) closeTrade(o.target, T, i);
      else if (p.breakevenAtR !== null && !o.beMoved) {
        const fav = o.side === 'long' ? (bar.h - o.entry) / o.risk : (o.entry - bar.l) / o.risk;
        if (fav >= p.breakevenAtR) { o.stop = o.entry; o.beMoved = true; }
      }
      if (open) continue;
    }

    // 2 — work the pending limit order.
    if (pending) {
      const o = pending;
      const reached = o.side === 'long' ? bar.l <= o.entry : bar.h >= o.entry;
      const ranAway = o.side === 'long' ? bar.h >= o.target : bar.l <= o.target;
      if (reached) {
        const risk = Math.abs(o.entry - o.stop);
        open = { ...o, entryAt: bar.t, exitAt: null, exit: null, rGross: 0, rNet: 0, outcome: 'open', beMoved: false, risk };
        day(bar.t).trades++;
        pending = null;
        // Same-bar stop after the fill counts as a loss; a same-bar target does not count (unknown order).
        if (o.side === 'long' ? bar.l <= open.stop : bar.h >= open.stop) closeTrade(open.stop, T, i);
        continue;
      }
      if (ranAway) { cancelled.ranAway++; pending = null; }
      else if (i - o.createdIdx >= p.expiryBars) { cancelled.expired++; pending = null; }
      else if (T >= o.windowEnd) { cancelled.windowClosed++; pending = null; }
      if (pending) continue;
    }

    // 3 — look for a new setup at this bar close.
    const win = windows.find((w) => isInWindow(bar.t, w));
    if (!win) continue;
    const d = day(bar.t);
    const cap = d.trades >= p.maxTradesPerDay ? `trade cap ${p.maxTradesPerDay}` : d.losses >= p.stopAfterLosses ? `stopped after ${d.losses} losses` : null;
    if (cap) continue;

    while (hi < htf.length && htf[hi]!.t + htfMs <= T) hi++;
    while (pi < poi.length && poi[pi]!.t + poiMs <= T) pi++;
    if (hi < 30 || pi < 60) continue;
    const H = htf.slice(Math.max(0, hi - 300), hi);
    const P = poi.slice(Math.max(0, pi - 400), pi);
    const L = ltf.slice(Math.max(0, i - 299), i + 1);

    const newsClear = !news.some((n) => Math.abs(n - T) <= blockMs);
    for (const side of sides) {
      const a: SetupAnalysis = analyzeSetup(side, H, P, L, { now: T, stopBuffer: def.stopBuffer, sweepLookback: p.sweepLookback });
      // Only act on the bar that printed the shift (an order is placed at that close).
      if (!a.suggest || !a.shift?.t || a.shift.t !== bar.t || !a.sweep || !a.range) continue;
      const key = `${side}:${a.sweep.t}`;
      if (used.has(key)) continue;
      used.add(key);
      signals++;
      const g = evaluateGate({
        htfTrend: a.htfTrend, poiTfTrend: a.poiTrend, side, price: a.price, range: a.range,
        poi: p.requirePoi
          ? { inside: !!a.inside, fresh: a.inside?.fresh ?? false, trendAligned: true, liquidityStory: a.inside?.liquidityStory ?? false, createdBos: a.inside?.createdBos ?? true }
          : { inside: true, fresh: true, trendAligned: true, liquidityStory: true, createdBos: true },
        swept: true, shifted: true,
        timing: { inWindow: true, newsClear, windowId: win.id },
        plan: { ...a.suggest, targetIsStructural: true, stopIsStructural: true },
        minRR: p.minRR, minStopPct, model: 'A', instrument: instrumentId,
      });
      const take = g.verdict === 'GO' || (p.allowGradeA && g.grade === 'A');
      if (!take) {
        const fail = g.boxes.find((b) => b.status === 'fail');
        const why = g.blockers[0] ?? (fail ? `${fail.label}: ${fail.reason.replace(/[\d.,]+/g, '#')}` : g.grade === 'A' ? 'grade A (one soft miss)' : `${g.grade.toLowerCase()}: ${g.waitingFor[0] ?? ''}`);
        rejected[why] = (rejected[why] ?? 0) + 1;
        continue;
      }
      const { entry, stop, target } = a.suggest;
      const nyH = zonedParts(T, NY);
      pending = {
        side, signalAt: T, entry, stop, target,
        plannedR: Math.abs(target - entry) / Math.abs(entry - stop),
        costR: costInR({ costRate }, entry, stop),
        grade: g.grade, window: win.id, sweep: a.sweep.label, targetLabel: a.suggest.targetLabel,
        zone: a.inside?.label ?? '—', weekday: nyH.weekday, hourNy: nyH.hour,
        createdIdx: i,
        windowEnd: windowOnDateOf(bar.t, win).endUtc,
      };
      break;
    }
  }
  if (open) {
    const o = open as BacktestTrade & { risk: number };
    const last = ltf[ltf.length - 1]!;
    trades.push({ ...o, exit: null, exitAt: null, rGross: ((o.side === 'long' ? 1 : -1) * (last.c - o.entry)) / o.risk, rNet: 0, outcome: 'open' });
  }

  const closed = trades.filter((t) => t.outcome !== 'open');
  let bal = p.startBalance, peak = bal, mdd = 0;
  const equity = [{ t: ltf[warm]?.t ?? 0, v: bal }];
  for (const t of closed) {
    bal *= 1 + (p.riskPct / 100) * t.rNet;
    peak = Math.max(peak, bal);
    mdd = Math.max(mdd, (peak - bal) / peak);
    equity.push({ t: t.exitAt!, v: bal });
  }
  return {
    instrument: instrumentId,
    params: p,
    from: ltf[0]?.t ?? 0,
    to: ltf[ltf.length - 1]?.t ?? 0,
    bars: ltf.length,
    trades,
    stats: summarize(closed.map((t) => t.rNet)),
    grossStats: summarize(closed.map((t) => t.rGross)),
    equity,
    returnPct: ((bal - p.startBalance) / p.startBalance) * 100,
    maxDrawdownPct: mdd * 100,
    signals,
    rejected,
    cancelled,
  };
}

/** Group closed trades by a key and summarise each group in net R. */
export function breakdown<K extends string>(trades: readonly BacktestTrade[], key: (t: BacktestTrade) => K): { key: K; stats: RStats }[] {
  const m = new Map<K, number[]>();
  for (const t of trades) {
    if (t.outcome === 'open') continue;
    const k = key(t);
    const a = m.get(k) ?? [];
    a.push(t.rNet);
    m.set(k, a);
  }
  return [...m.entries()].map(([k, v]) => ({ key: k, stats: summarize(v) })).sort((a, b) => b.stats.n - a.stats.n);
}
