/** Edge and performance statistics, all in R (multiples of initial risk). */

/** Break-even win rate for a fixed R:R and per-trade cost c (in R): (1 + c) ÷ (R + 1). */
export function breakevenWinRate(rr: number, costR = 0): number {
  if (!(rr > 0)) throw new Error('rr must be > 0');
  return (1 + costR) / (rr + 1);
}

/** Expectancy per trade in R: W(R − c) − (1 − W)(1 + c). */
export function expectancy(winRate: number, rr: number, costR = 0): number {
  if (winRate < 0 || winRate > 1) throw new Error('winRate must be in [0, 1]');
  return winRate * (rr - costR) - (1 - winRate) * (1 + costR);
}

export interface RStats {
  n: number;
  wins: number;
  losses: number;
  winRate: number;
  avgR: number;
  netR: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number | null;
  maxDrawdownR: number;
  recoveryFactor: number | null;
  /** Per-trade Sharpe: mean ÷ sample stdev. Not annualised. */
  sharpePerTrade: number | null;
  longestLosingStreak: number;
}

export function summarize(results: readonly number[]): RStats {
  const n = results.length;
  let wins = 0, losses = 0, gw = 0, gl = 0, net = 0, peak = 0, eq = 0, mdd = 0, streak = 0, worst = 0;
  for (const r of results) {
    net += r;
    if (r > 0) { wins++; gw += r; streak = 0; }
    else if (r < 0) { losses++; gl += r; streak++; worst = Math.max(worst, streak); }
    eq += r;
    peak = Math.max(peak, eq);
    mdd = Math.max(mdd, peak - eq);
  }
  const avg = n ? net / n : 0;
  let sharpe: number | null = null;
  if (n > 1) {
    const v = results.reduce((a, r) => a + (r - avg) ** 2, 0) / (n - 1);
    sharpe = v > 0 ? avg / Math.sqrt(v) : null;
  }
  return {
    n,
    wins,
    losses,
    winRate: n ? wins / n : 0,
    avgR: avg,
    netR: net,
    avgWin: wins ? gw / wins : 0,
    avgLoss: losses ? gl / losses : 0,
    profitFactor: gl !== 0 ? gw / Math.abs(gl) : null,
    maxDrawdownR: mdd,
    recoveryFactor: mdd > 0 ? net / mdd : null,
    sharpePerTrade: sharpe,
    longestLosingStreak: worst,
  };
}

/** Max drawdown of an equity series as a fraction of the running peak. */
export function maxDrawdownPct(equity: readonly number[]): number {
  let peak = -Infinity, mdd = 0;
  for (const e of equity) {
    peak = Math.max(peak, e);
    if (peak > 0) mdd = Math.max(mdd, (peak - e) / peak);
  }
  return mdd;
}
