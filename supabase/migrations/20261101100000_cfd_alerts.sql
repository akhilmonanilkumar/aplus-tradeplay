-- v2 CFD Arena: alerts sized per prop account under the firm's rules, sent to Telegram with cTrader
-- signal links, and marked taken or skipped from Telegram or the app.

create table if not exists public.cfd_alerts (
  id uuid primary key default gen_random_uuid(),
  signal_id uuid references public.signals (id) on delete set null,
  instrument text not null,           -- engine instrument the setup came from
  symbol text not null,               -- cTrader CFD symbol
  side text not null check (side in ('long', 'short')),
  model text,
  grade text,
  entry numeric(18,6) not null,
  stop numeric(18,6) not null,
  tp1 numeric(18,6) not null,
  tp2 numeric(18,6) not null,
  expires_at timestamptz not null,
  status text not null default 'armed' check (status in ('armed', 'taken', 'skipped', 'expired')),
  why text[] not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists cfd_alerts_created_idx on public.cfd_alerts (created_at desc);
create unique index if not exists cfd_alerts_signal_uq on public.cfd_alerts (signal_id) where signal_id is not null;

-- One leg per account: its size under the rules, the link it was sent with, and what the trader did.
create table if not exists public.cfd_alert_legs (
  id uuid primary key default gen_random_uuid(),
  alert_id uuid not null references public.cfd_alerts (id) on delete cascade,
  account_id uuid not null references public.trading_accounts (id) on delete cascade,
  lots numeric(12,2) not null,
  legs numeric(12,2)[] not null default '{}',
  risk_amount numeric(14,2) not null,
  bound_by text not null,
  blocked text,
  link text,
  action text check (action in ('taken', 'skipped')),
  action_at timestamptz,
  action_by text,
  unique (alert_id, account_id)
);

alter table public.cfd_alerts enable row level security;
alter table public.cfd_alert_legs enable row level security;
do $$
declare t text;
begin
  foreach t in array array['cfd_alerts', 'cfd_alert_legs'] loop
    execute format('drop policy if exists %I on public.%I', t || '_staff', t);
    execute format('create policy %I on public.%I for all to authenticated using ((select public.is_staff())) with check ((select public.is_staff()))', t || '_staff', t);
  end loop;
end $$;

-- Telegram alerts carry inline buttons; the message id lets the webhook update the buttons after a tap.
alter table public.telegram_alerts add column if not exists cfd_alert_id uuid references public.cfd_alerts (id) on delete set null;
