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
  firm_rules: { daily_loss_pct?: number; max_loss_pct?: number; profit_target_pct?: number; split?: number };
  is_live: boolean;
  active: boolean;
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
