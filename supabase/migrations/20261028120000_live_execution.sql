-- Live execution on Delta Exchange for promoted strategies. Every order the platform plans for real
-- money is a row here (sent or not, with the risk gate's reasons), keyed by its signal so a retried
-- pass can never place it twice. One state row holds the mode, the risk policy and any halt.

create table if not exists public.live_exec_state (
  id smallint primary key default 1 check (id = 1),
  mode text not null default 'off' check (mode in ('off', 'dry-run', 'testnet', 'production')),
  policy jsonb not null default '{}'::jsonb,
  halted_until timestamptz,
  halt_reason text,
  peak_equity numeric,
  day_date date,
  day_start_equity numeric,
  -- Equity used for sizing in dry-run when no venue keys are set.
  dry_run_equity numeric not null default 1000,
  api_errors jsonb not null default '[]'::jsonb,
  leverage_set jsonb not null default '{}'::jsonb,
  last_sync_at timestamptz,
  last_error text,
  account_id uuid references public.trading_accounts (id),
  updated_at timestamptz not null default now()
);
insert into public.live_exec_state (id) values (1) on conflict (id) do nothing;

create table if not exists public.live_orders (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  signal_id uuid references public.signals (id) on delete set null,
  candidate_key text not null,
  mode text not null check (mode in ('dry-run', 'testnet', 'production')),
  symbol text not null,
  product_id integer,
  side text not null check (side in ('buy', 'sell')),
  contracts integer not null default 0,
  limit_price numeric,
  stop numeric,
  target numeric,
  risk_usd numeric,
  rr numeric,
  basis numeric,
  client_order_id text not null unique,
  exchange_order_id text,
  status text not null check (status in ('rejected', 'dry-run', 'submitted', 'open', 'filled', 'closed', 'cancelled', 'error')),
  reasons text[] not null default '{}',
  error text,
  fill_price numeric,
  filled_at timestamptz,
  exit_price numeric,
  closed_at timestamptz,
  pnl numeric,
  fees numeric,
  trade_id uuid references public.trades (id) on delete set null,
  meta jsonb not null default '{}'::jsonb
);
create index if not exists live_orders_status_idx on public.live_orders (status, created_at desc);

alter table public.strategy_candidates add column if not exists execute boolean not null default true;

alter table public.live_exec_state enable row level security;
alter table public.live_orders enable row level security;
do $$
declare t text;
begin
  foreach t in array array['live_exec_state', 'live_orders'] loop
    execute format('drop policy if exists %I on public.%I', t || '_staff', t);
    execute format('create policy %I on public.%I for all to authenticated using ((select public.is_staff())) with check ((select public.is_staff()))', t || '_staff', t);
  end loop;
end $$;

-- Every live order and every status change lands in the notifications feed.
create or replace function public.trg_notify_live_orders() returns trigger language plpgsql security definer set search_path = public as $$
declare sev text; title text;
begin
  if tg_op = 'UPDATE' and old.status is not distinct from new.status then return new; end if;
  sev := case new.status when 'filled' then 'success' when 'closed' then case when coalesce(new.pnl, 0) > 0 then 'success' else 'warn' end
    when 'error' then 'critical' when 'rejected' then 'info' when 'cancelled' then 'info' else 'info' end;
  title := format('%s %s %s %s', upper(new.mode), new.symbol, new.side, case new.status
    when 'dry-run' then 'planned (dry run)' when 'submitted' then 'order sent' when 'open' then 'order working'
    when 'filled' then 'filled' when 'closed' then format('closed %s', coalesce(round(new.pnl, 2)::text, '')) when 'rejected' then 'skipped by risk gate'
    when 'cancelled' then 'cancelled' else 'error' end);
  perform public.notify('strategy', sev, title,
    concat_ws(' · ', new.contracts || ' contracts', 'limit ' || new.limit_price, 'SL ' || new.stop, 'TP ' || new.target, nullif(array_to_string(new.reasons, '; '), ''), new.error),
    null, '/live', 'lo:' || new.id || ':' || new.status, jsonb_build_object('live_order_id', new.id, 'candidate', new.candidate_key));
  return new;
end $$;
drop trigger if exists notify_live_orders on public.live_orders;
create trigger notify_live_orders after insert or update of status on public.live_orders for each row execute function public.trg_notify_live_orders();
revoke all on function public.trg_notify_live_orders() from public, anon, authenticated;
