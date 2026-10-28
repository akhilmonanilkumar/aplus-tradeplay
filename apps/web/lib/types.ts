import type { SelectorConfig } from "@/lib/selectorConfig";

export type Role = "owner" | "admin" | "investor";
export type AccountType = "master" | "sub" | "eval" | "demo" | "investor";
export type CopyPolicy = "AUTO" | "CONFIRM" | "MANUAL" | "PAPER" | "BLOCKED";
export type Stage = "kyc" | "payment" | "to_purchase" | "evaluation" | "funded" | "payout_pending" | "breached" | "closed";

export interface Investor {
  id: string;
  user_id: string | null;
  name: string;
  email: string | null;
  model: "prop_profit_share" | "managed_capital" | "both";
  stage: Stage;
  fee_rate: number;
  kyc_status: "pending" | "verified" | "rejected";
  agreement_signed_at: string | null;
  risk_disclosure_at: string | null;
  created_at: string;
}

export interface TradingAccount {
  id: string;
  name: string;
  type: AccountType;
  venue: string;
  platform: string | null;
  investor_id: string | null;
  currency: string;
  start_balance: number;
  balance: number;
  equity: number;
  hwm: number | null;
  risk_pct: number;
  copy_policy: CopyPolicy;
  firm_rules: { daily_loss_pct?: number; max_loss_pct?: number; profit_target_pct?: number; split?: number; copy_rule?: string; multiplier?: number; skip_below_min?: boolean };
  is_live: boolean;
  active: boolean;
  instruments: string[];
  tags: string[];
  broker_account: string | null;
  notes: string | null;
  created_at: string;
}

export interface PropPurchase {
  id: string;
  ref: string;
  investor_id: string;
  firm: string;
  plan: string;
  size: number;
  fee: number | null;
  fee_currency: string;
  paid_by: "investor" | "aplus";
  status: "to_purchase" | "evaluation" | "funded" | "breached" | "refunded" | "closed";
  account_id: string | null;
  created_at: string;
}

export interface Trade {
  id: string;
  account_id: string;
  instrument: string;
  side: "long" | "short";
  model: string | null;
  session_window: string | null;
  qty: number;
  entry: number;
  exit: number | null;
  stop: number;
  target: number | null;
  planned_r: number | null;
  realized_r: number | null;
  pnl: number | null;
  fees: number | null;
  rule_breaks: string[];
  review: string | null;
  mood: number | null;
  grade: "A+" | "A" | "B" | "C" | null;
  plan_followed: boolean | null;
  emotion: string | null;
  lesson: string | null;
  risk_pct: number | null;
  source: string;
  funding: number | null;
  opened_at: string;
  closed_at: string | null;
}

export interface Payout {
  id: string;
  investor_id: string;
  account_id: string | null;
  kind: "prop" | "hwm";
  period: string;
  gross: number;
  firm_split: number | null;
  hwm_before: number | null;
  commission: number;
  to_investor: number;
  status: "pending" | "approved" | "paid" | "held";
  created_at: string;
  paid_at: string | null;
}

export interface Plan { id: string; name: string; price_inr: number; months: number; active: boolean }
export interface TrackedLink { id: string; slug: string; source: string; campaign: string | null; target_url: string; created_at: string }
export interface TgMember {
  id: string;
  telegram_user_id: number;
  username: string | null;
  source: string | null;
  first_link_id: string | null;
  plan_id: string | null;
  status: "free" | "active" | "expiring" | "lapsed" | "removed";
  paid_until: string | null;
  first_seen: string;
}
export interface TgEvent { id: number; tg_member_id: string | null; type: string; chat: "vip" | "free"; amount_inr: number | null; at: string }
export interface TgPost { id: string; destination: string; kind: string; views: number | null; reactions: number | null; clicks: number | null; status: string; sent_at: string | null; created_at: string }

export interface Signal {
  id: string;
  instrument: string;
  side: "long" | "short";
  model: string;
  session_window: string | null;
  entry: number;
  stop: number;
  target: number;
  rr: number | null;
  grade: string;
  gate: { n: number; label: string; status: "pass" | "warn" | "fail" | "pending"; reason: string }[];
  state: string;
  created_at: string;
  source?: string;
  meta?: {
    score?: number; parts?: Record<string, number>; context?: number | null; why?: string[]; mode?: string; targetLabel?: string; dataSource?: string;
    /** Paper ledger (lib/server/ledger.ts). */
    key?: string; detail?: string; strategy?: string; tradeable?: boolean; stopAnchor?: string; entryType?: string;
    paper?: { verdict: string; blockers: string[]; softMisses: string[]; waitingFor: string[] };
    edge?: { verdict: string; grade: string; blockers: string[] };
  } | null;
  outcome?: "pending" | "filled" | "win" | "loss" | "expired" | "ran_away" | "cancelled" | null;
  filled_at?: string | null;
  closed_at?: string | null;
  exit_price?: number | null;
  result_r?: number | null;
  net_r?: number | null;
}
export interface Order { id: string; signal_id: string | null; account_id: string; client_order_id: string; action: string; side: string; qty: number; entry: number; stop: number; target: number | null; risk_amount: number | null; status: string; reasons: string[]; fill_price: number | null; latency_ms: number | null; created_at: string; filled_at: string | null }
export interface NewsEvent { id: string; at: string; currency: string; title: string; impact: "high" | "medium" | "low"; instruments: string[]; actual: string | null; forecast: string | null; previous: string | null }
export interface SetupZone { id: string; instrument: string; side: "long" | "short"; timeframe: string; kind: string; top: number; bottom: number; fresh: boolean; liquidity_story: boolean; created_bos: boolean; alert_set: boolean; status: string; note: string | null; created_at: string }
export interface AlertLog { id: number; title: string; body: string | null; severity: "info" | "warn" | "critical"; read: boolean; at: string }
export interface CopyRoute { id: string; instrument: string; master_account_id: string; target_account_id: string; risk_pct: number | null; symbol: string | null; enabled: boolean }

export interface Snapshot { id: number; account_id: string; at: string; balance: number; equity: number; note: string | null }
export interface CashFlow { id: string; account_id: string; kind: "deposit" | "withdrawal" | "fee" | "payout" | "adjustment"; amount: number; at: string; note: string | null }
export interface TelegramAlert { id: number; at: string; chat_id: string; chat_label: string | null; kind: string; instrument: string | null; text: string; status: "sent" | "failed"; telegram_message_id: number | null; error: string | null; signal_id: string | null; source: string }
export interface Strategy { id: string; desk: "gold" | "btc"; instrument: string; name: string; params: Record<string, unknown>; notes: string | null; created_at: string; updated_at: string }
export interface BacktestRow { id: string; strategy_id: string | null; instrument: string; from_ts: string; to_ts: string; params: Record<string, unknown>; stats: Record<string, number | null>; summary: Record<string, unknown>; source: string | null; created_at: string }
export type AutopilotMode = "off" | "alerts" | "paper" | "confirm" | "auto";
export interface AutopilotConfig { id: string; instrument: string; mode: AutopilotMode; strategy_id: string | null; account_ids: string[]; risk_pct: number; events: string[]; filters: { allowGradeA?: boolean }; updated_at: string }
export interface AutopilotRun { id: number; at: string; instrument: string; side: string | null; state: string; grade: string | null; verdict: string | null; price: number | null; action: string | null; detail: Record<string, unknown> }
export interface Integrations { telegram_chats: { id: string; label: string }[]; ai_model: string | null; selector?: Partial<SelectorConfig>; notify?: Partial<import("@/lib/notify").TelegramRouting> }
