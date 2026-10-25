import { premiumDiscount, type Zone } from './smc.js';
import { EDGE_RULES } from './specs.js';

/** Daily bias in five steps (Trade Finder Pro §4). */
export interface BiasInput {
  /** 1 — HTF range from the latest BOS: swing low (origin) to swing high (pullback start). */
  range: { low: number; high: number };
  price: number;
  htfTrend: 'up' | 'down' | null;
  /** 3 — liquidity pools. Any subset. */
  liquidity: { pdh?: number; pdl?: number; eqh?: number; eql?: number; sessionHigh?: number; sessionLow?: number };
  /** 4 — continuation or pullback phase. */
  narrative: 'continuation' | 'pullback';
  /** 5 — one target and the price that proves the bias wrong. */
  target?: number | null;
  invalidation?: number | null;
}

export interface LiquidityPool { label: string; level: number; side: 'buy_side' | 'sell_side'; distance: number }

export interface BiasResult {
  zone: Zone;
  outside: 'below' | 'above' | null;
  pos: number;
  eq: number;
  allowed: 'long' | 'short' | null;
  /** Nearest pool on the side price is drawn to. */
  magnet: LiquidityPool | null;
  pools: LiquidityPool[];
  valid: boolean;
  issues: string[];
  /** e.g. "My bias is wrong if price closes and holds below 4,096". */
  statement: string | null;
}

const LABELS: Record<keyof BiasInput['liquidity'], string> = { pdh: 'PDH', pdl: 'PDL', eqh: 'EQH', eql: 'EQL', sessionHigh: 'Session high', sessionLow: 'Session low' };
const fmt = (x: number) => x.toLocaleString('en-US', { maximumFractionDigits: 2 });

export function dailyBias(b: BiasInput): BiasResult {
  const pd = premiumDiscount(b.range.low, b.range.high, b.price, EDGE_RULES.midBandPct);
  const issues: string[] = [];

  // 2 — premium / discount sets the allowed direction; mid-range = stand aside.
  let allowed: 'long' | 'short' | null = pd.outside ? null : pd.zone === 'discount' ? 'long' : pd.zone === 'premium' ? 'short' : null;
  if (pd.outside) issues.push(`price ${pd.outside} the HTF range: structure is breaking, stand aside until a new range forms`);
  else if (pd.zone === 'mid') issues.push('mid-range: stand aside');
  if (allowed && b.htfTrend && ((allowed === 'long' && b.htfTrend === 'down') || (allowed === 'short' && b.htfTrend === 'up'))) {
    issues.push(`${allowed} would be counter-trend`);
    allowed = null;
  }

  // 3 — liquidity pools and the magnet.
  const pools: LiquidityPool[] = [];
  for (const [k, v] of Object.entries(b.liquidity) as [keyof BiasInput['liquidity'], number | undefined][]) {
    if (v === undefined || !Number.isFinite(v)) continue;
    pools.push({ label: LABELS[k], level: v, side: v > b.price ? 'buy_side' : 'sell_side', distance: Math.abs(v - b.price) });
  }
  pools.sort((x, y) => x.distance - y.distance);
  // Longs want sell-side taken first (sweep) then draw to buy-side; the magnet is where the target liquidity rests.
  const drawSide = allowed === 'long' ? 'buy_side' : allowed === 'short' ? 'sell_side' : null;
  const magnet = drawSide ? pools.find((p) => p.side === drawSide) ?? null : pools[0] ?? null;

  // 5 — target and invalidation.
  if (b.invalidation === null || b.invalidation === undefined) issues.push('no invalidation: a bias needs a price that proves it wrong');
  else if (allowed === 'long' && b.invalidation >= b.price) issues.push('invalidation must be below price for a long bias');
  else if (allowed === 'short' && b.invalidation <= b.price) issues.push('invalidation must be above price for a short bias');
  if (b.target !== null && b.target !== undefined && allowed) {
    if ((allowed === 'long' && b.target <= b.price) || (allowed === 'short' && b.target >= b.price)) issues.push('target is on the wrong side');
  }
  if (b.narrative === 'pullback' && allowed) issues.push('pullback phase: wait for the extreme zone, then a shift');

  const statement = b.invalidation !== null && b.invalidation !== undefined && allowed
    ? `My bias is wrong if price closes and holds ${allowed === 'long' ? 'below' : 'above'} ${fmt(b.invalidation)}`
    : null;
  const hard = issues.filter((i) => !i.startsWith('pullback phase'));
  return { zone: pd.zone, outside: pd.outside, pos: pd.pos, eq: pd.eq, allowed, magnet, pools, valid: allowed !== null && hard.length === 0, issues, statement };
}
