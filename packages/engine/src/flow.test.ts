import { describe, expect, it } from 'vitest';
import { ClockSync, bookStats, cvd, footprint, imbalances, type FlowTrade } from './flow.js';

const T = (t: number, price: number, size: number, side: 'buy' | 'sell'): FlowTrade => ({ t, price, size, side });

describe('footprint', () => {
  const trades = [T(1000, 100.04, 2, 'buy'), T(1500, 100.06, 1, 'sell'), T(2000, 100.1, 5, 'buy'), T(61_000, 99.9, 3, 'sell')];
  it('groups by bucket and price level, with delta and point of control', () => {
    const bars = footprint(trades, 60_000, 0.1);
    expect(bars).toHaveLength(2);
    const [a, b] = bars;
    expect(a!.buy).toBe(7); // 2 at 100.0 + 5 at 100.1
    expect(a!.sell).toBe(1);
    expect(a!.delta).toBe(6);
    expect(a!.open).toBe(100.04);
    expect(a!.close).toBe(100.1);
    expect(a!.cells.map((c) => c.price)).toEqual([100.1, 100]);
    expect(a!.cells[0]).toEqual({ price: 100.1, buy: 5, sell: 1 }); // 100.06 rounds up to 100.1
    expect(a!.poc).toBe(100.1);
    expect(b!.delta).toBe(-3);
  });
  it('sorts unordered input and rejects bad parameters', () => {
    expect(footprint([...trades].reverse(), 60_000, 0.1)[0]!.open).toBe(100.04);
    expect(() => footprint(trades, 0, 0.1)).toThrow();
  });
});

describe('cvd', () => {
  it('accumulates delta across buckets', () => {
    const s = cvd([T(0, 10, 3, 'buy'), T(10, 10, 1, 'sell'), T(1000, 11, 4, 'sell'), T(2000, 12, 5, 'buy')], 1000);
    expect(s.map((x) => x.cvd)).toEqual([2, -2, 3]);
    expect(s.map((x) => x.price)).toEqual([10, 11, 12]);
  });
});

describe('imbalances', () => {
  it('flags levels where one side is 3x the other', () => {
    const [bar] = footprint([T(0, 1, 9, 'buy'), T(0, 1, 2, 'sell'), T(0, 2, 1, 'buy'), T(0, 2, 6, 'sell'), T(0, 3, 2, 'buy'), T(0, 3, 2, 'sell')], 1000, 1);
    expect(imbalances(bar!)).toEqual([{ price: 2, side: 'sell' }, { price: 1, side: 'buy' }]);
  });
});

describe('bookStats', () => {
  const book = {
    t: 0,
    bids: [{ price: 99.9, size: 1 }, { price: 99.8, size: 1 }, { price: 99.5, size: 9 }, { price: 95, size: 50 }],
    asks: [{ price: 100.1, size: 1 }, { price: 100.2, size: 2 }, { price: 100.4, size: 1 }],
  };
  it('measures size near the mid, imbalance and walls', () => {
    const s = bookStats(book, 0.01, 3)!;
    expect(s.mid).toBeCloseTo(100);
    expect(s.spread).toBeCloseTo(0.2);
    expect(s.bidsWithin).toBe(11);
    expect(s.asksWithin).toBe(4);
    expect(s.imbalance).toBeCloseTo(7 / 15);
    expect(s.bidWalls).toEqual([{ price: 99.5, size: 9 }]);
    expect(s.askWalls).toEqual([]);
  });
  it('returns null for an empty side', () => {
    expect(bookStats({ t: 0, bids: [], asks: book.asks })).toBeNull();
  });
});

describe('ClockSync', () => {
  it('estimates offset from the fastest samples and ignores asymmetric delays', () => {
    const c = new ClockSync();
    // venue is 500 ms ahead; symmetric 40 ms round trips
    for (let i = 0; i < 6; i++) c.add(i * 1000, i * 1000 + 40, i * 1000 + 20 + 500);
    // one slow sample delayed on the way back only: naive offset would be wrong
    c.add(10_000, 10_900, 10_020 + 500);
    expect(c.offset()).toBe(500);
    expect(c.count).toBe(7);
    expect(c.now(1000)).toBe(1500);
  });
  it('is healthy only with fresh samples inside the budget', () => {
    const c = new ClockSync();
    expect(c.healthy(1500, 120_000, 0)).toBe(false);
    c.add(0, 50, 25 + 200);
    expect(c.healthy(1500, 120_000, 100)).toBe(true);
    expect(c.healthy(100, 120_000, 100)).toBe(false);
    expect(c.healthy(1500, 120_000, 500_000)).toBe(false);
  });
  it('drops invalid samples', () => {
    const c = new ClockSync();
    c.add(100, 50, 0);
    c.add(0, 10, Number.NaN);
    expect(c.offset()).toBeNull();
  });
});
