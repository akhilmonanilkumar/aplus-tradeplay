# Edge audit — rules vs engine (27 Oct 2026)

Sources: *A+ Trading Edge — Copilot Configuration Spec* (PDF), *Trade Finder Pro master guide* (62-lesson Market Mechanics knowledge base), and the owner's decisions in the desk sessions. Each rule below says where the engine applies it and whether it matches.

Status: **OK** matches · **Fixed** was wrong or missing, changed in this pass · **Owner** the owner chose a different rule from the document (kept, measurable in the lab) · **Gap** not automated, with the reason.

## Direction and location

| Rule (source) | Engine | Status |
|---|---|---|
| HTF = 1H gold / 4H BTC; POI TF 15M; entry 5M (Edge §2) | `instruments.ts` timeframes | OK |
| HTF trend and 15M trend must agree; disagreement = wait, not fail (Edge §5 box 1, TFP §5) | `gate.ts` box 1 → `pending` | OK |
| Trade only with the HTF trend; counter-trend only as its own model (Edge §8 CT-1, TFP model G) | box 1 fails counter-trend; G is never A+ | OK |
| Structure = body-close BOS/CHoCH; swing vs internal (TFP §2.1) | LuxAlgo port (`smcStructure`, swing 50 / internal 5) for trend and range | Owner (chose LuxAlgo structure) |
| HTF range = leg of the latest BOS, fib 50 % (Edge §3, TFP §4) | LuxAlgo trailing swing top/bottom; (3,3) protected-level range until a swing break exists | Owner |
| Long only in discount, short only in premium; mid-range = no trade (Edge §3, box 2) | box 2 with a ±5 % band; price outside the range = fail | OK |
| POI types: S/D zone, OB, unfilled FVG, flip zone (Edge §4) | 15M OBs and FVGs; flip zones only as model B entries; plain S/D bases not detected | Gap (S/D bases need a separate "base" detector) |
| OB = last opposite candle before displacement; candle takes the previous candle's low/high; leaves an imbalance; breaks structure (TFP §2.3) | Was: took-the-low not required. Now required with imbalance and the break | **Fixed** |
| Liquidity story: the zone swept liquidity when it formed, or sits just beyond a pool price must take first (Edge §4, TFP §2.3) | Was: the OB's took-the-previous-candle rule stood in for it. Now: the zone's leg ran a prior 15M swing on the stop side, or a sell-side (buy-side) level sits within 1 ATR in front of it | **Fixed** |
| POI created a break of structure (TFP §2.3 checklist) | OBs by construction; FVGs now checked for a break within 3 bars (was: FVGs always failed) | **Fixed** |
| Fresh (unmitigated); prefer the extreme zone (Edge §4) | Fresh until the current tap; extreme-vs-internal preference not applied | OK / Gap (preference) |
| Liquidity: PDH/PDL, EQH/EQL, session highs/lows, internal swings (Edge §3) | PDH/PDL (17:00 NY roll), EQH/EQL (0.1 ATR), Asia high/low, 5M swings. London high/low was missing for the NY window | **Fixed** (London added) |

## Execution

