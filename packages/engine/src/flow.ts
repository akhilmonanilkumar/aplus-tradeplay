/**
 * Order-flow and venue-health maths shared by the engine host and the web app:
 * footprint, cumulative delta, order-book stats and clock sync (the OI regime lives in context.ts).
 * Pure functions, no I/O.
 */

/** One executed trade. `side` is the aggressor: "buy" lifted the offer, "sell" hit the bid. */
export interface FlowTrade { t: number; price: number; size: number; side: 'buy' | 'sell' }
export interface BookLevel { price: number; size: number }
export interface Book { bids: BookLevel[]; asks: BookLevel[]; t: number }

export interface FootprintCell { price: number; buy: number; sell: number }
export interface FootprintBar { t: number; open: number; high: number; low: number; close: number; buy: number; sell: number; delta: number; poc: number | null; cells: FootprintCell[] }

const roundTo = (x: number, step: number) => Math.round(x / step) * step;
const fix = (x: number) => Number(x.toPrecision(12));

/**
 * Footprint bars: trades grouped by time bucket, then by price level (`tick`), with buy and sell volume
 * per level. The point of control is the level with the most total volume.
 */
export function footprint(trades: FlowTrade[], bucketMs: number, tick: number): FootprintBar[] {
  if (!(bucketMs > 0) || !(tick > 0)) throw new Error('bucketMs and tick must be positive');
  const byBucket = new Map<number, FlowTrade[]>();
  for (const tr of [...trades].sort((a, b) => a.t - b.t)) {
    const k = Math.floor(tr.t / bucketMs) * bucketMs;
    const arr = byBucket.get(k);
    if (arr) arr.push(tr); else byBucket.set(k, [tr]);
  }
  return [...byBucket.entries()].sort((a, b) => a[0] - b[0]).map(([t, xs]) => {
    const cells = new Map<number, FootprintCell>();
    let buy = 0, sell = 0;
    for (const x of xs) {
      const p = fix(roundTo(x.price, tick));
      const c = cells.get(p) ?? { price: p, buy: 0, sell: 0 };
      if (x.side === 'buy') { c.buy += x.size; buy += x.size; } else { c.sell += x.size; sell += x.size; }
      cells.set(p, c);
    }
    const list = [...cells.values()].sort((a, b) => b.price - a.price);
    const poc = list.reduce<FootprintCell | null>((best, c) => (!best || c.buy + c.sell > best.buy + best.sell ? c : best), null);
    const prices = xs.map((x) => x.price);
    return { t, open: xs[0]!.price, high: Math.max(...prices), low: Math.min(...prices), close: xs.at(-1)!.price, buy, sell, delta: buy - sell, poc: poc?.price ?? null, cells: list };
  });
}

/** Cumulative volume delta per bucket (buy minus sell), running total. */
export function cvd(trades: FlowTrade[], bucketMs: number): { t: number; delta: number; cvd: number; price: number }[] {
  let run = 0;
  return footprint(trades, bucketMs, Number.MAX_SAFE_INTEGER / 4).map((b) => { run += b.delta; return { t: b.t, delta: b.delta, cvd: run, price: b.close }; });
}

/** Cells where one side outweighs the other by `ratio` or more (stacked imbalances show conviction). */
export function imbalances(bar: FootprintBar, ratio = 3, minSize = 0): { price: number; side: 'buy' | 'sell' }[] {
  const out: { price: number; side: 'buy' | 'sell' }[] = [];
  for (const c of bar.cells) {
    if (c.buy + c.sell < minSize) continue;
    if (c.buy >= ratio * Math.max(c.sell, 1e-12)) out.push({ price: c.price, side: 'buy' });
    else if (c.sell >= ratio * Math.max(c.buy, 1e-12)) out.push({ price: c.price, side: 'sell' });
  }
  return out;
}

export interface BookStats {
  mid: number; spread: number; bidsWithin: number; asksWithin: number; imbalance: number;
  bidWalls: BookLevel[]; askWalls: BookLevel[];
}

/**
 * Size resting within `pct` of the mid on each side, the imbalance (+1 all bids, −1 all asks) and the
 * largest levels ("walls": at least `wallX` times the median level size).
 */
export function bookStats(book: Book, pct = 0.01, wallX = 3, maxWalls = 3): BookStats | null {
  const bb = book.bids[0], ba = book.asks[0];
  if (!bb || !ba) return null;
  const mid = (bb.price + ba.price) / 2;
  const inBids = book.bids.filter((l) => l.price >= mid * (1 - pct));
  const inAsks = book.asks.filter((l) => l.price <= mid * (1 + pct));
  const bidsWithin = inBids.reduce((s, l) => s + l.size, 0), asksWithin = inAsks.reduce((s, l) => s + l.size, 0);
  const sizes = [...inBids, ...inAsks].map((l) => l.size).sort((a, b) => a - b);
  const median = sizes.length ? sizes[Math.floor(sizes.length / 2)]! : 0;
  const walls = (xs: BookLevel[]) => xs.filter((l) => median > 0 && l.size >= wallX * median).sort((a, b) => b.size - a.size).slice(0, maxWalls);
  const tot = bidsWithin + asksWithin;
  return { mid, spread: ba.price - bb.price, bidsWithin, asksWithin, imbalance: tot ? (bidsWithin - asksWithin) / tot : 0, bidWalls: walls(inBids), askWalls: walls(inAsks) };
}

/**
 * Clock sync against one venue. Each sample is (local send time, local receive time, server time);
 * offset = server − (send + rtt / 2). The estimate is the median offset of the lowest-RTT half of the
 * recent samples, which ignores samples delayed on one leg.
 */
export class ClockSync {
  private samples: { offset: number; rtt: number; at: number }[] = [];
  constructor(private readonly keep = 20) {}

  add(sentAt: number, receivedAt: number, serverTime: number): void {
    const rtt = receivedAt - sentAt;
    if (!(rtt >= 0) || !Number.isFinite(serverTime)) return;
    this.samples.push({ offset: serverTime - (sentAt + rtt / 2), rtt, at: receivedAt });
    if (this.samples.length > this.keep) this.samples.shift();
  }

  get count(): number { return this.samples.length; }

  /** Milliseconds to add to local time to get venue time; null until a sample exists. */
  offset(): number | null {
    if (!this.samples.length) return null;
    const best = [...this.samples].sort((a, b) => a.rtt - b.rtt).slice(0, Math.max(1, Math.ceil(this.samples.length / 2)));
    const offs = best.map((s) => s.offset).sort((a, b) => a - b);
    return offs[Math.floor(offs.length / 2)]!;
  }

  /** 95th-percentile round trip, ms. */
  rttP95(): number | null {
    if (!this.samples.length) return null;
    const r = this.samples.map((s) => s.rtt).sort((a, b) => a - b);
    return r[Math.min(r.length - 1, Math.floor(r.length * 0.95))]!;
  }

  lastAt(): number | null { return this.samples.at(-1)?.at ?? null; }

  /** Venue time now. */
  now(local = Date.now()): number { return local + (this.offset() ?? 0); }

  /**
   * Safe to sign and send orders: a recent sample exists, |offset| and p95 RTT are inside the budget.
   * Delta rejects signatures older than 5 s, so its budget is tighter than that.
   */
  healthy(budgetMs: number, maxAgeMs = 120_000, local = Date.now()): boolean {
    const off = this.offset(), rtt = this.rttP95(), last = this.lastAt();
    return off !== null && rtt !== null && last !== null && local - last <= maxAgeMs && Math.abs(off) <= budgetMs && rtt <= budgetMs;
  }
}
