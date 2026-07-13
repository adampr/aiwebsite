#!/usr/bin/env bash
# aicompany-template: extra-services.sh.tpl@86ed8b060cfd3df31ed194676dc0fa6e14997819c50fc63a42a63ce5a25f1655
# Extra-services supervision library + CLI for ai.xl.net (§9.5 "Extra
# services", v1.4.0). Supervises host-declared non-pm2 services (e.g. a legacy
# voice service) from INSIDE the module watchdog's singleton loop — no second
# daemon, no new liveness authority.
#
# Config: host-owned deploy/extra-services.json (committed, NOT
# template-rendered — the pre-migrate.sh precedent). Absent file ⇒ every code
# path here is a no-op for the watchdog and setup-vm. Schema per service:
#   name (^[a-z0-9-]+$), cwd, start, port, healthUrl        — REQUIRED
#   path, user, healthExpect, checkIntervalSeconds(10),     — optional
#   failThreshold(3), restartCooldownSeconds(30),
#   stopSignal(TERM), stopTimeoutSeconds(20),
#   startTimeoutSeconds(120), logFile(/var/log/aiwebsite-<name>.log),
#   gateOnDeploy(true)
#
# Usage (CLI):
#   bash deploy/extra-services.sh {validate|verify|status} [name]   # unprivileged
#   sudo bash deploy/extra-services.sh {start|stop|restart} [name]  # root only
#
# Privilege contract (§9.5): the mutating subcommands require root — the
# launcher uses root-only `runuser` for the cross-user branch, and the first
# append to a fresh /var/log logFile only works because the ROOT shell opens
# the redirect. validate/verify/status are read-only and run unprivileged.
#
# Sourced by watchdog.sh as a library; invoked as a CLI subprocess by
# setup-vm.sh and deploy.sh (the dispatcher at the bottom only fires when
# executed directly). Deliberately NO top-level `set -e`: sourcing must not
# change the caller's shell options.
#
# Launch contract (§9.5): services are DETACHED (setsid) and survive watchdog
# restarts — a watchdog bounce no longer bounces the service. Every spawn
# closes fd 9 (watchdog singleton lock) AND fd 200 (deploy lock): a long-lived
# service child that inherited either fd would hold the lock past its owner's
# death and wedge the singleton/deploy (the B1 failure class, v1.3.4).
# Stop identity is the UNION of port-holders (lsof -ti :port) and
# pgrep-matched start-command pids — `exec` in the launcher makes the launched
# pid the service itself, and whichever pid actually binds the port receives
# the stop signal directly either way.

es_app_root="/var/www/aiwebsite"
es_slug="aiwebsite"
# ES_MANIFEST env override is a test/dev hook only — production always uses
# the committed manifest next to this script.
es_manifest_file="${ES_MANIFEST:-$es_app_root/deploy/extra-services.json}"
es_state_dir="/var/run"

# Parallel arrays filled by es_load (bash 3 compatible — no assoc arrays).
es_names=(); es_cwds=(); es_starts=(); es_paths=(); es_users=()
es_ports=(); es_health_urls=(); es_health_expects=()
es_check_intervals=(); es_fail_thresholds=(); es_cooldowns=()
es_stop_signals=(); es_stop_timeouts=(); es_start_timeouts=()
es_log_files=(); es_gate_on_deploys=()
es_loaded=0

es_log() { echo "$(date '+%Y-%m-%d %H:%M:%S %Z') [extra-services] $1"; }

es_manifest_present() { [ -f "$es_manifest_file" ]; }

