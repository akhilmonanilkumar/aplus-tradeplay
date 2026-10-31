import { createHmac } from "node:crypto";
import type { BookLevel, FlowTrade } from "@aplus/engine";
import { CLOCK_BUDGET_MS, config, type DeltaEnv } from "../config.js";
import { timedFetch } from "../http.js";
import type { MarketHub } from "../market.js";
import { VenueBase } from "./types.js";

/**
 * Delta Exchange India. Market data from production over the public socket (REST polling while the
 * socket is down); signed REST for trading in the configured environment.
 */
export const DELTA_REST: Record<DeltaEnv, string> = { production: "https://api.india.delta.exchange", testnet: "https://cdn-ind.testnet.deltaex.org" };
export const DELTA_PUBLIC_WS = "wss://public-socket.india.delta.exchange";

export function deltaSignature(secret: string, method: string, timestampSec: string, path: string, query: string, body: string) {
  return createHmac("sha256", secret).update(method + timestampSec + path + query + body).digest("hex");
}

/** Delta timestamps arrive in seconds, milliseconds or microseconds depending on the field. */
export const toMs = (x: number) => (x > 1e15 ? x / 1000 : x > 1e12 ? x : x * 1000);

type Side = [string | number, string | number];
const levels = (xs: unknown): BookLevel[] =>
  Array.isArray(xs) ? xs.map((l) => (Array.isArray(l) ? { price: Number((l as Side)[0]), size: Number((l as Side)[1]) } : { price: Number((l as { price: string }).price), size: Number((l as { size: string | number }).size) })).filter((l) => Number.isFinite(l.price)) : [];

export type DeltaMsg =
  | { kind: "book"; symbol: string; action: "snapshot" | "update"; bids: BookLevel[]; asks: BookLevel[]; seq: number | null; prevSeq: number | null; t: number }
  | { kind: "trade"; symbol: string; trade: FlowTrade }
  | { kind: "ticker"; symbol: string; t: number; mark?: number; last?: number; index?: number; funding?: number; oi?: number }
  | { kind: "other"; type: string };

/**
 * Parse one public-socket message. Handles the current channel formats (l2_updates, all_trades,
 * v2/ticker) and the migrated short-key ones (ob_updates, trades, ticker).
 */
export function parseDeltaMessage(m: Record<string, unknown>): DeltaMsg {
  const type = String(m.type ?? "");
  if (type === "l2_updates" || type === "ob_updates") {
    const short = type === "ob_updates";
    return {
      kind: "book", symbol: String(short ? m.sy : m.symbol), action: m.action === "snapshot" ? "snapshot" : "update",
      bids: levels(short ? m.b : m.bids), asks: levels(short ? m.a : m.asks),
      seq: m.sequence_no !== undefined ? Number(m.sequence_no) : m.seq !== undefined ? Number(m.seq) : null,
      prevSeq: m.prev_sequence_no !== undefined ? Number(m.prev_sequence_no) : null,
      t: toMs(Number(m.timestamp ?? m.ts ?? Date.now())),
    };
  }
  if (type === "all_trades" || type === "trades") {
    const short = type === "trades";
    // buyer_role "taker" (or "t") means the buyer crossed the spread: an aggressive buy.
    const role = String(short ? m.r : m.buyer_role);
    return {
      kind: "trade", symbol: String(short ? m.sy : m.symbol),
      trade: { t: toMs(Number(short ? m.t ?? m.ts : m.timestamp)), price: Number(short ? m.p : m.price), size: Number(short ? m.s : m.size), side: role === "taker" || role === "t" ? "buy" : "sell" },
    };
  }
  if (type === "v2/ticker" || type === "ticker") {
    const d = (Array.isArray(m.d) ? m.d[0] : m) as Record<string, unknown>;
    const num = (x: unknown) => (x === undefined || x === null || x === "" ? undefined : Number(x));
    return {
      kind: "ticker", symbol: String(m.symbol ?? m.sy ?? d.s ?? ""), t: toMs(Number(m.timestamp ?? m.ts ?? Date.now())),
      mark: num(d.mark_price ?? d.m), last: num(d.close), index: num(m.spot_price ?? m.sp ?? d.spot_price), funding: num(d.funding_rate), oi: num(d.oi),
    };
  }
  return { kind: "other", type };
}

