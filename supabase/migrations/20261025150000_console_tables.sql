-- Owner console: system switches, news blocks, daily bias reports, setups (POIs) and alert log.
create table public.app_settings (
  id smallint primary key default 1 check (id = 1),
  mode text not null default 'PAPER' check (mode in ('PAPER', 'LIVE')),
  kill_switch boolean not null default false,
  aggressive_entry_allowed boolean not null default false,
  counter_trend_allowed boolean not null default false,
  advanced_models_allowed boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into public.app_settings (id) values (1);

create table public.news_events (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null,
  currency text not null default 'USD',
  title text not null,
  impact text not null default 'high' check (impact in ('high', 'medium', 'low')),
  instruments text[] not null default '{XAUUSD,BTCUSDT.P}',
  actual text, forecast text, previous text,
  created_at timestamptz not null default now()
);
create index news_events_at on public.news_events (at);

create table public.bias_reports (
  id uuid primary key default gen_random_uuid(),
  report_date date not null,
  instrument text not null,
  range_low numeric(18,6) not null,
  range_high numeric(18,6) not null,
  price numeric(18,6) not null,
  htf_trend text check (htf_trend in ('up', 'down')),
  liquidity jsonb not null default '{}'::jsonb,
  narrative text not null default 'continuation' check (narrative in ('continuation', 'pullback')),
  target numeric(18,6),
  invalidation numeric(18,6),
  allowed text check (allowed in ('long', 'short')),
  zone text,
  notes text,
  created_at timestamptz not null default now(),
  unique (report_date, instrument)
);

create table public.setups (
  id uuid primary key default gen_random_uuid(),
  instrument text not null,
  side text not null check (side in ('long', 'short')),
  timeframe text not null default '15M',
  kind text not null check (kind in ('demand', 'supply', 'order_block', 'fvg', 'flip', 'institutional')),
  top numeric(18,6) not null,
  bottom numeric(18,6) not null,
  fresh boolean not null default true,
  liquidity_story boolean not null default false,
  created_bos boolean not null default true,
  alert_set boolean not null default false,
  status text not null default 'watching' check (status in ('watching', 'tapped', 'triggered', 'invalid', 'done')),
  note text,
  created_at timestamptz not null default now(),
  check (top > bottom)
);

create table public.alert_log (
  id bigint generated always as identity primary key,
  rule_id uuid references public.alert_rules (id) on delete set null,
  title text not null,
  body text,
  severity text not null default 'info' check (severity in ('info', 'warn', 'critical')),
  read boolean not null default false,
  at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['app_settings', 'news_events', 'bias_reports', 'setups', 'alert_log'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for all to authenticated using ((select public.is_staff())) with check ((select public.is_staff()))', t || '_staff', t);
  end loop;
end $$;

create trigger audit_app_settings after insert or update or delete on public.app_settings for each row execute function public.audit_row();
