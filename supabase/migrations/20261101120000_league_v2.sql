-- v2 Strategy League: candidates per venue with lifecycle stages and versioned gates, the strategy
-- development agent's runs, and a clean start (records before reset_at are kept but not counted).

alter table public.strategy_candidates
  add column if not exists venue text,
  add column if not exists stage text not null default 'paper',
  add column if not exists stage_since timestamptz not null default now(),
  add column if not exists gate_version text,
  add column if not exists origin text not null default 'catalogue',
  add column if not exists backtest jsonb,
  add column if not exists notes text;

alter table public.strategy_candidates drop constraint if exists strategy_candidates_stage_chk;
alter table public.strategy_candidates add constraint strategy_candidates_stage_chk
  check (stage in ('paper', 'candidate', 'live_small', 'live', 'benched', 'retired'));
alter table public.strategy_candidates drop constraint if exists strategy_candidates_venue_chk;
alter table public.strategy_candidates add constraint strategy_candidates_venue_chk
  check (venue is null or venue in ('cfd', 'delta', 'coinswitch', 'fyers'));
create index if not exists strategy_candidates_venue_stage_idx on public.strategy_candidates (venue, stage);

-- v1 candidates (keys without a venue) are retired: the League starts fresh on v2 data.
update public.strategy_candidates
  set stage = 'retired', status = case when status = 'live' then 'benched' else status end, status_reason = 'retired at the v2 restart'
  where venue is null and key not like '%/%';

-- Start counting from now. Older signals stay in the database for reference.
update public.app_settings
  set integrations = coalesce(integrations, '{}'::jsonb) || jsonb_build_object('league', coalesce(integrations->'league', '{}'::jsonb) || jsonb_build_object('reset_at', now()))
  where id = 1 and (integrations->'league'->>'reset_at') is null;

create table if not exists public.strategy_agent_runs (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  status text not null default 'running' check (status in ('running', 'done', 'failed')),
  trigger text not null default 'schedule',
  summary text,
  findings jsonb not null default '[]'::jsonb,
  proposals jsonb not null default '[]'::jsonb,
  moves jsonb not null default '[]'::jsonb,
  model text,
  error text,
  ms integer
);
create index if not exists strategy_agent_runs_at_idx on public.strategy_agent_runs (at desc);
alter table public.strategy_agent_runs enable row level security;
drop policy if exists strategy_agent_runs_staff on public.strategy_agent_runs;
create policy strategy_agent_runs_staff on public.strategy_agent_runs for all to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));

-- Daily agent run at 01:07 UTC (06:37 IST), after the US close and before Asia gets busy.
-- Uses the same Vault secrets as the autopilot scheduler.
create or replace function public.league_agent_call() returns bigint
language plpgsql security definer set search_path = '' as $$
declare u text; s text;
begin
  select decrypted_secret into u from vault.decrypted_secrets where name = 'autopilot_url';
  select decrypted_secret into s from vault.decrypted_secrets where name = 'autopilot_secret';
  if u is null or s is null then return null; end if;
  return net.http_post(
    url := rtrim(u, '/') || '/api/league/agent',
    headers := jsonb_build_object('Authorization', 'Bearer ' || s, 'Content-Type', 'application/json'),
    body := '{"trigger":"schedule"}'::jsonb,
    timeout_milliseconds := 290000
  );
end $$;
revoke all on function public.league_agent_call() from public, anon, authenticated;
select cron.unschedule(jobname) from cron.job where jobname = 'league-agent-daily';
select cron.schedule('league-agent-daily', '7 1 * * *', 'select public.league_agent_call()');

-- Notifications for every stage move (v1 only knew live and benched).
create or replace function public.trg_notify_candidates() returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.notify('strategy',
    case when new.to_status in ('live', 'live_small') then 'success' when new.to_status = 'benched' then 'warn' else 'info' end,
    format('%s %s', new.key, case new.to_status
      when 'live_small' then 'promoted to live (small size)' when 'live' then 'promoted to full size'
      when 'candidate' then 'cleared every gate' when 'benched' then 'benched' when 'retired' then 'retired' else 'back to paper' end),
    new.reason, split_part(split_part(new.key, '/', 2), ':', 1), '/league', 'cand:' || new.id);
  return new;
end $$;
revoke all on function public.trg_notify_candidates() from public, anon, authenticated;