| Rule (source) | Engine | Status |
|---|---|---|
| Price inside the POI before anything (Edge §4) | box 3: price in the zone now, or the sweep bar / last 6 bars tapped it | OK |
| Sweep = wick through a level, close back (box 4) | `isSweep` on the entry TF within the sweep lookback (36 × 5M) | OK |
| Shift = 5M BODY close beyond the last LH (long) / HL (short) (box 5) | `marketShift`: first body close beyond the last (2,2) swing formed before the sweep | OK |
| Session windows London Q 02–05, NY Q 07–10 New York (box 6) | `sessions.ts`, DST-safe | OK |
| News: no entries ±15 min of high-impact releases (box 6) | Live: Forex Factory calendar. Backtests had **no** news data; now NFP (first Friday 08:30) and FOMC (14:00) are applied; CPI not included. Live releases are now stored in `news_events` for future backtests | **Fixed** (partial for history) |
| Min R:R 3 to a real target (box 7) | `EDGE_RULES.minRR = 2` | Owner (2R); the lab's "playbook" row tests 3R |
| Target: nearest structural level; if under 3R, skip; never stretch (Edge §7, TFP §7) | Live rule takes the nearest level paying ≥ 2R (skips nearer levels) | Owner; `targetMode: 'nearest'` reproduces the playbook |
| Stop: just beyond the entry zone or the sweep wick, + spread; "whichever is nearer and still logical" (Edge §7, TFP §7) | Live rule: beyond the furthest of sweep wick, entry OB and 15M POI, + max(spread, 0.2 × 5M ATR) | Owner; `stopMode: 'zone'` reproduces the playbook |
| BTC stop ≥ 0.4 % of price (Edge §2) | Removed | Owner |
| No pullback, no trade; cancel if price runs away or the window closes (Edge §6) | Limit expires after 12 bars, cancelled on target-before-fill or window close | OK |
| Max 2 A+ trades per instrument per day; stop after 2 losses (Edge §7) | Backtester per New York day; live via the daily caps | OK |
| Set and forget for the first 30 trades (Edge §7) | Default: no BE, no partials | OK |
| Grade A = one quality concern → log / base risk; two misses = no trade (Edge §5, TFP §5) | `gate.ts` soft misses | OK |
| A model that fires outside the window is logged, not traded (Edge §6) | Paper ledger logs it with box 6 failed | **Fixed** (was not logged) |

## Entry models

Before this pass only **model A** was detected (and G as A against the trend). B–I existed as labels in the gate. All are now detected by `packages/engine/src/detect.ts`, backtested one at a time and logged live:

| Model | Trigger as detected | Entry · stop | Status |
|---|---|---|---|
| A Market shift → pullback | sweep → 5M body-close shift | limit at the 5M OB that started the shift (or the broken level) · furthest anchor | OK |
| B Flip zone | an opposing 5M zone between the sweep and the shift that price closed through | limit at the flip zone's near edge · beyond the flip zone | **Added** |
| C Sweep → OB → FVG | A's OB plus an unfilled FVG the displacement left in/next to it | limit at the FVG's near edge · beyond the OB | **Added** |
| D Institutional precision | POI with a liquidity story; the sweep took the low (high) of the first tap of that POI; then the shift | as A | **Added** |
| E Gold sweep (aggressive) | gold only; in the POI; enter at the sweep candle's close, no shift | market · beyond the sweep wick | **Added** (never passes the strict gate unless aggressive entries are enabled) |
| F Asia sweep | Asia high/low swept in London Q with the bias, then the shift | as A; aims for the other side of the Asia range | **Added** |
| G Counter-trend pullback | A's structure against the HTF trend (on 5M; the playbook asks for 1M) | as A · never A+ | OK (5M stand-in) |
| H Sniper / fractal | A's shift ran ≥ 1R without filling; a fresh 1M internal break leaves a 1M OB | limit at the 1M OB · just beyond it · target ≥ 5R | **Added** (needs 1M data: live always, lab with `m1=1` up to 60 days) |
| I Post-news | sweep and shift 30–120 min after a high-impact release | as A | **Added** (backtests only see NFP/FOMC) |
| S Session-range strategies | Asia range in London / London range in NY, fades and breakouts (research, not in the playbook) | market at the trigger close | Experimental, tracked separately (Edge §8) |

## Paper trading and logging

- Every pass logs each model setup once (key: model, side, defining bar) to `signals` with the paper gate verdict (all models permitted), the strict verdict under the current settings, the plan under the live rules and under the playbook rules (`meta.spec`), the stop anchor, the candidate targets, sweep, POI, HTF/15M trend and position in the range.
- Outcomes of **every** logged setup — traded or rejected — are resolved on 5M candles, so each rule's cost or benefit is measured on live data.
- Paper orders go to the dedicated paper account for setups the gate would trade (A+, or grade A for models that are never A+).
- The scheduler's secret is generated in Supabase Vault and checked by `autopilot_secret_ok()`.
