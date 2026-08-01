#!/usr/bin/env bash
# Inventory and clean up stray local Next servers.
#
# WHY THIS EXISTS
#
# Three lessons from 2026-07-31/08-01, each of which cost real time:
#
#  1. A stale `next start` kept answering on a test port and served an OLD
#     build, so a fix that was actually correct looked broken. Diagnosing that
#     took longer than writing the fix.
#  2. `pkill -f "next start"` MATCHES THE SHELL RUNNING IT. It kills itself,
#     the compound command stops at that point, and everything after it is
#     silently skipped. That is how a whole deploy run vanished with no log
#     file and an exit code nobody reads. NEVER pattern-kill on that string;
#     kill by PORT, which is what this script does.
#  3. An orphaned preview server for a project that had moved off this box sat
#     running for three days holding 116 MB, bound to the PUBLIC interface,
#     serving 500s to nobody.
#
# Usage:
#   bash scripts/dev-servers.sh            # list every Next server + verdict
#   bash scripts/dev-servers.sh --clean    # stop ONLY the orphans
#   bash scripts/dev-servers.sh --check    # also report crash-looping units
#
# --clean NEVER touches a supervised server (one whose parent is a watchdog),
# and never touches a server with a live connection.
set -uo pipefail

cd "$(dirname "$0")/.."

mode="${1:-list}"

port_of()  { ss -ltnp 2>/dev/null | grep "pid=$1," | grep -oP '[:*]\K[0-9]+(?=\s)' | head -1; }
conns_of() { local p="$1"; [ -z "$p" ] && echo 0 && return; ss -tn 2>/dev/null | grep -c ":$p "; }

echo "Local Next servers"
echo "------------------"

found=0
orphans=()

while read -r pid; do
  [ -z "$pid" ] && continue
  found=$((found + 1))
  ppid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
  cwd="$(readlink /proc/$pid/cwd 2>/dev/null || echo '?')"
  rss="$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ')"
  started="$(ps -o lstart= -p "$pid" 2>/dev/null | xargs)"
  port="$(port_of "$pid")"
  conns="$(conns_of "$port")"

  # Supervised = parent is a watchdog script, not init.
  parent_cmd="$(ps -o args= -p "${ppid:-1}" 2>/dev/null | cut -c1-60)"
  if [[ "$parent_cmd" == *watchdog* ]]; then
    verdict="SUPERVISED — leave alone"
  elif [ "${ppid:-1}" = "1" ] && [ "$conns" = "0" ]; then
    verdict="orphan, no connections — safe to stop"
    orphans+=("$pid:${port:-?}")
  elif [ "${ppid:-1}" = "1" ]; then
    verdict="orphan but $conns live connection(s) — check before stopping"
  else
    verdict="has a live parent (pid $ppid) — probably someone's session"
  fi

  printf "  pid %-8s port %-6s %5s MB  %s\n" "$pid" "${port:-none}" "$((${rss:-0} / 1024))" "$verdict"
  printf "      cwd %s\n" "$cwd"
  printf "      up since %s\n" "$started"
done < <(pgrep -f "next-server" 2>/dev/null)

[ "$found" = "0" ] && echo "  (none running)"

if [ "$mode" = "--check" ]; then
  echo ""
  echo "Crash-looping or failed user units"
  echo "----------------------------------"
  # A dead unit with Restart=on-failure retries forever and nobody notices.
  # One of these had restarted 277,161 times and written 224,008 journal
  # entries before anyone looked.
  # Filter on the STATE, not the listing text: brain-watchdog's DESCRIPTION
  # contains the words "auto-restart", which a naive grep reads as a crash
  # loop. --state= asks systemd instead of pattern-matching its output.
  # .scope units are excluded: those are transient systemd-run wrappers from
  # finished builds, not services that will retry.
  loop="$(systemctl --user list-units --state=activating --no-legend --plain 2>/dev/null | grep -v '\.scope' | head -5)"
  bad="$(systemctl --user list-units --state=failed --no-legend --plain 2>/dev/null | grep -v '\.scope' | head -5)"
  if [ -z "$loop" ] && [ -z "$bad" ]; then
    echo "  none"
  else
    [ -n "$loop" ] && echo "$loop" | awk '{print "  LOOPING: "$1}'
    [ -n "$bad" ] && echo "$bad" | awk '{print "  FAILED:  "$1}'
    echo ""
    echo "  Restart count: journalctl --user -u <unit> | grep -c 'Scheduled restart'"
  fi
fi

if [ "$mode" = "--clean" ]; then
  echo ""
  if [ "${#orphans[@]}" = "0" ]; then
    echo "Nothing to clean: no unsupervised, unused servers."
    exit 0
  fi
  echo "Stopping ${#orphans[@]} orphan(s)"
  for entry in "${orphans[@]}"; do
    pid="${entry%%:*}"
    port="${entry##*:}"
    # Kill by PID resolved from the port listing — never `pkill -f "next start"`.
    kill "$pid" 2>/dev/null && echo "  stopped pid $pid (port $port)"
    sleep 2
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null && echo "    escalated to SIGKILL"
  done
  echo ""
  echo "Remaining:"
  pgrep -af "next-server" 2>/dev/null | cut -c1-60 | sed 's/^/  /' || echo "  none"
fi
