import type { CfdSpec, PerpSpec } from './sizing.js';
import { BTCUSDT_PERP_DEFAULT, XAUUSD_DEFAULT } from './specs.js';

/**
 * Instruments by desk. Gold and BTC have full desks (live context, macro, derivatives, selector);
 * the forex and index desks (EURUSD, USDJPY, NAS100, SPX500, NIFTY) are research desks:
 * lab, backtests and the paper autopilot, without desk pages or the selector.
 */
export type DeskId = 'gold' | 'btc' | 'fx' | 'indices';
/** Desks with macro and derivatives context (desk pages, selector). */
export type LiveDeskId = Extract<DeskId, 'gold' | 'btc'>;
/** The context desk of an instrument on the selector board (research instruments never reach it). */
export const liveDesk = (id: InstrumentId): LiveDeskId => {
  const d = INSTRUMENTS[id].desk;
  if (d !== 'gold' && d !== 'btc') throw new Error(`${id} is a research instrument`);
  return d;
};
export type InstrumentId = 'XAUUSD' | 'XAUUSDT.P' | 'BTCUSD' | 'BTCUSDT.P' | 'BTCUSD.SPOT' | 'EURUSD' | 'USDJPY' | 'NAS100' | 'SPX500' | 'NIFTY';
export type Tf = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

export const TF_MS: Record<Tf, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };

export interface SpotSpec { qtyStep: number; minQty: number; minNotional?: number; takerFee: number }

export type SizingModel =
  | { kind: 'cfd'; spec: CfdSpec; unit: string }
  | { kind: 'perp'; spec: PerpSpec; leverage: number; unit: string }
  | { kind: 'spot'; spec: SpotSpec; unit: string };

export interface InstrumentDef {
  id: InstrumentId;
  desk: DeskId;
  label: string;
  short: string;
  kind: 'cfd' | 'perp' | 'spot';
  htf: Tf;
  poi: Tf;
  ltf: Tf;
  /** Price decimals shown in the UI. */
  digits: number;
  /** Spread / noise buffer added beyond the sweep wick. */
  stopBuffer: (price: number) => number;
  /** Minimum stop distance in % of price (fees would eat the 3R otherwise). */
  minStopPct?: number;
  /** Round-trip trading cost as a fraction of notional (fees + typical spread), used to express costs in R. */
  costRate: number;
  sizing: SizingModel;
  /** Closed Friday 17:00 → Sunday 17:00 New York. */
  fxHours: boolean;
  /** What the engine's candles represent. */
  priceBasis: string;
  /** Trade windows (session ids). Default: London Q and NY Q. */
  windows?: string[];
  /** Research desk: lab and paper autopilot only, no desk page, macro context or selector. */
  research?: boolean;
}

const BTC_CFD: CfdSpec = { tickSize: 0.01, tickValue: 0.01, volumeStep: 0.01, minVolume: 0.01 };
/** Binance USDⓈ-M XAUUSDT: 1 contract = 1 oz. Verify against exchangeInfo before live. */
const XAU_PERP: PerpSpec = { qtyStep: 0.001, minQty: 0.001, minNotional: 5, takerFee: 0.0005, mmr: 0.01, maintAmount: 0 };
/** Standard lot 100,000 units; JPY tick value moves with the rate (≈ $0.67 at 150). Verify against the broker. */
const EURUSD_CFD: CfdSpec = { tickSize: 0.00001, tickValue: 1, volumeStep: 0.01, minVolume: 0.01 };
const USDJPY_CFD: CfdSpec = { tickSize: 0.001, tickValue: 0.67, volumeStep: 0.01, minVolume: 0.01 };
/** Index CFD, 1 lot = 1 unit of account currency per point. */
const INDEX_CFD: CfdSpec = { tickSize: 0.01, tickValue: 0.01, volumeStep: 0.01, minVolume: 0.01 };
const BTC_SPOT: SpotSpec = { qtyStep: 0.00001, minQty: 0.00001, minNotional: 5, takerFee: 0.001 };

