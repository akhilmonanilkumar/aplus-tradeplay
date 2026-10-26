import { describe, expect, it } from 'vitest';
import {
  BTCUSDT_PERP_DEFAULT, XAUUSD_DEFAULT, NY_Q, LONDON_Q, IST, UTC,
  breakevenWinRate, churnRate, currentOrNextWindow, evaluateGate, expectancy, fairValueGaps, floorToStep, hhmm,
  hwmFee, hwmSchedule, initialContext, isFxWeekend, isSweep, isolatedLiquidationPrice, marketShift, mrr, pivots,
  planCopies, premiumDiscount, propPayout, rewardToRisk, sizeCfd, sizeMcx, sizePerp, step, structureBreaks, summarize,
  windowOnDateOf, MCX_MULTIPLIER, clientOrderId, type Candle,
} from './index.js';

describe('number helpers', () => {
  it('floors to step without float drift', () => {
    expect(floorToStep(0.24059, 0.001)).toBe(0.24);
    expect(floorToStep(0.0343, 0.01)).toBe(0.03);
    expect(floorToStep(0.3, 0.1)).toBe(0.3);
    expect(floorToStep(1.0000000001, 0.01)).toBe(1);
  });
});

describe('edge maths (spec section 12)', () => {
  it('break-even win rate at 1:3 is 25%', () => {
    expect(breakevenWinRate(3)).toBeCloseTo(0.25, 10);
  });
  it('35% wins at 3R is +0.40R', () => {
    expect(expectancy(0.35, 3)).toBeCloseTo(0.4, 10);
  });
  it('a 0.25R cost drops it to +0.15R and lifts break-even to 31.25%', () => {
    expect(expectancy(0.35, 3, 0.25)).toBeCloseTo(0.15, 10);
    expect(breakevenWinRate(3, 0.25)).toBeCloseTo(0.3125, 10);
  });
});

describe('sessions are anchored to New York (DST-safe)', () => {
  it('NY Q is 16:30–19:30 IST while US is on daylight time', () => {
    const w = windowOnDateOf(Date.UTC(2026, 9, 26, 12), NY_Q); // Mon 26 Oct 2026
    expect(hhmm(w.startUtc, UTC)).toBe('11:00');
    expect(hhmm(w.startUtc, IST)).toBe('16:30');
    expect(hhmm(w.endUtc, IST)).toBe('19:30');
  });
  it('NY Q moves to 17:30–20:30 IST after US DST ends on 1 Nov 2026', () => {
    const w = windowOnDateOf(Date.UTC(2026, 10, 2, 12), NY_Q); // Mon 2 Nov 2026
    expect(hhmm(w.startUtc, UTC)).toBe('12:00');
    expect(hhmm(w.startUtc, IST)).toBe('17:30');
    expect(hhmm(w.endUtc, IST)).toBe('20:30');
  });
  it('London Q after the change is 12:30–15:30 IST', () => {
    const w = windowOnDateOf(Date.UTC(2026, 10, 2, 12), LONDON_Q);
    expect(hhmm(w.startUtc, IST)).toBe('12:30');
    expect(hhmm(w.endUtc, IST)).toBe('15:30');
  });
  it('skips the weekend when looking for the next window', () => {
    const sun = Date.UTC(2026, 9, 25, 10, 0); // Sun 25 Oct 2026, 06:00 ET
    const next = currentOrNextWindow(sun, NY_Q);
    expect(next.weekday).toBe('Mon');
    expect(next.live).toBe(false);
    expect(isFxWeekend(sun)).toBe(true);
  });
});

