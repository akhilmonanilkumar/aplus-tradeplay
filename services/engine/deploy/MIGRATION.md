# Moving the dashboard from Vercel to the droplet

After this the droplet runs everything: the dashboard (`web`), the engine, TimescaleDB, and Caddy for HTTPS.
Supabase (database, logins, scheduled passes) stays where it is. The domain keeps the same addresses, so
the logins, the Fyers / cTrader / Telegram links and the scheduled passes need no changes.

Run the commands on the droplet as the user that owns `~/aplus-tradeplay`.

## 1. Swap (once)

The dashboard build needs headroom next to TimescaleDB on a 4 GB droplet.

```bash
swapon --show | grep -q swapfile || { fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab; }
```

## 2. The dashboard's settings (`web.env`)

Copy the production environment variables from Vercel into `services/engine/deploy/web.env`, without
pasting them anywhere else. Either with the Vercel CLI:

```bash
cd ~/aplus-tradeplay/services/engine/deploy
npx --yes vercel@latest login
npx --yes vercel@latest link --yes --project aplus-tradeplay
npx --yes vercel@latest env pull web.env --environment=production
sed -i '/^VERCEL/d' web.env && chmod 600 web.env && rm -rf .vercel
```

or by hand from Vercel → aplus-tradeplay → Settings → Environment Variables (keys as in
`apps/web/.env.example`). Check that `APP_URL=https://www.tradeplay.cloud`. `ENGINE_URL` is set by the
compose file to the engine inside the droplet, so its value here does not matter; `ENGINE_SECRET` must be
the same as in `.env`.

## 3. Build and start

```bash
cd ~/aplus-tradeplay && git checkout main && bash services/engine/deploy/deploy.sh
```

The first build takes 5–10 minutes. It ends with `Engine: ok …` and `Dashboard: HTTP 200`. Until the DNS
moves, Caddy logs certificate errors for the dashboard domains; they stop once DNS points here.

## 4. Move DNS to DigitalOcean

1. DigitalOcean → Networking → Domains → add `tradeplay.cloud`, with three A records to the droplet's IP:
   `@`, `www` and `engine`.
2. Vercel → Domains → `tradeplay.cloud` → Nameservers → set `ns1.digitalocean.com`,
   `ns2.digitalocean.com`, `ns3.digitalocean.com`.

The change takes from a few minutes to a few hours. Caddy then gets the certificates by itself.

## 5. Check

- https://www.tradeplay.cloud loads and you can sign in; https://tradeplay.cloud redirects to it.
- The CFD desk updates every 5 seconds.
- The scheduled passes keep answering: Settings / League show fresh times within 15 minutes (Supabase
  records each call's status in `net._http_response`).

## 6. After a week without problems

- Remove the project from Vercel (Settings → Advanced → Delete project), or at least disconnect Git.
- The domain itself is still registered through Vercel. It can be transferred to another registrar
  (DigitalOcean does not sell domains; Cloudflare or Namecheap do) 60 days after purchase, i.e. from
  early December 2026. Until then Vercel only renews it once a year.

## Updates

`deploy.sh` again, or set `DEPLOY_HOST`, `DEPLOY_USER` and `DEPLOY_SSH_KEY` as GitHub repository secrets
and every merge to main deploys itself once CI passes (`.github/workflows/deploy.yml`).

Logs: `cd ~/aplus-tradeplay/services/engine/deploy && docker compose logs -f web` (or `engine`, `caddy`).
Rollback: `git checkout <previous commit> && bash services/engine/deploy/deploy.sh`.
