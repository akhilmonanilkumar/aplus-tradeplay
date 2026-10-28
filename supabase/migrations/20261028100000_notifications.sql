-- Notifications for every app event, with per-user controls.
-- Events are written by triggers on the tables where they already land (trades, orders, autopilot
-- state, basis positions, payouts, cash flows, settings) plus proactive heads-ups from the autopilot.
-- Each staff user keeps their own preferences (what shows in the bell, browser pop-ups, sound, quiet
-- hours); Telegram routing per category lives in app_settings.integrations.notify.

create table if not exists public.notifications (
  id bigserial primary key,
  at timestamptz not null default now(),
  category text not null check (category in ('setup', 'trade', 'headsup', 'news', 'feed', 'basis', 'account', 'system')),
  severity text not null default 'info' check (severity in ('info', 'success', 'warn', 'critical')),
  title text not null,
  body text,
  instrument text,
  desk text,
  link text,
  dedupe_key text unique,
  meta jsonb not null default '{}'::jsonb,
  telegram_at timestamptz
);
create index if not exists notifications_at_idx on public.notifications (at desc);
create index if not exists notifications_desk_idx on public.notifications (desk, at desc);

create table if not exists public.notification_prefs (
  user_id uuid primary key references auth.users (id) on delete cascade,
  prefs jsonb not null default '{}'::jsonb,
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.notifications enable row level security;
alter table public.notification_prefs enable row level security;
drop policy if exists notifications_staff on public.notifications;
create policy notifications_staff on public.notifications for all to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));
drop policy if exists notification_prefs_own on public.notification_prefs;
create policy notification_prefs_own on public.notification_prefs for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Desk of an instrument id, for filtering and links.
create or replace function public.desk_of(i text) returns text language sql immutable as $$
  select case
    when i like 'XAU%' then 'gold'
    when i like 'BTC%' then 'btc'
    when i in ('EURUSD', 'USDJPY') then 'fx'
    when i in ('NAS100', 'SPX500', 'NIFTY') then 'indices'
    else null end
$$;

