import { assertFinitePositive, floorToStep, round } from './num.js';

export type Side = 'long' | 'short';

export function sideOf(entry: number, stop: number): Side {
  if (entry === stop) throw new Error('entry and stop must differ');
  return entry > stop ? 'long' : 'short';
}

/** Structural reward-to-risk: |target − entry| ÷ |entry − stop|. */
export function rewardToRisk(entry: number, stop: number, target: number): number {
  const risk = Math.abs(entry - stop);
  if (risk === 0) throw new Error('entry and stop must differ');
  const side = sideOf(entry, stop);
  const reward = side === 'long' ? target - entry : entry - target;
  return reward / risk;
}

/* ---------------- Forex / CFD (e.g. XAUUSD) ---------------- */

export interface CfdSpec {
  /** Minimum price increment, e.g. 0.01 for XAUUSD at most brokers. */
  tickSize: number;
  /** Account-currency value of one tick for 1.00 lot, e.g. $1.00 for 100 oz gold. */
  tickValue: number;
  volumeStep: number;
  minVolume: number;
  maxVolume?: number;
  /** Round-turn commission per 1.00 lot in account currency. */
  commissionPerLot?: number;
}

export interface CfdSizing {
  lots: number;
  rawLots: number;
  riskBudget: number;
  lossPerLot: number;
  /** Money lost at the stop including commission. */
  riskAmount: number;
  belowMinimum: boolean;
}

export function sizeCfd(p: { balance: number; riskPct: number; entry: number; stop: number; spec: CfdSpec }): CfdSizing {
  assertFinitePositive('balance', p.balance);
  assertFinitePositive('riskPct', p.riskPct);
  const dist = Math.abs(p.entry - p.stop);
  assertFinitePositive('stop distance', dist);
  const riskBudget = (p.balance * p.riskPct) / 100;
  const lossPerLot = (dist / p.spec.tickSize) * p.spec.tickValue + (p.spec.commissionPerLot ?? 0);
  const rawLots = riskBudget / lossPerLot;
  let lots = floorToStep(rawLots, p.spec.volumeStep);
  if (p.spec.maxVolume !== undefined) lots = Math.min(lots, p.spec.maxVolume);
  const belowMinimum = lots < p.spec.minVolume;
  if (belowMinimum) lots = 0;
  return { lots, rawLots, riskBudget: round(riskBudget, 2), lossPerLot: round(lossPerLot, 2), riskAmount: round(lots * lossPerLot, 2), belowMinimum };
}

/* ---------------- Linear USDT-margined perpetual ---------------- */

export interface PerpSpec {
  qtyStep: number;
  minQty: number;
  minNotional?: number;
  /** Taker fee as a fraction, e.g. 0.0005 for 0.05%. */
  takerFee: number;
  /** Maintenance margin rate of the notional tier, e.g. 0.004. */
  mmr: number;
  /** Tier maintenance amount ("cum"), 0 for tier 1. */
  maintAmount: number;
}

export interface PerpSizing {
  qty: number;
  rawQty: number;
  side: Side;
  riskBudget: number;
  notional: number;
  margin: number;
  feesToStop: number;
  feesToTarget: number | null;
  /** Fees at entry + exit at stop, in R. */
  feeR: number;
  /** Loss at stop including fees. */
  lossAtStop: number;
  /** Net R if target is hit, after fees. */
  netRAtTarget: number | null;
  liquidationPrice: number;
  liquidationBeyondStop: boolean;
  stopPct: number;
  belowMinimum: boolean;
}

/**
 * Isolated-margin liquidation price for a single one-way position
 * (Binance USDⓈ-M formula): LP = (WB + cum − s·q·E) ÷ (q·MMR − s·q), s = +1 long, −1 short.
 */
export function isolatedLiquidationPrice(p: { walletBalance: number; side: Side; qty: number; entry: number; mmr: number; maintAmount: number }): number {
  const s = p.side === 'long' ? 1 : -1;
  const den = p.qty * p.mmr - s * p.qty;
  if (den === 0) throw new Error('invalid liquidation inputs');
  return (p.walletBalance + p.maintAmount - s * p.qty * p.entry) / den;
}

export function sizePerp(p: { balance: number; riskPct: number; entry: number; stop: number; target?: number; leverage: number; spec: PerpSpec }): PerpSizing {
  assertFinitePositive('balance', p.balance);
  assertFinitePositive('riskPct', p.riskPct);
  assertFinitePositive('leverage', p.leverage);
  const side = sideOf(p.entry, p.stop);
  const dist = Math.abs(p.entry - p.stop);
  const riskBudget = (p.balance * p.riskPct) / 100;
  const rawQty = riskBudget / dist;
  let qty = floorToStep(rawQty, p.spec.qtyStep);
  const notional = qty * p.entry;
  const belowMinimum = qty < p.spec.minQty || (p.spec.minNotional !== undefined && notional < p.spec.minNotional);
  if (belowMinimum) qty = 0;
  const n = qty * p.entry;
  const margin = n / p.leverage;
  const gross = qty * dist;
  const feesToStop = qty * p.entry * p.spec.takerFee + qty * p.stop * p.spec.takerFee;
  let feesToTarget: number | null = null;
  let netRAtTarget: number | null = null;
  if (p.target !== undefined && qty > 0) {
    feesToTarget = qty * p.entry * p.spec.takerFee + qty * p.target * p.spec.takerFee;
    const reward = Math.abs(p.target - p.entry) * qty;
    netRAtTarget = (reward - feesToTarget) / gross;
  }
  const liquidationPrice = qty > 0 ? isolatedLiquidationPrice({ walletBalance: margin, side, qty, entry: p.entry, mmr: p.spec.mmr, maintAmount: p.spec.maintAmount }) : NaN;
  return {
    qty,
    rawQty,
    side,
    riskBudget: round(riskBudget, 2),
    notional: round(n, 2),
    margin: round(margin, 2),
    feesToStop: round(feesToStop, 4),
    feesToTarget: feesToTarget === null ? null : round(feesToTarget, 4),
    feeR: gross > 0 ? feesToStop / gross : 0,
    lossAtStop: round(gross + feesToStop, 2),
    netRAtTarget,
    liquidationPrice,
    liquidationBeyondStop: qty > 0 && (side === 'long' ? liquidationPrice < p.stop : liquidationPrice > p.stop),
    stopPct: (dist / p.entry) * 100,
    belowMinimum,
  };
}

/* ---------------- MCX gold (GOLD 1 kg, GOLDM 100 g; quoted per 10 g) ---------------- */

/** ₹ P&L per ₹1 price move per lot. GOLD = 1000 g / 10 g = 100; GOLDM = 100 g / 10 g = 10. Verify per contract spec. */
export const MCX_MULTIPLIER = { GOLD: 100, GOLDM: 10 } as const;

export function sizeMcx(p: { capital: number; riskPct: number; entry: number; stop: number; multiplier: number; chargesPerLot?: number }) {
  assertFinitePositive('capital', p.capital);
  const dist = Math.abs(p.entry - p.stop);
  assertFinitePositive('stop distance', dist);
  const riskBudget = (p.capital * p.riskPct) / 100;
  const lossPerLot = dist * p.multiplier + (p.chargesPerLot ?? 0);
  const rawLots = riskBudget / lossPerLot;
  const lots = Math.floor(round(rawLots, 9));
  return { lots, rawLots, riskBudget: round(riskBudget, 2), lossPerLot: round(lossPerLot, 2), riskAmount: round(lots * lossPerLot, 2), belowMinimum: lots < 1 };
}
