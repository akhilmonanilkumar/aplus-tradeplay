import type { BookLevel, BookStats, FlowTrade, FootprintBar } from "@aplus/engine";

/** What /api/market/flow returns, from the engine host or the serverless Delta fallback. */
export interface FlowSnapshot {
  venue: string; symbol: string; at: number; source: string;
  ticker: { t: number; last?: number; mark?: number; index?: number; funding?: number; oi?: number; oiUsd?: number; change24hPct?: number } | null;
  book: { t: number; bids: BookLevel[]; asks: BookLevel[]; stats: BookStats | null } | null;
  footprint: (FootprintBar & { imbalances: { price: number; side: "buy" | "sell" }[] })[];
  cvd: { t: number; delta: number; cvd: number; price: number }[];
  largeTrades: FlowTrade[];
  tradeCount: number;
  oiHistory: { t: number; oi: number; price: number }[];
}
