import { equalLevels, fairValueGaps, isSweep, marketShift, pivots, premiumDiscount, swingStructure, atr, type Candle, type Trend } from './smc.js';
import { orderBlocks, previousDayLevels, sessionRange } from './zones.js';
import { ASIA_Q } from './sessions.js';

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
  /** Model A plan: limit at the 5M zone that caused the shift, stop beyond the sweep wick. */
  suggest: { entry: number; stop: number; target: number; targetLabel: string } | null;
  /** After the shift: did price return to the entry (filled) or run to target first (ran away)? */
  after: { filled: boolean; ranAway: boolean } | null;
  atr: number;
}

export interface AnalyzeOptions {
  /** Instant used for "today" (previous-day levels, Asia range). Defaults to the last candle close. */
  now?: number;
  manual?: SetupZone[];
  /** Spread / noise buffer beyond the sweep wick. */
  stopBuffer?: (price: number) => number;
  /** Bars of the entry TF searched for a sweep (default 36 = 3 h on 5M). */
  sweepLookback?: number;
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

export function analyzeSetup(side: 'long' | 'short', htf: readonly Candle[], poi: readonly Candle[], ltf: readonly Candle[], opts: AnalyzeOptions = {}): SetupAnalysis {
  const last = ltf[ltf.length - 1] ?? poi[poi.length - 1];
  const price = last?.c ?? 0;
  const now = opts.now ?? (last ? last.t + 1 : Date.now());
  const hr = htf.length > 20 ? htfRange(htf) : null;
  const poiTrend = poi.length > 20 ? swingStructure(poi, 3, 3).trend : null;
  const pd = hr && hr.high > hr.low ? premiumDiscount(hr.low, hr.high, price) : null;
  const pdl = previousDayLevels(poi, now);
  const asiaRaw = sessionRange(poi, ASIA_Q, now - 12 * 3_600_000);
  const asia = asiaRaw && asiaRaw.endUtc <= now ? { high: asiaRaw.high, low: asiaRaw.low } : null;
  const a = atr(poi, 14);

  // Liquidity pools: PDH/PDL, Asia range, equal highs/lows on the POI timeframe.
  const liquidity: LiquidityLevel[] = [];
  if (pdl) liquidity.push({ level: pdl.pdh, label: 'PDH', side: 'buy_side' }, { level: pdl.pdl, label: 'PDL', side: 'sell_side' });
  if (asia) liquidity.push({ level: asia.high, label: 'Asia high', side: 'buy_side' }, { level: asia.low, label: 'Asia low', side: 'sell_side' });
  for (const e of equalLevels(pivots(poi.slice(-200), 3, 3), a * 0.1).slice(-4)) {
    liquidity.push({ level: e.level, label: e.kind, side: e.kind === 'EQH' ? 'buy_side' : 'sell_side' });
  }

  // 15M POIs on the trade side: fresh order blocks with imbalance, unfilled FVGs.
  const want: Trend = side === 'long' ? 'up' : 'down';
  // A zone stays "fresh" until the tap that is happening now: first mitigation inside the last 12 POI bars still counts.
  const tapCut = poi.length - 12;
  const obs = orderBlocks(poi, 3, 3).filter((o) => o.direction === want && o.hasImbalance && (o.mitigatedAt === null || o.mitigatedAt >= tapCut));
  const fvgs = fairValueGaps(poi).filter((f) => f.direction === want && (f.filledAt === null || f.filledAt >= tapCut)).slice(-4);
  const zones: SetupZone[] = [
    ...(opts.manual ?? []),
    ...obs.slice(-3).map((o) => ({ kind: 'order_block' as const, side, top: o.top, bottom: o.bottom, t: poi[o.index]!.t, label: `15M OB${o.tookLiquidity ? ' · swept' : ''}`, fresh: true, liquidityStory: o.tookLiquidity, createdBos: true })),
    ...fvgs.map((f) => ({ kind: 'fvg' as const, side, top: f.top, bottom: f.bottom, t: poi[f.index]!.t, label: '15M FVG', fresh: f.touchedAt === null || f.touchedAt >= tapCut, liquidityStory: false, createdBos: false })),
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

  let suggest: SetupAnalysis['suggest'] = null;
  let after: SetupAnalysis['after'] = null;
  if (sweep && ms && ms.index !== null) {
    const ob = orderBlocks(ltf, 2, 2).filter((o) => o.direction === want && o.index >= sweep!.index - 3 && o.index <= ms.index!).pop();
    let entry = ob ? (side === 'long' ? ob.top : ob.bottom) : ms.level;
    // A zone beyond the sweep wick has no invalidation behind it: enter at the broken swing instead.
    if (side === 'long' ? entry <= sweep.wick : entry >= sweep.wick) entry = ms.level;
    const buf = (opts.stopBuffer ?? (() => 0))(entry);
    let stop = side === 'long' ? sweep.wick - buf : sweep.wick + buf;
    // Floor the risk at a quarter of the 15M ATR: a stop inside the noise is hit by spread alone
    // and turns costs into several R.
    const minRisk = Number.isFinite(a) ? a * 0.25 : 0;
    if ((side === 'long' ? entry - stop : stop - entry) < minRisk) stop = side === 'long' ? entry - minRisk : entry + minRisk;
    // Nearest real level beyond the entry (ignoring noise within ¼R): never stretched to reach 3R.
    const pool = side === 'long'
      ? [{ v: pdl?.pdh, l: 'PDH' }, { v: hr?.high, l: 'Range high' }, { v: asia?.high, l: 'Asia high' }, ...liquidity.filter((x) => x.label === 'EQH').map((x) => ({ v: x.level, l: 'EQH' })), ...pivots(poi, 3, 3).filter((p) => p.kind === 'high').slice(-6).map((p) => ({ v: p.price, l: '15M swing high' }))]
      : [{ v: pdl?.pdl, l: 'PDL' }, { v: hr?.low, l: 'Range low' }, { v: asia?.low, l: 'Asia low' }, ...liquidity.filter((x) => x.label === 'EQL').map((x) => ({ v: x.level, l: 'EQL' })), ...pivots(poi, 3, 3).filter((p) => p.kind === 'low').slice(-6).map((p) => ({ v: p.price, l: '15M swing low' }))];
    const risk = Math.abs(entry - stop);
    const cands = pool
      .filter((x): x is { v: number; l: string } => typeof x.v === 'number' && Number.isFinite(x.v) && (side === 'long' ? x.v > entry + risk * 0.25 : x.v < entry - risk * 0.25))
      .sort((x, y) => (side === 'long' ? x.v - y.v : y.v - x.v));
    const t = cands[0];
    if (t && risk > 0) {
      suggest = { entry, stop, target: t.v, targetLabel: t.l };
      let filled = false, ranAway = false;
      for (let k = ms.index + 1; k < ltf.length; k++) {
        const c = ltf[k]!;
        if (side === 'long' ? c.l <= entry : c.h >= entry) { filled = true; break; }
        if (side === 'long' ? c.h >= t.v : c.l <= t.v) { ranAway = true; break; }
      }
      after = { filled, ranAway };
    }
  }

  return {
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
    suggest,
    after,
    atr: a,
  };
}

/** Desk state from what the detector sees (the gate decides ARMED). */
export function stateFromSetup(a: SetupAnalysis, armed: boolean, hasPlan: boolean): 'IDLE' | 'PLANNED' | 'IN_POI' | 'SWEPT' | 'SHIFTED' | 'ARMED' {
  if (armed) return 'ARMED';
  if (a.shift?.t) return 'SHIFTED';
  if (a.sweep) return 'SWEPT';
  if (a.inside) return 'IN_POI';
  return hasPlan || a.zones.length ? 'PLANNED' : 'IDLE';
}