create or replace function public.notify(p_category text, p_severity text, p_title text, p_body text, p_instrument text default null, p_link text default null, p_key text default null, p_meta jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.notifications (category, severity, title, body, instrument, desk, link, dedupe_key, meta)
  values (p_category, p_severity, p_title, p_body, p_instrument, public.desk_of(p_instrument),
          coalesce(p_link, case when public.desk_of(p_instrument) is not null then '/desk/' || public.desk_of(p_instrument) || '?i=' || p_instrument end),
          p_key, coalesce(p_meta, '{}'::jsonb))
  on conflict (dedupe_key) do nothing;
end $$;
revoke all on function public.notify(text, text, text, text, text, text, text, jsonb) from public, anon, authenticated;

-- Trades: opened and closed (paper and real).
create or replace function public.trg_notify_trades() returns trigger language plpgsql security definer set search_path = public as $$
declare acc text; kind text;
begin
  select name into acc from public.trading_accounts where id = new.account_id;
  kind := case when new.source = 'paper' then 'paper' else 'real' end;
  if tg_op = 'INSERT' then
    perform public.notify('trade', 'info', format('%s %s opened (%s)', new.instrument, new.side, kind),
      format('Entry %s · stop %s%s · %s', new.entry, new.stop, coalesce(' · target ' || new.target, ''), coalesce(acc, '')),
      new.instrument, null, 'trade-open:' || new.id, jsonb_build_object('trade_id', new.id, 'source', new.source));
  elsif tg_op = 'UPDATE' and old.exit is null and new.exit is not null then
    perform public.notify('trade', case when coalesce(new.pnl, 0) > 0 then 'success' else 'warn' end,
      format('%s %s closed %s%sR (%s)', new.instrument, new.side, case when coalesce(new.realized_r, 0) > 0 then '+' else '' end, round(coalesce(new.realized_r, 0)::numeric, 2), kind),
      format('%s → %s · P&L %s · fees %s · %s', new.entry, new.exit, round(coalesce(new.pnl, 0)::numeric, 2), round(coalesce(new.fees, 0)::numeric, 2), coalesce(acc, '')),
      new.instrument, '/analytics', 'trade-close:' || new.id, jsonb_build_object('trade_id', new.id, 'r', new.realized_r, 'pnl', new.pnl));
  end if;
  return new;
end $$;
drop trigger if exists notify_trades on public.trades;
create trigger notify_trades after insert or update of exit on public.trades for each row execute function public.trg_notify_trades();

-- Paper orders: queued and cancelled (fills arrive as trade opens).
create or replace function public.trg_notify_orders() returns trigger language plpgsql security definer set search_path = public as $$
declare inst text;
begin
  select instrument into inst from public.signals where id = new.signal_id;
  if tg_op = 'INSERT' then
    perform public.notify('trade', 'info', format('%s %s order queued (%s)', coalesce(inst, ''), new.side, lower(new.action)),
      format('Limit %s · stop %s · target %s', new.entry, new.stop, new.target), inst, null, 'order:' || new.id, jsonb_build_object('order_id', new.id));
  elsif tg_op = 'UPDATE' and old.status is distinct from new.status and new.status = 'cancelled' then
    perform public.notify('trade', 'info', format('%s %s order cancelled', coalesce(inst, ''), new.side),
      coalesce(array_to_string(new.reasons, ' · '), ''), inst, null, 'order-cancel:' || new.id, jsonb_build_object('order_id', new.id));
  end if;
  return new;
end $$;
drop trigger if exists notify_orders on public.orders;
create trigger notify_orders after insert or update of status on public.orders for each row execute function public.trg_notify_orders();

-- Autopilot state changes and errors.
create or replace function public.trg_notify_runs() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.state = 'ERROR' then
    perform public.notify('system', 'warn', format('%s autopilot error', new.instrument), left(coalesce(new.detail ->> 'error', new.action, ''), 300),
      nullif(new.instrument, 'SELECTOR'), '/autopilot', 'run-error:' || new.instrument || ':' || to_char(new.at, 'YYYYMMDDHH24'));
  elsif new.state in ('ARMED', 'SHIFTED', 'SWEPT') then
    perform public.notify('setup', case when new.state = 'ARMED' then 'success' else 'info' end,
      format('%s %s %s', new.instrument, coalesce(new.side, ''), case new.state when 'ARMED' then 'is ARMED: all boxes pass' when 'SHIFTED' then 'shifted: 5M structure broke' else 'swept liquidity' end),
      concat_ws(' · ', 'price ' || new.price, 'grade ' || new.grade, nullif(array_to_string(array(select jsonb_array_elements_text(coalesce(new.detail -> 'waitingFor', '[]'::jsonb))), ', '), '')),
      new.instrument, null, 'run:' || new.id, jsonb_build_object('state', new.state));
  end if;
  return new;
end $$;
drop trigger if exists notify_runs on public.autopilot_runs;
create trigger notify_runs after insert on public.autopilot_runs for each row execute function public.trg_notify_runs();

-- Basis positions: opened, margin top-ups, closed or liquidated.
create or replace function public.trg_notify_basis() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform public.notify('basis', 'info', format('Basis opened: %s', new.symbol), format('Long spot %s / short perp %s · notional $%s', new.spot_entry, new.perp_entry, round(new.notional, 0)), null, '/basis', 'basis-open:' || new.id);
  elsif new.status = 'closed' and old.status = 'open' then
    perform public.notify('basis', case when new.exit_reason like 'liquidated%' then 'critical' else 'info' end, format('Basis closed: %s', new.symbol),
      concat_ws(' · ', new.exit_reason, 'funding $' || round(new.funding, 2), 'settlements ' || new.funding_count), null, '/basis', 'basis-close:' || new.id);
  elsif coalesce(new.top_up_count, 0) > coalesce(old.top_up_count, 0) then
    perform public.notify('basis', 'warn', format('Basis margin top-up: %s', new.symbol), format('Reserve moved to margin, total $%s · liquidation now %s', round(new.top_ups, 2), round(coalesce(new.liq_price, 0), 2)), null, '/basis', 'basis-topup:' || new.id || ':' || new.top_up_count);
  end if;
  return new;
end $$;
drop trigger if exists notify_basis on public.basis_positions;
create trigger notify_basis after insert or update on public.basis_positions for each row execute function public.trg_notify_basis();

-- Money movements: payouts and cash flows.
create or replace function public.trg_notify_money() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'payouts' then
    if tg_op = 'INSERT' then
      perform public.notify('account', 'info', 'Payout created', format('%s · to investor $%s · %s', new.kind, round(coalesce(new.to_investor, 0), 2), new.status), null, '/admin', 'payout:' || new.id);
    elsif old.status is distinct from new.status then
      perform public.notify('account', 'info', format('Payout %s', new.status), format('%s · to investor $%s', new.kind, round(coalesce(new.to_investor, 0), 2)), null, '/admin', 'payout:' || new.id || ':' || new.status);
    end if;
  else
    perform public.notify('account', 'info', format('Cash flow: %s', new.kind), format('$%s%s', round(new.amount, 2), coalesce(' · ' || new.note, '')), null, '/accounts', 'flow:' || new.id);
  end if;
  return new;
end $$;
drop trigger if exists notify_payouts on public.payouts;
create trigger notify_payouts after insert or update of status on public.payouts for each row execute function public.trg_notify_money();
drop trigger if exists notify_cash_flows on public.cash_flows;
create trigger notify_cash_flows after insert on public.cash_flows for each row execute function public.trg_notify_money();

-- Settings: kill switch and execution mode.
create or replace function public.trg_notify_settings() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.kill_switch is distinct from new.kill_switch then
    perform public.notify('system', case when new.kill_switch then 'critical' else 'info' end, case when new.kill_switch then 'Kill switch ON' else 'Kill switch off' end,
      case when new.kill_switch then 'No orders are sent to any account.' else 'Order routing resumed.' end, null, '/settings', 'kill:' || extract(epoch from new.updated_at)::bigint);
  end if;
  if old.mode is distinct from new.mode then
    perform public.notify('system', case when new.mode = 'LIVE' then 'critical' else 'info' end, format('Execution mode: %s', new.mode), null, null, '/settings', 'mode:' || extract(epoch from new.updated_at)::bigint);
  end if;
  return new;
end $$;
drop trigger if exists notify_settings on public.app_settings;
create trigger notify_settings after update on public.app_settings for each row execute function public.trg_notify_settings();

revoke all on function public.trg_notify_trades(), public.trg_notify_orders(), public.trg_notify_runs(), public.trg_notify_basis(), public.trg_notify_money(), public.trg_notify_settings() from public, anon, authenticated;
