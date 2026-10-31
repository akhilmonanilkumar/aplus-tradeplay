import { describe, expect, it } from 'vitest';
import { PROP_PRESETS, propRoom, propSize, type PropState } from './prop.js';
import { CTRADER_SPECS, ctraderExpiry, ctraderSignalLink, toCTraderSymbol, valuePerPointPerLot } from './ctrader.js';

const FH = PROP_PRESETS.fundedhive_1step_low!;
const T5 = PROP_PRESETS.the5ers_summer_2step_10_5!;
const base: PropState = { startBalance: 100_000, balance: 104_000, equity: 104_180, dayStartBalance: 103_460, dailyPnl: [1500, 900, -400, 1300, 540] };

describe('propRoom', () => {
  it('FundedHive: static 5% daily from the day-start balance, static 10% max, 1% per trade', () => {
    const r = propRoom(FH, base);
    expect(r.target).toBe(10_000);
    expect(r.progress).toBe(4180);
    expect(r.dailyLimit).toBe(5000);
    expect(r.dailyFloor).toBe(98_460);
    expect(r.dailyRoom).toBe(5720);
    expect(r.maxFloor).toBe(90_000);
    expect(r.maxRoom).toBe(14_180);
    expect(r.perTradeCap).toBe(1000);
    expect(r.profitableDays).toBe(4);
    expect(r.passed).toBe(false);
  });
  it('The5ers: 3% of the higher of yesterday’s EOD equity and balance', () => {
    const r = propRoom(T5, { ...base, equity: 101_000, prevEodEquity: 101_400, prevEodBalance: 101_200 });
    expect(r.dailyLimit).toBeCloseTo(3042);
    expect(r.dailyFloor).toBeCloseTo(98_358);
    expect(r.dailyRoom).toBeCloseTo(2642);
    expect(r.maxFloor).toBe(90_000);
    expect(r.phaseName).toBe('Phase 1');
  });
  it('flags breaches and passes', () => {
    expect(propRoom(FH, { ...base, equity: 98_000 }).breached).toEqual(['daily loss']);
    expect(propRoom(FH, { ...base, equity: 110_500 }).passed).toBe(true);
    expect(propRoom(FH, { ...base, equity: 110_500, dailyPnl: [10_500] }).passed).toBe(false); // only 1 profitable day of 3
  });
  it('trailing max loss follows the peak balance, capped', () => {
    const r = propRoom({ ...FH, maxLossType: 'trailing' }, { ...base, peakBalance: 105_000 });
    expect(r.maxFloor).toBe(95_000);
  });
});

describe('propSize', () => {
  const xau = { riskPct: 0.5, entry: 4031.9, stop: 4024.4, target: 4054.4, valuePerPointPerLot: 100, lotStep: 0.01, minLot: 0.01 };
  it('sizes gold at 0.5% risk and splits into two legs', () => {
    const r = propSize(FH, base, propRoom(FH, base), xau);
    // 0.5% of 104,180 = 520.9; per lot risk = 7.5 × 100 = 750 → 0.69 lots
    expect(r.lots).toBe(0.69);
    expect(r.legs).toEqual([0.34, 0.35]);
    expect(r.boundBy).toBe('risk');
    expect(r.riskAmount).toBeCloseTo(517.5);
  });
  it('respects the per-trade cap and daily room', () => {
    expect(propSize(FH, base, propRoom(FH, base), { ...xau, riskPct: 2 }).boundBy).toBe('per-trade cap');
    const tight = { ...base, equity: 98_900 };
    const r = propSize(FH, tight, propRoom(FH, tight), xau);
    expect(r.boundBy).toBe('daily room');
    expect(r.lots).toBe(0.29); // (98,900 − 98,460) × 0.5 = 220 → 0.29 lots
  });
  it('limits size so a full win keeps the best day under a consistency cap', () => {
    const rules = { ...FH, perTradeLossPct: null, consistencyShare: 0.5 };
    const s = { ...base, dailyPnl: [400, 400, 0] };
    // total 800, today 0: a win x must satisfy x ≤ 0.5 × (800 + x) → x ≤ 800; reward 22.5 × 100 = 2250 per lot → 0.35 lots
    const r = propSize(rules, s, propRoom(rules, s), xau);
    expect(r.boundBy).toBe('consistency');
    expect(r.lots).toBe(0.35);
  });
  it('blocks below the minimum lot or on a breached account', () => {
    expect(propSize(FH, base, propRoom(FH, base), { ...xau, riskPct: 0.0001 }).blocked).toMatch(/minimum lot/);
    const breached = { ...base, equity: 98_000 };
    expect(propSize(FH, breached, propRoom(FH, breached), xau).blocked).toMatch(/breached/);
  });
});

describe('cTrader', () => {
  it('maps engine instruments to CFD symbols', () => {
    expect(toCTraderSymbol('XAUUSDT.P')).toBe('XAUUSD');
    expect(toCTraderSymbol('BTCUSDT.P')).toBe('BTCUSD');
    expect(toCTraderSymbol('SPX500')).toBe('US500');
    expect(toCTraderSymbol('NIFTY')).toBeNull();
  });
  it('values a point per lot, converting JPY pairs at the price', () => {
    expect(valuePerPointPerLot(CTRADER_SPECS.XAUUSD!, 4000)).toBe(100);
    expect(valuePerPointPerLot(CTRADER_SPECS.USDJPY!, 150)).toBeCloseTo(666.67, 1);
  });
  it('formats expiry as DD-MM-YYYY_hh-mm UTC', () => {
    expect(ctraderExpiry(new Date(Date.UTC(2027, 0, 15, 15, 0)))).toBe('15-01-2027_15-00');
  });
  it("reproduces cTrader's documented multi-target link", () => {
    const url = ctraderSignalLink({
      symbol: 'EURUSD', order: 'limit', direction: 'sell', price: 1.0728, sl: 1.0805, digits: 5,
      tps: [{ price: 1.0713, units: 47000 }, { price: 1.0698, units: 27000 }, { price: 1.0683, units: 26000 }],
      comment: 'Good opportunity', expiry: new Date(Date.UTC(2027, 0, 15, 15, 0)),
    });
    expect(url).toBe('https://app.ctrader.com/signal?s=EURUSD&o=limit&d=sell&p=1.0728&sl=1.0805&v=100000&tp=1.0713&tpv=47000&tp2=1.0698&tpv2=27000&tp3=1.0683&tpv3=26000&c=Good%20opportunity&e-utc=15-01-2027_15-00');
  });
  it('drops volume with a single target and the price on market orders, and cleans comments', () => {
    const url = ctraderSignalLink({ symbol: 'XAUUSD', order: 'market', direction: 'buy', price: 4031.9, sl: 4024.4, digits: 2, tps: [{ price: 4054.4, units: 66 }], comment: 'A+ · gold 🟢' });
    expect(url).toBe('https://app.ctrader.com/signal?s=XAUUSD&o=market&d=buy&sl=4024.4&tp=4054.4&c=A%2B%20%20gold');
  });
});
