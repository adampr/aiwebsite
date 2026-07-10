#!/usr/bin/env bash
# Incident fix continuation: the first pass killed the watchdogs but pkill
# self-matched the ssh command line and cut the session. Bracket-pattern
# avoids self-match; finish cleanup + migration + single restart.
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
envval() { grep -E "^$1=" "$repo_dir/.env" | head -1 | cut -d= -f2-; }
export SSHPASS="$(envval AIWEBSITE_PW)"
sshpass -e ssh -o StrictHostKeyChecking=accept-new "$(envval AIWEBSITE_USER)@$(envval AIWEBSITE_SSH_IP)" '
  set -e
  WD="[a]iwebsite-watchdog.sh"
  echo -n "instances before: "; pgrep -fc "$WD" || echo 0
  sudo pkill -f "$WD" 2>/dev/null || true
  sleep 2
  sudo pkill -9 -f "$WD" 2>/dev/null || true
  sudo rm -f /var/run/aiwebsite-watchdog.pid
  echo -n "instances after kill: "; pgrep -fc "$WD" || echo 0
  echo "== applying migration 0005 (memory tables) =="
  m=$(ls /var/www/aiwebsite/drizzle/migrations/0005_*.sql | head -1)
  sudo -u postgres psql -d aiwebsite -v ON_ERROR_STOP=1 -f "$m"
  sudo -u postgres psql -d aiwebsite -tAc "select to_regclass('"'"'public.sms_memory_notices'"'"'), to_regclass('"'"'public.memory_deletion_logs'"'"')"
  echo "== starting exactly one watchdog =="
  sudo /usr/local/bin/aiwebsite-watchdog-cron.sh >/dev/null 2>&1 || true
  sleep 3
  echo -n "instances now: "; pgrep -fc "$WD" || echo 0
  echo "== pm2 state =="
  pm2 jlist 2>/dev/null | python3 -c "
import json,sys,time
for p in json.load(sys.stdin):
    up=(time.time()*1000-p[\"pm2_env\"].get(\"pm_uptime\",0))/1000
    print(p[\"name\"], p[\"pm2_env\"][\"status\"], f\"up {up:.0f}s\", \"restarts\", p[\"pm2_env\"][\"restart_time\"])"
'
