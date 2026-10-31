# Delta relay

Delta Exchange only accepts trading API calls from whitelisted IPs, and the platform runs on Vercel
without a fixed IP. This relay runs on a small fixed-IP server (Mumbai), keeps the Delta keys, and
forwards only signed requests from the platform to the endpoints the platform uses.

1. Server with a static IP (Lightsail / DigitalOcean / Oracle free tier), Node 20+.
2. Whitelist that IP on the Delta API key (Read + Trading).
3. Run `node server.mjs` with `DELTA_TESTNET_API_KEY`, `DELTA_TESTNET_API_SECRET` (and production keys
   later) and a long random `DELTA_RELAY_SECRET`; put HTTPS in front (Caddy: `reverse_proxy :8787`).
4. In Vercel set `DELTA_RELAY_URL=https://your-relay-host` and the same `DELTA_RELAY_SECRET`, and remove
   the Delta keys from Vercel.

`GET /health` answers `{ ok: true }`.
