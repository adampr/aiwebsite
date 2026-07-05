#!/usr/bin/env bash
#
# Deploy ai.xl.net from the dev box to the production VM.
#
#   bash deploy/deploy.sh
#
# Reads AIWEBSITE_SSH_IP / AIWEBSITE_USER / AIWEBSITE_PW from .env.
# Syncs the repo (incl. packages/brain submodule working tree), the
# production .env, and the pre-provisioned Cloudflare tunnel credentials,
# then runs deploy/setup-vm.sh on the VM.
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="/var/www/aiwebsite"
TUNNEL_CRED_LOCAL="${TUNNEL_CRED_LOCAL:-$HOME/.cloudflared/aiwebsite-tunnel.json}"

# Read values literally — do NOT `source` .env: passwords may contain
# shell-special characters ($, #, *) that expansion would mangle.
envval() { grep -E "^$1=" "$REPO_DIR/.env" | head -1 | cut -d= -f2-; }
AIWEBSITE_SSH_IP="$(envval AIWEBSITE_SSH_IP)"
AIWEBSITE_USER="$(envval AIWEBSITE_USER)"
AIWEBSITE_PW="$(envval AIWEBSITE_PW)"
: "${AIWEBSITE_SSH_IP:?set AIWEBSITE_SSH_IP in .env}"
: "${AIWEBSITE_USER:?set AIWEBSITE_USER in .env}"
: "${AIWEBSITE_PW:?set AIWEBSITE_PW in .env}"

export SSHPASS="$AIWEBSITE_PW"
SSH="sshpass -e ssh -o StrictHostKeyChecking=accept-new $AIWEBSITE_USER@$AIWEBSITE_SSH_IP"
HOST="$AIWEBSITE_USER@$AIWEBSITE_SSH_IP"

echo ">>> Preparing $APP_DIR on VM..."
$SSH "sudo mkdir -p $APP_DIR && sudo chown $AIWEBSITE_USER: $APP_DIR"

echo ">>> Syncing repo..."
sshpass -e rsync -az --delete \
  --exclude .git --exclude node_modules --exclude .next \
  --exclude packages/brain/node_modules \
  --exclude packages/brain/scripts/benchmark/cache \
  --exclude .env \
  "$REPO_DIR/" "$HOST:$APP_DIR/"

echo ">>> Copying production .env..."
sshpass -e rsync -az "$REPO_DIR/.env" "$HOST:$APP_DIR/.env"

if [ -f "$TUNNEL_CRED_LOCAL" ]; then
  echo ">>> Copying Cloudflare tunnel credentials..."
  sshpass -e rsync -az "$TUNNEL_CRED_LOCAL" "$HOST:/tmp/aiwebsite-tunnel.json"
  $SSH "sudo mkdir -p /etc/cloudflared && sudo mv /tmp/aiwebsite-tunnel.json /etc/cloudflared/aiwebsite-tunnel.json && sudo chmod 600 /etc/cloudflared/aiwebsite-tunnel.json"
else
  echo "NOTE: $TUNNEL_CRED_LOCAL not found — setup-cloudflared.sh will fall back to interactive login."
fi

echo ">>> Running setup-vm.sh on VM (this installs everything and starts services)..."
$SSH "cd $APP_DIR && bash deploy/setup-vm.sh"

echo ""
echo ">>> Verifying..."
$SSH "curl -fsS http://127.0.0.1:3000/api/health && echo && curl -fsS http://127.0.0.1:3211/health | head -c 300 && echo"
echo ""
echo "=== Deploy complete. Public check: curl -fsS https://ai.xl.net/api/health ==="
