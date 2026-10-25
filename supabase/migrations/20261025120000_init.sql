-- A+ Tradeplay — initial schema
-- Roles: owner/admin (staff, must be signed in with MFA = aal2) and investor (read-only, own records).

create extension if not exists pgcrypto;

-- ---------- enums ----------
create type public.member_role as enum ('owner', 'admin', 'investor');
create type public.account_type as enum ('master', 'sub', 'eval', 'demo', 'investor');
create type public.copy_policy as enum ('AUTO', 'CONFIRM', 'MANUAL', 'PAPER', 'BLOCKED');
create type public.investor_stage as enum ('kyc', 'payment', 'to_purchase', 'evaluation', 'funded', 'payout_pending', 'breached', 'closed');
create type public.payout_status as enum ('pending', 'approved', 'paid', 'held');
create type public.tg_event_type as enum ('join', 'leave', 'removed', 'payment', 'renewal', 'payment_failed', 'click', 'reaction');

-- ---------- members ----------
create table public.members (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role public.member_role not null default 'investor',
  display_name text not null default '',
  created_at timestamptz not null default now()
);

-- Staff = owner/admin who signed in with a second factor in this session.
create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.members m
    where m.user_id = auth.uid() and m.role in ('owner', 'admin')
  ) and coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2';
$$;

create or replace function public.my_role() returns public.member_role
language sql stable security definer set search_path = public as $$
  select role from public.members where user_id = auth.uid();
$$;

-- ---------- investors ----------
create table public.investors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users (id) on delete set null,
  name text not null,
  email text,
  model text not null check (model in ('prop_profit_share', 'managed_capital', 'both')),
  stage public.investor_stage not null default 'kyc',
  fee_rate numeric(5,4) not null default 0.20 check (fee_rate between 0 and 1),
  agreement_signed_at timestamptz,
  risk_disclosure_at timestamptz,
  kyc_status text not null default 'pending' check (kyc_status in ('pending', 'verified', 'rejected')),
  notes text,
  created_at timestamptz not null default now()
);

create or replace function public.my_investor_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select id from public.investors where user_id = auth.uid();
$$;

-- ---------- trading accounts ----------
create table public.trading_accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type public.account_type not null,
  venue text not null,
  platform text,
  investor_id uuid references public.investors (id) on delete set null,
  currency text not null default 'USD',
  start_balance numeric(18,2) not null default 0,
  balance numeric(18,2) not null default 0,
  equity numeric(18,2) not null default 0,
  hwm numeric(18,2),
  risk_pct numeric(6,3) not null default 0.5 check (risk_pct > 0 and risk_pct <= 5),
  sizing_mode text not null default 'risk_pct' check (sizing_mode in ('risk_pct', 'equity_ratio', 'fixed')),
  max_size numeric(18,6),
  copy_policy public.copy_policy not null default 'PAPER',
  symbol_map jsonb not null default '{}'::jsonb,
  firm_rules jsonb not null default '{}'::jsonb,
  is_live boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint investor_accounts_have_investor check (type <> 'investor' or investor_id is not null)
);
create index on public.trading_accounts (investor_id);

-- API secrets never live in this table: only a reference to a Vault secret.
create table public.venue_credentials (
  account_id uuid primary key references public.trading_accounts (id) on delete cascade,
  vault_secret_id uuid not null,
  can_trade boolean not null default true,
  can_withdraw boolean not null default false check (can_withdraw = false),
  ip_locked boolean not null default false,
  rotated_at timestamptz not null default now()
);

-- ---------- prop purchases ----------
create table public.prop_purchases (
  id uuid primary key default gen_random_uuid(),
  ref text unique not null,
  investor_id uuid not null references public.investors (id) on delete restrict,
  firm text not null,
  plan text not null,
  size numeric(18,2) not null,
  fee numeric(18,2),
  fee_currency text not null default 'USD',
  paid_by text not null default 'investor' check (paid_by in ('investor', 'aplus')),
  payment_received_at timestamptz,
  purchased_at timestamptz,
  account_id uuid references public.trading_accounts (id) on delete set null,
  status text not null default 'to_purchase' check (status in ('to_purchase', 'evaluation', 'funded', 'breached', 'refunded', 'closed')),
  created_at timestamptz not null default now()
);

-- ---------- copy routes ----------
create table public.copy_routes (
  id uuid primary key default gen_random_uuid(),
  instrument text not null,
  master_account_id uuid not null references public.trading_accounts (id) on delete cascade,
  target_account_id uuid not null references public.trading_accounts (id) on delete cascade,
  risk_pct numeric(6,3),
  symbol text,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (instrument, master_account_id, target_account_id),
  check (master_account_id <> target_account_id)
);

