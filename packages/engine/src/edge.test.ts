import { describe, expect, it } from 'vitest';
import {
  ASIA_Q, ENTRY_MODELS, canChangeRules, complianceRate, dailyBias, diagnose, evaluateGate, guardrails, inducementSwept,
  normalizeModel, orderBlocks, personalLimits, previousDayLevels, riskDeviation, riskForGrade, sessionRange, summarize,
  type Candle, type GateInput,
} from './index.js';

const base: GateInput = {
  htfTrend: 'up', poiTfTrend: 'up', side: 'long', price: 4121.8,
  range: { low: 4096, high: 4176.4 }, poi: { inside: true, fresh: true, trendAligned: true, liquidityStory: true, createdBos: true },
  swept: true, shifted: true, timing: { inWindow: true, newsClear: true, windowId: 'ny_q' },
  plan: { entry: 4120.6, stop: 4105.6, target: 4171.4, targetIsStructural: true, stopIsStructural: true },
};

describe('A+ filter refinements (Trade Finder Pro §5)', () => {
  it('HTF vs 15M disagreement is a wait, not a fail', () => {
    const r = evaluateGate({ ...base, poiTfTrend: 'down' });
    expect(r.boxes[0]!.status).toBe('pending');
    expect(r.boxes[0]!.reason).toMatch(/wait for alignment/);
    expect(r.verdict).toBe('WAIT');
  });
  it('one soft miss (no liquidity story) grades A, two soft misses = no trade', () => {
    const a = evaluateGate({ ...base, poi: { ...base.poi, liquidityStory: false } });
    expect(a.boxes[2]!.status).toBe('warn');
    expect(a.grade).toBe('A');
    expect(a.verdict).toBe('WAIT');
    const no = evaluateGate({ ...base, poi: { ...base.poi, liquidityStory: false, createdBos: false } });
    expect(no.grade).toBe('NO_TRADE');
  });
  it('soft miss + quality concern = more than one A+ trigger missing → no trade', () => {
    const r = evaluateGate({ ...base, poi: { ...base.poi, liquidityStory: false }, qualityConcern: 'obstacle before target' });
    expect(r.grade).toBe('NO_TRADE');
    expect(r.blockers).toContain('misses more than one A+ trigger');
  });
  it('a random stop fails box 7', () => {
    expect(evaluateGate({ ...base, plan: { ...base.plan!, stopIsStructural: false } }).boxes[6]!.status).toBe('fail');
  });
  it('automatic no-trade conditions block an otherwise perfect setup', () => {
    for (const conditions of [{ capReached: 'stopped after 2 losses' }, { emotional: true }, { illiquid: true }, { ranAway: true }]) {
      const r = evaluateGate({ ...base, conditions });
      expect(r.verdict).toBe('NO');
      expect(r.blockers.length).toBeGreaterThan(0);
    }
  });
  it('price outside the dealing range fails box 2 and the bias stands aside', () => {
    const r = evaluateGate({ ...base, price: 4090, plan: { ...base.plan!, entry: 4090, stop: 4080, target: 4140 } });
    expect(r.boxes[1]!.status).toBe('fail');
    expect(r.boxes[1]!.reason).toMatch(/below the range/);
    const b = dailyBias({ range: { low: 4096, high: 4176.4 }, price: 4090, htfTrend: 'up', liquidity: {}, narrative: 'continuation', invalidation: 4080 });
    expect(b.allowed).toBeNull();
    expect(b.outside).toBe('below');
  });
  it('mid-range is named in the reason', () => {
    expect(evaluateGate({ ...base, plan: { ...base.plan!, entry: 4137 } }).boxes[1]!.reason).toMatch(/mid-range/);
  });
});

