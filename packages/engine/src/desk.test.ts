import { describe, expect, it } from 'vitest';
import {
  INSTRUMENTS, costInR, sizePosition, normalizeInstrument, pnlMultiplier,
  oiRegime, fundingState, syntheticDxy, pearson, correlation, contextScore, basisPct, fundingApr, sessionStats, emaTrend,
  runBacktest, breakdown, analyzeSetup, TF_MS, type Candle,
} from './index.js';

/** Deterministic pseudo-random walk with trending swings so structure forms. */
function walk(n: number, startT: number, stepMs: number, seed = 7, start = 100): Candle[] {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2 ** 31; return s / 2 ** 31; };
  const out: Candle[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 40) * 0.06;
    const o = p;
    const c = Math.max(1, o * (1 + (rnd() - 0.5) * 0.008 + drift / 100));
    const h = Math.max(o, c) * (1 + rnd() * 0.002);
    const l = Math.min(o, c) * (1 - rnd() * 0.002);
    out.push({ t: startT + i * stepMs, o, h, l, c });
    p = c;
  }
  return out;
}

/** Aggregate base candles into a higher timeframe aligned to its own period. */
function agg(base: Candle[], ms: number): Candle[] {
  const m = new Map<number, Candle>();
  for (const c of base) {
    const k = Math.floor(c.t / ms) * ms;
    const x = m.get(k);
    if (!x) m.set(k, { t: k, o: c.o, h: c.h, l: c.l, c: c.c });
    else { x.h = Math.max(x.h, c.h); x.l = Math.min(x.l, c.l); x.c = c.c; }
  }
  return [...m.values()];
}

describe('instruments', () => {
  it('has the five desk instruments', () => {
    expect(Object.keys(INSTRUMENTS).sort()).toEqual(['BTCUSD', 'BTCUSD.SPOT', 'BTCUSDT.P', 'XAUUSD', 'XAUUSDT.P']);
  });
  it('normalises legacy and TradingView ids', () => {
    expect(normalizeInstrument('BINANCE:BTCUSDT.P')).toBe('BTCUSDT.P');
    expect(normalizeInstrument('OANDA:XAUUSD')).toBe('XAUUSD');
    expect(normalizeInstrument('ETHUSD')).toBeNull();
  });
  it('sizes XAUUSD CFD lots from the stop distance', () => {
    // $10,284 × 0.5% = $51.42; 15.00 stop = $1,500 per lot → 0.0343 → 0.03
    const s = sizePosition(INSTRUMENTS.XAUUSD, { balance: 10_284, riskPct: 0.5, entry: 4120.6, stop: 4105.6 });
    expect(s.size).toBe(0.03);
    expect(s.riskAmount).toBeCloseTo(45, 6);
    expect(pnlMultiplier('XAUUSD')).toBe(100);
  });
  it('sizes a perp including taker fees to the stop and never rounds up', () => {
    const s = sizePosition(INSTRUMENTS['BTCUSDT.P'], { balance: 8420.55, riskPct: 1, entry: 68_000, stop: 67_700 });
    const lossPerBtc = 300 + 68_000 * 0.0005 + 67_700 * 0.0005;
    expect(s.size).toBeLessThanOrEqual(84.2055 / lossPerBtc);
    expect(s.riskAmount).toBeLessThanOrEqual(84.21);
    expect(s.size).toBe(0.228);
  });
  it('flags positions below the minimum', () => {
    expect(sizePosition(INSTRUMENTS.XAUUSD, { balance: 100, riskPct: 0.5, entry: 4000, stop: 3980 }).belowMinimum).toBe(true);
  });
  it('expresses costs in R', () => {
    // 0.1% round trip on a 0.4% stop = 0.25R
    expect(costInR({ costRate: 0.001 }, 100, 99.6)).toBeCloseTo(0.25, 9);
  });
});

describe('context', () => {
  it('classifies the price × OI quadrant', () => {
    expect(oiRegime(1, 2)).toBe('long_build');
    expect(oiRegime(-1, 2)).toBe('short_build');
    expect(oiRegime(1, -2)).toBe('short_cover');
    expect(oiRegime(-1, -2)).toBe('long_unwind');
    expect(oiRegime(0.1, 5)).toBe('neutral');
  });
  it('buckets funding and annualises it', () => {
    expect(fundingState(0.0001)).toBe('neutral');
    expect(fundingState(0.0003)).toBe('elevated_long');
    expect(fundingState(0.0006)).toBe('extreme_long');
    expect(fundingState(-0.0004)).toBe('extreme_short');
    expect(fundingApr(0.0001)).toBeCloseTo(10.95, 2);
    expect(basisPct(101, 100)).toBeCloseTo(1, 9);
  });
  it('computes the ICE dollar index formula', () => {
    // All components at 1.0 → the constant itself.
    expect(syntheticDxy({ eurusd: 1, usdjpy: 1, gbpusd: 1, usdcad: 1, usdsek: 1, usdchf: 1 })).toBeCloseTo(50.14348112, 8);
    const v = syntheticDxy({ eurusd: 1.08, usdjpy: 150, gbpusd: 1.27, usdcad: 1.36, usdsek: 10.5, usdchf: 0.88 });
    expect(v).toBeGreaterThan(100);
    expect(v).toBeLessThan(110);
  });
  it('correlates aligned returns and ignores unmatched bars', () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 9);
    expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 9);
    const a = Array.from({ length: 50 }, (_, i) => ({ t: i, v: 100 + Math.sin(i) * 5 + i }));
    const b = a.filter((p) => p.t % 7 !== 3).map((p) => ({ t: p.t, v: 1 / p.v }));
    const c = correlation(a, b);
    expect(c.corr!).toBeLessThan(-0.95);
    expect(c.n).toBeLessThan(49);
  });
  it('detects EMA trend direction', () => {
    expect(emaTrend(Array.from({ length: 80 }, (_, i) => 100 + i)).dir).toBe(1);
    expect(emaTrend(Array.from({ length: 80 }, (_, i) => 200 - i)).dir).toBe(-1);
  });
  it('scores confluence and warns when funding is crowded on our side', () => {
    const long = contextScore({ desk: 'btc', side: 'long', funding: 0.0008, oi: { regime: 'long_build' }, dxy: { dir: -1, chg24h: -0.3 } });
    expect(long.caution.some((c) => c.includes('funding'))).toBe(true);
    const gold = contextScore({ desk: 'gold', side: 'long', dxy: { dir: -1, chg24h: -0.4 }, us10yBp24h: -6 });
    expect(gold.score).toBe(100);
    const goldShort = contextScore({ desk: 'gold', side: 'short', dxy: { dir: -1, chg24h: -0.4 }, us10yBp24h: -6 });
    expect(goldShort.score).toBe(-100);
  });
  it('reports which session ran the previous one', () => {
    const c: Candle[] = [
      { t: 0, o: 10, h: 11, l: 9, c: 10 }, { t: 10, o: 10, h: 12, l: 9.5, c: 11 },
      { t: 20, o: 11, h: 13, l: 8, c: 12 },
    ];
    const s = sessionStats(c, [{ id: 'asia', name: 'Asia', startUtc: 0, endUtc: 20 }, { id: 'ldn', name: 'London', startUtc: 20, endUtc: 30 }], 25);
    expect(s[1]!.sweptPrevHigh).toBe(true);
    expect(s[1]!.sweptPrevLow).toBe(true);
    expect(s[1]!.live).toBe(true);
  });
});

