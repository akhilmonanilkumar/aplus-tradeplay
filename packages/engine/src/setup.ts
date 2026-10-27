import { equalLevels, fairValueGaps, isSweep, marketShift, pivots, premiumDiscount, smcStructure, structureBreaks, swingStructure, atr, type Candle, type Trend } from './smc.js';
import { orderBlocks, previousDayLevels, sessionRange } from './zones.js';
import { ASIA_Q, LONDON_Q } from './sessions.js';
import { EDGE_RULES } from './specs.js';

/**
 * Setup detector: turns closed HTF / POI / entry-TF candles into what the A+ gate
 * needs (range, half, POIs, sweep, shift, a Model A plan). Pure and deterministic,
 * so the desk, the autopilot and the backtester see exactly the same thing.
 */

export interface SetupZone {
  kind: 'order_block' | 'fvg' | 'manual';
  side: 'long' | 'short';
  top: number;
  bottom: number;
  t: number;
  label: string;
  fresh: boolean;
  liquidityStory: boolean;
  createdBos: boolean;
}

export interface LiquidityLevel { level: number; label: string; side: 'buy_side' | 'sell_side' }

export interface SetupAnalysis {
  price: number;
  htfTrend: Trend | null;
  poiTrend: Trend | null;
  range: { low: number; high: number } | null;
  eq: number | null;
  zone: 'premium' | 'discount' | 'mid' | null;
  /** 0–100 position of price in the range. */
  pos: number | null;
  pdh: number | null;
  pdl: number | null;
  asia: { high: number; low: number } | null;
  liquidity: LiquidityLevel[];
  zones: SetupZone[];
  inside: SetupZone | null;
  sweep: { t: number; index: number; level: number; label: string; wick: number } | null;
  shift: { t: number | null; level: number; close: number | null } | null;
  lastLH: number | null;
  lastHL: number | null;
  /** Latest 5M structure break in the trade direction (LuxAlgo internal structure, length 5) within the sweep lookback, sweep or not. */
  ltfShift: { t: number; index: number; level: number; kind: 'BOS' | 'CHoCH' } | null;
  /**
   * Plan. After a sweep and shift (Model A): limit at the 5M zone that caused the shift. Without a
   * sweep, from the 5M shift alone, the leg that broke structure stands in for the sweep.
   * Stop: beyond the furthest of the sweep wick (or leg extreme), the entry order block and the 15M
   * POI being traded, plus a buffer of a fraction of the 5M ATR (never less than the spread buffer).
   * Target: the nearest real level (liquidity, swing, unfilled FVG) worth at least `minRR`.
   */
  suggest: { entry: number; stop: number; target: number; targetLabel: string; basis: 'sweep' | 'shift'; stopAnchor: string; stopBuffer: number } | null;
  /** Real levels beyond the entry in order of distance, with the R each would pay. */
  targets: { level: number; label: string; r: number }[];
  /** Every target candidate on the trade side (liquidity, swings, unfilled FVGs), before filtering by entry. */
  pool: { level: number; label: string }[];
  /** Stop buffer beyond an anchor: max(spread buffer, `stopAtrMult` × entry-TF ATR). */
  stopBuf: number;
  /** Entry-TF ATR(14). */
  ltfAtr: number;
  /** London Q high/low of the current New York day once that window has closed (session liquidity for NY). */
  london: { high: number; low: number } | null;
  /** After the shift: did price return to the entry (filled) or run to target first (ran away)? */
  after: { filled: boolean; ranAway: boolean } | null;
  atr: number;
}

export interface AnalyzeOptions {
  /** Instant used for "today" (previous-day levels, Asia range). Defaults to the last candle close. */
  now?: number;
  manual?: SetupZone[];
  /** Spread buffer beyond the stop anchor (the minimum buffer). */
  stopBuffer?: (price: number) => number;
  /** Stop buffer beyond the anchor as a multiple of the entry-TF ATR(14) (default 0.2). */
  stopAtrMult?: number;
  /** Bars of the entry TF searched for a sweep (default 36 = 3 h on 5M). */
  sweepLookback?: number;
  /** Minimum reward:risk the target should pay; the nearest real level that does is chosen (default 2). */
  minRR?: number;
}

