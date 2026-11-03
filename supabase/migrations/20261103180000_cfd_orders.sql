-- cTrader orders placed from CFD alerts in confirm mode: one row per order (an alert leg with two
-- targets sends two). Pending orders are cancelled when the setup dies or its levels move.
create table if not exists public.cfd_orders (
  id uuid primary key default gen_random_uuid(),
  alert_id uuid not null references public.cfd_alerts (id) on delete cascade,
  leg_id uuid references public.cfd_alert_legs (id) on delete set null,
  account_id uuid references public.trading_accounts (id) on delete set null,
  part smallint not null default 1,
  order_id bigint,
  lots numeric(12,2) not null,
  entry numeric(18,6) not null,
  stop numeric(18,6) not null,
  target numeric(18,6) not null,
  status text not null default 'placing' check (status in ('placing', 'pending', 'cancelled', 'failed')),
  error text,
  placed_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists cfd_orders_alert_idx on public.cfd_orders (alert_id);
create index if not exists cfd_orders_pending_idx on public.cfd_orders (status) where status = 'pending';

alter table public.cfd_orders enable row level security;
drop policy if exists cfd_orders_staff on public.cfd_orders;
create policy cfd_orders_staff on public.cfd_orders for all to authenticated using ((select public.is_staff())) with check ((select public.is_staff()));

-- Every order placed or cancelled is in the audit log.
drop trigger if exists audit_cfd_orders on public.cfd_orders;
create trigger audit_cfd_orders after insert or update or delete on public.cfd_orders for each row execute function public.audit_row();
