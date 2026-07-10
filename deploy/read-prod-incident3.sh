#!/usr/bin/env bash
# Read-only incident diagnosis round 3: the user's actual failing chat
# requests — nginx statuses, app-side failures, brain turn errors, recent
# brain_messages rows.
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
envval() { grep -E "^$1=" "$repo_dir/.env" | head -1 | cut -d= -f2-; }
export SSHPASS="$(envval AIWEBSITE_PW)"
sshpass -e ssh -o StrictHostKeyChecking=accept-new "$(envval AIWEBSITE_USER)@$(envval AIWEBSITE_SSH_IP)" '
  echo "== nginx: ALL /api/tron-netter/chat POSTs, last 25 =="
  sudo awk "\$7 ~ /tron-netter\/chat/ && \$6 ~ /POST/" /var/log/nginx/aiwebsite.access.log 2>/dev/null | tail -25 | awk "{print \$4, \$9, \"bytes:\"\$10, \"ua:\"\$14}"
  echo "== nginx: any non-200 site-wide, last 15 =="
  sudo awk "\$9 !~ /^(200|301|302|304|307|101)$/" /var/log/nginx/aiwebsite.access.log 2>/dev/null | tail -15 | awk "{print \$4, \$6, \$7, \$9}"
  echo "== app structured failures, last 800 lines =="
  pm2 logs aiwebsite --lines 800 --nostream 2>/dev/null | grep "\"ok\":false" | tail -15
  echo "== app raw errors, last 800 lines =="
  pm2 logs aiwebsite --lines 800 --nostream 2>/dev/null | grep -iE "unhandled|Error:|500" | grep -v "\"ok\"" | tail -10
  echo "== brain chat.turn events, last 20 =="
  pm2 logs brain-api --lines 600 --nostream 2>/dev/null | grep "chat.turn" | tail -20
  echo "== recent chat brain_messages =="
  sudo -u postgres psql -d aiwebsite -tAc "select left(session_id,28), left(created_at,19), role, left(regexp_replace(content, chr(10), '"'"' '"'"', '"'"'g'"'"'),60) from brain_messages where session_id like '"'"'tron_%'"'"' order by created_at desc limit 12"
'
