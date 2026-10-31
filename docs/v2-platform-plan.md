# A+ Tradeplay v2 — platform plan

Status: **draft for approval** · 31 Oct 2026 · supersedes the desk/lab layout described in `README.md`

A+ Tradeplay is a private suite for analysing trades, managing own and investor portfolios, and running
proven strategies on several venues, either through API execution or through Telegram alerts. v2 moves
from per-instrument *desks and labs* to per-venue **Arenas**. Each Arena has one data plane, one
execution path, one ledger and one P&L, and runs on a shared engine.

---

## 1. What changes

| v1 | v2 |
|---|---|
| Gold / BTC / FX / Index **desks** + **labs** (8 pages) | 4 **Arenas** (CFD, Delta, CoinSwitch, Fyers) + 1 global **Backtest Suite** |
| Autopilot page | Removed. Every Arena except CFD runs promoted strategies on its own. CFD raises alerts. |
| Funding basis page | Removed as a page. Basis becomes a strategy family, paper-traded in fresh Delta and CoinSwitch paper accounts. |
| Bot log | **Edge Analytics** (A+ and promoted setups, filtered by account, instrument, venue and engine grade) |
| Live strategies + paper ledger | **Strategy League**: an endless forward test with promotion and demotion, run by a strategy development agent |
| Journal, Daily bias, Discipline & mood, Funded challenges, Reviews | Moved **inside CFD Arena**, scoped to CFD accounts only |
| Playbook (editable notes) | **Versioned playbook**: frozen core models; new models are added only on evidence |
| Paper trades so far | **Archived** (kept read-only in an `archive` schema, not deleted) and excluded from every stat |
| Candle-level analysis | **Tick and order-book level** data plane (trades, L2, OI, funding, liquidations) |

Kept as they are, with the new design: Dashboard, Accounts, Investors and the investor portal (`/me`),
P&L analytics, Risk manager, Notifications, Telegram, Payouts & audit, Settings.

---

## 2. Venue research

### 2.1 Delta Exchange India — API execution (crypto perps, futures, options)

| | |
|---|---|
| REST | `https://api.india.delta.exchange` (prod) · `https://cdn-ind.testnet.deltaex.org` (demo) |
| WebSocket | `wss://socket.india.delta.exchange` (testnet has its own socket host) |
| Auth | HMAC-SHA256 over `METHOD + timestamp + path + query + body`; headers `api-key`, `timestamp` (Unix **seconds**), `signature`. A signature older than **5 s** on arrival fails with `SignatureExpired`. |
| IP | Trading keys need a **whitelisted IP**. Vercel has no fixed IP, so a fixed-IP gateway is required (§3). |
| Products | BTCUSD / ETHUSD / XAUTUSD / PAXGUSD perps, dated futures, **BTC and ETH options (daily, weekly, monthly expiries)**, MOVE options, ~240 perps |
| Public streams we use | `v2/ticker`, `l2_orderbook`, `l2_updates`, `all_trades`, `mark_price`, `funding_rate`, `candlesticks`, `spot_price`, OI via ticker |
| Private streams | `orders`, `positions`, `user_trades`, `margins`, `v2/user_trades` |
| Orders | limit / market / stop, **bracket** SL+TP on entry (on mark price), reduce-only, post-only, `client_order_id` for idempotency |
| Fees | BTC perp: taker 0.05%, maker 0.02%. Gold perp: 0.01% each way. Options fees are capped as a share of premium. |

**CCXT.** CCXT lists Delta, but it ships the *global* hosts (`api.delta.exchange`). It works for India if
`exchange.urls['api']` is overridden, with India keys and India product ids.

**Decision:** keep the native Delta client we already have for signing, brackets and India-specific
endpoints. Add **CCXT behind the same adapter interface** for unified market metadata, options chain
parsing and order and position normalisation, and as a reference to diff our own client against.
Native WebSocket for books and trades in both cases (lowest latency, full control over sequence checks).

### 2.2 CoinSwitch PRO — API execution (crypto spot, INR-settled futures, options beta)

