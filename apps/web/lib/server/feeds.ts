import "server-only";
import { INSTRUMENTS, TF_MS, isFxClosed, type Candle, type InstrumentId, type Tf } from "@aplus/engine";
import { cached, errMsg, getJson } from "@/lib/server/http";

/**
 * Candle and quote providers with ordered fallbacks per instrument. Each result says
 * which source answered and whether it is an approximation of the traded price.
 *
 * Gold CFD accuracy: OANDA (free practice key) or Twelve Data give real XAU/USD.
 * Without a key we fall back to the Binance XAUUSDT index (a multi-venue spot-gold
 * composite), then PAXG — both are labelled.
 */

export interface CandleSet { candles: Candle[]; forming: Candle | null; source: string; approx: boolean; note?: string }
type Range = { limit: number; endTime?: number };
type Provider = {
  name: string; approx: boolean; note?: string; enabled?: () => boolean; load: (tf: Tf, r: Range) => Promise<Candle[]>;
  /** Rate-limited vendors: fetch only this timeframe (once per bar) and aggregate the others from it. */
  base?: Tf;
  /** Bars per request when paging history. */
  pageSize?: number;
  /** Tight request quota: a long history pull can run out mid-way, so backtests skip it unless asked for by name. */
  metered?: boolean;
};

const num = (x: unknown) => Number(x);
const env = (k: string) => process.env[k]?.trim() || "";

/* ---------------- crypto venues ---------------- */