export const INSTRUMENTS: Record<InstrumentId, InstrumentDef> = {
  XAUUSD: {
    id: 'XAUUSD', desk: 'gold', label: 'XAUUSD · CFD', short: 'XAUUSD', kind: 'cfd',
    htf: '1h', poi: '15m', ltf: '5m', digits: 2,
    stopBuffer: () => 0.3, costRate: 0.00008,
    sizing: { kind: 'cfd', spec: XAUUSD_DEFAULT, unit: 'lot' },
    fxHours: true, priceBasis: 'Spot gold mid (bid/ask average)',
  },
  'XAUUSDT.P': {
    id: 'XAUUSDT.P', desk: 'gold', label: 'XAUUSDT.P · perp', short: 'XAUUSDT.P', kind: 'perp',
    htf: '1h', poi: '15m', ltf: '5m', digits: 2,
    stopBuffer: (p) => p * 0.0001, costRate: 0.001,
    sizing: { kind: 'perp', spec: XAU_PERP, leverage: 10, unit: 'oz' },
    fxHours: false, priceBasis: 'Binance USDⓈ-M mark price',
  },
  BTCUSD: {
    id: 'BTCUSD', desk: 'btc', label: 'BTCUSD · CFD', short: 'BTCUSD', kind: 'cfd',
    htf: '4h', poi: '15m', ltf: '5m', digits: 2,
    stopBuffer: (p) => p * 0.0005, costRate: 0.0006,
    sizing: { kind: 'cfd', spec: BTC_CFD, unit: 'lot' },
    fxHours: false, priceBasis: 'USD spot reference (broker CFD tracks it)',
  },
  'BTCUSDT.P': {
    id: 'BTCUSDT.P', desk: 'btc', label: 'BTCUSDT.P · perp', short: 'BTCUSDT.P', kind: 'perp',
    htf: '4h', poi: '15m', ltf: '5m', digits: 1,
    stopBuffer: (p) => p * 0.0005, costRate: 0.001,
    sizing: { kind: 'perp', spec: BTCUSDT_PERP_DEFAULT, leverage: 10, unit: 'BTC' },
    fxHours: false, priceBasis: 'Binance USDⓈ-M mark price (stops trigger on mark)',
  },
  'BTCUSD.SPOT': {
    id: 'BTCUSD.SPOT', desk: 'btc', label: 'BTCUSD · spot', short: 'BTC spot', kind: 'spot',
    htf: '4h', poi: '15m', ltf: '5m', digits: 2,
    stopBuffer: (p) => p * 0.0005, costRate: 0.002,
    sizing: { kind: 'spot', spec: BTC_SPOT, unit: 'BTC' },
    fxHours: false, priceBasis: 'Coinbase BTC-USD last trade',
  },
  EURUSD: {
    id: 'EURUSD', desk: 'fx', label: 'EURUSD · CFD', short: 'EURUSD', kind: 'cfd',
    htf: '1h', poi: '15m', ltf: '5m', digits: 5,
    stopBuffer: (p) => p * 0.00005, costRate: 0.00007,
    sizing: { kind: 'cfd', spec: EURUSD_CFD, unit: 'lot' },
    fxHours: true, priceBasis: 'EUR/USD mid', research: true,
  },
  USDJPY: {
    id: 'USDJPY', desk: 'fx', label: 'USDJPY · CFD', short: 'USDJPY', kind: 'cfd',
    htf: '1h', poi: '15m', ltf: '5m', digits: 3,
    stopBuffer: (p) => p * 0.00005, costRate: 0.00007,
    sizing: { kind: 'cfd', spec: USDJPY_CFD, unit: 'lot' },
    fxHours: true, priceBasis: 'USD/JPY mid', research: true,
  },
  NAS100: {
    id: 'NAS100', desk: 'indices', label: 'NAS100 · CFD', short: 'NAS100', kind: 'cfd',
    htf: '1h', poi: '15m', ltf: '5m', digits: 2,
    stopBuffer: (p) => p * 0.0001, costRate: 0.0001,
    sizing: { kind: 'cfd', spec: INDEX_CFD, unit: 'lot' },
    fxHours: true, priceBasis: 'Nasdaq-100 (QQQ tracker; R results carry over, points do not)', research: true,
  },
  SPX500: {
    id: 'SPX500', desk: 'indices', label: 'SPX500 · CFD', short: 'SPX500', kind: 'cfd',
    htf: '1h', poi: '15m', ltf: '5m', digits: 2,
    stopBuffer: (p) => p * 0.0001, costRate: 0.0001,
    sizing: { kind: 'cfd', spec: INDEX_CFD, unit: 'lot' },
    fxHours: true, priceBasis: 'S&P 500 (SPY tracker; R results carry over, points do not)', research: true,
  },
  NIFTY: {
    // NSE cash session 09:15–15:30 IST; costs as Nifty futures (STT, exchange fees, half-point slippage).
    id: 'NIFTY', desk: 'indices', label: 'NIFTY 50 · futures', short: 'NIFTY', kind: 'cfd',
    htf: '1h', poi: '15m', ltf: '5m', digits: 2,
    stopBuffer: (p) => p * 0.00005, costRate: 0.0004,
    sizing: { kind: 'cfd', spec: INDEX_CFD, unit: 'lot' },
    fxHours: true, priceBasis: 'NSE Nifty 50 index', windows: ['india_q'], research: true,
  },
};

/** Trade windows of an instrument. */
export const tradeWindows = (id: InstrumentId): string[] => INSTRUMENTS[id].windows ?? ['london_q', 'ny_q'];

