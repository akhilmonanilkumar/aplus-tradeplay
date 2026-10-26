/**
 * Outcome of one limit-order signal against candles, with the backtester's rules:
 * the limit fills when price trades through entry; a target hit before any fill is
 * "ran away"; no fill within `expiryBars` closed bars is "expired"; after the fill the
 * stop is checked before the target on every bar, and on the fill bar only the stop
 * counts (the order of a same-bar target is unknown).
 */
import type { Candle } from './smc.js';

export type SignalOutcome = 'pending' | 'filled' | 'win' | 'loss' | 'expired' | 'ran_away';

export interface SignalPlan {
  side: 'long' | 'short';
  entry: number;
  stop: number;
  target: number;
  /** When the order was placed (ms). Bars that close after this count. */
  createdAt: number;
}

export interface SignalResolution {
  outcome: SignalOutcome;
  filledAt: number | null;
  closedAt: number | null;
  exit: number | null;
  /** Gross result in R (+R:R on target, −1 on stop). */
  resultR: number | null;
}

export const isFinalOutcome = (o: SignalOutcome | null | undefined) => o === 'win' || o === 'loss' || o === 'expired' || o === 'ran_away';

/** `candles` must be closed bars of `tfMs`, oldest first. */
export function resolveSignal(s: SignalPlan, candles: readonly Candle[], tfMs: number, expiryBars = 12): SignalResolution {
  const long = s.side === 'long';
  const risk = Math.abs(s.entry - s.stop);
  const rr = risk > 0 ? Math.abs(s.target - s.entry) / risk : 0;
  const bars = candles.filter((c) => c.t + tfMs > s.createdAt);
  const touched = (c: Candle, level: number, below: boolean) => (below ? c.l <= level : c.h >= level);

  let filledAt: number | null = null;
  for (let i = 0; i < bars.length; i++) {
    const c = bars[i]!;
    if (filledAt === null) {
      if (touched(c, s.entry, long)) {
        filledAt = c.t;
        if (touched(c, s.stop, long)) return { outcome: 'loss', filledAt, closedAt: c.t + tfMs, exit: s.stop, resultR: -1 };
        continue;
      }
      if (touched(c, s.target, !long)) return { outcome: 'ran_away', filledAt: null, closedAt: c.t + tfMs, exit: null, resultR: null };
      if (i + 1 >= expiryBars) return { outcome: 'expired', filledAt: null, closedAt: c.t + tfMs, exit: null, resultR: null };
      continue;
    }
    if (touched(c, s.stop, long)) return { outcome: 'loss', filledAt, closedAt: c.t + tfMs, exit: s.stop, resultR: -1 };
    if (touched(c, s.target, !long)) return { outcome: 'win', filledAt, closedAt: c.t + tfMs, exit: s.target, resultR: Math.round(rr * 1000) / 1000 };
  }
  return { outcome: filledAt === null ? 'pending' : 'filled', filledAt, closedAt: null, exit: null, resultR: null };
}
