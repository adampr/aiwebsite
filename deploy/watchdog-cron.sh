#!/usr/bin/env bash
# Cron supervisor for the ai.xl.net watchdog.
# Ensures the watchdog process is running; starts it if not.
# Install (root crontab): */5 * * * * /usr/local/bin/aiwebsite-watchdog-cron.sh
set -uo pipefail

PID_FILE="/var/run/aiwebsite-watchdog.pid"
WATCHDOG_BIN="/usr/local/bin/aiwebsite-watchdog.sh"
LOG_FILE="/var/log/aiwebsite-watchdog-cron.log"

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S %Z') $1" >> "$LOG_FILE"
}

is_watchdog_running() {
  if [[ ! -f "$PID_FILE" ]]; then
    return 1
  fi
  local pid
  pid=$(cat "$PID_FILE")
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
  log "OK: Watchdog is running (PID $(cat "$PID_FILE"))"
else
  log "WARN: Watchdog is not running -- starting it"
  rm -f "$PID_FILE"
  nohup "$WATCHDOG_BIN" >> /dev/null 2>&1 &
  sleep 2
  if is_watchdog_running; then
    log "OK: Watchdog started (PID $(cat "$PID_FILE"))"
  else
    log "ERROR: Failed to start watchdog"
  fi
fi
