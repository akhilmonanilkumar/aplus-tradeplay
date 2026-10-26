import type { Candle } from './smc.js';

/**
 * Market context: derivatives positioning, the dollar, rates and correlations.
 * Context never changes an A+ gate result; it grades confluence and can be used
 * as an optional autopilot filter ("don't buy into extreme long funding").
 */

/* ---------------- statistics ---------------- */

export function mean(x: readonly number[]): number {
  return x.length ? x.reduce((a, b) => a + b, 0) / x.length : 0;
}

export function stdev(x: readonly number[]): number {
  if (x.length < 2) return 0;
  const m = mean(x);
  return Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / (x.length - 1));
}

export function zscore(x: readonly number[]): number | null {
  if (x.length < 3) return null;
  const s = stdev(x.slice(0, -1));
  return s > 0 ? (x[x.length - 1]! - mean(x.slice(0, -1))) / s : null;
}

/** Pearson correlation of two equal-length series. */
export function pearson(a: readonly number[], b: readonly number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  const ma = mean(a.slice(0, n)), mb = mean(b.slice(0, n));
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]! - ma, y = b[i]! - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : null;
}

export interface Point { t: number; v: number }

/** Log returns of two series aligned on identical timestamps (bars missing on either side are dropped). */
export function alignedReturns(a: readonly Point[], b: readonly Point[]): { ra: number[]; rb: number[]; n: number } {
  const mb = new Map(b.map((p) => [p.t, p.v]));
  const pairs = a.filter((p) => mb.has(p.t)).map((p) => [p.v, mb.get(p.t)!] as const);
  const ra: number[] = [], rb: number[] = [];
  for (let i = 1; i < pairs.length; i++) {
    const [a0, b0] = pairs[i - 1]!, [a1, b1] = pairs[i]!;
    if (a0 > 0 && a1 > 0 && b0 > 0 && b1 > 0) { ra.push(Math.log(a1 / a0)); rb.push(Math.log(b1 / b0)); }
  }
  return { ra, rb, n: ra.length };
}

/** Correlation and beta of `b` against `a` over the last `window` aligned returns. */
export function correlation(a: readonly Point[], b: readonly Point[], window = 240): { corr: number | null; beta: number | null; n: number } {
  const { ra, rb } = alignedReturns(a, b);
  const x = ra.slice(-window), y = rb.slice(-window);
  const corr = pearson(x, y);
  const sx = stdev(x), sy = stdev(y);
  return { corr, beta: corr !== null && sx > 0 ? (corr * sy) / sx : null, n: x.length };
}

/** Rolling correlation, one value per bar after the first `window` returns. */
export function rollingCorrelation(a: readonly Point[], b: readonly Point[], window = 48): Point[] {
  const mb = new Map(b.map((p) => [p.t, p.v]));
  const pairs = a.filter((p) => mb.has(p.t)).map((p) => ({ t: p.t, a: p.v, b: mb.get(p.t)! }));
  const out: Point[] = [];
  const ra: number[] = [], rb: number[] = [];
  for (let i = 1; i < pairs.length; i++) {
    ra.push(Math.log(pairs[i]!.a / pairs[i - 1]!.a));
    rb.push(Math.log(pairs[i]!.b / pairs[i - 1]!.b));
    if (ra.length >= window) {
      const c = pearson(ra.slice(-window), rb.slice(-window));
      if (c !== null) out.push({ t: pairs[i]!.t, v: c });
    }
  }
  return out;
}

export const closes = (c: readonly Candle[]): Point[] => c.map((x) => ({ t: x.t, v: x.c }));

export function ema(x: readonly number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let e = x[0] ?? 0;
  for (let i = 0; i < x.length; i++) { e = i === 0 ? x[0]! : x[i]! * k + e * (1 - k); out.push(e); }
  return out;
}

/** Trend from a fast/slow EMA pair: +1 up, −1 down, 0 flat (within `flatPct`). */
export function emaTrend(values: readonly number[], fast = 20, slow = 50, flatPct = 0.02): { dir: -1 | 0 | 1; spreadPct: number } {
  if (values.length < slow) return { dir: 0, spreadPct: 0 };
  const f = ema(values, fast).at(-1)!, s = ema(values, slow).at(-1)!;
  const spreadPct = ((f - s) / s) * 100;
  return { dir: Math.abs(spreadPct) < flatPct ? 0 : spreadPct > 0 ? 1 : -1, spreadPct };
}

export function changePct(values: readonly number[], bars: number): number | null {
  if (values.length <= bars) return null;
  const a = values[values.length - 1 - bars]!, b = values[values.length - 1]!;
  return a ? ((b - a) / a) * 100 : null;
}

