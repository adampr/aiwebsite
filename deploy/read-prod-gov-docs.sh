#!/usr/bin/env bash
# Read-only dump of the newest governance project's generated documents and
# format-sample text, for diagnosing drafting/formatting quality. No writes,
# no restarts. Optional arg: project id (defaults to newest updated).
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
envval() { { grep -E "^$1=" "$repo_dir/.env" || true; } | head -1 | cut -d= -f2-; }
ssh_key="$(envval AIWEBSITE_SSH_KEY)"; ssh_key="${ssh_key:-~/.ssh/id_ed25519}"; ssh_key="${ssh_key/#\~/$HOME}"
project_id="${1:-}"
ssh -i "$ssh_key" -o StrictHostKeyChecking=accept-new "$(envval AIWEBSITE_USER)@$(envval AIWEBSITE_SSH_IP)" "
  set -e
  cd /var/www/aiwebsite
  DB=\"\$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2-)\"
  echo '== projects (newest first) =='
  psql \"\$DB\" -tAc \"SELECT id, kind, domain, status, length(documents_json) AS docs_len, coalesce(style_sample_name,'-') AS sample, created_at FROM governance_projects ORDER BY updated_at DESC LIMIT 8\"
  id='${project_id}'
  if [ -z \"\$id\" ]; then
    id=\"\$(psql \"\$DB\" -tAc \"SELECT id FROM governance_projects WHERE length(documents_json) > 2 ORDER BY updated_at DESC LIMIT 1\")\"
  fi
  echo \"== documents_json of \$id (first 20000 chars) ==\"
  psql \"\$DB\" -tAc \"SELECT left(documents_json, 20000) FROM governance_projects WHERE id = '\$id'\"
  echo \"== style_sample_text of \$id (first 6000 chars) ==\"
  psql \"\$DB\" -tAc \"SELECT left(coalesce(style_sample_text,'(none)'), 6000) FROM governance_projects WHERE id = '\$id'\"
"
