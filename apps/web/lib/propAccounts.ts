import { PROP_PRESETS, type CTraderSpec, type PropRules, type PropState } from "@aplus/engine";

/** Prop accounts in the CFD Arena: rules from the firm preset and account state from closed trades. Client-safe. */

export interface PropAccount {
  id: string; name: string; currency: string; start_balance: number; balance: number; equity: number; active: boolean; instruments: string[] | null;
  firm_rules: { preset?: string; phase?: number; risk_pct?: number; day_reset_utc?: number; phase_started_at?: string; overrides?: Partial<PropRules>; specs?: Record<string, Partial<CTraderSpec>> } | null;
}
export interface ClosedTrade { account_id: string; pnl: number | null; closed_at: string | null }

/** The account's firm rules: its preset, then any per-account overrides. Null when it is not a prop account. */
export function rulesOf(a: Pick<PropAccount, "firm_rules">): PropRules | null {
  const fr = a.firm_rules;
  const preset = fr?.preset ? PROP_PRESETS[fr.preset] : undefined;
  if (!preset) return null;
  return { ...preset, ...(fr?.overrides ?? {}), phase: fr?.phase ?? preset.phase };
}

/** Start of the account's trading day: the firm's reset hour in UTC (default midnight UTC). */
export function dayStart(now: number, resetUtcHour = 0): number {
  const d = new Date(now);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), resetUtcHour);
  return start > now ? start - 86_400_000 : start;
}

/** Account state for the rules from its balances and closed trades this phase. */
export function stateOf(a: PropAccount, trades: ClosedTrade[], now = Date.now()): PropState {
  const reset = a.firm_rules?.day_reset_utc ?? 0;
  const since = a.firm_rules?.phase_started_at ? Date.parse(a.firm_rules.phase_started_at) : 0;
  const closed = trades.filter((t) => t.account_id === a.id && t.closed_at && t.pnl !== null && Date.parse(t.closed_at) >= since);
  const today = dayStart(now, reset);
  const byDay = new Map<number, number>();
  for (const t of closed) { const k = dayStart(Date.parse(t.closed_at!), reset); byDay.set(k, (byDay.get(k) ?? 0) + Number(t.pnl)); }
  const todayPnl = byDay.get(today) ?? 0;
  const days = [...byDay.entries()].filter(([k]) => k !== today).sort((x, y) => x[0] - y[0]).map(([, v]) => v);
  const dayStartBalance = Number(a.balance) - todayPnl;
  return { startBalance: Number(a.start_balance), balance: Number(a.balance), equity: Number(a.equity) || Number(a.balance), dayStartBalance, prevEodBalance: dayStartBalance, prevEodEquity: dayStartBalance, dailyPnl: [...days, todayPnl] };
}

export interface AlertPlan { instrument: string; side: "long" | "short"; entry: number; stop: number; target: number; model?: string | null; grade?: string | null; why?: string[]; expiresAt: number; signalId?: string | null }

/** TP1 at 1.5R or halfway to the target, whichever is nearer; TP2 at the target. */
export function targets(p: Pick<AlertPlan, "side" | "entry" | "stop" | "target">) {
  const dir = p.side === "long" ? 1 : -1, r = Math.abs(p.entry - p.stop);
  const tp1 = p.entry + dir * Math.min(1.5 * r, 0.5 * Math.abs(p.target - p.entry));
  return { tp1, tp2: p.target, rr: r ? Math.abs(p.target - p.entry) / r : 0 };
}