/* ---------------- derivatives ---------------- */

export type OiRegime = 'long_build' | 'short_build' | 'short_cover' | 'long_unwind' | 'neutral';

export const OI_REGIME_TEXT: Record<OiRegime, string> = {
  long_build: 'Price ↑ OI ↑ — new longs entering',
  short_build: 'Price ↓ OI ↑ — new shorts entering',
  short_cover: 'Price ↑ OI ↓ — short covering (weak rally)',
  long_unwind: 'Price ↓ OI ↓ — long liquidation / unwind',
  neutral: 'No clear positioning change',
};

/** Classic price × open-interest quadrant. Thresholds in % over the same window. */
export function oiRegime(priceChgPct: number, oiChgPct: number, priceTh = 0.3, oiTh = 0.5): OiRegime {
  if (Math.abs(priceChgPct) < priceTh || Math.abs(oiChgPct) < oiTh) return 'neutral';
  if (priceChgPct > 0) return oiChgPct > 0 ? 'long_build' : 'short_cover';
  return oiChgPct > 0 ? 'short_build' : 'long_unwind';
}

export type FundingState = 'extreme_long' | 'elevated_long' | 'neutral' | 'elevated_short' | 'extreme_short';

/** Funding per 8 h (fraction, e.g. 0.0001 = 0.01%). Baseline on Binance is 0.01%. */
export function fundingState(rate8h: number): FundingState {
  const bp = rate8h * 10_000; // basis points
  if (bp >= 5) return 'extreme_long';
  if (bp >= 2) return 'elevated_long';
  if (bp <= -3) return 'extreme_short';
  if (bp <= -1) return 'elevated_short';
  return 'neutral';
}

/** Annualised funding (3 payments a day). */
export const fundingApr = (rate8h: number) => rate8h * 3 * 365 * 100;

/** Perp premium over the index, in %. */
export const basisPct = (mark: number, index: number) => (index > 0 ? ((mark - index) / index) * 100 : 0);

/* ---------------- the dollar ---------------- */

/** ICE US Dollar Index formula from its six component rates. */
export function syntheticDxy(r: { eurusd: number; usdjpy: number; gbpusd: number; usdcad: number; usdsek: number; usdchf: number }): number {
  return 50.14348112 * r.eurusd ** -0.576 * r.usdjpy ** 0.136 * r.gbpusd ** -0.119 * r.usdcad ** 0.091 * r.usdsek ** 0.042 * r.usdchf ** 0.036;
}

/* ---------------- confluence ---------------- */

export type Stance = 'supports' | 'against' | 'neutral';
export interface Factor { id: string; label: string; stance: Stance; weight: number; detail: string }

export interface ContextInput {
  desk: 'gold' | 'btc';
  side: 'long' | 'short';
  /** DXY 1H trend and 24 h change. */
  dxy?: { dir: -1 | 0 | 1; chg24h: number | null } | null;
  /** US 10Y yield change over 24 h in basis points (or real yield). */
  us10yBp24h?: number | null;
  /** Nasdaq-100 trend (risk appetite). */
  nq?: { dir: -1 | 0 | 1 } | null;
  funding?: number | null;
  oi?: { regime: OiRegime } | null;
  /** Taker buy ÷ sell volume over the last hours. */
  takerRatio?: number | null;
  /** Top-trader long/short account ratio. */
  topLs?: number | null;
  /** COT managed-money net long, z-score vs the last year (gold). */
  cotZ?: number | null;
  /** Rolling correlation of the asset with DXY (sign matters). */
  corrDxy?: number | null;
}

/**
 * Score context for a trade direction: −100 (all against) … +100 (all supporting).
 * Weights reflect how much each read usually matters intraday for that desk.
 */