/** Dealing range from the latest HTF break: origin of the BOS → extreme reached after it. */
export function htfRange(c: readonly Candle[]): { low: number; high: number; trend: Trend | null } | null {
  const { breaks, trend } = swingStructure(c, 3, 3);
  const b = breaks[breaks.length - 1];
  if (!b) return null;
  if (b.direction === 'up') {
    let low = Infinity; for (let k = b.pivotIndex; k <= b.index; k++) low = Math.min(low, c[k]!.l);
    let high = -Infinity; for (let k = b.index; k < c.length; k++) high = Math.max(high, c[k]!.h);
    return { low, high, trend };
  }
  let high = -Infinity; for (let k = b.pivotIndex; k <= b.index; k++) high = Math.max(high, c[k]!.h);
  let low = Infinity; for (let k = b.index; k < c.length; k++) low = Math.min(low, c[k]!.l);
  return { low, high, trend };
}

/** Structure lengths, as in LuxAlgo Smart Money Concepts (internal 5, swing 50). */
export const STRUCTURE = { internal: 5, swing: 50 } as const;

/**
 * Trend and dealing range of one frame, read like LuxAlgo Smart Money Concepts: the swing
 * (50) bias and its trailing premium/discount range. Until the window holds a swing break,
 * the protected-level structure on (3,3) swings stands in for both.
 */
export function frameStructure(c: readonly Candle[]): { trend: Trend | null; range: { low: number; high: number } | null; internalTrend: Trend | null } {
  const s = smcStructure(c, STRUCTURE);
  const { top, bottom } = s.trailing;
  if (s.swing.trend && Number.isFinite(top) && Number.isFinite(bottom) && top > bottom) {
    return { trend: s.swing.trend, range: { low: bottom, high: top }, internalTrend: s.internal.trend };
  }
  const hr = htfRange(c);
  return { trend: hr?.trend ?? null, range: hr ? { low: hr.low, high: hr.high } : null, internalTrend: s.internal.trend };
}

