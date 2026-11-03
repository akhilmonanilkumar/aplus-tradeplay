-- cTrader sync: trades closed on the prop accounts are imported once each (keyed by the broker's deal id).
alter table public.trades add column if not exists external_id text;
create unique index if not exists trades_account_external_uq on public.trades (account_id, external_id);
alter table public.trading_accounts add column if not exists synced_at timestamptz;

-- Trades that arrive already closed (cTrader imports) announce one "closed" message, and only when they
-- closed in the last hour, so the first import of past trades does not flood notifications.
create or replace function public.trg_notify_trades() returns trigger language plpgsql security definer set search_path = public as $$
declare acc text; kind text;
begin
  select name into acc from public.trading_accounts where id = new.account_id;
  kind := case when new.source = 'paper' then 'paper' when new.source = 'ctrader' then 'cTrader' else 'real' end;
  if tg_op = 'INSERT' and new.exit is null then
    perform public.notify('trade', 'info', format('%s %s opened (%s)', new.instrument, new.side, kind),
      format('Entry %s · stop %s%s · %s', new.entry, new.stop, coalesce(' · target ' || new.target, ''), coalesce(acc, '')),
      new.instrument, null, 'trade-open:' || new.id, jsonb_build_object('trade_id', new.id, 'source', new.source));
  elsif (tg_op = 'INSERT' and new.exit is not null and coalesce(new.closed_at, now()) > now() - interval '1 hour')
     or (tg_op = 'UPDATE' and old.exit is null and new.exit is not null) then
    perform public.notify('trade', case when coalesce(new.pnl, 0) > 0 then 'success' else 'warn' end,
      format('%s %s closed %s%sR (%s)', new.instrument, new.side, case when coalesce(new.realized_r, 0) > 0 then '+' else '' end, round(coalesce(new.realized_r, 0)::numeric, 2), kind),
      format('%s → %s · P&L %s · fees %s · %s', new.entry, new.exit, round(coalesce(new.pnl, 0)::numeric, 2), round(coalesce(new.fees, 0)::numeric, 2), coalesce(acc, '')),
      new.instrument, '/analytics', 'trade-close:' || new.id, jsonb_build_object('trade_id', new.id, 'r', new.realized_r, 'pnl', new.pnl));
  end if;
  return new;
end $$;
