import { describe, expect, it } from 'vitest';
import { smcStructure, structureBreaks, swingStructure, type Candle } from './smc.js';
import { frameStructure, htfRange } from './setup.js';

/** Close-only bars along a zig-zag: 4 bars per leg, so every turn is a (3,3) pivot. */
function path(points: number[]): Candle[] {
  const out: Candle[] = [];
  let t = 0;
  const push = (c: number) => out.push({ t: (t++) * 3_600_000, o: c, h: c + 0.05, l: c - 0.05, c });
  push(points[0]!);
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1]!, b = points[k]!;
    for (let s = 1; s <= 4; s++) push(a + ((b - a) * s) / 4);
  }
  for (let s = 0; s < 4; s++) push(points[points.length - 1]!);
  return out;
}

describe('SMC swing structure', () => {
  // 110 high, 95 low, 105 lower high, 90 breaks 95 (bearish), 85 low, 93 lower high (strong high),
  // 82 breaks 85 (BOS down), bounce 89, 84, then 91: above the minor 89 but below the strong 93.
  const bearish = path([100, 110, 95, 105, 90, 85, 93, 82, 89, 84, 91]);

  it('stays bearish when a bounce only clears a minor lower high', () => {
    expect(structureBreaks(bearish, 3, 3).trend).toBe('up'); // internal structure flips…
    const s = swingStructure(bearish, 3, 3);
    expect(s.trend).toBe('down'); // …the swing structure does not
    expect(s.protectedLevel?.price).toBeCloseTo(93.05, 6);
    expect(s.breaks.map((b) => `${b.kind}:${b.direction}`)).toEqual(['BOS:down', 'BOS:down']);
  });

  it('flips with a CHoCH only on a body close above the strong high', () => {
    const s = swingStructure(path([100, 110, 95, 105, 90, 85, 93, 82, 89, 84, 91, 96]), 3, 3);
    expect(s.trend).toBe('up');
    const last = s.breaks[s.breaks.length - 1]!;
    expect(last.kind).toBe('CHoCH');
    expect(last.level).toBeCloseTo(93.05, 6);
    expect(s.protectedLevel?.price).toBeCloseTo(81.95, 6); // the low the CHoCH leg started from
  });

  it('continues a trend only past the leg extreme, moving the protected low up', () => {
    // 90 → 100 → 95 → 106 breaks 100 (up), 101 pullback, 104 (inside the leg, no BOS), 110 breaks 106.
    const s = swingStructure(path([92, 100, 95, 106, 101, 104, 102, 110]), 3, 3);
    expect(s.trend).toBe('up');
    expect(s.breaks.map((b) => b.kind)).toEqual(['BOS', 'BOS']);
    expect(s.protectedLevel?.price).toBeCloseTo(100.95, 6);
  });

  it('builds the HTF dealing range from the swing structure', () => {
    const r = htfRange(bearish)!;
    expect(r.trend).toBe('down');
    // Latest break is the BOS through 85: range from the strong high it started from (93) to the low since (82).
    expect(r.high).toBeCloseTo(93.05, 6);
    expect(r.low).toBeCloseTo(81.95, 6);
  });
});

describe('LuxAlgo-style internal and swing structure', () => {
  // Selloff from 120 with bounces whose lows keep being undercut, then a bounce to 105.
  const selloff = path([100, 120, 108, 114, 102, 108, 96, 103, 92, 100, 95, 105]);

  it('flips internal structure on the bounce while swing structure stays bearish', () => {
    const s = smcStructure(selloff, { internal: 2, swing: 12 });
    const last = s.internal.breaks[s.internal.breaks.length - 1]!;
    expect(s.internal.trend).toBe('up');
    expect(`${last.kind}:${last.direction}`).toBe('CHoCH:up');
    expect(last.level).toBeCloseTo(100.05, 6);
    expect(s.swing.trend).toBe('down');
    expect(s.swing.high.level).toBeCloseTo(120.05, 6); // no bullish swing leg, so the top is still the swing high
    expect(s.strong).toEqual({ kind: 'high', level: expect.closeTo(120.05, 6) });
    expect(s.trailing.top).toBeCloseTo(120.05, 6);
    expect(s.trailing.bottom).toBeCloseTo(91.95, 6);
  });

  it('marks swing pivots by legs: a high is a swing high only when the next N bars stay below it', () => {
    const s = smcStructure(path([100, 110, 95, 105, 90, 85, 93, 82, 89, 84, 91]), { internal: 2, swing: 4 });
    // Every 4-bar turn is a swing at length 4: bearish BOS chain, then a CHoCH up through 89.
    expect(s.swing.breaks.map((b) => `${b.kind}:${b.direction}`)).toEqual(['BOS:down', 'BOS:down', 'BOS:down', 'CHoCH:up']);
    expect(s.swing.breaks[3]!.level).toBeCloseTo(89.05, 6);
    // Internal levels equal to the swing levels are not broken twice.
    expect(s.internal.breaks).toHaveLength(0);
  });

  it('breaks on a close crossing the level, once per swing point', () => {
    const c = path([100, 110, 95, 105, 90, 85, 93, 82, 89, 84, 91, 88, 92]);
    const s = smcStructure(c, { internal: 2, swing: 4 });
    const ups = s.swing.breaks.filter((b) => b.direction === 'up');
    expect(new Set(ups.map((b) => b.pivotIndex)).size).toBe(ups.length);
    for (const b of s.swing.breaks) {
      const cl = c[b.index]!.c;
      expect(b.direction === 'up' ? cl > b.level : cl < b.level).toBe(true);
    }
  });

  it('frame structure falls back to the protected levels while there is no swing break', () => {
    const f = frameStructure(selloff); // 49 bars: too short for a 50-bar swing
    expect(f.trend).toBe(swingStructure(selloff, 3, 3).trend);
    expect(f.range).not.toBeNull();
  });
});
