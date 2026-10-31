import { describe, expect, it } from "vitest";
import { alertButtons, alertText, dayStart, legFor, rulesOf, stateOf, targets, type PropAccount } from "@/lib/server/cfdAlerts";

const fh: PropAccount = {
  id: "a1", name: "FundedHive", currency: "USD", start_balance: 100_000, balance: 104_000, equity: 104_180, active: true, instruments: null,
  firm_rules: { preset: "fundedhive_1step_low", risk_pct: 0.5 },
};
const plan = { instrument: "XAUUSD", side: "long" as const, entry: 4031.9, stop: 4024.4, target: 4054.4, model: "A", grade: "A+", expiresAt: Date.UTC(2026, 10, 2, 16, 0), why: ["Asia low swept"] };

describe("CFD alerts", () => {
  it("reads rules from the preset with per-account overrides", () => {
    expect(rulesOf(fh)?.dailyLossPct).toBe(5);
    expect(rulesOf({ firm_rules: { preset: "the5ers_summer_2step_10_5", phase: 1 } })?.phase).toBe(1);
    expect(rulesOf({ firm_rules: { preset: "fundedhive_1step_low", overrides: { perTradeLossPct: 2 } } })?.perTradeLossPct).toBe(2);
    expect(rulesOf({ firm_rules: null })).toBeNull();
  });
  it("starts the trading day at the firm's reset hour", () => {
    const t = Date.UTC(2026, 10, 2, 21, 0);
    expect(dayStart(t, 0)).toBe(Date.UTC(2026, 10, 2, 0));
    expect(dayStart(t, 22)).toBe(Date.UTC(2026, 10, 1, 22));
  });
  it("derives today's opening balance and daily P&L from closed trades", () => {
    const now = Date.UTC(2026, 10, 2, 12, 0);
    const s = stateOf(fh, [
      { account_id: "a1", pnl: 300, closed_at: "2026-11-02T09:00:00Z" },
      { account_id: "a1", pnl: -100, closed_at: "2026-11-02T10:00:00Z" },
      { account_id: "a1", pnl: 900, closed_at: "2026-10-30T10:00:00Z" },
      { account_id: "other", pnl: 5000, closed_at: "2026-11-02T10:00:00Z" },
    ], now);
    expect(s.dayStartBalance).toBe(103_800);
    expect(s.dailyPnl).toEqual([900, 200]);
  });
  it("puts TP1 at 1.5R or halfway, whichever is nearer", () => {
    const t = targets(plan);
    expect(t.tp1).toBeCloseTo(4043.15);
    expect(t.tp2).toBe(4054.4);
    expect(t.rr).toBeCloseTo(3);
    expect(targets({ side: "short", entry: 100, stop: 101, target: 98.5 }).tp1).toBeCloseTo(99.25);
  });
  it("builds a sized leg with a two-target cTrader link", () => {
    const state = { startBalance: 100_000, balance: 104_000, equity: 104_180, dayStartBalance: 103_460, dailyPnl: [540] };
    const leg = legFor(fh, rulesOf(fh)!, state, plan, "XAUUSD", "1234567890abcdef", targets(plan));
    expect(leg.size.lots).toBe(0.69);
    expect(leg.link).toBe("https://app.ctrader.com/signal?s=XAUUSD&o=limit&d=buy&p=4031.9&sl=4024.4&v=69&tp=4043.15&tpv=34&tp2=4054.4&tpv2=35&c=APLUS%2012345678%20FundedHive&e-utc=02-11-2026_16-00");
  });
  it("writes the Telegram message and buttons", () => {
    const text = alertText(plan, "XAUUSD", 2, targets(plan), [
      { name: "FundedHive", lots: 0.69, legs: [0.34, 0.35], risk: 517.5, blocked: null, bound: "risk" },
      { name: "The5ers", lots: 0, legs: [], risk: 0, blocked: "account breached: daily loss", bound: "daily room" },
    ]);
    expect(text).toContain("A+ ARMED · XAUUSD LONG");
    expect(text).toContain("Entry 4,031.90 (limit, expires 16:00 UTC)");
    expect(text).toContain("FundedHive: <b>0.69 lots</b> (0.34 + 0.35) · risk $518");
    expect(text).toContain("⛔ The5ers: account breached: daily loss");
    const b = alertButtons("id-1", [{ name: "FundedHive", lots: 0.69, link: "https://app.ctrader.com/signal?s=XAUUSD" }, { name: "The5ers", lots: 0, link: null }]);
    expect(b).toHaveLength(2);
    expect(b[1]).toEqual([{ text: "✅ Taken", callback_data: "cfd:t:id-1" }, { text: "Skip", callback_data: "cfd:s:id-1" }]);
  });
});
