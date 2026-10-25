# A+ Tradeplay — Feature Spec v2.1
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

## 8. Build status (25 Oct 2026)
- **Repo** `akhilmonanilkumar/aplus-tradeplay` — pnpm monorepo: `packages/engine` (34 tests), `apps/web` (Next.js 16, React 19, Tailwind 4, Geist + Geist Mono), `supabase/migrations`.
- **Design** — the A+ TradePlay journal design system (soft bento, floating icon rail, gold accent, violet curves, light/dark/system via cookie). No descriptive filler text in the UI.
- **Supabase** — new project `siuolrkuljeopkefvjhp` (not the trade-journal project). Staff need an aal2 (TOTP) session; investors read only their own rows. The first user to sign in becomes owner (`claim_owner`).
- **Owner app routes** — / Command · /copilot · /calculator · /copy · /accounts · /investors · /payouts · /telegram · /trades · /analytics · /settings
- **Investor routes** — /me · /me/accounts · /me/trades. Investors are invited by email from Investors → Invite (needs `SUPABASE_SERVICE_ROLE_KEY` on Vercel).
- **Deploy** — new Vercel project `aplus-tradeplay` (root `apps/web`) replaces the journal on tradeplay.cloud. The old journal project is kept for rollback or a later subdomain.
- **Not yet built** — live venue execution worker, TradingView chart and webhooks, the Telegram bot, the AI bias/outlook, and the news feed.
