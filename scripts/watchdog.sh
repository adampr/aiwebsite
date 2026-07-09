#!/usr/bin/env bash
# Health-check watchdog for aiwebsite (Next.js production server, port 3999).
# Modeled after roleplay/scripts/watchdog.sh.
#
# Runs `next start`, polls the homepage, and auto-restarts on sustained
# failure. Launched from cron (@reboot + every 5 min) under `flock -n` so at
# most one instance ever runs — the periodic cron entry is the self-heal path
# if the watchdog itself dies.
#
# Usage:  flock -n /tmp/aiwebsite-watchdog.lock bash scripts/watchdog.sh

set -uo pipefail

PORT="${AIWEBSITE_PORT:-3999}"
CHECK_INTERVAL="${CHECK_INTERVAL:-10}"
FAIL_THRESHOLD="${FAIL_THRESHOLD:-3}"
RESTART_COOLDOWN="${RESTART_COOLDOWN:-30}"

cd "$(dirname "$0")/.."

fail_count=0
dev_pid=""
last_restart=0

cleanup() {
  echo "[aiwebsite-watchdog] shutting down"
  if [[ -n "$dev_pid" ]] && kill -0 "$dev_pid" 2>/dev/null; then
    kill "$dev_pid" 2>/dev/null || true
    wait "$dev_pid" 2>/dev/null || true
  fi
  exit 0
}
trap cleanup SIGINT SIGTERM

health_ok() {
  curl -sf --max-time 5 "http://127.0.0.1:${PORT}/" >/dev/null 2>&1
}

kill_port() {
  local pids
  pids=$(lsof -ti :"$PORT" 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    echo "[aiwebsite-watchdog] killing PIDs on port $PORT: $pids"
    echo "$pids" | xargs kill -9 2>/dev/null || true
    sleep 1
  fi
}

start_server() {
  echo "[aiwebsite-watchdog] starting server on port $PORT"
  # Launch the next binary directly (not via `npm start`): npm wraps node in a
  # child process, so signals would hit npm and never reach the server.
  PORT="$PORT" ./node_modules/.bin/next start --port "$PORT" &
  dev_pid=$!
  last_restart=$(date +%s)
  fail_count=0
  echo "[aiwebsite-watchdog] server started (PID $dev_pid), waiting ${RESTART_COOLDOWN}s cooldown"
  sleep "$RESTART_COOLDOWN"
}

# Adopt an already-healthy server (e.g. started manually) instead of
# double-starting into EADDRINUSE. It has no dev_pid, so a later restart goes
# through kill_port instead of SIGTERM — acceptable for a stateless server.
if health_ok; then
  echo "[aiwebsite-watchdog] existing server is healthy — monitoring only"
  last_restart=$(date +%s)
else
  kill_port
  start_server
fi

while true; do
  sleep "$CHECK_INTERVAL"

  if health_ok; then
    fail_count=0
    continue
  fi

  fail_count=$((fail_count + 1))
  echo "[aiwebsite-watchdog] health check failed ($fail_count/$FAIL_THRESHOLD)"

  if [[ $fail_count -ge $FAIL_THRESHOLD ]]; then
    now=$(date +%s)
    elapsed=$((now - last_restart))
    if [[ $elapsed -lt $RESTART_COOLDOWN ]]; then
      echo "[aiwebsite-watchdog] cooldown active (${elapsed}s < ${RESTART_COOLDOWN}s), skipping restart"
      continue
    fi

    echo "[aiwebsite-watchdog] threshold reached — restarting"
    if [[ -n "$dev_pid" ]] && kill -0 "$dev_pid" 2>/dev/null; then
      kill -TERM "$dev_pid" 2>/dev/null || true
      for _ in $(seq 1 10); do
        kill -0 "$dev_pid" 2>/dev/null || break
        sleep 1
      done
      wait "$dev_pid" 2>/dev/null || true
    fi

    kill_port
    start_server
  fi
done
