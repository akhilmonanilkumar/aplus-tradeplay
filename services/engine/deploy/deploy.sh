#!/usr/bin/env bash
# Pull the latest code and restart the stack. Run on the droplet from the repository root.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
git pull --ff-only
cd services/engine/deploy
test -f .env || { echo "services/engine/deploy/.env is missing (copy .env.example)"; exit 1; }
docker compose up -d --build
docker compose ps
sleep 3
docker compose exec -T engine node -e "fetch('http://localhost:8787/health').then(r=>r.text()).then(t=>console.log('Health:',t)).catch(e=>console.log('Not answering yet:',e.message))"
