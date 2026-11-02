import { describe, expect, it } from "vitest";
import { DEFAULT_RULES, candidateKey, demotionReason, promotable, promotionChecks, statsOf } from "@/lib/promotion";

const day = 86_400_000;
const series = (rs: number[], cost = 0.1) => rs.map((r, i) => ({ at: i * day, grossR: r, netR: r - cost }));

describe("strategy promotion", () => {
  it("scores a record in net R: expectancy, profit factor, drawdown, recent form", () => {
    const s = statsOf(series([2, -1, -1, 3, -1, 2]));
    expect(s.n).toBe(6);
    expect(s.netR).toBeCloseTo(3.4, 6);
    expect(s.expectancy).toBeCloseTo(0.567, 3);
    expect(s.profitFactor).toBeCloseTo(6.7 / 3.3, 2);
    expect(s.maxDrawdownR).toBeCloseTo(2.2, 6);
    expect(s.avgCostR).toBeCloseTo(0.1, 6);
    expect(s.score).toBeCloseTo(0.567 * Math.sqrt(6), 2);
  });

  it("promotes only when every rule passes", () => {
    const good = statsOf(series(Array.from({ length: 24 }, (_, i) => (i % 3 === 0 ? 2.5 : -0.6))));
    expect(promotable(good, DEFAULT_RULES)).toBe(true);
    const few = statsOf(series([3, 3, 3]));
    expect(promotionChecks(few, DEFAULT_RULES).find((c) => c.label.includes("trades"))!.ok).toBe(false);
    expect(promotable(few, DEFAULT_RULES)).toBe(false);
    const losing = statsOf(series(Array.from({ length: 30 }, (_, i) => (i % 4 === 0 ? 2 : -1))));
    expect(promotable(losing, DEFAULT_RULES)).toBe(false);
  });

  it("benches a live strategy whose recent record or live drawdown breaks the rules", () => {
    const decayed = statsOf(series(Array.from({ length: 20 }, (_, i) => (i % 5 === 0 ? 1.5 : -0.8))));
    expect(demotionReason(decayed, statsOf([]), DEFAULT_RULES)).toMatch(/expectancy/);
    const fine = statsOf(series(Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 2 : -0.8))));
    expect(demotionReason(fine, statsOf([]), DEFAULT_RULES)).toBeNull();
    const deep = statsOf(series([-1, -1, -1, -1, -1, -1, -1], 0));
    expect(demotionReason(fine, deep, DEFAULT_RULES)).toMatch(/drawdown since live/);
  });

  it("keys candidates by market and model, and by strategy for session strategies", () => {
    expect(candidateKey("XAUUSD", "B")).toBe("XAUUSD:B");
    expect(candidateKey("BTCUSDT.P", "S", "ldn-bo-p")).toBe("BTCUSDT.P:S:ldn-bo-p");
  });
});
