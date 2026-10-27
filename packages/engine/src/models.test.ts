import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PLAN, NY, TF_MS, detectModels, lossDiagnostics, planSetup, scanSignals, simulate, usHighImpactTimes, zonedParts,
  type Candle, type ModelSetup,
} from './index.js';

function walk(n: number, startT: number, stepMs: number, seed = 7, start = 100): Candle[] {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2 ** 31; return s / 2 ** 31; };
  const out: Candle[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 40) * 0.06;
    const o = p;
    const c = Math.max(1, o * (1 + (rnd() - 0.5) * 0.008 + drift / 100));
    out.push({ t: startT + i * stepMs, o, h: Math.max(o, c) * (1 + rnd() * 0.002), l: Math.min(o, c) * (1 - rnd() * 0.002), c });
    p = c;
  }
  return out;
}
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

const setup = (over: Partial<ModelSetup> = {}): ModelSetup => ({
  model: 'A', side: 'long', index: 0, entry: 100, entryType: 'limit',
  anchors: [{ v: 98, l: 'sweep of PDL' }, { v: 99, l: '5M OB' }, { v: 97, l: '15M OB' }], zoneAnchor: { v: 99, l: '5M OB' },
  shifted: true, checks: {}, key: 'k', detail: '', sweep: null, ...over,
});
const pool = [{ level: 101, label: '5M swing high' }, { level: 105, label: '15M swing high' }, { level: 110, label: 'PDH' }];

describe('plan rules', () => {
  it('structural stop sits beyond the furthest anchor; zone stop beyond the entry zone', () => {
    const s = planSetup(setup(), { pool, stopBuf: 0.5 }, DEFAULT_PLAN)!;
    expect(s.stop).toBe(96.5);
    expect(s.stopAnchor).toBe('15M OB');
    const z = planSetup(setup(), { pool, stopBuf: 0.5 }, { ...DEFAULT_PLAN, stopMode: 'zone' })!;
    expect(z.stop).toBe(98.5);
    expect(z.stopAnchor).toBe('5M OB');
  });
  it('first_ge_min takes the nearest level paying the minimum; nearest never stretches', () => {
    const z = { ...DEFAULT_PLAN, stopMode: 'zone' as const };
    // risk 1.5: 101 pays 0.67R, 105 pays 3.33R
    expect(planSetup(setup(), { pool, stopBuf: 0.5 }, z)!.targetLabel).toBe('15M swing high');
    const n = planSetup(setup(), { pool, stopBuf: 0.5 }, { ...z, targetMode: 'nearest' })!;
    expect(n.targetLabel).toBe('5M swing high');
    expect(n.plannedR).toBeLessThan(2);
  });
  it('prefers the model target (F: opposite side of the Asia range) and honours a minimum target R', () => {
    const f = planSetup(setup({ preferTargets: ['PDH'] }), { pool, stopBuf: 0.5 }, { ...DEFAULT_PLAN, stopMode: 'zone' })!;
    expect(f.targetLabel).toBe('PDH');
    const h = planSetup(setup({ minTargetR: 5, stopMode: 'zone' }), { pool, stopBuf: 0.5 }, DEFAULT_PLAN)!;
    expect(h.plannedR).toBeGreaterThanOrEqual(5);
  });
  it('returns null with nothing behind the entry', () => {
    expect(planSetup(setup({ anchors: [{ v: 101, l: 'x' }], zoneAnchor: { v: 101, l: 'x' } }), { pool, stopBuf: 0.5 }, DEFAULT_PLAN)).toBeNull();
  });
});

