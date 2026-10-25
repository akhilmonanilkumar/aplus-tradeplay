-- One-time owner claim: the first signed-in user becomes owner; afterwards it does nothing.
create or replace function public.claim_owner(p_display_name text default '')
returns public.member_role
language plpgsql security definer set search_path = public as $$
declare r public.member_role;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select role into r from public.members where user_id = auth.uid();
  if r is not null then return r; end if;
  if exists (select 1 from public.members where role = 'owner') then
    return null;
  end if;
  insert into public.members (user_id, role, display_name) values (auth.uid(), 'owner', coalesce(p_display_name, ''));
  return 'owner';
end $$;
revoke all on function public.claim_owner(text) from public, anon;
grant execute on function public.claim_owner(text) to authenticated;

-- Link an invited investor login to its investor record by email (staff creates the investor first).
create or replace function public.link_investor_login()
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_email text; v_id uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select email into v_email from auth.users where id = auth.uid();
  select id into v_id from public.investors where user_id is null and lower(email) = lower(v_email) limit 1;
  if v_id is null then
    select id into v_id from public.investors where user_id = auth.uid();
    return v_id;
  end if;
  update public.investors set user_id = auth.uid() where id = v_id;
  insert into public.members (user_id, role, display_name)
    select auth.uid(), 'investor', (select name from public.investors where id = v_id)
    where not exists (select 1 from public.members where user_id = auth.uid());
  return v_id;
end $$;
revoke all on function public.link_investor_login() from public, anon;
grant execute on function public.link_investor_login() to authenticated;

create or replace function public.block_audit_change() returns trigger
language plpgsql set search_path = public as $$ begin raise exception 'audit_log is append-only'; end $$;

create or replace function public.stamp_payout_approval() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.status = 'approved' and (old.status is distinct from 'approved') then
    new.approved_by := auth.uid();
    new.approved_at := now();
  end if;
  if new.status = 'paid' and new.paid_at is null then new.paid_at := now(); end if;
  return new;
end $$;
create trigger payouts_stamp before update on public.payouts for each row execute function public.stamp_payout_approval();

insert into public.edge_configs (version, active, config) values ('1.0', true, '{
  "edge": "htf_trend + correct_half + quality_poi + liquidity_sweep + ltf_shift + session + min_3R",
  "instruments": {"XAUUSD": {"htf": "1H", "poi_tf": "15M", "entry_tf": "5M", "refine_tf": "1M"},
                  "BTCUSDT.P": {"htf": "4H", "poi_tf": "15M", "entry_tf": "5M", "refine_tf": "1M", "price_source": "mark", "min_stop_pct": 0.4}},
  "sessions": {"tz": "America/New_York", "london_q": ["02:00", "05:00"], "ny_q": ["07:00", "10:00"]},
  "news_block_minutes": 15,
  "min_rr": 3.0,
  "rules": {"no_pullback_no_trade": true, "no_chasing": true, "no_tp_stretch": true, "aggressive_entry_allowed": false,
            "counter_trend_allowed": false, "max_a_plus_trades_per_day": 2, "stop_after_losses": 2, "set_and_forget_first_n_trades": 30}
}'::jsonb);
