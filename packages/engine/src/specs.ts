import type { CfdSpec, PerpSpec } from './sizing.js';

/**
 * Default instrument specs. Brokers and exchanges differ and change these values:
 * the live system must read them from the venue (symbol spec / exchangeInfo) and
 * only fall back to these defaults in paper mode.
 */
export const XAUUSD_DEFAULT: CfdSpec = { tickSize: 0.01, tickValue: 1, volumeStep: 0.01, minVolume: 0.01 };

/** Binance USDⓈ-M BTCUSDT, notional tier 1 (verify against /fapi/v1/exchangeInfo and leverageBracket). */
export const BTCUSDT_PERP_DEFAULT: PerpSpec = { qtyStep: 0.001, minQty: 0.001, minNotional: 100, takerFee: 0.0005, mmr: 0.004, maintAmount: 0 };

export const EDGE_RULES = {
  minRR: 3,
  btcMinStopPct: 0.4,
  newsBlockMinutes: 15,
  maxAPlusTradesPerDay: 2,
  stopAfterLosses: 2,
  setAndForgetFirstN: 30,
  midBandPct: 5,
} as const;
