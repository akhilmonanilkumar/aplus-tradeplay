-- Edit and delete across the app: an account can be deleted even when the live executor once used it.
-- The executor's state keeps running without the account link. Safe on databases without the column.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'live_exec_state' and column_name = 'account_id'
  ) then
    alter table public.live_exec_state drop constraint if exists live_exec_state_account_id_fkey;
    alter table public.live_exec_state add constraint live_exec_state_account_id_fkey
      foreign key (account_id) references public.trading_accounts (id) on delete set null;
  end if;
end $$;
