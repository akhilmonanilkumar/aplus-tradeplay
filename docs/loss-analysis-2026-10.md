# Why the edge loses — 180-day backtest by entry model (27 Oct 2026)

Data: 30 Apr – 27 Oct 2026. Gold on the Binance XAU index (spot-gold composite, 35,880 5M bars); BTC on the Binance BTCUSDT.P mark (52,416 5M bars). Windows London Q and NY Q, NFP/FOMC news filter, live stop rule (beyond the furthest of sweep wick, 5M OB and 15M POI + max(spread, 0.2 × 5M ATR)), first target paying ≥ 2R. Run with `/api/autopilot/lab?family=models&days=180`.

Three views per model:

- **Full gate** — every box of the A+ checklist.
- **Location off** — the premium/discount, POI and one-soft-miss boxes off; trend, window, news and R:R still apply. This shows whether the trigger itself (sweep → shift → entry) has an edge.
- **Playbook** — the documents' stop (just beyond the entry zone) and target (nearest real level, 3R minimum).

## 1. Under the full gate the edge barely trades

| | Gold | BTC |
|---|---|---|
| Model A trades in 180 days | 1 (+2.2R) | 1 (−1.3R) |
| Other models | G 9 trades (+3.7R), C 1 | B 1, G 5 (−6.1R) |
| Top reasons a setup was rejected | wrong half of the range (shorts in discount, longs in premium), counter-trend, HTF/15M disagreement | same |

About 500 model-A setups formed per instrument and almost all were rejected. Six months of backtest cannot say whether the full A+ checklist works — the paper ledger (live since today) logs every setup with its gate verdict, so rejected setups are measured too.

## 2. Without the location boxes every trigger loses

| Model | Gold n · WR · net R | BTC n · WR · net R |
|---|---|---|
| A shift → pullback | 79 · 20 % · −23.4 | 50 · 22 % · −35.5 |
| B flip zone | 55 · 22 % · −14.6 | 29 · 31 % · −10.7 |
| C sweep → OB → FVG | 42 · 12 % · −25.8 | 30 · 27 % · −13.2 |
| D first-tap sweep | 9 · 11 % · −6.3 | 8 · 0 % · −10.8 |
| E gold sweep (market) | 167 · 32 % · **+5.1** (PF 1.04) | — |
| F Asia sweep | 8 · 0 % · −8.4 | 7 · 43 % · **+8.5** |
| G counter-trend | 81 · 27 % · −5.5 | 65 · 23 % · −41.7 |
| All models together | 169 · 28 % · −10.0 | 91 · 25 % · −55.8 |

Break-even win rate at the planned R:R is 28–31 %. The triggers win 20–27 %.

## 3. Why the losers lose

**It is the entry, not the target.** Of the losers:

| | Gold all models | BTC all models |
|---|---|---|
| Never went 0.3R in favour | 41 % | 38 % |
| Reached +1R, then stopped out | 21 % | 29 % |
| Stopped within two bars | 27 % | 18 % |

Replaying every trade with a fixed 1R, 1.5R or 2R target makes every model **worse**, not better (gold all models: −33.8R at 1R, −11.8R at 2R versus −10.0R as traded). Taking profit earlier does not rescue the trades — too many shifts are simply wrong.

**BTC pays too much in costs.** Average cost is **0.45R per trade** on BTC (0.06R on gold): the 5M structural stop is small against fees, so a third of every loss is cost. On model A that is about 22R of the 35R lost. Break-even win rate rises by about 10 points.

**The playbook stop is too tight on 5M.** With the stop just beyond the entry zone, gold won 7.5 % and 28 of 37 losers were stopped within two bars (median one bar). Your furthest-anchor stop is the right call.

**Shorting the low, buying the high.** Gold shorts taken in deep discount (< 25 % of the range) lost −29.5R across models; the premium/discount box is doing real work, which is also why the full gate trades so rarely.

## 4. What holds up (small samples — watch, don't act yet)

- **15M OB with a liquidity story as the POI** — the documents' "quality POI": gold all models 10 trades, 50 %, +7.1R; gold E 12 trades, 58 %, +11.6R. FVG POIs and plain 5M OBs as anchors lose on every model.
- **Liquidity targets win, FVG targets lose** — gold PDL target 7 trades 57 % +9.9R, London low 4 trades +2.2R; on model A, 15M and 5M FVG targets lost −9.4R and −10.5R. The playbook says target liquidity; the engine also targets FVGs.
- **Time of day** — 02:00 NY (the first London hour) is the worst hour on both instruments (gold A 18 trades 6 % −14.4R; BTC all 22 trades 14 % −21.5R); 08:00 NY is next worst. 03:00–04:00 and 07:00 NY are flat to positive.
- **Model E (gold, enter on the sweep close)** is the only model near break-even with size (167 trades, PF 1.04). **Model F on BTC** +8.5R from 7 trades.
- **Counter-trend G** loses on both (BTC −41.7R) — keep it off.
- Longs did worse than shorts on both instruments in this period (gold and BTC fell).

## 5. Not testable yet

- **H (1M sniper)** needs 1M history; the lab loads it only for ≤ 60 days (`&m1=1`). Live, it is logged every pass.
- **I (post-news)** sees only NFP and FOMC in history (gold 0 setups, BTC 1). Live releases are now stored in `news_events`, so later backtests get CPI and the rest.

## 6. Candidate rule changes (for the owner to decide)

1. Require a **15M OB with a liquidity story** as the POI; drop FVG POIs.
2. **Target liquidity only** (PDH/PDL, session highs/lows, EQH/EQL, range extremes); stop using FVGs as targets.
3. **Skip 02:00–03:00 NY** (first London hour) and **08:00–09:00 NY**.
4. **BTC:** require stop ≥ k × round-trip cost (e.g. cost ≤ 0.15R), or trade BTC from 15M entries.
5. Keep **G, C and D** off live until the paper ledger shows otherwise.

Each can be backtested in the lab before it is adopted.
