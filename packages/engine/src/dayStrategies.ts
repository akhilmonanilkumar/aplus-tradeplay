import type { Candle } from './smc.js';
import type { InstrumentId } from './instruments.js';
import type { SessionTrade } from './sessionModels.js';
import type { RStats } from './stats.js';
import { runBreadnButter, type BnbParams } from './breadnbutter.js';
import { runRangeTheory, type RangeTheoryParams } from './rangeTheory.js';

/**
 * Day strategies: rule sets built on the clock (yesterday's range, the Tokyo box) rather than the A+
 * checklist. They log and paper trade as model S like the session strategies, each variant on its own record.
 * Every variant carries the cost cap (fees above a quarter of the risk skip the trade).
 */

export const DAY_STRATEGIES = [
  {
    id: 'bnb', name: 'BreadnButter', kind: 'liquidity', range: "Yesterday's", trade: 'London / NY Q',
    summary: "Yesterday's high and low are the battlefield: the first push fails to take one side, a displacement leaves a gap, and the trade runs to the other side.",
    steps: ["Mark yesterday's high and low (17:00 New York roll)", 'Today opens inside that range', "The first push towards one side fails to take yesterday's level", 'A displacement candle away from that low (high) leaves a fresh fair-value gap', "Limit at the gap; target yesterday's other extreme"],
    entry: 'Limit at the near edge of the fresh gap', stop: 'Beyond the protected low / high', target: "Yesterday's opposite extreme (2R minimum)",
  },
  {
    id: 'rt', name: 'Range Theory', kind: 'breakout', range: 'Tokyo box', trade: 'London / NY open',
    summary: 'A box tied to the clock (01:00–05:00 London): two closes outside it in the first two hours of London or New York pick the side; the retest at 60% is the entry.',
    steps: ['Box: the first four hours of Tokyo, 01:00–05:00 London time, on 15M', 'Break: two 15M closes outside the box in the first two hours of London', 'Fib from the box to the breakout extreme', 'Pending entry at 60%, stop at 80%', 'Trade two: the same rules in the first two hours of New York (two trades a day at most)'],
    entry: 'Pending at the 60% retracement', stop: 'At the 80% retracement', target: '3R, capped at half the daily ATR',
  },
] as const;

export type DayStrategyId = (typeof DAY_STRATEGIES)[number]['id'];

export interface DayVariant {
  id: string;
  strategy: DayStrategyId;
  /** Short display name. */
  name: string;
  label: string;
  /** Needs a correlated market's candles (SMT). */
  needsCorr?: boolean;
  bnb?: BnbParams;
  rt?: RangeTheoryParams;
}

const BNB: BnbParams = { insideOpen: true, smt: 'off', trend: false, discount: false, window: 'kz', stop: 'swing', entry: 'edge', minRR: 2, dispAtr: 1, pushAtr: 0.5, partialAtR: null, maxCostR: 0.25, shift: false, asiaSweep: false };
const RT: RangeTheoryParams = { mode: 'retest', closes: 2, anchor: 'far', entryFib: 0.6, stopFib: 0.8, rr: 3, capAtr: 0.5, minRR: 1, sessions: 'both', trend: false, maxBoxAtr: null, maxCostR: 0.25 };

/** Variants logged on paper. The A+ versions add the gates that held up in the backtest. */
export const DAY_VARIANTS: readonly DayVariant[] = [
  { id: 'bnb', strategy: 'bnb', name: 'BreadnButter', label: 'BreadnButter: as taught, kill zones, 2R minimum', bnb: BNB },
  { id: 'bnb-j', strategy: 'bnb', name: 'BreadnButter · A+ Asia sweep', label: 'BreadnButter A+: the failed push swept the Asia range, 2.5R minimum', bnb: { ...BNB, asiaSweep: true, minRR: 2.5 } },
  { id: 'bnb-smt', strategy: 'bnb', name: 'BreadnButter · SMT', label: 'BreadnButter SMT: the correlated market took its level, 2.5R minimum', needsCorr: true, bnb: { ...BNB, smt: 'require', minRR: 2.5 } },
  { id: 'rt', strategy: 'rt', name: 'Range Theory', label: 'Range Theory: as taught, London and New York', rt: RT },
  { id: 'rt-l', strategy: 'rt', name: 'Range Theory · London', label: 'Range Theory: London only', rt: { ...RT, sessions: 'london' } },
];

/** Correlated market for the SMT check (sign -1: the pair moves against it). */
export const SMT_PAIRS: Partial<Record<InstrumentId, { id: InstrumentId; sign: 1 | -1 }>> = {
  EURUSD: { id: 'GBPUSD', sign: 1 }, GBPUSD: { id: 'EURUSD', sign: 1 }, USDJPY: { id: 'EURUSD', sign: -1 },
  NAS100: { id: 'SPX500', sign: 1 }, SPX500: { id: 'NAS100', sign: 1 },
};

export interface DayData { ltf: readonly Candle[]; ltfMs: number; htf?: readonly Candle[]; htfMs?: number; corr?: readonly Candle[] | null; corrSign?: 1 | -1 }

export type DayTrade = SessionTrade & { filledAt: number };

/** Runs one variant; null when it needs data this market does not have (no SMT pair). */
export interface DayResult { trades: DayTrade[]; stats: RStats; from: number; to: number }

export function runDayVariant(v: DayVariant, id: InstrumentId, d: DayData): DayResult | null {
  if (v.strategy === 'bnb') {
    if (v.needsCorr && !d.corr?.length) return null;
    return runBreadnButter(id, { ltf: d.ltf, ltfMs: d.ltfMs, htf: d.htf, htfMs: d.htfMs, corr: d.corr?.length ? { ltf: d.corr, sign: d.corrSign ?? 1 } : null }, v.bnb!);
  }
  return runRangeTheory(id, { ltf: d.ltf, ltfMs: d.ltfMs, htf: d.htf, htfMs: d.htfMs }, v.rt!);
}

export const dayVariant = (id: string | null | undefined) => DAY_VARIANTS.find((v) => v.id === id) ?? null;
