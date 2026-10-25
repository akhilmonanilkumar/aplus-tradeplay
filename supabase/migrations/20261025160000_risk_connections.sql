-- Dynamic risk rules, auto-trade modes, inbound/outbound webhooks, vault-backed venue keys.
alter table public.app_settings
  add column if not exists equity_throttle boolean not null default true,
  add column if not exists prop_buffer boolean not null default true,
  add column if not exists auto_modes jsonb not null default '{"XAUUSD":"Confirm","BTCUSDT.P":"Paper","GOLDM":"Off"}'::jsonb,
  add column if not exists webhook_token text not null default encode(extensions.gen_random_bytes(18), 'hex');

create table public.webhooks_out (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  url text not null check (url like 'https://%'),
  events text[] not null default '{ARMED,filled}',
  signing text not null default 'HMAC-SHA256',
  last_status text,
  last_at timestamptz,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.webhooks_out enable row level security;
create policy webhooks_out_staff on public.webhooks_out for all to authenticated using ((select public.is_staff())) with check ((select public.is_staff()));

-- Store a venue API secret in Supabase Vault and point the account at it. Withdrawal rights are never allowed.
create or replace function public.store_venue_secret(p_account uuid, p_secret text, p_ip_locked boolean default false)
returns void
language plpgsql security definer set search_path = public, vault as $$
declare v_id uuid;
begin
  if not public.is_staff() then raise exception 'staff with two-factor only'; end if;
  if p_secret is null or length(p_secret) < 8 then raise exception 'secret too short'; end if;
  v_id := vault.create_secret(p_secret, 'venue:' || p_account::text || ':' || extract(epoch from now())::bigint, 'A+ Tradeplay venue API key');
  insert into public.venue_credentials (account_id, vault_secret_id, ip_locked, rotated_at)
  values (p_account, v_id, p_ip_locked, now())
  on conflict (account_id) do update set vault_secret_id = excluded.vault_secret_id, ip_locked = excluded.ip_locked, rotated_at = now();
end $$;
revoke all on function public.store_venue_secret(uuid, text, boolean) from public, anon;
grant execute on function public.store_venue_secret(uuid, text, boolean) to authenticated;

-- Signal broadcast settings (destinations, instruments, post types).
alter table public.app_settings
  add column if not exists broadcast jsonb not null default '{"vip":true,"free":true,"instruments":{"XAUUSD":true,"BTCUSDT.P":true,"GOLDM":false},"events":{"armed":true,"filled":true,"closed":true,"bias":true,"invalid":false,"weekly":true,"delay_free":true}}'::jsonb;

-- News rules and alert quiet hours.
alter table public.app_settings
  add column if not exists news_block_minutes smallint not null default 15 check (news_block_minutes between 0 and 120),
  add column if not exists news_medium_gold boolean not null default false,
  add column if not exists quiet_from text not null default '23:30',
  add column if not exists quiet_to text not null default '07:00';
