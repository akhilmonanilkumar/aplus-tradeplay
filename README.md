# A+ Tradeplay

Private, invite-only trade copilot and managed copy-trading platform.

- `packages/engine` — sizing (XAUUSD CFD, BTCUSDT.P perp, MCX Gold), A+ gate, sessions (NY-anchored, DST-safe), SMC structure, copy fan-out guard, fees (prop split, HWM), R statistics. `pnpm test`
- `apps/web` — Next.js 16 owner app and investor portal (Supabase auth + RLS, TOTP required for staff).
- `supabase/migrations` — schema, RLS, audit log, owner bootstrap.

## Env (`apps/web/.env.local`)

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=   # server only, for investor invites
APP_URL=https://tradeplay.cloud
```

## Run

```
pnpm install
pnpm test
pnpm dev
```

First signed-in user becomes owner (`claim_owner`). Investors are invited from Investors → Invite and land on `/me`.
