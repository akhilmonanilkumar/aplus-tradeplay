import { describe, expect, it } from 'vitest';
import { basisAllocation, basisPnl, basisSignal, breakEvenSettlements, liquidationBuffer, marginTopUp, maxLeverageFor, settlementApr, fundingForShort, roundTripCost, shortLiquidationPrice } from './index.js';

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
  it('enters and exits on the funding average, holding through single negative prints', () => {
    const r = { entryRate: 0.00005, exitRate: 0 };
    expect(basisSignal(false, { predicted: 0.0001, lastSettled: 0.0001, avg3d: 0.00006 }, r)).toBe('enter');
    expect(basisSignal(false, { predicted: -0.00001, lastSettled: 0.0001, avg3d: 0.00008 }, r)).toBe('wait');
    expect(basisSignal(false, { predicted: 0.0001, lastSettled: 0.0001, avg3d: 0.00004 }, r)).toBe('wait');
    // One negative print with the 3-day average still positive: hold.
    expect(basisSignal(true, { predicted: -0.00002, lastSettled: -0.00001, avg3d: 0.00003 }, r)).toBe('hold');
    expect(basisSignal(true, { predicted: 0.00001, lastSettled: 0.00001, avg3d: -0.000001 }, r)).toBe('exit');
    // The 7-day average wins over the 3-day one when present.
    expect(basisSignal(true, { predicted: -0.00001, lastSettled: -0.00001, avg3d: -0.00002, avg7d: 0.00002 }, r)).toBe('hold');
  });
  it('counts the settlements needed to repay the round trip', () => {
    expect(breakEvenSettlements(0.0001, rules)).toBe(30);
    expect(breakEvenSettlements(-0.0001, rules)).toBeNull();
    expect(settlementApr(0.0001)).toBeCloseTo(0.1095);
  });
});

describe('basis account', () => {
  it('splits capital by leverage and finds the liquidation buffer', () => {
    const a = basisAllocation({ capital: 1000, leverage: 1 });
    expect(a.notional).toBeCloseTo(500);
    expect(a.margin).toBeCloseTo(500);
    const qty = a.notional / 100;
    const liq = shortLiquidationPrice(100, qty, a.margin, 0.005);
    expect(liquidationBuffer(100, liq)).toBeCloseTo(2 / 1.005 - 1, 6);
    expect(maxLeverageFor(liquidationBuffer(100, liq), 0.005)).toBeCloseTo(1, 6);
  });
  it('tops up margin to restore the buffer after a rise', () => {
    const qty = 5, margin = 250; // 2x on 500 notional at 100
    const add = marginTopUp(130, qty, margin, 100, 0.005, 1);
    const liq = shortLiquidationPrice(100, qty, margin + add, 0.005);
    expect(liquidationBuffer(130, liq)).toBeCloseTo(1, 6);
    expect(marginTopUp(100, qty, 1000, 100, 0.005, 0.5)).toBe(0);
  });
});
