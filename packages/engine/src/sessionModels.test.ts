import { describe, expect, it } from 'vitest';
import { runSessionModel } from './sessionModels.js';
import { ASIA_Q, LONDON_Q } from './sessions.js';
import { TF_MS } from './instruments.js';
import type { Candle } from './smc.js';

const M5 = TF_MS['5m'];

/** Flat 100 ± 1 from 00:00 UTC (Asia, 20:00 NY the evening before), then a London fakeout and a drop. */
function day(): Candle[] {
  const start = Date.UTC(2026, 6, 7, 0, 0); // Tue 7 Jul 2026, 20:00 NY on the 6th
  const out: Candle[] = [];
  for (let k = 0; k < 12 * 6; k++) out.push({ t: start + k * M5, o: 100, h: k === 10 ? 101 : 100.4, l: k === 20 ? 99 : 99.6, c: 100 });
  const t0 = start + 72 * M5; // 06:00 UTC = 02:00 NY, London Q opens
  out.push({ t: t0, o: 100, h: 101.6, l: 99.9, c: 100.5 }); // sweep of the Asia high, close back inside
  for (let k = 1; k <= 6; k++) out.push({ t: t0 + k * M5, o: 100.5 - (k - 1) * 0.3, h: 100.6 - (k - 1) * 0.3, l: 100.2 - k * 0.3, c: 100.5 - k * 0.3 });
  return out;
}

const base = { rangeWindow: ASIA_Q, tradeWindow: LONDON_Q, trendFilter: false, rr: 2, minRR: 1, partialAtR: null, minRiskAtr: 0, costRate: 0 } as const;

describe('session models', () => {
  it('fades a sweep of the Asia high back to the Asia low', () => {
    const r = runSessionModel('XAUUSD', { htf: [], ltf: day(), htfMs: TF_MS['1h'], ltfMs: M5 }, { ...base, kind: 'fade', target: 'opposite' });
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0]!;
    expect(t.side).toBe('short');
    expect(t.entry).toBe(100.5);
    expect(t.stop).toBeCloseTo(101.9, 6); // wick 101.6 + 0.3 buffer
    expect(t.target).toBe(99);
    expect(t.exit).toBe('target');
    expect(t.rGross).toBeCloseTo(1.5 / 1.4, 6);
  });

  it('banks half at the partial and stops the rest at break-even', () => {
    const ltf = day();
    // Bounce back to entry after reaching 1R: half banked at 1R, the runner exits flat.
    const last = ltf[ltf.length - 1]!;
    ltf.splice(ltf.length - 5);
    const t1 = ltf[ltf.length - 1]!.t;
    ltf.push({ t: t1 + M5, o: 100.2, h: 100.2, l: 99.05, c: 99.2 }, { t: t1 + 2 * M5, o: 99.2, h: 100.6, l: 99.2, c: 100.6 });
    void last;
    const r = runSessionModel('XAUUSD', { htf: [], ltf, htfMs: TF_MS['1h'], ltfMs: M5 }, { ...base, kind: 'fade', target: 'rr', rr: 3, partialAtR: 1 });
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]!.exit).toBe('stop');
    expect(r.trades[0]!.rGross).toBeCloseTo(0.5, 6);
  });

  it('takes at most one trade per day and charges costs', () => {
    const r = runSessionModel('XAUUSD', { htf: [], ltf: day(), htfMs: TF_MS['1h'], ltfMs: M5 }, { ...base, kind: 'fade', target: 'opposite', costRate: 0.001 });
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]!.rNet).toBeLessThan(r.trades[0]!.rGross);
  });
});
