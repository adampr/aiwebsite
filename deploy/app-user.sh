#!/usr/bin/env bash
# aicompany-template: app-user.sh.tpl@b3d0edf8d47ac5d10479eff510d2b3cb868b10782b128a0388510d8fcaf95318
# aiwebsite app account handoff (v1.175.0, architecture.md §9.10; S12 P1, owner
# ruling 2026-10-25 "Go, both sites"). Moves the site, brain-api, skills-host and
# the extra services off the deploy user (passwordless sudo) onto their own
# least-privilege account 'aiwebsite': no sudo, no password, no login shell, no
# cron or at, refused by sshd. The code stays the deploy user's and unwritable by
# the app; only the state paths below are the app's.
#
# Inert unless APP_USER is set in deploy/site-deploy.env (rendered below), and the
# rendered scripts on the VM change behaviour only while the ROOT-OWNED marker
# /etc/aiwebsite/app-user names that account: `migrate` writes it once the old
# daemon is stopped and the state is moved, `rollback` removes it FIRST. Deploy
# the host commit that sets APP_USER BEFORE `migrate`, so every rendered script
# on the box already understands the marker.
#
# Run as the deploy user (the owner of /var/www/aiwebsite), never as root:
#   bash deploy/app-user.sh preflight   read-only: is this box ready? (exit 0/1)
#   bash deploy/app-user.sh migrate     the window: stop, move, re-own, start (journaled, idempotent)
#   bash deploy/app-user.sh verify      read-only: every invariant, exit 0/1
#   bash deploy/app-user.sh rollback    the journal in reverse (2-5 min)
#   bash deploy/app-user.sh ensure      root-owned units, drop-ins, logrotate (setup-vm calls it)
#   bash deploy/app-user.sh pm2 <args>  pm2 as the app account; never starts a daemon
#   bash deploy/app-user.sh status      which mode the box is in
#
# The STATE paths (the app's): data/ (sticky, so it cannot remove the deploy
# side's files), the .next write paths of each generation, packages/brain/data
# (the brain's registry refresh rewrites it by rename), /home/aiwebsite.
# Everything else in /var/www/aiwebsite is CODE: deploy-user-owned, never other-writable.
# No secret is printed, and no secrets file is ever copied: .env is re-owned in
# place, the old pm2 dump stays where it is (closed out by literal-path shred).
set -euo pipefail

app_dir="/var/www/aiwebsite"
stage_dir="/var/www/aiwebsite.stage"
slug="aiwebsite"
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
# >>> app-user-procs
# §9.10 (v1.175.2): app_pids <pgrep args…> prints the pids pgrep finds that are
# APP processes. `pgrep -f` matches the whole command line, so it also finds
# every observer whose argv merely names the pattern: an ssh `bash -c '… | grep
# next-server'`, that grep, a watch, a sudo (roleplay, 2026-10-26: verify and
# posture FAILed on the operator's own ssh command). A pid counts only when its
# process name (comm) is node's or the title an app process gives itself:
# `next-server (v…` (Next), `PM2 v…` (the God daemon), `node <exec path>` (pm2's
# fork container); the tsx child that runs brain-api/skills-host keeps `node`. A
# shell, grep, ssh or sudo keeps its own program name whatever its argv says.
# comm, not /proc/<pid>/exe: comm is readable for every process by every account
# (posture runs as root and as the deploy user; the God check reads the app
# account's daemon as the deploy user, where exe is EACCES), and a pid that exits
# between pgrep and the read prints nothing and is dropped. This region is
# byte-identical in app-user.sh and posture-check.sh (a test pins that).
app_pids() {
  local p c
  for p in $(pgrep "$@" 2>/dev/null || true); do
    c="$(ps -o comm= -p "$p" 2>/dev/null || true)"
    case "$c" in node*|next-server*|'PM2 v'*) printf '%s\n' "$p" ;; esac
  done
}
# <<< app-user-procs
app_home="/home/$app_user"
journal="/var/lib/aiwebsite/app-user.journal"
npmrc_empty="/etc/aiwebsite/npmrc-empty"
pm2_unit="pm2-$app_user.service"
pm2_unit_file="/etc/systemd/system/$pm2_unit"
dropin_name="60-aicompany-app-user.conf"
logrotate_file="/etc/logrotate.d/aiwebsite-pm2-app"
sshd_dropin="/etc/ssh/sshd_config.d/05-aicompany-deny-app-user.conf"
deploy_marker="/var/run/aiwebsite-deploy-in-progress"
deploy_lock="/var/run/aiwebsite-deploy.lock"
host_units_file="$app_dir/deploy/app-user-units.txt"
# Module timer units whose work is app code (the crawl, the blog). The hi-speed
# gate stays on the deploy user on purpose: it writes the root-drained issue
# spool, which the app account must never be able to write (§9.10).
module_units=("aiwebsite-knowledge.service" "aiwebsite-blog.service" "aiwebsite-blog-digest.service")
# data/ files the DEPLOY side writes in place (the synth sweep over ssh, the
# deploy's rsync, the hi-speed unit): they stay the deploy user's, and data/ is
# sticky, so the app account can neither rewrite nor replace them with a link.
deploy_written=(synth-last-sweep GeoLite2-ASN.mmdb hi-speed-last-run hi-speed-pass-streak hi-speed-open-issues.md)
# Next 16.4 runtime writes (file-system-cache.js getFilePath; image-optimizer.js
# cacheDir): the fetch and image caches, the ISR output of both routers, and
# the scoped route cache.
next_write_paths=(cache server/app server/pages server/route-cache)
toolchain_prefix=''
app_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
if [ -n "$toolchain_prefix" ]; then app_path="$toolchain_prefix:$app_path"; export PATH="$toolchain_prefix:$PATH"; fi
site_health="http://127.0.0.1:3000/api/health"
brain_health="http://127.0.0.1:3211/health"
skills_health="http://127.0.0.1:3213/health"

die()  { echo "ERROR: $*" >&2; exit 1; }
say()  { echo ">>> $*"; }
fails=0
ok()   { echo "OK   $*"; }
info() { echo "INFO $*"; }
fail() { echo "FAIL $*"; fails=$((fails + 1)); }

