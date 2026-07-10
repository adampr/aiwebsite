#!/usr/bin/env bash
# Incident fix (2026-07-10): multiple concurrent watchdog instances are
# restart-looping the PM2 services (pre-adoption watchdog + one per deploy —
# watchdog.sh never killed siblings). Kill them all, start exactly one, and
# apply migration 0005 (memory tables) that a stale drizzle journal skipped.
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
envval() { grep -E "^$1=" "$repo_dir/.env" | head -1 | cut -d= -f2-; }
export SSHPASS="$(envval AIWEBSITE_PW)"
sshpass -e ssh -o StrictHostKeyChecking=accept-new "$(envval AIWEBSITE_USER)@$(envval AIWEBSITE_SSH_IP)" '
  set -e
  echo "== watchdog instances before =="
  pgrep -fc "aiwebsite-watchdog.sh" || echo 0
  echo "== killing all watchdog instances =="
  sudo pkill -f "aiwebsite-watchdog.sh" || true
  sleep 2
  sudo pkill -9 -f "aiwebsite-watchdog.sh" 2>/dev/null || true
  sudo rm -f /var/run/aiwebsite-watchdog.pid
  echo "== applying migration 0005 (memory tables) =="
  m=$(ls /var/www/aiwebsite/drizzle/migrations/0005_*.sql | head -1)
  sudo -u postgres psql -d aiwebsite -v ON_ERROR_STOP=1 -f "$m"
  sudo -u postgres psql -d aiwebsite -tAc "select to_regclass('"'"'public.sms_memory_notices'"'"'), to_regclass('"'"'public.memory_deletion_logs'"'"')"
  echo "== starting exactly one watchdog =="
  sudo /usr/local/bin/aiwebsite-watchdog-cron.sh
  sleep 3
  echo -n "instances now: "; pgrep -fc "aiwebsite-watchdog.sh" || echo 0
  echo "== pm2 state =="
  pm2 jlist 2>/dev/null | python3 -c "
import json,sys,time
for p in json.load(sys.stdin):
    up=(time.time()*1000-p[\"pm2_env\"].get(\"pm_uptime\",0))/1000
    print(p[\"name\"], p[\"pm2_env\"][\"status\"], f\"up {up:.0f}s\", \"restarts\", p[\"pm2_env\"][\"restart_time\"])"
'
