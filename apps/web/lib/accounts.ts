import type { Investor, TradingAccount } from "@/lib/types";

/** Loss-limit room from the account's firm rules (none → uncapped). */
export function rooms(a: TradingAccount) {
  const start = Number(a.start_balance) || Number(a.balance);
  const eq = Number(a.equity) || Number(a.balance);
  const rules = a.firm_rules ?? {};
  const out: { dailyLossRoom?: number; maxLossRoom?: number } = {};
  if (rules.daily_loss_pct) out.dailyLossRoom = Math.max(0, (start * rules.daily_loss_pct) / 100 - Math.max(0, Number(a.balance) - eq));
  if (rules.max_loss_pct) out.maxLossRoom = Math.max(0, eq - start * (1 - rules.max_loss_pct / 100));
  return out;
}

/** Drawdown from the high-water mark, as a fraction. */
export function drawdown(a: TradingAccount) {
  const peak = Math.max(Number(a.hwm ?? 0), Number(a.start_balance), Number(a.equity));
  return peak > 0 ? Math.max(0, (peak - Number(a.equity)) / peak) : 0;
}

/** Owner tag: "Own" for the firm's accounts, otherwise the investor's name. */
export function ownerOf(a: Pick<TradingAccount, "investor_id">, investors: Pick<Investor, "id" | "name">[]): { key: string; label: string; own: boolean } {
  if (!a.investor_id) return { key: "own", label: "Own", own: true };
  const inv = investors.find((i) => i.id === a.investor_id);
  return { key: a.investor_id, label: inv?.name ?? "Investor", own: false };
}

/** Owner filter options: All, Own, then each investor. */
export function ownerOptions(investors: Pick<Investor, "id" | "name">[]) {
  return [{ v: "all", l: "All accounts" }, { v: "own", l: "Own" }, ...investors.map((i) => ({ v: i.id, l: i.name }))];
}

export function matchesOwner(a: Pick<TradingAccount, "investor_id">, owner: string) {
  return owner === "all" || (owner === "own" ? !a.investor_id : a.investor_id === owner);
}