-- ---------- edge config ----------
create table public.edge_configs (
  id uuid primary key default gen_random_uuid(),
  version text unique not null,
  config jsonb not null,
  active boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index edge_configs_one_active on public.edge_configs (active) where active;

-- ---------- signals, orders, trades ----------
create table public.signals (
  id uuid primary key default gen_random_uuid(),
  instrument text not null,
  side text not null check (side in ('long', 'short')),
  model text not null check (model in ('A', 'B', 'C', 'CT1')),
  session_window text,
  entry numeric(18,6) not null,
  stop numeric(18,6) not null,
  target numeric(18,6) not null,
  rr numeric(8,3),
  grade text not null,
  gate jsonb not null,
  state text not null,
  edge_version text,
  created_at timestamptz not null default now()
);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  signal_id uuid references public.signals (id) on delete set null,
  account_id uuid not null references public.trading_accounts (id) on delete cascade,
  client_order_id text unique not null,
  action text not null check (action in ('SEND', 'CONFIRM', 'MANUAL', 'PAPER', 'BLOCK', 'SKIP')),
  side text not null check (side in ('long', 'short')),
  qty numeric(18,6) not null,
  entry numeric(18,6) not null,
  stop numeric(18,6) not null,
  target numeric(18,6),
  risk_amount numeric(18,2),
  status text not null default 'queued' check (status in ('queued', 'sent', 'filled', 'partial', 'rejected', 'cancelled', 'awaiting_confirm', 'manual_pending', 'blocked')),
  reasons text[] not null default '{}',
  venue_order_id text,
  fill_price numeric(18,6),
  latency_ms integer,
  created_at timestamptz not null default now(),
  filled_at timestamptz
);
create index on public.orders (account_id, created_at desc);

create table public.trades (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.trading_accounts (id) on delete cascade,
  signal_id uuid references public.signals (id) on delete set null,
  instrument text not null,
  side text not null check (side in ('long', 'short')),
  model text,
  session_window text,
  qty numeric(18,6) not null,
  entry numeric(18,6) not null,
  exit numeric(18,6),
  stop numeric(18,6) not null,
  target numeric(18,6),
  planned_r numeric(8,3),
  realized_r numeric(8,3),
  pnl numeric(18,2),
  fees numeric(18,4),
  gate jsonb,
  sweep_type text,
  htf_zone text,
  target_type text,
  rule_breaks text[] not null default '{}',
  review text,
  mood smallint check (mood between 1 and 10),
  edge_version text,
  opened_at timestamptz not null default now(),
  closed_at timestamptz
);
create index on public.trades (account_id, opened_at desc);

-- ---------- payouts ----------
create table public.payouts (
  id uuid primary key default gen_random_uuid(),
  investor_id uuid not null references public.investors (id) on delete restrict,
  account_id uuid references public.trading_accounts (id) on delete set null,
  kind text not null check (kind in ('prop', 'hwm')),
  period text not null,
  gross numeric(18,2) not null check (gross >= 0),
  firm_split numeric(5,4),
  hwm_before numeric(18,2),
  commission numeric(18,2) not null,
  to_investor numeric(18,2) not null,
  status public.payout_status not null default 'pending',
  approved_by uuid references auth.users (id),
  approved_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  check (commission >= 0 and to_investor >= 0)
);

-- ---------- discipline ----------
create table public.mood_checkins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  phase text not null check (phase in ('pre', 'post')),
  score smallint not null check (score between 1 and 10),
  tags text[] not null default '{}',
  sleep_hours numeric(4,1),
  note text,
  at timestamptz not null default now()
);

create table public.alert_rules (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  event text not null,
  channels text[] not null default '{app}',
  enabled boolean not null default true
);

-- ---------- Telegram subscriptions & tracking ----------
create table public.subscription_plans (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  price_inr numeric(12,2) not null check (price_inr >= 0),
  months smallint not null check (months between 1 and 12),
  active boolean not null default true
);

create table public.tracked_links (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  source text not null,
  campaign text,
  target_url text not null,
  created_at timestamptz not null default now()
);

create table public.link_clicks (
  id bigint generated always as identity primary key,
  link_id uuid not null references public.tracked_links (id) on delete cascade,
  visitor_hash text,
  at timestamptz not null default now()
);
create index on public.link_clicks (link_id, at);

create table public.tg_members (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint unique not null,
  username text,
  source text,
  first_link_id uuid references public.tracked_links (id),
  invite_link text,
  plan_id uuid references public.subscription_plans (id),
  status text not null default 'free' check (status in ('free', 'active', 'expiring', 'lapsed', 'removed')),
  paid_until timestamptz,
  first_seen timestamptz not null default now()
);

create table public.tg_events (
  id bigint generated always as identity primary key,
  tg_member_id uuid references public.tg_members (id) on delete cascade,
  type public.tg_event_type not null,
  chat text not null check (chat in ('vip', 'free')),
  amount_inr numeric(12,2),
  payload jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);
create index on public.tg_events (type, at);