describe('backtest', () => {
  const start = Date.UTC(2026, 6, 6); // Monday
  const ltf = walk(12 * 24 * 40, start, TF_MS['5m'], 11, 4000);
  const data = { ltf, poi: agg(ltf, TF_MS['15m']), htf: agg(ltf, TF_MS['1h']) };

  it('produces consistent trades and statistics', () => {
    const r = runBacktest('XAUUSD', data, { allowGradeA: true, requirePoi: false });
    for (const t of r.trades) {
      expect(t.entryAt).toBeGreaterThanOrEqual(t.signalAt);
      if (t.exitAt !== null) expect(t.exitAt).toBeGreaterThan(t.entryAt);
      expect(t.plannedR).toBeGreaterThanOrEqual(3 - 1e-9);
      if (t.outcome === 'loss') expect(t.rGross).toBeCloseTo(-1, 6);
      if (t.outcome === 'win') expect(t.rGross).toBeCloseTo(t.plannedR, 6);
      expect(t.rNet).toBeLessThanOrEqual(t.rGross);
    }
    const closed = r.trades.filter((t) => t.outcome !== 'open');
    expect(r.stats.n).toBe(closed.length);
    expect(r.equity.length).toBe(closed.length + 1);
    const byWindow = breakdown(r.trades, (t) => t.window);
    expect(byWindow.reduce((a, b) => a + b.stats.n, 0)).toBe(closed.length);
  });

  it('never looks ahead: trades closed before a cutoff are identical on truncated data', () => {
    const full = runBacktest('XAUUSD', data, { allowGradeA: true, requirePoi: false });
    const cut = ltf[Math.floor(ltf.length * 0.7)]!.t;
    const ltf2 = ltf.filter((c) => c.t < cut);
    const part = runBacktest('XAUUSD', { ltf: ltf2, poi: agg(ltf2, TF_MS['15m']), htf: agg(ltf2, TF_MS['1h']) }, { allowGradeA: true, requirePoi: false });
    const done = (ts: typeof full.trades) => ts.filter((t) => t.exitAt !== null && t.exitAt <= cut - TF_MS['1h']).map((t) => `${t.side}${t.entryAt}${t.exit}`);
    expect(done(part.trades)).toEqual(done(full.trades));
  });

  it('respects the daily trade cap and the side filter', () => {
    const r = runBacktest('XAUUSD', data, { allowGradeA: true, requirePoi: false, maxTradesPerDay: 1, sides: 'long' });
    expect(r.trades.every((t) => t.side === 'long')).toBe(true);
    const days = new Map<string, number>();
    for (const t of r.trades) { const k = new Date(t.entryAt - 4 * 3_600_000).toISOString().slice(0, 10); days.set(k, (days.get(k) ?? 0) + 1); }
    expect(Math.max(0, ...days.values())).toBeLessThanOrEqual(2);
  });

  it('only trades inside the chosen windows', () => {
    const r = runBacktest('XAUUSD', data, { allowGradeA: true, requirePoi: false, windows: ['ny_q'] });
    expect(r.trades.every((t) => t.window === 'ny_q')).toBe(true);
  });
});

describe('setup detector', () => {
  it('uses only the candles it is given and returns a coherent analysis', () => {
    const start = Date.UTC(2026, 6, 6);
    const ltf = walk(2000, start, TF_MS['5m'], 3, 60_000);
    const a = analyzeSetup('long', agg(ltf, TF_MS['4h']), agg(ltf, TF_MS['15m']), ltf.slice(-300), { stopBuffer: (p) => p * 0.0005 });
    expect(a.price).toBe(ltf.at(-1)!.c);
    if (a.range) expect(a.range.high).toBeGreaterThan(a.range.low);
    if (a.suggest) {
      expect(a.suggest.stop).toBeLessThan(a.suggest.entry);
      expect(a.suggest.target).toBeGreaterThan(a.suggest.entry);
    }
  });
});
