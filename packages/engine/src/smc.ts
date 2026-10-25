/**
 * Deterministic market-structure primitives. Everything works on CLOSED candles only,
 * and pivots are only "known" once their right-hand bars have closed, so nothing repaints.
 */

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v?: number;
}

export type Trend = 'up' | 'down';

export interface Pivot {
  kind: 'high' | 'low';
  index: number;
  price: number;
  /** Bar index at which the pivot becomes confirmed (index + right). */
  confirmedAt: number;
}

/** Swing pivots: strictly higher (lower) than `left` bars before and `right` bars after. */
export function pivots(candles: readonly Candle[], left = 3, right = 3): Pivot[] {
  const out: Pivot[] = [];
  for (let i = left; i < candles.length - right; i++) {
    const c = candles[i]!;
    let isHigh = true, isLow = true;
    for (let k = i - left; k <= i + right; k++) {
      if (k === i) continue;
      const o = candles[k]!;
      if (o.h >= c.h) isHigh = false;
      if (o.l <= c.l) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) out.push({ kind: 'high', index: i, price: c.h, confirmedAt: i + right });
    if (isLow) out.push({ kind: 'low', index: i, price: c.l, confirmedAt: i + right });
  }
  return out;
}

export interface StructureBreak {
  kind: 'BOS' | 'CHoCH';
  direction: Trend;
  index: number;
  level: number;
  pivotIndex: number;
}

/**
 * Break of structure / change of character using candle BODY closes through the last
 * confirmed swing. BOS continues the current trend; CHoCH is the first break against it.
 */
export function structureBreaks(candles: readonly Candle[], left = 3, right = 3): { breaks: StructureBreak[]; trend: Trend | null } {
  const piv = pivots(candles, left, right);
  const breaks: StructureBreak[] = [];
  let trend: Trend | null = null;
  let lastHigh: Pivot | null = null, lastLow: Pivot | null = null;
  let usedHigh = -1, usedLow = -1;
  let pi = 0;
  const sorted = [...piv].sort((a, b) => a.confirmedAt - b.confirmedAt);
  for (let j = 0; j < candles.length; j++) {
    while (pi < sorted.length && sorted[pi]!.confirmedAt <= j) {
      const p = sorted[pi]!;
      if (p.kind === 'high') lastHigh = p; else lastLow = p;
      pi++;
    }
    const c = candles[j]!;
    if (lastHigh && lastHigh.index !== usedHigh && c.c > lastHigh.price && j > lastHigh.index) {
      breaks.push({ kind: trend === 'down' ? 'CHoCH' : 'BOS', direction: 'up', index: j, level: lastHigh.price, pivotIndex: lastHigh.index });
      trend = 'up';
      usedHigh = lastHigh.index;
    } else if (lastLow && lastLow.index !== usedLow && c.c < lastLow.price && j > lastLow.index) {
      breaks.push({ kind: trend === 'up' ? 'CHoCH' : 'BOS', direction: 'down', index: j, level: lastLow.price, pivotIndex: lastLow.index });
      trend = 'down';
      usedLow = lastLow.index;
    }
  }
  return { breaks, trend };
}

/** Liquidity sweep: wick through a level and close back on the original side. */
export function isSweep(c: Candle, level: number, side: 'sell_side' | 'buy_side'): boolean {
  return side === 'sell_side' ? c.l < level && c.c > level : c.h > level && c.c < level;
}

export interface Fvg {
  direction: Trend;
  /** Index of the middle candle. */
  index: number;
  top: number;
  bottom: number;
  touchedAt: number | null;
  filledAt: number | null;
}

/** Three-candle fair value gaps with mitigation tracking. */
export function fairValueGaps(candles: readonly Candle[]): Fvg[] {
  const out: Fvg[] = [];
  for (let i = 1; i < candles.length - 1; i++) {
    const a = candles[i - 1]!, b = candles[i + 1]!;
    let g: Fvg | null = null;
    if (b.l > a.h) g = { direction: 'up', index: i, top: b.l, bottom: a.h, touchedAt: null, filledAt: null };
    else if (b.h < a.l) g = { direction: 'down', index: i, top: a.l, bottom: b.h, touchedAt: null, filledAt: null };
    if (!g) continue;
    for (let k = i + 2; k < candles.length; k++) {
      const x = candles[k]!;
      if (g.direction === 'up') {
        if (g.touchedAt === null && x.l <= g.top) g.touchedAt = k;
        if (x.l <= g.bottom) { g.filledAt = k; break; }
      } else {
        if (g.touchedAt === null && x.h >= g.bottom) g.touchedAt = k;
        if (x.h >= g.top) { g.filledAt = k; break; }
      }
    }
    out.push(g);
  }
  return out;
}

/** Average true range (simple mean of true ranges). */
export function atr(candles: readonly Candle[], period = 14): number {
  if (candles.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!, p = candles[i - 1]!;
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
  }
  const s = trs.slice(-period);
  return s.reduce((a, b) => a + b, 0) / s.length;
}

/** Equal highs / lows: pairs of same-kind pivots within `tolerance` price units. */
export function equalLevels(piv: readonly Pivot[], tolerance: number): { kind: 'EQH' | 'EQL'; a: Pivot; b: Pivot; level: number }[] {
  const out: { kind: 'EQH' | 'EQL'; a: Pivot; b: Pivot; level: number }[] = [];
  for (const kind of ['high', 'low'] as const) {
    const list = piv.filter((p) => p.kind === kind);
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1]!, b = list[i]!;
      if (Math.abs(a.price - b.price) <= tolerance) {
        out.push({ kind: kind === 'high' ? 'EQH' : 'EQL', a, b, level: kind === 'high' ? Math.max(a.price, b.price) : Math.min(a.price, b.price) });
      }
    }
  }
  return out;
}

export type Zone = 'discount' | 'premium' | 'mid';

/** Premium / discount of a dealing range with a no-trade band around equilibrium. */
export function premiumDiscount(rangeLow: number, rangeHigh: number, price: number, midBandPct = 5) {
  if (!(rangeHigh > rangeLow)) throw new Error('rangeHigh must be above rangeLow');
  const eq = (rangeLow + rangeHigh) / 2;
  const pos = ((price - rangeLow) / (rangeHigh - rangeLow)) * 100;
  const zone: Zone = Math.abs(pos - 50) <= midBandPct ? 'mid' : pos < 50 ? 'discount' : 'premium';
  return { eq, pos, zone };
}

/**
 * LTF market shift after a sweep: the first candle BODY close beyond the last swing
 * (lower high for a long, higher low for a short) that formed before the sweep.
 */
export function marketShift(candles: readonly Candle[], side: 'long' | 'short', sweepIndex: number, left = 2, right = 2) {
  const piv = pivots(candles, left, right).filter((p) => p.index < sweepIndex && (side === 'long' ? p.kind === 'high' : p.kind === 'low'));
  const ref = piv[piv.length - 1];
  if (!ref) return null;
  for (let j = sweepIndex + 1; j < candles.length; j++) {
    const c = candles[j]!;
    if (side === 'long' ? c.c > ref.price : c.c < ref.price) return { index: j, level: ref.price, pivotIndex: ref.index, close: c.c };
  }
  return { index: null, level: ref.price, pivotIndex: ref.index, close: null };
}
