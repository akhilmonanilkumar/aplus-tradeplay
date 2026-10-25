import { BTCUSDT_PERP_DEFAULT, XAUUSD_DEFAULT, clientOrderId, planCopies, type CopyAccount, type CopyDecision } from "@aplus/engine";
import { supabase } from "@/lib/supabase";
import type { TradingAccount } from "@/lib/types";
import type { Settings } from "@/components/Shell";

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

type Rules = Pick<Settings, "equity_throttle" | "prop_buffer"> | null | undefined;

export function toCopyAccounts(accounts: TradingAccount[], instrument: string, riskOverride?: number, rules?: Rules): CopyAccount[] {
  const perp = instrument.startsWith("BTC");
  return accounts.map((a) => {
    let riskPct = a.type === "master" && riskOverride ? riskOverride : Number(a.risk_pct);
    // Equity-curve throttle: more than 3% below the peak → half risk until a new high.
    if (rules?.equity_throttle !== false && drawdown(a) > 0.03) riskPct = riskPct / 2;
    return {
      id: a.id,
      name: a.name,
      policy: a.copy_policy,
      balance: Number(a.balance),
      riskPct,
      instrument: perp ? { kind: "perp" as const, spec: BTCUSDT_PERP_DEFAULT, leverage: 10 } : { kind: "cfd" as const, spec: XAUUSD_DEFAULT },
      // Prop buffer: one stop may use at most half the remaining room (off → all of it).
      roomBuffer: rules?.prop_buffer === false ? 1 : 0.5,
      ...rooms(a),
    };
  });
}

/** USD/USDT accounts that can take this instrument (MCX/INR accounts excluded). */
export function eligible(accounts: TradingAccount[]) {
  return accounts.filter((a) => a.active && a.currency !== "INR");
}

export function plan(accounts: TradingAccount[], instrument: string, order: { entry: number; stop: number; target?: number }, riskOverride?: number, rules?: Rules): { decisions: CopyDecision[]; error: string | null } {
  try {
    return { decisions: planCopies(order, toCopyAccounts(accounts, instrument, riskOverride, rules)), error: null };
  } catch (e) {
    return { decisions: [], error: (e as Error).message };
  }
}

const STATUS: Record<string, string> = { SEND: "queued", CONFIRM: "awaiting_confirm", MANUAL: "manual_pending", PAPER: "queued", BLOCK: "blocked", SKIP: "cancelled" };

/** Idempotent fan-out: one row per (signal, account); a retry never doubles an order. */
export async function queueOrders(
  signal: { id: string; side: "long" | "short"; entry: number; stop: number; target: number },
  decisions: CopyDecision[],
  settings: Settings | null,
): Promise<string | null> {
  if (!settings) return "Settings not loaded";
  if (settings.kill_switch) return "Kill switch is on";
  const rows = decisions.filter((d) => d.action !== "SKIP").map((d) => {
    const action = settings.mode === "PAPER" && d.action !== "BLOCK" ? "PAPER" : d.action;
    return {
      signal_id: signal.id,
      account_id: d.accountId,
      client_order_id: clientOrderId(signal.id, d.accountId),
      action,
      side: signal.side,
      qty: d.size,
      entry: signal.entry,
      stop: signal.stop,
      target: signal.target,
      risk_amount: d.riskAmount,
      reasons: d.reasons,
      status: STATUS[action] ?? "queued",
    };
  });
  if (!rows.length) return "No accounts to route to";
  const { error } = await supabase.from("orders").upsert(rows, { onConflict: "client_order_id", ignoreDuplicates: true });
  return error ? error.message : null;
}
