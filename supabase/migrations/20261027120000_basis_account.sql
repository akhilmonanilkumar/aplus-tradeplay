-- Funding basis: a separate simulated account. Capital is split between the spot wallet (long leg)
-- and the futures wallet (short-leg margin) by leverage, with a reserve kept aside to top up margin.
-- Positions are sized from the account, carry a liquidation price, and the bot moves margin over when
-- a rally eats into the buffer.

alter table public.basis_config
  add column if not exists capital numeric not null default 1000,
  add column if not exists leverage numeric not null default 1 check (leverage > 0 and leverage <= 5),
  add column if not exists mmr numeric not null default 0.005,
  add column if not exists reserve_share numeric not null default 0.1 check (reserve_share >= 0 and reserve_share < 1),
  add column if not exists rebalance_at numeric not null default 0.5 check (rebalance_at > 0 and rebalance_at < 1),
  add column if not exists min_notional numeric not null default 50,
  add column if not exists venue text not null default 'binance' check (venue in ('binance', 'coinswitch')),
  -- Hold through short negative runs: enter on the 7-day average, exit when the 7-day average turns negative.
  add column if not exists entry_avg numeric not null default 0.00005,
  add column if not exists exit_avg numeric not null default 0;

alter table public.basis_positions
  add column if not exists margin numeric,
  add column if not exists leverage numeric,
  add column if not exists mmr numeric,
  add column if not exists liq_price numeric,
  add column if not exists top_ups numeric not null default 0,
  add column if not exists top_up_count integer not null default 0,
  add column if not exists max_mark numeric;

-- Start the account on the researched defaults (bot stays off until switched on from the page).
update public.basis_config
set symbols = array['BTCUSDT'], max_open = 1, notional = 0
where id = 1;
