# A+ Tradeplay

Private desk for the firm's team: trade gold and bitcoin on one edge, manage own and investor accounts, and show investors how their money grows.

- `packages/engine` — instruments (XAUUSD CFD, XAUUSDT.P, BTCUSD CFD, BTCUSDT.P, BTCUSD spot), setup detector, A+ gate, sessions (NY-anchored, DST-safe), sizing, context analytics (OI regime, funding, basis, DXY, correlations, confluence), walk-forward backtester. `pnpm test`
- `apps/web` — Next.js app: Dashboard, Gold / BTC desks, Gold / BTC labs, Autopilot, Accounts, Investors, P&L analytics, Telegram alerts, investor portal (`/me`). Market data, news, AI and Telegram run through server routes in `app/api`.
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

The TradingView tab on each desk embeds TradingView's own chart for the symbol set in Settings (your broker's feed). TradingView has no public market-data API; the engine chart uses the sources above.

## Env

See `apps/web/.env.example`.

## Best-opportunity selector

On the Autopilot page. Each pass scores every live setup that passes the A+ gate (gate quality, R:R, dollar/yields/funding/OI/flow confluence, the edge's last-3-weeks walk-forward result on that instrument, timing) and sends the best trade per underlying to Telegram with size per account; optional paper tracking reports fills and results. "Preview board" scores without acting. Details: `docs/spec.md` §11.

## Autopilot schedule

`.github/workflows/autopilot.yml` calls `/api/autopilot/tick` every 5 minutes. Add repository secrets `AUTOPILOT_URL` and `AUTOPILOT_SECRET` (same value as the Vercel env var). Any external cron can call the same URL with `Authorization: Bearer $AUTOPILOT_SECRET`. A manual run with the input `preview=selector` scores the selector board without acting.

## Run

```
pnpm install
pnpm test
pnpm dev
```