export function analyzeSetup(side: 'long' | 'short', htf: readonly Candle[], poi: readonly Candle[], ltf: readonly Candle[], opts: AnalyzeOptions = {}): SetupAnalysis {
  const last = ltf[ltf.length - 1] ?? poi[poi.length - 1];
  const price = last?.c ?? 0;
  const now = opts.now ?? (last ? last.t + 1 : Date.now());
  const hs = htf.length > 20 ? frameStructure(htf) : null;
  const hr = hs?.range ? { ...hs.range, trend: hs.trend } : null;
  const poiTrend = poi.length > 20 ? frameStructure(poi).trend : null;
  const pd = hr && hr.high > hr.low ? premiumDiscount(hr.low, hr.high, price) : null;
  const pdl = previousDayLevels(poi, now);
  const asiaRaw = sessionRange(poi, ASIA_Q, now - 12 * 3_600_000);
  const asia = asiaRaw && asiaRaw.endUtc <= now ? { high: asiaRaw.high, low: asiaRaw.low } : null;
  const londonRaw = sessionRange(poi, LONDON_Q, now);
  const london = londonRaw && londonRaw.endUtc <= now ? { high: londonRaw.high, low: londonRaw.low } : null;
  const a = atr(poi, 14);

  // Liquidity pools: PDH/PDL, Asia range, equal highs/lows on the POI timeframe.
  const liquidity: LiquidityLevel[] = [];
  if (pdl) liquidity.push({ level: pdl.pdh, label: 'PDH', side: 'buy_side' }, { level: pdl.pdl, label: 'PDL', side: 'sell_side' });
  if (asia) liquidity.push({ level: asia.high, label: 'Asia high', side: 'buy_side' }, { level: asia.low, label: 'Asia low', side: 'sell_side' });
  if (london) liquidity.push({ level: london.high, label: 'London high', side: 'buy_side' }, { level: london.low, label: 'London low', side: 'sell_side' });
  for (const e of equalLevels(pivots(poi.slice(-200), 3, 3), a * 0.1).slice(-4)) {
    liquidity.push({ level: e.level, label: e.kind, side: e.kind === 'EQH' ? 'buy_side' : 'sell_side' });
  }

  // 15M POIs on the trade side (§2.3): order blocks whose candle took the previous candle's low (high)
  // and whose displacement left an imbalance and broke structure; unfilled FVGs.
  const want: Trend = side === 'long' ? 'up' : 'down';
  // A zone stays "fresh" until the tap that is happening now: first mitigation inside the last 12 POI bars still counts.
  const tapCut = poi.length - 12;
  const poiPiv = pivots(poi, 3, 3);
  const poiBreaks = structureBreaks(poi, 3, 3).breaks;
  const sellSide = side === 'long';
  // Liquidity story (§4): the zone swept liquidity when it formed (its leg ran a prior swing on the
  // stop side), or a liquidity pool sits just in front of it that price must take first.
  const liquidityStory = (top: number, bottom: number, formedAt: number): boolean => {
    const prior = poiPiv.filter((p) => p.kind === (sellSide ? 'low' : 'high') && p.confirmedAt < formedAt && p.index >= formedAt - 40);
    const swept = prior.some((p) => (sellSide ? bottom < p.price && p.price < top + a : top > p.price && p.price > bottom - a));
    const front = liquidity.some((l) => l.side === (sellSide ? 'sell_side' : 'buy_side') && (sellSide ? l.level >= top && l.level <= top + a : l.level <= bottom && l.level >= bottom - a))
      || poiPiv.some((p) => p.kind === (sellSide ? 'low' : 'high') && p.index > formedAt && (sellSide ? p.price >= top && p.price <= top + a : p.price <= bottom && p.price >= bottom - a));
    return swept || front;
  };
  const obs = orderBlocks(poi, 3, 3).filter((o) => o.direction === want && o.hasImbalance && o.tookLiquidity && (o.mitigatedAt === null || o.mitigatedAt >= tapCut));
  const fvgs = fairValueGaps(poi).filter((f) => f.direction === want && (f.filledAt === null || f.filledAt >= tapCut)).slice(-4);
  const zones: SetupZone[] = [
    ...(opts.manual ?? []),
    ...obs.slice(-3).map((o) => {
      const story = liquidityStory(o.top, o.bottom, o.index);
      return { kind: 'order_block' as const, side, top: o.top, bottom: o.bottom, t: poi[o.index]!.t, label: `15M OB${story ? ' · liquidity' : ''}`, fresh: true, liquidityStory: story, createdBos: true };
    }),
    ...fvgs.map((f) => ({
      kind: 'fvg' as const, side, top: f.top, bottom: f.bottom, t: poi[f.index]!.t, label: '15M FVG',
      fresh: f.touchedAt === null || f.touchedAt >= tapCut, liquidityStory: liquidityStory(f.top, f.bottom, f.index),
      // The displacement that left the gap broke structure within three bars.
      createdBos: poiBreaks.some((b) => b.direction === want && b.index >= f.index - 1 && b.index <= f.index + 3),
    })),
  ];

  // Sweep on the entry TF: a liquidity pool or a recent swing on the opposite side.
  const lookback = Math.min(opts.sweepLookback ?? 36, ltf.length);
  const offset = ltf.length - lookback;
  const levels = liquidity.filter((l) => l.side === (side === 'long' ? 'sell_side' : 'buy_side')).map((l) => ({ level: l.level, label: l.label }));
  for (const p of pivots(ltf.slice(0, Math.max(0, ltf.length - 2)), 3, 3).filter((p) => p.kind === (side === 'long' ? 'low' : 'high')).slice(-4)) {
    levels.push({ level: p.price, label: side === 'long' ? '5M swing low' : '5M swing high' });
  }
  let sweep: SetupAnalysis['sweep'] = null;
  for (let i = ltf.length - 1; i >= offset && !sweep; i--) {
    const c = ltf[i]!;
    for (const L of levels) {
      if (isSweep(c, L.level, side === 'long' ? 'sell_side' : 'buy_side')) { sweep = { t: c.t, index: i, level: L.level, label: L.label, wick: side === 'long' ? c.l : c.h }; break; }
    }
  }
  // In POI: price inside a zone now, or the sweep candle (or the last 6 bars) tapped one.
  const recent = ltf.slice(-6);
  const touched = (z: SetupZone, c: Candle) => c.l <= z.top && c.h >= z.bottom;
  const sweepBar = sweep ? ltf[sweep.index]! : null;
  const inside = zones.find((z) => price <= z.top && price >= z.bottom)
    ?? (sweepBar ? zones.find((z) => touched(z, sweepBar)) : undefined)
    ?? zones.find((z) => recent.some((c) => touched(z, c)))
    ?? null;
  const ms = sweep ? marketShift(ltf, side, sweep.index, 2, 2) : null;
  const ltfPiv = pivots(ltf, 2, 2);
  const lastLH = [...ltfPiv].reverse().find((p) => p.kind === 'high')?.price ?? null;
  const lastHL = [...ltfPiv].reverse().find((p) => p.kind === 'low')?.price ?? null;

  // 5M structure as LuxAlgo internal structure reads it: the latest break in the trade direction.
  const ltfStruct = smcStructure(ltf, { internal: STRUCTURE.internal, swing: STRUCTURE.swing });
  const lastBreak = [...ltfStruct.internal.breaks, ...ltfStruct.swing.breaks]
    .filter((b) => b.direction === want && b.index >= offset)
    .sort((x, y) => y.index - x.index)[0];
  const ltfShift: SetupAnalysis['ltfShift'] = lastBreak ? { t: ltf[lastBreak.index]!.t, index: lastBreak.index, level: lastBreak.level, kind: lastBreak.kind } : null;

  // Target pool: liquidity, range extremes, swings and unfilled FVGs (their near edge) beyond the entry.
  const fvgTargets = (c: readonly Candle[], label: string) => fairValueGaps(c)
    .filter((f) => f.filledAt === null && f.direction === (side === 'long' ? 'down' : 'up'))
    .slice(-8)
    .map((f) => ({ v: side === 'long' ? f.bottom : f.top, l: label }));
  const pool = side === 'long'
    ? [{ v: pdl?.pdh, l: 'PDH' }, { v: hr?.high, l: 'Range high' }, { v: asia?.high, l: 'Asia high' }, { v: london?.high, l: 'London high' }, ...liquidity.filter((x) => x.label === 'EQH').map((x) => ({ v: x.level, l: 'EQH' })), ...pivots(poi, 3, 3).filter((p) => p.kind === 'high').slice(-6).map((p) => ({ v: p.price, l: '15M swing high' })), ...pivots(ltf, 3, 3).filter((p) => p.kind === 'high').slice(-6).map((p) => ({ v: p.price, l: '5M swing high' })), ...fvgTargets(poi, '15M FVG'), ...fvgTargets(ltf, '5M FVG')]
    : [{ v: pdl?.pdl, l: 'PDL' }, { v: hr?.low, l: 'Range low' }, { v: asia?.low, l: 'Asia low' }, { v: london?.low, l: 'London low' }, ...liquidity.filter((x) => x.label === 'EQL').map((x) => ({ v: x.level, l: 'EQL' })), ...pivots(poi, 3, 3).filter((p) => p.kind === 'low').slice(-6).map((p) => ({ v: p.price, l: '15M swing low' })), ...pivots(ltf, 3, 3).filter((p) => p.kind === 'low').slice(-6).map((p) => ({ v: p.price, l: '5M swing low' })), ...fvgTargets(poi, '15M FVG'), ...fvgTargets(ltf, '5M FVG')];
  const minRR = opts.minRR ?? EDGE_RULES.minRR;
  const ltfAtr = atr(ltf, 14);
  const atrBuf = Number.isFinite(ltfAtr) ? ltfAtr * (opts.stopAtrMult ?? 0.2) : 0;

  let suggest: SetupAnalysis['suggest'] = null;
  let after: SetupAnalysis['after'] = null;
  let targets: SetupAnalysis['targets'] = [];
  const plan = (entry: number, anchors: { v: number; l: string }[], fromIndex: number, basis: 'sweep' | 'shift') => {
    // The structural invalidation is the furthest anchor beyond the entry: below all of them for a long.
    const beyond = anchors.filter((x) => Number.isFinite(x.v) && (side === 'long' ? x.v < entry : x.v > entry));
    if (!beyond.length) return;
    const anchor = beyond.reduce((m, x) => (side === 'long' ? (x.v < m.v ? x : m) : (x.v > m.v ? x : m)));
    const buf = Math.max(atrBuf, (opts.stopBuffer ?? (() => 0))(entry));
    const stop = side === 'long' ? anchor.v - buf : anchor.v + buf;
    const risk = Math.abs(entry - stop);
    if (!(risk > 0)) return;
    const seen = new Set<string>();
    targets = pool
      .filter((x): x is { v: number; l: string } => typeof x.v === 'number' && Number.isFinite(x.v) && (side === 'long' ? x.v > entry + risk * 0.25 : x.v < entry - risk * 0.25))
      .sort((x, y) => (side === 'long' ? x.v - y.v : y.v - x.v))
      .filter((x) => { const k = x.v.toFixed(2); if (seen.has(k)) return false; seen.add(k); return true; })
      .map((x) => ({ level: x.v, label: x.l, r: Math.abs(x.v - entry) / risk }));
    // The nearest real level that pays the minimum R:R; if none does, the nearest one (the gate then says no).
    const t = targets.find((x) => x.r >= minRR) ?? targets[0];
    if (!t) return;
    suggest = { entry, stop, target: t.level, targetLabel: t.label, basis, stopAnchor: anchor.l, stopBuffer: buf };
    let filled = false, ranAway = false;
    for (let k = fromIndex + 1; k < ltf.length; k++) {
      const c = ltf[k]!;
      if (side === 'long' ? c.l <= entry : c.h >= entry) { filled = true; break; }
      if (side === 'long' ? c.h >= t.level : c.l <= t.level) { ranAway = true; break; }
    }
    after = { filled, ranAway };
  };

  // The 15M POI being traded protects the setup until price leaves it: its far edge is a stop anchor.
  const poiAnchor = (z: SetupZone | null) => (z ? [{ v: side === 'long' ? z.bottom : z.top, l: z.label }] : []);
  const obAnchor = (o: { top: number; bottom: number } | undefined) => (o ? [{ v: side === 'long' ? o.bottom : o.top, l: '5M OB' }] : []);

  if (sweep && ms && ms.index !== null) {
    const ob = orderBlocks(ltf, 2, 2).filter((o) => o.direction === want && o.index >= sweep!.index - 3 && o.index <= ms.index!).pop();
    let entry = ob ? (side === 'long' ? ob.top : ob.bottom) : ms.level;
    // A zone beyond the sweep wick has no invalidation behind it: enter at the broken swing instead.
    if (side === 'long' ? entry <= sweep.wick : entry >= sweep.wick) entry = ms.level;
    plan(entry, [{ v: sweep.wick, l: `sweep of ${sweep.label}` }, ...obAnchor(ob), ...poiAnchor(inside)], ms.index, 'sweep');
  } else if (ltfShift && lastBreak) {
    // No sweep: the leg that broke structure is the invalidation; enter at its order block or the broken level.
    let ext = lastBreak.pivotIndex;
    for (let k = lastBreak.pivotIndex; k <= lastBreak.index; k++) {
      if (side === 'long' ? ltf[k]!.l < ltf[ext]!.l : ltf[k]!.h > ltf[ext]!.h) ext = k;
    }
    const wick = side === 'long' ? ltf[ext]!.l : ltf[ext]!.h;
    const ob = orderBlocks(ltf, 2, 2).filter((o) => o.direction === want && o.index >= ext - 3 && o.index <= lastBreak.index).pop();
    let entry = ob ? (side === 'long' ? ob.top : ob.bottom) : lastBreak.level;
    if (side === 'long' ? entry <= wick : entry >= wick) entry = lastBreak.level;
    plan(entry, [{ v: wick, l: 'shift leg extreme' }, ...obAnchor(ob), ...poiAnchor(inside)], lastBreak.index, 'shift');
  }

  return {
    pool: pool.filter((x): x is { v: number; l: string } => typeof x.v === 'number' && Number.isFinite(x.v)).map((x) => ({ level: x.v, label: x.l })),
    stopBuf: Math.max(atrBuf, (opts.stopBuffer ?? (() => 0))(price)),
    ltfAtr,
    london,
    price,
    htfTrend: hr?.trend ?? null,
    poiTrend,
    range: hr ? { low: hr.low, high: hr.high } : null,
    eq: pd?.eq ?? null,
    zone: pd?.zone ?? null,
    pos: pd?.pos ?? null,
    pdh: pdl?.pdh ?? null,
    pdl: pdl?.pdl ?? null,
    asia,
    liquidity,
    zones,
    inside,
    sweep,
    shift: ms ? { t: ms.index !== null ? ltf[ms.index]!.t : null, level: ms.level, close: ms.close } : null,
    lastLH,
    lastHL,
    ltfShift,
    suggest,
    targets,
    after,
    atr: a,
  };
}

/** Box 5 wording for the shift the detector found, e.g. "5M CHoCH down through 4,012.91". */
export function shiftText(a: SetupAnalysis): string | null {
  const f = (x: number) => x.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (a.shift?.t) return `5M body close through ${f(a.shift.level)} after the sweep`;
  if (a.ltfShift) return `5M ${a.ltfShift.kind} ${a.ltfShift.kind === 'BOS' ? 'continuation' : 'shift'} through ${f(a.ltfShift.level)}${a.sweep ? '' : ' (no sweep yet)'}`;
  return null;
}

/** Desk state from what the detector sees (the gate decides ARMED). */
export function stateFromSetup(a: SetupAnalysis, armed: boolean, hasPlan: boolean): 'IDLE' | 'PLANNED' | 'IN_POI' | 'SWEPT' | 'SHIFTED' | 'ARMED' {
  if (armed) return 'ARMED';
  if (a.shift?.t) return 'SHIFTED';
  if (a.sweep) return 'SWEPT';
  if (a.inside) return 'IN_POI';
  return hasPlan || a.zones.length ? 'PLANNED' : 'IDLE';
}
