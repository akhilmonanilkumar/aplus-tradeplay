/**
 * Prop-firm rules: how much room an evaluation or funded account has left, and how big an alert may be
 * on it. Pure functions; the app feeds them account state from trades and balances.
 */

export type DailyBasis = 'start_balance' | 'higher_of_eod_equity_balance';

export interface PropRules {
  preset: string;
  firm: string;
  plan: string;
  /** Profit target per phase as % of the starting balance; a funded stage has 0. */
  phases: { name: string; targetPct: number }[];
  /** Index into `phases`. */
  phase: number;
  dailyLossPct: number;
  /** start_balance: a fixed amount of the starting balance, measured from today's opening balance.
   *  higher_of_eod_equity_balance: % of the higher of yesterday's end-of-day equity and balance, measured from that reference. */
  dailyBasis: DailyBasis;
  maxLossPct: number;
  maxLossType: 'static' | 'trailing';
  /** Largest loss allowed on one trade, % of the starting balance. */
  perTradeLossPct: number | null;
  minProfitableDays: number | null;
  /** No single day may make more than this share of total profit (0.5 = 50%). */
  consistencyShare: number | null;
  newsAllowed: boolean;
  weekendHolding: boolean;
  leverage: string;
}

/** The two accounts in the CFD Arena, from each firm's published rules (checked 31 Oct 2026). */
export const PROP_PRESETS: Record<string, PropRules> = {
  fundedhive_1step_low: {
    preset: 'fundedhive_1step_low', firm: 'FundedHive', plan: '1-Step · Pay from profits · Low risk',
    phases: [{ name: 'Evaluation', targetPct: 10 }, { name: 'Funded', targetPct: 0 }], phase: 0,
    dailyLossPct: 5, dailyBasis: 'start_balance', maxLossPct: 10, maxLossType: 'static',
    perTradeLossPct: 1, minProfitableDays: 3, consistencyShare: null, newsAllowed: true, weekendHolding: true, leverage: 'FX 1:50 (dynamic)',
  },
  the5ers_summer_2step_10_5: {
    preset: 'the5ers_summer_2step_10_5', firm: 'The5ers', plan: 'Summer Plan · 2-Step 10/5',
    phases: [{ name: 'Phase 1', targetPct: 10 }, { name: 'Phase 2', targetPct: 5 }, { name: 'Funded', targetPct: 0 }], phase: 0,
    dailyLossPct: 3, dailyBasis: 'higher_of_eod_equity_balance', maxLossPct: 10, maxLossType: 'static',
    perTradeLossPct: null, minProfitableDays: null, consistencyShare: null, newsAllowed: true, weekendHolding: true, leverage: '1:100',
  },
};

export interface PropState {
  startBalance: number;
  balance: number;
  equity: number;
  /** Balance at today's reset. */
  dayStartBalance: number;
  /** Yesterday's end-of-day equity and balance (The5ers basis); default to dayStartBalance. */
  prevEodEquity?: number;
  prevEodBalance?: number;
  /** Highest closing balance so far (trailing drawdown). */
  peakBalance?: number;
  /** Closed P&L per trading day this phase, oldest first, today last. */
  dailyPnl: number[];
}

export interface PropRoom {
  phaseName: string;
  target: number; progress: number; targetLeft: number;
  dailyLimit: number; dailyFloor: number; dailyRoom: number;
  maxFloor: number; maxRoom: number;
  perTradeCap: number | null;
  profitableDays: number; daysNeeded: number | null;
  consistency: { bestDay: number; total: number; share: number; limit: number } | null;
  breached: string[];
  passed: boolean;
}

