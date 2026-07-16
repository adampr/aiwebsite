#!/usr/bin/env bash
# Read-only governance budget diagnosis: today's usage ledger vs the caps the
# running process actually sees, active overrides, queued projects, and the
# deploy mutex marker (a fresh marker parks every research kick as "queued").
# No writes, no restarts.
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
envval() { { grep -E "^$1=" "$repo_dir/.env" || true; } | head -1 | cut -d= -f2-; }
ssh_key="$(envval AIWEBSITE_SSH_KEY)"; ssh_key="${ssh_key:-~/.ssh/id_ed25519}"; ssh_key="${ssh_key/#\~/$HOME}"
ssh -i "$ssh_key" -o StrictHostKeyChecking=accept-new "$(envval AIWEBSITE_USER)@$(envval AIWEBSITE_SSH_IP)" '
  set -e
  cd /var/www/aiwebsite
  echo "== deploy marker (fresh <30min ⇒ research kicks park as queued) =="
  ls -la /var/run/aiwebsite-deploy-in-progress 2>/dev/null || echo "absent (good)"
  date -u
  echo "== .env caps on disk =="
  grep -E "^GOVERNANCE_(TAVILY|BRAIN)_DAILY_CAP=" .env || echo "unset (code defaults 300/1500)"
  echo "== caps in the RUNNING pm2 process env =="
  pm2 env 0 2>/dev/null | grep -E "GOVERNANCE_(TAVILY|BRAIN)_DAILY_CAP" || echo "not in pm2 env (app reads .env at boot via dotenv)"
  DB="$(grep -E "^DATABASE_URL=" .env | head -1 | cut -d= -f2-)"
  echo "== governance_usage (last 3 days) =="
  psql "$DB" -tAc "SELECT day, tavily_calls, brain_calls, research_runs FROM governance_usage ORDER BY day DESC LIMIT 3"
  echo "== budget overrides in governance_meta =="
  psql "$DB" -tAc "SELECT key, value FROM governance_meta WHERE key LIKE '\''budget_override_%'\''" || true
  echo "== projects by status =="
  psql "$DB" -tAc "SELECT status, count(*) FROM governance_projects GROUP BY status ORDER BY status"
  echo "== queued/failed projects (newest first) =="
  psql "$DB" -tAc "SELECT id, status, created_at, updated_at FROM governance_projects WHERE status IN ('\''queued'\'','\''research_failed'\'','\''created'\'') ORDER BY updated_at DESC LIMIT 10"
'
