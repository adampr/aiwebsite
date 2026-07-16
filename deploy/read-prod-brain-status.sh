#!/usr/bin/env bash
# Read-only prod diagnostic: brain-api status after config:check failures
# (read-prod-*.sh precedent; deploy transport).
set -euo pipefail
cd "$(dirname "$0")/.."
IP=$(grep '^AIWEBSITE_SSH_IP=' .env | cut -d= -f2)
U=$(grep '^AIWEBSITE_USER=' .env | cut -d= -f2)
K=$(grep '^AIWEBSITE_SSH_KEY=' .env | cut -d= -f2)
K="${K/#\~/$HOME}"
ssh -i "$K" -o StrictHostKeyChecking=accept-new "$U@$IP" bash -s <<'REMOTE'
set -u
echo "=== pm2 ==="
pm2 ls || sudo -u xladmin pm2 ls || true
echo "=== brain health (loopback) ==="
curl -s -m 5 http://127.0.0.1:3211/health || echo UNREACHABLE
echo
echo "=== brain-api last log lines ==="
pm2 logs brain-api --lines 25 --nostream 2>/dev/null | tail -30 || true
echo "=== deploy marker / locks ==="
ls -la /var/run/aiwebsite-deploy* 2>/dev/null || echo "no markers"
echo "=== recent watchdog log ==="
tail -8 /var/log/aiwebsite-watchdog.log 2>/dev/null || true
REMOTE
