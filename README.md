# A+ Tradeplay

Private trading and investor platform: prop CFD accounts on cTrader, Delta Exchange India, CoinSwitch PRO and Fyers, each in its own arena, with a Strategy League that paper-trades every strategy and promotes the ones that prove themselves.

## Layout

| Path | What |
|---|---|
| `apps/web` | Next.js app on Vercel: Dashboard (with the CFD live board), four Arenas at `/arena/{cfd,delta,coinswitch,fyers}`, Strategy League, Backtest Suite, Playbook, Edge and P&L Analytics, Risk, Accounts, Investors, Payouts, Integrations, investor portal (`/me`). Server routes in `app/api`. |
| `packages/engine` | Pure TypeScript: markets, setup detector, A+ gate, entry models, sessions, sizing, backtester, order flow, prop rules, cTrader links, League gates. |
| `services/engine` | The engine host on a DigitalOcean droplet with a static IP: holds every venue key, signs orders, syncs venue clocks, streams order flow, serves venue candles and quotes. See `services/engine/README.md`. |
| `supabase/migrations` | Schema, row-level security, audit log, scheduled passes. Apply in order. |
| `docs/v2-platform-plan.md` | The v2 plan and decisions. `docs/design/` holds the approved prototype. |
| `tools/tradingview` | Pine Script port of the edge for TradingView backtests. |

## Market data

Each arena reads only its own venue's prices; analytics read every record across venues.

| Arena | Markets | Source |
|---|---|---|
| CFD | XAUUSD, BTCUSD, EURUSD, GBPUSD, USDJPY, US500, NAS100 | The prop broker's cTrader feed (engine host), then Twelve Data (or OANDA) if a key is set, then free public references (labelled approximate) |
| Delta | BTCUSD and XAUTUSD perps | Delta Exchange India public REST and stream |
| CoinSwitch | BTCUSDT futures | CoinSwitch PRO (signed, through the engine host) |
| Fyers | Nifty 50 | Fyers (daily login, through the engine host) |

Context for the CFD desks: open interest and funding across crypto venues, DXY and yields (Yahoo, FRED), CFTC positioning, Forex Factory calendar, news RSS. AI reads run through OpenRouter (or the Anthropic API).

## Setup

1. **Supabase**: apply `supabase/migrations` in order. Put the app URL and secret in Vault for the scheduled passes:
   ```sql
   select vault.create_secret('https://www.tradeplay.cloud', 'autopilot_url');
   select vault.create_secret('<AUTOPILOT_SECRET from Vercel>', 'autopilot_secret');
   ```
2. **Engine host**: follow `services/engine/README.md`. Venue keys go only in the host's `.env`.
3. **Vercel**: set the variables in `apps/web/.env.example` (at least the Supabase keys, `AUTOPILOT_SECRET`, `ENGINE_URL`, `ENGINE_SECRET`). The production branch is `main`.
4. **Integrations page**: sign in to cTrader and Fyers, connect the Telegram buttons, and check each venue's clock.

## Schedule

`pg_cron` in Supabase calls `/api/autopilot/tick` every 5 minutes through the London and New York sessions and every 15 minutes otherwise, and the strategy agent daily. Check runs with `select * from cron.job_run_details order by start_time desc limit 10;`. `.github/workflows/autopilot.yml` is a manual trigger for one-off passes and research runs.

## Safety

- Every execution switch defaults to off. Delta runs dry-run, then testnet, then production; CoinSwitch and Fyers stay in shadow mode until a supervised first order.
- The CFD Arena never places orders: it sends sized alerts with cTrader links, and reads the accounts read-only.
- Payout approval needs 2FA; every change to accounts, investors, payouts and cash flows is in the audit log.

## Develop

```bash
pnpm install
pnpm test
pnpm dev
```

`pnpm typecheck` and `pnpm build` run the same checks as CI.
