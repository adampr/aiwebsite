#!/usr/bin/env bash
# aicompany-template: posture-check.sh.tpl@4ede9549d833f7b3ddeda013921a7e3ce236bf4856365af091215ab8aa254045
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
#   3. app account (v1.175.0, §9.10) — only while the app account split is
#      active (APP_USER rendered AND /etc/aiwebsite/app-user names it): one pm2
#      daemon, the unit's, running as the app account; the deploy user's old
#      unit off; no app process as the deploy user; the pm2 drift check clean
#      (live and dump) and no unacknowledged repaired drift; no pm2 module,
#      crontab, ~/.ssh or ~/.npmrc under the app account. --user defaults to the
#      app account then.
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

# >>> app-user-active
# §9.10 (v1.175.0): the app account split is ACTIVE only when the rendered name
# is set AND the root-owned marker names it. This region is byte-identical in
# every template that carries it (tests/app-user-split.test.ts pins that).
app_user='aiwebsite'
app_user_marker="/etc/aiwebsite/app-user"
app_user_active() {
  [ -n "$app_user" ] || return 1
  [ -f "$app_user_marker" ] && [ ! -L "$app_user_marker" ] || return 1
  [ "$(stat -c %u "$app_user_marker" 2>/dev/null)" = "0" ] || return 1
  [ "$(head -n 1 "$app_user_marker" 2>/dev/null)" = "$app_user" ]
}
# <<< app-user-active

user=""
while [ $# -gt 0 ]; do
  case "$1" in
    --user)
      if [ $# -lt 2 ] || [ -z "$2" ]; then echo "posture-check: --user needs a name" >&2; exit 2; fi
      user="$2"; shift 2 ;;
    *) echo "posture-check: unknown argument '$1'" >&2; exit 2 ;;
  esac
done
if [ -z "$user" ] && app_user_active; then user="$app_user"; fi
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

# ── 3. app account (v1.175.0, §9.10) ───────────────────────────────
# >>> app-user-posture
if app_user_active; then
  tree_user="$(stat -c %U "/var/www/aiwebsite" 2>/dev/null || true)"
  app_home="/home/$app_user"
  app_env_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  if [ -n "" ]; then app_env_path=":$app_env_path"; fi
  # root (the watchdog) reads through runuser; the deploy user through sudo -n.
  # The drift check `require`s the tree's ecosystem, so it never runs as root.
  priv()    { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo -n "$@"; fi; }
  as_tree() { if [ "$(id -u)" -eq 0 ]; then runuser -u "$tree_user" -- "$@"; else "$@"; fi; }
  app_cli() {
    if [ "$(id -u)" -eq 0 ]; then
      runuser -u "$app_user" -- env -i HOME="$app_home" PM2_HOME="$app_home/.pm2" PATH="$app_env_path" LANG=C.UTF-8 NPM_CONFIG_USERCONFIG="/etc/aiwebsite/npmrc-empty" pm2 "$@"
    else
      sudo -n -u "$app_user" -H env -i HOME="$app_home" PM2_HOME="$app_home/.pm2" PATH="$app_env_path" LANG=C.UTF-8 NPM_CONFIG_USERCONFIG="/etc/aiwebsite/npmrc-empty" pm2 "$@"
    fi
  }
  before=$fails
  old_unit="pm2-$tree_user.service"
  if systemctl is-enabled --quiet "$old_unit" 2>/dev/null || systemctl is-active --quiet "$old_unit" 2>/dev/null; then
    fail "app $old_unit is enabled or active while the apps belong to $app_user — two pm2 daemons at boot. Fix: sudo systemctl disable --now $old_unit"
  fi
  gods="$(pgrep -f 'PM2 v[0-9.]+: God Daemon' 2>/dev/null || true)"
  ngods="$(printf '%s\n' "$gods" | grep -c . || true)"
  main="$(systemctl show -p MainPID --value "pm2-$app_user.service" 2>/dev/null || echo 0)"
  if [ "$ngods" != "1" ]; then
    fail "app $ngods pm2 God daemons are running — exactly one may, inside pm2-$app_user.service. A bare 'pm2' as another account starts one: use bash deploy/app-user.sh pm2 <args>"
  else
    gu="$(ps -o user:32= -p "$gods" 2>/dev/null | tr -d ' ')"
    if [ "$gu" != "$app_user" ] || [ "$gods" != "$main" ]; then
      fail "app the pm2 God daemon (pid $gods, user ${gu:-?}) is not pm2-$app_user.service's MainPID (${main:-0})"
    fi
  fi
  if pgrep -u "$tree_user" -f 'next-server|apps/(brain-api|skills-host)/src/server.ts' >/dev/null 2>&1; then
    fail "app an app process runs as $tree_user, not $app_user"
  fi
  dc="/usr/local/lib/aiwebsite/pm2-drift-check.cjs"
  if [ ! -f "$dc" ]; then
    fail "app $dc is not installed — bash deploy/app-user.sh ensure installs the root-owned copy"
  elif systemctl is-active --quiet "pm2-$app_user.service"; then
    drift="$(app_cli jlist 2>/dev/null | as_tree node "$dc" --live - 2>&1)" \
      || fail "app pm2 drift (live): $(printf '%s\n' "$drift" | grep -E '^(DRIFT|pm2-drift-check)' | head -3 | tr '\n' ' ')— bash deploy/app-user.sh pm2 … repairs (deploy/RUNBOOK.md: App account)"
    drift="$(priv cat "$app_home/.pm2/dump.pm2" 2>/dev/null | as_tree node "$dc" --dump - 2>&1)" \
      || fail "app pm2 drift (saved dump): $(printf '%s\n' "$drift" | grep -E '^(DRIFT|pm2-drift-check)' | head -3 | tr '\n' ' ')"
  fi
  if [ -e "/var/lib/aiwebsite/pm2-drift-found" ]; then
    fail "app a deploy found and repaired pm2 drift ($(head -c 300 "/var/lib/aiwebsite/pm2-drift-found" 2>/dev/null | tr -d '\n')) — find out who changed the app account's pm2 state, then: sudo rm /var/lib/aiwebsite/pm2-drift-found"
  fi
  if [ -n "$(priv find "$app_home/.pm2/modules" -mindepth 1 -maxdepth 1 2>/dev/null | head -1)" ]; then
    fail "app a pm2 module is installed under $app_user ($app_home/.pm2/modules): code the daemon runs at every start, rewritable by the app — bash deploy/app-user.sh pm2 uninstall <name>"
  fi
  if priv test -e "/var/spool/cron/crontabs/$app_user"; then fail "app $app_user has a crontab (cron.deny lists it: someone with root wrote one)"; fi
  for p in .ssh .npmrc .config/npm; do
    if priv test -e "$app_home/$p"; then fail "app $app_home/$p exists — the app account must have none"; fi
  done
  if [ "$fails" -eq "$before" ]; then
    ok "app the apps run as $app_user in pm2-$app_user.service only; the pm2 state matches the ecosystem; no module, crontab, ~/.ssh or ~/.npmrc foothold"
  fi
fi
# <<< app-user-posture

if [ "$fails" -gt 0 ]; then
  echo "posture-check: $fails FAIL line(s)"
  exit 1
fi
echo "posture-check: posture holds"
exit 0
