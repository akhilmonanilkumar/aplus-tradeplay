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
 * Internal structure: BOS / CHoCH on candle BODY closes through the last confirmed swing,
 * however minor. Used where every break counts (order blocks that broke structure); the
 * trend of a frame comes from `swingStructure`, which respects the protected levels.
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

/**
 * SMC swing structure (the trend the HTF and POI frames report). The trend only changes on a
 * body close through the protected level: in an uptrend the strong low the last bullish break
 * started from, in a downtrend the strong high the last bearish break started from. Closes
 * through minor swings inside a leg are internal structure and do not flip the trend. A
 * continuation BOS needs a body close beyond the leg's extreme swing (the highest swing high
 * since the last break in an uptrend), which moves the protected level to the pullback that
 * preceded it. Before the first break, the first close through any confirmed swing sets it.
 */
export function swingStructure(candles: readonly Candle[], left = 3, right = 3): {
  breaks: StructureBreak[];
  trend: Trend | null;
  /** Level whose body-close break would be the next CHoCH (strong low in an uptrend, strong high in a downtrend). */
  protectedLevel: { price: number; index: number } | null;
} {
  const piv = [...pivots(candles, left, right)].sort((a, b) => a.confirmedAt - b.confirmedAt);
  const breaks: StructureBreak[] = [];
  let trend: Trend | null = null;
  let protect: { price: number; index: number } | null = null;
  let lastHigh: Pivot | null = null, lastLow: Pivot | null = null;
  // Extreme swing of the current leg (pivots formed at or after the last break).
  let legHigh: Pivot | null = null, legLow: Pivot | null = null;
  let lastBreak = -1;
  let pi = 0;

  const lowest = (from: number, to: number) => { let k = from; for (let x = from; x <= to; x++) if (candles[x]!.l < candles[k]!.l) k = x; return { price: candles[k]!.l, index: k }; };
  const highest = (from: number, to: number) => { let k = from; for (let x = from; x <= to; x++) if (candles[x]!.h > candles[k]!.h) k = x; return { price: candles[k]!.h, index: k }; };
  const breakUp = (j: number, level: number, from: number) => {
    breaks.push({ kind: trend === 'down' ? 'CHoCH' : 'BOS', direction: 'up', index: j, level, pivotIndex: from });
    trend = 'up';
    protect = lowest(from, j);
    lastBreak = j; legHigh = null; legLow = null;
  };
  const breakDown = (j: number, level: number, from: number) => {
    breaks.push({ kind: trend === 'up' ? 'CHoCH' : 'BOS', direction: 'down', index: j, level, pivotIndex: from });
    trend = 'down';
    protect = highest(from, j);
    lastBreak = j; legHigh = null; legLow = null;
  };

  for (let j = 0; j < candles.length; j++) {
    while (pi < piv.length && piv[pi]!.confirmedAt <= j) {
      const p = piv[pi]!;
      if (p.kind === 'high') {
        lastHigh = p;
        if (p.index >= lastBreak && (!legHigh || p.price > legHigh.price)) legHigh = p;
      } else {
        lastLow = p;
        if (p.index >= lastBreak && (!legLow || p.price < legLow.price)) legLow = p;
      }
      pi++;
    }
    const c = candles[j]!.c;
    if (trend === null) {
      if (lastHigh && c > lastHigh.price && j > lastHigh.index) breakUp(j, lastHigh.price, lastHigh.index);
      else if (lastLow && c < lastLow.price && j > lastLow.index) breakDown(j, lastLow.price, lastLow.index);
    } else if (trend === 'up') {
      const pr = protect as { price: number; index: number } | null;
      if (pr && c < pr.price) breakDown(j, pr.price, pr.index);
      else if (legHigh && c > legHigh.price && j > legHigh.index) breakUp(j, legHigh.price, legHigh.index);
    } else {
      const pr = protect as { price: number; index: number } | null;
      if (pr && c > pr.price) breakUp(j, pr.price, pr.index);
      else if (legLow && c < legLow.price && j > legLow.index) breakDown(j, legLow.price, legLow.index);
    }
  }
  return { breaks, trend, protectedLevel: protect };
}

export interface SmcLevel {
  /** Current swing level (NaN until the first pivot of this kind). */
  level: number;
  index: number;
  crossed: boolean;
}

export interface SmcStructureSide {
  trend: Trend | null;
  breaks: StructureBreak[];
  high: SmcLevel;
  low: SmcLevel;
}

export interface SmcStructure {
  internal: SmcStructureSide;
  swing: SmcStructureSide;
  /** Swing extremes since the last swing pivots (premium/discount range of the swing structure). */
  trailing: { top: number; topIndex: number; bottom: number; bottomIndex: number };
  /** Strong high / weak low (bearish swing bias) or strong low / weak high (bullish). */
  strong: { kind: 'high' | 'low'; level: number } | null;
}

