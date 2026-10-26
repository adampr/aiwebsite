#!/usr/bin/env bash
# aicompany-template: posture-check.sh.tpl@965a80dc8552987c9ccb966ec117fd1bafa9af66f7a72d0c2de4b143a9335342
# aiwebsite posture check (v1.174.0, architecture.md §9.1 / §9.5). READ-ONLY: it
# changes nothing on the box and prints no secret.
#
# Two assertions; each broken one is a FAIL line:
#   1. listeners — every TCP listener on the module's internal ports (site
#      3000, brain-api 3211, skills-host 3213) is bound to loopback (127.0.0.0/8
#      or ::1). Their only clients are local: nginx (proxy_pass
#      http://127.0.0.1:…), the deploy health gate, the watchdog, skills-host ↔
#      site. The public path is cloudflared → nginx, and nginx listens on
#      loopback too. Before v1.174.0 all three bound every interface on four
#      hosts (measured 2026-10-23), behind nothing but the cloud firewall.
#   2. boot — pm2's boot unit pm2-<user>.service exists, is enabled, runs as
#      <user>, its ExecStart pm2 exists and runs `resurrect`, its PM2_HOME is
#      <home>/.pm2 and its PATH resolves `node`. Without it a reboot brings back
#      nginx and cloudflared in front of apps that never start. Before v1.174.0
#      setup-vm's `pm2 startup … || true` was a silent no-op for every non-root
#      deploy user (S11, 2026-10-23).
# INFO lines are never a failure: a port nothing listens on (the health checks
# own a down service), other non-loopback TCP listeners besides sshd, and
# whether the pm2 daemon runs inside the unit (that matters for shutdown order
# and the needrestart exclusion, not for boot start; moving it is a live bounce
# and an operator's step, never a deploy's).
#
# Callers: setup-vm.sh at the end of every deploy (a FAIL fails the deploy,
# after everything is installed — nothing is rolled back) and the watchdog
# once an hour (a FAIL records a ledger row, no mail).
#
# Usage: posture-check.sh [--user <name>]   (default: the owner of /var/www/aiwebsite)
# Exit:  0 posture holds · 1 at least one FAIL · 2 the check could not run.
set -uo pipefail

user=""
while [ $# -gt 0 ]; do
  case "$1" in
    --user)
      if [ $# -lt 2 ] || [ -z "$2" ]; then echo "posture-check: --user needs a name" >&2; exit 2; fi
      user="$2"; shift 2 ;;
    *) echo "posture-check: unknown argument '$1'" >&2; exit 2 ;;
  esac
done
[ -n "$user" ] || user="$(stat -c %U "/var/www/aiwebsite" 2>/dev/null || true)"
if [ -z "$user" ]; then echo "posture-check: cannot determine the pm2 user (pass --user)" >&2; exit 2; fi
for tool in ss systemctl getent; do
  command -v "$tool" >/dev/null 2>&1 || { echo "posture-check: $tool not found" >&2; exit 2; }
done

fails=0
fail() { echo "FAIL $*"; fails=$((fails + 1)); }
ok()   { echo "OK   $*"; }
info() { echo "INFO $*"; }

# ss's local-address column: "127.0.0.1:3211", "*:3211", "0.0.0.0:3211",
# "[::]:3211", "[::1]:3211", "[::ffff:127.0.0.1]:3211", "127.0.0.53%lo:53".
is_loopback() {
  local a="$1"
  a="${a%:*}"            # the :port
  a="${a%%\%*}"          # a %interface suffix
  a="${a#[}"; a="${a%]}" # IPv6 brackets
  case "$a" in
    127.*|::1|::ffff:127.*) return 0 ;;
    *) return 1 ;;
  esac
}

# ── 1. listeners ───────────────────────────────────────────────────
module_ports="3000 3211 3213"
if ! listeners="$(ss -ltnH 2>/dev/null)"; then
  echo "posture-check: ss -ltnH failed" >&2; exit 2
fi
for port in $module_ports; do
  locals="$(printf '%s\n' "$listeners" | awk -v p=":$port" 'length($4) > length(p) && substr($4, length($4) - length(p) + 1) == p { print $4 }' | sort -u)"
  if [ -z "$locals" ]; then
    info "listeners :$port — nothing is listening (the health checks own a down service)"
    continue
  fi
  bad=""
  for a in $locals; do is_loopback "$a" || bad="$bad $a"; done
  if [ -n "$bad" ]; then
    fail "listeners :$port is bound beyond loopback:$bad — expected 127.0.0.1 only. The site binds through pm2-start.cjs (next start -H 127.0.0.1); brain-api/skills-host through NODE_OPTIONS=--require /usr/local/lib/aiwebsite/listen-loopback.cjs in the rendered ecosystem. A process started outside the ecosystem (a hand 'pm2 start', an old dump) does not carry it: as the deploy user in /var/www/aiwebsite, pm2 startOrReload deploy/ecosystem.config.cjs --only <app> --update-env, then re-run this check."
  else
    ok "listeners :$port loopback only ($(printf '%s' "$locals" | tr '\n' ' ' | sed 's/ $//'))"
  fi
