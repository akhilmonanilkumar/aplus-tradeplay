import { describe, expect, it } from 'vitest';
import { structureBreaks, swingStructure, type Candle } from './smc.js';
import { htfRange } from './setup.js';

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