/** Apply book deltas: size 0 removes the level. Bids sorted high→low, asks low→high. */
export function applyBook(cur: { bids: BookLevel[]; asks: BookLevel[] }, upd: { bids: BookLevel[]; asks: BookLevel[] }) {
  const merge = (base: BookLevel[], diff: BookLevel[], desc: boolean) => {
    const m = new Map(base.map((l) => [l.price, l.size]));
    for (const l of diff) { if (l.size === 0) m.delete(l.price); else m.set(l.price, l.size); }
    return [...m.entries()].map(([price, size]) => ({ price, size })).sort((a, b) => (desc ? b.price - a.price : a.price - b.price));
  };
  return { bids: merge(cur.bids, upd.bids, true), asks: merge(cur.asks, upd.asks, false) };
}

export class DeltaVenue extends VenueBase {
  readonly id = "delta";
  readonly name = "Delta Exchange India";
  readonly budgetMs = CLOCK_BUDGET_MS.delta;
  /** Underlying units per contract (BTCUSD: 0.001 BTC), so sizes are comparable across venues. */
  private contractValue = new Map<string, number>();
  private books = new Map<string, { bids: BookLevel[]; asks: BookLevel[]; seq: number | null }>();
  private ws: WebSocket | null = null;
  private closing = false;

  constructor(private readonly hub: MarketHub) { super(); }

  private creds() { const k = config.delta.keys[config.delta.env]; return k.key && k.secret ? k : null; }

  start() {
    this.every(10 * 60_000, () => this.loadProducts());
    this.every(30_000, () => this.syncClock());
    this.every(15_000, () => this.pollTickers());
    this.every(2_000, () => (this.stream.state === "open" ? undefined : this.pollRest()));
    this.connect();
  }

  stop() { this.closing = true; this.ws?.close(); super.stop(); }

  private async loadProducts() {
    const r = await timedFetch<{ result: { symbol: string; contract_value: string }[] }>(`${DELTA_REST.production}/v2/products?contract_types=perpetual_futures&states=live`);
    for (const p of r.body?.result ?? []) this.contractValue.set(p.symbol, Number(p.contract_value) || 1);
  }

  private cv(symbol: string) { return this.contractValue.get(symbol) ?? 1; }

  /** Server time from the ticker's own timestamp (µs), falling back to the HTTP Date header (1 s precision). */
  async syncClock() {
    const r = await timedFetch<{ result?: { timestamp?: number } }>(`${DELTA_REST[config.delta.env]}/v2/tickers/BTCUSD`, {}, 8_000);
    const server = r.body?.result?.timestamp ? toMs(r.body.result.timestamp) : r.date;
    if (server) this.clock.add(r.sentAt, r.receivedAt, server);
  }

  private async pollTickers() {
    for (const s of config.delta.symbols) {
      const r = await timedFetch<{ result?: Record<string, unknown> }>(`${DELTA_REST.production}/v2/tickers/${s}`);
      const t = r.body?.result;
      if (!t) continue;
      const mark = Number(t.mark_price), oiContracts = Number(t.oi);
      this.hub.setTicker("delta", s, {
        t: Date.now(), mark, last: Number(t.close), index: Number(t.spot_price), funding: Number(t.funding_rate) / 100,
        oi: oiContracts * this.cv(s), oiUsd: Number(t.oi_value_usd ?? t.oi_value ?? 0) || undefined, change24hPct: Number(t.mark_change_24h ?? NaN) || undefined, volume: Number(t.volume ?? 0),
      });
    }
  }

  /** Fallback while the socket is down: order book and recent trades over REST. */
  private async pollRest() {
    if (this.stream.state !== "connecting") this.stream.state = "polling";
    for (const s of config.delta.symbols) {
      const [ob, tr] = await Promise.all([
        timedFetch<{ result?: { buy: unknown; sell: unknown; last_updated_at?: number } }>(`${DELTA_REST.production}/v2/l2orderbook/${s}?depth=50`),
        timedFetch<{ result?: { trades?: { side: string; size: number; price: string; timestamp: number }[] } }>(`${DELTA_REST.production}/v2/trades/${s}`),
      ]);
      const cv = this.cv(s);
      if (ob.body?.result) {
        const bids = levels(ob.body.result.buy).map((l) => ({ ...l, size: l.size * cv })), asks = levels(ob.body.result.sell).map((l) => ({ ...l, size: l.size * cv }));
        this.hub.setBook("delta", s, { bids, asks, t: Date.now() });
      }
      // REST `side` is the taker side.
      const trades = (tr.body?.result?.trades ?? []).map((x) => ({ t: toMs(x.timestamp), price: Number(x.price), size: x.size * cv, side: x.side === "buy" ? "buy" as const : "sell" as const }));
      this.hub.addTrades("delta", s, trades);
      this.seen();
    }
  }