const BINANCE_TF: Record<Tf, string> = { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d" };

function binanceFutures(path: "klines" | "markPriceKlines" | "indexPriceKlines", symbol: string): Provider["load"] {
  return async (tf, r) => {
    const key = path === "indexPriceKlines" ? "pair" : "symbol";
    const q = new URLSearchParams({ [key]: symbol, interval: BINANCE_TF[tf], limit: String(Math.min(1500, r.limit)) });
    if (r.endTime) q.set("endTime", String(r.endTime));
    const rows = await getJson<(string | number)[][]>(`https://fapi.binance.com/fapi/v1/${path}?${q}`);
    return rows.map((x) => ({ t: num(x[0]), o: num(x[1]), h: num(x[2]), l: num(x[3]), c: num(x[4]), v: num(x[5] ?? 0) }));
  };
}

function binanceSpot(symbol: string): Provider["load"] {
  return async (tf, r) => {
    const q = new URLSearchParams({ symbol, interval: BINANCE_TF[tf], limit: String(Math.min(1000, r.limit)) });
    if (r.endTime) q.set("endTime", String(r.endTime));
    const rows = await getJson<(string | number)[][]>(`https://api.binance.com/api/v3/klines?${q}`);
    return rows.map((x) => ({ t: num(x[0]), o: num(x[1]), h: num(x[2]), l: num(x[3]), c: num(x[4]), v: num(x[5]) }));
  };
}

const BYBIT_TF: Record<Tf, string> = { "1m": "1", "5m": "5", "15m": "15", "1h": "60", "4h": "240", "1d": "D" };
function bybit(symbol: string, mark: boolean): Provider["load"] {
  return async (tf, r) => {
    const q = new URLSearchParams({ category: "linear", symbol, interval: BYBIT_TF[tf], limit: String(Math.min(1000, r.limit)) });
    if (r.endTime) q.set("end", String(r.endTime));
    const j = await getJson<{ retCode: number; retMsg: string; result: { list: string[][] } }>(`https://api.bybit.com/v5/market/${mark ? "mark-price-kline" : "kline"}?${q}`);
    if (j.retCode !== 0) throw new Error(`bybit: ${j.retMsg}`);
    return j.result.list.map((x) => ({ t: num(x[0]), o: num(x[1]), h: num(x[2]), l: num(x[3]), c: num(x[4]), v: num(x[5] ?? 0) })).reverse();
  };
}

const OKX_TF: Record<Tf, string> = { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1Dutc" };
function okx(instId: string): Provider["load"] {
  return async (tf, r) => {
    const q = new URLSearchParams({ instId, bar: OKX_TF[tf], limit: String(Math.min(300, r.limit)) });
    if (r.endTime) q.set("after", String(r.endTime));
    const j = await getJson<{ code: string; msg: string; data: string[][] }>(`https://www.okx.com/api/v5/market/${r.endTime ? "history-candles" : "candles"}?${q}`);
    if (j.code !== "0") throw new Error(`okx: ${j.msg}`);
    return j.data.map((x) => ({ t: num(x[0]), o: num(x[1]), h: num(x[2]), l: num(x[3]), c: num(x[4]), v: num(x[5]) })).reverse();
  };
}

/** Coinbase Exchange: max 300 candles per call, no 4h granularity (built from 1h). */
function coinbase(product: string): Provider["load"] {
  const one = async (gran: number, limit: number, end?: number) => {
    const endT = end ?? Date.now();
    const startT = endT - gran * 1000 * limit;
    const q = new URLSearchParams({ granularity: String(gran), start: new Date(startT).toISOString(), end: new Date(endT).toISOString() });
    const rows = await getJson<number[][]>(`https://api.exchange.coinbase.com/products/${product}/candles?${q}`);
    return rows.map((x) => ({ t: x[0]! * 1000, l: x[1]!, h: x[2]!, o: x[3]!, c: x[4]!, v: x[5]! })).sort((a, b) => a.t - b.t);
  };
  return async (tf, r) => {
    if (tf === "4h") return aggregate(await coinbaseMany(one, 3600, r.limit * 4, r.endTime), TF_MS["4h"]).slice(-r.limit);
    const gran = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "1d": 86400 }[tf];
    return coinbaseMany(one, gran, r.limit, r.endTime);
  };
}
async function coinbaseMany(one: (g: number, l: number, e?: number) => Promise<Candle[]>, gran: number, limit: number, end?: number) {
  const out: Candle[] = [];
  let e = end;
  while (out.length < limit) {
    const n = Math.min(300, limit - out.length);
    const batch = await one(gran, n, e);
    if (!batch.length) break;
    out.unshift(...batch.filter((c) => !out.length || c.t < out[0]!.t));
    e = batch[0]!.t - 1;
    if (batch.length < n * 0.5) break;
  }
  return out.slice(-limit);
}

function kraken(pair: string): Provider["load"] {
  return async (tf) => {
    const interval = { "1m": 1, "5m": 5, "15m": 15, "1h": 60, "4h": 240, "1d": 1440 }[tf];
    const j = await getJson<{ error: string[]; result: Record<string, unknown> }>(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${interval}`);
    if (j.error?.length) throw new Error(`kraken: ${j.error[0]}`);
    const key = Object.keys(j.result).find((k) => k !== "last")!;
    return (j.result[key] as (string | number)[][]).map((x) => ({ t: num(x[0]) * 1000, o: num(x[1]), h: num(x[2]), l: num(x[3]), c: num(x[4]), v: num(x[6]) }));
  };
}

/* ---------------- FX / CFD vendors (keyed) ---------------- */

const OANDA_TF: Record<Tf, string> = { "1m": "M1", "5m": "M5", "15m": "M15", "1h": "H1", "4h": "H4", "1d": "D" };
const oandaBase = () => (env("OANDA_ENV") === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com");
function oanda(instrumentName: string): Provider["load"] {
  return async (tf, r) => {
    const q = new URLSearchParams({ granularity: OANDA_TF[tf], price: "M", count: String(Math.min(5000, r.limit)), dailyAlignment: "17", alignmentTimezone: "America/New_York" });
    if (r.endTime) q.set("to", new Date(r.endTime).toISOString());
    const j = await getJson<{ candles: { time: string; mid: { o: string; h: string; l: string; c: string }; volume: number }[] }>(
      `${oandaBase()}/v3/instruments/${instrumentName}/candles?${q}`,
      { headers: { authorization: `Bearer ${env("OANDA_API_KEY")}` } },
    );
    return j.candles.map((x) => ({ t: Date.parse(x.time), o: num(x.mid.o), h: num(x.mid.h), l: num(x.mid.l), c: num(x.mid.c), v: x.volume }));
  };
}

const TD_TF: Record<Tf, string> = { "1m": "1min", "5m": "5min", "15m": "15min", "1h": "1h", "4h": "4h", "1d": "1day" };
function twelveData(symbol: string): Provider["load"] {
  return async (tf, r) => {
    const q = new URLSearchParams({ symbol, interval: TD_TF[tf], outputsize: String(Math.min(5000, r.limit)), timezone: "UTC", order: "ASC", apikey: env("TWELVEDATA_API_KEY") });
    if (r.endTime) q.set("end_date", new Date(r.endTime).toISOString().slice(0, 19).replace("T", " "));
    const j = await getJson<{ status: string; message?: string; values?: { datetime: string; open: string; high: string; low: string; close: string }[] }>(`https://api.twelvedata.com/time_series?${q}`);
    if (j.status !== "ok" || !j.values) throw new Error(`twelvedata: ${j.message ?? j.status}`);
    return j.values.map((x) => ({ t: Date.parse(`${x.datetime.replace(" ", "T")}Z`), o: num(x.open), h: num(x.high), l: num(x.low), c: num(x.close) }));
  };
}

/* ---------------- chains ---------------- */

const hasOanda = () => !!env("OANDA_API_KEY");
const hasTd = () => !!env("TWELVEDATA_API_KEY");

export const CHAINS: Record<InstrumentId, Provider[]> = {
  XAUUSD: [
    { name: "OANDA XAU/USD", approx: false, enabled: hasOanda, load: oanda("XAU_USD") },
    // Free tier: 8 requests/min, 800/day — one 5,000-bar 5M pull per bar close covers 5M, 15M and 1H.
    { name: "Twelve Data XAU/USD", approx: false, enabled: hasTd, load: twelveData("XAU/USD"), base: "5m", pageSize: 5000, metered: true },
    { name: "Binance XAU index (spot-gold composite)", approx: true, note: "Add an OANDA or Twelve Data key for broker-grade XAU/USD", load: binanceFutures("indexPriceKlines", "XAUUSDT") },
    { name: "PAXG/USDT proxy", approx: true, note: "1 PAXG ≈ 1 oz; trades at a small premium to spot", load: binanceSpot("PAXGUSDT") },
  ],
  "XAUUSDT.P": [
    { name: "Binance XAUUSDT.P mark", approx: false, load: binanceFutures("markPriceKlines", "XAUUSDT") },
    { name: "Binance XAUUSDT.P last", approx: false, load: binanceFutures("klines", "XAUUSDT") },
  ],
  "BTCUSDT.P": [
    { name: "Binance BTCUSDT.P mark", approx: false, load: binanceFutures("markPriceKlines", "BTCUSDT") },
    { name: "Bybit BTCUSDT mark", approx: true, note: "Binance unreachable — Bybit mark price", load: bybit("BTCUSDT", true) },
    { name: "OKX BTC-USDT-SWAP", approx: true, note: "Binance unreachable — OKX last price", load: okx("BTC-USDT-SWAP") },
  ],
  "BTCUSD.SPOT": [
    { name: "Coinbase BTC-USD", approx: false, load: coinbase("BTC-USD") },
    { name: "Kraken XBT/USD", approx: false, load: kraken("XBTUSD") },
    { name: "Binance BTC/USDT", approx: true, note: "USDT, not USD", load: binanceSpot("BTCUSDT") },
  ],
  BTCUSD: [
    { name: "OANDA BTC/USD CFD", approx: false, enabled: hasOanda, load: oanda("BTC_USD") },
    { name: "Coinbase BTC-USD (CFD reference)", approx: true, note: "Broker CFD tracks USD spot plus its spread", load: coinbase("BTC-USD") },
    { name: "Kraken XBT/USD (CFD reference)", approx: true, load: kraken("XBTUSD") },
  ],
};

/** Latest candles: closed ones for the engine, the forming bar for the chart. */
export async function loadCandles(id: InstrumentId, tf: Tf, limit = 300, prefer?: string): Promise<CandleSet> {
  return cached(`c:${id}:${tf}:${limit}:${prefer ?? ""}`, tf === "1m" || tf === "5m" ? 10_000 : 30_000, async () => {
    const errors: string[] = [];
    const chain = CHAINS[id].filter((p) => !p.enabled || p.enabled());
    const order = prefer ? [...chain.filter((p) => p.name === prefer), ...chain.filter((p) => p.name !== prefer)] : chain;
    for (const p of order) {
      try {
        const rows = openHours(id, p.base && tf !== "1m" ? await fromBase(id, p, tf) : dedupe(await p.load(tf, { limit: limit + 1 })));
        if (rows.length < 10) throw new Error("too few candles");
        const now = Date.now();
        const closed = rows.filter((c) => c.t + TF_MS[tf] <= now);
        const forming = rows.find((c) => c.t + TF_MS[tf] > now) ?? null;
        return { candles: closed.slice(-limit), forming, source: p.name, approx: p.approx, note: p.note };
      } catch (e) {
        errors.push(`${p.name}: ${errMsg(e)}`);
      }
    }
    throw new Error(errors.join(" · ") || "no provider");
  });
}

/**
 * Base-timeframe pull for rate-limited vendors, cached until just after the next bar closes.
 * If the vendor hasn't published the newest bar yet, retry in 30 s instead of waiting a full bar.
 */
const baseMemo = new Map<string, { until: number; v: Promise<Candle[]> }>();
async function fromBase(id: InstrumentId, p: Provider, tf: Tf): Promise<Candle[]> {
  const base = p.base!;
  const ms = TF_MS[base];
  const key = `${id}:${p.name}:${base}`;
  const now = Date.now();
  let hit = baseMemo.get(key);
  if (!hit || now >= hit.until) {
    const v = p.load(base, { limit: 5000 }).then(dedupe);
    hit = { until: Math.floor(now / ms) * ms + ms + 8_000, v };
    baseMemo.set(key, hit);
    v.then((rows) => {
      const expected = Math.floor(Date.now() / ms) * ms - ms; // open time of the last closed bar
      if ((rows.at(-1)?.t ?? 0) < expected && hit) hit.until = Math.min(hit.until, Date.now() + 30_000);
    }, () => baseMemo.delete(key));
  }
  const rows = openHours(id, await hit.v);
  return tf === base ? rows : aggregate(rows, TF_MS[tf]);
}

export interface HistoryOpts {
  /** Use only this provider (by name) and fail rather than fall back to another. */
  source?: string;
  /** Allow metered providers in the automatic chain (live tracking, not backtests). */
  allowMetered?: boolean;
}

/**
 * Closed candles between `from` and `to`, paging backwards through one provider.
 * Repeatable by design: metered vendors are skipped unless named, and a provider whose history
 * starts well after `from` is passed over for one that covers the window, so the same request
 * gets the same source and the same bars instead of whichever vendor happened to answer.
 */
export async function loadHistory(id: InstrumentId, tf: Tf, from: number, to: number, opts: HistoryOpts = {}): Promise<CandleSet> {
  const errors: string[] = [];
  const enabled = CHAINS[id].filter((x) => !x.enabled || x.enabled());
  const chain = opts.source ? enabled.filter((x) => x.name === opts.source) : enabled.filter((x) => opts.allowMetered || !x.metered);
  if (!chain.length) throw new Error(opts.source ? `source not available: ${opts.source}` : "no provider");
  // Weekends and holidays leave CFD history without bars for up to a few days.
  const slack = (INSTRUMENTS[id].fxHours ? 4 : 1) * 86_400_000 + TF_MS[tf];
  const end0 = Math.min(to, Date.now());
  let partial: CandleSet | null = null;
  for (const p of chain) {
    const page = p.pageSize ?? 1000;
    try {
      const out: Candle[] = [];
      let end = end0;
      for (let guard = 0; guard < 80 && end > from; guard++) {
        const batch = dedupe(await p.load(tf, { limit: page, endTime: end }));
        const older = batch.filter((c) => c.t < (out[0]?.t ?? Infinity) && c.t >= from - TF_MS[tf]);
        if (!older.length) break;
        out.unshift(...older);
        end = older[0]!.t - 1;
        if (batch.length < page * 0.3) break;
      }
      const closed = openHours(id, out).filter((c) => c.t >= from && c.t + TF_MS[tf] <= end0);
      if (closed.length < 50) throw new Error(`only ${closed.length} candles`);
      const set: CandleSet = { candles: closed, forming: null, source: p.name, approx: p.approx, note: p.note };
      if (closed[0]!.t <= from + slack) return set;
      errors.push(`${p.name}: history starts ${new Date(closed[0]!.t).toISOString().slice(0, 10)}`);
      if (!partial || closed[0]!.t < partial.candles[0]!.t) partial = set;
    } catch (e) {
      errors.push(`${p.name}: ${errMsg(e)}`);
    }
  }
  if (partial) return { ...partial, note: `Partial history: starts ${new Date(partial.candles[0]!.t).toISOString().slice(0, 10)}, not ${new Date(from).toISOString().slice(0, 10)}` };
  throw new Error(errors.join(" · "));
}

/**
 * Several timeframes for one backtest from a single provider: the first frame picks the source,
 * the others must come from it too, so structure, POIs and entries all read the same prices.
 */
export async function loadFrames(id: InstrumentId, frames: { tf: Tf; from: number }[], to: number, opts: HistoryOpts = {}): Promise<CandleSet[]> {
  const [first, ...rest] = frames;
  const lead = await loadHistory(id, first!.tf, first!.from, to, opts);
  const others = await Promise.all(rest.map((f) => loadHistory(id, f.tf, f.from, to, { source: lead.source })));
  return [lead, ...others];
}

/** Backtest windows end on the last whole hour, so reruns within the hour replay the same bars. */
export const historyEnd = (now = Date.now()) => Math.floor(now / 3_600_000) * 3_600_000;

/** Drop bars printed while a CFD market is shut (weekend, daily break). Crypto trades 24/7. */
function openHours(id: InstrumentId, rows: Candle[]): Candle[] {
  return INSTRUMENTS[id].fxHours ? rows.filter((c) => !isFxClosed(c.t)) : rows;
}

function dedupe(rows: Candle[]): Candle[] {
  const m = new Map<number, Candle>();
  for (const c of rows) if ([c.o, c.h, c.l, c.c].every(Number.isFinite)) m.set(c.t, c);
  return [...m.values()].sort((a, b) => a.t - b.t);
}

export function aggregate(base: readonly Candle[], ms: number): Candle[] {
  const m = new Map<number, Candle>();
  for (const c of base) {
    const k = Math.floor(c.t / ms) * ms;
    const x = m.get(k);
    if (!x) m.set(k, { ...c, t: k });
    else { x.h = Math.max(x.h, c.h); x.l = Math.min(x.l, c.l); x.c = c.c; x.v = (x.v ?? 0) + (c.v ?? 0); }
  }
  return [...m.values()].sort((a, b) => a.t - b.t);
}

/* ---------------- quotes ---------------- */

export interface Quote { bid: number | null; ask: number | null; last: number; mark?: number; index?: number; ts: number; source: string; approx: boolean }

export async function loadQuote(id: InstrumentId): Promise<Quote> {
  return cached(`q:${id}`, 1500, async () => {
    const errors: string[] = [];
    for (const q of QUOTES[id]) {
      if (q.enabled && !q.enabled()) continue;
      try { return await q.load(); } catch (e) { errors.push(`${q.name}: ${errMsg(e)}`); }
    }
    throw new Error(errors.join(" · "));
  });
}

type QuoteProvider = { name: string; enabled?: () => boolean; load: () => Promise<Quote> };

const binanceFutQuote = (symbol: string, name: string): QuoteProvider => ({
  name,
  load: async () => {
    const [pi, bt] = await Promise.all([
      getJson<{ markPrice: string; indexPrice: string; time: number }>(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`),
      getJson<{ bidPrice: string; askPrice: string }>(`https://fapi.binance.com/fapi/v1/ticker/bookTicker?symbol=${symbol}`).catch(() => null),
    ]);
    return { bid: bt ? num(bt.bidPrice) : null, ask: bt ? num(bt.askPrice) : null, last: num(pi.markPrice), mark: num(pi.markPrice), index: num(pi.indexPrice), ts: pi.time, source: name, approx: false };
  },
});

const coinbaseQuote: QuoteProvider = {
  name: "Coinbase BTC-USD",
  load: async () => {
    const j = await getJson<{ bid: string; ask: string; price: string; time: string }>("https://api.exchange.coinbase.com/products/BTC-USD/ticker");
    return { bid: num(j.bid), ask: num(j.ask), last: num(j.price), ts: Date.parse(j.time), source: "Coinbase BTC-USD", approx: false };
  },
};

const QUOTES: Record<InstrumentId, QuoteProvider[]> = {
  XAUUSD: [
    {
      name: "OANDA XAU/USD",
      enabled: () => hasOanda() && !!env("OANDA_ACCOUNT_ID"),
      load: async () => {
        const j = await getJson<{ prices: { bids: { price: string }[]; asks: { price: string }[]; time: string }[] }>(
          `${oandaBase()}/v3/accounts/${env("OANDA_ACCOUNT_ID")}/pricing?instruments=XAU_USD`,
          { headers: { authorization: `Bearer ${env("OANDA_API_KEY")}` } },
        );
        const p = j.prices[0]!;
        const bid = num(p.bids[0]!.price), ask = num(p.asks[0]!.price);
        return { bid, ask, last: (bid + ask) / 2, ts: Date.parse(p.time), source: "OANDA XAU/USD", approx: false };
      },
    },
    {
      name: "Swissquote XAU/USD",
      load: async () => {
        const j = await getJson<{ ts: number; spreadProfilePrices: { spreadProfile: string; bid: number; ask: number }[] }[]>(
          "https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD",
        );
        const best = j.flatMap((x) => x.spreadProfilePrices.map((p) => ({ ...p, ts: x.ts }))).sort((a, b) => a.ask - a.bid - (b.ask - b.bid))[0];
        if (!best) throw new Error("no prices");
        return { bid: best.bid, ask: best.ask, last: (best.bid + best.ask) / 2, ts: best.ts, source: "Swissquote XAU/USD", approx: false };
      },
    },
    {
      name: "Binance XAU index",
      load: async () => {
        const q = await binanceFutQuote("XAUUSDT", "Binance XAU index").load();
        return { ...q, bid: null, ask: null, last: q.index ?? q.last, approx: true };
      },
    },
  ],
  "XAUUSDT.P": [binanceFutQuote("XAUUSDT", "Binance XAUUSDT.P")],
  "BTCUSDT.P": [binanceFutQuote("BTCUSDT", "Binance BTCUSDT.P")],
  "BTCUSD.SPOT": [coinbaseQuote],
  BTCUSD: [coinbaseQuote],
};

export const instrumentOk = (id: string | null): id is InstrumentId => !!id && id in INSTRUMENTS;
export const tfOk = (tf: string | null): tf is Tf => !!tf && tf in TF_MS;
