import { describe, expect, it } from "vitest";
import { orderParts, placeBlocker } from "@/lib/server/cfdOrders";
import { alertButtons } from "@/lib/server/cfdAlerts";
import { signalsOnlyAllows } from "@/lib/server/telegram";

describe("cTrader orders from signals", () => {
  it("only places while the signal is waiting for its entry", () => {
    const later = new Date(Date.now() + 3_600_000).toISOString();
    expect(placeBlocker({ phase: "armed", status: "armed", expires_at: later })).toBeNull();
    expect(placeBlocker({ phase: "trigger", status: "taken", expires_at: later })).toBeNull();
    expect(placeBlocker({ phase: "ended", status: "armed", expires_at: later })).toMatch(/ended/);
    expect(placeBlocker({ phase: "in_trade", status: "armed", expires_at: later })).toMatch(/entry/);
    expect(placeBlocker({ phase: "armed", status: "skipped", expires_at: later })).toMatch(/skipped/);
    expect(placeBlocker({ phase: "armed", status: "armed", expires_at: new Date(Date.now() + 30_000).toISOString() })).toMatch(/expires/);
  });
  it("splits a leg into a TP1 and a TP2 order, else one order at TP2", () => {
    expect(orderParts(1, [0.5, 0.5], { tp1: 10, tp2: 20 })).toEqual([{ part: 1, lots: 0.5, target: 10 }, { part: 2, lots: 0.5, target: 20 }]);
    expect(orderParts(0.3, [], { tp1: 10, tp2: 20 })).toEqual([{ part: 1, lots: 0.3, target: 20 }]);
  });
  it("shows one Place button in confirm mode, links and Taken / Skip otherwise", () => {
    const legs = [{ name: "FundedHive", lots: 0.5, link: "https://app.ctrader.com/x", legId: "11111111-1111-1111-1111-111111111111", blocked: null }];
    const on = alertButtons("a".repeat(36), legs, true);
    expect(on[0]![0]).toMatchObject({ callback_data: `cfd:pa:${"a".repeat(36)}` });
    expect(JSON.stringify(on)).not.toContain("app.ctrader.com");
    const off = alertButtons("a".repeat(36), legs, false);
    expect(JSON.stringify(off)).toContain("app.ctrader.com");
    expect(JSON.stringify(off)).toContain("cfd:t:");
  });
  it("keeps Telegram to signals unless everything is switched on", () => {
    expect(signalsOnlyAllows("CFD", "autopilot")).toBe(true);
    expect(signalsOnlyAllows("ARMED", "autopilot")).toBe(false);
    expect(signalsOnlyAllows("PICK", "autopilot")).toBe(false);
    expect(signalsOnlyAllows("STRATEGY", "system")).toBe(false);
    expect(signalsOnlyAllows("manual", "manual")).toBe(true);
  });
});