  private connect() {
    if (this.closing) return;
    this.stream.state = "connecting";
    const ws = new WebSocket(DELTA_PUBLIC_WS);
    this.ws = ws;
    ws.onopen = () => {
      this.stream.state = "open";
      this.stream.error = null;
      ws.send(JSON.stringify({ type: "enable_heartbeat" }));
      ws.send(JSON.stringify({ type: "subscribe", payload: { channels: config.delta.channels.map((name) => ({ name, symbols: config.delta.symbols })) } }));
    };
    ws.onmessage = (ev) => {
      this.seen();
      let m: Record<string, unknown>;
      try { m = JSON.parse(String(ev.data)); } catch { return; }
      this.onMessage(parseDeltaMessage(m));
    };
    ws.onerror = () => { this.stream.error = "socket error"; };
    ws.onclose = () => {
      this.ws = null;
      this.books.clear();
      if (this.closing) { this.stream.state = "closed"; return; }
      this.stream.state = "polling";
      this.stream.reconnects++;
      setTimeout(() => this.connect(), Math.min(30_000, 1000 * 2 ** Math.min(5, this.stream.reconnects)));
    };
    // A silent socket is a dead socket: heartbeats arrive every few seconds.
    const watchdog = setInterval(() => {
      if (this.ws !== ws) return clearInterval(watchdog);
      if (this.stream.lastMessageAt && Date.now() - this.stream.lastMessageAt > 35_000) ws.close();
    }, 10_000);
  }

  private onMessage(m: DeltaMsg) {
    if (m.kind === "trade") return this.hub.addTrades("delta", m.symbol, [{ ...m.trade, size: m.trade.size * this.cv(m.symbol) }]);
    if (m.kind === "ticker") return this.hub.setTicker("delta", m.symbol, { t: m.t, mark: m.mark, last: m.last, index: m.index, funding: m.funding === undefined ? undefined : m.funding / 100, oi: m.oi === undefined ? undefined : m.oi * this.cv(m.symbol) });
    if (m.kind !== "book") return;
    const cv = this.cv(m.symbol);
    const scaled = { bids: m.bids.map((l) => ({ ...l, size: l.size * cv })), asks: m.asks.map((l) => ({ ...l, size: l.size * cv })) };
    const cur = this.books.get(m.symbol);
    if (m.action === "snapshot" || !cur) {
      if (m.action !== "snapshot") return; // wait for a snapshot before applying deltas
      this.books.set(m.symbol, { ...scaled, seq: m.seq });
    } else {
      // A gap in sequence numbers means a missed update: drop the book and resubscribe for a fresh snapshot.
      if (cur.seq !== null && m.seq !== null && m.seq !== cur.seq + 1 && (m.prevSeq === null || m.prevSeq !== cur.seq)) {
        this.books.delete(m.symbol);
        this.ws?.send(JSON.stringify({ type: "subscribe", payload: { channels: [{ name: config.delta.channels[0], symbols: [m.symbol] }] } }));
        return;
      }
      this.books.set(m.symbol, { ...applyBook(cur, scaled), seq: m.seq });
    }
    const b = this.books.get(m.symbol)!;
    this.hub.setBook("delta", m.symbol, { bids: b.bids, asks: b.asks, t: m.t });
  }

  /** Signed request with the venue clock, for the trading routes. */
  async signed(method: string, path: string, query: Record<string, string | number> = {}, body: unknown = null) {
    const c = this.creds();
    if (!c) throw new Error(`Delta ${config.delta.env} keys are not set on the engine host`);
    if (!this.clock.healthy(this.budgetMs)) throw new Error("Delta clock is out of budget; not signing");
    const qs = Object.keys(query).length ? `?${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]))}` : "";
    const b = body === null || body === undefined ? "" : JSON.stringify(body);
    const ts = String(Math.floor(this.clock.now() / 1000));
    return timedFetch(`${DELTA_REST[config.delta.env]}${path}${qs}`, {
      method, body: b || undefined,
      headers: { "api-key": c.key, timestamp: ts, signature: deltaSignature(c.secret, method, ts, path, qs, b), "content-type": "application/json" },
    });
  }

  status() {
    return this.baseStatus({ env: config.delta.env, keys: !!this.creds(), execution: config.delta.execution, symbols: config.delta.symbols });
  }
}
