-- v2 Phase 5: one order log for every venue. CoinSwitch and Fyers orders (shadow first) sit beside
-- Delta's, told apart by venue; client order ids carry the venue so a retried pass never doubles one.
alter table public.live_orders add column if not exists venue text not null default 'delta';
alter table public.live_orders drop constraint if exists live_orders_venue_chk;
alter table public.live_orders add constraint live_orders_venue_chk check (venue in ('delta', 'coinswitch', 'fyers'));
alter table public.live_orders alter column contracts type numeric using contracts::numeric;
create index if not exists live_orders_venue_idx on public.live_orders (venue, created_at desc);
