import { describe, expect, it } from "vitest";
import { edgeScore, rankSetups, setupState, type SetupInput } from "@/lib/cfdSetups";

const M5 = 300_000;
const now = Date.UTC(2026, 10, 10, 9, 0);
const base: SetupInput = { side: "long", entry: 100, stop: 98, target: 106, createdAt: now - 10 * 60_000, market: false, outcome: "pending", filledAt: null, closedAt: null, resultR: null };

describe("CFD setup state", () => {
  it("a pending limit is waiting until price is within 0.15R of the entry", () => {
    const far = setupState(base, 101, M5, now);
    expect(far.status).toBe("waiting");
    expect(far.toEntryR).toBe(0.5);
    expect(far.expiresAt).toBe(base.createdAt + 12 * M5);
    expect(setupState(base, 100.2, M5, now).status).toBe("enter");
  });
  it("a short measures the distance the other way", () => {
    expect(setupState({ ...base, side: "short", stop: 102, target: 94 }, 99, M5, now).toEntryR).toBe(0.5);
  });
  it("a recent market fill near the entry can still be taken; later it is just running", () => {
    const m = { ...base, market: true, outcome: "filled", filledAt: now - 5 * 60_000 };
    const s = setupState(m, 100.4, M5, now);
    expect(s.status).toBe("enter");
    expect(s.lateOk).toBe(true);
    expect(s.r).toBe(0.2);
    expect(setupState(m, 101.5, M5, now).status).toBe("in_trade");
    expect(setupState({ ...m, filledAt: now - 60 * 60_000 }, 100.1, M5, now).status).toBe("in_trade");
  });
  it("losses, expiries and runaways are failed with the reason", () => {
    expect(setupState({ ...base, outcome: "loss", resultR: -1.05 }, null, M5, now)).toMatchObject({ status: "failed", fail: "stopped", r: -1.05 });
    expect(setupState({ ...base, outcome: "expired" }, null, M5, now)).toMatchObject({ status: "failed", fail: "expired" });
    expect(setupState({ ...base, outcome: "ran_away" }, null, M5, now)).toMatchObject({ status: "failed", fail: "ran_away" });
    expect(setupState({ ...base, outcome: "win", resultR: 2.9 }, null, M5, now)).toMatchObject({ status: "won", r: 2.9 });
  });
});

describe("edge score and ranking", () => {
  const paper = (n: number, expectancy: number) => ({ n, expectancy, profitFactor: 1.5, winRate: 0.4, lowerBound: expectancy - 0.1 });
  it("shrinks small samples, so fifty good trades beat three lucky ones", () => {
    expect(edgeScore({ stage: "paper", paper: paper(50, 0.3), backtest: null }).score).toBeGreaterThan(edgeScore({ stage: "paper", paper: paper(3, 1.2), backtest: null }).score);
  });
  it("is winning on a positive paper record of ten or more, or a passing backtest", () => {
    expect(edgeScore({ stage: "paper", paper: paper(12, 0.2), backtest: null }).winning).toBe(true);
    expect(edgeScore({ stage: "paper", paper: paper(4, 0.8), backtest: null }).winning).toBe(false);
    expect(edgeScore({ stage: null, paper: null, backtest: { trades: 105, avgR: 0.44, profitFactor: 1.7, pass: true } }).winning).toBe(true);
    expect(edgeScore({ stage: null, paper: null, backtest: null })).toMatchObject({ score: 0, winning: false, label: "No paper trades yet" });
  });
  it("ranks setups at the entry first, then waiting, best edge first; ended ones get no rank", () => {
    const e = (score: number) => ({ score, winning: score > 0, label: "" });
    const r = rankSetups([
      { id: "a", status: "waiting" as const, edge: e(0.4), createdAt: 1 },
      { id: "b", status: "enter" as const, edge: e(0.1), createdAt: 1 },
      { id: "c", status: "failed" as const, edge: e(0.9), createdAt: 1 },
      { id: "d", status: "waiting" as const, edge: e(0.6), createdAt: 1 },
    ]);
    expect(r.map((x) => [x.id, x.rank])).toEqual([["b", 1], ["d", 2], ["a", 3], ["c", null]]);
  });
});
