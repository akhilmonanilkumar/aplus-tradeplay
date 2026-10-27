# Where does the edge work? Seven markets, 180 days (27 Oct 2026)

Same engine, same rules, 30 Apr – 27 Oct 2026, 5M entries, NFP/FOMC news filter, live stop and target rules (stop beyond sweep / OB / POI + ATR buffer, first target ≥ 2R). Windows London Q and NY Q; the Nifty trades India Q (09:15–12:15 IST). Run with `/api/autopilot/lab?family=models&days=180`.

| Market | Data | Cost per trade |
|---|---|---|
| Gold | Binance XAU index (spot-gold composite) | 0.06R |
| BTC | Binance BTCUSDT.P mark | 0.45R |
| EURUSD | Twelve Data EUR/USD | 0.16R |
| USDJPY | Twelve Data USD/JPY | 0.25R |
| NAS100 | Binance QQQUSDT.P (Nasdaq-100 tracker, listed 6 Apr) | 0.10R |
| SPX500 | Binance SPYUSDT.P (S&P 500 tracker, listed 6 Apr) | 0.16R |
| NIFTY | Upstox NSE Nifty 50 (India Q only, 9,261 bars) | 0.24R |

## Full A+ gate (every box)

| Market | Trades | Net R | Notes |
|---|---|---|---|
| Gold | 11 | +4.9 | 9 of them counter-trend G |
| BTC | 7 | −8.8 | |
| EURUSD | 21 | −6.4 | 16 of them G |
| USDJPY | 12 | −3.8 | 11 of them G |
| NAS100 | 12 | −9.5 | 11 of them G (−8.5R) |
| **SPX500** | 17 | **+7.9** | A, C and D won all 5 of theirs (+10.1R); G 12 trades −2.2R |
| NIFTY | 11 | −6.8 | |

The full checklist trades 1–3 times a month per market. Rows are simulated one model at a time, so an A, C and D trade can be the same setup.

## By model with the location boxes off (net R, trades)

| Model | Gold | BTC | EURUSD | USDJPY | NAS100 | SPX500 | NIFTY |
|---|---|---|---|---|---|---|---|
| A shift → pullback | −23.4 (79) | −35.5 (50) | −17.7 (61) | −20.0 (55) | −17.1 (64) | **+6.8** (66) | −5.2 (15) |
| B flip zone | −14.6 (55) | −10.7 (29) | **+5.4** (35) | **+2.8** (33) | −6.7 (35) | −11.2 (36) | +1.6 (7) |
| C sweep → OB → FVG | −25.8 (42) | −13.2 (30) | −2.8 (26) | −3.2 (20) | −3.6 (30) | −0.4 (34) | −3.7 (6) |
| D first-tap sweep | −6.3 (9) | −10.8 (8) | +1.8 (10) | −11.5 (14) | −9.8 (18) | +3.5 (14) | −6.3 (5) |
| E gold sweep | **+5.1** (167) | — | — | — | — | — | — |
| F Asia sweep | −8.4 (8) | +8.5 (7) | +1.3 (7) | −3.7 (3) | −2.1 (2) | +0.8 (6) | — |
| G counter-trend | −5.5 (81) | −41.7 (65) | +0.3 (83) | −8.4 (81) | −24.7 (77) | −13.4 (86) | −10.8 (29) |
| **All models** | −10.0 (169) | −55.8 (91) | −18.9 (116) | −24.0 (109) | −29.4 (118) | −12.7 (125) | −15.7 (39) |

None passes the lab's bar (≥ 40 trades, PF ≥ 1.2, positive in both halves). Closest:

- **EURUSD model B**: 35 trades, 37 % wins, PF 1.21, halves 0 / +5.4R.
- **SPX500 model A**: 66 trades, 35 % wins, PF 1.13, halves +15.0 / −8.2R.
- **USDJPY model B**: 33 trades, 39 % wins, PF 1.12, halves +6.6 / −3.8R.
- **Gold model E**: 167 trades, PF 1.04 (break-even).

## What it says

1. **Changing market does not fix the edge.** The same picture as gold and BTC shows up everywhere: wins of 25–30 % against a 30–34 % break-even, and 35–45 % of losers never going 0.3R in favour. The entry trigger is the problem, not where it is traded.
2. **Model A loses on six of seven markets**; only the S&P is positive, and its second half lost.
3. **The flip zone (B) is the one model that holds up on forex** (EURUSD and USDJPY both positive) and loses on gold, BTC and US indices.
4. **Counter-trend G loses on six of seven** (flat on EURUSD) and is most of what the full gate trades on forex and indices. Keep it off.
5. **Costs matter on BTC, USDJPY and the Nifty** (0.25–0.45R per trade); gold and NAS100 are cheapest.
6. **The Nifty trades rarely** in India Q (15 model-A setups in six months); it needs a longer window or a second session to say anything.

## Now running

All ten instruments are on the paper autopilot (the five new ones since 27 Oct, alerts on closed trades only), logging every setup with its gate verdict. The live paper P&L card on the dashboard and bot log marks open trades every five seconds.
