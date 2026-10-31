import { createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { engineSignature, verifyEngine, verifyRelay } from "./auth.js";
import { MarketHub } from "./market.js";
import { allowed } from "./server.js";
import { coinswitchKey, coinswitchPath, coinswitchPublicHex, coinswitchSign } from "./venues/coinswitch.js";
import { applyBook, deltaSignature, parseDeltaMessage, toMs } from "./venues/delta.js";
import { appIdHash, nseOpen, tokenFresh } from "./venues/fyers.js";

describe("Delta signing", () => {
  it("matches an independent HMAC-SHA256 of METHOD + ts + path + query + body", () => {
    // Expected value computed with Python's hmac module.
    expect(deltaSignature("secret", "POST", "1700000000", "/v2/orders", "?product_id=27", '{"size":1}')).toBe("4adbe854c809c9531bc197e808c829bf2646f35463a6d280f710cfcfd5835249");
  });
});

describe("Delta socket messages", () => {
  it("parses current-format book, trade and ticker messages", () => {
    const b = parseDeltaMessage({ type: "l2_updates", action: "snapshot", symbol: "BTCUSD", bids: [["100", "5"]], asks: [["101", "2"]], sequence_no: 7, timestamp: 1_700_000_000_000_000 });
    expect(b).toMatchObject({ kind: "book", symbol: "BTCUSD", action: "snapshot", seq: 7, t: 1_700_000_000_000, bids: [{ price: 100, size: 5 }] });
    const t = parseDeltaMessage({ type: "all_trades", symbol: "BTCUSD", price: "100.5", size: 3, buyer_role: "taker", timestamp: 1_700_000_000_000_000 });
    expect(t).toEqual({ kind: "trade", symbol: "BTCUSD", trade: { t: 1_700_000_000_000, price: 100.5, size: 3, side: "buy" } });
    expect(parseDeltaMessage({ type: "all_trades", symbol: "X", price: 1, size: 1, buyer_role: "maker", timestamp: 1 })).toMatchObject({ trade: { side: "sell" } });
    const k = parseDeltaMessage({ type: "v2/ticker", symbol: "BTCUSD", mark_price: "100", close: 99, spot_price: "98", funding_rate: "0.01", oi: "1200", timestamp: 1_700_000_000_000_000 });
    expect(k).toMatchObject({ kind: "ticker", mark: 100, last: 99, index: 98, funding: 0.01, oi: 1200 });
  });
  it("parses the migrated short-key formats", () => {
    expect(parseDeltaMessage({ type: "ob_updates", action: "update", sy: "BTCUSD", b: [["100", "0"]], a: [], seq: 8, ts: 1_700_000_000_000 })).toMatchObject({ kind: "book", action: "update", seq: 8, bids: [{ price: 100, size: 0 }] });
    expect(parseDeltaMessage({ type: "trades", sy: "BTCUSD", p: "100", s: 2, r: "t", t: 1_700_000_000_000 })).toMatchObject({ trade: { side: "buy", size: 2 } });
    expect(parseDeltaMessage({ type: "heartbeat" })).toEqual({ kind: "other", type: "heartbeat" });
  });
  it("normalises seconds, ms and µs timestamps", () => {
    expect(toMs(1_700_000_000)).toBe(1_700_000_000_000);
    expect(toMs(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(toMs(1_700_000_000_000_000)).toBe(1_700_000_000_000);
  });
  it("applies book deltas and removes zero-size levels", () => {
    const cur = { bids: [{ price: 100, size: 1 }, { price: 99, size: 2 }], asks: [{ price: 101, size: 1 }] };
    const next = applyBook(cur, { bids: [{ price: 100, size: 0 }, { price: 99.5, size: 4 }], asks: [{ price: 100.5, size: 3 }] });
    expect(next.bids).toEqual([{ price: 99.5, size: 4 }, { price: 99, size: 2 }]);
    expect(next.asks).toEqual([{ price: 100.5, size: 3 }, { price: 101, size: 1 }]);
  });
});

describe("CoinSwitch signing", () => {
  // RFC 8032 Ed25519 test vector 1.
  const seed = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
  it("derives the RFC 8032 public key from the hex seed", () => {
    expect(coinswitchPublicHex(coinswitchKey(seed))).toBe("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
  });
  it("signs METHOD + decoded path + epoch, verifiable with the public key", () => {
    const key = coinswitchKey(seed);
    const path = coinswitchPath("/v5/market/orderbook", { category: "linear", symbol: "BTCUSDT", limit: 50 });
    expect(path).toBe("/v5/market/orderbook?category=linear&symbol=BTCUSDT&limit=50");
    const sig = coinswitchSign(key, "get", path, "1719905777483");
    expect(verify(null, Buffer.from("GET" + path + "1719905777483"), createPublicKey(key), Buffer.from(sig, "hex"))).toBe(true);
  });
  it("rejects a seed of the wrong length", () => {
    expect(() => coinswitchKey("abcd")).toThrow(/32-byte/);
  });
});

describe("engine request auth", () => {
  it("accepts a fresh signature and rejects stale or altered ones", () => {
    const ts = "1700000000000";
    const sig = engineSignature("s3cret", ts, "GET", "/status", "");
    expect(sig).toBe("ddaaa859d325078c1798c3073176e60cacd36e517b50b2beca3d461f30b249d2");
    expect(verifyEngine("s3cret", { ts, sig }, "GET", "/status", "", 1_700_000_010_000)).toBe(true);
    expect(verifyEngine("s3cret", { ts, sig }, "GET", "/status", "", 1_700_000_031_000)).toBe(false);
    expect(verifyEngine("s3cret", { ts, sig }, "GET", "/flow", "", 1_700_000_010_000)).toBe(false);
    expect(verifyEngine("", { ts, sig }, "GET", "/status", "", 1_700_000_010_000)).toBe(false);
  });
  it("keeps the old relay scheme working", () => {
    const ts = "1700000000000", body = '{"method":"GET"}';
    const { createHmac } = require("node:crypto") as typeof import("node:crypto");
    const sig = createHmac("sha256", "k").update(ts + body).digest("hex");
    expect(verifyRelay("k", { ts, sig }, body, 1_700_000_000_500)).toBe(true);
    expect(verifyRelay("k", { ts, sig }, body + " ", 1_700_000_000_500)).toBe(false);
  });
});

describe("trading allowlist", () => {
  it("allows reads, and writes only with execution on", () => {
    expect(allowed("delta", "GET", "/v2/positions/margined", false)).toBe(true);
    expect(allowed("delta", "POST", "/v2/orders", false)).toBe(false);
    expect(allowed("delta", "POST", "/v2/orders", true)).toBe(true);
    expect(allowed("delta", "POST", "/v2/wallet/withdraw", true)).toBe(false);
    expect(allowed("coinswitch", "POST", "/v5/order/create", true)).toBe(true);
    expect(allowed("coinswitch", "POST", "/dma/api/v1/funds/transfer", true)).toBe(false);
    expect(allowed("fyers", "POST", "/api/v3/orders/sync", false)).toBe(false);
  });
});

describe("Fyers session rules", () => {
  it("hashes app id and secret like Fyers expects", () => {
    expect(appIdHash("ABC-100", "XYZ")).toMatch(/^[0-9a-f]{64}$/);
  });
  it("treats a token as valid only on the IST day it was issued", () => {
    const issued = Date.parse("2026-11-02T03:00:00Z"); // 08:30 IST Monday
    expect(tokenFresh({ access_token: "x", saved_at: issued }, Date.parse("2026-11-02T17:00:00Z"))).toBe(true); // 22:30 IST same day
    expect(tokenFresh({ access_token: "x", saved_at: issued }, Date.parse("2026-11-02T19:00:00Z"))).toBe(false); // 00:30 IST next day
    expect(tokenFresh(null)).toBe(false);
  });
  it("knows NSE hours in IST", () => {
    expect(nseOpen(new Date("2026-11-02T04:00:00Z"))).toBe(true); // Mon 09:30 IST
    expect(nseOpen(new Date("2026-11-02T03:40:00Z"))).toBe(false); // Mon 09:10 IST
    expect(nseOpen(new Date("2026-11-02T10:05:00Z"))).toBe(false); // Mon 15:35 IST
    expect(nseOpen(new Date("2026-10-31T05:00:00Z"))).toBe(false); // Saturday
  });
});

describe("MarketHub", () => {
  it("drops overlapping REST trades and builds a snapshot", () => {
    const hub = new MarketHub(3_600_000);
    const now = Date.now();
    const seen: number[] = [];
    hub.onTrades((_v, _s, xs) => seen.push(xs.length));
    hub.addTrades("delta", "BTCUSD", [{ t: now - 2000, price: 100, size: 1, side: "buy" }, { t: now - 1000, price: 101, size: 2, side: "sell" }]);
    hub.addTrades("delta", "BTCUSD", [{ t: now - 1000, price: 101, size: 2, side: "sell" }, { t: now - 500, price: 102, size: 5, side: "buy" }]);
    expect(seen).toEqual([2, 1]);
    hub.setBook("delta", "BTCUSD", { t: now, bids: [{ price: 101.5, size: 3 }], asks: [{ price: 102.5, size: 1 }] });
    const snap = hub.snapshot("delta", "BTCUSD", { bucketMs: 60_000, tick: 1, bars: 5, depthPct: 0.01 })!;
    expect(snap.tradeCount).toBe(3);
    expect(snap.footprint.reduce((s, b) => s + b.delta, 0)).toBe(4); // 1 − 2 + 5, whichever minute bars they fall in
    expect(snap.book!.stats!.imbalance).toBeCloseTo(0.5);
    expect(hub.snapshot("delta", "ETHUSD", { bucketMs: 60_000, tick: 1, bars: 5, depthPct: 0.01 })).toBeNull();
  });
});
