#!/usr/bin/env bash
# Post-deploy verification for the AI Governance feature (ARCHITECTURE.md §13)
# + one-time standards bootstrap kick. Read-only except `systemctl start` of
# the governance service (which the daily timer would run at 04:30 UTC anyway;
# starting it now just closes the bootstrap window early). Runs from the dev
# box using the same transport as deploy.sh (read-prod-*.sh precedent).

set -euo pipefail
cd "$(dirname "$0")/.."

IP=$(grep '^AIWEBSITE_SSH_IP=' .env | cut -d= -f2)
U=$(grep '^AIWEBSITE_USER=' .env | cut -d= -f2)
K=$(grep '^AIWEBSITE_SSH_KEY=' .env | cut -d= -f2)
K="${K/#\~/$HOME}"

ssh -i "$K" -o StrictHostKeyChecking=accept-new "$U@$IP" bash -s <<'REMOTE'
set -u
echo "=== timers (expect aiwebsite-governance among 8) ==="
systemctl list-timers 'aiwebsite-*' --no-pager --all | sed -n '1,12p'
echo
echo "=== governance unit wiring ==="
systemctl cat aiwebsite-governance.service 2>/dev/null | grep -E 'ExecStart|OnFailure|max-old-space' || echo "MISSING UNIT"
echo
echo "=== governance tables present ==="
sudo -u postgres psql aiwebsite -tAc "select to_regclass('public.governance_projects') is not null, to_regclass('public.governance_usage') is not null, to_regclass('public.governance_meta') is not null"
echo
echo "=== logs pre-touched ==="
ls -la /var/log/aiwebsite-governance.log /var/log/aiwebsite-governance-research.log 2>&1
echo
echo "=== kicking standards bootstrap (also fires daily 04:30 UTC) ==="
sudo systemctl start --no-block aiwebsite-governance.service && echo "started (follow: tail -f /var/log/aiwebsite-governance.log)"
REMOTE
