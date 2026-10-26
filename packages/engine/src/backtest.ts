import type { Candle } from './smc.js';
import { analyzeSetup, type SetupAnalysis } from './setup.js';
import { evaluateGate, type Grade } from './gate.js';
import { resolveSignal, type SignalOutcome } from './outcome.js';
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
  /** Box 2: enforce the premium/discount half of the HTF range. */
  requireCorrectHalf: boolean;
  /** Box 1: the 15M trend must agree with the HTF (false = HTF direction alone). */
  requireAlignment: boolean;
  /** Width of the no-trade band around equilibrium in % of the range (default: edge rule). */
  midBandPct: number | null;
  /** zone = limit at the 5M zone that caused the shift (Model A); shift_close = enter at the shift bar close. */
  entryMode: 'zone' | 'shift_close';
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
  requireCorrectHalf: true,
  requireAlignment: true,
  midBandPct: null,
  entryMode: 'zone',
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
  /** Every gated signal that was not taken, with what it would have done (counterfactual). */
  skipped: SkippedSignal[];
}

export interface SkippedSignal {
  t: number;
  side: 'long' | 'short';
  window: string;
  /** First failing box / blocker / grade, digits masked (the `rejected` key). */
  why: string;
  /** Every rule that failed, for grouping. */
  fails: string[];
  grade: Grade;
  entry: number;
  stop: number;
  target: number;
  plannedR: number;
  /** What the order would have done under the same fill rules (no caps, no window close). */
  outcome: SignalOutcome;
  /** Net R after costs when it would have filled and closed, else null. */
  rNet: number | null;
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

/** A shift bar inside a window where the detector produced a plan: what the gate is asked about. */
export interface ScanCandidate {
  i: number;
  side: 'long' | 'short';
  windowId: string;
  a: Pick<SetupAnalysis, 'htfTrend' | 'poiTrend' | 'price' | 'range' | 'inside' | 'sweep' | 'suggest'>;
}

/** Where the detector stood at one window bar for one side (for day replays). */
export interface ScanTrace {
  t: number;
  side: 'long' | 'short';
  stage: 'no_structure' | 'no_sweep' | 'swept' | 'shifted' | 'shift_bar' | 'no_target';
  sweep: string | null;
  zone: string | null;
  /** 0–100 position in the HTF range. */
  pos: number | null;
  htf: string | null;
  m15: string | null;
}

export interface ScanResult {
  candidates: ScanCandidate[];
  trace: ScanTrace[];
}

/**
 * Runs the detector at every closed entry-TF bar inside the windows, with only the candles closed
 * by then. Independent of the gate and money rules, so one scan can be simulated under many.
 */
export function scanSignals(
  instrumentId: InstrumentId,
  data: BacktestData,
  opts: { windows: string[]; sides: StrategyParams['sides']; sweepLookback: number; traceFrom?: number },
): ScanResult {
  const def = INSTRUMENTS[instrumentId];
  const ltfMs = TF_MS[def.ltf], poiMs = TF_MS[def.poi], htfMs = TF_MS[def.htf];
  const windows = opts.windows.map((id) => WINDOW_BY_ID.get(id)).filter((w): w is NonNullable<typeof w> => !!w);
  const sides: ('long' | 'short')[] = opts.sides === 'both' ? ['long', 'short'] : [opts.sides];
  const { htf, poi, ltf } = data;
  const candidates: ScanCandidate[] = [];
  const trace: ScanTrace[] = [];
  let hi = 0, pi = 0;
  for (let i = WARM_BARS; i < ltf.length; i++) {
    const bar = ltf[i]!;
    const T = bar.t + ltfMs;
    const win = windows.find((w) => isInWindow(bar.t, w));
    if (!win) continue;
    while (hi < htf.length && htf[hi]!.t + htfMs <= T) hi++;
    while (pi < poi.length && poi[pi]!.t + poiMs <= T) pi++;
    const tracing = opts.traceFrom !== undefined && bar.t >= opts.traceFrom;
    if (hi < 30 || pi < 60) {
      if (tracing) for (const side of sides) trace.push({ t: bar.t, side, stage: 'no_structure', sweep: null, zone: null, pos: null, htf: null, m15: null });
      continue;
    }
    const H = htf.slice(Math.max(0, hi - 300), hi);
    const P = poi.slice(Math.max(0, pi - 400), pi);
    const L = ltf.slice(Math.max(0, i - 299), i + 1);
    for (const side of sides) {
      const a: SetupAnalysis = analyzeSetup(side, H, P, L, { now: T, stopBuffer: def.stopBuffer, sweepLookback: opts.sweepLookback });
      const shiftBar = !!a.shift?.t && a.shift.t === bar.t;
      if (tracing) {
        const stage: ScanTrace['stage'] = !a.range ? 'no_structure' : !a.sweep ? 'no_sweep' : shiftBar ? (a.suggest ? 'shift_bar' : 'no_target') : a.shift?.t ? 'shifted' : 'swept';
        trace.push({ t: bar.t, side, stage, sweep: a.sweep?.label ?? null, zone: a.inside?.label ?? null, pos: a.pos, htf: a.htfTrend, m15: a.poiTrend });
      }
      // Only the bar that printed the shift places an order (at that close).
      if (!a.suggest || !shiftBar || !a.sweep || !a.range) continue;
      candidates.push({ i, side, windowId: win.id, a: { htfTrend: a.htfTrend, poiTrend: a.poiTrend, price: a.price, range: a.range, inside: a.inside, sweep: a.sweep, suggest: a.suggest } });
    }
  }
  return { candidates, trace };
}

const WARM_BARS = 300;

/** Gate + order simulation over a scan, under one set of strategy rules. */
export function simulate(instrumentId: InstrumentId, data: BacktestData, scan: ScanResult, params: Partial<StrategyParams> = {}): BacktestResult {
  const def = INSTRUMENTS[instrumentId];
  const p: StrategyParams = { ...DEFAULT_STRATEGY, ...params };
  const ltfMs = TF_MS[def.ltf];
  const allowed = new Set(p.windows);
  const sideOk = (s: 'long' | 'short') => p.sides === 'both' || p.sides === s;
  const costRate = p.costRate ?? def.costRate;
  const minStopPct = p.minStopPct ?? def.minStopPct;
  const news = [...(p.newsBlockMinutes > 0 ? data.news ?? [] : [])].sort((a, b) => a - b);
  const blockMs = p.newsBlockMinutes * 60_000;
  const { ltf } = data;

  const byBar = new Map<number, ScanCandidate[]>();
  for (const c of scan.candidates) {
    if (!allowed.has(c.windowId) || !sideOk(c.side)) continue;
    const a = byBar.get(c.i) ?? [];
    a.push(c);
    byBar.set(c.i, a);
  }

  const trades: BacktestTrade[] = [];
  const skipped: SkippedSignal[] = [];
  const used = new Set<string>();
  const cancelled = { expired: 0, ranAway: 0, windowClosed: 0 };
  let signals = 0;
  const rejected: Record<string, number> = {};
  let pending: (Omit<BacktestTrade, 'entryAt' | 'exitAt' | 'exit' | 'rGross' | 'rNet' | 'outcome'> & { createdIdx: number; windowEnd: number }) | null = null;
  let open: (BacktestTrade & { beMoved: boolean; risk: number }) | null = null;
  const perDay = new Map<string, { trades: number; losses: number }>();
  const day = (t: number) => { const k = dayKey(t); let d = perDay.get(k); if (!d) { d = { trades: 0, losses: 0 }; perDay.set(k, d); } return d; };

  const closeTrade = (exit: number, at: number, i: number) => {
    const o = open!;
    const rGross = ((o.side === 'long' ? 1 : -1) * (exit - o.entry)) / o.risk;
    const rNet = rGross - o.costR;
    const outcome: BacktestTrade['outcome'] = Math.abs(rGross) < 0.05 ? 'breakeven' : rGross > 0 ? 'win' : 'loss';
    trades.push({ ...o, exit, exitAt: at, rGross, rNet, outcome });
    if (outcome === 'loss') day(ltf[i]!.t).losses++;
    open = null;
  };

  /** What a skipped order would have done: the backtester's fill rules, no caps or window close. */
  const counterfactual = (i: number, side: 'long' | 'short', entry: number, stop: number, target: number, costR: number): { outcome: SignalOutcome; rNet: number | null } => {
    // A plan with the stop on the wrong side has no defined outcome.
    if (side === 'long' ? stop >= entry || target <= entry : stop <= entry || target >= entry) return { outcome: 'pending', rNet: null };
    const after = ltf.slice(i + 1, i + 1 + 600);
    const rr = Math.abs(target - entry) / Math.abs(entry - stop);
    if (p.entryMode === 'shift_close') {
      for (const c of after) {
        if (side === 'long' ? c.l <= stop : c.h >= stop) return { outcome: 'loss', rNet: -1 - costR };
        if (side === 'long' ? c.h >= target : c.l <= target) return { outcome: 'win', rNet: rr - costR };
      }
      return { outcome: 'filled', rNet: null };
    }
    const r = resolveSignal({ side, entry, stop, target, createdAt: ltf[i]!.t + ltfMs }, after, ltfMs, p.expiryBars);
    return { outcome: r.outcome, rNet: r.resultR !== null ? r.resultR - costR : null };
  };

  for (let i = WARM_BARS; i < ltf.length; i++) {
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

    // 3 — act on a new setup at this bar close.
    const cands = byBar.get(i);
    if (!cands) continue;
    const d = day(bar.t);
    if (d.trades >= p.maxTradesPerDay || d.losses >= p.stopAfterLosses) continue;

    const newsClear = !news.some((n) => Math.abs(n - T) <= blockMs);
    for (const { side, a, windowId } of cands) {
      const sweep = a.sweep!, range = a.range!, plan = a.suggest!;
      const key = `${side}:${sweep.t}`;
      if (used.has(key)) continue;
      used.add(key);
      signals++;
      const entry = p.entryMode === 'shift_close' ? bar.c : plan.entry;
      const { stop, target } = plan;
      const g = evaluateGate({
        htfTrend: a.htfTrend, poiTfTrend: a.poiTrend, side, price: a.price,
        range: { ...range, ...(p.midBandPct !== null ? { midBandPct: p.midBandPct } : {}) },
        poi: p.requirePoi
          ? { inside: !!a.inside, fresh: a.inside?.fresh ?? false, trendAligned: true, liquidityStory: a.inside?.liquidityStory ?? false, createdBos: a.inside?.createdBos ?? true }
          : { inside: true, fresh: true, trendAligned: true, liquidityStory: true, createdBos: true },
        swept: true, shifted: true,
        timing: { inWindow: true, newsClear, windowId },
        plan: { entry, stop, target, targetIsStructural: true, stopIsStructural: true },
        minRR: p.minRR, minStopPct, model: 'A', instrument: instrumentId,
        config: { halfRequired: p.requireCorrectHalf, poiAlignRequired: p.requireAlignment },
      });
      const take = g.verdict === 'GO' || (p.allowGradeA && g.grade === 'A');
      const costR = costInR({ costRate }, entry, stop);
      const plannedR = Math.abs(target - entry) / Math.abs(entry - stop);
      if (!take) {
        const mask = (x: string) => x.replace(/[\d.,]+/g, '#');
        const failing = g.boxes.filter((b) => b.status === 'fail' || b.status === 'pending');
        const fail = failing.find((b) => b.status === 'fail');
        const why = g.blockers[0] ?? (fail ? `${fail.label}: ${mask(fail.reason)}` : g.grade === 'A' ? 'grade A (one soft miss)' : `${g.grade.toLowerCase()}: ${g.waitingFor[0] ?? ''}`);
        rejected[why] = (rejected[why] ?? 0) + 1;
        const fails = [...g.blockers, ...failing.map((b) => b.label), ...(g.grade === 'A' ? g.softMisses.map((m) => `soft: ${m}`) : [])];
        skipped.push({ t: T, side, window: windowId, why, fails, grade: g.grade, entry, stop, target, plannedR, ...counterfactual(i, side, entry, stop, target, costR) });
        continue;
      }
      const nyH = zonedParts(T, NY);
      const base = {
        side, signalAt: T, entry, stop, target, plannedR, costR,
        grade: g.grade, window: windowId, sweep: sweep.label, targetLabel: plan.targetLabel,
        zone: a.inside?.label ?? '—', weekday: nyH.weekday, hourNy: nyH.hour,
      };
      if (p.entryMode === 'shift_close') {
        // Market entry at the shift close: in the trade from the next bar.
        open = { ...base, entryAt: T, exitAt: null, exit: null, rGross: 0, rNet: 0, outcome: 'open', beMoved: false, risk: Math.abs(entry - stop) };
        d.trades++;
      } else {
        const win = WINDOW_BY_ID.get(windowId)!;
        pending = { ...base, createdIdx: i, windowEnd: windowOnDateOf(bar.t, win).endUtc };
      }
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
  const equity = [{ t: ltf[WARM_BARS]?.t ?? 0, v: bal }];
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
    skipped,
  };
}

export function runBacktest(instrumentId: InstrumentId, data: BacktestData, params: Partial<StrategyParams> = {}): BacktestResult {
  const p: StrategyParams = { ...DEFAULT_STRATEGY, ...params };
  return simulate(instrumentId, data, scanSignals(instrumentId, data, { windows: p.windows, sides: p.sides, sweepLookback: p.sweepLookback }), p);
}

/** Skipped signals grouped by the rules that blocked them, with what taking them would have returned. */
export function skippedImpact(skipped: readonly SkippedSignal[]): { rules: string; n: number; wins: number; losses: number; noFill: number; netR: number }[] {
  const m = new Map<string, { rules: string; n: number; wins: number; losses: number; noFill: number; netR: number }>();
  for (const s of skipped) {
    const rules = s.fails.length ? s.fails.join(' + ') : s.why;
    const g = m.get(rules) ?? { rules, n: 0, wins: 0, losses: 0, noFill: 0, netR: 0 };
    g.n++;
    if (s.outcome === 'win') g.wins++;
    else if (s.outcome === 'loss') g.losses++;
    else g.noFill++;
    g.netR += s.rNet ?? 0;
    m.set(rules, g);
  }
  return [...m.values()].sort((a, b) => b.n - a.n);
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
