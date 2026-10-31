import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, planLiveOrder } from "@/lib/liveRisk";
import { coinswitchOrder, fyersOrders, lastTuesday, niftyFuture, venueProduct } from "@/lib/venueExec";

const base = (product: NonNullable<ReturnType<typeof venueProduct>>, equity: number, sig: { side: "long" | "short"; entry: number; stop: number; target: number }, price: number) => planLiveOrder({
  policy: DEFAULT_POLICY, now: 1_000_000, equity, startOfDayEquity: equity, peakEquity: equity, todayPnl: 0, todayLosses: 0, todayTrades: 0, open: [],
  killSwitch: false, haltedUntil: null, newsBlocked: false, signal: { createdAt: 1_000_000, ...sig }, ourPrice: price, venueMid: price, product,
});

describe("venue execution plans", () => {
  it("finds the last Tuesday and rolls the Nifty future on expiry day", () => {
    expect(lastTuesday(2026, 10).toISOString().slice(0, 10)).toBe("2026-11-24");
    expect(niftyFuture(new Date("2026-11-10T05:00:00Z"))).toEqual({ symbol: "NSE:NIFTY26NOVFUT", expiry: "2026-11-24" });
    expect(niftyFuture(new Date("2026-11-24T05:00:00Z")).symbol).toBe("NSE:NIFTY26DECFUT");
    expect(niftyFuture(new Date("2026-12-30T05:00:00Z")).symbol).toBe("NSE:NIFTY27JANFUT");
  });
  it("maps only the markets each venue trades", () => {
    expect(venueProduct("coinswitch", "BTCUSDT.P")?.symbol).toBe("BTCUSDT");
    expect(venueProduct("coinswitch", "XAUUSDT.P")).toBeNull();
    expect(venueProduct("fyers", "NIFTY", new Date("2026-11-10T05:00:00Z"))?.contractValue).toBe(75);
    expect(venueProduct("fyers", "BTCUSDT.P")).toBeNull();
  });
  it("sizes CoinSwitch in quantity steps and builds the order with stop and target", () => {
    const product = venueProduct("coinswitch", "BTCUSDT.P")!;
    const r = base(product, 1000, { side: "long", entry: 100_000, stop: 99_500, target: 101_500 }, 100_000);
    expect(r.ok).toBe(true);
    // 0.5% of 1,000 = $5; one 0.001 BTC step loses $0.50 at the stop + $0.10 fees = $0.60 → 8 steps
    expect(r.plan!.contracts).toBe(8);
    const o = coinswitchOrder(r.plan!, product, "sig123");
    expect(o.body).toEqual({ category: "linear", symbol: "BTCUSDT", side: "Buy", orderType: "Limit", qty: "0.008", price: "100000", positionIdx: 0, timeInForce: "GTC", orderLinkId: "sig123", stopLoss: "99500", takeProfit: "101500" });
  });
  it("sizes Fyers in lots and builds entry, stop and target orders", () => {
    const product = venueProduct("fyers", "NIFTY", new Date("2026-11-10T05:00:00Z"))!;
    const r = base(product, 1_000_000, { side: "short", entry: 25_800, stop: 25_850, target: 25_650 }, 25_800);
    expect(r.ok).toBe(true);
    // ₹5,000 risk; per lot 50 × 75 + fees ≈ ₹4,524 → 1 lot
    expect(r.plan!.contracts).toBe(1);
    const o = fyersOrders(r.plan!, product, "APLUS-abc-1");
    expect(o.entry.body).toMatchObject({ symbol: "NSE:NIFTY26NOVFUT", qty: 75, type: 1, side: -1, limitPrice: 25_800, productType: "INTRADAY", orderTag: "APLUSabc1" });
    expect(o.stop.body).toMatchObject({ type: 3, side: 1, stopPrice: 25_850 });
    expect(o.target.body).toMatchObject({ type: 1, side: 1, limitPrice: 25_650 });
  });
});
