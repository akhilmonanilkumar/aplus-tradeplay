import { describe, expect, it } from "vitest";
import { arenaOf } from "@/lib/arenas";

describe("arenaOf", () => {
  it("routes accounts to their arena by venue", () => {
    expect(arenaOf({ venue: "Delta Exchange India", platform: null })).toBe("delta");
    expect(arenaOf({ venue: "CoinSwitch PRO", platform: "api" })).toBe("coinswitch");
    expect(arenaOf({ venue: "FYERS", platform: null })).toBe("fyers");
    expect(arenaOf({ venue: "FundedHive", platform: "cTrader" })).toBe("cfd");
    expect(arenaOf({ venue: "The5ers", platform: "cTrader" })).toBe("cfd");
  });
});
