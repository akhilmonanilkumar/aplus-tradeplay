# A+ Edge — TradingView strategy

`aplus_edge_strategy.pine` is a Pine Script v6 port of the app's edge (`packages/engine`: `setup.ts`, `gate.ts`, `backtest.ts`) so the entry models can be backtested on TradingView's full history.

## Use

1. TradingView → Pine Editor → paste the file → **Add to chart**.
2. Open a **5-minute** chart of the instrument (e.g. `OANDA:XAUUSD`, `BINANCE:XAUUSDT.P`, `BINANCE:BTCUSDT.P`, `COINBASE:BTCUSD`).
3. Settings → **Preset** = the matching instrument (sets stop buffer, minimum stop and round-trip cost as in the app). HTF is 1H for gold and 4H for BTC on *Auto*.
4. Read results in the **Strategy Tester** (money, sized at *Risk per trade* % of equity) and in the on-chart table (R after the preset's cost, plus why the gate rejected setups).
5. Use Deep Backtesting (premium plans) for more history on 5M; bar magnifier is on where your plan allows it.

Leave *Commission* at 0 in Properties: the table already subtracts the preset's round-trip cost in R. If you set a commission, the Strategy Tester money figures include it while the table's *Gross R* does not.

## What it reproduces

- **Structure:** body-close BOS/CHoCH through the last confirmed (3,3) swing; HTF dealing range = origin of the latest break → extreme since; trend = direction of the latest break. HTF and 15M use closed bars only (no repainting).
- **Liquidity:** previous-day high/low with the day rolling at 17:00 New York, the Asia range (20:00–24:00 NY), 15M equal highs/lows (within 0.1 ATR), recent 5M (3,3) swings.
- **Sweep:** wick through a level and close back. **Shift:** first 5M body close beyond the last (2,2) swing that formed before the sweep, within the sweep lookback.
- **POI (box 3):** the two most recent 15M order blocks per side that left an imbalance and are untouched or first tapped within the last 12 bars; touched by price, the sweep candle or the last six bars. A block that swept liquidity when it formed passes; one that did not is a soft miss (grade A).
- **Gate:** HTF and 15M aligned with the trade (box 1), entry in the correct half with a ±5 % no-trade band around equilibrium (box 2), POI (box 3), sweep and shift (boxes 4–5), London Q 02–05 / NY Q 07–10 NY (box 6), stop on the right side, minimum stop % and R:R ≥ 3 to the nearest real level beyond ¼R (box 7). A+ takes; grade A only when enabled.
- **Execution:** limit order at the shift bar close, cancelled if price reaches the target first (ran away), after 12 bars, or when the window closes; stop and target attached; max 2 trades and stop after 2 losses per New York day; one order at a time; optional break-even.

## Entry models

| Model | Entry | Notes |
|---|---|---|
| A · Market shift → pullback | Limit at the 5M order block that caused the shift (else the broken swing) | The app's default and what the selector trades |
| C · Sweep → OB → FVG | Limit at the 5M FVG left by the displacement | Rejected when the displacement left no OB with an FVG |
| F · Asia sweep | Model A entry | Only Asia high/low sweeps during London Q |
| E · Aggressive sweep | Limit at the sweep candle's close, no shift | Always grade A (aggressive is a soft miss): enable grade A |

Models B (flip zone), D (inducement), G/H (1-minute fractal) and I (post-news) need confirmations that cannot be detected reliably from bars alone and are not included.

## Differences from the app

- **News:** TradingView has no economic calendar, so the ±15 min high-impact news block is not applied. Results will include some trades the app would skip.
- **Fills:** TradingView's broker emulator decides the order of stop and target inside a bar. The app's backtester is stricter: on the fill bar only the stop counts. With bar magnifier on the difference is small; without it, expect slightly better results here.
- **Zones:** only order blocks are used as POIs (15M FVGs always fail box 3 in the app anyway); at most two blocks per side are tracked.
- **Pivots:** TradingView's pivot functions treat equal highs/lows slightly differently from the engine, so the odd swing can differ.

Cross-check a period against the app's Lab (same instrument, windows, minimum R:R, grade A setting) before relying on a result.
