-- Paper-trading ledger for every entry model and session strategy, and a scheduler secret that
-- never leaves the database.

-- Session-range strategies (Asia / London range fades and breakouts) log as model 'S';
-- the variant is in meta.strategy.
alter table public.signals drop constraint if exists signals_model_check;
alter table public.signals add constraint signals_model_check check (model = any (array['A','B','C','D','E','F','G','H','I','S']));

-- One row per detected setup: passes look a setup up by its key before logging it.
create index if not exists signals_meta_key_idx on public.signals ((meta->>'key'));
create index if not exists signals_model_created_idx on public.signals (model, created_at desc);

-- Scheduler secret: generated here, read by autopilot_tick_call() for the bearer header and
-- checked by the app through autopilot_secret_ok(), so it is never copied by hand. The URL is the
-- www host: the apex redirects there and the redirect drops the Authorization header.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'autopilot_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'autopilot_secret');
  end if;
  if not exists (select 1 from vault.secrets where name = 'autopilot_url') then
    perform vault.create_secret('https://www.tradeplay.cloud', 'autopilot_url');
  end if;
end $$;

create or replace function public.autopilot_secret_ok(token text) returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select coalesce(length(token) >= 32, false)
     and exists (select 1 from vault.decrypted_secrets where name = 'autopilot_secret' and decrypted_secret = token);
$$;

revoke all on function public.autopilot_secret_ok(text) from public, anon, authenticated;
grant execute on function public.autopilot_secret_ok(text) to service_role;

-- A full pass now evaluates every model on five instruments: give it the route's 300 s.
create or replace function public.autopilot_tick_call() returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  u text;
  s text;
begin
  select decrypted_secret into u from vault.decrypted_secrets where name = 'autopilot_url';
  select decrypted_secret into s from vault.decrypted_secrets where name = 'autopilot_secret';
  if u is null or s is null then
    return null;
  end if;
  return net.http_get(
    url := rtrim(u, '/') || '/api/autopilot/tick',
    headers := jsonb_build_object('Authorization', 'Bearer ' || s),
    timeout_milliseconds := 300000
  );
end;
$$;

revoke all on function public.autopilot_tick_call() from public, anon, authenticated;

-- High-impact releases from the live calendar, kept so later backtests can apply the news filter
-- and model I with real release times (the history feed has none).
create unique index if not exists news_events_at_ccy_title_idx on public.news_events (at, currency, title);