describe('position sizing', () => {
  it('XAUUSD: $10,284 at 0.5% with a 15.00 stop → 0.03 lot, $45.00 at risk, 3.39R', () => {
    const s = sizeCfd({ balance: 10284, riskPct: 0.5, entry: 4120.6, stop: 4105.6, spec: XAUUSD_DEFAULT });
    expect(s.lots).toBe(0.03);
    expect(s.riskAmount).toBe(45);
    expect(s.lossPerLot).toBe(1500);
    expect(rewardToRisk(4120.6, 4105.6, 4171.4)).toBeCloseTo(3.3867, 3);
  });
  it('XAUUSD below minimum returns zero lots', () => {
    const s = sizeCfd({ balance: 500, riskPct: 0.5, entry: 4120.6, stop: 4105.6, spec: XAUUSD_DEFAULT });
    expect(s.lots).toBe(0);
    expect(s.belowMinimum).toBe(true);
  });
  it('BTCUSDT.P: $8,420.55 at 1%, stop 350 → 0.240 BTC, fees 0.192R, liq 60,948.8 at 10×', () => {
    const s = sizePerp({ balance: 8420.55, riskPct: 1, entry: 67450, stop: 67100, target: 68500, leverage: 10, spec: BTCUSDT_PERP_DEFAULT });
    expect(s.qty).toBe(0.24);
    expect(s.feeR).toBeCloseTo(0.1922, 3);
    expect(s.liquidationPrice).toBeCloseTo(60948.8, 0);
    expect(s.liquidationBeyondStop).toBe(true);
    expect(s.netRAtTarget!).toBeCloseTo(2.8058, 3);
    expect(s.stopPct).toBeCloseTo(0.5189, 3);
  });
  it('liquidation formula matches the closed form for a long', () => {
    const lp = isolatedLiquidationPrice({ walletBalance: 384.465, side: 'long', qty: 0.057, entry: 67450, mmr: 0.004, maintAmount: 0 });
    expect(lp).toBeCloseTo((67450 * (1 - 1 / 10)) / (1 - 0.004), 0);
  });
  it('BTC short 68,920 → 67,765, stop 69,250 nets +3.29R after fees', () => {
    const s = sizePerp({ balance: 4620, riskPct: 1, entry: 68920, stop: 69250, target: 67765, leverage: 5, spec: BTCUSDT_PERP_DEFAULT });
    expect(s.qty).toBe(0.14);
    expect(s.netRAtTarget!).toBeCloseTo(3.293, 2);
  });
  it('MCX GOLDM: ₹5,00,000 at 0.5%, stop ₹170 → 1 lot, ₹1,700 risk', () => {
    const s = sizeMcx({ capital: 500000, riskPct: 0.5, entry: 118410, stop: 118240, multiplier: MCX_MULTIPLIER.GOLDM });
    expect(s.lots).toBe(1);
    expect(s.riskAmount).toBe(1700);
  });
});

describe('fees and payouts', () => {
  it('HWM fee only charges profit above the mark', () => {
    const rows = hwmSchedule(5000, [5240, 4880, 5612.4], 0.2);
    expect(rows.map((r) => r.fee)).toEqual([48, 0, 122.48]);
    expect(rows.map((r) => r.toInvestor)).toEqual([192, 0, 489.92]);
    expect(rows[2]!.start).toBe(4880);
  });
  it('accrued fee if closed today', () => {
    expect(hwmFee({ navEnd: 5061.2, hwm: 5000, rate: 0.2 }).fee).toBe(12.24);
  });
  it('prop payout: $1,200 profit, 80% split, 20% commission → $768 to investor', () => {
    expect(propPayout({ profit: 1200, firmSplit: 0.8, ourRate: 0.2 })).toEqual({ firmPays: 960, firmKeeps: 240, commission: 192, toInvestor: 768 });
  });
  it('subscription MRR and churn', () => {
    expect(mrr([{ price: 1499, months: 1, active: 96 }, { price: 3999, months: 3, active: 46 }])).toBe(205222);
    expect(churnRate(88, 81, 27)).toBeCloseTo(0.1598, 3);
  });
});

describe('stats', () => {
  it('summarizes R results', () => {
    const s = summarize([3, -1, -1, 3.39, -1]);
    expect(s.n).toBe(5);
    expect(s.winRate).toBeCloseTo(0.4, 10);
    expect(s.netR).toBeCloseTo(3.39, 10);
    expect(s.profitFactor).toBeCloseTo(6.39 / 3, 10);
    expect(s.maxDrawdownR).toBe(2);
    expect(s.longestLosingStreak).toBe(2);
  });
});

/* ---------- market structure ---------- */
function bar(t: number, o: number, h: number, l: number, c: number): Candle { return { t, o, h, l, c }; }