# es_validate: jq parse + per-field checks. Non-zero on the FIRST violation,
# naming the field. Also refuses shell-hazard quotes in cwd/path/start (they
# are interpolated into the launcher's bash -c payload).
es_validate() {
  if ! es_manifest_present; then
    echo "extra-services: no manifest at $es_manifest_file"
    return 1
  fi
  if ! jq -e . "$es_manifest_file" >/dev/null 2>&1; then
    echo "extra-services INVALID: $es_manifest_file is not parseable JSON"
    return 1
  fi
  if ! jq -e '.services | type == "array" and length > 0' "$es_manifest_file" >/dev/null 2>&1; then
    echo "extra-services INVALID: services — must be a non-empty array"
    return 1
  fi
  local n i
  n=$(jq -r '.services | length' "$es_manifest_file")
  for i in $(seq 0 $(( n - 1 ))); do
    local svc
    svc=$(jq -c ".services[$i]" "$es_manifest_file")
    # required strings
    local f
    for f in name cwd start healthUrl; do
      if ! echo "$svc" | jq -e --arg f "$f" '.[$f] | type == "string" and length > 0' >/dev/null 2>&1; then
        echo "extra-services INVALID: services[$i].$f — required non-empty string"
        return 1
      fi
    done
    if ! echo "$svc" | jq -e '.name | test("^[a-z0-9-]+$")' >/dev/null 2>&1; then
      echo "extra-services INVALID: services[$i].name — must match ^[a-z0-9-]+$"
      return 1
    fi
    if ! echo "$svc" | jq -e '.port | type == "number" and . == floor and . > 0 and . < 65536' >/dev/null 2>&1; then
      echo "extra-services INVALID: services[$i].port — required integer 1-65535"
      return 1
    fi
    # optional integers
    for f in checkIntervalSeconds failThreshold restartCooldownSeconds stopTimeoutSeconds startTimeoutSeconds; do
      if ! echo "$svc" | jq -e --arg f "$f" '(.[$f] // 1) | type == "number" and . == floor and . >= 1' >/dev/null 2>&1; then
        echo "extra-services INVALID: services[$i].$f — must be a positive integer"
        return 1
      fi
    done
    # gateOnDeploy must be a real boolean: a string typo ("True"/"yes") would
    # pass through and silently UNGATE the service from the deploy marker —
    # re-enabling the npm-ci-vs-restart race this system exists to prevent.
    if ! echo "$svc" | jq -e 'if has("gateOnDeploy") then (.gateOnDeploy | type == "boolean") else true end' >/dev/null 2>&1; then
      echo "extra-services INVALID: services[$i].gateOnDeploy — must be true or false (JSON boolean)"
      return 1
    fi
    # stopSignal must be a signal kill(1) accepts: a typo would silently turn
    # every graceful stop (the recording-flush guarantee) into a full-timeout
    # wait + kill -9.
    local sig
    sig=$(echo "$svc" | jq -r '.stopSignal // "TERM"')
    if ! kill -l "$sig" >/dev/null 2>&1; then
      echo "extra-services INVALID: services[$i].stopSignal — '$sig' is not a signal name"
      return 1
    fi
    # shell-hazard guard: these values are interpolated into a bash -c payload
    for f in cwd start path user logFile; do
      if echo "$svc" | jq -r --arg f "$f" '.[$f] // ""' | grep -q "[\"'\\\\]"; then
        echo "extra-services INVALID: services[$i].$f — quotes/backslashes are not allowed"
        return 1
      fi
    done
  done
  # Duplicate names collide on stamps, alert keys, and supervision state.
  if [ "$(jq -r '.services[].name' "$es_manifest_file" | sort | uniq -d | wc -l)" != "0" ]; then
    echo "extra-services INVALID: services[].name — names must be unique"
    return 1
  fi
  echo "extra-services: manifest OK ($n service(s))"
  return 0
}

# es_load: parse the manifest once into the parallel arrays (idempotent).
es_load() {
  [ "$es_loaded" = "1" ] && return 0
  es_manifest_present || return 1
  local n i svc
  n=$(jq -r '.services | length' "$es_manifest_file" 2>/dev/null) || return 1
  for i in $(seq 0 $(( n - 1 ))); do
    svc=$(jq -c ".services[$i]" "$es_manifest_file")
    es_names+=("$(echo "$svc" | jq -r '.name')")
    es_cwds+=("$(echo "$svc" | jq -r '.cwd')")
    es_starts+=("$(echo "$svc" | jq -r '.start')")
    es_paths+=("$(echo "$svc" | jq -r '.path // "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"')")
    es_users+=("$(echo "$svc" | jq -r '.user // ""')")
    es_ports+=("$(echo "$svc" | jq -r '.port')")
    es_health_urls+=("$(echo "$svc" | jq -r '.healthUrl')")
    es_health_expects+=("$(echo "$svc" | jq -r '.healthExpect // ""')")
    es_check_intervals+=("$(echo "$svc" | jq -r '.checkIntervalSeconds // 10')")
    es_fail_thresholds+=("$(echo "$svc" | jq -r '.failThreshold // 3')")
    es_cooldowns+=("$(echo "$svc" | jq -r '.restartCooldownSeconds // 30')")
    es_stop_signals+=("$(echo "$svc" | jq -r '.stopSignal // "TERM"')")
    es_stop_timeouts+=("$(echo "$svc" | jq -r '.stopTimeoutSeconds // 20')")
    es_start_timeouts+=("$(echo "$svc" | jq -r '.startTimeoutSeconds // 120')")
    es_log_files+=("$(echo "$svc" | jq -r --arg d "/var/log/aiwebsite-$(echo "$svc" | jq -r '.name').log" '.logFile // $d')")
    # has()-guarded: jq's `//` treats an explicit false as absent, which
    # would make gateOnDeploy:false unrepresentable.
    es_gate_on_deploys+=("$(echo "$svc" | jq -r 'if has("gateOnDeploy") then .gateOnDeploy else true end')")
  done
  es_loaded=1
  return 0
}

