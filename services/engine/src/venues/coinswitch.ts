import { createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";
import { CLOCK_BUDGET_MS, config } from "../config.js";
import { timedFetch } from "../http.js";
import type { MarketHub } from "../market.js";
import { HOST_TF_MS, type HostCandle, type HostQuote, type HostTf } from "../candles.js";
import { VenueBase } from "./types.js";

/**
 * CoinSwitch PRO HFT API (https://dma.coinswitch.co, Bybit-v5-style paths). Every request, public or not,
 * is signed: Ed25519 over METHOD + decoded path-with-query + epoch-ms, hex, in X-AUTH-* headers.
 * The body is not part of the signed message (as in CoinSwitch's reference client).
 */
export const CS_BASE = "https://dma.coinswitch.co";
/** CoinSwitch PRO futures REST (same keys and signing): used for klines. */
export const CS_PRO = "https://coinswitch.co";
const CS_INTERVAL: Record<HostTf, string> = { "1m": "1", "5m": "5", "15m": "15", "1h": "60", "4h": "240", "1d": "1440" };

/** PKCS#8 DER prefix for a raw 32-byte Ed25519 seed. */
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export function coinswitchKey(secretHex: string): KeyObject {
  const seed = Buffer.from(secretHex, "hex");
  if (seed.length !== 32) throw new Error("CoinSwitch secret must be a 32-byte hex Ed25519 seed");
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
}

/** The API key CoinSwitch shows is the raw public key in hex; useful to check a pasted pair matches. */
export function coinswitchPublicHex(key: KeyObject): string {
  const der = createPublicKey(key).export({ format: "der", type: "spki" });
  return Buffer.from(der).subarray(-32).toString("hex");
}

/** path + sorted-as-given query, URL-decoded, exactly as the reference client signs it. */
export function coinswitchPath(path: string, params: Record<string, string | number> = {}) {
  const q = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
  const full = q ? `${path}${path.includes("?") ? "&" : "?"}${q}` : path;
  return decodeURIComponent(full.replace(/\+/g, " "));
}

export function coinswitchSign(key: KeyObject, method: string, decodedPath: string, epochMs: string) {
  return sign(null, Buffer.from(method.toUpperCase() + decodedPath + epochMs, "utf8"), key).toString("hex");
}

interface Envelope<T> { retCode: number; retMsg: string; result: T; time?: number }

export class CoinSwitchVenue extends VenueBase {
  readonly id = "coinswitch";
  readonly name = "CoinSwitch PRO";
  readonly budgetMs = CLOCK_BUDGET_MS.coinswitch;
  private key: KeyObject | null = null;

  constructor(private readonly hub: MarketHub) {
    super();
    if (config.coinswitch.secretHex) {
      try { this.key = coinswitchKey(config.coinswitch.secretHex); } catch (e) { this.stream.error = (e as Error).message; }
    }
  }

  private get ready() { return !!(this.key && config.coinswitch.apiKey); }

  start() {
    if (!this.ready) { this.stream.state = "off"; return; }
    this.every(30_000, () => this.syncClock());
    this.every(2_000, () => this.poll());
  }

  async request<T>(method: string, path: string, params: Record<string, string | number> = {}, body: unknown = null): Promise<{ env: Envelope<T>; sentAt: number; receivedAt: number }> {
    if (!this.key || !config.coinswitch.apiKey) throw new Error("CoinSwitch keys are not set on the engine host");
    const decoded = coinswitchPath(path, params);
    const epoch = String(Math.round(this.clock.now()));
    const r = await timedFetch<Envelope<T>>(`${CS_BASE}${decoded}`, {
      method, body: body === null ? undefined : JSON.stringify(body),
      headers: { "content-type": "application/json", "X-AUTH-APIKEY": config.coinswitch.apiKey, "X-AUTH-SIGNATURE": coinswitchSign(this.key, method, decoded, epoch), "X-AUTH-EPOCH": epoch },
    }, 5_000);
    if (!r.ok || !r.body || r.body.retCode !== 0) throw new Error(`coinswitch ${method} ${path}: ${r.body?.retMsg ?? `HTTP ${r.status}`}`);
    return { env: r.body, sentAt: r.sentAt, receivedAt: r.receivedAt };
  }

  /** Signed GET on the PRO futures API (plain `{ data }` responses, no retCode envelope). */
  private async pro<T>(path: string, params: Record<string, string | number>): Promise<T> {
    if (!this.key || !config.coinswitch.apiKey) throw new Error("CoinSwitch keys are not set on the engine host");
    const decoded = coinswitchPath(path, params);
    const epoch = String(Math.round(this.clock.now()));
    const r = await timedFetch<T & { message?: string }>(`${CS_PRO}${decoded}`, {
      headers: { "content-type": "application/json", "X-AUTH-APIKEY": config.coinswitch.apiKey, "X-AUTH-SIGNATURE": coinswitchSign(this.key, "GET", decoded, epoch), "X-AUTH-EPOCH": epoch },
    }, 10_000);
    if (!r.ok) throw new Error(`coinswitch GET ${path}: ${(r.body as { message?: string } | null)?.message ?? `HTTP ${r.status}`}`);
    return r.body;
  }

  /** CoinSwitch's own futures candles (KLines), oldest first. */
  async candles(symbol: string, tf: HostTf, limit: number, endTime = Date.now()): Promise<HostCandle[]> {
    const ms = HOST_TF_MS[tf];
    const n = Math.min(Math.max(limit, 1), 1000);
    const j = await this.pro<{ data?: { o: string; h: string; l: string; c: string; volume: string; start_time: string }[] }>("/trade/api/v2/futures/klines", {
      symbol: symbol.toLowerCase(), exchange: "EXCHANGE_2", interval: CS_INTERVAL[tf], start_time: String(endTime - n * ms), end_time: String(endTime), limit: n,
    });
    return (j.data ?? []).map((x) => ({ t: Number(x.start_time), o: Number(x.o), h: Number(x.h), l: Number(x.l), c: Number(x.c), v: Number(x.volume) }))
      .filter((x) => Number.isFinite(x.t) && x.c > 0).sort((a, b) => a.t - b.t);
  }

  /** Latest price from the polled ticker and book, or a direct ticker read for symbols not polled. */
  async quote(symbol: string): Promise<HostQuote> {
    const tk = this.hub.ticker("coinswitch", symbol), book = this.hub.book("coinswitch", symbol);
    if (tk && Date.now() - tk.t < 15_000 && (tk.last ?? tk.mark)) {
      return { last: (tk.last ?? tk.mark)!, bid: book?.bids[0]?.price ?? null, ask: book?.asks[0]?.price ?? null, ts: tk.t, source: "CoinSwitch PRO" };
    }
    // HFT ticker first; the regular futures ticker works even before the HFT account is funded.
    try {
      const r = await this.request<{ list: Record<string, string>[] }>("GET", "/v5/market/tickers", { category: "linear", symbol });
      const t = r.env.result.list?.[0];
      if (t && Number(t.lastPrice) > 0) return { last: Number(t.lastPrice), bid: Number(t.bid1Price) || null, ask: Number(t.ask1Price) || null, ts: Date.now(), source: "CoinSwitch PRO" };
    } catch { /* fall through to the futures ticker */ }
    const j = await this.pro<{ data?: Record<string, { last_price?: string; best_bid_price?: string; best_ask_price?: string; timestamp?: number }> }>("/trade/api/v2/futures/ticker", { symbol: symbol.toLowerCase(), exchange: "EXCHANGE_2" });
    const t = j.data?.EXCHANGE_2 ?? Object.values(j.data ?? {})[0];
    if (!t || !(Number(t.last_price) > 0)) throw new Error(`CoinSwitch has no ticker for ${symbol}`);
    return { last: Number(t.last_price), bid: Number(t.best_bid_price) || null, ask: Number(t.best_ask_price) || null, ts: Number(t.timestamp) || Date.now(), source: "CoinSwitch PRO" };
  }

  /** The envelope's `time` (ms) is the server clock. */
  async syncClock() {
    const r = await this.request<{ timeSecond?: string }>("GET", "/v5/market/time");
    const server = r.env.time ?? (r.env.result?.timeSecond ? Number(r.env.result.timeSecond) * 1000 : null);
    if (server) this.clock.add(r.sentAt, r.receivedAt, server);
  }

  private async poll() {
    this.stream.state = "polling";
    for (const s of config.coinswitch.symbols) {
      const [ob, tk] = await Promise.all([
        this.request<{ b: [string, string][]; a: [string, string][]; ts: number }>("GET", "/v5/market/orderbook", { category: "linear", symbol: s, limit: 50 }),
        this.request<{ list: Record<string, string>[] }>("GET", "/v5/market/tickers", { category: "linear", symbol: s }),
      ]);
      const lv = (xs: [string, string][]) => (xs ?? []).map(([p, q]) => ({ price: Number(p), size: Number(q) }));
      this.hub.setBook("coinswitch", s, { bids: lv(ob.env.result.b), asks: lv(ob.env.result.a), t: ob.env.result.ts ?? Date.now() });
      const t = tk.env.result.list?.[0];
      if (t) this.hub.setTicker("coinswitch", s, { t: Date.now(), last: Number(t.lastPrice), mark: Number(t.markPrice), index: Number(t.indexPrice), funding: Number(t.fundingRate), oi: Number(t.openInterest), oiUsd: Number(t.openInterestValue) || undefined, change24hPct: Number(t.price24hPcnt) * 100 || undefined, volume: Number(t.volume24h) || undefined });
      this.seen();
    }
  }

  status() {
    return this.baseStatus({ env: "production", keys: this.ready, execution: config.coinswitch.execution, symbols: config.coinswitch.symbols, note: this.ready ? undefined : "Set COINSWITCH_API_KEY and COINSWITCH_SECRET_KEY; even market data needs signed requests." });
  }
}
