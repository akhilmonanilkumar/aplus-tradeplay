import type { BacktestTrade } from './backtest.js';
import { summarize } from './stats.js';

/**
 * Why a strategy loses: where the R goes, read from closed trades. Losers are split by how far
 * they went in favour first (a trade that reached +1R and then stopped out is a management or
 * target problem; one that never went 0.3R in favour is an entry problem), win rate is compared
 * with the break-even rate the planned R:R needs, and simple fixed-target exits are replayed
 * from each trade's excursion to show what nearer targets would have returned.
 */

export interface LossDiagnostics {
  n: number;
  winRate: number;
  /** Win rate the average planned R:R needs to break even after costs. */
  breakEvenWinRate: number;
  avgPlannedR: number;
  avgCostR: number;
  netR: number;
  losers: {
    n: number;
    /** Losers that first reached at least this far in favour. */
    reached1R: number;
    reached05R: number;
    /** Never went 0.3R in favour: wrong from the start. */
    neverWorked: number;
    /** Stopped out within two bars of the fill. */
    stoppedFast: number;
    medianBarsToStop: number | null;
  };
  /** Net R had every trade targeted a fixed multiple instead (from each trade's best excursion). */
  fixedTargets: { r: number; netR: number; winRate: number }[];
  /** Win rate and net R by planned R:R bucket. */
  byPlannedR: { bucket: string; n: number; winRate: number; netR: number }[];
  by: Record<'side' | 'window' | 'trend' | 'model' | 'stopAnchor' | 'targetLabel' | 'hourNy' | 'zone', { key: string; n: number; winRate: number; netR: number; avgR: number }[]>;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

export function lossDiagnostics(trades: readonly BacktestTrade[]): LossDiagnostics {
  const closed = trades.filter((t) => t.outcome !== 'open');
  const wins = closed.filter((t) => t.rGross > 0.05);
  const losers = closed.filter((t) => t.rGross < -0.05);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const avgPlannedR = avg(closed.map((t) => t.plannedR));
  const avgCostR = avg(closed.map((t) => t.costR));
  const bars = losers.map((t) => t.barsHeld).sort((a, b) => a - b);

  const group = (key: (t: BacktestTrade) => string) => {
    const m = new Map<string, BacktestTrade[]>();
    for (const t of closed) { const k = key(t); m.set(k, [...(m.get(k) ?? []), t]); }
    return [...m.entries()].map(([k, v]) => {
      const s = summarize(v.map((t) => t.rNet));
      return { key: k, n: v.length, winRate: r2(s.winRate * 100), netR: r2(s.netR), avgR: r2(s.avgR) };
    }).sort((a, b) => b.n - a.n);
  };

  const buckets: [string, number, number][] = [['< 2.5R', 0, 2.5], ['2.5–4R', 2.5, 4], ['4–6R', 4, 6], ['≥ 6R', 6, Infinity]];
  const byPlannedR = buckets.map(([bucket, lo, hi]) => {
    const v = closed.filter((t) => t.plannedR >= lo && t.plannedR < hi);
    const s = summarize(v.map((t) => t.rNet));
    return { bucket, n: v.length, winRate: r2(s.winRate * 100), netR: r2(s.netR) };
  }).filter((b) => b.n > 0);

  // Fixed target X: a winner at planned R ≥ X, or any trade whose best excursion reached X, banks X.
  const fixedTargets = [1, 1.5, 2, 3].map((x) => {
    let net = 0, w = 0;
    for (const t of closed) {
      const hit = t.mfeR >= x || (t.rGross > 0.05 && t.plannedR >= x);
      if (hit) { net += x - t.costR; w++; } else net += t.rGross - t.costR;
    }
    return { r: x, netR: r2(net), winRate: closed.length ? r2((w / closed.length) * 100) : 0 };
  });

  return {
    n: closed.length,
    winRate: closed.length ? r2((wins.length / closed.length) * 100) : 0,
    breakEvenWinRate: r2(((1 + avgCostR) / (1 + avgPlannedR)) * 100),
    avgPlannedR: r2(avgPlannedR),
    avgCostR: r2(avgCostR),
    netR: r2(closed.reduce((a, t) => a + t.rNet, 0)),
    losers: {
      n: losers.length,
      reached1R: losers.filter((t) => t.mfeR >= 1).length,
      reached05R: losers.filter((t) => t.mfeR >= 0.5).length,
      neverWorked: losers.filter((t) => t.mfeR < 0.3).length,
      stoppedFast: losers.filter((t) => t.barsHeld <= 2).length,
      medianBarsToStop: bars.length ? bars[Math.floor(bars.length / 2)]! : null,
    },
    fixedTargets,
    byPlannedR,
    by: {
      side: group((t) => t.side),
      window: group((t) => t.window),
      trend: group((t) => (t.withTrend ? 'with HTF trend' : 'against HTF trend')),
      model: group((t) => t.model),
      stopAnchor: group((t) => t.stopAnchor.replace(/sweep of .*/, 'sweep wick')),
      targetLabel: group((t) => t.targetLabel),
      hourNy: group((t) => `${String(t.hourNy).padStart(2, '0')}:00`),
      zone: group((t) => (t.pos === null ? '—' : t.pos < 25 ? 'deep discount (<25)' : t.pos < 50 ? 'discount' : t.pos <= 75 ? 'premium' : 'deep premium (>75)')),
    },
  };
}
