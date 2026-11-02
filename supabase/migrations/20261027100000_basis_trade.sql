-- Funding basis trade (cash-and-carry), tracked on paper with its own P&L.
-- Long spot + short perp of equal size: price moves cancel, the short collects funding while it is
-- positive, and the position is closed when funding turns negative.

create table if not exists public.basis_config (
  id smallint primary key default 1 check (id = 1),
  enabled boolean not null default true,
  mode text not null default 'paper' check (mode in ('off', 'paper')),
  symbols text[] not null default array['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT'],
  notional numeric not null default 10000,
  -- Enter when the predicted rate per 8h is at least this (0.0001 = 0.01% ≈ 11% APR) and the 3-day average is positive.
  entry_rate numeric not null default 0.0001,
  -- Exit when a settled or predicted rate falls below this (0 = funding negative).
  exit_rate numeric not null default 0,
  max_open integer not null default 4,
  spot_fee numeric not null default 0.001,
  perp_fee numeric not null default 0.0005,
  updated_at timestamptz not null default now()
);
insert into public.basis_config (id) values (1) on conflict (id) do nothing;

create table if not exists public.basis_positions (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  side text not null default 'carry' check (side in ('carry')),
  status text not null default 'open' check (status in ('open', 'closed')),
  qty numeric not null,
  notional numeric not null,
  spot_entry numeric not null,
  perp_entry numeric not null,
  spot_exit numeric,
  perp_exit numeric,
  entry_rate numeric,
  entry_avg3d numeric,
  funding numeric not null default 0,
  funding_count integer not null default 0,
  last_funding_at timestamptz,
  fees numeric not null default 0,
  spot_fee numeric not null,
  perp_fee numeric not null,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  exit_reason text,
  source text not null default 'auto' check (source in ('auto', 'manual'))
);
create index if not exists basis_positions_status_idx on public.basis_positions (status, symbol);

create table if not exists public.basis_funding (
  id bigserial primary key,
  position_id uuid not null references public.basis_positions (id) on delete cascade,
  symbol text not null,
  funding_time timestamptz not null,
  rate numeric not null,
  mark numeric not null,
  amount numeric not null,
  unique (position_id, funding_time)
);
create index if not exists basis_funding_position_idx on public.basis_funding (position_id, funding_time);

alter table public.basis_config enable row level security;
alter table public.basis_positions enable row level security;
alter table public.basis_funding enable row level security;
do $$
declare t text;
begin
  foreach t in array array['basis_config', 'basis_positions', 'basis_funding'] loop
    execute format('drop policy if exists %I on public.%I', t || '_staff', t);
    execute format('create policy %I on public.%I for all to authenticated using ((select public.is_staff())) with check ((select public.is_staff()))', t || '_staff', t);
  end loop;
end $$;
