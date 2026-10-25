import { EDGE_RULES } from './specs.js';
import type { RStats } from './stats.js';

/** Share of trades where the plan was followed (§13). */
export function complianceRate(trades: readonly { planFollowed: boolean }[]): number {
  return trades.length ? trades.filter((t) => t.planFollowed).length / trades.length : 0;
}

/** Mean absolute deviation of actual risk from the intended risk, as a fraction of it. */
export function riskDeviation(actualRisk: readonly number[], intended: number): number {
  if (!actualRisk.length || !(intended > 0)) return 0;
  return actualRisk.reduce((s, r) => s + Math.abs(r - intended), 0) / actualRisk.length / intended;
}

/** Rule of 100: change rules after 100 trades or 3 months; never before 30 trades. */
export function canChangeRules(trades: number, monthsOfData: number): { ok: boolean; reason: string } {
  if (trades < EDGE_RULES.minTradesBareMinimum) return { ok: false, reason: `${trades} trades — need at least ${EDGE_RULES.minTradesBareMinimum}` };
  if (trades >= EDGE_RULES.minTradesBeforeRuleChange || monthsOfData >= 3) return { ok: true, reason: 'enough data to test one change' };
  return { ok: false, reason: `${trades} trades over ${monthsOfData} months — wait for 100 trades or 3 months` };
}

/** If-then fixes from the review rules. */
export function diagnose(s: RStats, opts: { compliance?: number; riskDev?: number } = {}): string[] {
  const out: string[] = [];
  if (s.n < EDGE_RULES.minTradesBareMinimum) out.push(`Only ${s.n} trades — keep collecting data before judging the edge`);
  if (s.n >= 10 && s.winRate >= 0.5 && s.avgWin < 2) out.push('High win rate but small winners — stop cutting winners early');
  if (s.n >= 10 && s.winRate < 0.3 && s.avgWin >= 3) out.push('Low win rate with strong winners — be more selective (A+ only)');
  if (s.n >= 10 && s.netR > 0 && s.longestLosingStreak >= 5) out.push('Profitable but streaky — fewer trades, shorter window, hard daily stop');
  if (opts.riskDev !== undefined && opts.riskDev > 0.2) out.push('Risk per trade varies — standardise sizing');
  if (opts.compliance !== undefined && opts.compliance < 0.9) out.push(`Plan followed on ${(opts.compliance * 100).toFixed(0)}% of trades — fix execution before changing the plan`);
  if (s.profitFactor !== null && s.profitFactor < 1 && s.n >= EDGE_RULES.minTradesBareMinimum) out.push('Profit factor below 1 — review location and timing filters');
  return out;
}