create table public.tg_posts (
  id uuid primary key default gen_random_uuid(),
  destination text not null check (destination in ('vip', 'free', 'both')),
  kind text not null,
  signal_id uuid references public.signals (id) on delete set null,
  telegram_message_id bigint,
  views integer,
  reactions integer,
  clicks integer,
  status text not null default 'queued' check (status in ('queued', 'sent', 'failed', 'blocked')),
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

-- ---------- audit (append-only) ----------
create table public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor uuid,
  action text not null,
  entity text not null,
  entity_id text,
  data jsonb not null default '{}'::jsonb
);

create or replace function public.audit_row() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.audit_log (actor, action, entity, entity_id, data)
  values (auth.uid(), lower(tg_op), tg_table_name,
          coalesce((case when tg_op = 'DELETE' then old.id else new.id end)::text, null),
          case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end);
  return coalesce(new, old);
end $$;

create trigger audit_trading_accounts after insert or update or delete on public.trading_accounts for each row execute function public.audit_row();
create trigger audit_copy_routes after insert or update or delete on public.copy_routes for each row execute function public.audit_row();
create trigger audit_investors after insert or update or delete on public.investors for each row execute function public.audit_row();
create trigger audit_payouts after insert or update or delete on public.payouts for each row execute function public.audit_row();
create trigger audit_prop_purchases after insert or update or delete on public.prop_purchases for each row execute function public.audit_row();
create trigger audit_edge_configs after insert or update or delete on public.edge_configs for each row execute function public.audit_row();

create or replace function public.block_audit_change() returns trigger
language plpgsql as $$ begin raise exception 'audit_log is append-only'; end $$;
create trigger audit_log_immutable before update or delete on public.audit_log for each row execute function public.block_audit_change();

-- ---------- row level security ----------
alter table public.members enable row level security;
alter table public.investors enable row level security;
alter table public.trading_accounts enable row level security;
alter table public.venue_credentials enable row level security;
alter table public.prop_purchases enable row level security;
alter table public.copy_routes enable row level security;
alter table public.edge_configs enable row level security;
alter table public.signals enable row level security;
alter table public.orders enable row level security;
alter table public.trades enable row level security;
alter table public.payouts enable row level security;
alter table public.mood_checkins enable row level security;
alter table public.alert_rules enable row level security;
alter table public.subscription_plans enable row level security;
alter table public.tracked_links enable row level security;
alter table public.link_clicks enable row level security;
alter table public.tg_members enable row level security;
alter table public.tg_events enable row level security;
alter table public.tg_posts enable row level security;
alter table public.audit_log enable row level security;

-- members: see yourself; staff see and manage everyone
create policy members_self_read on public.members for select to authenticated using (user_id = (select auth.uid()) or (select public.is_staff()));
create policy members_staff_write on public.members for all to authenticated using ((select public.is_staff())) with check ((select public.is_staff()));

-- staff-only tables
do $$
declare t text;
begin
  foreach t in array array['venue_credentials','copy_routes','edge_configs','signals','orders','alert_rules','subscription_plans','tracked_links','link_clicks','tg_members','tg_events','tg_posts']
  loop
    execute format('create policy %I on public.%I for all to authenticated using ((select public.is_staff())) with check ((select public.is_staff()))', t || '_staff', t);
  end loop;
end $$;

-- audit: staff read only (inserts come from the security-definer trigger)
create policy audit_staff_read on public.audit_log for select to authenticated using ((select public.is_staff()));

-- investor-visible tables: staff all, investors read their own
create policy investors_staff on public.investors for all to authenticated using ((select public.is_staff())) with check ((select public.is_staff()));
create policy investors_self_read on public.investors for select to authenticated using (user_id = (select auth.uid()));

create policy accounts_staff on public.trading_accounts for all to authenticated using ((select public.is_staff())) with check ((select public.is_staff()));
create policy accounts_investor_read on public.trading_accounts for select to authenticated using (investor_id in (select public.my_investor_ids()));

create policy purchases_staff on public.prop_purchases for all to authenticated using ((select public.is_staff())) with check ((select public.is_staff()));
create policy purchases_investor_read on public.prop_purchases for select to authenticated using (investor_id in (select public.my_investor_ids()));

create policy trades_staff on public.trades for all to authenticated using ((select public.is_staff())) with check ((select public.is_staff()));
create policy trades_investor_read on public.trades for select to authenticated using (
  account_id in (select id from public.trading_accounts where investor_id in (select public.my_investor_ids()))
);

create policy payouts_staff on public.payouts for all to authenticated using ((select public.is_staff())) with check ((select public.is_staff()));
create policy payouts_investor_read on public.payouts for select to authenticated using (investor_id in (select public.my_investor_ids()));

-- mood: own rows only (staff included)
create policy mood_own on public.mood_checkins for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- lock down helper functions
revoke all on function public.is_staff() from public, anon;
revoke all on function public.my_role() from public, anon;
revoke all on function public.my_investor_ids() from public, anon;
grant execute on function public.is_staff() to authenticated;
grant execute on function public.my_role() to authenticated;
grant execute on function public.my_investor_ids() to authenticated;
revoke all on function public.audit_row() from public, anon, authenticated;
