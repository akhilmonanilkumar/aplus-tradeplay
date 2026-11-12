#!/usr/bin/env bash
# Pull the latest code and restart the stack. Run on the droplet from the repository root.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
git pull --ff-only
cd services/engine/deploy
test -f .env || { echo "services/engine/deploy/.env is missing (copy .env.example)"; exit 1; }
test -f web.env || { echo "services/engine/deploy/web.env is missing (the dashboard's settings, see MIGRATION.md)"; exit 1; }
# Build first (the running stack keeps serving), then swap containers.
docker compose build
docker compose up -d
docker compose ps
sleep 5
docker compose exec -T engine node -e "fetch('http://localhost:8787/health').then(r=>r.text()).then(t=>console.log('Engine:',t)).catch(e=>console.log('Engine not answering yet:',e.message))"
docker compose exec -T web node -e "fetch('http://localhost:3000/login').then(r=>console.log('Dashboard: HTTP',r.status)).catch(e=>console.log('Dashboard not answering yet:',e.message))"
docker image prune -f >/dev/null
