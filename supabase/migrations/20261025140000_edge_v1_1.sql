-- Edge v1.1: Trade Finder Pro entry models A–I, review fields, guardrails.
alter table public.signals drop constraint if exists signals_model_check;
update public.signals set model = 'G' where model = 'CT1';
alter table public.signals add constraint signals_model_check check (model in ('A','B','C','D','E','F','G','H','I'));

alter table public.trades
  add column if not exists grade text check (grade in ('A+','A','B','C')),
  add column if not exists plan_followed boolean,
  add column if not exists emotion text,
  add column if not exists lesson text,
  add column if not exists risk_pct numeric(6,3);
update public.trades set model = 'G' where model = 'CT1';

update public.edge_configs set active = false where active;
insert into public.edge_configs (version, active, config) values ('1.1', true, '{
  "edge": "direction (HTF) → location (POI in correct half) → execution (sweep + LTF shift, in window, ≥3R)",
  "instruments": {"XAUUSD": {"htf": "1H", "poi_tf": "15M", "entry_tf": "5M", "refine_tf": "1M"},
                  "BTCUSDT.P": {"htf": "4H", "poi_tf": "15M", "entry_tf": "5M", "refine_tf": "1M", "price_source": "mark", "min_stop_pct": 0.4}},
  "sessions": {"tz": "America/New_York", "london_q": ["02:00", "05:00"], "ny_q": ["07:00", "10:00"], "asia_ref": ["20:00", "24:00"], "london_close_ref": ["10:00", "12:00"]},
  "news": {"block_minutes": 15, "post_news_wait_minutes": 30},
  "min_rr": 3.0,
  "models": {"A": "market shift → pullback", "B": "flip zone", "C": "sweep → OB → FVG", "D": "institutional precision", "E": "gold sweep (conservative unless aggressive enabled)", "F": "Asia sweep (London window)", "G": "counter-trend pullback scalp (advanced, never A+)", "H": "sniper / fractal shift (advanced, never A+)", "I": "post-news (advanced)"},
  "grading": {"A+": "every rule passes", "A": "one soft trigger missed (liquidity story, BOS from POI, quality concern) — base risk or skip", "B/C": "never"},
  "risk": {"base_pct": 0.5, "a_plus_pct": 1.0, "variable_after_trades": 100, "daily_loss_cap_pct": 2, "challenge_daily_profit_cap_pct": 1, "max_drawdown_pause_pct": 8},
  "rules": {"no_pullback_no_trade": true, "no_chasing": true, "no_tp_stretch": true, "aggressive_entry_allowed": false,
            "counter_trend_allowed": false, "advanced_models_allowed": false, "max_a_plus_trades_per_day": 2, "stop_after_losses": 2,
            "set_and_forget_first_n_trades": 30, "change_rules_after_trades": 100, "change_rules_bare_minimum": 30}
}'::jsonb);
