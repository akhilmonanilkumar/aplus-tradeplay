# System report — feeds, paper trades and tracked setups

Window: 26 Oct 10:00 → 27 Oct 23:25 UTC (about 37 hours of live autopilot passes). All numbers come
from production (`signals`, `trades`, `orders`, `net._http_response`, the feed probe); nothing was read
from the dashboard.

## 1. Market feeds

### What was broken

| Symptom (every pass for 6+ hours) | Cause |
|---|---|
| XAUUSD and EURUSD "timed out after 150s" | Twelve Data's free plan (800 calls/day, 8/min) was exhausted. The loader slept 61 s per 429 retry and waited for rate-limit slots, so it never reached the free fallback inside the market's budget. |
| USDJPY "Twelve Data … HTTP 429" | Twelve Data was its only feed. |
| Ledger and selector "timed out after 90s" | Both load the same metered feeds and waited the same way. |
| Nifty 37 hours stale, quote "no session bars today" | Upstox publishes a finished session to its history endpoint late, and its intraday endpoint empties at the IST day change. Between close and next morning the loader served the session before last without saying so. |

### Fixes (deployed)

- **Metered vendors fail over at once on live passes.** A 429 or out-of-credits reply trips a cooldown (2 → 15 → 60 min, or to UTC midnight when the daily credits are gone). While it lasts the vendor fails in under 0.5 s and the next provider answers. Backtests still wait and retry, as before.
- **Yahoo Finance (keyless) added:**
  - EUR/USD and USD/JPY now use Yahoo, ahead of Twelve Data, so the Twelve Data credits go to gold alone (about 288 calls/day on 5M).
  - Nifty falls back to Yahoo ^NSEI for candles and for the quote.
- **Stale Upstox sessions are refused,** so the fallback answers instead.
- **Feed health probe:** `GET /api/autopilot/lab?family=feeds[&metered=1]` (same auth as the tick). It tests every provider in every chain, plus untried candidates, and reports bars, last-bar age and latency.
- **Test fix:** a stale news/calendar test now matches the desk mapping (USD events apply to every desk). Web suite 14/14, engine suite 134/134.

### Verified autopilot pass (27 Oct 23:44 UTC)

| | Before (every pass, 17:45–23:30 UTC) | After |
|---|---|---|
| Pass duration | ~300 s, cut off by time limits | **15 s** |
| Market errors | XAUUSD, EURUSD, USDJPY | none, all 10 markets evaluated |
| Ledger | timed out after 90 s | 51 signal outcomes updated |
| Selector | timed out after 90 s | ranked 5 markets (none eligible: price in the wrong half of the range) |

### Verified state (probe, 27 Oct 23:43 UTC)

| Market | Live source | Grade | Last closed 5M bar |
|---|---|---|---|
| XAUUSD | Binance XAU index (Twelve Data in cooldown until it resets) | approx | fresh |
| XAUUSDT.P | Binance mark | exact | fresh |
| BTCUSDT.P | Binance mark (Bybit and OKX also OK) | exact | fresh |
| BTCUSD.SPOT | Coinbase (Kraken and Binance also OK) | exact | fresh |
| BTCUSD | Coinbase CFD reference | approx | fresh |
| EURUSD | Yahoo EUR/USD | exact | fresh |
| USDJPY | Yahoo USD/JPY | exact | fresh (was failing) |
| NAS100 | Binance QQQUSDT.P tracker | approx | fresh |
| SPX500 | Binance SPYUSDT.P tracker | approx | fresh |
| NIFTY | Yahoo ^NSEI | exact | 27 Oct close (was 26 Oct) |

All 10 quotes resolved: Swissquote for metals and FX, Binance and Coinbase for crypto and trackers, Yahoo for Nifty.

Probed but not wired in:
- Yahoo spot gold returns 404.
- Gold, Nasdaq and S&P futures on Yahoo are about 10 minutes delayed.
- ^NDX and ^GSPC carry real index points during US cash hours. They are an option for the index desks later.

