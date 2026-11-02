# A+ Tradeplay

Private desk for the firm's team: trade gold and bitcoin on one edge, manage own and investor accounts, and show investors how their money grows.

- `packages/engine` — instruments (XAUUSD CFD, XAUUSDT.P, BTCUSD CFD, BTCUSDT.P, BTCUSD spot), setup detector, A+ gate, sessions (NY-anchored, DST-safe), sizing, context analytics (OI regime, funding, basis, DXY, correlations, confluence), walk-forward backtester. `pnpm test`
- `apps/web` — Next.js app (v2 layout, see `docs/v2-platform-plan.md`): Dashboard; four Arenas at `/arena/{cfd,delta,coinswitch,fyers}` (CFD holds the prop challenges, journal, daily bias and discipline); Strategy League (`/league`), Backtest Suite (`/backtest`), Playbook; Edge Analytics (`/edge`), P&L Analytics, Risk; Accounts, Investors, Payouts; Integrations; investor portal (`/me`). Old desk, lab, autopilot and funding-basis URLs redirect to their new homes. Market data, news, AI and Telegram run through server routes in `app/api`.
- `supabase/migrations` — schema, RLS, audit log.

## Data sources

| What | Source | Key |
|---|---|---|
| BTCUSDT.P, XAUUSDT.P candles, ticks, funding, OI, L/S, taker flow, liquidations | Binance USDⓈ-M (Bybit / OKX fallback and cross-venue OI) | none |
| BTCUSD spot / CFD reference | Coinbase (Kraken fallback); OANDA BTC_USD when keyed | none |
| XAUUSD CFD | Twelve Data (OANDA if keyed; not offered to Indian residents); without a key the Binance XAU index (labelled approximate) | `OANDA_API_KEY` / `TWELVEDATA_API_KEY` |
| Spot gold bid/ask | OANDA pricing, else Swissquote public quotes | optional |
| DXY, US10Y, NQ, ES, silver, ETH, FX (correlations) | Yahoo Finance hourly | none |
| Real yields · gold COT | FRED (DFII10) · CFTC disaggregated report | `FRED_API_KEY` · none |
| Economic calendar · headlines | Forex Factory weekly export · Google News / CoinDesk / Cointelegraph RSS (+ Finnhub) | `FINNHUB_API_KEY` optional |
| AI analyst, news read, reviews | OpenRouter | `OPENROUTER_API_KEY` |

Desk charts are drawn from the sources above with TradingView's open-source Lightweight Charts library; there is no embedded TradingView chart or webhook.

## Env

See `apps/web/.env.example`.

## Bot log

`/bot` lists every signal the autopilot and the selector produced, tracks each one's fill, stop or target on candles (with or without an account trading it), and shows the bot's performance: win rate, net R after costs, expectancy, profit factor, drawdown, equity curve and breakdowns by bot, instrument, session, side, grade and selector score.

## TradingView backtest

`tools/tradingview/aplus_edge_strategy.pine` ports the edge and entry models (A, C, F, E) to a Pine Script v6 strategy for backtesting on TradingView history. See `tools/tradingview/README.md`.

## Best-opportunity selector

On the Autopilot page. Each pass scores every live setup that passes the A+ gate (gate quality, R:R, dollar/yields/funding/OI/flow confluence, the edge's last-3-weeks walk-forward result on that instrument, timing) and sends the best trade per underlying to Telegram with size per account; optional paper tracking reports fills and results. "Preview board" scores without acting. Details: `docs/spec.md` §11.

## Autopilot schedule

Supabase runs it: `pg_cron` calls `/api/autopilot/tick` every 5 minutes from 05:00 to 16:55 UTC (London Q and NY Q in summer and winter time) and every 15 minutes otherwise (migration `20261026190000_autopilot_cron.sql`). The URL and secret live in Vault; run once in the SQL editor:

```sql
select vault.create_secret('https://www.tradeplay.cloud', 'autopilot_url');
select vault.create_secret('<AUTOPILOT_SECRET from Vercel>', 'autopilot_secret');
```

Check it with `select * from cron.job_run_details order by start_time desc limit 10;` and `select status_code, created from net._http_response order by created desc limit 10;`. `.github/workflows/autopilot.yml` is a manual trigger only (GitHub skipped most scheduled 5-minute slots). Any external cron can call the same URL with `Authorization: Bearer $AUTOPILOT_SECRET`.

## Backtesting and rule research

- **Lab** (Gold / BTC lab): pick the instrument, set *History* to 30d, run. Toggles cover every gate rule (grade A, POI, premium/discount half, 15M alignment, min R:R, entry at the zone or at the shift close). *Skipped setups* lists every signal the rules rejected, grouped by the rules that blocked it, with what it would have done: a positive row means that rule is filtering out winners.
- **Research run**: Actions → *Autopilot tick* → Run workflow with the query `research=XAUUSD&days=30&day=2026-10-26` (any instrument id). Returns the live rules and eight relaxed variants on the same scan, the skipped-setup impact, and a bar-by-bar replay of that New York day's London Q and NY Q (sweep, shift, zone, position in the range, HTF / 15M trend) for both sides.

- **Strategy lab** (long walk-forward, read-only): Actions → *Autopilot tick* → Run workflow with endpoint `lab` and the query `i=XAUUSD&family=session&days=180`. Families: `a5` (Model A on 5M: live rules, trend core, partial exits), `a15` (Model A on 15M entries with 1H POIs and 4H structure), `session` (Asia range in London and London range in New York, as fades or breakouts, with and without the HTF trend filter, fixed or partial exits). Each variant is marked against criteria fixed before the run: at least 40 trades, profit factor ≥ 1.2 after costs, positive in both halves. Gold history over 90 days may fall back from Twelve Data to the Binance index or the PAXG proxy; the response names the source.

## Run

```
pnpm install
pnpm test
pnpm dev
```
