# Engine host

The always-on half of A+ Tradeplay. It runs on one small DigitalOcean droplet with a fixed IP and does
what Vercel functions cannot:

- **Venue adapters**: Delta Exchange India, CoinSwitch PRO (HFT API) and Fyers. Trading keys live only here.
- **Clock sync per venue**: offset and round trip measured every 30–60 s. Orders are refused when the
  clock is out of budget (Delta 1.5 s, because it rejects signatures older than 5 s; CoinSwitch 1 s; Fyers 2 s).
- **Market streams**: Delta's public socket (order book with sequence checks, trades, ticker), REST
  polling while the socket is down, CoinSwitch book and ticker, Fyers quotes and depth in market hours.
- **Tick store**: every trade into TimescaleDB, compressed after 2 days, kept 180 days, with 1-second bars.
- **Signed API** for the web app: `/status`, `/flow`, and allow-listed trading routes per venue.
- Replaces `services/delta-relay`; the old relay request format still works, so `DELTA_RELAY_URL` can point here.

Nothing trades unless that venue's `*_EXECUTION=on` is set, the endpoint is on the allowlist, and the clock is healthy.

## API

Every request except `/health` carries `x-engine-ts` (ms) and
`x-engine-sig = HMAC-SHA256(ENGINE_SECRET, ts + METHOD + path?query + body)` (hex), valid for 30 s.

| Route | What |
|---|---|
| `GET /health` | `{ ok, uptimeSec }`, no auth |
| `GET /status` | venues (keys, execution switch, clock offset, p95 round trip, stream state), tick store, markets |
| `GET /flow?venue=delta&symbol=BTCUSD&bucket=300000&tick=10&bars=12&depth=0.01` | book with stats and walls, footprint bars with imbalances, cumulative delta, large trades, OI history |
| `POST /delta` | `{ method, path, query, body }` signed to Delta (`DELTA_ENV`) |
| `POST /coinswitch` | `{ method, path, params, body }` signed to the HFT API |
| `GET /fyers/login-url`, `POST /fyers/token { code }` | daily Fyers login |
| `POST /fyers` | `{ method, path, body }`; orders are checked against the daily F&O symbol master and lot size |

## Set up the droplet (about 20 minutes)

1. **Create the droplet.** DigitalOcean → Create → Droplets: region **Bangalore (BLR1)** (DigitalOcean
   has no Mumbai region; BLR1 is about 15–20 ms away), Ubuntu 24.04, Basic **2 GB / 1 vCPU** (about
   $12/month), add your SSH key, enable weekly backups. Paste `deploy/cloud-init.yaml` into *User data*.
2. **Add a block volume** of 50 GB (about $5/month) to the droplet and mount it at `/mnt/ticks`
   (Volumes → attach, then on the droplet: `mount -o discard,defaults /dev/disk/by-id/scsi-0DO_Volume_* /mnt/ticks`
   and add the same line to `/etc/fstab`).
3. **Note the droplet's public IPv4.** It stays the same for the droplet's lifetime. Whitelist it on:
   the Delta API key (Read + Trading), the CoinSwitch API key, and the new Fyers API app (SEBI static IP).
   Do not destroy the droplet without re-whitelisting a new IP.
4. **Point a domain at it**: an A record such as `engine.yourdomain.com` → the IP.
5. **Get the code onto the droplet** with a read-only GitHub deploy key:
   `ssh-keygen -t ed25519` on the droplet, add the public key under the repository's Settings → Deploy keys,
   then `git clone git@github.com:akhilmonanilkumar/aplus-tradeplay.git && cd aplus-tradeplay`.
6. **Configure**: `cp services/engine/deploy/.env.example services/engine/deploy/.env && chmod 600 services/engine/deploy/.env`,
   then fill it in (generate secrets with `openssl rand -hex 32`).
7. **Start**: `services/engine/deploy/deploy.sh`. Caddy fetches the HTTPS certificate on first start.
8. **Connect the web app**: in Vercel set `ENGINE_URL=https://engine.yourdomain.com` and the same `ENGINE_SECRET`;
   optionally `DELTA_RELAY_URL` to the same URL with `DELTA_RELAY_SECRET=$ENGINE_SECRET`, then remove the
   Delta keys from Vercel. The Integrations page shows the host, its IP and each venue's clock.

Updates: run `services/engine/deploy/deploy.sh` again. Logs: `cd services/engine/deploy && docker compose logs -f engine`.

## Develop

```
pnpm --filter @aplus/engine-host test
ENGINE_SECRET=dev pnpm --filter @aplus/engine-host build && ENGINE_SECRET=dev node services/engine/dist/index.js
```

Without `DATABASE_URL` trades stay in memory only (the last `MEMORY_MINUTES`, default 120).

## To verify on the first live connection

- Delta is migrating socket channels (`l2_updates` → `ob_updates`, `all_trades` → `trades`). The parser
  reads both; set `DELTA_WS_CHANNELS=ob_updates,trades,ticker` once the old names stop answering.
- CoinSwitch's `/v5/market/time` envelope `time` field is used as server time; confirm it is in ms.
- The Fyers clock comes from the HTTP `Date` header (1 s resolution), which is fine for scheduling.
  Fyers signs nothing with a timestamp.