## 2. What was tested

| | Count | Notes |
|---|---|---|
| Tracked setups (`signals`) | 231 | Every model and session strategy on 9 markets, logged once per setup, with outcomes resolved on candles |
| — resolved win/loss | 108 | 59 never filled (expired or ran away), 64 still open or pending |
| Paper trades (`trades`, source=paper) | 18 | All from the session strategies (model S), the only setups the gate marked tradeable |
| Paper account | $100,000 → $96,984 | −$3,016 net, including $1,887 of fees |
| Basis account | $1,000, BTC only | Off. Research done; no positions yet. |

## 3. What actually works

- **London Break (`ldn-bo`) is the one positive strategy.** It took 2 ideas, both winners: BTC +2R/+3R and gold +2R/+3R by variant. That's +9.5R net across the variants. The partial-profit variant (`-p`) made more than the base in both cases.
- **The gate is doing its job.** Setups it rejected went 4 wins / 86 losses, −126R net. Setups it passed went 4 / 14, −9.4R. Without the gate the tracked losses would have been 13× larger.
- **EUR/USD** tracked setups went 2/2, +2.5R. That's too few to mean anything yet.
- **The pipeline works end to end:**
  - setup logged once, paper order queued and filled on the candle
  - stop or target resolved, P&L and fees booked to the paper account
  - outcome written back to the ledger
  - live P&L polled every 5 s

## 4. What does not work

| Finding | Evidence |
|---|---|
| **E (Sweep Snap) loses on gold** | 46 setups, 0 wins / 36 losses, −58R net. It re-fires every 5 minutes on the same move (10:50, 10:55, 11:05, 11:15, 11:20, 11:25 on 27 Oct), taking a fresh stop each time. |
| **Fades lose** | Tokyo Trap and London Trap: 3 ideas, 3 losses (12 paper trades across variants). The gold London fade used a 0.056% stop and was out in 10 minutes. |
| **Costs larger than the stop** | The average cost is −0.49R per resolved setup, which turned −82R gross into −135R net. Worst cases: XAUUSDT.P −1.11R per trade (median stop 0.086% against about 0.1% round-trip cost), BTCUSD.SPOT −0.99R, model H −1.19R. |
| **Same idea counted several times** | Gold is tracked on 2 feeds and BTC on 3, with identical gross results. Each session strategy runs 4 variants, so the 18 paper trades are really 6 trade ideas. |
| **Overall hit rate** | 8 wins / 100 losses on tracked setups. A, B, C, D, G and H are all negative net on this sample. |

## 5. What to optimise (in order)

1. **Stop E after a stop-out:** one entry per sweep level per session, or pause E on gold until a backtest says otherwise. This is the biggest single loss.
2. **Apply the cost filter live:** skip a setup when the round-trip cost is above 0.25R. The backtester already has `maxCostR`, and it lifted gold in the improve family. On this sample it removes most XAUUSDT.P, BTCUSD.SPOT and H trades.
3. **Count each idea once:**
   - track gold on XAUUSD only and BTC on BTCUSDT.P only (keep the other feeds as references)
   - roll the 4 session-strategy variants up to one idea in the stats, so a single trade can't look like four
4. **Session strategies:** keep London Break with the partial-profit variant. Pause Tokyo Trap and London Trap until the lab confirms them over 180 days.
5. **Feeds:**
   - Twelve Data's free plan only covers gold, so long FX backtests should name it as the source.
   - A paid plan, or an OANDA practice key, would make gold exact again instead of the Binance index.
   - Move the index desks to ^NDX/^GSPC during US cash hours if index points matter more than 24/7 coverage.
6. **Sample size:** 37 hours and 6 paper ideas prove the plumbing, not the edge. Run at least 4 weeks, or 30+ ideas per strategy, before any live money. Judge on net R after costs, counting each idea once.