describe('market structure', () => {
  // swing high 113 (i2) → swing low 103 (i4) → lower high 109 (i6) → BOS down (i7) → low 99 (i8) → body close above 109 (i11)
  const down: Candle[] = [
    bar(0, 110, 111, 108, 109), bar(1, 109, 110, 107, 108), bar(2, 108, 113, 107.5, 112), bar(3, 112, 112, 106, 107),
    bar(4, 107, 108, 103, 104), bar(5, 104, 107, 103.5, 106), bar(6, 106, 109, 105, 108.5), bar(7, 108.5, 108, 102, 102.5),
    bar(8, 102.5, 103, 99, 100), bar(9, 100, 102, 100, 101.5), bar(10, 101.5, 104, 100.5, 103.5), bar(11, 103.5, 110, 103, 109.8),
  ];
  it('finds confirmed pivots', () => {
    const p = pivots(down, 2, 2);
    expect(p.some((x) => x.kind === 'high' && x.index === 2 && x.price === 113)).toBe(true);
    expect(p.some((x) => x.kind === 'high' && x.index === 6 && x.price === 109)).toBe(true);
    expect(p.some((x) => x.kind === 'low' && x.index === 4 && x.price === 103)).toBe(true);
  });
  it('flags a CHoCH when a body closes above the last lower high in a downtrend', () => {
    const { breaks, trend } = structureBreaks(down, 2, 2);
    expect(breaks.some((b) => b.kind === 'BOS' && b.direction === 'down')).toBe(true);
    const last = breaks[breaks.length - 1]!;
    expect(last.direction).toBe('up');
    expect(last.kind).toBe('CHoCH');
    expect(last.level).toBe(109);
    expect(last.index).toBe(11);
    expect(trend).toBe('up');
  });
  it('detects a sell-side sweep and the market shift after it', () => {
    expect(isSweep(bar(0, 100, 101, 96.5, 99), 97, 'sell_side')).toBe(true);
    expect(isSweep(bar(0, 100, 101, 96.5, 96.8), 97, 'sell_side')).toBe(false);
    const ms = marketShift(down, 'long', 8, 2, 2);
    expect(ms?.level).toBe(109);
    expect(ms?.index).toBe(11);
  });
  it('finds fair value gaps and tracks mitigation', () => {
    const c = [bar(0, 10, 11, 9, 10.5), bar(1, 10.5, 14, 10.4, 13.8), bar(2, 13.8, 15, 12, 14.5), bar(3, 14.5, 14.6, 11.5, 12)];
    const g = fairValueGaps(c);
    expect(g[0]).toMatchObject({ direction: 'up', bottom: 11, top: 12, touchedAt: 3, filledAt: null });
  });
  it('premium / discount with a mid band', () => {
    expect(premiumDiscount(4096, 4176.4, 4120.6).zone).toBe('discount');
    expect(premiumDiscount(4096, 4176.4, 4120.6).eq).toBeCloseTo(4136.2, 6);
    expect(premiumDiscount(4096, 4176.4, 4137).zone).toBe('mid');
  });
});

describe('A+ gate', () => {
  const base = {
    htfTrend: 'up' as const, poiTfTrend: 'up' as const, side: 'long' as const, price: 4121.8,
    range: { low: 4096, high: 4176.4 }, poi: { inside: true, fresh: true, trendAligned: true, liquidityStory: true },
    swept: true, shifted: true, timing: { inWindow: true, newsClear: true },
    plan: { entry: 4120.6, stop: 4105.6, target: 4171.4, targetIsStructural: true },
  };
  it('all 7 boxes → A+ GO', () => {
    const r = evaluateGate(base);
    expect(r.grade).toBe('A+');
    expect(r.verdict).toBe('GO');
    expect(r.rr).toBeCloseTo(3.387, 2);
  });
  it('boxes 1–4 pass, shift pending → FORMING with a waiting-for list', () => {
    const r = evaluateGate({ ...base, shifted: false, plan: undefined });
    expect(r.grade).toBe('FORMING');
    expect(r.waitingFor.length).toBe(2);
  });
  it('mid-range, news window, sub-3R and counter-trend all fail', () => {
    expect(evaluateGate({ ...base, plan: { ...base.plan, entry: 4137 } }).boxes[1]!.status).toBe('fail');
    expect(evaluateGate({ ...base, timing: { inWindow: true, newsClear: false } }).verdict).toBe('NO');
    expect(evaluateGate({ ...base, plan: { ...base.plan, target: 4150 } }).boxes[6]!.status).toBe('fail');
    expect(evaluateGate({ ...base, htfTrend: 'down', poiTfTrend: 'down' }).boxes[0]!.reason).toMatch(/counter-trend/);
  });
  it('BTC stop under 0.4% fails box 7', () => {
    const r = evaluateGate({ ...base, minStopPct: 0.4, plan: { entry: 67450, stop: 67300, target: 67900, targetIsStructural: true }, range: { low: 60000, high: 80000 }, price: 67450 });
    expect(r.boxes[6]!.reason).toMatch(/minimum/);
  });
  it('quality concern drops A+ to A (log only)', () => {
    expect(evaluateGate({ ...base, qualityConcern: 'obstacle at 4,150 FVG' }).grade).toBe('A');
  });
});

