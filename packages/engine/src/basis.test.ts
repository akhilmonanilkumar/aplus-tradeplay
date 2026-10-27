import { describe, expect, it } from 'vitest';
import { basisPnl, basisSignal, breakEvenSettlements, settlementApr, fundingForShort, roundTripCost } from './index.js';

const rules = { entryRate: 0.0001, exitRate: 0, spotFee: 0.001, perpFee: 0.0005 };
const leg = { qty: 0.1, spotEntry: 100_000, perpEntry: 100_050, spotFee: 0.001, perpFee: 0.0005 };

describe('basis trade', () => {
  it('pays the short when funding is positive and charges it when negative', () => {
    expect(fundingForShort(0.1, 100_000, 0.0001)).toBeCloseTo(1);
    expect(fundingForShort(0.1, 100_000, -0.0002)).toBeCloseTo(-2);
  });
  it('is delta neutral: a parallel move in spot and perp leaves the basis P&L at zero', () => {
    const p = { ...leg, funding: 0, openedAt: 0 };
    const up = basisPnl(p, 110_000, 110_050, 86_400_000);
    expect(up.basis).toBeCloseTo(0, 6);
  });
  it('measures R against the round-trip cost and nets funding against fees', () => {
    const cost = roundTripCost(leg);
    expect(cost).toBeCloseTo(2 * 0.1 * (100_000 * 0.001 + 100_050 * 0.0005));
    const p = basisPnl({ ...leg, funding: 3 * cost, openedAt: 0 }, 100_000, 100_050, 10 * 86_400_000);
    expect(p.net).toBeCloseTo(2 * cost, 6); // three costs earned, one paid
    expect(p.r).toBeCloseTo(2, 6);
    expect(p.apr).toBeCloseTo(((3 * cost) / 10_000) * 36.5, 6);
  });
  it('enters on positive carry with a positive 3-day average and exits when funding turns negative', () => {
    expect(basisSignal(false, { predicted: 0.00012, lastSettled: 0.0001, avg3d: 0.00008 }, rules)).toBe('enter');
    expect(basisSignal(false, { predicted: 0.00012, lastSettled: 0.0001, avg3d: -0.00001 }, rules)).toBe('wait');
    expect(basisSignal(false, { predicted: 0.00005, lastSettled: 0.0001, avg3d: 0.0001 }, rules)).toBe('wait');
    expect(basisSignal(true, { predicted: 0.00003, lastSettled: 0.00002, avg3d: 0.0001 }, rules)).toBe('hold');
    expect(basisSignal(true, { predicted: -0.00001, lastSettled: 0.00002, avg3d: 0.0001 }, rules)).toBe('exit');
    expect(basisSignal(true, { predicted: 0.00001, lastSettled: -0.00002, avg3d: 0.0001 }, rules)).toBe('exit');
  });
  it('counts the settlements needed to repay the round trip', () => {
    expect(breakEvenSettlements(0.0001, rules)).toBe(30);
    expect(breakEvenSettlements(-0.0001, rules)).toBeNull();
    expect(settlementApr(0.0001)).toBeCloseTo(0.1095);
  });
});
