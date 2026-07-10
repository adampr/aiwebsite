#!/usr/bin/env bash
# Read-only incident diagnosis round 2: watchdog behavior, uptimes, nginx chat
# statuses, migration state, build integrity, model overrides.
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
envval() { grep -E "^$1=" "$repo_dir/.env" | head -1 | cut -d= -f2-; }
export SSHPASS="$(envval AIWEBSITE_PW)"
sshpass -e ssh -o StrictHostKeyChecking=accept-new "$(envval AIWEBSITE_USER)@$(envval AIWEBSITE_SSH_IP)" '
  echo "== pm2 uptimes =="
  pm2 jlist 2>/dev/null | python3 -c "
import json,sys,time
for p in json.load(sys.stdin):
    up=(time.time()*1000-p[\"pm2_env\"].get(\"pm_uptime\",0))/1000
    print(p[\"name\"], p[\"pm2_env\"][\"status\"], f\"up {up/60:.1f}m\", \"restarts\", p[\"pm2_env\"][\"restart_time\"])"
  echo "== watchdog log tail =="
  sudo tail -25 /var/log/aiwebsite-watchdog.log 2>/dev/null
  echo "== nginx: last chat POSTs =="
  sudo grep "POST /api/tron-netter/chat" /var/log/nginx/aiwebsite.access.log 2>/dev/null | tail -12 | awk "{print \$4, \$9, \$10}"
  echo "== migrations journal vs tables =="
  sudo -u postgres psql -d aiwebsite -tAc "select count(*) from drizzle.__drizzle_migrations" 2>/dev/null || sudo -u postgres psql -d aiwebsite -tAc "select count(*) from __drizzle_migrations" 2>/dev/null
  sudo -u postgres psql -d aiwebsite -tAc "select to_regclass('"'"'public.sms_memory_notices'"'"'), to_regclass('"'"'public.memory_deletion_logs'"'"')"
  echo "== build integrity =="
  ls /var/www/aiwebsite/.next/BUILD_ID && cat /var/www/aiwebsite/.next/BUILD_ID
  ls /var/www/aiwebsite/.next/server/app/sms-terms* 2>/dev/null | head -3
  echo "== model overrides in VM .env =="
  grep -nE "luna|MODEL" /var/www/aiwebsite/.env | sed "s/=.*KEY.*/=<redacted>/" | head -8
'
