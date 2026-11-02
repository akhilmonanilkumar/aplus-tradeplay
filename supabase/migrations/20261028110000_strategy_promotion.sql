-- Strategy promotion: every market × entry model (or session strategy) is a candidate, paper traded
-- for as long as the app runs. Candidates whose recent paper record clears the promotion rules go live
-- (their signals are routed to live alerts); live strategies whose record decays are benched and the
-- best waiting candidate takes the slot. Rules live in app_settings.integrations.promotion.

create table if not exists public.strategy_candidates (
  key text primary key,                  -- instrument:model[:strategy]
  instrument text not null,
  model text not null,
  strategy text,
  status text not null default 'paper' check (status in ('paper', 'live', 'benched')),
  pinned boolean not null default false,  -- staff override: stays live / stays out regardless of rules
  route_alerts boolean not null default true,
  stats jsonb not null default '{}'::jsonb,
  live_since timestamptz,
  benched_at timestamptz,
  status_reason text,
  updated_at timestamptz not null default now()
);
create index if not exists strategy_candidates_status_idx on public.strategy_candidates (status);

create table if not exists public.candidate_events (
  id bigserial primary key,
  at timestamptz not null default now(),
  key text not null references public.strategy_candidates (key) on delete cascade,
  from_status text,
  to_status text not null,
  reason text,
  stats jsonb not null default '{}'::jsonb,
  by_user uuid
);
create index if not exists candidate_events_key_idx on public.candidate_events (key, at desc);

alter table public.strategy_candidates enable row level security;
alter table public.candidate_events enable row level security;
do $$
declare t text;
begin
  foreach t in array array['strategy_candidates', 'candidate_events'] loop
    execute format('drop policy if exists %I on public.%I', t || '_staff', t);
    execute format('create policy %I on public.%I for all to authenticated using ((select public.is_staff())) with check ((select public.is_staff()))', t || '_staff', t);
  end loop;
end $$;

-- Every promotion and bench lands in the notifications feed.
create or replace function public.trg_notify_candidates() returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.notify('strategy', case when new.to_status = 'live' then 'success' when new.to_status = 'benched' then 'warn' else 'info' end,
    format('%s %s', new.key, case new.to_status when 'live' then 'promoted to live' when 'benched' then 'benched' else 'back to paper' end),
    new.reason, split_part(new.key, ':', 1), '/live', 'cand:' || new.id);
  return new;
end $$;
drop trigger if exists notify_candidates on public.candidate_events;
create trigger notify_candidates after insert on public.candidate_events for each row execute function public.trg_notify_candidates();
revoke all on function public.trg_notify_candidates() from public, anon, authenticated;