export function propRoom(r: PropRules, s: PropState): PropRoom {
  const phase = r.phases[Math.min(r.phase, r.phases.length - 1)]!;
  const target = (s.startBalance * phase.targetPct) / 100;
  const progress = s.equity - s.startBalance;
  const ref = r.dailyBasis === 'higher_of_eod_equity_balance'
    ? Math.max(s.prevEodEquity ?? s.dayStartBalance, s.prevEodBalance ?? s.dayStartBalance)
    : s.dayStartBalance;
  const dailyLimit = ((r.dailyBasis === 'start_balance' ? s.startBalance : ref) * r.dailyLossPct) / 100;
  const dailyFloor = ref - dailyLimit;
  const maxBase = r.maxLossType === 'trailing' ? Math.min(Math.max(s.peakBalance ?? s.startBalance, s.startBalance), s.startBalance * (1 + r.maxLossPct / 100)) : s.startBalance;
  const maxFloor = maxBase - (s.startBalance * r.maxLossPct) / 100;
  const profitableDays = s.dailyPnl.filter((p) => p > 0).length;
  const total = s.dailyPnl.reduce((a, b) => a + b, 0);
  const bestDay = s.dailyPnl.length ? Math.max(...s.dailyPnl) : 0;
  const consistency = r.consistencyShare === null ? null : { bestDay, total, share: total > 0 ? bestDay / total : 0, limit: r.consistencyShare };
  const breached: string[] = [];
  if (s.equity <= dailyFloor) breached.push('daily loss');
  if (s.equity <= maxFloor) breached.push('max loss');
  const passed = target > 0 && progress >= target && (r.minProfitableDays === null || profitableDays >= r.minProfitableDays) && (!consistency || consistency.share <= consistency.limit);
  return {
    phaseName: phase.name, target, progress, targetLeft: Math.max(0, target - progress),
    dailyLimit, dailyFloor, dailyRoom: s.equity - dailyFloor, maxFloor, maxRoom: s.equity - maxFloor,
    perTradeCap: r.perTradeLossPct === null ? null : (s.startBalance * r.perTradeLossPct) / 100,
    profitableDays, daysNeeded: r.minProfitableDays, consistency, breached, passed,
  };
}

export interface SizeInput {
  /** Planned risk as % of current equity. */
  riskPct: number;
  entry: number; stop: number;
  /** Furthest target, for the consistency check. */
  target: number;
  /** Account currency gained per 1.0 price move per lot. */
  valuePerPointPerLot: number;
  lotStep: number; minLot: number;
  /** Share of daily and max-loss room one trade may use. */
  roomShare?: number;
}

export type SizeBound = 'risk' | 'per-trade cap' | 'daily room' | 'max-loss room' | 'consistency';
export interface SizeResult { lots: number; legs: number[]; riskAmount: number; boundBy: SizeBound; blocked: string | null }

const floorStep = (x: number, step: number) => Math.floor(x / step + 1e-9) * step;
const round = (x: number, step: number) => Number((Math.round(x / step) * step).toFixed(Math.max(0, -Math.floor(Math.log10(step)))));

/**
 * Lots for an alert: the smallest of the planned risk, the per-trade cap, a share of today's room and of
 * the max-loss room, and (with a consistency rule) the size whose full win keeps today under the cap.
 * Split into two legs (TP1 and TP2) when both legs reach the minimum lot.
 */
export function propSize(r: PropRules, s: PropState, room: PropRoom, x: SizeInput): SizeResult {
  const share = x.roomShare ?? 0.5;
  const stopDist = Math.abs(x.entry - x.stop), rewardDist = Math.abs(x.target - x.entry);
  const perLotRisk = stopDist * x.valuePerPointPerLot;
  if (!(perLotRisk > 0)) return { lots: 0, legs: [], riskAmount: 0, boundBy: 'risk', blocked: 'stop distance is zero' };
  if (room.breached.length) return { lots: 0, legs: [], riskAmount: 0, boundBy: 'daily room', blocked: `account breached: ${room.breached.join(', ')}` };
  const caps: [SizeBound, number][] = [['risk', (s.equity * x.riskPct) / 100], ['daily room', room.dailyRoom * share], ['max-loss room', room.maxRoom * share]];
  if (room.perTradeCap !== null) caps.push(['per-trade cap', room.perTradeCap]);
  let [boundBy, budget] = caps.reduce((a, b) => (b[1] < a[1] ? b : a));
  let lots = floorStep(budget / perLotRisk, x.lotStep);
  if (room.consistency && r.consistencyShare !== null && rewardDist > 0) {
    const today = s.dailyPnl.at(-1) ?? 0, c = r.consistencyShare;
    const maxWin = (c * room.consistency.total - today) / (1 - c);
    const winLots = floorStep(Math.max(0, maxWin) / (rewardDist * x.valuePerPointPerLot), x.lotStep);
    if (room.consistency.total > 0 && winLots < lots) { lots = winLots; boundBy = 'consistency'; budget = lots * perLotRisk; }
  }
  lots = round(lots, x.lotStep);
  if (lots < x.minLot) return { lots: 0, legs: [], riskAmount: 0, boundBy, blocked: `size below the minimum lot (${boundBy})` };
  const half = round(floorStep(lots / 2, x.lotStep), x.lotStep);
  const legs = half >= x.minLot && round(lots - half, x.lotStep) >= x.minLot ? [half, round(lots - half, x.lotStep)] : [lots];
  return { lots, legs, riskAmount: lots * perLotRisk, boundBy, blocked: null };
}
