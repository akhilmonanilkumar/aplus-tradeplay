import "server-only";
import { createHmac } from "node:crypto";
import type { Candle, Tf } from "@aplus/engine";
import { getJson } from "@/lib/server/http";

/**
 * Delta Exchange India: public market data (always from production, which is the real market) and the
 * signed trading API, pointed at the demo testnet unless DELTA_ENV=production is set deliberately.
 *
 * Signing: HMAC-SHA256(secret, METHOD + timestamp + path + query + body), hex, sent as `api-key`,
 * `timestamp` (Unix seconds) and `signature` headers. Testnet keys come from the Delta demo account and
 * only work on the testnet host; production keys only on api.india.delta.exchange.
 */

export type DeltaEnv = "testnet" | "production";
export const DELTA_HOSTS: Record<DeltaEnv, { rest: string; socket: string }> = {
  production: { rest: "https://api.india.delta.exchange", socket: "wss://socket.india.delta.exchange" },
  testnet: { rest: "https://cdn-ind.testnet.deltaex.org", socket: "wss://socket-ind.testnet.deltaex.org" },
};

export const deltaEnv = (): DeltaEnv => (process.env.DELTA_ENV === "production" ? "production" : "testnet");
const creds = (env: DeltaEnv) => {
  const key = (env === "production" ? process.env.DELTA_API_KEY : process.env.DELTA_TESTNET_API_KEY)?.trim();
  const secret = (env === "production" ? process.env.DELTA_API_SECRET : process.env.DELTA_TESTNET_API_SECRET)?.trim();
  return key && secret ? { key, secret } : null;
};
export const deltaConfigured = (env: DeltaEnv = deltaEnv()) => !!creds(env);

interface Envelope<T> { success: boolean; result: T; error?: { code?: string; context?: unknown } | string; meta?: unknown }

/** Public GET (no keys). Market data comes from production unless a host is named. */
export async function deltaPublic<T>(path: string, query: Record<string, string | number> = {}, env: DeltaEnv = "production"): Promise<T> {
  const q = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
  const j = await getJson<Envelope<T>>(`${DELTA_HOSTS[env].rest}${path}${q.size ? `?${q}` : ""}`, { timeoutMs: 10_000 });
  if (!j.success) throw new Error(`delta ${path}: ${typeof j.error === "string" ? j.error : JSON.stringify(j.error)}`);
  return j.result;
}

export function deltaSignature(secret: string, method: string, timestamp: string, path: string, query: string, body: string) {
  return createHmac("sha256", secret).update(method + timestamp + path + query + body).digest("hex");
}

/** Signed request to the trading API of the configured environment. */
export async function deltaPrivate<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, opts: { query?: Record<string, string | number>; body?: unknown; env?: DeltaEnv } = {}): Promise<T> {
  const env = opts.env ?? deltaEnv();
  const c = creds(env);
  if (!c) throw new Error(`Delta ${env} keys are not set`);
  const qs = opts.query && Object.keys(opts.query).length ? `?${new URLSearchParams(Object.entries(opts.query).map(([k, v]) => [k, String(v)]))}` : "";
  const body = opts.body === undefined ? "" : JSON.stringify(opts.body);
  const ts = String(Math.floor(Date.now() / 1000));
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10_000);
  try {
    const res = await fetch(`${DELTA_HOSTS[env].rest}${path}${qs}`, {
      method, signal: ctl.signal, cache: "no-store", body: body || undefined,
      headers: { "api-key": c.key, timestamp: ts, signature: deltaSignature(c.secret, method, ts, path, qs, body), "content-type": "application/json", "user-agent": "aplus-tradeplay" },
    });
    const j = (await res.json().catch(() => ({ success: false, error: `HTTP ${res.status}` }))) as Envelope<T>;
    if (!res.ok || !j.success) throw new Error(`delta ${method} ${path}: ${typeof j.error === "string" ? j.error : JSON.stringify(j.error ?? `HTTP ${res.status}`)}`);
    return j.result;
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new Error(`delta ${method} ${path} timed out`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

/* ---------------- market data ---------------- */

export interface DeltaProduct {
  id: number; symbol: string; description: string; contract_type: string; state: string; contract_value: string; contract_unit_currency: string;
  tick_size: string; settling_asset?: { symbol: string }; quoting_asset?: { symbol: string }; underlying_asset?: { symbol: string };
  default_leverage?: string; initial_margin?: string; maintenance_margin?: string; taker_commission_rate?: string; maker_commission_rate?: string;
}
export interface DeltaTicker { symbol: string; close: number; mark_price: string; spot_price?: string; funding_rate?: string; oi?: string; volume?: number; timestamp?: number; quotes?: { best_bid?: string; best_ask?: string } }

const RES: Record<Tf, string> = { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d" };
const TF_S: Record<Tf, number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };

/** OHLC from Delta's history endpoint (production market). */
export async function deltaCandles(symbol: string, tf: Tf, r: { limit: number; endTime?: number }): Promise<Candle[]> {
  const end = Math.floor((r.endTime ?? Date.now()) / 1000);
  const start = end - Math.min(r.limit, 2000) * TF_S[tf];
  const rows = await deltaPublic<{ time: number; open: number; high: number; low: number; close: number; volume?: number }[]>("/v2/history/candles", { resolution: RES[tf], symbol, start, end });
  return rows.map((x) => ({ t: x.time * 1000, o: Number(x.open), h: Number(x.high), l: Number(x.low), c: Number(x.close), v: Number(x.volume ?? 0) })).sort((a, b) => a.t - b.t);
}

/** Read-only connectivity and market map, for the feed probe and the integration plan. */
export async function deltaProbe() {
  const out: Record<string, unknown> = { env: deltaEnv(), keys: { testnet: deltaConfigured("testnet"), production: deltaConfigured("production") } };
  for (const env of ["production", "testnet"] as const) {
    const t0 = Date.now();
    try {
      const products = await deltaPublic<DeltaProduct[]>("/v2/products", { contract_types: "perpetual_futures", states: "live" }, env);
      const pick = products.filter((p) => /^(BTC|ETH|XAU|PAXG|SOL)/.test(p.symbol)).slice(0, 12).map((p) => ({
        id: p.id, symbol: p.symbol, desc: p.description, contract_value: p.contract_value, unit: p.contract_unit_currency, tick: p.tick_size,
        settle: p.settling_asset?.symbol, lev: p.default_leverage, im: p.initial_margin, mm: p.maintenance_margin, taker: p.taker_commission_rate, maker: p.maker_commission_rate,
      }));
      const tick = await deltaPublic<DeltaTicker>("/v2/tickers/BTCUSD", {}, env).catch((e) => ({ error: (e as Error).message }));
      const candles = await deltaPublic<unknown[]>("/v2/history/candles", { resolution: "5m", symbol: "BTCUSD", start: Math.floor(Date.now() / 1000) - 3600, end: Math.floor(Date.now() / 1000) }, env).catch((e) => ({ error: (e as Error).message }));
      out[env] = { ok: true, ms: Date.now() - t0, perps: products.length, matches: pick, btcTicker: tick, candleSample: Array.isArray(candles) ? { n: candles.length, first: candles[0], last: candles.at(-1) } : candles };
    } catch (e) {
      out[env] = { ok: false, ms: Date.now() - t0, error: (e as Error).message };
    }
  }
  if (deltaConfigured("testnet")) {
    try { out.testnetWallet = await deltaPrivate("GET", "/v2/wallet/balances", { env: "testnet" }); } catch (e) { out.testnetWallet = { error: (e as Error).message }; }
  }
  return out;
}
