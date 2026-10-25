import { fairValueGaps, isSweep, structureBreaks, type Candle, type Trend } from './smc.js';
import { windowOnDateOf, zonedParts, NY, type SessionWindow } from './sessions.js';

export interface OrderBlock {
  direction: Trend;
  /** Index of the OB candle. */
  index: number;
  /** Wick-to-wick, drawn from the extreme. */
  top: number;
  bottom: number;
  /** Bullish: the OB candle took the previous candle's low (bearish: high). */
  tookLiquidity: boolean;
  /** Displacement left an FVG between the OB and the break. */
  hasImbalance: boolean;
  /** Index of the BOS / CHoCH the move produced. */
  breakIndex: number;
  mitigatedAt: number | null;
}

/**
 * Order blocks per §2.3: the last opposite candle before a displacement that
 * breaks structure. Without an imbalance it is just a zone, so it is flagged, not kept.
 */
export function orderBlocks(candles: readonly Candle[], left = 3, right = 3): OrderBlock[] {
  const { breaks } = structureBreaks(candles, left, right);
  const fvgs = fairValueGaps(candles);
  const out: OrderBlock[] = [];
  for (const b of breaks) {
    const up = b.direction === 'up';
    // Origin of the displacement: the extreme between the broken pivot and the break.
    let origin = b.pivotIndex;
    for (let k = b.pivotIndex; k <= b.index; k++) {
      const c = candles[k]!;
      if (up ? c.l < candles[origin]!.l : c.h > candles[origin]!.h) origin = k;
    }
    // Last opposite-coloured candle at or before the origin (within 3 bars).
    let ob = -1;
    for (let k = origin; k >= Math.max(0, origin - 3); k--) {
      const c = candles[k]!;
      if (up ? c.c < c.o : c.c > c.o) { ob = k; break; }
    }
    if (ob < 0) continue;
    const c = candles[ob]!;
    const prev = candles[ob - 1];
    const tookLiquidity = prev ? (up ? c.l < prev.l : c.h > prev.h) : false;
    const hasImbalance = fvgs.some((f) => f.direction === b.direction && f.index > ob && f.index <= b.index);
    let mitigatedAt: number | null = null;
    for (let k = b.index + 1; k < candles.length; k++) {
      const x = candles[k]!;
      if (up ? x.l <= c.h : x.h >= c.l) { mitigatedAt = k; break; }
    }
    if (!out.some((o) => o.index === ob && o.direction === b.direction)) {
      out.push({ direction: b.direction, index: ob, top: c.h, bottom: c.l, tookLiquidity, hasImbalance, breakIndex: b.index, mitigatedAt });
    }
  }
  return out;
}

/** High / low of the candles inside a session window instance (e.g. the Asia range). */
export function sessionRange(candles: readonly Candle[], w: SessionWindow, onDateOf: number): { high: number; low: number; startUtc: number; endUtc: number } | null {
  const inst = windowOnDateOf(onDateOf, w);
  const inside = candles.filter((c) => c.t >= inst.startUtc && c.t < inst.endUtc);
  if (!inside.length) return null;
  return { high: Math.max(...inside.map((c) => c.h)), low: Math.min(...inside.map((c) => c.l)), startUtc: inst.startUtc, endUtc: inst.endUtc };
}

/** Previous trading day's high / low. Gold and FX roll at 17:00 New York. */
export function previousDayLevels(candles: readonly Candle[], now: number, rollHour = 17): { pdh: number; pdl: number } | null {
  const dayKey = (t: number) => {
    const shifted = t + (24 - rollHour) * 3_600_000; // 17:00 NY becomes midnight
    const p = zonedParts(shifted, NY);
    return `${p.year}-${p.month}-${p.day}`;
  };
  const today = dayKey(now);
  const keys = Array.from(new Set(candles.map((c) => dayKey(c.t)))).filter((k) => k !== today);
  const last = keys[keys.length - 1];
  if (!last) return null;
  const day = candles.filter((c) => dayKey(c.t) === last);
  return { pdh: Math.max(...day.map((c) => c.h)), pdl: Math.min(...day.map((c) => c.l)) };
}

/**
 * Model D inducement: the first tap into a zone reacts, then a later candle sweeps
 * that first tap's extreme and closes back. Returns the sweep index or null.
 */
export function inducementSwept(candles: readonly Candle[], zone: { top: number; bottom: number }, side: 'long' | 'short', from = 0): { firstTap: number; sweep: number | null } | null {
  let first = -1;
  for (let k = from; k < candles.length; k++) {
    const c = candles[k]!;
    if (side === 'long' ? c.l <= zone.top && c.l >= zone.bottom - (zone.top - zone.bottom) : c.h >= zone.bottom && c.h <= zone.top + (zone.top - zone.bottom)) { first = k; break; }
  }
  if (first < 0) return null;
  const level = side === 'long' ? candles[first]!.l : candles[first]!.h;
  for (let k = first + 2; k < candles.length; k++) {
    if (isSweep(candles[k]!, level, side === 'long' ? 'sell_side' : 'buy_side')) return { firstTap: first, sweep: k };
  }
  return { firstTap: first, sweep: null };
}
