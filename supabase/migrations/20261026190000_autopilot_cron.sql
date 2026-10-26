-- Autopilot scheduler inside the database: pg_cron calls /api/autopilot/tick through pg_net.
-- GitHub's scheduled workflows are best-effort and skipped most 5-minute slots, so the bot
-- missed whole session windows. The URL and bearer secret live in Vault:
--   select vault.create_secret('https://www.tradeplay.cloud', 'autopilot_url');
--   select vault.create_secret('<AUTOPILOT_SECRET>', 'autopilot_secret');
-- Until both exist the job is a no-op.

create extension if not exists pg_cron;
create extension if not exists pg_net;

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
    timeout_milliseconds := 60000
  );
end;
$$;

revoke all on function public.autopilot_tick_call() from public, anon, authenticated;

-- Every 5 minutes from 05:00 to 16:55 UTC (London Q and NY Q in both EDT and EST, plus the
-- London close), every 15 minutes otherwise to keep tracking open signals and paper orders.
select cron.unschedule(jobname) from cron.job where jobname in ('autopilot-tick-sessions', 'autopilot-tick-offhours');
select cron.schedule('autopilot-tick-sessions', '*/5 5-16 * * *', 'select public.autopilot_tick_call()');
select cron.schedule('autopilot-tick-offhours', '*/15 0-4,17-23 * * *', 'select public.autopilot_tick_call()');
