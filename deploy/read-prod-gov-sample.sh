#!/usr/bin/env bash
# Read-only dump of one governance project's FULL extracted format-sample
# text plus row state, for diagnosing extraction artifacts that the 6000-char
# window in read-prod-gov-docs.sh cuts off. No writes, no restarts.
# Arg: project id (defaults to newest with a sample).
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
envval() { { grep -E "^$1=" "$repo_dir/.env" || true; } | head -1 | cut -d= -f2-; }
ssh_key="$(envval AIWEBSITE_SSH_KEY)"; ssh_key="${ssh_key:-~/.ssh/id_ed25519}"; ssh_key="${ssh_key/#\~/$HOME}"
project_id="${1:-}"
ssh -i "$ssh_key" -o StrictHostKeyChecking=accept-new "$(envval AIWEBSITE_USER)@$(envval AIWEBSITE_SSH_IP)" "
  set -e
  cd /var/www/aiwebsite
  DB=\"\$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2-)\"
  id='${project_id}'
  if [ -z \"\$id\" ]; then
    id=\"\$(psql \"\$DB\" -tAc \"SELECT id FROM governance_projects WHERE style_sample_text IS NOT NULL ORDER BY updated_at DESC LIMIT 1\")\"
  fi
  echo \"== row state of \$id ==\"
  psql \"\$DB\" -tAc \"SELECT rev, status, style_sample_name, style_sample_debt IS NOT NULL AS debt, turn_started_at, length(style_sample_text) AS sample_len, length(documents_json) AS docs_len, updated_at FROM governance_projects WHERE id = '\$id'\"
  echo \"== full style_sample_text of \$id ==\"
  psql \"\$DB\" -tAc \"SELECT style_sample_text FROM governance_projects WHERE id = '\$id'\"
"
