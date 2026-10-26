-- v3: two desks (gold, BTC), autopilot, backtests & strategies, Telegram alert log,
-- account ownership tags, balance snapshots and cash flows for investor growth.
-- Additive only: v2 tables (copy routes, subscriptions, tg_*) are kept for the later copy/Telegram release.

-- ---------- accounts: ownership & instruments ----------
alter table public.trading_accounts
  add column if not exists instruments text[] not null default '{}',
  add column if not exists tags text[] not null default '{}',
  add column if not exists broker_account text,
  add column if not exists notes text;

-- ---------- balance snapshots (growth curves) ----------
create table if not exists public.account_snapshots (
  id bigint generated always as identity primary key,
  account_id uuid not null references public.trading_accounts (id) on delete cascade,
  at timestamptz not null default now(),
  balance numeric(18,2) not null,
  equity numeric(18,2) not null,
  note text,
  created_by uuid default auth.uid()
);
create index if not exists account_snapshots_acc_at on public.account_snapshots (account_id, at);

-- ---------- deposits, withdrawals, fees (time-weighted returns, investor statements) ----------
create table if not exists public.cash_flows (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.trading_accounts (id) on delete cascade,
  kind text not null check (kind in ('deposit', 'withdrawal', 'fee', 'payout', 'adjustment')),
  amount numeric(18,2) not null check (amount > 0),
  at timestamptz not null default now(),
  note text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists cash_flows_acc_at on public.cash_flows (account_id, at);

-- ---------- Telegram alerts (send-only log) ----------
create table if not exists public.telegram_alerts (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  chat_id text not null,
  chat_label text,
  kind text not null default 'manual',
  instrument text,
  text text not null,
  status text not null check (status in ('sent', 'failed')),
  telegram_message_id bigint,
  error text,
  signal_id uuid references public.signals (id) on delete set null,
  source text not null default 'manual' check (source in ('manual', 'autopilot', 'tradingview', 'system')),
  sent_by uuid default auth.uid()
);
create index if not exists telegram_alerts_at on public.telegram_alerts (at desc);

-- ---------- strategies & backtests (per pair labs) ----------
create table if not exists public.strategies (
  id uuid primary key default gen_random_uuid(),
  desk text not null check (desk in ('gold', 'btc')),
  instrument text not null,
  name text not null,
  params jsonb not null default '{}'::jsonb,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.backtests (
  id uuid primary key default gen_random_uuid(),
  strategy_id uuid references public.strategies (id) on delete cascade,
  instrument text not null,
  from_ts timestamptz not null,
  to_ts timestamptz not null,
  params jsonb not null,
  stats jsonb not null,
  summary jsonb not null default '{}'::jsonb,
  trades jsonb not null default '[]'::jsonb,
  source text,
  created_at timestamptz not null default now()
);
create index if not exists backtests_strategy on public.backtests (strategy_id, created_at desc);

-- ---------- autopilot ----------
create table if not exists public.autopilot_config (
  id uuid primary key default gen_random_uuid(),
  instrument text unique not null,
  mode text not null default 'off' check (mode in ('off', 'alerts', 'paper', 'confirm', 'auto')),
  strategy_id uuid references public.strategies (id) on delete set null,
  account_ids uuid[] not null default '{}',
  risk_pct numeric(6,3) not null default 0.5 check (risk_pct > 0 and risk_pct <= 2),
  events text[] not null default '{SWEPT,SHIFTED,ARMED,CLOSED}',
  filters jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
insert into public.autopilot_config (instrument, mode) values
  ('XAUUSD', 'alerts'), ('XAUUSDT.P', 'off'), ('BTCUSDT.P', 'alerts'), ('BTCUSD', 'off'), ('BTCUSD.SPOT', 'off')
on conflict (instrument) do nothing;

create table if not exists public.autopilot_runs (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  instrument text not null,
  side text,
  state text not null,
  grade text,
  verdict text,
  price numeric(18,6),
  action text,
  detail jsonb not null default '{}'::jsonb
);
create index if not exists autopilot_runs_inst_at on public.autopilot_runs (instrument, at desc);

-- ---------- signals / trades provenance ----------
alter table public.signals add column if not exists source text not null default 'manual';
alter table public.trades
  add column if not exists source text not null default 'manual',
  add column if not exists funding numeric(18,4);
create index if not exists trades_source_open on public.trades (instrument, source) where exit is null;

-- ---------- integrations (non-secret settings; keys stay in Vercel env) ----------
alter table public.app_settings
  add column if not exists integrations jsonb not null default '{
    "tv_symbols": {"XAUUSD": "OANDA:XAUUSD", "XAUUSDT.P": "BINANCE:XAUUSDT.P", "BTCUSD": "BITSTAMP:BTCUSD", "BTCUSDT.P": "BINANCE:BTCUSDT.P", "BTCUSD.SPOT": "COINBASE:BTCUSD"},
    "telegram_chats": [],
    "tv_to_telegram": false,
    "ai_model": null
  }'::jsonb;

-- ---------- RLS ----------
alter table public.account_snapshots enable row level security;
alter table public.cash_flows enable row level security;
alter table public.telegram_alerts enable row level security;
alter table public.strategies enable row level security;
alter table public.backtests enable row level security;
alter table public.autopilot_config enable row level security;
alter table public.autopilot_runs enable row level security;

do $$
declare t text;
begin
  foreach t in array array['account_snapshots', 'cash_flows', 'telegram_alerts', 'strategies', 'backtests', 'autopilot_config', 'autopilot_runs'] loop
    execute format('drop policy if exists %I on public.%I', t || '_staff', t);
    execute format('create policy %I on public.%I for all to authenticated using ((select public.is_staff())) with check ((select public.is_staff()))', t || '_staff', t);
  end loop;
end $$;

-- Investors see the growth of their own accounts.
drop policy if exists snapshots_investor_read on public.account_snapshots;
create policy snapshots_investor_read on public.account_snapshots for select to authenticated using (
  account_id in (select id from public.trading_accounts where investor_id in (select public.my_investor_ids()))
);
drop policy if exists cash_flows_investor_read on public.cash_flows;
create policy cash_flows_investor_read on public.cash_flows for select to authenticated using (
  account_id in (select id from public.trading_accounts where investor_id in (select public.my_investor_ids()))
);

-- Audit every money and automation change.
drop trigger if exists audit_cash_flows on public.cash_flows;
create trigger audit_cash_flows after insert or update or delete on public.cash_flows for each row execute function public.audit_row();
drop trigger if exists audit_strategies on public.strategies;
create trigger audit_strategies after insert or update or delete on public.strategies for each row execute function public.audit_row();
drop trigger if exists audit_autopilot_config on public.autopilot_config;
create trigger audit_autopilot_config after insert or update or delete on public.autopilot_config for each row execute function public.audit_row();
drop trigger if exists audit_account_snapshots on public.account_snapshots;
create trigger audit_account_snapshots after insert or update or delete on public.account_snapshots for each row execute function public.audit_row();

-- Snapshot an account whenever its balance or equity changes (growth curve without manual work).
create or replace function public.snapshot_account() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.balance is distinct from old.balance or new.equity is distinct from old.equity then
    insert into public.account_snapshots (account_id, balance, equity, note) values (new.id, new.balance, new.equity, case when tg_op = 'INSERT' then 'opening' else null end);
  end if;
  return new;
end $$;
revoke all on function public.snapshot_account() from public, anon, authenticated;
drop trigger if exists snapshot_trading_accounts on public.trading_accounts;
create trigger snapshot_trading_accounts after insert or update of balance, equity on public.trading_accounts for each row execute function public.snapshot_account();

-- Seed one snapshot per existing account so curves have a starting point.
insert into public.account_snapshots (account_id, at, balance, equity, note)
select id, created_at, start_balance, start_balance, 'opening' from public.trading_accounts a
where not exists (select 1 from public.account_snapshots s where s.account_id = a.id);
