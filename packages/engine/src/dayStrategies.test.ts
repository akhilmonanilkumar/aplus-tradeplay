import { describe, expect, it } from 'vitest';
import type { Candle } from './smc.js';
import { NY, wallToUtc } from './sessions.js';
import { runBreadnButter, type BnbParams } from './breadnbutter.js';
import { runRangeTheory, type RangeTheoryParams } from './rangeTheory.js';
import { DAY_VARIANTS, runDayVariant } from './dayStrategies.js';
import { strategyName } from './sessionModels.js';

const M5 = 300_000, M15 = 900_000;
const bar = (t: number, o: number, h: number, l: number, c: number): Candle => ({ t, o, h, l, c, v: 1 });

/** Flat bars oscillating ±0.5 around `mid` from t0 to t1. */
function flat(t0: number, t1: number, mid: number, ms: number): Candle[] {
  const out: Candle[] = [];
  for (let t = t0, i = 0; t < t1; t += ms, i++) { const o = mid + (i % 2 ? 0.2 : -0.2); out.push(bar(t, o, mid + 0.5, mid - 0.5, mid - (i % 2 ? 0.2 : -0.2))); }
  return out;
}

const BNB: BnbParams = { insideOpen: true, smt: 'off', trend: false, discount: false, window: 'kz', stop: 'swing', entry: 'edge', minRR: 2, dispAtr: 1, pushAtr: 0.5, partialAtR: null, maxCostR: 0.25, shift: false, asiaSweep: false };

describe('BreadnButter', () => {
  // Wednesday 14 Jan 2026: yesterday (NY day from Mon 17:00) ranged 100–110; today opens at 105.
  const y0 = wallToUtc(2026, 1, 12, 17, 0, NY), d0 = wallToUtc(2026, 1, 13, 17, 0, NY);
  const yesterday = [...flat(y0, y0 + 12 * 3_600_000, 101, M5), ...flat(y0 + 12 * 3_600_000, d0, 109, M5)];
  yesterday[10] = { ...yesterday[10]!, l: 100 }; yesterday[yesterday.length - 3] = { ...yesterday[yesterday.length - 3]!, h: 110 };
  const at = (h: number, m: number) => wallToUtc(2026, 1, 14, h, m, NY);
  const today: Candle[] = [...flat(d0, at(2, 0), 105, M5)];
  // London Q: the first push dips to 102 (holds above 100), then a displacement leaves a gap 103–104.
  today.push(bar(at(2, 0), 105, 105.2, 103, 103.2), bar(at(2, 5), 103.2, 103.4, 102, 102.4), bar(at(2, 10), 102.4, 103, 102.3, 102.9));
  today.push(bar(at(2, 15), 102.9, 106.2, 102.8, 106), bar(at(2, 20), 106, 106.8, 104, 106.5));
  today.push(bar(at(2, 25), 106.5, 106.6, 103.9, 104.2), bar(at(2, 30), 104.2, 108, 104.1, 107.8), bar(at(2, 35), 107.8, 110.5, 107.5, 110.2));
  today.push(...flat(at(2, 40), at(16, 0), 110, M5));

  it('buys the gap after a failed push and targets yesterday’s high', () => {
    const r = runBreadnButter('XAUUSD', { ltf: [...yesterday, ...today], ltfMs: M5 }, BNB);
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0]!;
    expect(t.side).toBe('long');
    expect(t.entry).toBe(104); // the gap's near edge
    expect(t.stop).toBeCloseTo(101.7); // beyond the protected low (102) by the 0.3 buffer
    expect(t.target).toBe(110);
    expect(t.exit).toBe('target');
    expect(t.filledAt).toBe(at(2, 25));
  });
  it('the A+ version needs the failed push to sweep the Asia range', () => {
    const ltf = [...yesterday, ...today];
    expect(runBreadnButter('XAUUSD', { ltf, ltfMs: M5 }, { ...BNB, asiaSweep: true }).trades).toHaveLength(1); // 102 took the Asia low (104.5)
    const deepAsia = ltf.map((x) => (x.t === wallToUtc(2026, 1, 13, 21, 0, NY) ? { ...x, l: 101.5 } : x));
    expect(runBreadnButter('XAUUSD', { ltf: deepAsia, ltfMs: M5 }, { ...BNB, asiaSweep: true }).trades).toHaveLength(0);
  });
});

const RT: RangeTheoryParams = { mode: 'retest', closes: 2, anchor: 'far', entryFib: 0.6, stopFib: 0.8, rr: 3, capAtr: null, minRR: 1, sessions: 'both', trend: false, maxBoxAtr: null, maxCostR: null };

describe('Range Theory', () => {
  // Wednesday 14 Jan 2026 (London = UTC). Box 01:00–05:00 between 100 and 102.
  const u = (h: number, m = 0) => Date.UTC(2026, 0, 14, h, m);
  const c: Candle[] = [...flat(u(0), u(1), 101, M15), ...flat(u(1), u(5), 101, M15)];
  c[6] = { ...c[6]!, h: 102 }; c[10] = { ...c[10]!, l: 100 };
  c.push(...flat(u(5), u(8), 101, M15));
  // London: two closes above 102, extreme 104, then the retest to 60% (101.6) and a run to 3R.
  c.push(bar(u(8), 101, 102.8, 100.9, 102.5), bar(u(8, 15), 102.5, 104, 102.4, 103.5), bar(u(8, 30), 103.5, 103.6, 102.6, 102.8), bar(u(8, 45), 102.8, 102.9, 101.5, 101.9));
  c.push(bar(u(9), 101.9, 103, 101.8, 102.9), bar(u(9, 15), 102.9, 104.2, 102.8, 104.1), ...flat(u(9, 30), u(21), 104.5, M15));

  it('enters the 60% retest after two closes outside the box', () => {
    const r = runRangeTheory('XAUUSD', { ltf: c, ltfMs: M15 }, RT);
    const t = r.trades[0]!;
    expect(t.side).toBe('long');
    expect(t.session).toBe('london');
    expect(t.entry).toBeCloseTo(101.6);
    expect(t.stop).toBeCloseTo(100.8);
    expect(t.target).toBeCloseTo(104);
    expect(t.exit).toBe('target');
    expect(t.rGross).toBeCloseTo(3);
  });
  it('one close outside is not a break', () => {
    const one = c.map((x) => (x.t === u(8, 15) ? { ...x, c: 101.5 } : x));
    const r = runRangeTheory('XAUUSD', { ltf: one, ltfMs: M15 }, { ...RT, sessions: 'london' });
    expect(r.trades).toHaveLength(0);
  });
});

describe('day strategy registry', () => {
  it('names every variant and skips SMT without a correlated market', () => {
    for (const v of DAY_VARIANTS) expect(strategyName(v.id)).toBe(v.name);
    const smt = DAY_VARIANTS.find((v) => v.id === 'bnb-smt')!;
    expect(runDayVariant(smt, 'XAUUSD', { ltf: [], ltfMs: M5 })).toBeNull();
  });
});
