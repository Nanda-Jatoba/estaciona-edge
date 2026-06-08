#!/usr/bin/env bash
#
# Deploy server-side do EstacionaEDGE (rodado pelo deploy-bot, no próprio VPS).
# Espelha os passos do _ops/deploy_estacionaedge.py, mas a partir de um clone git
# local em vez de SFTP da máquina do dev.
#
#   1. git pull (reset --hard origin/main) no clone /opt/estacionaedge-src
#   2. rebuild de app/public/index.html a partir de frontend.html
#   3. sync -> /opt/estacionaedge:
#        - server.js  vem da RAIZ do repo (backend canônico, atualizado a cada feature)
#        - package.json/ecosystem.config.js/public vêm de app/
#   4. npm install --omit=dev + pm2 reload
#   5. health check
#
set -euo pipefail

SRC="${SRC:-/opt/estacionaedge-src}"
APP="$SRC/app"
DEST="${DEST:-/opt/estacionaedge}"

echo "== git pull =="
cd "$SRC"
git fetch --quiet origin main
git reset --hard origin/main
echo "commit: $(git rev-parse --short HEAD) — $(git log -1 --pretty=%s)"

echo "== build index.html =="
cd "$APP"
node build-html.mjs

echo "== sync -> $DEST =="
mkdir -p "$DEST/public"
cp -f "$SRC/server.js" "$DEST/server.js"          # backend canônico (raiz)
cp -f package.json ecosystem.config.js "$DEST"/   # de app/
cp -rf public/. "$DEST/public/"                   # index.html gerado + favicons

echo "== npm install =="
cd "$DEST"
npm install --omit=dev --no-audit --no-fund 2>&1 | tail -3

echo "== pm2 reload =="
pm2 reload estacionaedge --update-env
pm2 save --force >/dev/null

echo "== health =="
sleep 1
curl -fsS http://127.0.0.1:3100/api/health; echo
echo "DEPLOY OK"
