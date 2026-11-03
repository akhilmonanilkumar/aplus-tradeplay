-- Each arena reads only its own venue's prices. New venue markets: Delta BTCUSD and XAUTUSD perps,
-- CoinSwitch BTCUSDT futures; the Nifty reads Fyers. The older Binance / Coinbase markets stop
-- running (they stay for research), and League records that were kept on Binance prices for Delta
-- and CoinSwitch are retired: those venues start fresh on their own data. Analytics keep all rows.

-- 1. Run the venue markets on paper (no Telegram on every state change; the League routes live alerts).
insert into public.autopilot_config (instrument, mode, events) values
  ('BTCUSD.DELTA', 'paper', '{}'), ('XAUTUSD.DELTA', 'paper', '{}'), ('BTCUSDT.CS', 'paper', '{}')
on conflict (instrument) do nothing;
insert into public.autopilot_config (instrument, mode, events) values ('NIFTY', 'paper', '{}')
on conflict (instrument) do nothing;

-- 2. The CFD BTC market runs on its own (it used to borrow the Binance perp's alerts).
update public.autopilot_config set mode = 'alerts'
  where instrument = 'BTCUSD' and mode = 'off'
    and exists (select 1 from public.autopilot_config where instrument = 'BTCUSDT.P' and mode <> 'off');

-- 3. Stop the older Binance / Coinbase markets.
update public.autopilot_config set mode = 'off', updated_at = now()
  where instrument in ('BTCUSDT.P', 'XAUUSDT.P', 'BTCUSD.SPOT');

-- 4. Retire Delta and CoinSwitch League entries kept on Binance prices, and stop their execution.
update public.strategy_candidates
  set stage = 'retired', stage_since = now(), execute = false,
      status = case when status = 'live' then 'benched' else status end,
      status_reason = 'retired: venue now trades on its own prices'
  where venue in ('delta', 'coinswitch') and instrument in ('BTCUSDT.P', 'XAUUSDT.P', 'BTCUSD.SPOT') and stage <> 'retired';

-- 5. The selector picks CFD alerts only.
update public.app_settings
  set integrations = jsonb_set(integrations, '{selector,universe}', '["XAUUSD", "BTCUSD"]'::jsonb)
  where id = 1 and integrations ? 'selector';