cmd="${1:-}"
[ $# -gt 0 ] && shift

if [ -z "$app_user" ]; then
  echo "app-user: APP_USER is empty in deploy/site-deploy.env — this host runs its apps as the deploy user (§9.10); nothing to do."
  [ "$cmd" = "status" ] && exit 0
  exit 2
fi
[ "$(id -u)" -ne 0 ] || die "run as the deploy user (the owner of $app_dir), not as root"
deploy_user="$(id -un)"
[ "$deploy_user" != "$app_user" ] || die "run as the deploy user, not as $app_user"

# ── journal (root-owned, in the root:<deploy> 2775 /var/lib/aiwebsite) ──────────
# An epoch is everything after the last `complete rollback`, so a migrate that
# follows a rollback records fresh "pre" values.
j_add()   { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | sudo -n tee -a "$journal" >/dev/null; sudo -n chmod 600 "$journal"; }
j_epoch() { { sudo -n cat "$journal" 2>/dev/null || true; } | cut -d' ' -f2- | awk '/^complete rollback/{buf=""; next} {buf=buf $0 "\n"} END{printf "%s", buf}'; }
j_has()   { j_epoch | grep -xF -- "$1" >/dev/null; }   # no -q: grep reads it all (pipefail-safe)
# pre <key> <value…>: the first value recorded in this epoch, or $2 when none.
j_pre()   { local v; v="$(j_epoch | awk -v k="$1" '$1=="pre" && $2==k && !f {sub(/^pre [^ ]+ /,""); print; f=1}')"; printf '%s' "${v:-$2}"; }
j_pre_once() { j_epoch | awk -v k="$1" '$1=="pre" && $2==k {f=1} END{exit !f}' || j_add "pre $1 $2"; }

# ── the pm2 CLI as the app account, clean environment, never a daemon start ──
pm2_bin() { readlink -f "$(command -v pm2)" 2>/dev/null || true; }
as_app() {
  sudo -n -u "$app_user" -H env -i HOME="$app_home" PATH="$app_path" LANG=C.UTF-8 \
    NPM_CONFIG_USERCONFIG="$npmrc_empty" "$@"
}
app_pm2() {   # only while pm2-<app>.service is active: a CLI call must never spawn a daemon
  systemctl is-active --quiet "$pm2_unit" || { echo "app-user: $pm2_unit is not active — not running 'pm2 $*' (it would start a daemon outside the unit)" >&2; return 1; }
  as_app PM2_HOME="$app_home/.pm2" "$(pm2_bin)" "$@"
}

take_lock() {   # the deploy lock (fd 200, as setup-vm) + the marker the watchdog defers on
  sudo -n touch "$deploy_lock"
  sudo -n chown "$deploy_user" "$deploy_lock"
  exec 200>"$deploy_lock"
  flock -n 200 || die "another deploy holds $deploy_lock — wait for it"
  sudo -n touch "$deploy_marker"   # the watchdog defers every repair action while this is fresh
}

wait_http() {  # <url> <seconds> <needle or empty>
  local i body
  for i in $(seq 1 $(( $2 / 5 ))); do
    body="$(curl -fsS -m 5 "$1" 2>/dev/null)" || body=""
    if [ -n "$body" ] && { [ -z "$3" ] || printf '%s' "$body" | grep -- "$3" >/dev/null; }; then return 0; fi
    sleep 5
  done
  return 1
}

# ══ ensure: the root-owned pieces, idempotent (migrate and every split deploy) ══
unit_text() {
  local bin="$1"
  cat <<UNIT
# Managed by @aicompany/core deploy/app-user.sh (§9.10, v1.175.0) — do not edit.
# pm2 for aiwebsite under its own account. The daemon starts ONLY here (or from
# setup-vm's wrapper, which starts this unit first); a pm2 CLI call never may.
[Unit]
Description=PM2 process manager for aiwebsite (app account $app_user)
Documentation=https://pm2.keymetrics.io/
After=network.target postgresql.service

[Service]
Type=forking
User=$app_user
Group=$app_user
UMask=0022
NoNewPrivileges=yes
LimitNOFILE=infinity
LimitNPROC=infinity
LimitCORE=infinity
Environment=PATH=$app_path
Environment=HOME=$app_home
Environment=PM2_HOME=$app_home/.pm2
Environment=NPM_CONFIG_USERCONFIG=$npmrc_empty
PIDFile=$app_home/.pm2/pm2.pid
Restart=on-failure

ExecStart=$bin resurrect
ExecReload=$bin reload all
ExecStop=$bin kill

[Install]
WantedBy=multi-user.target
UNIT
}
dropin_text() {
  cat <<DROPIN
# Managed by @aicompany/core deploy/app-user.sh (§9.10, v1.175.0) — do not edit.
# This unit's work is app code: it runs as the app account, reads no ~/.npmrc,
# and can never gain privileges (no sudo, no setuid).
[Service]
User=$app_user
Group=$app_user
NoNewPrivileges=yes
Environment=HOME=$app_home
Environment=NPM_CONFIG_USERCONFIG=$npmrc_empty
DROPIN
}
logrotate_text() {
  cat <<LOGROTATE
# Managed by @aicompany/core deploy/app-user.sh (§9.10, v1.175.0) — do not edit.
# The app account's pm2 logs. No pm2-logrotate module under that account: a pm2
# module is code the daemon runs at every start from a directory the app owns.
# su: logrotate acts in the app's own directory with the app's own rights.
# pm2.log (the God daemon's own log, v1.175.2) shares the stanza, so it gets
# exactly the options of the apps' logs; copytruncate keeps the daemon's fd.
$app_home/.pm2/logs/*.log $app_home/.pm2/pm2.log {
    su $app_user $app_user
    daily
    maxsize 10M
    rotate 7
    missingok
    notifempty
    copytruncate
    compress
    delaycompress
}
LOGROTATE
}
host_units() {   # deploy/app-user-units.txt: one aiwebsite-*.service per line, # comments
  [ -f "$host_units_file" ] || return 0
  local u
  while IFS= read -r u || [ -n "$u" ]; do
    u="${u%$'\r'}"; u="${u%%#*}"; u="$(printf '%s' "$u" | tr -d '[:space:]')"
    [ -n "$u" ] || continue
    if ! printf '%s' "$u" | grep -qE "^aiwebsite-[a-z0-9][a-z0-9.@_-]*\.service$"; then
      echo "app-user: ignoring '$u' in deploy/app-user-units.txt (must be aiwebsite-<name>.service)" >&2
      continue
    fi
    printf '%s\n' "$u"
  done < "$host_units_file"
}
install_if_changed() {  # <dest> <mode>   (content on stdin) → prints "changed" when it wrote
  local tmp; tmp="$(mktemp)"
  cat > "$tmp"
  if sudo -n cmp -s "$tmp" "$1" 2>/dev/null; then rm -f "$tmp"; return 0; fi
  sudo -n install -o root -g root -m "$2" "$tmp" "$1"
  rm -f "$tmp"
  echo changed
}
do_ensure() {
  getent passwd "$app_user" >/dev/null || die "account $app_user does not exist — run migrate first"
  local bin changed="" u
  bin="$(pm2_bin)"
  [ -n "$bin" ] && [ -x "$bin" ] || die "no pm2 on PATH"
  case "$bin" in /home/*) die "pm2 resolves to $bin, under a home directory the app account cannot read — install Node and pm2 system-wide first (§9.10, roleplay R0)";; esac
  sudo -n install -d -o root -g root -m 755 "/etc/aiwebsite"
  [ -f "$npmrc_empty" ] || sudo -n install -o root -g root -m 644 /dev/null "$npmrc_empty"
  [ -n "$(unit_text "$bin" | install_if_changed "$pm2_unit_file" 644)" ] && { changed=1; say "wrote $pm2_unit_file (a running daemon keeps its settings until its next restart)"; }
  for u in "${module_units[@]}" $(host_units); do
    if [ ! -f "/etc/systemd/system/$u" ]; then
      [ -f "/etc/systemd/system/$u.d/$dropin_name" ] || { info "ensure: $u is not installed here — no drop-in"; continue; }
    fi
    sudo -n install -d -o root -g root -m 755 "/etc/systemd/system/$u.d"
    [ -n "$(dropin_text | install_if_changed "/etc/systemd/system/$u.d/$dropin_name" 644)" ] && { changed=1; say "wrote $u.d/$dropin_name (runs as $app_user)"; }
  done
  [ -n "$(logrotate_text | install_if_changed "$logrotate_file" 644)" ] && say "wrote $logrotate_file"
  # The posture check (root, hourly) runs this root-owned copy, never the tree's file.
  sudo -n install -d -o root -g root -m 755 "/usr/local/lib/aiwebsite"
  sudo -n install -o root -g root -m 644 "$app_dir/deploy/pm2-drift-check.cjs" "/usr/local/lib/aiwebsite/pm2-drift-check.cjs"
  [ -z "$changed" ] || sudo -n systemctl daemon-reload
  sudo -n systemctl enable "$pm2_unit" >/dev/null 2>&1 || die "systemctl enable $pm2_unit failed"
}

# ══ preflight (read-only) ═══════════════════════════════════════════════════
do_preflight() {
  local owner anc d u n gods
  fails=0
  echo "app-user preflight: aiwebsite, app account $app_user, deploy user $deploy_user ($(date -u +%FT%TZ))"
  owner="$(stat -c %U "$app_dir" 2>/dev/null || echo '?')"
  [ "$owner" = "$deploy_user" ] && ok "deploy user $deploy_user owns $app_dir" || fail "$app_dir is owned by '$owner', not by the deploy user $deploy_user"
  sudo -n true 2>/dev/null && ok "the deploy user has non-interactive sudo" || fail "sudo -n is refused for $deploy_user"
  case "$app_dir" in /home|/home/*) fail "$app_dir is under /home (render refuses this; R8 moves the tree first)";; esac
  anc="$app_dir"; n=$fails
  while [ "$anc" != "/" ]; do
    anc="$(dirname "$anc")"
    d="$(stat -c '%U %a' "$anc" 2>/dev/null || echo '? 777')"
    if [ "${d% *}" != "root" ] || [ $(( 8#${d#* } & 8#022 )) -ne 0 ]; then
      fail "$anc ($d) — every ancestor of $app_dir must be root-owned and not group/other-writable, or the code tree could be swapped"
    fi
  done
  [ "$fails" -eq "$n" ] && ok "every ancestor of $app_dir is root-owned and not group/other-writable"
  if getent passwd "$app_user" >/dev/null; then
    IFS=: read -r _ _ u _ _ d n <<< "$(getent passwd "$app_user")"
    if [ "$u" -ge 1000 ] || [ "$d" != "$app_home" ] || [ "${n##*/}" != "nologin" ]; then
      fail "account $app_user exists but is not the system account migrate creates (uid $u, home $d, shell $n) — a human must look"
    else
      ok "account $app_user exists (system uid $u, $d, nologin)"
    fi
    for g in sudo adm admin wheel "$deploy_user"; do
      id -nG "$app_user" | tr ' ' '\n' | grep -xF -- "$g" >/dev/null && fail "$app_user is in group $g"
    done
  else
    ok "account $app_user is free (migrate creates it)"
  fi
  for t in node npm npx pm2; do
    u="$(readlink -f "$(command -v "$t" 2>/dev/null)" 2>/dev/null || true)"
    case "$u" in
      "") fail "$t is not on PATH";;
      /home/*) fail "$t resolves to $u, under a home directory the app account cannot read (R0: install Node and pm2 system-wide)";;
      *) ok "$t → $u";;
    esac
  done
  for k in fs.protected_hardlinks fs.protected_symlinks; do
    [ "$(sysctl -n "$k" 2>/dev/null)" = "1" ] && ok "$k = 1" || fail "$k is not 1 — root's deletes and the deploy side's writes rely on it"
  done
  if [ -f "$app_dir/node_modules/playwright-core/package.json" ]; then
    fail "playwright-core is installed: its browser lives under the deploy user's ~/.cache (stage-build.sh browser) — not supported with an app account in this release"
  fi
  if [ -f "$deploy_marker" ] && [ $(( $(date +%s) - $(stat -c %Y "$deploy_marker") )) -lt 1800 ]; then
    fail "a deploy marker is fresher than 30 min ($deploy_marker) — another deploy may be running"
  else
    ok "no deploy in progress"
  fi
  n="$(systemctl list-units --type=service --state=active,activating --no-legend --plain "aiwebsite-*" 2>/dev/null | awk '{print $1}' | grep -vE "^aiwebsite-(psi-log|peer-monitor)\.service$" || true)"
  [ -z "$n" ] && ok "no aiwebsite job is running" || fail "running now: $(printf '%s' "$n" | tr '\n' ' ') — wait for it to finish"
  for f in setup-vm.sh watchdog.sh posture-check.sh stage-build.sh extra-services.sh; do
    if grep -qxF "app_user='$app_user'" "$app_dir/deploy/$f" 2>/dev/null; then ok "deploy/$f on this box is rendered with APP_USER=$app_user"
    else fail "deploy/$f on this box does not carry APP_USER=$app_user — deploy the host commit that sets APP_USER first"; fi
  done
  for f in "/usr/local/bin/aiwebsite-watchdog.sh" "/usr/local/bin/aiwebsite-posture-check.sh"; do
    grep -qxF "app_user='$app_user'" "$f" 2>/dev/null && ok "$f is the APP_USER render" || fail "$f is not the APP_USER render (the host deploy installs it)"
  done
  sudo -n sshd -t 2>/dev/null && ok "sshd -t passes now" || fail "sshd -t fails BEFORE any change — fix sshd first"
  gods="$(app_pids -f 'PM2 v[0-9.]+: God Daemon' | grep -c . || true)"
  [ "$gods" -le 1 ] && ok "pm2 God daemons: $gods" || fail "$gods pm2 God daemons are running — exactly one may"
  if app_user_active; then
    info "the split is ACTIVE ($app_user_marker names $app_user): migrate resumes or no-ops"
  else
    n="$(pm2 jlist 2>/dev/null | jq -r '.[].name' 2>/dev/null | sort -u | tr '\n' ' ' || true)"
    for u in $n; do case "$u" in "aiwebsite"|brain-api|skills-host|pm2-logrotate) ;; *) fail "stray pm2 app '$u' under $deploy_user — remove it before the window";; esac; done
    info "pm2 apps under $deploy_user: ${n:-none}"
  fi
  d="$(df -Pm "$app_dir" | awk 'NR==2{print $4}')"; info "free on the app filesystem: ${d} MB (migrate renames, it copies nothing)"
  for f in "${deploy_written[@]}"; do [ -e "$app_dir/data/$f" ] && info "deploy-written data/$f: $(stat -c '%U:%G %a' "$app_dir/data/$f")"; done
  [ -d "/home/$deploy_user/software-brain-data" ] && info "brain data /home/$deploy_user/software-brain-data → $app_home/software-brain-data ($(du -sh "/home/$deploy_user/software-brain-data" 2>/dev/null | cut -f1), a rename)"
  [ -f "$host_units_file" ] && info "host units that will run as $app_user: $(host_units | tr '\n' ' ')"
  [ -f /var/run/reboot-required ] && info "a reboot is pending (the window's reboot boots $(ls -t /boot/vmlinuz-* 2>/dev/null | head -1 | sed 's#/boot/vmlinuz-##'))"
  echo "app-user preflight: $fails FAIL line(s)"
  [ "$fails" -eq 0 ]
}

# ══ migrate ═════════════════════════════════════════════════════════════════
do_migrate() {
  if j_has "complete migrate"; then say "already migrated in this journal epoch — run verify (or rollback)"; return 0; fi
  if ! j_has "step stop done"; then
    do_preflight || die "preflight failed — nothing was changed"
  fi
  take_lock
  j_has "start migrate" || j_add "start migrate"

  # 1. the account and its lockdown
  if ! j_has "step accounts done"; then
    say "1/7 account $app_user, cron/at deny, sshd DenyUsers"
    getent passwd "$app_user" >/dev/null || sudo -n useradd --system --user-group --create-home --home-dir "$app_home" --shell /usr/sbin/nologin "$app_user"
    sudo -n passwd -l "$app_user" >/dev/null
    sudo -n chmod 0750 "$app_home"
    sudo -n usermod -aG "$app_user" "$deploy_user"
    for f in /etc/cron.deny /etc/at.deny; do
      sudo -n touch "$f"
      sudo -n grep -qxF "$app_user" "$f" || printf '%s\n' "$app_user" | sudo -n tee -a "$f" >/dev/null
    done
    printf '# Managed by @aicompany/core deploy/app-user.sh (§9.10): the app account never logs in.\nDenyUsers %s\n' "$app_user" | sudo -n tee "$sshd_dropin" >/dev/null
    sudo -n chmod 644 "$sshd_dropin"
    if ! sudo -n sshd -t; then sudo -n rm -f "$sshd_dropin"; die "sshd -t rejected $sshd_dropin — removed it; nothing else changed in this step"; fi
    # Ubuntu 24.04 may run sshd per connection from ssh.socket; then each new
    # connection reads the config anyway and there is no daemon to reload.
    if systemctl is-active --quiet ssh; then sudo -n systemctl reload ssh
    elif systemctl is-active --quiet sshd; then sudo -n systemctl reload sshd; fi
    j_add "step accounts done"
  fi

  # 2. stop every app process (extra services, then the deploy user's daemon)
  local old_unit="pm2-$deploy_user.service" i left
  if ! j_has "step stop done"; then
    say "2/7 stopping the extra services and the pm2 daemon of $deploy_user (the site is DOWN from here)"
    i="$(systemctl is-enabled "$old_unit" 2>/dev/null)" || true
    j_pre_once old-unit-enabled "${i:-absent}"
    # The deploy marker stays until "migrate complete". A deploy started within 30 min of
    # its last touch stops with DEPLOY-BUSY; after a migrate that died (e.g. a step-6 drift
    # stop), if the marker is that migrate's own, the fix is deployed with --takeover.
    sudo -n touch "$deploy_marker"
    if [ -f "$app_dir/deploy/extra-services.json" ]; then sudo -n bash "$app_dir/deploy/extra-services.sh" stop 200>&-; fi
    if systemctl is-active --quiet "$old_unit"; then sudo -n systemctl stop "$old_unit"; fi
    if [ -n "$(app_pids -u "$deploy_user" -f 'PM2 v[0-9.]+: God Daemon')" ]; then pm2 kill 200>&- >/dev/null 2>&1 || true; fi
    for i in $(seq 1 30); do
      [ -n "$(app_pids -u "$deploy_user" -f 'PM2 v[0-9.]+: God Daemon|next-server|apps/(brain-api|skills-host)/src/server.ts')" ] || break
      sleep 1
    done
    left="$(app_pids -u "$deploy_user" -f 'PM2 v[0-9.]+: God Daemon|next-server|apps/(brain-api|skills-host)/src/server.ts' | tr '\n' ' ')"
    [ -z "$left" ] || die "app processes of $deploy_user are still running after 30 s (pids $left) — nothing was re-owned; inspect, then re-run migrate (or rollback)"
    j_add "step stop done"
  fi

  # 3. state: move, re-own (every app process is stopped)
  if ! j_has "step state done"; then
    say "3/7 state: brain data, data/, .next write paths, packages/brain/data, .env, code o-w, stage 0750"
    local src="/home/$deploy_user/software-brain-data" dst="$app_home/software-brain-data" e name gen p
    if sudo -n test -d "$src" && ! sudo -n test -e "$dst"; then
      sudo -n mv -T "$src" "$dst"; j_add "moved $src $dst"
    elif sudo -n test -d "$src" && sudo -n test -e "$dst"; then
      die "both $src and $dst exist — a human must merge them; nothing else changed in this step"
    fi
    sudo -n test -d "$dst" && sudo -n chown -R -P "$app_user:$app_user" "$dst"
    # data/: sticky + setgid, owned by the deploy user, group-writable by the app.
    j_pre_once data "$(stat -c '%U:%G %a' "$app_dir/data")"
    sudo -n chown "$deploy_user:$app_user" "$app_dir/data"
    sudo -n chmod 3775 "$app_dir/data"
    while IFS= read -r -d '' e; do
      name="${e##*/}"
      if printf '%s\n' "${deploy_written[@]}" | grep -xF -- "$name" >/dev/null; then
        sudo -n test -L "$e" && die "data/$name is a symbolic link — the deploy side writes it in place; a human must look"
        sudo -n chown -h "$deploy_user:$app_user" "$e"; sudo -n chmod 0644 "$e"
      else
        sudo -n chown -R -P "$app_user:$app_user" "$e"
      fi
    done < <(sudo -n find "$app_dir/data" -mindepth 1 -maxdepth 1 -print0)
    # The deploy side's in-place files must EXIST (then the sticky bit keeps the
    # app account from planting a link under their names before the first write).
    [ -e "$app_dir/data/synth-last-sweep" ]      || { date +%s > "$app_dir/data/synth-last-sweep"; }
    [ -e "$app_dir/data/hi-speed-last-run" ]     || { date +%s > "$app_dir/data/hi-speed-last-run"; }
    [ -e "$app_dir/data/hi-speed-pass-streak" ]  || { echo 0 > "$app_dir/data/hi-speed-pass-streak"; }
    [ -e "$app_dir/data/hi-speed-open-issues.md" ] || { : > "$app_dir/data/hi-speed-open-issues.md"; }
    for f in synth-last-sweep hi-speed-last-run hi-speed-pass-streak hi-speed-open-issues.md; do
      sudo -n chown -h "$deploy_user:$app_user" "$app_dir/data/$f"; sudo -n chmod 0644 "$app_dir/data/$f"
    done
    # .next write paths, in the live generation AND the N-1 one a health-gate rollback restores.
    for gen in .next .next.old; do
      [ -d "$app_dir/$gen" ] || continue
      [ -d "$app_dir/$gen/server" ] && mkdir -p "$app_dir/$gen/server/route-cache"
      mkdir -p "$app_dir/$gen/cache"
      for p in "${next_write_paths[@]}"; do
        [ -d "$app_dir/$gen/$p" ] && sudo -n chown -R -P "$app_user:$app_user" "$app_dir/$gen/$p"
      done
    done
    # packages/brain/data: the brain's in-process registry refresh writes .tmp + rename here.
    if [ -d "$app_dir/packages/brain/data" ]; then
      j_pre_once brain-data "$(stat -c '%U:%G %a' "$app_dir/packages/brain/data")"
      sudo -n chgrp -R -P "$app_user" "$app_dir/packages/brain/data"
      sudo -n chmod 2775 "$app_dir/packages/brain/data"
      sudo -n find "$app_dir/packages/brain/data" -maxdepth 1 -type f -exec chmod g+w {} +
    fi
    # .env: re-owned IN PLACE (never copied): readable by the app's group, writable by the deploy user only.
    j_pre_once env "$(stat -c '%U:%G %a' "$app_dir/.env")"
    sudo -n chown "$deploy_user:$app_user" "$app_dir/.env"
    sudo -n chmod 0640 "$app_dir/.env"
    # code: nothing other-writable (the app account is "other" to every code file).
    sudo -n find "$app_dir" -xdev \( -path "$app_dir/data" -o -path "$app_dir/.git" \) -prune -o ! -type l -perm -0002 -exec chmod o-w {} +
    # the stage holds parked generations root deletes: unreachable for the app account.
    j_pre_once stage "$(stat -c '%U:%G %a' "$stage_dir" 2>/dev/null || echo absent)"
    [ -d "$stage_dir" ] && chmod 0750 "$stage_dir"
    for p in .ssh .npmrc .config/npm; do
      sudo -n test -e "$app_home/$p" && die "$app_home/$p exists — the app account must have none; a human must look"
    done
    j_add "step state done"
  fi

  # 4. units: pm2-<app>.service + drop-ins + logrotate (root-owned), old unit off
  if ! j_has "step units done"; then
    say "4/7 $pm2_unit, unit drop-ins, logrotate; $old_unit disabled"
    do_ensure
    if [ "$(j_pre old-unit-enabled absent)" = "enabled" ]; then sudo -n systemctl disable "$old_unit" >/dev/null 2>&1 || true; fi
    j_add "step units done"
  fi

  # 5. the activation marker: from here every rendered script runs in split mode
  if ! j_has "step marker done"; then
    say "5/7 activation marker $app_user_marker"
    printf '%s\n' "$app_user" | sudo -n tee "$app_user_marker" >/dev/null
    sudo -n chown root:root "$app_user_marker"; sudo -n chmod 644 "$app_user_marker"
    app_user_active || die "the marker did not take — inspect $app_user_marker"
    j_add "step marker done"
  fi

  # 6. start: the unit (empty dump), then the ecosystem through the app account, then the checks
  if ! j_has "step start done"; then
    say "6/7 starting $pm2_unit and the apps under $app_user"
    sudo -n systemctl start "$pm2_unit"
    (cd "$app_dir" && app_pm2 startOrReload deploy/ecosystem.config.cjs --update-env 200>&-)
    # Save at once (refuter N1): until a dump exists, a reboot resurrects no app
    # and the watchdog's unit restart cannot help. These apps were started from
    # the ecosystem a second ago through the clean wrapper; the drift checks
    # below verify the live state and this dump, and save again.
    app_pm2 save 200>&- >/dev/null
    wait_http "$site_health" 120 '"status":"ok"' || die "site health did not come back within 120 s — re-run migrate (it resumes here) or run rollback; do NOT reboot first"
    wait_http "$brain_health" 60 "" || die "brain-api health did not come back within 60 s — re-run migrate (it resumes here) or run rollback; do NOT reboot first"
    wait_http "$skills_health" 60 "" || die "skills-host health did not come back within 60 s — re-run migrate (it resumes here) or run rollback; do NOT reboot first"
    # A drift stop here is read first, then resumed or rolled back (deploy/RUNBOOK.md
    # "migrate died part-way"; MIGRATIONS v1.175.1): a name pm2 itself sets that the
    # check did not know (v1.175.1's PWD) is fixed by a module bump, after which
    # migrate resumes at this step; a name or value the ecosystem does not explain
    # is real drift, and rollback is the answer.
    app_pm2 jlist 2>/dev/null | node "$app_dir/deploy/pm2-drift-check.cjs" --live - \
      || die "the pm2 drift check failed on a FRESH start (names above). Read the check first: if a module bump fixes its cause, deploy the bump and re-run migrate (it resumes at step 6) — this migrate's deploy marker stays fresh for 30 min, so a deploy before then stops with DEPLOY-BUSY; if that marker is your own migrate's (no other deploy is running), deploy the bump with --takeover; if the drift is real, run rollback. Do NOT reboot first"
    app_pm2 save 200>&- >/dev/null
    sudo -n cat "$app_home/.pm2/dump.pm2" | node "$app_dir/deploy/pm2-drift-check.cjs" --dump - \
      || die "the saved dump does not match the rendered ecosystem (names above). Read the check first: if a module bump fixes its cause, deploy the bump and re-run migrate (it resumes at step 6) — this migrate's deploy marker stays fresh for 30 min, so a deploy before then stops with DEPLOY-BUSY; if that marker is your own migrate's (no other deploy is running), deploy the bump with --takeover; if the drift is real, run rollback. Do NOT reboot first"
    j_add "step start done"
  fi

  # 7. the extra services, now under the app account
  if ! j_has "step services done"; then
    say "7/7 extra services under $app_user"
    if [ -f "$app_dir/deploy/extra-services.json" ]; then
      sudo -n bash "$app_dir/deploy/extra-services.sh" start 200>&-
      bash "$app_dir/deploy/extra-services.sh" verify || die "an extra service did not verify — run rollback"
    fi
    j_add "step services done"
  fi
  j_add "complete migrate"
  sudo -n rm -f "$deploy_marker"
  say "migrate complete — the apps run as $app_user. Next: bash deploy/app-user.sh verify, one normal deploy, the reboot."
}

