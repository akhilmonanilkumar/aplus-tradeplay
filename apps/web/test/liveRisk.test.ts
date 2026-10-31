import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, planLiveOrder, policyFrom, type RiskInput } from "@/lib/liveRisk";

const btc = { symbol: "BTCUSD", productId: 84, contractValue: 0.001, tick: 0.1, takerFee: 0.0005 };
const now = Date.UTC(2026, 9, 28, 10, 0);
const base = (over: Partial<RiskInput> = {}): RiskInput => ({
  policy: DEFAULT_POLICY, now, equity: 10_000, startOfDayEquity: 10_000, peakEquity: 10_000, todayPnl: 0, todayLosses: 0, todayTrades: 0,
  open: [], killSwitch: false, haltedUntil: null, newsBlocked: false,
  signal: { createdAt: now - 60_000, side: "long", entry: 80_000, stop: 79_600, target: 81_200 },
  ourPrice: 80_050, venueMid: 80_070, product: btc, ...over,
});

describe("live risk gate", () => {
  it("sizes a bracketed limit from risk, shifted by the basis, within leverage", () => {
    const r = planLiveOrder(base());
    expect(r.ok).toBe(true);
    const p = r.plan!;
    expect(p.side).toBe("buy");
    expect(p.limitPrice).toBe(80_020); // +20 basis
    expect(p.stop).toBe(79_620);
    expect(p.target).toBe(81_220);
    // 0.5% of 10k = $50; per contract 400 × 0.001 = $0.40 + fees ≈ $0.08 → 104 contracts
    expect(p.contracts).toBe(104);
    expect(p.riskUsd).toBeLessThanOrEqual(50);
    expect(p.rr).toBe(3);
    expect(p.leverage).toBeLessThanOrEqual(DEFAULT_POLICY.maxLeverage);
  });

  it("caps size by leverage and by capital cap", () => {
    const tight = planLiveOrder(base({ signal: { createdAt: now - 60_000, side: "long", entry: 80_000, stop: 79_990, target: 80_100 }, venueMid: 80_050, ourPrice: 80_050 }));
    expect(tight.plan!.leverage).toBeLessThanOrEqual(5);
    const capped = planLiveOrder(base({ policy: policyFrom({ capitalCap: 1000 }) }));
    expect(capped.plan!.riskUsd).toBeLessThanOrEqual(5);
  });

  it("blocks on account-level rules", () => {
    expect(planLiveOrder(base({ killSwitch: true })).reasons.join()).toMatch(/kill switch/);
    expect(planLiveOrder(base({ todayPnl: -200 })).reasons.join()).toMatch(/daily loss/);
    expect(planLiveOrder(base({ todayLosses: 2 })).reasons.join()).toMatch(/losses today/);
    expect(planLiveOrder(base({ equity: 9_100, peakEquity: 10_000 })).reasons.join()).toMatch(/drawdown/);
    expect(planLiveOrder(base({ open: [{ symbol: "BTCUSD", riskUsd: 40 }] })).reasons.join()).toMatch(/already in BTCUSD/);
    expect(planLiveOrder(base({ newsBlocked: true })).reasons.join()).toMatch(/news/);
    expect(planLiveOrder(base({ haltedUntil: now + 60_000 })).reasons.join()).toMatch(/halted/);
  });

  it("does not chase, skips stale signals and thin targets", () => {
    expect(planLiveOrder(base({ venueMid: 80_170, ourPrice: 80_150 })).reasons.join()).toMatch(/ran .*past the entry/);
    expect(planLiveOrder(base({ signal: { createdAt: now - 30 * 60_000, side: "long", entry: 80_000, stop: 79_600, target: 81_200 } })).reasons.join()).toMatch(/min old/);
    expect(planLiveOrder(base({ signal: { createdAt: now - 60_000, side: "long", entry: 80_000, stop: 79_600, target: 80_400 } })).reasons.join()).toMatch(/R to target/);
  });

  it("never lets a setting loosen past the hard caps", () => {
    const p = policyFrom({ riskPct: 5, maxLeverage: 100, dailyLossPct: 20, maxDrawdownPct: 50, minRR: 0.2 });
    expect(p.riskPct).toBe(1);
    expect(p.maxLeverage).toBe(10);
    expect(p.dailyLossPct).toBe(3);
    expect(p.maxDrawdownPct).toBe(10);
    expect(p.minRR).toBe(1);
  });

  it("plans shorts with the stop above and rounds conservatively", () => {
    const r = planLiveOrder(base({ signal: { createdAt: now - 60_000, side: "short", entry: 80_000, stop: 80_400.04, target: 78_800.06 }, venueMid: 79_990, ourPrice: 79_990 }));
    expect(r.ok).toBe(true);
    expect(r.plan!.side).toBe("sell");
    expect(r.plan!.stop).toBe(80_400.1);
    expect(r.plan!.target).toBe(78_800.1);
  });
});
