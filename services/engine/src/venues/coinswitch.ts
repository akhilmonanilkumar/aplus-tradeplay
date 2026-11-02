import { createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";
import { CLOCK_BUDGET_MS, config } from "../config.js";
import { timedFetch } from "../http.js";
import type { MarketHub } from "../market.js";
import { VenueBase } from "./types.js";

/**
 * CoinSwitch PRO HFT API (https://dma.coinswitch.co, Bybit-v5-style paths). Every request, public or not,
 * is signed: Ed25519 over METHOD + decoded path-with-query + epoch-ms, hex, in X-AUTH-* headers.
 * The body is not part of the signed message (as in CoinSwitch's reference client).
 */
export const CS_BASE = "https://dma.coinswitch.co";

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
