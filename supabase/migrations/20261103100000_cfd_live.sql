-- CFD live board: each confirmed CFD alert carries where it is in its life (armed, at the entry, in the
-- trade, ended), why it ended, and every time its levels moved before a fill. Additive only.

alter table public.cfd_alerts
  add column if not exists phase text not null default 'armed',
  add column if not exists outcome text,
  add column if not exists ended_reason text,
  add column if not exists filled_at timestamptz,
  add column if not exists ended_at timestamptz,
  add column if not exists result_r numeric(8,3),
  add column if not exists levels_at timestamptz,
  add column if not exists revisions jsonb not null default '[]'::jsonb,
  add column if not exists checked_at timestamptz,
  add column if not exists strikes int not null default 0;

alter table public.cfd_alerts drop constraint if exists cfd_alerts_phase_check;
alter table public.cfd_alerts add constraint cfd_alerts_phase_check check (phase in ('armed', 'trigger', 'in_trade', 'ended'));
alter table public.cfd_alerts drop constraint if exists cfd_alerts_outcome_check;
alter table public.cfd_alerts add constraint cfd_alerts_outcome_check check (outcome is null or outcome in ('win', 'partial', 'loss', 'expired', 'ran_away', 'dead'));

-- Alerts from before this change: the levels date from when they were sent; old ones are closed out.
update public.cfd_alerts set levels_at = created_at where levels_at is null;
update public.cfd_alerts set phase = 'ended', outcome = 'expired', ended_at = expires_at, ended_reason = 'expired before the live board'
  where phase = 'armed' and expires_at < now() - interval '1 day';

create index if not exists cfd_alerts_open_idx on public.cfd_alerts (created_at desc) where phase <> 'ended';
