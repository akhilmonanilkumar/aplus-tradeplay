# Delta Exchange integration plan — automated trading for promoted strategies

Goal: promoted strategies (Live strategies page) place real orders on Delta Exchange India, starting on the
demo **testnet**, under the firm's risk rules. Nothing else can place an order. Delta's market data also
feeds the BTC and gold desks for analysis.

## 1. What Delta offers (verified from production, 28 Oct 2026)

| | Production (`api.india.delta.exchange`) | Testnet (`cdn-ind.testnet.deltaex.org`) |
|---|---|---|
| Reachable from our servers (Vercel bom1) | yes, ~300 ms | yes, ~900 ms |
| Perpetuals listed | 241 | 17 |
| BTC | `BTCUSD` id 27 · 0.001 BTC/contract · tick 0.5 · taker 0.05% / maker 0.02% · up to 200× | `BTCUSD` id 84 · tick 0.1 · up to 10× |
| Gold | `XAUTUSD` (Tether Gold) id 131253 · 0.001 XAUT/contract · tick 0.01 · taker/maker 0.01% | `XAUTUSD` id 181689 |
| Also | `PAXGUSD`, `ETHUSD`, `SOLUSD` | same symbols, smaller set |
| Public data | products, tickers (mark, bid/ask, funding, OI, spot), candles 1m–1d | same (synthetic order flow) |

Markets we trade that Delta does not list (EUR/USD, USD/JPY, Nasdaq, S&P, Nifty) stay **alert-only**.

**Instrument map** (signal → order)

| Our candidate's market | Delta product |
|---|---|
| BTCUSDT.P, BTCUSD, BTCUSD.SPOT | BTCUSD perpetual |
| XAUUSD, XAUUSDT.P | XAUTUSD perpetual |

Signal prices come from our feed, so levels are shifted by the basis (Delta mid − our price) at order
time, keeping the stop and target distances (the R) unchanged.

**Authentication.** HMAC-SHA256 of `METHOD + timestamp + path + query + body` with the API secret, sent as
`api-key`, `timestamp` (Unix seconds) and `signature` headers. Testnet keys come from the demo account and
only work on testnet; production keys only on production.

**IP whitelisting (blocker for production).** Delta enforces an IP whitelist on API keys with trading
permission. Vercel functions have no fixed outgoing IP. Options:
1. **Execution relay (recommended):** a ~100-line service (`services/delta-relay`) on a small fixed-IP
   server in Mumbai (Lightsail, DigitalOcean or Oracle free tier). It holds the Delta keys, accepts only
   HMAC-signed requests from our app, signs and forwards them. Keys never touch Vercel.
2. Vercel Static IPs (paid add-on), whitelisted directly.

The testnet may enforce it too. The first signed call shows that: Delta returns the IP it saw.

## 2. Architecture

```
autopilot pass (every 5 min)
  └─ ledger logs a setup ──► candidate live? ──► Delta symbol? ──► risk gate ──► size ──► bracket order
                                   │ no              │ no              │ fail
                                   └ paper only      └ alert only      └ logged with reason, notified
reconcile (every pass): open orders · fills · positions · wallet ──► live_orders + trades(source 'live')
```

* **One door for orders:** `lib/server/liveExec.ts`. Every order comes from a promoted strategy's signal
  and passes the risk gate. Nothing else calls Delta's order endpoints.
* **Idempotent:** `client_order_id` = signal id, and the `live_orders` row is unique on it, so a retried
  pass cannot double an order.
* **Bracket on entry:** every entry carries its stop-loss and take-profit (`bracket_stop_loss_price`,
  `bracket_take_profit_price`, triggered on mark price). An order without a stop is never sent.
* **Modes:** `off` → `dry-run` (build and log the order, send nothing) → `testnet` → `production`.
  Production also needs `DELTA_ENV=production` in Vercel and a fresh 2FA step-up to arm.

## 3. Risk policy (strict, from the firm's edge rules)

| Rule | Value | Action |
|---|---|---|
| Who may trade | Only candidates with status **live** and execution on | everything else stays paper/alerts |
| Risk per trade | 0.5% of account equity (hard cap 1%) | size from stop distance + fees |
| Daily loss cap | 2% of start-of-day equity | no new orders until next IST day |
| Losses per day | stop after 2 | as above |
| Trades per day | 4 | as above |
| Open risk (all stops hit) | ≤ 1.5% | skip the new order |
| Positions | 1 per product, 2 in total | skip |
| Drawdown from peak | 8% | halt live trading, notify, needs a manual re-arm |
| Leverage | ≤ 5× (set per product before the first order) | skip if margin needs more |
| Minimum R | ≥ 1.5R to target after the basis shift | skip |
| Entry drift | price ≤ 0.25R away from planned entry | skip (no chasing) |
| Signal age | ≤ 10 min since it was logged | skip |
| News | ±15 min around high-impact releases for the desk | skip |
| Kill switch | the global kill switch | cancel open entries, send nothing |
| API errors | 3 failures in 30 min | halt 30 min, notify |
| Reconcile mismatch | exchange position not in our book (or the reverse) | halt, notify, manual review |
| Unfilled entry | cancel after 60 min | |
| Never | widen a stop, average down, add to a loser, trade without a bracket | |

All limits are editable on the Live page, but none can be loosened beyond the caps above in code.

## 4. Live feed for analysis

* Delta candles and tickers as providers: BTC perp candles as a fallback for BTCUSDT.P, XAUT for the gold perp.
* A **Delta venue card** on the BTC and gold desks: mark, best bid/ask, spread, funding rate, open
  interest, and basis versus our feed (what an order would actually pay).
* Later: WebSocket (`wss://socket.india.delta.exchange`: `v2/ticker`, `candlestick_5m`, `l2_orderbook`,
  `mark_price`, `funding_rate`, private `orders`/`positions`). That needs a long-lived process, so it
  belongs with the relay server; serverless polls REST.

## 5. Phases and exit criteria

| Phase | What | Done when |
|---|---|---|
| 0 · Discovery | Probe production and testnet, map products | done (above) |
| 1 · Data | Delta feed providers, venue card, health in the feed probe | desks show Delta prices |
| 2 · Execution core | signed client, risk gate (tested), sizing in contracts, bracket orders, `live_orders`, reconcile, journal into `trades` | unit tests green; dry-run logs correct orders |
| 3 · Testnet | testnet keys, arm testnet, live strategies trade the demo account | 2–4 weeks or 30+ orders with no unexplained reconcile mismatch, every order bracketed, slippage and fees measured |
| 4 · Relay | fixed-IP relay for production keys | relay passes the same smoke test as testnet |
| 5 · Production, small | `DELTA_ENV=production`, capital cap (e.g. $500), 0.25% risk | 30+ trades tracking the testnet within tolerance |
| 6 · Scale | raise the capital cap step by step | review at every 100 trades |

## 6. What is needed from you

1. **Testnet account:** sign up at Delta's demo/testnet (India), fund it with demo USD, create an API key
   with **Read + Trading**. Add the IP Delta reports on the first call, or tell me if it accepts keys
   without a whitelist.
2. Put the keys in **Vercel → Settings → Environment Variables** as `DELTA_TESTNET_API_KEY` and
   `DELTA_TESTNET_API_SECRET` (Production scope), then redeploy. Never paste keys into chat.
3. For production later: a small fixed-IP server for the relay, and production keys whitelisted to it.