| | |
|---|---|
| Surfaces | Spot `https://coinswitch.co/trade/api/v2/…` · Futures `…/v2/futures` (send `exchange: EXCHANGE_2` on every call) · **HFT** surface `https://dma.coinswitch.co` (streams over **NATS**, envelope `{retCode, retMsg, result}`) |
| Auth | **Ed25519**: the API key is the public key, and the secret signs `METHOD + path(+query) + epoch`. Headers `X-AUTH-APIKEY`, `X-AUTH-SIGNATURE` (hex), `X-AUTH-EPOCH` (Unix **ms**). Server time: `GET /trade/api/v2/time`. |
| Limits | Regular futures API: about 20–100 requests per 60 s per endpoint, which is too low for scalping. The **HFT surface** is open to all PRO users with API keys and is the route for momentum and order-flow strategies. |
| Products | BTC/ETH and 350+ crypto futures. The site lists **Commodities (Gold, Silver, Crude)** and **US-stock futures** sections, but I could not confirm their API tradability or symbols. **Options are private beta** (by email to api@coinswitch.co). |
| CCXT | Not supported. Native adapter. |

Open item: confirm which of gold, silver and US-stock perps are listed on the API futures surface, and
request options beta access. Until then CoinSwitch paper-trades BTC/ETH and anything confirmed.

### 2.3 Fyers — API execution (NSE/BSE F&O, intraday equities)

| | |
|---|---|
| REST | `https://api-t1.fyers.in` (v3). Rate limits: 10/s, 200/min, 100k/day. Breaking the per-minute cap more than 3 times a day blocks the app for the day. |
| Auth | OAuth `auth_code` → `access_token` (valid for the trading day) + `refresh_token` (15 days, needs the PIN). Header `Authorization: app_id:access_token`. |
| Streams | Data socket (LTP + 5-level depth, 5,000 symbols per connection) · Order socket · **TBT socket: 50-level tick-by-tick depth for NFO** (3 connections × 5 symbols). |
| Data | History (1m+), option chain with greeks / IV / OI, market status, symbol master (daily CSV, gives lot and tick sizes). |
| **SEBI retail-algo rules (in force since 1 Apr 2026)** | Orders are accepted only from a **registered App ID mapped to a whitelisted static IP**. Old apps are data-only until a new app is activated. Orders carry an exchange Algo ID (the broker tags it). Under 10 orders per second, no separate strategy registration is needed. Static IP still applies. Market data needs no static IP. |

