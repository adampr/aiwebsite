#!/usr/bin/env bash
# Read-only: is logrotate healthy on the prod VM, and is there a second
# fragment for the watchdog logs beside the deploy-written
# /etc/logrotate.d/aiwebsite? (2026-10-21: itsupportchicago carried a June
# one-off /etc/logrotate.d/itsupportchicago-watchdog that duplicated the
# deploy's /var/log/<slug>-*.log stanza, so logrotate.service failed every
# night.) Fixed command set, no arguments; no writes, no restarts.
# Same transport as the other read-prod-*.sh probes (host/user/key from .env).
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
envval() { { grep -E "^$1=" "$repo_dir/.env" || true; } | head -1 | cut -d= -f2-; }
ssh_key="$(envval AIWEBSITE_SSH_KEY)"; ssh_key="${ssh_key:-~/.ssh/id_ed25519}"; ssh_key="${ssh_key/#\~/$HOME}"
ssh -i "$ssh_key" -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=25 \
  "$(envval AIWEBSITE_USER)@$(envval AIWEBSITE_SSH_IP)" bash -s <<'REMOTE'
set -u
echo "== host time =="; date
echo "== systemctl status logrotate.service =="
systemctl status logrotate.service --no-pager 2>&1 || true
echo "== ls -la /etc/logrotate.d/ =="
ls -la /etc/logrotate.d/
echo "== fragments naming 'watchdog' (grep -l) =="
grep -l watchdog /etc/logrotate.d/* 2>/dev/null || echo "(none)"
echo "== logrotate -d: count of 'error:' lines =="
sudo -n logrotate -d /etc/logrotate.conf 2>&1 | grep -c 'error:' || true
REMOTE
