#!/usr/bin/env bash
# Read-only: blog rows in non-clean states (published-noindexed, drafts,
# needs-attention) + the tail of the newest async regen log if one exists.
# No writes, no restarts.
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
envval() { { grep -E "^$1=" "$repo_dir/.env" || true; } | head -1 | cut -d= -f2-; }
ssh_key="$(envval AIWEBSITE_SSH_KEY)"; ssh_key="${ssh_key:-~/.ssh/id_ed25519}"; ssh_key="${ssh_key/#\~/$HOME}"
ssh -i "$ssh_key" -o StrictHostKeyChecking=accept-new "$(envval AIWEBSITE_USER)@$(envval AIWEBSITE_SSH_IP)" "
  set -e
  cd /var/www/aiwebsite
  DB=\"\$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2-)\"
  echo '== published-noindexed + draft rows =='
  psql \"\$DB\" -tAc \"SELECT slug || ' | ' || status || ' | noindex=' || noindex || ' | gate_passed=' || coalesce(gate_passed::text,'null') || ' | updated=' || to_char(updated_at,'HH24:MI') FROM blog_posts WHERE (status='published' AND noindex) OR status='draft' ORDER BY updated_at DESC\"
  echo '== advisory lock holders (blog) =='
  psql \"\$DB\" -tAc \"SELECT count(*) FROM pg_locks WHERE locktype='advisory'\"
  log=\"\$(ls -t /tmp/regen-noindexed-*.log 2>/dev/null | head -1 || true)\"
  if [ -n \"\$log\" ]; then
    echo \"== newest async regen log: \$log ==\"
    if [ -f \"\$log.done\" ]; then echo '(RUN COMPLETE)'; else echo '(run in progress)'; fi
    tail -25 \"\$log\"
  else
    echo '== no async regen log =='
  fi
"