Decision: native adapter (TS port of the `fyers-apiv3` calls the repo's FYERS skill documents). Orders go
out only from the fixed-IP gateway, with the symbol validated against the daily master before every order.

### 2.4 CFD Arena data (prop firm accounts, alerts only)

Prop CFD prices have no central book, so order flow and depth come from the **reference futures or perp market**:

| CFD | Reference for flow, OI, depth | Free source | Paid upgrade |
|---|---|---|---|
| BTCUSD | Binance / Bybit / Delta perps | yes (already in use) | — |
| XAUUSD | COMEX GC; Delta XAUT and Binance XAU perps | perps yes, GC no | CME via Databento / Rithmic |
| EURUSD, GBPUSD, USDJPY | CME 6E / 6B / 6J; spot from OANDA / Yahoo | spot only | CME futures feed |
| S&P 500, Nasdaq 100 | CME ES / NQ (+ SPY/QQQ option flow) | delayed only | CME feed |

Without a futures feed, **FX and index order flow and OI are approximations**, and the UI labels them so.
That is the one data budget decision in this plan (Q2 below).

### 2.5 Clock sync (all venues)

* The gateway host runs `chrony` (NTP-disciplined).
* Per venue, a `ClockSync` measures `offset = serverTime − (t_send + rtt/2)` every 30 s, from
  CoinSwitch `/v2/time`, the Delta response `Date`/server timestamp, and the Fyers exchange timestamp in socket
  ticks. It keeps a rolling median and p95 RTT.
* Signing uses `now + offset` for that venue. Orders are **refused locally** if |offset| or RTT exceeds
  the venue budget (Delta: 5 s window → budget 1.5 s; CoinSwitch: 1 s; Fyers: 1 s).
* Each venue's offset, RTT, WS lag and last message age are shown in Settings → Integrations and in the
  Dashboard live-feed card.

---

## 3. Architecture

```
                ┌──────────────── Vercel (bom1) ────────────────┐
 Browser ◄────► │ Next.js UI · API routes · auth · Supabase RLS │
                └───────▲─────────────────────────▲─────────────┘
                        │ Supabase realtime        │ signed HTTPS (HMAC)
                ┌───────┴─────────────────────────┴─────────────┐
                │  Engine host — Mumbai VM, static IP (new)      │
                │  ┌ venue adapters: Delta · CoinSwitch · Fyers · reference feeds (Binance/Bybit/OANDA…)
                │  ├ ClockSync per venue · WS supervisors (reconnect, seq/gap checks, snapshots)
                │  ├ tick store (QuestDB/Timescale) → 1s/1m bars + footprint to Supabase
                │  ├ analysis engine: A+ gate, confluence, OI/funding/flow, regime
                │  ├ strategy runner: paper + live, per Arena
                │  ├ order router → risk gate → venue (one door per venue)
                │  ├ alert router → Telegram (CFD Arena)
                │  └ scheduler: strategy dev agent (daily), research jobs, reconciliation
                └───────────────────────────────────────────────┘
```

* **Why a persistent host:** tick and L2 streams, sub-second strategies and static-IP order routing do
  not fit serverless functions. The current `services/delta-relay` grows into this gateway. Vercel keeps
  the UI and user-facing APIs. Keys live only on the host, never in Vercel.
* **One door per venue:** `Venue` interface `{ markets, book, trades, place, cancel, amend, positions,
  balances, fills, clock }`. Every order passes the **risk gate** (the existing `liveRisk.ts` rules,
  per account) and carries an idempotent `client_order_id` = signal id.
* **Modes per Arena:** `off → paper → dry-run → testnet → live (small) → live`. Live requires 2FA step-up
  (already built). Global and per-Arena kill switches.
* **Data model additions:** `venues`, `venue_credentials` (encrypted reference only), `clock_samples`,
  `arenas`, `strategies` (versioned spec + hash), `strategy_runs` (paper/live, per venue/instrument),
  `signals`, `orders`, `fills`, `positions_snapshots`, `promotion_events`, `playbook_models` (frozen
  versions). Paper and live are **separate ledgers** by `run_mode`, never mixed in stats.

---

## 4. Information architecture

```
Command        Dashboard
Arenas         CFD Arena · Delta Arena · CoinSwitch Arena · Fyers Arena
Strategy       Strategy League · Backtest Suite (+ visual builder) · Playbook
Analytics      Edge Analytics · P&L Analytics · Risk
Capital        Accounts · Investors · Payouts & audit
System         Notifications & Telegram · Settings (Integrations, keys, clocks, risk limits)
Investor       /me (unchanged scope, new design)
```

Each Arena has the same shell with **mode tabs**: Scalp · Day · Options (Fyers adds Intraday Equity and
Option Strategies; CFD adds Challenge, Journal, Bias, Discipline, Review).

---

## 5. Screens

### 5.1 Dashboard (one screen at 1440×900, cards dense, no wasted chrome)

Row 1 (strip): **Live feeds card** (one compact card with one dot per feed and venue: green live / red down /
grey closed, plus clock offset on hover) · current time IST / NY / London + active session · global kill switch.
Row 2: P&L snapshot (today / week / month, by Arena) · equity curve (all, or per Arena) · win rate, Sharpe,
PF, expectancy tiles.
Row 3: ongoing trades (all Arenas, live R and P&L) · Strategy League leaderboard (top 5 live and top 5
rising on paper) · funded challenge progress (target, daily-loss and max-loss bars per account).
Row 4: global heatmap (crypto, indices, FX, metals, NSE sectors; toggle % change / funding / OI change) ·
risk metrics (open risk, VaR, exposure by asset, correlation) · news feed + calendar ticker.
Floating: **Global AI agent** (command palette ⌘K plus a side drawer). It answers about any account, strategy or
market, and can draft (not place) trades.

### 5.2 Arena layout (single screen, no page scroll)

```
┌ top bar: account picker · mode tabs · engine state · clock/latency · Arena kill switch ────────────┐
├ left 240px ─────────┬ centre ───────────────────────────────────────────┬ right 320px ────────────┤
│ watchlist (focus    │ chart (Lightweight Charts): footprint / volume    │ order ticket or alert   │
│ instruments)        │ profile / VWAP / OI and funding panes / levels    │ arming (CFD)            │
│ engine radar: A+    │ from engine / position lines; 1–4 chart grid       │ DOM ladder + depth heat  │
│ gate per instrument │                                                   │ tape (time & sales)     │
│ daily bias chip     │                                                   │ confluence checklist    │
├─────────────────────┴───────────────────────────────────────────────────┴─────────────────────────┤
│ dock tabs: Positions · Orders · Fills · Signals · Strategy log · Agent · Calendar · News · Journal │
└────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Panels are collapsible and the layout is saved per mode. Below 1280 px the right column folds into a drawer.

**Analytics in every crypto Arena:** L2 depth heatmap, cumulative delta and CVD divergence, footprint,
absorption and iceberg flags, large-trade bubbles, liquidation map, OI change × price regime (long build-up,
short covering…), funding and predicted funding, basis term structure, long/short and top-trader
positioning, spot vs perp premium.

**Options mode (Delta, Fyers):** option chain with greeks, IV smile and term structure, OI and ΔOI by
strike, max pain, PCR, GEX/dealer gamma estimate, straddle tracker, strategy payoff builder (multi-leg,
what-if IV/time sliders), live greeks of the position.

**Scalp mode:** 1s/5s/tick charts, DOM-first layout, hotkeys, one-click bracket, latency readout.

### 5.3 CFD Arena specifics

* 7 instruments only: BTCUSD, XAUUSD, EURUSD, GBPUSD, USDJPY, US500, NAS100.
* Accounts: the two 100K evaluations (and later funded accounts) with **firm rules encoded**: profit
  target, daily loss (balance- or equity-based, reset time), max loss (static or trailing), min trading
  days, consistency rule, news window, weekend holding, lot limits. A live "room left" gauge per account.
* **Autonomous analysis engine + dedicated CFD agent** scan continuously. When the A+ gate passes for a
  core playbook model or a promoted strategy: setup is **armed**, Telegram gets entry, SL, TP, size per
  account (sized to the firm's rules) and a chart snapshot. On confirmation, a second message **Triggered**.
* No execution. You mark taken / skipped from Telegram buttons or the panel. Positions are tracked per
  account against the CFD price feed with separate account P&L.
* Tabs: Challenge progress · Journal · Daily bias · Discipline & mood · Review (Review lives only here).

### 5.4 Delta Arena and CoinSwitch Arena

* Fully autonomous: run only strategies that are **Live** in the League for that venue. Each Arena has its
  own paper account (restarted fresh; basis strategies included) and its own live account.
* Order analytics: fill rate, slippage vs signal (bps and R), maker/taker mix, fees, latency
  (signal→ack→fill), reject reasons, paper-vs-live divergence per strategy.
* CoinSwitch adds a **market explorer** (BTC, gold, silver, US-stock-linked perps once confirmed) to paper-trade
  the same strategy across markets and find where the edge is strongest.

### 5.5 Fyers Arena

* Nifty, Bank Nifty, Sensex (index F&O), stock futures, intraday equities.
* A+ gate + deep confluence for Indian markets: OI build-up by strike, PCR, India VIX, FII/DII flows,
  sector breadth, opening-range and gap stats, expiry-day behaviour.
* Paper per strategy × symbol. Promotion moves a pair to live with its own **live ledger**, kept separate.
* Session-aware: pre-open, 9:15 open, no new entries after a configurable cutoff, auto square-off before
  15:15 for intraday, expiry-day rules.

### 5.6 Strategy League (replaces Live strategies + Autopilot)

Lifecycle: **Idea → Backtest → Paper (forever) → Candidate → Live-small → Live → Benched → Retired**.

* **Strategy development agent** runs daily after the US close (and on demand). It reads League results,
  regime stats and the tick store, proposes variants inside our edge (the playbook families, the order-flow,
  OI and momentum families per venue) and submits them to the Backtest Suite. Anything that passes goes to paper.
* **Gates (fixed in advance and versioned):** backtest on tick or 1s data with fees + slippage, walk-forward
  with out-of-sample segments, ≥ 100 trades (≥ 40 for low-frequency), PF ≥ 1.3, positive in every
  WF fold, deflated Sharpe > 0, Monte Carlo 95th-percentile drawdown inside the account limit. Paper:
  ≥ 30 trades over ≥ 3 weeks and results within the backtest's confidence band.
* **Demotion:** rolling 30-trade expectancy below 0 at 90% confidence, CUSUM drift on R, drawdown past
  1.5× the backtest's max, or live slippage eating > 30% of edge. Benched strategies keep paper trading and
  can come back.
* Each venue × instrument has a **slot cap**, so the best-ranked strategy replaces the weakest live one
  automatically (with a Telegram note and an audit row).
* Existing paper trades are archived. All League stats start clean at v2 launch.

### 5.7 Backtest Suite

Pick venue → account → instruments → period → data grade (tick / 1s / 1m). Engines: event-driven tick
replay with L2 where stored, and fast vectorised bars for sweeps. Outputs: equity, drawdown, monthly
heatmap, trade list with chart replay, parameter heatmaps, walk-forward folds, Monte Carlo, regime split.
**Visual builder:** blocks for conditions (price, flow, OI, funding, session, calendar, greeks) → entry →
risk → exit. The options builder adds legs, strike rules (ATM±n, delta-based) and adjustments. Builder
output is the same versioned strategy spec the League runs.

### 5.8 Edge Analytics (was Bot log)

Every A+ and promoted signal with outcome, filtered by account, venue, instrument, strategy, engine grade
(A+/A/B), session, regime and day of week. Grade calibration (does A+ actually beat A?), gate-rule impact
(skipped-setups replay, kept from v1), taken-vs-skipped for CFD alerts.

### 5.9 Playbook

* **Core models frozen** as `v1.0`: parameters and rules hash-locked, editable only by publishing a new
  version with evidence attached (League link + backtest report). The Pine port in `tools/tradingview`
  is tied to the version.
* New models enter as `draft`. They become `core` only after passing League promotion. Each model page shows
  its spec, examples, live stats by venue and a changelog.

### 5.10 Settings → Integrations

Per venue card: environment (testnet/prod), keys status (set on the host, last 4 shown, scopes), IP
whitelist check, clock offset and RTT, WS health, rate-limit headroom, last reconcile, test-connection
button, enable/disable trading. Fyers adds daily token status, refresh-token expiry and a re-login
button. Telegram, AI provider and data vendors are listed the same way.

---

## 6. Visual design direction

* Light and dark themes (system default, toggle in the top bar). Dark-first "instrument panel": near-black surfaces in layers, one accent per Arena (CFD amber, Delta
  violet, CoinSwitch cyan, Fyers blue; green stays the brand accent), tabular numerals everywhere, 12/13 px data type, 8 px grid,
  hairline dividers instead of boxed cards where density matters.
* Motion with a purpose only: value-change flashes, live dots, smooth panel resize, 150 ms transitions.
* Status language used everywhere: dots (live/down/closed), engine states (scanning, armed, in trade,
  cooling off, halted), grade chips (A+/A/B).
* The reference shots you send will set the final look. Next step: a clickable HTML prototype of the
  Dashboard + one Arena for approval.

---

## 7. Delivery plan (after design approval, on a fresh branch)

| Phase | Scope |
|---|---|
| 0 | Engine host up (Mumbai VM, static IP, chrony, TLS). Whitelist the IP on Delta, CoinSwitch and the new Fyers app. Archive the paper ledger. New schema migrations. |
| 1 | New shell, navigation, design system, Dashboard. Old pages are removed or redirected. |
| 2 | Venue adapters + ClockSync + tick store. Integrations settings. Data on screen in all Arenas. |
| 3 | CFD Arena (rules, alerts, tracking, journal/bias/discipline/review). The two 100K evaluations are live on alerts. |
| 4 | Strategy League + Backtest Suite + dev agent. Paper on Delta, CoinSwitch and Fyers. |
| 5 | Live execution: Delta testnet → prod small, then CoinSwitch, then Fyers. |
| 6 | Visual builder, options payoff tools, Edge Analytics, Playbook versioning, polish. |

## 8. Risks

* **Data honesty:** FX and index flow without CME data is a proxy. It is labelled as such and kept out of gate scores until a real feed exists.
* **Overfitting from auto-generated strategies:** fixed gates, deflated Sharpe, multiple-testing count per run, clean out-of-sample data.
* **Venue risk:** API changes and outages. Health checks halt the Arena, never retry blindly, and reconcile on reconnect.
* **Compliance:** SEBI static IP and Algo ID for Fyers. Delta and CoinSwitch are FIU-registered Indian venues. Prop firm terms on copy and alert use and on news trading are encoded per account.

---

## 9. Decisions (31 Oct 2026)

### 9.1 CFD Arena accounts — rules encoded per account

Rules come from the firms' own pages (FundedHive Pay From Profits, The5ers Summer Plan), checked 31 Oct 2026.
Every limit is a field on the account, not a constant, so a plan change is an edit, not a code change.

| | FundedHive 100K · 1-Step · Pay From Profits | The5ers 100K · Summer Plan (1-Step assumed) |
|---|---|---|
| Profit target | 10% | 10% |
| Daily loss | 5%, **balance-based, static** | 3% of the **higher of end-of-day equity or balance** (recomputed at each day's close) |
| Max loss | 10%, **balance-based, static** (floor $90,000) | 6% of initial balance (floor $94,000) |
| Per-trade loss cap | 3% (1 / 1.5 / 2 / 3% by chosen risk group) | none stated |
| Consistency | none | **no day > 50% of total profit** |
| Min days | 3 profitable days | not stated |
| News trading | allowed | not stated (engine still stands down ±15 min by our own rule) |
| Weekend | allowed in evaluation, **not on funded** | overnight allowed |
| Leverage | FX 1:50 (dynamic, by risk group) | 1:100 |
| Payout | 80%; fee taken from the first profits | 75% (scaling plan) |

Gauges per account: target progress, **daily room** = limit − (today's start reference − current equity),
**max-loss room** = equity − floor, **per-trade cap**, **consistency headroom** (The5ers: largest day ÷ total
profit vs 50%), **profitable days** (FundedHive: n / 3). Alert sizing uses the smallest of: 0.5% risk, the
per-trade cap, 50% of today's daily room, and (The5ers) the size at which a full win would break the 50% day.

Open: confirm The5ers variant (1-Step vs 2-Step 10/5 or 8/5), the FundedHive risk group, both platforms
(MT5 / cTrader / Match-Trader) and each firm's day-reset time and server timezone.

### 9.2 Market data — free sources first

| Need | Free source | Use |
|---|---|---|
| Live FX, XAU, index CFD prices | **cTrader Open API** with a free broker demo account (spot ticks; the API also lists depth-quote subscriptions, to be confirmed per broker on the demo) | CFD Arena prices, position tracking |
| Tick history for backtests | **Dukascopy** historical bid/ask ticks (FX, metals, index CFDs) | Backtest Suite, tick-level research |
| XAU / BTC order flow, OI, funding, liquidations | Binance / Bybit / Delta / OKX perps (gold and silver perps included) | real flow, used in gate scores |
| Daily futures OI and volume (6E, 6B, 6J, ES, NQ, GC) | CME daily bulletin (end of day) | daily OI regime for FX and indices |
| Positioning | CFTC COT (weekly) | bias |
| India | Fyers data socket + TBT (free with the account) | Fyers Arena |

Intraday FX and index "order flow" is tick-volume and CFD-depth based until a paid CME feed is added. It is
labelled as a proxy and kept out of A+ gate scores. Paid upgrade path stays Databento (CME).

### 9.3 Infrastructure — DigitalOcean, minimal management

* DigitalOcean has no Mumbai region; use **Bangalore (BLR1)** (about 15–20 ms to the Mumbai exchanges and
  Delta's India endpoints).
* One droplet (start: Basic 2 GB / 1 vCPU, about $12/mo; upgrade to 4 GB if the tick store needs it) + a 50 GB
  block volume for ticks (about $5/mo) + weekly droplet backups.
* The droplet's own public IPv4 is fixed for its lifetime: that address is whitelisted on Delta,
  CoinSwitch and the new Fyers app (SEBI static IP). Never destroy the droplet without re-whitelisting.
* Ubuntu LTS, Docker Compose with three services (gateway, TimescaleDB, Caddy for TLS), `unattended-upgrades`,
  `chrony`, a firewall that only opens 443, and a heartbeat to the app so the Dashboard shows it red when down.
  One `deploy.sh` pulls and restarts; no Kubernetes, no manual babysitting.

### 9.4 Other answers

* **Fyers:** register a new API app after the droplet exists and map it to the droplet's static IP.
* **CoinSwitch:** request options beta access (asking is normal; it is how CoinSwitch grants it) and list the
  gold, silver and US-stock futures visible on the API futures surface.
* **Paper trades:** start fresh. Old paper rows are exported once to a dated backup file, then cleared;
  League stats begin at v2 launch on the new data.
* **Strategy agent:** OpenRouter, as today.
* **Mobile:** monitoring only (Dashboard, positions, alerts, kill switches). Arenas are designed for desktop.

### 9.5 CFD alerts → cTrader (both prop accounts are on cTrader)

* Accounts: **FundedHive 100K 1-Step, low-risk group** (per-trade loss cap 1%) and **The5ers 100K Summer
  Plan 2-Step 10/5** (phase 1 target 10%, phase 2 5%, daily 3% of the higher of EOD equity or balance,
  max loss 10%, no consistency rule in evaluation).
* Every armed alert carries one **cTrader signal link per account**
  (`https://app.ctrader.com/signal?s=…&o=limit&d=buy&p=…&sl=…&v=…&tp=…&tpv=…&tp2=…&tpv2=…&e-utc=DD-MM-YYYY_hh-mm&c=…`).
  Tapping it in Telegram opens cTrader's order screen pre-filled; the trader checks it and taps Place order.
  Volume is only carried when the order has split take-profits, so alerts always use TP1/TP2 halves, which
  also lets each account get its own size. The comment carries the signal id (`APLUS <id> <acct>`) so fills
  can be matched back to the alert.
* Volume is sent in the symbol's units from the account's cTrader symbol spec (gold: ounces, so 0.66 lots
  = 66), read once per account.
* Position tracking: cTrader Open API with the trader's cTrader ID in **read-only** use (positions, deals,
  balance) if each firm's server allows Open API; otherwise "Taken" from Telegram plus price tracking.
  The app never places prop-account orders.

## 10. Build progress

| Phase | State |
|---|---|
| 1 · Shell, design system, Dashboard, Arena layout, redirects | Done (`claude/v2-platform-build`) |
| 2 · Engine host, venue adapters, clock sync, tick store, flow views | Code done: `services/engine` (Delta socket + REST fallback, CoinSwitch HFT, Fyers, TimescaleDB, signed API, deploy kit). Arena Order flow / Depth / OI & funding tabs live on Delta data without the host. **Waiting on:** the droplet, its IP whitelisted at each venue, `ENGINE_URL` + `ENGINE_SECRET` in Vercel. |
| 3 · CFD Arena rules, alerts with cTrader links, position sync | Next |
