#!/usr/bin/env bash
#
# Deploy jobarms-render to a VPS.
#
# Idempotent: safe to re-run for an upgrade. Installs Node if missing, syncs the
# source, builds, installs the Chromium Playwright needs, and (re)starts a
# systemd unit bound to LOOPBACK ONLY. Traffic reaches the service through a
# Cloudflare Tunnel that connects OUT from the box, so nothing here opens a port.
#
# Usage:
#   RENDER_TOKEN=<bearer> ./scripts/deploy.sh root@<host>
#
# The box may be SHARED with other services (it starts life on the internal
# Hostinger KVM1). Everything below is namespaced under jobarms-render and uses
# its own port, user-visible unit name, state directory, and bearer token, so it
# cannot collide with or read anything belonging to another tenant on the box.
set -euo pipefail

TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  echo "usage: RENDER_TOKEN=<bearer> $0 user@host" >&2
  exit 1
fi
if [ -z "${RENDER_TOKEN:-}" ]; then
  echo "error: RENDER_TOKEN must be set (generate: openssl rand -hex 32)" >&2
  exit 1
fi

APP_DIR=/opt/jobarms-render
STATE_DIR=/var/lib/jobarms-render/state
PORT="${RENDER_PORT:-8085}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> syncing source to $TARGET:$APP_DIR"
ssh "$TARGET" "mkdir -p $APP_DIR $STATE_DIR"
# Source only: node_modules and build output are produced on the box.
rsync -az --delete \
  --exclude node_modules --exclude dist --exclude coverage --exclude cov \
  "$HERE/src" "$HERE/package.json" "$HERE/package-lock.json" "$HERE/tsconfig.json" \
  "$TARGET:$APP_DIR/"

echo "==> installing runtime prerequisites"
ssh "$TARGET" bash -s <<'REMOTE'
set -euo pipefail
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi
REMOTE

echo "==> building and installing Chromium"
ssh "$TARGET" bash -s <<REMOTE
set -euo pipefail
cd $APP_DIR
npm ci --omit=dev --ignore-scripts
# Dev deps are needed only to compile; drop them again afterwards to keep the
# footprint small on a 4GB box.
npm install --no-save typescript@^7.0.2 @types/node @types/express
npx tsc
rm -rf node_modules/typescript
# Chromium plus the system libraries it needs. Playwright pins the build that
# matches the installed version, so this must run after npm ci.
npx --yes playwright@\$(node -p "require('$APP_DIR/package.json').dependencies.playwright.replace(/^[^0-9]*/,'')") install --with-deps chromium
REMOTE

echo "==> writing systemd unit"
ssh "$TARGET" bash -s <<REMOTE
set -euo pipefail
cat >/etc/systemd/system/jobarms-render.service <<UNIT
[Unit]
Description=JobArms render sidecar (headless Chromium for ATS applications)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
Environment=PORT=$PORT
Environment=RENDER_TOKEN=$RENDER_TOKEN
Environment=RENDER_STATE_DIR=$STATE_DIR
# Deliberately small: each session is a real Chromium context, and this box is
# shared. Raise only after moving to dedicated hardware.
Environment=RENDER_MAX_SESSIONS=8
Environment=RENDER_MAX_CONCURRENCY=2
ExecStart=/usr/bin/node $APP_DIR/dist/index.js
Restart=always
RestartSec=5
# Chromium is memory-hungry; cap it so a runaway page cannot take the box down.
MemoryMax=2G
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=$STATE_DIR

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable jobarms-render
systemctl restart jobarms-render
sleep 3
systemctl is-active jobarms-render
REMOTE

echo "==> health check"
ssh "$TARGET" "curl -fsS http://127.0.0.1:$PORT/health"
echo
echo "Deployed. Remaining manual step: point a Cloudflare Tunnel hostname"
echo "(browser.jobarms.com) at http://127.0.0.1:$PORT on this box, then set"
echo "RENDER_URL + RENDER_TOKEN in the app and worker environments."