done
others="$(printf '%s\n' "$listeners" | awk '{ print $4 }' | while read -r a; do
  [ -n "$a" ] || continue
  p="${a##*:}"
  case " $module_ports 22 " in *" $p "*) continue ;; esac
  is_loopback "$a" || echo "$a"
done | sort -u | tr '\n' ' ' | sed 's/ $//')"
[ -z "$others" ] || info "listeners: other non-loopback TCP listeners (not module-owned, not a failure): $others"

# ── 2. boot ────────────────────────────────────────────────────────
unit="pm2-${user}.service"
home="$(getent passwd "$user" | cut -d: -f6)"
before=$fails
load="$(systemctl show -p LoadState --value "$unit" 2>/dev/null || true)"
if [ "$load" != "loaded" ]; then
  fail "boot $unit does not exist (LoadState=${load:-unknown}) — after a reboot no pm2 daemon starts and the site stays down. The next deploy arms it (setup-vm: sudo env PATH=\$PATH pm2 startup systemd -u $user --hp $home)."
else
  enabled="$(systemctl is-enabled "$unit" 2>/dev/null || true)"
  [ "$enabled" = "enabled" ] || fail "boot $unit is not enabled (is-enabled=${enabled:-unknown}) — it will not start at boot. Fix: sudo systemctl enable $unit (or let the next deploy re-arm it)."
  unit_user="$(systemctl show -p User --value "$unit" 2>/dev/null || true)"
  [ "$unit_user" = "$user" ] || fail "boot $unit runs as '${unit_user:-root}', not $user — it would resurrect another account's (or root's empty) pm2."
  exec_start="$(systemctl show -p ExecStart --value "$unit" 2>/dev/null || true)"
  exe="$(printf '%s' "$exec_start" | sed -n 's/.*path=\([^ ;]*\).*/\1/p' | head -1)"
  argv="$(printf '%s' "$exec_start" | sed -n 's/.*argv\[\]=\([^;]*\).*/\1/p' | head -1)"
  if [ -z "$exe" ] || [ ! -x "$exe" ]; then
    fail "boot $unit ExecStart '${exe:-unset}' is missing or not executable — the unit would fail at boot (a removed node tree takes its pm2 with it). The next deploy re-arms it from the pm2 on PATH."
  fi
  case " $argv " in *" resurrect "*) ;; *) fail "boot $unit ExecStart does not run 'pm2 resurrect' (argv: ${argv:-unset})." ;; esac
  unit_path=""; unit_pm2_home=""
  # read -a, not an unquoted $(…): no glob expansion of the unit's values.
  read -r -a unit_env <<< "$(systemctl show -p Environment --value "$unit" 2>/dev/null || true)"
  for kv in "${unit_env[@]}"; do
    case "$kv" in
      PATH=*) unit_path="${kv#PATH=}" ;;
      PM2_HOME=*) unit_pm2_home="${kv#PM2_HOME=}" ;;
    esac
  done
  [ "$unit_pm2_home" = "$home/.pm2" ] || fail "boot $unit PM2_HOME is '${unit_pm2_home:-unset}', not $home/.pm2 — it would resurrect a different (empty) dump."
  # No Environment=PATH= in the unit: systemd's default PATH applies (refuter A-N10).
  if [ -z "$unit_path" ]; then unit_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin"; fi
  node_at=""
  IFS=: read -r -a path_dirs <<< "$unit_path"
  for d in "${path_dirs[@]}"; do
    if [ -n "$d" ] && [ -x "$d/node" ]; then node_at="$d/node"; break; fi
  done
  [ -n "$node_at" ] || fail "boot $unit PATH resolves no node — pm2's '#!/usr/bin/env node' would fail at boot (PATH=${unit_path:-unset})."
  if [ "$fails" -eq "$before" ]; then
    ok "boot $unit enabled, User=$user, ExecStart $exe resurrect, PM2_HOME $unit_pm2_home, node $node_at"
  fi
  pidf="$home/.pm2/pm2.pid"
  if [ -r "$pidf" ]; then
    god="$(tr -dc '0-9' < "$pidf")"
    cg="$(cut -d: -f3 "/proc/${god:-0}/cgroup" 2>/dev/null | head -1)"
    case "$cg" in
      */"$unit") info "boot the pm2 daemon (pid $god) runs inside $unit" ;;
      "") info "boot $pidf names pid ${god:-?}, which is not running" ;;
      *) info "boot the pm2 daemon (pid $god) runs OUTSIDE $unit (cgroup $cg): boot start still works; shutdown order and the needrestart exclusion apply only inside the unit — moving it is a live bounce, an operator's step (S11 B3), never a deploy's" ;;
    esac
  fi
fi

if [ "$fails" -gt 0 ]; then
  echo "posture-check: $fails FAIL line(s)"
  exit 1
fi
echo "posture-check: posture holds"
exit 0
