import { describe, expect, it } from "vitest";
import { JOBS, keysForRow, todaysJobs } from "@/lib/server/strategyAgent";

describe("strategy agent", () => {
  it("rotates through every market × family over a few days", () => {
    const seen = new Set<string>();
    const days = Math.ceil(JOBS.length / 4);
    for (let d = 0; d < days; d++) for (const j of todaysJobs(d * 86_400_000)) seen.add(`${j.instrument}/${j.family}`);
    expect(seen.size).toBe(JOBS.length);
    expect(todaysJobs(0)).toHaveLength(4);
  });
  it("attaches backtests to the League entries they belong to, per venue", () => {
    expect(keysForRow("BTCUSDT.P", "session", "asia-fade-p-t")).toEqual(["delta/BTCUSDT.P:S:asia-fade-p-t", "coinswitch/BTCUSDT.P:S:asia-fade-p-t"]);
    expect(keysForRow("XAUUSD", "a5", "live")).toEqual(["cfd/XAUUSD:A"]);
    expect(keysForRow("XAUUSD", "a5", "core15")).toEqual([]); // research-only variant, not logged live
  });
});
