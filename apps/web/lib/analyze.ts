import {
  fairValueGaps, isSweep, marketShift, orderBlocks, pivots, premiumDiscount, previousDayLevels, structureBreaks,
  type Candle, type Trend,
} from "@aplus/engine";

export interface Zone { kind: "order_block" | "fvg" | "manual"; side: "long" | "short"; top: number; bottom: number; t: number; label: string; fresh: boolean; liquidityStory: boolean; createdBos: boolean }
export interface Analysis {
  price: number;
  htfTrend: Trend | null;
  poiTrend: Trend | null;
  range: { low: number; high: number } | null;
  eq: number | null;
  zone: "premium" | "discount" | "mid" | null;
  pdh: number | null;
  pdl: number | null;
  zones: Zone[];
  inside: Zone | null;
  sweep: { t: number; level: number; label: string; wick: number } | null;
  shift: { t: number | null; level: number; close: number | null } | null;
  lastLH: number | null;
  lastHL: number | null;
  /** Model A plan from closed candles: limit at the 5M zone that caused the shift. */
  suggest: { entry: number; stop: number; target: number; targetLabel: string } | null;
}

/** Spread / noise buffer beyond the sweep wick. */
export const STOP_BUFFER: Record<string, (price: number) => number> = {
  XAUUSD: () => 0.3,
  "BTCUSDT.P": (p) => p * 0.0005,
};

/** Dealing range from the latest HTF break: origin of the BOS → extreme reached after it. */
export function htfRange(c: readonly Candle[]): { low: number; high: number; trend: Trend | null } | null {
  const { breaks, trend } = structureBreaks(c, 3, 3);
  const b = breaks[breaks.length - 1];
  if (!b) return null;
  if (b.direction === "up") {
    let low = Infinity; for (let k = b.pivotIndex; k <= b.index; k++) low = Math.min(low, c[k]!.l);
    let high = -Infinity; for (let k = b.index; k < c.length; k++) high = Math.max(high, c[k]!.h);
    return { low, high, trend };
  }
  let high = -Infinity; for (let k = b.pivotIndex; k <= b.index; k++) high = Math.max(high, c[k]!.h);
  let low = Infinity; for (let k = b.index; k < c.length; k++) low = Math.min(low, c[k]!.l);
  return { low, high, trend };
}

export function analyze(side: "long" | "short", htf: Candle[], poi: Candle[], ltf: Candle[], manual: Zone[] = [], instrument = "XAUUSD"): Analysis {
  const price = ltf[ltf.length - 1]?.c ?? poi[poi.length - 1]?.c ?? 0;
  const hr = htf.length > 20 ? htfRange(htf) : null;
  const poiTrend = poi.length > 20 ? structureBreaks(poi, 3, 3).trend : null;
  const pd = hr && hr.high > hr.low ? premiumDiscount(hr.low, hr.high, price) : null;
  const pdl = previousDayLevels(poi, Date.now());

  // 15M POIs: fresh order blocks (with imbalance) and unfilled FVGs on the trade side.
  const want: Trend = side === "long" ? "up" : "down";
  const obs = orderBlocks(poi, 3, 3).filter((o) => o.direction === want && o.hasImbalance && o.mitigatedAt === null);
  const fvgs = fairValueGaps(poi).filter((f) => f.direction === want && f.filledAt === null).slice(-4);
  const zones: Zone[] = [
    ...manual,
    ...obs.slice(-3).map((o) => ({ kind: "order_block" as const, side, top: o.top, bottom: o.bottom, t: poi[o.index]!.t, label: `15M OB${o.tookLiquidity ? " · swept" : ""}`, fresh: true, liquidityStory: o.tookLiquidity, createdBos: true })),
    ...fvgs.map((f) => ({ kind: "fvg" as const, side, top: f.top, bottom: f.bottom, t: poi[f.index]!.t, label: "15M FVG", fresh: f.touchedAt === null, liquidityStory: false, createdBos: false })),
  ];
  const ref = ltf.length ? ltf.slice(-6) : [];
  const touch = (z: Zone) => ref.some((c) => c.l <= z.top && c.h >= z.bottom);
  const inside = zones.find((z) => price <= z.top && price >= z.bottom) ?? zones.find(touch) ?? null;

  // Liquidity on the 5M: sweep of PDL/PDH, or of a recent swing on the opposite side, within the last 3 hours.
  const lookback = ltf.slice(-36);
  const offset = ltf.length - lookback.length;
  const levels: { level: number; label: string }[] = [];
  if (pdl) levels.push(side === "long" ? { level: pdl.pdl, label: "PDL" } : { level: pdl.pdh, label: "PDH" });
  for (const p of pivots(ltf.slice(0, Math.max(0, ltf.length - 2)), 3, 3).filter((p) => p.kind === (side === "long" ? "low" : "high")).slice(-4)) {
    levels.push({ level: p.price, label: side === "long" ? "5M swing low" : "5M swing high" });
  }
  let sweep: Analysis["sweep"] = null, sweepIdx = -1;
  for (let i = lookback.length - 1; i >= 0 && !sweep; i--) {
    const c = lookback[i]!;
    for (const L of levels) {
      if (isSweep(c, L.level, side === "long" ? "sell_side" : "buy_side")) { sweep = { t: c.t, level: L.level, label: L.label, wick: side === "long" ? c.l : c.h }; sweepIdx = offset + i; break; }
    }
  }
  const ms = sweepIdx >= 0 ? marketShift(ltf, side, sweepIdx, 2, 2) : null;
  const ltfPiv = pivots(ltf, 2, 2);
  const lastLH = [...ltfPiv].reverse().find((p) => p.kind === "high")?.price ?? null;
  const lastHL = [...ltfPiv].reverse().find((p) => p.kind === "low")?.price ?? null;

  let suggest: Analysis["suggest"] = null;
  if (sweep && ms && ms.index !== null) {
    const ob = orderBlocks(ltf, 2, 2).filter((o) => o.direction === want && o.index >= sweepIdx - 3 && o.index <= ms.index!).pop();
    const entry = ob ? (side === "long" ? ob.top : ob.bottom) : ms.level;
    const buf = (STOP_BUFFER[instrument] ?? (() => 0))(entry);
    const stop = side === "long" ? sweep.wick - buf : sweep.wick + buf;
    const cands = side === "long"
      ? [{ v: pdl?.pdh, l: "PDH" }, { v: hr?.high, l: "Range high" }].filter((x): x is { v: number; l: string } => x.v !== undefined && x.v > entry).sort((a, b) => a.v - b.v)
      : [{ v: pdl?.pdl, l: "PDL" }, { v: hr?.low, l: "Range low" }].filter((x): x is { v: number; l: string } => x.v !== undefined && x.v < entry).sort((a, b) => b.v - a.v);
    const t = cands[0];
    if (t) suggest = { entry, stop, target: t.v, targetLabel: t.l };
  }

  return {
    suggest,
    price,
    htfTrend: hr?.trend ?? null,
    poiTrend,
    range: hr ? { low: hr.low, high: hr.high } : null,
    eq: pd?.eq ?? null,
    zone: pd?.zone ?? null,
    pdh: pdl?.pdh ?? null,
    pdl: pdl?.pdl ?? null,
    zones,
    inside,
    sweep,
    shift: ms ? { t: ms.index !== null ? ltf[ms.index]!.t : null, level: ms.level, close: ms.close } : null,
    lastLH,
    lastHL,
  };
}
