import { describe, expect, it } from "vitest";
import type { Candle } from "@aplus/engine";
import { judge, levelsChanged, lifecycle, splitR } from "@/lib/cfdLive";

const M = 300_000;
const T0 = 1_800_000_000_000;
// Long gold: entry 2000, stop 1990 (10 risk), TP1 2015 (1.5R), TP2 2030 (3R).
const L = { side: "long" as const, entry: 2000, stop: 1990, tp1: 2015, tp2: 2030 };
const times = { levelsAt: T0, expiresAt: T0 + 12 * M };
const bar = (i: number, l: number, h: number): Candle => ({ t: T0 + i * M, o: (l + h) / 2, h, l, c: (l + h) / 2, v: 0 });

describe("CFD live lifecycle", () => {
  it("is armed away from the entry and at the trigger near it", () => {
    const c = [bar(0, 2008, 2012)];
    expect(lifecycle(L, times, c, M, 2010, T0 + M)).toMatchObject({ phase: "armed", toEntryR: 1 });
    expect(lifecycle(L, times, c, M, 2002, T0 + M)).toMatchObject({ phase: "trigger", toEntryR: 0.2 });
  });
  it("fills on a touch of the entry and marks open R", () => {
    const r = lifecycle(L, times, [bar(0, 2004, 2010), bar(1, 1999, 2006)], M, 2005, T0 + 2 * M);
    expect(r).toMatchObject({ phase: "in_trade", filledAt: T0 + M, r: 0.5, tp1Hit: false });
  });
  it("books half at TP1 and ends partial when the rest is stopped", () => {
    const c = [bar(0, 1999, 2005), bar(1, 2005, 2016), bar(2, 1989, 2010)];
    const r = lifecycle(L, times, c, M, null, T0 + 3 * M);
    expect(r).toMatchObject({ phase: "ended", outcome: "partial", tp1Hit: true, r: splitR(L, "tp1_stop") });
    expect(r.r).toBe(0.25);
  });
  it("wins at TP2 with both legs", () => {
    const r = lifecycle(L, times, [bar(0, 1999, 2005), bar(1, 2010, 2031)], M, null, T0 + 2 * M);
    expect(r).toMatchObject({ outcome: "win", r: 2.25 });
  });
  it("counts a bar through entry and stop as a loss", () => {
    expect(lifecycle(L, times, [bar(0, 1985, 2005)], M, null, T0 + M)).toMatchObject({ outcome: "loss", r: -1 });
  });
  it("ends as ran away when TP1 trades before the entry", () => {
    expect(lifecycle(L, times, [bar(0, 2005, 2016)], M, null, T0 + M)).toMatchObject({ phase: "ended", outcome: "ran_away" });
  });
  it("expires without a fill after the order's expiry", () => {
    const c = Array.from({ length: 14 }, (_, i) => bar(i, 2004, 2010));
    expect(lifecycle(L, times, c, M, 2006, T0 + 14 * M)).toMatchObject({ phase: "ended", outcome: "expired", endedAt: times.expiresAt });
  });
  it("only reads bars after the levels were last set", () => {
    // An old bar touched the old entry; levels were moved after it, so it does not count.
    const r = lifecycle(L, { levelsAt: T0 + 2 * M, expiresAt: T0 + 14 * M }, [bar(0, 1995, 2003), bar(2, 2004, 2010)], M, 2006, T0 + 3 * M);
    expect(r.phase).toBe("armed");
  });
  it("works for shorts", () => {
    const S = { side: "short" as const, entry: 100, stop: 101, tp1: 98.5, tp2: 97 };
    expect(lifecycle(S, times, [bar(0, 99.5, 100.1)], M, 99.4, T0 + M)).toMatchObject({ phase: "in_trade", r: 0.6 });
  });
});

describe("CFD live detector verdicts", () => {
  const cur = { entry: 2000, stop: 1990, tp1: 2015, tp2: 2030 };
  it("keeps the alert while the setup holds", () => {
    expect(judge({ state: "ARMED", blockers: [], ranAway: false, plan: { entry: 2000.5, stop: 1990, target: 2030 } }, cur, "long")).toEqual({ kind: "keep" });
    expect(judge({ state: "SHIFTED", blockers: [], ranAway: false, plan: null }, cur, "long")).toEqual({ kind: "keep" });
  });
  it("revises when the levels move by more than a tenth of the risk", () => {
    expect(judge({ state: "ARMED", blockers: [], ranAway: false, plan: { entry: 1998, stop: 1988, target: 2030 } }, cur, "long")).toMatchObject({ kind: "revise" });
    expect(levelsChanged(cur, { ...cur, entry: 2000.9 })).toBe(false);
  });
  it("ends a setup whose structure is gone, or that a news block covers", () => {
    expect(judge({ state: "IN_POI", blockers: [], ranAway: false, plan: null }, cur, "long")).toMatchObject({ kind: "dead" });
    expect(judge({ state: "ARMED", blockers: ["High-impact news within 15 min"], ranAway: false, plan: null }, cur, "long")).toMatchObject({ kind: "dead" });
    expect(judge({ state: "SHIFTED", blockers: [], ranAway: true, plan: null }, cur, "long")).toMatchObject({ kind: "ran_away" });
  });
});
