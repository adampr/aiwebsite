#!/usr/bin/env bash
# aicompany-template: watchdog-cron.sh.tpl@33601224bd009f18b67e9b62546428712685007252f64c699c367d8f372cea8e
# Cron supervisor for the ai.xl.net watchdog (§9.5) — the one deliberate cron
# entry. Ensures the watchdog process is running; starts it if not.
# Install (root crontab): */5 * * * * /usr/local/bin/aiwebsite-watchdog-cron.sh
set -uo pipefail

pid_file="/var/run/aiwebsite-watchdog.pid"
watchdog_bin="/usr/local/bin/aiwebsite-watchdog.sh"
log_file="/var/log/aiwebsite-watchdog-cron.log"

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S %Z') $1" >> "$log_file"
}

is_watchdog_running() {
  if [[ ! -f "$pid_file" ]]; then
    return 1
  fi
  local pid
  pid=$(cat "$pid_file")
  if [[ -z "$pid" ]]; then
    return 1
  fi
  # Check if the PID is alive AND is actually our watchdog script
  if kill -0 "$pid" 2>/dev/null && grep -q "aiwebsite-watchdog" "/proc/$pid/cmdline" 2>/dev/null; then
    return 0
  fi
  return 1
}

if is_watchdog_running; then
  log "OK: Watchdog is running (PID $(cat "$pid_file"))"
else
  log "WARN: Watchdog is not running -- starting it"
  rm -f "$pid_file"
  nohup "$watchdog_bin" >> /dev/null 2>&1 &
  sleep 2
  if is_watchdog_running; then
    log "OK: Watchdog started (PID $(cat "$pid_file"))"
  else
    log "ERROR: Failed to start watchdog"
  fi
fi
