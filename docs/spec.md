# A+ Tradeplay — Feature Spec v2.2
**25 Oct 2026 · closed, invite-only service · replaces ZekeAI spec v1.0**

Inputs: *A+ Trading Edge — Copilot Configuration Spec* (PDF), pre-design research brief (25 Oct 2026), owner decisions below.

---

## 0. Business model (owner-defined)
| Stream | How it works | Revenue |
|---|---|---|
| **Investors — fully managed** | Investor pays for a prop account. A+ Tradeplay buys it **in its own name**, copies the master into it, and runs it end to end. Managed capital (sub-account under master) also supported. | **20%** of each prop payout (after the firm's split), or 20% of profit above the high-water mark for managed capital. Deducted before paying the investor. |
| **Telegram subscribers** | Pay monthly/quarterly to follow signals in the VIP channel; free group gets delayed posts. | Subscription fees |
| **Own trading** | Master + own sub, eval and demo accounts. | Own P&L |

Removed from v1: friend/follower accounts executing on their own keys.

> ⚠ Compliance (from research): prop accounts run for third parties breach most firms' terms (The5ers bans account-management services; FundedHive appears to ban copying even between your own accounts; Kraken Prop has no API). Pooled profit-share management for Indian residents is a SEBI-PMS / FEMA question. The platform keeps per-firm copy rules, signed agreements, purchase records, payout approvals and an append-only audit log — get a legal opinion before scaling.

## 1. Apps & roles
| App | Who | Access |
|---|---|---|
| **Owner app** (owner + admins) | Aak, ops | Everything. TOTP mandatory; step-up 2FA for keys, LIVE mode, policy changes, payouts |
| **Investor app** (web + mobile) | Investors | Read-only: their accounts, progress, portfolio analysis, payout splits, trade log, AI outlook, documents |
| Telegram | Subscribers | Bot-managed channel/group; no app login |

## 2. Owner app modules
1. **Command Center** — own vs investor equity, today P&L, open risk, A+ caps, copilot states, sessions ET/UTC/IST (DST-correct), AI feed, news blocks, accounts strip
2. **Live Copilot** — chart (Lightweight Charts) with engine overlays, 7-box A+ gate, state timeline, AI stream, ticket routed to master / selected / all copy routes
3. **Setups & Intel**, **AI Bias Report** — unchanged from v1
4. **Orders & Risk Calculator** — XAUUSD / BTC perp / MCX sizing, fees in R, isolated liquidation; per-account fan-out preview
5. **Copy Engine** — pipeline: signal → AI pre-trade guard → per-account sizing → venue routing → fill & reconcile → publish (journal, investor app, Telegram). Latency per account (p50/p95), slippage in R, reconciler drift, routing map, global/route/account kill switches. The guard checks daily room, max DD, news window, min size, firm rule; it can block or shrink, never enlarge.
6. **Accounts** — types: Master, Sub, Eval, Demo, Investor-assigned; sizing mode, max size, daily stop, symbol map, fee %, agreement status
7. **Risk Manager**, **Funded Challenges** — limits on live equity (demo excluded), master and per account; firm-specific loss maths
8. **Investors** — lifecycle (agreement & KYC → payment → purchase → evaluation → funded → payout), investor table, **prop purchase ledger**
9. **Subscriptions / Telegram** — MRR, paid members, churn, expiring, member sources (Instagram bio/reels, free group, referral, direct) with clicks → joins → paid, 7-day channel activity, post engagement, plans, tracked links, member list
10. **Signal Broadcast** — Telegram bot posting, per-instrument publish rules, post log
11. **Payouts & Audit** — payout approvals, copy policy matrix, system health, audit log
12. **Analytics, Journal, Discipline & Mood, News, Connections, Alerts, Settings** — as v1

## 3. Investor app
- **Overview & payouts** — paid lifetime, fees, current value; waterfall per account (managed: gain → recovery below HWM → profit above HWM → 20% fee → to investor; prop: profit → firm split → firm payout → 20% commission → to investor)
- **My accounts** — stage, balance, profit this cycle, daily/overall loss room, target progress, purchases
- **Insights & AI outlook** — value curve, win rate / avg R / drawdown, weekly AI outlook (educational), full trade log
- Mobile: overview + accounts screens

## 4. Verified maths
- Break-even win rate 1/(1+R); expectancy W·R − (1−W); with cost c: W(R−c) − (1−W)(1+c)
- XAUUSD lots = risk ÷ (stop distance ÷ tick × tick value), floor to step; linear perp qty = risk ÷ |entry − stop|; isolated liq LP = (WB + cum − s·q·E) ÷ (q·MMR − s·q)
- Net R on a winner uses exit fees at TP (e.g. BTC short 68,920 → 67,765, stop 69,250: +3.29R net, not 3.31R)
- Investor prop payout: investor = profit × firm split × (1 − 0.20); managed: fee = 0.20 × max(0, NAV − HWM)
- Subscription MRR = Σ price ÷ months × active; churn = churned ÷ (start + new)

## 5. Phasing
1. Engine, charts, journal, analytics, owner app shell, auth + 2FA, paper/testnet
2. Live execution + Copy Engine on own accounts (Delta, Binance, cTrader), risk manager, reconciler, audit
3. Investor app, investor lifecycle & purchases, payouts ledger (after legal review); Telegram bot + subscriptions

## 6. Stack
Next.js on Vercel · Supabase (Postgres + RLS by role, Auth + TOTP, Realtime, Vault) · always-on copy/engine worker (Tokyo for crypto, London for cTrader/MT5, Mumbai static IP for Indian brokers) · queue + idempotent client order IDs · LLM for narrative only.

## 7. Open items
FundedIN firm identity · real Telegram plan prices · data/news vendors · legal opinion on investor model · per-firm confirmation of copy rules

## 8. Edge v1.1 — refined from the Trade Finder Pro master guide
- **Method:** direction (HTF) → location (fresh POI in the correct half) → execution (liquidity sweep + 5M body-close shift, in London Q / NY Q, news clear, ≥3R to a real target, structural stop).
- **Gate:** 7 boxes. HTF vs 15M disagreement = *wait* (not fail). Price outside the HTF dealing range = fail (structure breaking). Grade **A** = exactly one soft miss (no liquidity story, POI didn't break structure, quality concern, or non-A+ model) → base risk or skip. Two soft misses = no trade.
- **Automatic no-trade:** daily cap hit, emotional, volatile/illiquid, shift ran away without pullback, random stop, mid-range, outside window, news window.
- **Entry models:** A market shift → pullback (default) · B flip zone · C sweep → OB → FVG · D institutional precision (first tap swept) · E gold sweep (aggressive only if enabled, capped at A) · F Asia sweep (London window) · G counter-trend scalp (advanced, never A+) · H sniper/fractal (advanced, never A+) · I post-news (waits 30 min).
- **Daily bias (5 steps):** HTF range → premium/discount → liquidity & magnet (PDH/PDL/EQH/EQL) → narrative → target + invalidation ("bias is wrong if price closes and holds beyond …"). No invalidation = no bias.
- **Risk:** 0.5% base; A+ 1% only after 100 proven trades; daily loss cap 2%; challenge daily profit cap 1%; drawdown pause 8%; personal prop limits = half the firm's; equity throttle halves risk >3% below peak; prop buffer: one stop ≤ 50% of remaining daily room.
- **Review:** compliance %, risk deviation, rule of 100 (change rules after 100 trades or 3 months, never before 30), if-then diagnosis.

## 9. Build status (25 Oct 2026)
- **Repo** `akhilmonanilkumar/aplus-tradeplay` — pnpm monorepo: `packages/engine` (63 tests), `apps/web` (Next.js 16), `supabase/migrations`.
- **Design** — every App Design board rebuilt as a working screen (owner: Command, Copilot, Setups, Bias, Orders, Copy Engine, Accounts, Risk, Funded Challenges, Connections, Investors, Subscriptions, Broadcast, Payouts & Audit, Analytics, Journal, Discipline & Mood, News, Alerts, Settings; investor: Overview, My accounts, Insights, Trade log). Branding only from the A+ journal: gold accent, A+ mark, Geist fonts, soft radii, pill buttons; 4 accents × light/dark.
- **Copilot chart** — Lightweight Charts with engine overlays; BTCUSDT.P = Binance mark price, gold = PAXG/USDT proxy (labelled) with a TradingView OANDA:XAUUSD tab.
- **Supabase** — project `siuolrkuljeopkefvjhp`; staff need aal2 (TOTP); LIVE mode and payout approval need a fresh code; venue keys go to Supabase Vault (never withdrawal).
- **Deploy** — Vercel project `aplus-tradeplay` (root `apps/web`, region bom1) replaces the journal on tradeplay.cloud.
- **Env still to add on Vercel** — `SUPABASE_SERVICE_ROLE_KEY` (invites, TradingView webhook), `ANTHROPIC_API_KEY` (copilot agent answers).
- **Not yet built** — execution worker (venue adapters, fills, reconciler), Telegram bot, calendar/news API feed, licensed XAUUSD feed.

## 10. v3 — internal desk (26 Oct 2026)
Scope change from the owner: the platform is now the firm's own tool (team trades, manages own and investor accounts); SaaS, subscriptions, copy trading and connections are parked for a later release. No Indian markets.

- **Instruments:** XAUUSD CFD, XAUUSDT.P, BTCUSD CFD, BTCUSDT.P, BTCUSD spot — one registry (`packages/engine/src/instruments.ts`) with timeframes, stop buffers, minimum stop, cost model and sizing per instrument.
- **Navigation:** Dashboard · Gold desk · BTC desk · Gold lab · BTC lab · Autopilot · Accounts · Investors · P&L analytics · Risk · Funded challenges · Journal · Daily bias · Discipline · Telegram alerts · Payouts & audit · Settings. Retired routes redirect.
- **Desks** (replace Live Copilot): engine chart (closed-candle overlays + forming bar from live ticks) and TradingView tab, A+ gate, trade timeline, order & risk per account (owner-tagged), confluence score, derivatives positioning (funding, OI with ΔOI × price regime over 1h/4h/24h/7d, L/S, taker flow, basis, cross-venue OI, live liquidations), DXY / yields / cross-asset correlations (+ real yields, COT for gold), session analysis, news with AI read, economic calendar with ±15 min blocks, AI desk analyst.
- **Labs:** walk-forward backtest per pair in a web worker (no look-ahead, stop-before-target, costs in R), strategy save/load, run history, rejection breakdown, "use for autopilot".
- **Autopilot:** per instrument Off / Alerts / Paper / Confirm / Auto; server pass every 5 min via `/api/autopilot/tick`; state changes logged; Telegram on chosen events; paper orders filled and closed on live candles. Auto acts as Confirm until venue adapters ship.
- **Accounts & investors:** owner tag (Own / investor), instruments per account, cash-flow ledger, automatic balance snapshots → growth curves for staff and investors; money P&L analytics by owner, account, pair, session, weekday, hour, side, model.
- **Telegram:** send-only, every message logged (`telegram_alerts`).
- **AI:** OpenRouter gateway, model configurable; narrative only.
- **Not yet built:** live venue execution adapters (Binance, Delta, cTrader/MT5), historical economic calendar for backtests, licensed tick feed for spot gold beyond OANDA.

## 11. Best-opportunity selector (26 Oct 2026)

- **What it does:** each autopilot pass evaluates every instrument in its universe, keeps only setups the A+ gate passes (grade A optional), scores them 0–100 and sends the best trade per underlying (gold, BTC) to Telegram as one trade ticket with size per account. Engine: `packages/engine/src/selector.ts`; server: `apps/web/lib/server/selector.ts`.
- **Score:** gate quality 40 (A+ 40, A 28) · R:R 15 (2R→0, 5R→full) · confluence 20 (dollar, yields, NQ, funding, OI regime, taker flow, top-trader L/S, COT; −100…+100 mapped linearly) · recent edge 15 · timing 10 (London/NY killzone 10, other window 5) · −4 per caution flag (max −12).
- **Recent edge:** the same walk-forward backtester run on the last 21 days per instrument, refreshed about daily (one instrument per pass), stored in `backtests` with `strategy_id` null and `summary.kind = 'edge'`. Few trades shrink the edge to neutral; a proven negative edge (≥ 8 trades, < −0.25R) rejects the instrument.
- **Hard rejects:** gate not GO, confluence ≤ −40, negative proven edge, score below the minimum.
- **Exposure rules:** one pick per desk; a desk is busy while a selector order is pending or a selector trade is open, and for the cooldown after a pick; daily cap per IST day.
- **Tracking:** with paper tracking on, each pick queues paper orders on the chosen accounts; fills and closes go to Telegram and into P&L analytics.
- **Execution layer:** `apps/web/lib/server/execution.ts` defines `TradeTicket` and `Executor`. Telegram is the only destination today; broker/prop-firm API or webhook adapters implement `Executor` and receive the same ticket.
- **Preview:** `/api/autopilot/tick?preview=selector` (staff or `AUTOPILOT_SECRET`) and the Preview button score the board without acting.
- **Settings:** `app_settings.integrations.selector` (no schema change), edited on the Autopilot page.