export function contextScore(c: ContextInput): { score: number; factors: Factor[]; caution: string[] } {
  const want = c.side === 'long' ? 1 : -1;
  const f: Factor[] = [];
  const caution: string[] = [];
  const push = (id: string, label: string, s: number, weight: number, detail: string) =>
    f.push({ id, label, stance: s > 0 ? 'supports' : s < 0 ? 'against' : 'neutral', weight, detail });

  if (c.dxy) {
    // Gold and BTC both lean inverse to the dollar; use the measured correlation when it agrees.
    const inv = c.corrDxy !== null && c.corrDxy !== undefined && c.corrDxy > 0.2 ? 1 : -1;
    const s = c.dxy.dir * inv * want;
    push('dxy', 'US dollar', s, c.desk === 'gold' ? 3 : 2, `DXY ${c.dxy.dir > 0 ? 'rising' : c.dxy.dir < 0 ? 'falling' : 'flat'}${c.dxy.chg24h !== null ? ` · ${c.dxy.chg24h >= 0 ? '+' : ''}${c.dxy.chg24h.toFixed(2)}% 24h` : ''}`);
  }
  if (c.us10yBp24h !== null && c.us10yBp24h !== undefined && c.desk === 'gold') {
    const s = Math.abs(c.us10yBp24h) < 2 ? 0 : (c.us10yBp24h > 0 ? -1 : 1) * want;
    push('yields', 'US yields', s, 2, `10Y ${c.us10yBp24h >= 0 ? '+' : ''}${c.us10yBp24h.toFixed(1)} bp 24h`);
  }
  if (c.nq && c.desk === 'btc') push('nq', 'Risk appetite (NQ)', c.nq.dir * want, 2, `Nasdaq-100 ${c.nq.dir > 0 ? 'up' : c.nq.dir < 0 ? 'down' : 'flat'}trend`);
  if (c.funding !== null && c.funding !== undefined) {
    const st = fundingState(c.funding);
    // Crowding is contrarian: extreme long funding argues against new longs.
    const s = st === 'extreme_long' ? -want : st === 'extreme_short' ? want : st === 'elevated_long' && want > 0 ? -1 : st === 'elevated_short' && want < 0 ? -1 : 0;
    if ((st === 'extreme_long' && want > 0) || (st === 'extreme_short' && want < 0)) caution.push(`funding ${st.replace('_', ' ')} — crowded on your side`);
    push('funding', 'Funding', Math.sign(s), 2, `${(c.funding * 100).toFixed(4)}% / 8h · ${st.replace('_', ' ')}`);
  }
  if (c.oi) {
    const r = c.oi.regime;
    const s = r === 'long_build' ? 1 : r === 'short_build' ? -1 : r === 'short_cover' ? 0.5 : r === 'long_unwind' ? -0.5 : 0;
    push('oi', 'Open interest', Math.sign(s * want), 2, OI_REGIME_TEXT[r]);
  }
  if (c.takerRatio !== null && c.takerRatio !== undefined) {
    const s = c.takerRatio > 1.05 ? 1 : c.takerRatio < 0.95 ? -1 : 0;
    push('taker', 'Aggressor flow', s * want, 1, `taker buy/sell ${c.takerRatio.toFixed(2)}`);
  }
  if (c.topLs !== null && c.topLs !== undefined) {
    const s = c.topLs > 2.5 ? -1 : c.topLs < 0.7 ? 1 : 0;
    if ((s < 0 && want > 0) || (s > 0 && want < 0)) caution.push('top traders heavily positioned on your side');
    push('ls', 'Top trader L/S', s * want, 1, `ratio ${c.topLs.toFixed(2)}`);
  }
  if (c.cotZ !== null && c.cotZ !== undefined && c.desk === 'gold') {
    const s = c.cotZ > 1.5 ? -1 : c.cotZ < -1.5 ? 1 : 0;
    push('cot', 'COT managed money', s * want, 1, `net long z ${c.cotZ.toFixed(2)} (weekly)`);
  }

  const total = f.reduce((a, x) => a + x.weight, 0);
  const got = f.reduce((a, x) => a + (x.stance === 'supports' ? x.weight : x.stance === 'against' ? -x.weight : 0), 0);
  return { score: total ? Math.round((got / total) * 100) : 0, factors: f, caution };
}

/* ---------------- sessions ---------------- */

export interface SessionStat { id: string; name: string; high: number; low: number; open: number; close: number; rangePct: number; sweptPrevHigh: boolean; sweptPrevLow: boolean; live: boolean }

/**
 * Today's Asia → London → New York sessions from intraday candles: range, direction,
 * and whether each session ran the previous session's high or low (the liquidity story).
 */
export function sessionStats(candles: readonly Candle[], windows: readonly { id: string; name: string; startUtc: number; endUtc: number }[], now: number): SessionStat[] {
  const out: SessionStat[] = [];
  let prev: SessionStat | null = null;
  for (const w of windows) {
    const inside = candles.filter((c) => c.t >= w.startUtc && c.t < w.endUtc && c.t <= now);
    if (!inside.length) { prev = null; continue; }
    const high = Math.max(...inside.map((c) => c.h)), low = Math.min(...inside.map((c) => c.l));
    const s: SessionStat = {
      id: w.id, name: w.name, high, low, open: inside[0]!.o, close: inside.at(-1)!.c,
      rangePct: ((high - low) / low) * 100,
      sweptPrevHigh: !!prev && high > prev.high,
      sweptPrevLow: !!prev && low < prev.low,
      live: now >= w.startUtc && now < w.endUtc,
    };
    out.push(s);
    prev = s;
  }
  return out;
}
