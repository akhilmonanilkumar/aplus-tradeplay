-- Edit and delete across the app: an account can be deleted even when the live executor once
-- traded or tracked it. Its live order log stays, without the account link. Additive only.

alter table public.live_orders drop constraint if exists live_orders_account_id_fkey;
alter table public.live_orders add constraint live_orders_account_id_fkey
  foreign key (account_id) references public.trading_accounts (id) on delete set null;

alter table public.live_exec_state drop constraint if exists live_exec_state_account_id_fkey;
alter table public.live_exec_state add constraint live_exec_state_account_id_fkey
  foreign key (account_id) references public.trading_accounts (id) on delete set null;
