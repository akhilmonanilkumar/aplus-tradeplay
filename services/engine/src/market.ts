import { bookStats, cvd, footprint, imbalances, type Book, type FlowTrade } from "@aplus/engine";

/** Latest ticker fields every venue can fill (any may be missing). */
export interface Ticker { t: number; last?: number; mark?: number; index?: number; funding?: number; oi?: number; oiUsd?: number; change24hPct?: number; volume?: number }

interface Slot { trades: FlowTrade[]; book: Book | null; ticker: Ticker | null; oiHistory: { t: number; oi: number; price: number }[] }

export type TradeListener = (venue: string, symbol: string, trades: FlowTrade[]) => void;

/**
 * In-memory market state per venue and symbol: recent trades, the latest book and ticker, and an
 * open-interest history sampled from tickers. The flow API reads snapshots from here.
 */
export class MarketHub {
  private slots = new Map<string, Slot>();
  private listeners: TradeListener[] = [];
  constructor(private readonly memoryMs: number) {}

  private slot(venue: string, symbol: string): Slot {
    const k = `${venue}:${symbol}`;
    let s = this.slots.get(k);
    if (!s) { s = { trades: [], book: null, ticker: null, oiHistory: [] }; this.slots.set(k, s); }
    return s;
  }

  onTrades(fn: TradeListener) { this.listeners.push(fn); }

  addTrades(venue: string, symbol: string, xs: FlowTrade[]) {
    if (!xs.length) return;
    const s = this.slot(venue, symbol);
    const last = s.trades.at(-1)?.t ?? 0;
    // REST polls overlap: keep only trades newer than what we hold (same-ms trades from one batch stay).
    const fresh = xs.filter((x) => x.t > last).sort((a, b) => a.t - b.t);
    if (!fresh.length) return;
    s.trades.push(...fresh);
    const cut = Date.now() - this.memoryMs;
    if (s.trades[0] && s.trades[0].t < cut) s.trades = s.trades.filter((x) => x.t >= cut);
    for (const fn of this.listeners) fn(venue, symbol, fresh);
  }

  setBook(venue: string, symbol: string, book: Book) { this.slot(venue, symbol).book = book; }

  setTicker(venue: string, symbol: string, t: Ticker) {
    const s = this.slot(venue, symbol);
    s.ticker = { ...s.ticker, ...t };
    if (t.oi !== undefined && (t.last ?? t.mark) !== undefined) {
      const lastAt = s.oiHistory.at(-1)?.t ?? 0;
      if (t.t - lastAt >= 60_000) {
        s.oiHistory.push({ t: t.t, oi: t.oi, price: (t.mark ?? t.last)! });
        if (s.oiHistory.length > 1440) s.oiHistory.shift();
      }
    }
  }

  book(venue: string, symbol: string) { return this.slots.get(`${venue}:${symbol}`)?.book ?? null; }
  ticker(venue: string, symbol: string) { return this.slots.get(`${venue}:${symbol}`)?.ticker ?? null; }
  keys() { return [...this.slots.keys()]; }

  /** Everything the flow tabs draw, computed on request. */
  snapshot(venue: string, symbol: string, opts: { bucketMs: number; tick: number; bars: number; depthPct: number }) {
    const s = this.slots.get(`${venue}:${symbol}`);
    if (!s) return null;
    const since = Date.now() - opts.bucketMs * opts.bars;
    const recent = s.trades.filter((x) => x.t >= since);
    const bars = footprint(recent, opts.bucketMs, opts.tick).slice(-opts.bars);
    const sizes = recent.map((x) => x.size).sort((a, b) => a - b);
    const bigCut = sizes.length ? sizes[Math.floor(sizes.length * 0.98)]! : Infinity;
    return {
      venue, symbol, at: Date.now(),
      ticker: s.ticker,
      book: s.book ? { t: s.book.t, bids: s.book.bids.slice(0, 25), asks: s.book.asks.slice(0, 25), stats: bookStats(s.book, opts.depthPct) } : null,
      footprint: bars.map((b) => ({ ...b, imbalances: imbalances(b, 3) })),
      cvd: cvd(recent, Math.max(5_000, Math.round(opts.bucketMs / 6))),
      largeTrades: recent.filter((x) => x.size >= bigCut).slice(-30).reverse(),
      tradeCount: recent.length,
      oiHistory: s.oiHistory.slice(-288),
    };
  }
}