describe('entry models A–I', () => {
  it('nine models, legacy CT1 maps to G', () => {
    expect(Object.keys(ENTRY_MODELS)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']);
    expect(normalizeModel('CT1')).toBe('G');
    expect(normalizeModel(null)).toBe('A');
  });
  it('A: default model passes on the classic sequence', () => {
    expect(evaluateGate(base).grade).toBe('A+');
  });
  it('B: needs the failed opposing zone', () => {
    expect(evaluateGate({ ...base, model: 'B' }).boxes[4]!.status).toBe('pending');
    expect(evaluateGate({ ...base, model: 'B', modelChecks: { failed_opposing_zone: true } }).grade).toBe('A+');
  });
  it('C: OB with FVG is required at the POI', () => {
    expect(evaluateGate({ ...base, model: 'C', modelChecks: { ob_fvg: false } }).boxes[2]!.status).toBe('fail');
    expect(evaluateGate({ ...base, model: 'C', modelChecks: { ob_fvg: true } }).grade).toBe('A+');
  });
  it('D: the first tap must be swept before entry', () => {
    const r = evaluateGate({ ...base, model: 'D' });
    expect(r.boxes[3]!.status).toBe('pending');
    expect(evaluateGate({ ...base, model: 'D', modelChecks: { first_tap_swept: true } }).grade).toBe('A+');
  });
  it('E: gold only; aggressive sweep entry only when enabled, and capped at A', () => {
    expect(evaluateGate({ ...base, model: 'E', instrument: 'BTCUSDT.P' }).verdict).toBe('NO');
    const strict = evaluateGate({ ...base, model: 'E', instrument: 'XAUUSD', shifted: false });
    expect(strict.boxes[4]!.status).toBe('pending');
    const aggressive = evaluateGate({ ...base, model: 'E', instrument: 'XAUUSD', shifted: false, config: { aggressiveEntryAllowed: true } });
    expect(aggressive.boxes[4]!.status).toBe('warn');
    expect(aggressive.grade).toBe('A');
  });
  it('F: Asia sweep trades the London window only', () => {
    const ok = evaluateGate({ ...base, model: 'F', modelChecks: { asia_swept: true }, timing: { inWindow: true, newsClear: true, windowId: 'london_q' } });
    expect(ok.grade).toBe('A+');
    const ny = evaluateGate({ ...base, model: 'F', modelChecks: { asia_swept: true } });
    expect(ny.boxes[5]!.status).toBe('fail');
  });
  it('G: counter-trend scalp is blocked by default and never A+ when allowed', () => {
    const short = { ...base, side: 'short' as const, plan: { entry: 4160, stop: 4170, target: 4128, targetIsStructural: true, stopIsStructural: true }, price: 4160 };
    expect(evaluateGate({ ...short, model: 'G' }).verdict).toBe('NO');
    const r = evaluateGate({ ...short, model: 'G', modelChecks: { fractal_shift: true }, config: { counterTrendAllowed: true, advancedModelsAllowed: true } });
    expect(r.boxes[0]!.status).toBe('warn');
    expect(r.grade).toBe('A');
  });
  it('H: sniper is advanced-only and never A+', () => {
    expect(evaluateGate({ ...base, model: 'H', modelChecks: { fractal_shift: true } }).verdict).toBe('NO');
    expect(evaluateGate({ ...base, model: 'H', modelChecks: { fractal_shift: true }, config: { advancedModelsAllowed: true } }).grade).toBe('A');
  });
  it('I: post-news waits 30 minutes after the release', () => {
    const cfg = { advancedModelsAllowed: true };
    expect(evaluateGate({ ...base, model: 'I', config: cfg, timing: { inWindow: true, newsClear: false, minutesSinceNews: 12 } }).boxes[5]!.status).toBe('pending');
    expect(evaluateGate({ ...base, model: 'I', config: cfg, timing: { inWindow: true, newsClear: false, minutesSinceNews: 45 } }).grade).toBe('A+');
  });
});

describe('daily bias in five steps', () => {
  const input = { range: { low: 4096, high: 4176.4 }, price: 4110, htfTrend: 'up' as const, liquidity: { pdh: 4150, pdl: 4100, eqh: 4160 }, narrative: 'continuation' as const, target: 4150, invalidation: 4096 };
  it('discount + up-trend allows longs; magnet is the nearest buy-side pool', () => {
    const b = dailyBias(input);
    expect(b.zone).toBe('discount');
    expect(b.allowed).toBe('long');
    expect(b.magnet).toMatchObject({ label: 'PDH', level: 4150, side: 'buy_side' });
    expect(b.valid).toBe(true);
    expect(b.statement).toBe('My bias is wrong if price closes and holds below 4,096');
  });
  it('no invalidation = no bias; mid-range = stand aside; counter-trend side is refused', () => {
    expect(dailyBias({ ...input, invalidation: null }).valid).toBe(false);
    expect(dailyBias({ ...input, price: 4136 }).allowed).toBeNull();
    expect(dailyBias({ ...input, htfTrend: 'down' }).allowed).toBeNull();
  });
});

const C = (t: number, o: number, h: number, l: number, c: number): Candle => ({ t, o, h, l, c });

describe('zones and session liquidity', () => {
  it('order block: last opposite candle before a BOS displacement, with liquidity taken and an FVG', () => {
    const cs = [C(0, 105, 106, 104, 104.5), C(1, 104.5, 107, 104, 106.5), C(2, 106.5, 108, 105, 105.5), C(3, 105.5, 106, 102, 102.5), C(4, 102.6, 109, 102.4, 108.8), C(5, 108.8, 110, 106.5, 109.5), C(6, 109.5, 110, 105.5, 106)];
    const obs = orderBlocks(cs, 1, 1);
    const ob = obs.find((o) => o.direction === 'up')!;
    expect(ob).toMatchObject({ index: 3, top: 106, bottom: 102, tookLiquidity: true, hasImbalance: true, breakIndex: 4, mitigatedAt: 6 });
  });
  it('Asia range is 20:00–24:00 New York', () => {
    const h = 3_600_000, t0 = Date.UTC(2026, 9, 27, 0); // 20:00 NY on Mon 26 Oct (EDT)
    const cs = [C(t0, 8, 10, 5, 9), C(t0 + h, 9, 12, 6, 11), C(t0 + 2 * h, 11, 11, 4, 5), C(t0 + 3 * h, 5, 9, 7, 8), C(t0 + 4 * h, 8, 99, 1, 50)];
    expect(sessionRange(cs, ASIA_Q, Date.UTC(2026, 9, 26, 18))).toMatchObject({ high: 12, low: 4 });
  });
  it('PDH / PDL use the 17:00 New York roll', () => {
    const cs = [C(Date.UTC(2026, 9, 26, 14), 45, 50, 40, 48), C(Date.UTC(2026, 9, 26, 20), 48, 55, 45, 50), C(Date.UTC(2026, 9, 26, 22), 65, 70, 60, 66)];
    expect(previousDayLevels(cs, Date.UTC(2026, 9, 27, 12))).toEqual({ pdh: 55, pdl: 40 });
  });
  it('model D inducement: first tap, then a sweep of that tap', () => {
    const cs = [C(0, 106, 107, 105, 106), C(1, 104, 104.5, 101.5, 103), C(2, 103, 104, 103, 103.5), C(3, 103.5, 104, 100.8, 102)];
    expect(inducementSwept(cs, { top: 102, bottom: 100 }, 'long')).toEqual({ firstTap: 1, sweep: 3 });
  });
});

describe('risk guardrails (§10–11)', () => {
  it('daily loss cap, trade cap, profit cap and drawdown pause', () => {
    expect(guardrails({ dayStartBalance: 10000, equity: 9790, peakEquity: 10000, tradesToday: 1, lossesToday: 1 }).reasons).toContain('daily loss cap 2% hit');
    expect(guardrails({ dayStartBalance: 10000, equity: 10000, peakEquity: 10000, tradesToday: 2, lossesToday: 0 }).canTrade).toBe(false);
    expect(guardrails({ dayStartBalance: 10000, equity: 10105, peakEquity: 10105, tradesToday: 1, lossesToday: 0, dailyProfitCapPct: 1 }).reasons[0]).toMatch(/profit cap/);
    expect(guardrails({ dayStartBalance: 9100, equity: 9100, peakEquity: 10000, tradesToday: 0, lossesToday: 0 }).reasons[0]).toMatch(/drawdown 9.0%/);
    const ok = guardrails({ dayStartBalance: 10000, equity: 9950, peakEquity: 10000, tradesToday: 1, lossesToday: 1 });
    expect(ok.canTrade).toBe(true);
    expect(ok.lossRoom).toBe(150);
  });
  it('variable risk only after 100 proven trades; A at base; B/C zero', () => {
    expect(riskForGrade('A+', { variable: true, provenTrades: 50 })).toBe(0.5);
    expect(riskForGrade('A+', { variable: true, provenTrades: 120 })).toBe(1);
    expect(riskForGrade('A')).toBe(0.5);
    expect(riskForGrade('NO_TRADE')).toBe(0);
  });
  it('personal limits are tighter than the firm', () => {
    expect(personalLimits({ dailyLossPct: 5, maxLossPct: 10 })).toEqual({ dailyLossPct: 2, maxDrawdownPct: 5 });
    expect(personalLimits({ dailyLossPct: 3, maxLossPct: 6 })).toEqual({ dailyLossPct: 1.5, maxDrawdownPct: 3 });
  });
});

describe('review (§13)', () => {
  it('compliance and risk deviation', () => {
    expect(complianceRate([{ planFollowed: true }, { planFollowed: true }, { planFollowed: false }, { planFollowed: true }])).toBe(0.75);
    expect(riskDeviation([50, 50, 60, 40], 50)).toBeCloseTo(0.1, 10);
  });
  it('rule of 100', () => {
    expect(canChangeRules(20, 1).ok).toBe(false);
    expect(canChangeRules(40, 1).ok).toBe(false);
    expect(canChangeRules(40, 3).ok).toBe(true);
    expect(canChangeRules(120, 1).ok).toBe(true);
  });
  it('if-then diagnosis', () => {
    const s = summarize([1.2, 1.1, -1, 1.3, 1.0, -1, 1.5, 1.2, -1, 1.1, 1.4, 1.0]);
    const d = diagnose(s, { compliance: 0.8, riskDev: 0.3 });
    expect(d.some((x) => /cutting winners/.test(x))).toBe(true);
    expect(d.some((x) => /standardise sizing/.test(x))).toBe(true);
    expect(d.some((x) => /80%/.test(x))).toBe(true);
  });
});