describe('model detector', () => {
  const start = Date.UTC(2026, 6, 6);
  const ltf = walk(12 * 24 * 40, start, TF_MS['5m'], 11, 4000);
  const data = { ltf, poi: agg(ltf, TF_MS['15m']), htf: agg(ltf, TF_MS['1h']) };

  it('finds several models, each with its entry in front of its structure', () => {
    const scan = scanSignals('XAUUSD', data, { windows: ['london_q', 'ny_q'], sides: 'both', sweepLookback: 36 });
    const models = new Set(scan.candidates.map((c) => c.setup.model));
    expect(models.has('A') || models.has('G')).toBe(true);
    expect(models.size).toBeGreaterThan(1);
    for (const c of scan.candidates) {
      const s = c.setup;
      const plan = planSetup(s, c.a, DEFAULT_PLAN);
      if (!plan) continue;
      expect(s.side === 'long' ? plan.stop < plan.entry && plan.target > plan.entry : plan.stop > plan.entry && plan.target < plan.entry).toBe(true);
      if (s.model === 'E') expect(s.entryType).toBe('market');
      if (s.model === 'G') expect(c.a.htfTrend).not.toBe(s.side === 'long' ? 'up' : 'down');
    }
  });

  it('simulates one model at a time and records excursions', () => {
    const scan = scanSignals('XAUUSD', data, { windows: ['london_q', 'ny_q'], sides: 'both', sweepLookback: 36 });
    for (const m of ['A', 'B', 'C', 'D', 'E', 'G'] as const) {
      const r = simulate('XAUUSD', data, scan, { models: [m], allowAllModels: true, allowGradeA: true, requirePoi: false, requireCorrectHalf: false });
      for (const t of r.trades) {
        expect(t.model).toBe(m);
        if (t.outcome === 'loss') expect(t.mfeR).toBeLessThan(t.plannedR + 1e-9);
        if (t.outcome === 'win') expect(t.mfeR).toBeGreaterThanOrEqual(t.plannedR - 1e-9);
        expect(t.maeR).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });

  it('model E is gold only and model H needs 1M candles', () => {
    const L = ltf.slice(1000, 1300), P = data.poi.filter((c) => c.t < L[L.length - 1]!.t).slice(-400), H = data.htf.filter((c) => c.t < L[L.length - 1]!.t).slice(-300);
    for (const side of ['long', 'short'] as const) {
      const btc = detectModels(side, H, P, L, { instrument: 'BTCUSDT.P', recentBars: 300 });
      expect(btc.setups.some((s) => s.model === 'E' || s.model === 'H')).toBe(false);
    }
  });

  it('applies the learned filters: POI quality, liquidity targets, skipped hours, cost cap', () => {
    const scan = scanSignals('XAUUSD', data, { windows: ['london_q', 'ny_q'], sides: 'both', sweepLookback: 36 });
    const loose = { allowAllModels: true, allowGradeA: true, requirePoi: false, requireCorrectHalf: false, models: ['A', 'B', 'C', 'D', 'E'] as const };
    const r = simulate('XAUUSD', data, scan, { ...loose, models: [...loose.models], poiQuality: 'ob_liquidity', targetSet: 'liquidity', skipHoursNy: [2, 8], maxCostR: 0.25 });
    for (const t of r.trades) {
      expect(t.zone).toMatch(/OB · liquidity/);
      expect(t.targetLabel).not.toMatch(/FVG/);
      expect([2, 8]).not.toContain(zonedParts(t.signalAt - TF_MS['5m'], NY).hour);
      expect(t.costR).toBeLessThanOrEqual(0.25 + 1e-9);
    }
    expect(Object.keys(r.rejected).some((k) => k.startsWith('filter:'))).toBe(true);
  });

  it('diagnoses losses from the trades', () => {
    const scan = scanSignals('XAUUSD', data, { windows: ['london_q', 'ny_q'], sides: 'both', sweepLookback: 36 });
    const r = simulate('XAUUSD', data, scan, { allowGradeA: true, requirePoi: false, requireCorrectHalf: false, requireAlignment: false });
    const d = lossDiagnostics(r.trades);
    expect(d.n).toBe(r.stats.n);
    expect(d.losers.reached1R).toBeLessThanOrEqual(d.losers.reached05R);
    expect(d.losers.neverWorked + d.losers.reached05R).toBeLessThanOrEqual(d.losers.n);
    expect(d.byPlannedR.reduce((a, b) => a + b.n, 0)).toBe(d.n);
  });
});

describe('news schedule', () => {
  it('puts NFP on the first Friday at 08:30 New York and FOMC at 14:00', () => {
    const t = usHighImpactTimes(Date.UTC(2026, 9, 1), Date.UTC(2026, 9, 31));
    const parts = t.map((x) => zonedParts(x, NY));
    expect(parts.some((p) => p.day === 2 && p.weekday === 'Fri' && p.hour === 8 && p.minute === 30)).toBe(true);
    expect(parts.some((p) => p.day === 28 && p.hour === 14)).toBe(true);
  });
});