export const INSTRUMENT_IDS = Object.keys(INSTRUMENTS) as InstrumentId[];

export const DESKS: Record<DeskId, { id: DeskId; name: string; instruments: InstrumentId[]; primary: InstrumentId }> = {
  gold: { id: 'gold', name: 'Gold desk', instruments: ['XAUUSD', 'XAUUSDT.P'], primary: 'XAUUSD' },
  btc: { id: 'btc', name: 'BTC desk', instruments: ['BTCUSDT.P', 'BTCUSD', 'BTCUSD.SPOT'], primary: 'BTCUSDT.P' },
  fx: { id: 'fx', name: 'Forex lab', instruments: ['EURUSD', 'USDJPY'], primary: 'EURUSD' },
  indices: { id: 'indices', name: 'Index lab', instruments: ['NAS100', 'SPX500', 'NIFTY'], primary: 'NAS100' },
};

/** Instruments with a full desk (desk pages, macro context, selector board). */
export const LIVE_INSTRUMENT_IDS = (Object.keys(INSTRUMENTS) as InstrumentId[]).filter((id) => !INSTRUMENTS[id].research);

export function instrument(id: string): InstrumentDef {
  const d = INSTRUMENTS[id as InstrumentId];
  if (!d) throw new Error(`unknown instrument ${id}`);
  return d;
}

export function isInstrument(id: string): id is InstrumentId {
  return id in INSTRUMENTS;
}

/** Legacy ids from v2 rows. */
export function normalizeInstrument(id: string): InstrumentId | null {
  if (isInstrument(id)) return id;
  const u = id.toUpperCase().replace(/^[A-Z]+:/, '');
  if (u === 'BTCUSDT' || u === 'BTCUSDT.P' || u === 'BTCUSDTPERP') return 'BTCUSDT.P';
  if (u === 'XAUUSDT' || u === 'XAUUSDT.P') return 'XAUUSDT.P';
  if (u === 'XAUUSD' || u === 'GOLD') return 'XAUUSD';
  if (u === 'BTCUSD') return 'BTCUSD';
  return null;
}

/** Round-trip cost in R for a given stop distance: costRate × entry ÷ |entry − stop|. */
export function costInR(def: Pick<InstrumentDef, 'costRate'>, entry: number, stop: number): number {
  const d = Math.abs(entry - stop);
  return d > 0 ? (def.costRate * entry) / d : 0;
}

/**
 * Size a position on any of the five instruments. Returns size in the
 * instrument's unit and the money lost at the stop (fees included where known).
 */
export function sizePosition(def: InstrumentDef, p: { balance: number; riskPct: number; entry: number; stop: number }): { size: number; riskAmount: number; notional: number; belowMinimum: boolean; unit: string } {
  const budget = (p.balance * p.riskPct) / 100;
  const dist = Math.abs(p.entry - p.stop);
  if (!(budget > 0) || !(dist > 0)) return { size: 0, riskAmount: 0, notional: 0, belowMinimum: true, unit: def.sizing.unit };
  const floor = (x: number, step: number) => Math.floor(x / step + 1e-9) * step;
  const dec = (step: number) => Math.max(0, Math.round(-Math.log10(step)));
  const fix = (x: number, step: number) => Number(x.toFixed(dec(step)));
  const s = def.sizing;
  if (s.kind === 'cfd') {
    const lossPerLot = (dist / s.spec.tickSize) * s.spec.tickValue + (s.spec.commissionPerLot ?? 0);
    const lots = fix(floor(budget / lossPerLot, s.spec.volumeStep), s.spec.volumeStep);
    const below = lots < s.spec.minVolume;
    const size = below ? 0 : lots;
    const contract = s.spec.tickValue / s.spec.tickSize;
    return { size, riskAmount: size * lossPerLot, notional: size * contract * p.entry, belowMinimum: below, unit: s.unit };
  }
  const fee = s.spec.takerFee;
  const lossPerUnit = dist + p.entry * fee + p.stop * fee;
  const raw = budget / lossPerUnit;
  const qty = fix(floor(raw, s.spec.qtyStep), s.spec.qtyStep);
  const below = qty < s.spec.minQty || (s.spec.minNotional !== undefined && qty * p.entry < s.spec.minNotional);
  const size = below ? 0 : qty;
  return { size, riskAmount: size * lossPerUnit, notional: size * p.entry, belowMinimum: below, unit: s.unit };
}

/** Money per 1.0 price move per 1.0 of size (P&L multiplier). */
export function pnlMultiplier(id: string): number {
  const d = INSTRUMENTS[id as InstrumentId];
  if (!d) return id === 'XAUUSD' ? 100 : 1;
  if (d.sizing.kind === 'cfd') return d.sizing.spec.tickValue / d.sizing.spec.tickSize;
  return 1;
}
