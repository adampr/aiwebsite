#!/usr/bin/env bash
# aicompany-template: watchdog-cron.sh.tpl@f0a921e6ff13af5787ba7333c0916582d0358fccd86a5466f0045196ed7b9665
# Cron supervisor for the ai.xl.net watchdog (§9.5) — the one deliberate cron
# entry. Ensures the watchdog process is running; starts it if not.
# Install (root crontab): */5 * * * * /usr/local/bin/aiwebsite-watchdog-cron.sh
#
# Liveness is decided by the SAME advisory lock the watchdog holds for its
# lifetime (§9.5) — never by pid-file grep. If we can acquire the lock, no
# watchdog is alive; we release it and start one (the freshly started watchdog
# then holds it). If we cannot, a watchdog is alive and there is nothing to do.
# This is what stops unrecorded daemons accumulating: a live-but-unrecorded
# instance still holds the lock, so this supervisor never double-starts.
set -uo pipefail

pid_file="/var/run/aiwebsite-watchdog.pid"
lock_file="/var/run/aiwebsite-watchdog.lock"
watchdog_bin="/usr/local/bin/aiwebsite-watchdog.sh"
log_file="/var/log/aiwebsite-watchdog-cron.log"

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S %Z') $1" >> "$log_file"
}

exec 9>"$lock_file" || { log "ERROR: cannot open lock file $lock_file"; exit 1; }

if ! flock -n 9; then
  # Lock held by a live watchdog — nothing to do.
  log "OK: Watchdog is running (holds $lock_file; pid $(cat "$pid_file" 2>/dev/null || echo '?'))"
  exit 0
fi

# We acquired the lock, so no watchdog is alive. Release it so the child can
# take it, then start exactly one.
log "WARN: Watchdog is not running -- starting it"
flock -u 9
nohup "$watchdog_bin" >> /dev/null 2>&1 &
sleep 2

# Confirm via process count, NOT by re-acquiring the lock: a re-acquire here
# could win the microsecond race against the just-started watchdog, which would
# then see the lock held, exit 0, and leave zero watchdogs — the very outage we
# are guarding against. pgrep observes without taking the lock.
if [[ "$(pgrep -cf "aiwebsite-watchdog.sh")" -ge 1 ]]; then
  log "OK: Watchdog started (pid $(cat "$pid_file" 2>/dev/null || echo '?'))"
else
  log "ERROR: Failed to start watchdog (no aiwebsite-watchdog.sh process after start)"
fi
