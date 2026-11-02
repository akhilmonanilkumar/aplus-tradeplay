import type { OrderPlan, ProductSpec } from "@/lib/liveRisk";

/**
 * CoinSwitch and Fyers execution, the pure half: what each venue trades for a market, and the exact
 * order payloads. The risk gate (liveRisk.planLiveOrder) sizes in whole "contracts": for CoinSwitch a
 * contract is one quantity step, for Fyers one lot.
 */

export type ExecVenue = "coinswitch" | "fyers";
export type VenueMode = "off" | "shadow" | "live";

export interface VenueProduct extends ProductSpec { venue: ExecVenue; currency: "USD" | "INR"; unitLabel: string; verified: boolean; note?: string }

/** CoinSwitch HFT linear futures. Steps and fees are conservative until the instruments-info call confirms them. */
const CS: Record<string, Omit<VenueProduct, "venue" | "currency" | "productId">> = {
  "BTCUSDT.P": { symbol: "BTCUSDT", contractValue: 0.001, tick: 0.1, takerFee: 0.0005, unitLabel: "BTC", verified: false, note: "qty step and tick from instruments-info before the first live order" },
  "BTCUSD.SPOT": { symbol: "BTCUSDT", contractValue: 0.001, tick: 0.1, takerFee: 0.0005, unitLabel: "BTC", verified: false },
};

/** NSE monthly index futures expire on the last Tuesday of the month (from September 2025). */
export function lastTuesday(year: number, month0: number): Date {
  const d = new Date(Date.UTC(year, month0 + 1, 0));
  while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() - 1);
  return d;
}

const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/**
 * The near-month Nifty future, rolling to the next month from expiry day (positions are intraday).
 * Format NSE:NIFTY{YY}{MON}FUT; the engine host checks it against the daily symbol master before sending.
 */
export function niftyFuture(now = new Date()): { symbol: string; expiry: string } {
  const ist = new Date(now.getTime() + 5.5 * 3_600_000);
  let y = ist.getUTCFullYear(), m = ist.getUTCMonth();
  const exp = lastTuesday(y, m);
  if (ist.toISOString().slice(0, 10) >= exp.toISOString().slice(0, 10)) { m += 1; if (m > 11) { m = 0; y += 1; } }
  return { symbol: `NSE:NIFTY${String(y).slice(2)}${MON[m]}FUT`, expiry: lastTuesday(y, m).toISOString().slice(0, 10) };
}

export function venueProduct(venue: ExecVenue, instrument: string, now = new Date(), lotSize = 75): VenueProduct | null {
  if (venue === "coinswitch") {
    const c = CS[instrument];
    return c ? { ...c, venue, currency: "USD", productId: 0 } : null;
  }
  if (instrument !== "NIFTY") return null;
  // Index futures trade at a premium to spot; levels shift by the basis like on Delta.
  return { venue, currency: "INR", productId: 0, symbol: niftyFuture(now).symbol, contractValue: lotSize, tick: 0.1, takerFee: 0.0002, unitLabel: "lot", verified: false, note: "lot size from the symbol master on send" };
}

/** CoinSwitch HFT /v5/order/create body (Bybit-v5 style): limit entry with attached stop and target. */
export function coinswitchOrder(p: OrderPlan, product: VenueProduct, clientId: string) {
  const qty = Number((p.contracts * product.contractValue).toFixed(6));
  return {
    method: "POST" as const, path: "/v5/order/create",
    body: {
      category: "linear", symbol: product.symbol, side: p.side === "buy" ? "Buy" : "Sell", orderType: "Limit",
      qty: String(qty), price: String(p.limitPrice), positionIdx: 0, timeInForce: "GTC", orderLinkId: clientId,
      stopLoss: String(p.stop), takeProfit: String(p.target),
    },
  };
}

/**
 * Fyers /api/v3/orders/sync: an intraday limit entry, then a stop-loss-market exit and a limit target
 * once filled (Fyers' bracket product does not cover index futures for API orders).
 */
export function fyersOrders(p: OrderPlan, product: VenueProduct, tag: string) {
  const qty = p.contracts * product.contractValue;
  const side = p.side === "buy" ? 1 : -1;
  const base = { symbol: product.symbol, qty, productType: "INTRADAY", validity: "DAY", disclosedQty: 0, offlineOrder: false, stopLoss: 0, takeProfit: 0, orderTag: tag.replace(/[^A-Za-z0-9]/g, "").slice(0, 20) };
  return {
    entry: { method: "POST" as const, path: "/api/v3/orders/sync", body: { ...base, type: 1, side, limitPrice: p.limitPrice, stopPrice: 0 } },
    stop: { method: "POST" as const, path: "/api/v3/orders/sync", body: { ...base, type: 3, side: -side, limitPrice: 0, stopPrice: p.stop } },
    target: { method: "POST" as const, path: "/api/v3/orders/sync", body: { ...base, type: 1, side: -side, limitPrice: p.target, stopPrice: 0 } },
  };
}