describe('copilot state machine', () => {
  it('walks IDLE → ARMED → FILLED and enforces the 2-loss stop', () => {
    let c = initialContext();
    for (const e of [{ type: 'PLAN_SAVED', invalidation: 4096, poiCount: 2 }, { type: 'ENTER_POI' }, { type: 'SWEEP' }, { type: 'SHIFT' }, { type: 'GATE_PASS' }, { type: 'FILLED' }] as const) c = step(c, e);
    expect(c.state).toBe('FILLED');
    c = step(c, { type: 'TRADE_CLOSED', resultR: -1 });
    expect(c.state).toBe('PLANNED');
    c = step(c, { type: 'TRADE_CLOSED', resultR: -1 });
    expect(c.state).toBe('INVALID');
    expect(c.reason).toMatch(/2 losses/);
    expect(step(c, { type: 'NEW_DAY' }).state).toBe('IDLE');
  });
  it('rejects a plan without an invalidation and a shift that ran away', () => {
    expect(step(initialContext(), { type: 'PLAN_SAVED', invalidation: null, poiCount: 1 }).state).toBe('INVALID');
    let c = initialContext();
    for (const e of [{ type: 'PLAN_SAVED', invalidation: 1, poiCount: 1 }, { type: 'ENTER_POI' }, { type: 'SWEEP' }, { type: 'SHIFT' }, { type: 'RAN_AWAY' }] as const) c = step(c, e);
    expect(c.reason).toBe('no pullback, no trade');
  });
});

describe('copy engine sizing + guard', () => {
  const order = { entry: 4120.6, stop: 4105.6, target: 4171.4 };
  const cfd = { kind: 'cfd' as const, spec: XAUUSD_DEFAULT };
  it('sizes each account on its own equity and maps policy to action', () => {
    const d = planCopies(order, [
      { id: 'rahul', name: 'Rahul · The5ers 10K', policy: 'AUTO', balance: 10212.4, riskPct: 0.5, instrument: cfd },
      { id: 'fh5', name: 'FundedHive 5K', policy: 'CONFIRM', balance: 5212.3, riskPct: 0.5, instrument: cfd },
      { id: 'small', name: 'Small', policy: 'AUTO', balance: 900, riskPct: 0.5, instrument: cfd },
    ]);
    expect(d[0]).toMatchObject({ action: 'SEND', size: 0.03, riskAmount: 45 });
    expect(d[1]).toMatchObject({ action: 'CONFIRM', size: 0.01, riskAmount: 15 });
    expect(d[2]!.action).toBe('BLOCK');
  });
  it('shrinks an order that would use more than half the daily room, never enlarges', () => {
    const [d] = planCopies(order, [{ id: 'p', name: 'Prop', policy: 'AUTO', balance: 10000, riskPct: 1, instrument: cfd, dailyLossRoom: 60 }]);
    expect(d!.shrunk).toBe(true);
    expect(d!.riskAmount).toBeLessThanOrEqual(30);
  });
  it('builds stable idempotency keys', () => {
    expect(clientOrderId('sig-123456789', 'acc1')).toBe(clientOrderId('sig-123456789', 'acc1'));
    expect(clientOrderId('sig-123456789', 'acc1')).not.toBe(clientOrderId('sig-123456789', 'acc2'));
  });
});

describe('gate box 1 switches', () => {
  const base = {
    side: 'short' as const, price: 105, range: { low: 90, high: 110 },
    poi: { inside: true, fresh: true, trendAligned: true, liquidityStory: true, createdBos: true },
    swept: true, shifted: true, timing: { inWindow: true, newsClear: true },
    plan: { entry: 105, stop: 106, target: 100, targetIsStructural: true, stopIsStructural: true },
  };
  it('fails a counter-trend trade unless the HTF trend is not required', () => {
    const on = evaluateGate({ ...base, htfTrend: 'up', poiTfTrend: 'up' });
    expect(on.boxes[0]!.status).toBe('fail');
    const noAlign = evaluateGate({ ...base, htfTrend: 'up', poiTfTrend: 'down', config: { poiAlignRequired: false } });
    expect(noAlign.boxes[0]!.status).toBe('fail');
    const off = evaluateGate({ ...base, htfTrend: 'up', poiTfTrend: 'up', config: { htfTrendRequired: false } });
    expect(off.boxes[0]!.status).toBe('pass');
    expect(off.verdict).toBe('GO');
  });
  it('does not wait for a 15M trend when alignment is not required', () => {
    const g = evaluateGate({ ...base, htfTrend: 'down', poiTfTrend: null, config: { poiAlignRequired: false } });
    expect(g.boxes[0]!.status).toBe('pass');
  });
});
