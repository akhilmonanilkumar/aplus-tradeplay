import { describe, expect, it } from 'vitest';
import { GATES_V2, demoteReason, leaguePass, leagueStats, paperChecks, parseVenueKey, venueKey, venueNetR, venuesFor, type Entry, type LeagueTrade } from './league.js';

const DAY = 86_400_000;
/** n trades over `days`, alternating wins and losses with the given sizes. */
const series = (n: number, win: number, loss: number, days = 30, start = 0): LeagueTrade[] =>
  Array.from({ length: n }, (_, i) => ({ at: start + (i * days * DAY) / Math.max(1, n - 1), netR: i % 2 === 0 ? win : -loss }));

describe('venues and costs', () => {
  it('maps markets to the venues that can trade them', () => {
    expect(venuesFor('BTCUSDT.P')).toEqual(['delta', 'coinswitch']);
    expect(venuesFor('XAUUSD')).toEqual(['cfd']);
    expect(venuesFor('NIFTY')).toEqual(['fyers']);
  });
  it('charges a venue its extra round-trip cost in R', () => {
    // BTC at 100,000 with a 500 stop: Delta adds 2 × 0.02% × 100,000 / 500 = 0.08R
    expect(venueNetR(1, 100_000, 99_500, 'delta')).toBeCloseTo(0.92);
    expect(venueNetR(1, 100_000, 99_500, 'cfd')).toBe(1);
  });
  it('builds and parses venue keys', () => {
    const k = venueKey('delta', 'BTCUSDT.P', 'S', 'asia_fade');
    expect(k).toBe('delta/BTCUSDT.P:S:asia_fade');
    expect(parseVenueKey(k)).toEqual({ venue: 'delta', instrument: 'BTCUSDT.P', model: 'S', strategy: 'asia_fade' });
    expect(venueKey('cfd', 'XAUUSD', 'A', 'ignored')).toBe('cfd/XAUUSD:A');
    expect(parseVenueKey('XAUUSD:A')).toBeNull();
  });
});

describe('leagueStats', () => {
  it('computes expectancy, PF, drawdown and a 90% lower bound', () => {
    const s = leagueStats(series(40, 2, 1));
    expect(s.n).toBe(40);
    expect(s.expectancy).toBe(0.5);
    expect(s.profitFactor).toBe(2);
    expect(s.maxDrawdownR).toBe(1);
    expect(s.days).toBe(30);
    expect(s.lowerBound).toBeGreaterThan(0);
    expect(leagueStats([]).lowerBound).toBe(-Infinity);
  });
});

describe('gates', () => {
  it('needs trades, days, edge and a positive lower bound', () => {
    expect(paperChecks(leagueStats(series(40, 2, 1)), GATES_V2).every((c) => c.ok)).toBe(true);
    expect(paperChecks(leagueStats(series(20, 2, 1)), GATES_V2).find((c) => !c.ok)?.label).toBe('30+ paper trades');
    expect(paperChecks(leagueStats(series(40, 2, 1, 10)), GATES_V2).find((c) => !c.ok)?.label).toBe('over 21+ days');
    expect(paperChecks(leagueStats(series(40, 1.1, 1)), GATES_V2).some((c) => !c.ok)).toBe(true);
  });
  it('includes the backtest when there is one', () => {
    const s = leagueStats(series(40, 2, 1));
    expect(paperChecks(s, GATES_V2, { trades: 12, profitFactor: 2 }).every((c) => c.ok)).toBe(false);
  });
  it('demotes on a losing recent record or a drawdown past the cap', () => {
    expect(demoteReason(leagueStats(series(30, 0.5, 1)), leagueStats([]), GATES_V2)).toMatch(/below zero/);
    expect(demoteReason(leagueStats(series(30, 2, 1)), leagueStats([{ at: 0, netR: 2 }, ...Array.from({ length: 5 }, (_, i) => ({ at: i + 1, netR: -1 }))]), GATES_V2, { backtestMaxDdR: 3 })).toMatch(/drawdown since live 5R ≥ 4.5R/);
    expect(demoteReason(leagueStats(series(30, 2, 1)), leagueStats(series(10, 2, 1)), GATES_V2)).toBeNull();
  });
});

describe('leaguePass', () => {
  const now = 100 * DAY;
  const entry = (key: string, stage: Entry['stage'], paper: LeagueTrade[], extra: Partial<Entry> = {}): Entry => {
    const p = leagueStats(paper);
    return { key, venue: 'delta', instrument: 'BTCUSDT.P', stage, pinned: false, stageSince: 0, paper: p, recent: p, sinceLive: leagueStats([]), ...extra };
  };
  it('promotes a qualifying paper strategy to candidate and then into a free slot', () => {
    const moves = leaguePass([entry('delta/BTCUSDT.P:A', 'paper', series(40, 2, 1))], GATES_V2, now);
    expect(moves.map((m) => `${m.from}>${m.to}`)).toEqual(['paper>candidate', 'candidate>live_small']);
  });
  it('fills one slot per market with the best score and swaps out a clearly weaker live one', () => {
    const strong = entry('delta/BTCUSDT.P:S:x', 'candidate', series(60, 3, 1));
    const weak = entry('delta/BTCUSDT.P:A', 'live', series(40, 1.4, 1), { sinceLive: leagueStats(series(20, 1.4, 1)) });
    const moves = leaguePass([strong, weak], GATES_V2, now);
    expect(moves).toEqual([
      { key: 'delta/BTCUSDT.P:A', from: 'live', to: 'benched', reason: expect.stringContaining('replaced by delta/BTCUSDT.P:S:x') },
      { key: 'delta/BTCUSDT.P:S:x', from: 'candidate', to: 'live_small', reason: 'replaced delta/BTCUSDT.P:A' },
    ]);
  });
  it('graduates live_small after enough trades and benches decaying live strategies', () => {
    const grad = entry('delta/BTCUSDT.P:A', 'live_small', series(40, 2, 1), { sinceLive: leagueStats(series(16, 2, 1)) });
    expect(leaguePass([grad], GATES_V2, now)[0]).toMatchObject({ to: 'live' });
    const decay = entry('delta/BTCUSDT.P:A', 'live', series(40, 2, 1), { recent: leagueStats(series(30, 0.5, 1)) });
    expect(leaguePass([decay], GATES_V2, now)[0]).toMatchObject({ to: 'benched' });
  });
  it('keeps benched strategies out until the cool-down ends, and never moves pinned ones', () => {
    expect(leaguePass([entry('k', 'benched', series(40, 2, 1), { stageSince: now - 2 * DAY })], GATES_V2, now)).toEqual([]);
    expect(leaguePass([entry('k', 'benched', series(40, 2, 1), { stageSince: now - 8 * DAY })], GATES_V2, now)[0]).toMatchObject({ to: 'paper' });
    expect(leaguePass([entry('k', 'live', series(40, 2, 1), { pinned: true, recent: leagueStats(series(30, 0.5, 1)) })], GATES_V2, now)).toEqual([]);
  });
});
