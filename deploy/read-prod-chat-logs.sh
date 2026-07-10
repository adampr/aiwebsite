#!/usr/bin/env bash
# Read-only incident diagnosis: which commit prod runs + the §5.12 structured
# failure lines for the chat channel. No writes, no restarts.
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
envval() { grep -E "^$1=" "$repo_dir/.env" | head -1 | cut -d= -f2-; }
export SSHPASS="$(envval AIWEBSITE_PW)"
sshpass -e ssh -o StrictHostKeyChecking=accept-new "$(envval AIWEBSITE_USER)@$(envval AIWEBSITE_SSH_IP)" '
  set -e
  echo "== deployed tree (git absent on VM → check file mtime + marker) =="
  ls -la /var/www/aiwebsite/site.config.ts | awk "{print \$6,\$7,\$8}"
  grep -c requesterName /var/www/aiwebsite/packages/aicompany/src/memory/identity.ts || true
  echo "== pm2 status =="
  pm2 jlist 2>/dev/null | python3 -c "import json,sys; [print(p[\"name\"], p[\"pm2_env\"][\"status\"], \"restarts:\", p[\"pm2_env\"][\"restart_time\"]) for p in json.load(sys.stdin)]" 2>/dev/null || pm2 ls
  echo "== chat failures (structured logs, last 300 lines) =="
  pm2 logs aiwebsite --lines 300 --nostream 2>/dev/null | grep -E "\"ok\":false|\"channel\":\"chat\"" | tail -20
  echo "== app errors =="
  pm2 logs aiwebsite --lines 300 --nostream 2>/dev/null | grep -iE "error|exception" | grep -v "\"ok\":true" | tail -12
  echo "== brain-api errors =="
  pm2 logs brain-api --lines 200 --nostream 2>/dev/null | grep -iE "error|400|reject" | tail -12
'
