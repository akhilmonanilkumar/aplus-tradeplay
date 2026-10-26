-- Bot ledger: every autopilot / selector signal carries its own outcome, tracked on candles
-- whether or not any account traded it, so the bot's performance is measured on its own.
-- Additive only.

alter table public.signals
  add column if not exists meta jsonb not null default '{}'::jsonb,
  add column if not exists outcome text check (outcome in ('pending', 'filled', 'win', 'loss', 'expired', 'ran_away', 'cancelled')),
  add column if not exists filled_at timestamptz,
  add column if not exists closed_at timestamptz,
  add column if not exists exit_price numeric(18,6),
  add column if not exists result_r numeric(8,3),
  add column if not exists net_r numeric(8,3);

create index if not exists signals_source_created on public.signals (source, created_at desc);
create index if not exists signals_open_outcome on public.signals (instrument) where outcome in ('pending', 'filled');
