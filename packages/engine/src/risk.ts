import { round } from './num.js';
import { EDGE_RULES } from './specs.js';
import type { Grade } from './gate.js';

/** Personal guardrails (§10). All percentages are of the day's opening balance unless stated. */
export interface GuardrailInput {
  dayStartBalance: number;
  equity: number;
  /** Highest equity reached (for drawdown). */
  peakEquity: number;
  tradesToday: number;
  lossesToday: number;
  maxTrades?: number;
  stopAfterLosses?: number;
  dailyLossCapPct?: number;
  /** e.g. 1 on challenge accounts; omit for no cap. */
  dailyProfitCapPct?: number | null;
  maxDrawdownPausePct?: number;
}

export interface GuardrailResult {
  canTrade: boolean;
  reasons: string[];
  dayPnl: number;
  dayPnlPct: number;
  drawdownPct: number;
  /** Money left before the daily loss cap. */
  lossRoom: number;
}

export function guardrails(g: GuardrailInput): GuardrailResult {
  const maxTrades = g.maxTrades ?? EDGE_RULES.maxAPlusTradesPerDay;
  const stopAfter = g.stopAfterLosses ?? EDGE_RULES.stopAfterLosses;
  const lossCap = g.dailyLossCapPct ?? EDGE_RULES.dailyLossCapPct;
  const ddCap = g.maxDrawdownPausePct ?? EDGE_RULES.maxDrawdownPausePct;
  const dayPnl = g.equity - g.dayStartBalance;
  const dayPnlPct = (dayPnl / g.dayStartBalance) * 100;
  const drawdownPct = g.peakEquity > 0 ? Math.max(0, ((g.peakEquity - g.equity) / g.peakEquity) * 100) : 0;
  const reasons: string[] = [];
  if (g.tradesToday >= maxTrades) reasons.push(`trade cap ${maxTrades} reached`);
  if (g.lossesToday >= stopAfter) reasons.push(`stopped after ${g.lossesToday} losses`);
  if (dayPnlPct <= -lossCap) reasons.push(`daily loss cap ${lossCap}% hit`);
  if (g.dailyProfitCapPct !== null && g.dailyProfitCapPct !== undefined && dayPnlPct >= g.dailyProfitCapPct) reasons.push(`daily profit cap ${g.dailyProfitCapPct}% reached`);
  if (drawdownPct >= ddCap) reasons.push(`drawdown ${drawdownPct.toFixed(1)}% ≥ ${ddCap}%: pause and review`);
  const lossRoom = Math.max(0, (g.dayStartBalance * lossCap) / 100 + Math.min(0, dayPnl));
  return { canTrade: reasons.length === 0, reasons, dayPnl: round(dayPnl, 2), dayPnlPct: round(dayPnlPct, 3), drawdownPct: round(drawdownPct, 3), lossRoom: round(lossRoom, 2) };
}

/**
 * Risk % for a graded setup. Fixed base risk until enough trades prove variable risk;
 * then A+ may use the larger size. B/C and anything ungraded = 0.
 */
export function riskForGrade(grade: Grade, opts: { provenTrades?: number; variable?: boolean; basePct?: number; aPlusPct?: number } = {}): number {
  const base = opts.basePct ?? EDGE_RULES.baseRiskPct;
  const plus = opts.aPlusPct ?? EDGE_RULES.aPlusRiskPct;
  const proven = (opts.provenTrades ?? 0) >= EDGE_RULES.variableRiskAfterTrades;
  if (grade === 'A+') return opts.variable && proven ? plus : base;
  if (grade === 'A') return base;
  return 0;
}

/** Turn a firm's limits into tighter personal limits (§11): a fraction of each, capped by the source guideline. */
export function personalLimits(firm: { dailyLossPct?: number; maxLossPct?: number }, fraction = 0.5) {
  const daily = firm.dailyLossPct !== undefined ? Math.min(firm.dailyLossPct * fraction, EDGE_RULES.dailyLossCapPct) : EDGE_RULES.dailyLossCapPct;
  const max = firm.maxLossPct !== undefined ? firm.maxLossPct * fraction : EDGE_RULES.maxDrawdownPausePct;
  return { dailyLossPct: round(daily, 3), maxDrawdownPct: round(max, 3) };
}
