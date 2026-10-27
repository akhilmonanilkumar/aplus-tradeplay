import { describe, expect, it } from 'vitest';
import { isFinalOutcome, resolveSignal, type Candle } from './index.js';

const M5 = 300_000;
const T0 = 1_800_000_000_000;
/** Bars from [low, high] pairs, starting one bar after the signal. */
const bars = (...hl: [number, number][]): Candle[] => hl.map(([l, h], i) => ({ t: T0 + i * M5, o: (l + h) / 2, h, l, c: (l + h) / 2, v: 0 }));
const long = { side: 'long' as const, entry: 100, stop: 98, target: 106, createdAt: T0 - 1 };
const short = { side: 'short' as const, entry: 100, stop: 102, target: 94, createdAt: T0 - 1 };

describe('signal outcome', () => {
  it('fills then wins at +R:R', () => {
    const r = resolveSignal(long, bars([101, 103], [99.5, 101], [100, 104], [103, 106.5]), M5);
    expect(r.outcome).toBe('win');
    expect(r.resultR).toBe(3);
    expect(r.filledAt).toBe(T0 + M5);
    expect(r.closedAt).toBe(T0 + 4 * M5);
  });

  it('checks the stop before the target on every bar after the fill', () => {
    expect(resolveSignal(long, bars([99.9, 101], [97, 107]), M5).outcome).toBe('loss');
  });

  it('counts a stop on the fill bar but not a target', () => {
    expect(resolveSignal(long, bars([97.5, 101]), M5).outcome).toBe('loss');
    const r = resolveSignal(long, bars([99.9, 106.5]), M5);
    expect(r.outcome).toBe('filled');
  });

  it('ran away when the target trades before the fill', () => {
    expect(resolveSignal(short, bars([99, 99.8], [93.5, 99]), M5).outcome).toBe('ran_away');
  });

  it('expires after the order lifetime without a fill', () => {
    const flat = Array.from({ length: 12 }, () => [101, 102] as [number, number]);
    expect(resolveSignal(long, bars(...flat), M5, 12).outcome).toBe('expired');
    expect(resolveSignal(long, bars(...flat.slice(0, 11)), M5, 12).outcome).toBe('pending');
  });

  it('ignores bars that closed before the signal and handles shorts', () => {
    const r = resolveSignal({ ...short, createdAt: T0 + M5 }, bars([90, 110], [99, 100.5], [95, 99], [93.9, 96]), M5);
    expect(r.outcome).toBe('win');
    expect(r.resultR).toBe(3);
    expect(isFinalOutcome(r.outcome)).toBe(true);
    expect(isFinalOutcome('filled')).toBe(false);
  });
});

describe('market entries', () => {
  it('fill when placed, so a move away is a win, not "ran away"', () => {
    const r = resolveSignal({ ...long, market: true }, bars([100.5, 103], [102, 106.5]), M5);
    expect(r.outcome).toBe('win');
    expect(r.filledAt).toBe(long.createdAt);
  });
});
