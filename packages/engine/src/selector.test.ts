import { describe, expect, it } from 'vitest';
import { DEFAULT_SELECTOR, scoreCandidate, selectOpportunities, type Candidate } from './index.js';

const base: Candidate = {
  instrument: 'XAUUSD', side: 'long', state: 'ARMED', grade: 'A+', verdict: 'GO', blockers: [],
  rr: 3.5, entry: 4000, stop: 3990, target: 4035, price: 4002, window: 'ny_q',
  context: 40, caution: [], edge: { avgR: 0.4, n: 12, winRate: 0.4 },
};
const c = (o: Partial<Candidate>): Candidate => ({ ...base, ...o });

describe('opportunity selector', () => {
  it('scores an armed A+ setup in the killzone with supportive context highly', () => {
    const s = scoreCandidate(base);
    expect(s.eligible).toBe(true);
    expect(s.parts.quality).toBe(40);
    expect(s.parts.timing).toBe(10);
    expect(s.score).toBeGreaterThanOrEqual(75);
    expect(s.score).toBeLessThanOrEqual(100);
  });

  it('never makes a non-armed setup eligible, however good the context', () => {
    const s = scoreCandidate(c({ state: 'SHIFTED', verdict: 'WAIT', grade: 'FORMING', context: 100 }));
    expect(s.eligible).toBe(false);
    expect(s.reasons[0]).toMatch(/not armed/);
    expect(scoreCandidate(c({ verdict: 'NO', grade: 'NO_TRADE', gateReason: 'outside the London/NY windows' })).reasons[0]).toBe('no trade: outside the London/NY windows');
  });

  it('takes grade A only when allowed and without blockers', () => {
    const a = c({ verdict: 'WAIT', grade: 'A' });
    expect(scoreCandidate(a).eligible).toBe(false);
    expect(scoreCandidate(a, { ...DEFAULT_SELECTOR, allowGradeA: true }).eligible).toBe(true);
    expect(scoreCandidate({ ...a, blockers: ['news'] }, { ...DEFAULT_SELECTOR, allowGradeA: true }).eligible).toBe(false);
  });

  it('rejects strongly opposing context and a proven negative recent edge', () => {
    expect(scoreCandidate(c({ context: -60 })).reasons.join()).toMatch(/context against/);
    expect(scoreCandidate(c({ edge: { avgR: -0.6, n: 20, winRate: 0.1 } })).reasons.join()).toMatch(/edge negative/);
    // A thin sample is shrunk to neutral rather than trusted.
    const thin = scoreCandidate(c({ edge: { avgR: -0.6, n: 2, winRate: 0 } }));
    expect(thin.reasons.join()).not.toMatch(/edge/);
    expect(thin.parts.edge).toBeGreaterThan(5);
  });

  it('caution flags lower the score', () => {
    expect(scoreCandidate(c({ caution: ['crowded', 'top traders'] })).score).toBe(scoreCandidate(base).score - 8);
  });

  it('picks the best setup per desk and never doubles the same underlying', () => {
    const { picks, ranked } = selectOpportunities([
      c({ instrument: 'XAUUSD', context: 10 }),
      c({ instrument: 'XAUUSDT.P', context: 80 }),
      c({ instrument: 'BTCUSDT.P', side: 'short', context: 30 }),
      c({ instrument: 'BTCUSD', state: 'SWEPT', verdict: 'WAIT', grade: 'WATCHING' }),
    ]);
    expect(picks.map((p) => p.instrument)).toEqual(['XAUUSDT.P', 'BTCUSDT.P']);
    expect(ranked.find((r) => r.instrument === 'XAUUSD')!.reasons.join()).toMatch(/lower score than the gold pick/);
    expect(ranked.at(-1)!.instrument).toBe('BTCUSD');
  });

  it('respects busy desks and the daily budget', () => {
    const list = [c({ instrument: 'XAUUSD' }), c({ instrument: 'BTCUSDT.P', context: 0 })];
    expect(selectOpportunities(list, { busyDesks: new Set(['gold']) }).picks.map((p) => p.instrument)).toEqual(['BTCUSDT.P']);
    const one = selectOpportunities(list, { slots: 1 });
    expect(one.picks).toHaveLength(1);
    expect(one.ranked.find((r) => r.instrument === 'BTCUSDT.P')!.reasons).toContain('daily limit reached');
  });
});