# ══ verify (read-only) ══════════════════════════════════════════════════════
as_app_test() { sudo -n -u "$app_user" test "$@" 2>/dev/null; }
# processes: every pattern match goes through app_pids (an observer naming the
# pattern is not an app process, v1.175.2)
verify_processes() {
  local gods n god main p left
  gods="$(app_pids -f 'PM2 v[0-9.]+: God Daemon')"
  n="$(printf '%s\n' "$gods" | grep -c . || true)"
  god="$(printf '%s\n' "$gods" | head -1)"
  main="$(systemctl show -p MainPID --value "$pm2_unit" 2>/dev/null || echo 0)"
  [ "$n" = "1" ] && [ "$god" = "$main" ] && [ "$(ps -o user:32= -p "$god" | tr -d ' ')" = "$app_user" ] \
    && ok "one pm2 God daemon (pid $god) = $pm2_unit MainPID, user $app_user" || fail "pm2 God daemons: $n, first pid ${god:-none}, unit MainPID $main"
  left="$(app_pids -u "$deploy_user" -f 'next-server|apps/(brain-api|skills-host)/src/server.ts|PM2 v' | tr '\n' ' ')"
  [ -n "$left" ] && fail "an app process still runs as $deploy_user (pids $left)" || ok "no app process runs as $deploy_user"
  for p in next-server 'apps/brain-api/src/server.ts' 'apps/skills-host/src/server.ts'; do
    [ -n "$(app_pids -u "$app_user" -f "$p")" ] && ok "$p runs as $app_user" || fail "$p is not running as $app_user"
  done
}
# listeners (v1.175.2, a backstop independent of every name rule above): each of
# the three module ports is held by a process of the app account. ss names
# another account's socket owner only to root, so it runs through sudo; a port
# whose owner cannot be read is a FAIL, never an OK. A port nothing listens on is
# read again like the health checks (2 more reads, 5 s apart, about 10 s: a port
# mid-restart). A pid ss names that has exited by the owner read (ps exits 1 for
# a pid that no longer exists) is skipped; one that exists but reads no user is a
# FAIL; a port none of whose pids could be read is a FAIL.
ss_port_lines() { printf '%s\n' "$1" | awk -v p=":$2" 'length($4) > length(p) && substr($4, length($4) - length(p) + 1) == p'; }
verify_listeners() {
  local out port lines pids p u bad seen try
  if ! out="$(sudo -n ss -ltnpH 2>/dev/null)"; then
    fail "listeners: could not run ss -ltnp through sudo — who owns :3000 :3211 :3213 is unchecked"; return 0
  fi
  for port in 3000 3211 3213; do
    lines="$(ss_port_lines "$out" "$port")"
    for try in 2 3; do
      [ -z "$lines" ] || break
      sleep 5
      if ! out="$(sudo -n ss -ltnpH 2>/dev/null)"; then
        fail "listeners: could not run ss -ltnp through sudo — who owns :3000 :3211 :3213 is unchecked"; return 0
      fi
      lines="$(ss_port_lines "$out" "$port")"
    done
    if [ -z "$lines" ]; then fail "listeners :$port — nothing listens (read 3 times over about 10 s)"; continue; fi
    pids="$(printf '%s\n' "$lines" | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u | tr '\n' ' ' || true)"
    if [ -z "$pids" ]; then fail "listeners :$port — could not read its owner (ss printed no process)"; continue; fi
    bad=""; seen=""
    for p in $pids; do
      if u="$(ps -o user:32= -p "$p" 2>/dev/null)"; then
        u="$(printf '%s' "$u" | tr -d ' ')"; seen="$seen $p"
        [ "$u" = "$app_user" ] || bad="$bad pid $p (${u:-no user})"
      fi
    done
    if [ -n "$bad" ]; then fail "listeners :$port is held by another account:$bad — not $app_user"
    elif [ -z "$seen" ]; then fail "listeners :$port — its holders (pids $pids) exited before their owner could be read; re-run verify"
    else ok "listeners :$port held by $app_user (pids$seen)"; fi
  done
}
# Permission errors. An app account's EACCES/EPERM/EROFS lands in its pm2 logs,
# in the pm2 daemon's own log (pm2.log), in a host log a host job appends to
# (/var/log/*.log), or in the journal of the units that run as the app account,
# where systemd also writes its own words ("Failed to execute …: Permission
# denied", "status=203/EXEC", "Read-only file system") and never the codes.
# It never lands in /var/log/auth.log: that file holds sudo and sshd records,
# including the COMMAND= line sudo writes for this very scan before grep reads the
# file, so v1.175.0/.1 FAILed on their own invocation on every host, every run
# (measured on both hosts 2026-10-26), and those old lines, which carry the bare
# words, stay there until logrotate ages them out. So auth.log is not scanned,
# and every pattern is written [E]… / [P]… / [R]… so that no log line recording a
# command that carries it can match it.
# The windows, exactly (nothing is anchored to the migrate):
#   *.log files  — regular files only (-type f: a directory or a dangling link
#                  named *.log is not a log, and grep would exit 2 on it), read
#                  WHOLE when last written in the last 2 h, so an older line in
#                  such a file counts too;
#   pm2.log      — only its lines stamped in the last 2 h (pm2 7.0.3's default
#                  PM2_LOG_DATE_FORMAT prefix "YYYY-MM-DDTHH:mm:ss:", local time,
#                  compared in the same local time); an unstamped line (a stack
#                  frame) belongs to the stamp before it, lines before the first
#                  stamp to none. Two known limits, accepted (refute round 2):
#                  the stamps carry no UTC offset, so on a box not on UTC about
#                  1 h of lines can be missed after a DST fall-back; and an
#                  unstamped line written after a long quiet period inherits
#                  the older stamp, so it can be missed too;
#   the journal  — entries of the last 2 h.
# A source that cannot be read is a FAIL, never a clean pass (refuter SHOULD-1).
verify_permissions() {
  local hits="" unread="" list out rc n j since units u files=()
  if ! sudo -n true 2>/dev/null; then
    fail "permission scan: could not read any log — sudo -n is refused for $deploy_user"; return 0
  fi
  # 1. *.log files last written in the last 2 h (read whole)
  if list="$(sudo -n find "$app_home/.pm2/logs" /var/log -maxdepth 1 -type f -name '*.log' ! -name auth.log -newermt '-2 hours' -print 2>/dev/null)"; then
    [ -z "$list" ] || mapfile -t files <<< "$list"
    if [ "${#files[@]}" -gt 0 ]; then
      rc=0; out="$(sudo -n grep -lsE '[E](ACCES|PERM|ROFS)' -- "${files[@]}" 2>/dev/null)" || rc=$?
      [ "$rc" -le 1 ] || unread="${unread}the *.log files (grep exit $rc); "
      [ -z "$out" ] || hits="${hits}$(printf '%s\n' "$out" | head -5 | tr '\n' ' ' || true)"
    fi
  else
    unread="${unread}the list of *.log files written in the last 2 h; "
  fi
  # 2. pm2.log, its lines stamped in the last 2 h
  if sudo -n test -e "$app_home/.pm2/pm2.log"; then
    since="$(env -u TZ date -d '-2 hours' +%Y-%m-%dT%H:%M:%S)"
    if j="$(sudo -n cat "$app_home/.pm2/pm2.log" 2>/dev/null)"; then
      n="$(printf '%s\n' "$j" | awk -v since="$since" '
        /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]:/ { w = (substr($0, 1, 19) >= since) }
        w && /[E](ACCES|PERM|ROFS)/ { c++ }
        END { print c + 0 }')"
      [ "$n" -eq 0 ] || hits="${hits}$app_home/.pm2/pm2.log ($n lines stamped in the last 2 h) "
    else
      unread="${unread}$app_home/.pm2/pm2.log; "
    fi
  fi
  # 3. the journal of pm2-<app>.service and the app account's units, the last 2 h
  units=(-u "$pm2_unit")
  for u in "${module_units[@]}" $(host_units); do units+=(-u "$u"); done
  rc=0; j="$(sudo -n journalctl -q --no-pager --since '-2 hours' "${units[@]}" -o cat 2>/dev/null)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    unread="${unread}the journal of $pm2_unit and the app account's units (journalctl exit $rc); "
  else
    n="$(printf '%s\n' "$j" | grep -cE '[E](ACCES|PERM|ROFS)|[P]ermission denied|[R]ead-only file system' || true)"
    [ "${n:-0}" -eq 0 ] || hits="${hits}the journal of $pm2_unit and the app account's units ($n lines) "
  fi
  if [ -n "$unread" ]; then fail "permission scan: could not read ${unread}a source that cannot be read is not clean"; fi
  if [ -n "$hits" ]; then
    fail "permission errors in: $hits"
  elif [ -z "$unread" ]; then
    ok "permission scan clean: *.log files written in the last 2 h (read whole), pm2.log lines and the units' journal of the last 2 h (auth.log is not an app log)"
  fi
}
do_verify() {
  fails=0
  local n u p f code_w state_w
  echo "app-user verify: aiwebsite, app account $app_user ($(date -u +%FT%TZ))"
  app_user_active && ok "split ACTIVE ($app_user_marker, root-owned)" || fail "the activation marker $app_user_marker is missing or wrong — every rendered script runs as before"
  # account
  if ! getent passwd "$app_user" >/dev/null; then fail "account $app_user does not exist"; echo "app-user verify: $fails FAIL line(s)"; return 1; fi
  IFS=: read -r _ _ u _ _ p n <<< "$(getent passwd "$app_user")"
  [ "$u" -lt 1000 ] && [ "$p" = "$app_home" ] && [ "${n##*/}" = "nologin" ] && ok "account $app_user: system uid $u, $p, nologin" || fail "account $app_user: uid $u, home $p, shell $n"
  [ "$(sudo -n passwd -S "$app_user" 2>/dev/null | awk '{print $2}')" = "L" ] && ok "password locked" || fail "the password of $app_user is not locked"
  [ "$(id -nG "$app_user")" = "$app_user" ] && ok "$app_user is in its own group only" || fail "$app_user groups: $(id -nG "$app_user")"
  id -nG "$deploy_user" | tr ' ' '\n' | grep -xF -- "$app_user" >/dev/null && ok "$deploy_user is in group $app_user" || fail "$deploy_user is not in group $app_user"
  sudo -n -l -U "$app_user" 2>/dev/null | grep 'is not allowed to run sudo' >/dev/null && ok "sudo refused for $app_user" || fail "sudo -l -U $app_user does not say 'not allowed'"
  for f in /etc/cron.deny /etc/at.deny; do sudo -n grep -qxF "$app_user" "$f" 2>/dev/null && ok "$f lists $app_user" || fail "$f does not list $app_user"; done
  sudo -n test -e "/var/spool/cron/crontabs/$app_user" && fail "$app_user has a crontab" || ok "no crontab for $app_user"
  for p in .ssh .npmrc .config/npm; do sudo -n test -e "$app_home/$p" && fail "$app_home/$p exists" || ok "no $app_home/$p"; done
  [ "$(loginctl show-user "$app_user" -p Linger --value 2>/dev/null || echo none)" = "yes" ] && fail "$app_user has a lingering systemd user manager" || ok "no lingering user manager for $app_user"
  sudo -n sshd -T -C "user=$app_user,host=localhost,addr=127.0.0.1" 2>/dev/null | grep -iE "^denyusers .*\b$app_user\b" >/dev/null && ok "sshd: DenyUsers $app_user" || fail "sshd -T does not deny $app_user"
  verify_processes
  verify_listeners
  # write matrix: code must be unwritable for the app account, state writable
  code_w=("$app_dir" "$app_dir/deploy" "$app_dir/deploy/setup-vm.sh" "$app_dir/deploy/extra-services.sh" "$app_dir/node_modules" "$app_dir/.next" "$app_dir/.next/BUILD_ID" "$app_dir/packages/brain" "$app_dir/packages/brain/apps" "$stage_dir" "/usr/local/lib/aiwebsite/listen-loopback.cjs" "/usr/local/bin/aiwebsite-watchdog.sh" "/etc/systemd/system" "$pm2_unit_file" "$npmrc_empty" "/var/lib/aiwebsite" "/var/lib/aiwebsite/issue-spool.d" "/home/$deploy_user")
  for f in "${deploy_written[@]}"; do [ -e "$app_dir/data/$f" ] && code_w+=("$app_dir/data/$f"); done
  for p in "${code_w[@]}"; do
    [ -e "$p" ] || continue
    as_app_test -w "$p" && fail "$app_user can WRITE $p" || ok "$app_user cannot write $p"
  done
  state_w=("$app_dir/data" "$app_home" "$app_home/.pm2")
  for p in "${next_write_paths[@]}"; do state_w+=("$app_dir/.next/$p"); done
  [ -d "$app_dir/packages/brain/data" ] && state_w+=("$app_dir/packages/brain/data")
  [ -d "$app_home/software-brain-data" ] && state_w+=("$app_home/software-brain-data")
  for p in "${state_w[@]}"; do as_app_test -w "$p" && ok "$app_user can write $p" || fail "$app_user cannot write $p (a state path)"; done
  as_app_test -r "$app_dir/.env" && ok "$app_user can read .env" || fail "$app_user cannot read .env"
  sudo -n -u "$app_user" ls -A "/home/$deploy_user" >/dev/null 2>&1 && fail "$app_user can list /home/$deploy_user" || ok "$app_user cannot list /home/$deploy_user"
  for p in /etc/cloudflared/*.json; do [ -e "$p" ] || continue; as_app_test -r "$p" && fail "$app_user can read $p" || ok "$app_user cannot read $p"; done
  [ "$(stat -c '%U %a' "$app_dir/data")" = "$deploy_user 3775" ] && ok "data/ is $deploy_user-owned, sticky + setgid (3775)" || fail "data/ is $(stat -c '%U:%G %a' "$app_dir/data"), expected $deploy_user:$app_user 3775"
  [ "$(stat -c '%a' "$stage_dir" 2>/dev/null)" = "750" ] && ok "the stage is 0750" || fail "$stage_dir is $(stat -c '%a' "$stage_dir" 2>/dev/null), expected 0750"
  [ "$(stat -c '%U:%G %a' "$app_dir/.env")" = "$deploy_user:$app_user 640" ] && ok ".env is $deploy_user:$app_user 0640" || fail ".env is $(stat -c '%U:%G %a' "$app_dir/.env")"
  n="$(sudo -n find "$app_dir" -xdev \( -path "$app_dir/data" -o -path "$app_dir/.git" \) -prune -o ! -type l -perm -0002 -print 2>/dev/null | head -5 || true)"
  [ -z "$n" ] && ok "nothing in the code tree is other-writable" || fail "other-writable in the code tree: $(printf '%s' "$n" | tr '\n' ' ')"
  local prune=(-path "$app_dir/data" -o -path "$app_dir/packages/brain/data")
  for gen in .next .next.old; do for p in "${next_write_paths[@]}"; do prune+=(-o -path "$app_dir/$gen/$p"); done; done
  n="$(sudo -n find "$app_dir" -xdev \( "${prune[@]}" \) -prune -o -user "$app_user" -print 2>/dev/null | head -5 || true)"
  [ -z "$n" ] && ok "the app account owns nothing in the code tree" || fail "owned by $app_user in the code tree: $(printf '%s' "$n" | tr '\n' ' ')"
  for f in "${deploy_written[@]}"; do
    [ -e "$app_dir/data/$f" ] || continue
    if [ -L "$app_dir/data/$f" ] || [ "$(stat -c %U "$app_dir/data/$f")" != "$deploy_user" ] || [ ! -w "$app_dir/data/$f" ]; then fail "data/$f must be a regular file the deploy user owns and can write"; else ok "data/$f: the deploy side's in-place write works ($deploy_user, regular file)"; fi
  done
  # units
  for u in "${module_units[@]}" $(host_units); do
    [ -f "/etc/systemd/system/$u" ] || continue
    [ "$(systemctl show -p User --value "$u")" = "$app_user" ] && systemctl show -p Environment --value "$u" | grep -F -- "NPM_CONFIG_USERCONFIG=$npmrc_empty" >/dev/null \
      && ok "$u runs as $app_user with the empty npmrc" || fail "$u: User=$(systemctl show -p User --value "$u")"
  done
  [ -f "/etc/systemd/system/aiwebsite-hi-speed.service" ] && { [ "$(systemctl show -p User --value "aiwebsite-hi-speed.service")" = "$deploy_user" ] && ok "aiwebsite-hi-speed stays on $deploy_user (writes the root-drained spool)" || fail "aiwebsite-hi-speed.service does not run as $deploy_user"; }
  systemctl is-enabled --quiet "pm2-$deploy_user.service" 2>/dev/null && fail "pm2-$deploy_user.service is still enabled — two daemons at boot" || ok "pm2-$deploy_user.service is not enabled"
  [ -f "$logrotate_file" ] && sudo -n logrotate -d "$logrotate_file" >/dev/null 2>&1 && ok "logrotate stanza for the app's pm2 logs parses" || fail "logrotate stanza $logrotate_file missing or invalid"
  # pm2 drift (live + dump) and the posture check
  if app_pm2 jlist 2>/dev/null | node "$app_dir/deploy/pm2-drift-check.cjs" --live - >/dev/null; then ok "pm2 drift check: the live apps match the rendered ecosystem"; else fail "pm2 drift check (live): run node deploy/pm2-drift-check.cjs --live - for the names"; fi
  if sudo -n cat "$app_home/.pm2/dump.pm2" 2>/dev/null | node "$app_dir/deploy/pm2-drift-check.cjs" --dump - >/dev/null; then ok "pm2 drift check: the saved dump matches"; else fail "pm2 drift check (dump)"; fi
  if bash "$app_dir/deploy/posture-check.sh" >/dev/null 2>&1; then ok "posture-check holds"; else fail "posture-check fails: bash deploy/posture-check.sh"; fi
  # health
  wait_http "$site_health" 10 '"status":"ok"' && ok "site /api/health ok" || fail "site /api/health"
  wait_http "$brain_health" 10 "" && ok "brain-api /health" || fail "brain-api /health"
  wait_http "$skills_health" 10 "" && ok "skills-host /health" || fail "skills-host /health"
  if [ -f "$app_dir/deploy/extra-services.json" ]; then bash "$app_dir/deploy/extra-services.sh" verify >/dev/null 2>&1 && ok "extra services verify" || fail "extra services verify"; fi
  verify_permissions
  echo "app-user verify: $fails FAIL line(s)"
  [ "$fails" -eq 0 ]
}

# ══ rollback ════════════════════════════════════════════════════════════════
do_rollback() {
  take_lock
  j_add "start rollback"
  say "1/6 removing the activation marker FIRST — every rendered script runs as before from here"
  sudo -n rm -f "$app_user_marker"
  say "2/6 stopping the extra services and $pm2_unit (the site is DOWN from here)"
  if [ -f "$app_dir/deploy/extra-services.json" ]; then sudo -n bash "$app_dir/deploy/extra-services.sh" stop 200>&- || true; fi
  sudo -n systemctl stop "$pm2_unit" 2>/dev/null || true
  sudo -n systemctl disable "$pm2_unit" >/dev/null 2>&1 || true
  local i u src dst gen p pre
  if getent passwd "$app_user" >/dev/null; then
    sudo -n pkill -u "$app_user" 2>/dev/null || true
    for i in $(seq 1 20); do pgrep -u "$app_user" >/dev/null || break; sleep 1; done
    sudo -n pkill -9 -u "$app_user" 2>/dev/null || true
    sleep 1
    pgrep -u "$app_user" >/dev/null && die "processes of $app_user survive SIGKILL — nothing was re-owned; a human must look"
  fi
  say "3/6 drop-ins, logrotate stanza and $pm2_unit_file removed"
  for u in "${module_units[@]}" $(host_units); do sudo -n rm -f "/etc/systemd/system/$u.d/$dropin_name"; done
  sudo -n rm -f "$logrotate_file" "$pm2_unit_file"
  sudo -n systemctl daemon-reload
  say "4/6 ownership back to $deploy_user (every app process is stopped)"
  dst="/home/$deploy_user/software-brain-data"; src="$app_home/software-brain-data"
  if j_epoch | grep -xF -- "moved $dst $src" >/dev/null && sudo -n test -d "$src" && ! sudo -n test -e "$dst"; then sudo -n mv -T "$src" "$dst"; fi
  sudo -n test -d "$dst" && sudo -n chown -R -P "$deploy_user:$deploy_user" "$dst"
  pre="$(j_pre data "$deploy_user:$deploy_user 775")"
  sudo -n chown -R -P "${pre% *}" "$app_dir/data"; sudo -n chmod "${pre#* }" "$app_dir/data"
  for gen in .next .next.old; do
    for p in "${next_write_paths[@]}"; do [ -d "$app_dir/$gen/$p" ] && sudo -n chown -R -P "$deploy_user:$deploy_user" "$app_dir/$gen/$p"; done
  done
  if [ -d "$app_dir/packages/brain/data" ]; then
    pre="$(j_pre brain-data "$deploy_user:$deploy_user 775")"
    sudo -n chown -R -P "${pre% *}" "$app_dir/packages/brain/data"; sudo -n chmod "${pre#* }" "$app_dir/packages/brain/data"
  fi
  pre="$(j_pre env "$deploy_user:$deploy_user 600")"
  sudo -n chown "${pre% *}" "$app_dir/.env"; sudo -n chmod "${pre#* }" "$app_dir/.env"
  pre="$(j_pre stage absent)"
  [ "$pre" != "absent" ] && [ -d "$stage_dir" ] && chmod "${pre#* }" "$stage_dir"
  # host logs a host job appends to by itself (post-install chowned them to AICOMPANY_APP_USER)
  sudo -n find /var/log -maxdepth 1 -name "aiwebsite-*.log" -user "$app_user" -exec chown "$deploy_user" {} +
  say "5/6 the deploy user's pm2 back ($(j_pre old-unit-enabled absent) before migrate)"
  if [ "$(j_pre old-unit-enabled absent)" = "enabled" ]; then
    sudo -n systemctl enable "pm2-$deploy_user.service" >/dev/null 2>&1 || true
    sudo -n systemctl start "pm2-$deploy_user.service"
  fi
  (cd "$app_dir" && pm2 startOrReload deploy/ecosystem.config.cjs --update-env 200>&-)
  wait_http "$site_health" 120 '"status":"ok"' || echo "!!! site health did not come back within 120 s after rollback — the RUNBOOK's manual recovery applies"
  pm2 save 200>&- >/dev/null || true
  if [ -f "$app_dir/deploy/extra-services.json" ]; then sudo -n bash "$app_dir/deploy/extra-services.sh" start 200>&- || true; bash "$app_dir/deploy/extra-services.sh" verify || true; fi
  say "6/6 the app account's saved pm2 state (it carries the env) is shredded"
  for p in "$app_home/.pm2/dump.pm2" "$app_home/.pm2/dump.pm2.bak"; do sudo -n test -f "$p" && sudo -n shred -u "$p"; done
  j_add "complete rollback"
  sudo -n rm -f "$deploy_marker"
  say "rollback complete. Kept on purpose (inert): the locked account $app_user, its cron/at deny lines, the sshd DenyUsers drop-in, $npmrc_empty. Revert APP_USER in the host repo at the next deploy."
}

do_status() {
  if app_user_active; then echo "app-user: ACTIVE — the apps run as $app_user ($pm2_unit: $(systemctl is-active "$pm2_unit" 2>/dev/null))"
  elif getent passwd "$app_user" >/dev/null; then echo "app-user: rendered for $app_user, account exists, NOT active (no marker) — the deploy user runs the apps"
  else echo "app-user: rendered for $app_user, not migrated — the deploy user runs the apps"; fi
  j_epoch | tail -n 3 | sed 's/^/  journal: /' || true
}

case "$cmd" in
  preflight) do_preflight ;;
  migrate)   do_migrate ;;
  verify)    do_verify ;;
  rollback)  do_rollback ;;
  ensure)    do_ensure ;;
  pm2)       app_user_active || die "the split is not active on this box — use pm2 as $deploy_user"; app_pm2 "$@" ;;
  status)    do_status ;;
  *) echo "usage: app-user.sh preflight|migrate|verify|rollback|ensure|status|pm2 <args>"; exit 2 ;;
esac