es_index_of() { # name -> array index (or return 1)
  local i
  for i in "${!es_names[@]}"; do
    [ "${es_names[$i]}" = "$1" ] && { echo "$i"; return 0; }
  done
  echo "extra-services: unknown service '$1' (manifest: ${es_names[*]:-none})" >&2
  return 1
}

es_require_root() {
  if [ "$(id -u)" != "0" ]; then
    echo "extra-services: '$1' requires root — run: sudo bash deploy/extra-services.sh $1 ${2:-}" >&2
    return 1
  fi
}

es_kill_port() { # port — lsof -ti + kill -9 (legacy watchdog parity)
  local pids
  pids=$(lsof -ti :"$1" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    es_log "killing PIDs on port $1: $(echo "$pids" | tr '\n' ' ')"
    echo "$pids" | xargs kill -9 2>/dev/null || true
    sleep 1
  fi
}

es_pids_for() { # index -> union of port-holders and start-command matches
  local port="${es_ports[$1]}" start="${es_starts[$1]}"
  { lsof -ti :"$port" 2>/dev/null || true
    pgrep -f -- "$start" 2>/dev/null || true
  } | sort -un
}

es_stamp_file() { echo "$es_state_dir/${es_slug}-es-$1.last-start"; }

es_last_start_epoch() { # name -> epoch of last start (0 = never / pre-reboot)
  stat -c %Y "$(es_stamp_file "$1")" 2>/dev/null || echo 0
}

es_in_cooldown() { # index -> 0 when within restartCooldownSeconds of last start
  local last now
  last=$(es_last_start_epoch "${es_names[$1]}")
  [ "$last" = "0" ] && return 1
  now=$(date +%s)
  (( now - last < ${es_cooldowns[$1]} ))
}

# es_should_restart <now> <last_start> <fail_count> <fail_threshold> <cooldown>
# Pure decision function (unit-testable): 0 ⇒ restart. Non-zero NEVER
# escalates: a cooldown refusal prints "SKIP: cooldown" and callers treat it
# as a handled no-op — it must never surface as a failed restart command
# inside restart_and_alert's CRITICAL branch (legacy parity: log-and-skip).
es_should_restart() {
  local now="$1" last_start="$2" fail_count="$3" fail_threshold="$4" cooldown="$5"
  if (( fail_count < fail_threshold )); then
    echo "SKIP: below threshold ($fail_count/$fail_threshold)"
    return 1
  fi
  if (( now - last_start < cooldown )); then
    echo "SKIP: cooldown ($(( now - last_start ))s < ${cooldown}s since last start)"
    return 1
  fi
  echo "RESTART"
  return 0
}

# es_spawn <user> <payload> <logfile> — the normative launcher (§9.5).
# setsid detaches from the caller's session (the service survives watchdog
# restarts); `9>&- 200>&-` close the watchdog-singleton and deploy-lock fds so
# the long-lived service can never inherit + wedge either lock (B1). The
# same-user branch exists for root-launching-as-root and for the behavioral
# fd-hygiene tests (runuser is root-only).
es_spawn() {
  local user="$1" payload="$2" logfile="$3"
  if [ "$(id -un)" = "$user" ]; then
    setsid bash -c "$payload" 9>&- 200>&- >>"$logfile" 2>&1 </dev/null &
  else
    setsid runuser -u "$user" -- bash -c "$payload" 9>&- 200>&- >>"$logfile" 2>&1 </dev/null &
  fi
}

es_stop_one() { # index
  local i="$1" name="${es_names[$1]}"
  local pids
  pids=$(es_pids_for "$i")
  if [ -z "$pids" ]; then
    es_log "stop $name: not running"
    return 0
  fi
  es_log "stop $name: sending SIG${es_stop_signals[$i]} to $(echo "$pids" | tr '\n' ' ')"
  # shellcheck disable=SC2086
  kill -s "${es_stop_signals[$i]}" $pids 2>/dev/null || true
  local waited=0
  while (( waited < ${es_stop_timeouts[$i]} )); do
    pids=$(es_pids_for "$i")
    [ -z "$pids" ] && { es_log "stop $name: stopped gracefully (${waited}s)"; return 0; }
    sleep 1
    waited=$(( waited + 1 ))
  done
  es_log "stop $name: still up after ${es_stop_timeouts[$i]}s — escalating"
  es_kill_port "${es_ports[$i]}"
  pids=$(pgrep -f -- "${es_starts[$i]}" 2>/dev/null || true)
  # shellcheck disable=SC2086
  [ -n "$pids" ] && kill -9 $pids 2>/dev/null || true
  return 0
}

es_start_one() { # index
  local i="$1" name="${es_names[$1]}"
  local user="${es_users[$i]}"
  [ -n "$user" ] || user=$(stat -c %U "${es_cwds[$i]}" 2>/dev/null || echo root)
  # Idempotency: already healthy on its port ⇒ no-op (never double-start);
  # port held but UNhealthy ⇒ stop the wreck first, then launch fresh.
  if [ -n "$(lsof -ti :"${es_ports[$i]}" 2>/dev/null || true)" ]; then
    if es_health_one "$i" >/dev/null 2>&1; then
      es_log "start $name: already running and healthy on :${es_ports[$i]} — no-op"
      return 0
    fi
    es_log "start $name: port :${es_ports[$i]} held but unhealthy — stopping stale process first"
    es_stop_one "$i"
  fi
  es_log "start $name: launching as $user (cwd ${es_cwds[$i]})"
  es_spawn "$user" "cd '${es_cwds[$i]}' && exec env PATH='${es_paths[$i]}' ${es_starts[$i]}" "${es_log_files[$i]}"
  touch "$(es_stamp_file "$name")" 2>/dev/null || true
  return 0
}

es_health_one() { # index
  local i="$1" body
  body=$(curl -sf --max-time 5 "${es_health_urls[$i]}" 2>/dev/null) || return 1
  if [ -n "${es_health_expects[$i]}" ]; then
    echo "$body" | grep -q -- "${es_health_expects[$i]}" || return 1
  fi
  return 0
}

es_verify_one() { # index — health-gate up to startTimeoutSeconds
  local i="$1" name="${es_names[$1]}" waited=0
  while (( waited < ${es_start_timeouts[$i]} )); do
    if es_health_one "$i"; then
      es_log "verify $name: healthy (${waited}s)"
      return 0
    fi
    sleep 2
    waited=$(( waited + 2 ))
  done
  es_log "verify $name: NOT healthy after ${es_start_timeouts[$i]}s (${es_health_urls[$i]})"
  return 1
}

es_restart() { # name — the watchdog's repair command (via restart_and_alert)
  local i decision
  i=$(es_index_of "$1") || return 1
  # Both production decision sites (this guard and the watchdog's pre-check)
  # route through es_should_restart — the pure function the truth-table
  # tests pin. fail_count==threshold here: a manual/repair restart is only
  # ever refused by the cooldown, never by the counter. Exit 0 on refusal —
  # a cooldown SKIP is handled, not a failed restart (it must never fire
  # restart_and_alert's CRITICAL branch).
  if ! decision=$(es_should_restart "$(date +%s)" "$(es_last_start_epoch "$1")" \
      "${es_fail_thresholds[$i]}" "${es_fail_thresholds[$i]}" "${es_cooldowns[$i]}"); then
    es_log "SKIP: restart $1 refused — $decision"
    return 0
  fi
  es_stop_one "$i"
  es_start_one "$i"
}

es_status_one() { # index
  local i="$1" name="${es_names[$1]}"
  local holders health="FAIL" last="never"
  holders=$(lsof -ti :"${es_ports[$i]}" 2>/dev/null | tr '\n' ' ')
  es_health_one "$i" && health="OK"
  local stamp mtime
  stamp=$(es_stamp_file "$name")
  mtime=$(stat -c %Y "$stamp" 2>/dev/null) && last="$(( $(date +%s) - mtime ))s ago"
  echo "$name  port=:${es_ports[$i]} pids=${holders:-none} health=$health last-start=$last log=${es_log_files[$i]}"
}

es_each() { # <fn_suffix> [name] — run es_<fn>_one over one or all services
  local fn="$1" name="${2:-}" rc=0 i
  es_load || { echo "extra-services: no manifest at $es_manifest_file"; return 1; }
  if [ -n "$name" ]; then
    i=$(es_index_of "$name") || return 1
    "es_${fn}_one" "$i" || rc=1
  else
    for i in "${!es_names[@]}"; do
      "es_${fn}_one" "$i" || rc=1
    done
  fi
  return $rc
}

es_main() {
  set -uo pipefail
  local cmd="${1:-}" name="${2:-}"
  case "$cmd" in
    validate) es_validate ;;
    verify)   es_each verify "$name" ;;
    status)   es_each status "$name" ;;
    start)    es_require_root start "$name" && es_each start "$name" ;;
    stop)     es_require_root stop "$name" && es_each stop "$name" ;;
    restart)
      es_require_root restart "$name" || return 1
      es_load || { echo "extra-services: no manifest at $es_manifest_file"; return 1; }
      if [ -n "$name" ]; then es_restart "$name"; else
        local n; for n in "${es_names[@]}"; do es_restart "$n"; done
      fi
      ;;
    *)
      echo "usage: bash deploy/extra-services.sh {validate|verify|status} [name]"
      echo "       sudo bash deploy/extra-services.sh {start|stop|restart} [name]"
      return 1
      ;;
  esac
}

# CLI dispatcher — only when executed, never when sourced as a library.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  es_main "$@"
fi