/**
 * Internal and swing market structure computed the way the LuxAlgo "Smart Money Concepts"
 * indicator does, so the engine reads a chart the same way a trader using it would:
 *
 * - Legs: with length `size`, the bar `size` bars back starts a bearish leg when its high is
 *   above the highest high of the `size` bars after it, and a bullish leg when its low is below
 *   their lowest low. A change of leg makes that bar a swing high (new bearish leg) or a swing
 *   low (new bullish leg), so pivots alternate. Internal structure uses 5, swing structure 50.
 * - Breaks: a close crossing above the current swing high (close > level, previous close <=
 *   previous level) that has not been crossed yet is a bullish break: CHoCH when the bias was
 *   bearish, otherwise BOS; the bias becomes bullish. Lows mirror it. Internal breaks are
 *   skipped where the internal level is the swing level (optionally also a candle-confluence filter).
 * - Premium / discount: the trailing swing top and bottom, reset at each swing pivot and
 *   extended by new highs and lows.
 */
export function smcStructure(candles: readonly Candle[], opts: { internal?: number; swing?: number; confluence?: boolean } = {}): SmcStructure {
  const sizes = { internal: opts.internal ?? 5, swing: opts.swing ?? 50 };
  const mkSide = (): SmcStructureSide & { leg: number; prevHigh: number; prevLow: number } => ({
    trend: null, breaks: [], leg: 0,
    high: { level: NaN, index: -1, crossed: false }, low: { level: NaN, index: -1, crossed: false },
    prevHigh: NaN, prevLow: NaN,
  });
  const sw = mkSide(), int = mkSide();
  const trailing = { top: NaN, topIndex: -1, bottom: NaN, bottomIndex: -1 };

  const updateLegs = (st: ReturnType<typeof mkSide>, size: number, j: number, isSwing: boolean) => {
    if (j < size) return;
    const k = j - size;
    let hh = -Infinity, ll = Infinity;
    for (let x = k + 1; x <= j; x++) { hh = Math.max(hh, candles[x]!.h); ll = Math.min(ll, candles[x]!.l); }
    const prev = st.leg;
    if (candles[k]!.h > hh) st.leg = 0; // bearish leg starts: swing high at k
    else if (candles[k]!.l < ll) st.leg = 1; // bullish leg starts: swing low at k
    if (st.leg === prev) return;
    if (st.leg === 1) {
      st.low = { level: candles[k]!.l, index: k, crossed: false };
      if (isSwing) { trailing.bottom = candles[k]!.l; trailing.bottomIndex = k; }
    } else {
      st.high = { level: candles[k]!.h, index: k, crossed: false };
      if (isSwing) { trailing.top = candles[k]!.h; trailing.topIndex = k; }
    }
  };

  const checkBreaks = (st: ReturnType<typeof mkSide>, j: number, isInternal: boolean) => {
    const c = candles[j]!, pc = candles[j - 1]!;
    const upper = c.h - Math.max(c.c, c.o), lower = Math.min(c.c, c.o) - c.l;
    const bullishBar = opts.confluence ? upper > lower : true;
    const bearishBar = opts.confluence ? upper < lower : true;
    const hi = st.high;
    const okHigh = isInternal ? hi.level !== sw.high.level && bullishBar : true;
    if (Number.isFinite(hi.level) && !hi.crossed && okHigh && c.c > hi.level && Number.isFinite(st.prevHigh) && pc.c <= st.prevHigh) {
      st.breaks.push({ kind: st.trend === 'down' ? 'CHoCH' : 'BOS', direction: 'up', index: j, level: hi.level, pivotIndex: hi.index });
      hi.crossed = true;
      st.trend = 'up';
    }
    const lo = st.low;
    const okLow = isInternal ? lo.level !== sw.low.level && bearishBar : true;
    if (Number.isFinite(lo.level) && !lo.crossed && okLow && c.c < lo.level && Number.isFinite(st.prevLow) && pc.c >= st.prevLow) {
      st.breaks.push({ kind: st.trend === 'up' ? 'CHoCH' : 'BOS', direction: 'down', index: j, level: lo.level, pivotIndex: lo.index });
      lo.crossed = true;
      st.trend = 'down';
    }
  };

  for (let j = 0; j < candles.length; j++) {
    // Levels as they stood on the previous bar (the crossover compares against them).
    for (const st of [sw, int]) { st.prevHigh = st.high.level; st.prevLow = st.low.level; }
    updateLegs(sw, sizes.swing, j, true);
    updateLegs(int, sizes.internal, j, false);
    const c = candles[j]!;
    if (Number.isFinite(trailing.top) && c.h > trailing.top) { trailing.top = c.h; trailing.topIndex = j; }
    if (Number.isFinite(trailing.bottom) && c.l < trailing.bottom) { trailing.bottom = c.l; trailing.bottomIndex = j; }
    if (j === 0) continue;
    // ta.crossover needs the previous bar's level: a level set this bar compares against NaN.
    checkBreaks(int, j, true);
    checkBreaks(sw, j, false);
  }

  const strip = (st: ReturnType<typeof mkSide>): SmcStructureSide => ({ trend: st.trend, breaks: st.breaks, high: st.high, low: st.low });
  const strong = sw.trend === 'down' && Number.isFinite(trailing.top) ? { kind: 'high' as const, level: trailing.top }
    : sw.trend === 'up' && Number.isFinite(trailing.bottom) ? { kind: 'low' as const, level: trailing.bottom } : null;
  return { internal: strip(int), swing: strip(sw), trailing, strong };
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
  /** Price beyond the dealing range: the range no longer applies (structure is breaking). */
  const outside: 'below' | 'above' | null = price < rangeLow ? 'below' : price > rangeHigh ? 'above' : null;
  return { eq, pos, zone, outside };
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
