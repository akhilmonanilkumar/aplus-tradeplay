import { maxDrawdownPct, pnlMultiplier } from "@aplus/engine";
import type { Trade, TradingAccount } from "@/lib/types";

/** Contract multiplier: money per 1.0 price move per 1.0 of size. */
export function multiplier(instrument: string): number {
  return pnlMultiplier(instrument); // XAUUSD CFD: 1.00 lot = 100 oz; perps/spot: qty in coin
}

/** Money lost if the stop is hit. */
export function riskAmount(t: Pick<Trade, "instrument" | "entry" | "stop" | "qty">): number {
  return Math.abs(Number(t.entry) - Number(t.stop)) * Number(t.qty) * multiplier(t.instrument);
}

export const istDay = (iso: string | number) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
export const todayIst = () => istDay(Date.now());

export type Group = "combined" | "master" | "copy" | "investors";
export function inGroup(a: Pick<TradingAccount, "type">, g: Group) {
  if (g === "combined") return true;
  if (g === "master") return a.type === "master";
  if (g === "investors") return a.type === "investor";
  return a.type === "sub" || a.type === "eval" || a.type === "demo";
}

/**
 * Daily equity for a group over the last `days`, rebuilt from current equity
 * minus later closed P&L (USD accounts only).
 */
export function equitySeries(accounts: TradingAccount[], trades: Trade[], g: Group | ((a: TradingAccount) => boolean), days = 30) {
  const acc = accounts.filter((a) => a.currency !== "INR" && (typeof g === "function" ? g(a) : inGroup(a, g)));
  const ids = new Set(acc.map((a) => a.id));
  const now = acc.reduce((s, a) => s + Number(a.equity), 0);
  const byDay = new Map<string, number>();
  for (const t of trades) {
    if (!ids.has(t.account_id) || t.pnl === null || !t.closed_at) continue;
    const d = istDay(t.closed_at);
    byDay.set(d, (byDay.get(d) ?? 0) + Number(t.pnl));
  }
  const keys = Array.from({ length: days }, (_, i) => istDay(Date.now() - (days - 1 - i) * 86_400_000));
  // walk backwards from today's equity
  const vals = new Array<number>(days);
  let eq = now;
  for (let i = days - 1; i >= 0; i--) {
    vals[i] = eq;
    eq -= byDay.get(keys[i]!) ?? 0;
  }
  const start = eq;
  let peak = -Infinity;
  const dd = vals.map((v) => { peak = Math.max(peak, v); return peak > 0 ? (peak - v) / peak : 0; });
  return { keys, vals, dd, start, end: now, ret: start > 0 ? (now - start) / start : 0, maxDd: maxDrawdownPct(vals) };
}
