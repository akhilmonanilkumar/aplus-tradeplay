import { describe, expect, it } from "vitest";
import { alertRef, fromCTraderSymbol, tradeRow } from "@/lib/server/ctraderSync";

describe("cTrader sync", () => {
  it("maps broker symbols back to our markets", () => {
    expect(fromCTraderSymbol("XAUUSD.")).toBe("XAUUSD");
    expect(fromCTraderSymbol("US500")).toBe("SPX500");
    expect(fromCTraderSymbol("USTEC")).toBe("NAS100");
    expect(fromCTraderSymbol("EURUSD")).toBe("EURUSD");
  });
  it("reads the alert reference from the order comment", () => {
    expect(alertRef("APLUS 1a2b3c4d FundedHive")).toBe("1a2b3c4d");
    expect(alertRef("manual")).toBeNull();
  });
  it("imports a closed trade once, with realised R from the stop seen while open", () => {
    const row = tradeRow("acc1", { dealId: 9, positionId: 7, symbol: "XAUUSD", side: "short", units: 0.5, entry: 4000, exit: 3970, sl: 4010, pnl: 1490, fees: 10, openedAt: 1_000, closedAt: 2_000, balanceAfter: null, comment: null }, { signal_id: "s1", model: "A" });
    expect(row).toMatchObject({ external_id: "ct:9", source: "ctrader", instrument: "XAUUSD", side: "short", qty: 0.5, stop: 4010, realized_r: 3, pnl: 1490, signal_id: "s1", model: "A", review: null });
  });
});
