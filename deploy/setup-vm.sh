#!/usr/bin/env bash
# aicompany-template: setup-vm.sh.tpl@b5631580f01f3384761d0a960935f5a229f5df634e724b4507608d5eda7f399e
set -euo pipefail

# One-time VM provisioning for ai.xl.net (idempotent — safe to re-run on every
# deploy). Assumes the repo (incl. packages/brain submodule contents and .env)
# has been synced to the app dir by deploy/deploy.sh.
#
# All periodic jobs are systemd timer units with Persistent=true — NOT crontab
# lines (§9.3: a crontab rebuild once silently dropped an entry). The only cron
# entry is the watchdog supervisor (§9.5).

app_dir="/var/www/aiwebsite"
module_dir="$app_dir/packages/aicompany"
# Build placement (§9.2 v1.78.0): "remote" = staged VM-side build (unchanged
# default); "local-artifact" = deploy.sh built .next on the dev box and
# shipped it to /var/tmp — this script extracts it into the STAGE tree and
# never runs `next build` (the 2026-08-08 itsc outage class).
build_mode="remote"

echo "=== ai.xl.net — VM Setup ==="

# ── Deploy↔deploy mutex (v1.4.0, §9.2): one deploy at a time, fail fast ──
# Never queue: the second deployer must see the first and decide, not pile on.
# Pre-create the lock with sudo (the marker precedent): this script runs as
# the deploy user with per-command sudo, and a bare `exec 200>` into
# root-owned /var/run would EACCES-abort the very first deploy at step 1
# under `set -euo pipefail`. fd 200 is closed (`200>&-`) on every long-lived
# spawn below — a pm2 God daemon or watchdog resurrected during this deploy
# must not inherit + pin the deploy lock (the B1 failure class, v1.3.4).
deploy_lock="/var/run/aiwebsite-deploy.lock"
sudo touch "$deploy_lock"
sudo chown "$(whoami)" "$deploy_lock"
exec 200>"$deploy_lock"
if ! flock -n 200; then
  echo "ERROR: another deploy holds $deploy_lock — aborting."
  echo "       (ps aux | grep setup-vm to find it)"
  exit 1
fi

# Node 20/22 split hosts (v1.4.0): prepend the Node-22 toolchain for this
# script's npm/next/pm2 work on a VM whose system node must stay v20 for
# native-ABI services. Empty for standard hosts ⇒ no-op.
if [ -n "" ]; then
  export PATH=":$PATH"
fi

# ── Deploy↔watchdog mutex marker (§9.5) ──────────────────────────
# Touch a timestamped marker the watchdog checks before running any repair
# ACTION (service restart / clean rebuild). While this marker is fresher than
# the watchdog's grace TTL (30 min) the watchdog still observes+alerts but does
# NOT act — so a watchdog `npm run build`/`pm2 restart` cannot race this
# deploy's npm ci/build on the same tree (the 2026-07-13 EEXIST + phantom
# module-not-found deploy failures). The marker is re-touched before the long
# build step and removed on successful completion. Failure mode (accepted): a
# deploy that crashes before the end leaves the marker; the watchdog resumes
# self-healing once it ages past the TTL — no trap clears it early, so a broken
# half-deploy is NOT immediately "repaired" by the watchdog.
deploy_marker="/var/run/aiwebsite-deploy-in-progress"
sudo touch "$deploy_marker"

# ── Capability probe: memory-capped staging must WORK here (v1.15.0, A3) ──
# stage-build.sh runs every heavy step inside a systemd scope with a hard
# MemoryMax (§9.2) and is FAIL-CLOSED. Probe the exact capability up front
# with a 64M throwaway scope, so a VM where sudo -n systemd-run cannot place
# scopes aborts NOW — before any package or staging work — not mid-pipeline.
if ! sudo -n systemd-run --quiet --collect --scope --unit="aiwebsite-stage-probe-$$" -p MemoryMax=64M true; then
  echo "ERROR: sudo -n systemd-run cannot create a memory-capped scope on this VM —"
  echo "       staged builds would have to run UNCAPPED (the 2026-07-22 livelock class)."
  echo "       Fix sudoers/systemd (MIGRATIONS.md v1.15.0 step 4) and redeploy."
  exit 1
fi

# ── System packages ──────────────────────────────────────────────
# build-essential/python3/libpq-dev are required to compile the brain's
# native deps (better-sqlite3, pg-native).
# `apt-get update` exits non-zero when ANY configured repository fails, and
# under `set -e` that aborts the whole deploy. A third-party repo being down
# must not do that: the packages below come from Debian's own repos, Node is
# installed once and guarded by `command -v node` further down, and the
# `apt-get install` on the next line is the real gate — it still fails loudly
# if a package genuinely cannot be resolved. (2026-07-27: deb.nodesource.com
# started returning 403 and took BOTH remaining hosts' deploys down with it.)
sudo apt-get update -qq || echo "WARN: apt-get update had failing repositories — continuing; the package install below is the gate"
# lsof: extra-services stop/start identity (v1.4.0) — without it, port-holder
# detection silently degrades and services can double-start.
sudo apt-get install -y -qq build-essential python3 libpq-dev pkg-config jq rsync logrotate lsof

# ── System measures vs swapless near-OOM livelock (v1.15.0, §9.5) ──
# Mirrors the PROVEN one-off harden-vm.sh applied fleet-wide on 2026-07-22
# (aiwebsite outage): the template now MAINTAINS what the one-off
# bootstrapped. Three legs: swap restores schedulability under memory
# pressure; earlyoom turns an unbounded livelock into a bounded kill;
# systemd drop-ins keep operator access (sshd/journald/cloudflared) alive.
# Idempotent. Restarts ONLY earlyoom/journald/psi-log/ssh — NEVER cron
# (S4: cron's drop-in is MemoryMin-only; a cron restart would orphan the
# running watchdog chain).

# 1. swapfile 4G + swappiness=60 (S3: the kernel must be WILLING to swap
#    anon pages or earlyoom's swap gate never trips)
if ! sudo swapon --show=NAME --noheadings | grep -q '^/swapfile$'; then
  sudo fallocate -l 4G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=4096
  # NOT `chmod && mkswap && swapon` (v1.64.0): under `set -euo pipefail` an
  # AND-list whose FIRST command fails does not abort, so a failed chmod or
  # mkswap silently skipped swapon and the deploy continued with NO swap —
  # which matters because earlyoom's SIGTERM leg is an AND of low RAM and low
  # SwapFree, so a swapless box degenerates to "kill at 15% RAM". Same defect
  # class as the nginx gate below.
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
fi
# v1.29.1: the guard above is existence-only — a pre-hardening legacy
# /swapfile (e.g. 2G) passes it forever, and at typical utilization its
# SwapFree sits below earlyoom's -s 30 SIGTERM leg PERMANENTLY, degenerating
# the AND-gate to "MemAvail<=15%" and killing deploy builds (itsupportchicago
# ran 2G for a month of staged-install "OOMs", root-caused 2026-07-26). Fail
# the deploy loudly — deliberately NO auto-resize: a safe live resize needs
# temp-swap-first + drain + recreate with RAM-headroom gating, and an
# unattended swapoff of a hot swapfile inside a deploy is exactly the
# 2026-07-22 livelock class (MIGRATIONS v1.29.1 has the runbook pointer).
swap_bytes=$(sudo stat -c %s /swapfile 2>/dev/null || echo 0)
if [ "$swap_bytes" -lt 4294967296 ]; then
  echo "ERROR: /swapfile is $((swap_bytes / 1048576))M — the §9.5 memory defenses assume 4096M."
  echo "Live-resize it first (temp-swap-first, never a bare swapoff under load; see MIGRATIONS v1.29.1), then re-deploy."
  exit 1
fi
grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
printf 'vm.swappiness = 60\n' | sudo tee /etc/sysctl.d/90-aicompany-memory.conf >/dev/null
sudo sysctl -q -p /etc/sysctl.d/90-aicompany-memory.conf

# 2. earlyoom (S2: no -N mailer — the notifier is sandbox-broken on Debian
#    units and failed silently; the watchdog scans the journal for kill
#    events instead. S5: regexes UNQUOTED + space-free — systemd $VAR
#    splitting keeps quote characters literal otherwise)
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq earlyoom >/dev/null 2>&1 || sudo apt-get install -y earlyoom
sudo systemctl mask --now systemd-oomd >/dev/null 2>&1 || true
sudo tee /etc/default/earlyoom >/dev/null <<'EOF'
# aicompany hardening 2026-07-22: SIGTERM at MemAvail<15% AND SwapFree<30%; KILL at 8%/15%.
# Regexes UNQUOTED+space-free (systemd $VAR splitting keeps quotes literal otherwise).
EARLYOOM_ARGS="-m 15,8 -s 30,15 -r 300 --avoid ^(sshd|sshd-session|systemd|systemd-journal|systemd-logind|cloudflared|nginx|postgres|earlyoom|cron)$ --prefer ^(npm|node|next-server|tsx|npx)$"
EOF
sudo mkdir -p /etc/systemd/system/earlyoom.service.d
sudo tee /etc/systemd/system/earlyoom.service.d/90-aicompany.conf >/dev/null <<'EOF'
[Service]
OOMScoreAdjust=-1000
MemoryMin=16M
Restart=always
EOF

# 3. critical-daemon drop-ins (S4: cron NOT restarted; S10: slice min 384M)
mkdrop() { sudo mkdir -p "/etc/systemd/system/$1.d"; sudo tee "/etc/systemd/system/$1.d/90-aicompany-oom.conf" >/dev/null; }
mkdrop system.slice <<'EOF'
[Slice]
MemoryMin=384M
EOF
mkdrop ssh.service <<'EOF'
[Service]
OOMScoreAdjust=-1000
MemoryMin=32M
EOF
mkdrop systemd-journald.service <<'EOF'
[Service]
OOMScoreAdjust=-900
MemoryMin=64M
EOF
mkdrop cloudflared.service <<'EOF'
[Service]
OOMScoreAdjust=-900
MemoryMin=64M
EOF
mkdrop nginx.service <<'EOF'
[Service]
OOMScoreAdjust=-500
MemoryMin=32M
EOF
mkdrop 'postgresql@.service' <<'EOF'
[Service]
OOMScoreAdjust=-800
MemoryMin=128M
EOF
mkdrop cron.service <<'EOF'
[Service]
MemoryMin=16M
EOF

# 4. journald persistent + bounded (the 07-22 forensics lost the freeze
#    window; persistent storage survives the console reboot)
sudo mkdir -p /etc/systemd/journald.conf.d
sudo tee /etc/systemd/journald.conf.d/90-aicompany.conf >/dev/null <<'EOF'
[Journal]
Storage=persistent
SystemMaxUse=200M
RuntimeMaxUse=64M
EOF

# 5. sysstat 1-min grain + PSI flight recorder (07-22 had a 10-min sar grain
#    and zero pressure history)
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq sysstat >/dev/null 2>&1 || true
sudo sed -i 's/^ENABLED=.*/ENABLED="true"/' /etc/default/sysstat 2>/dev/null || true
sudo mkdir -p /etc/systemd/system/sysstat-collect.timer.d
sudo tee /etc/systemd/system/sysstat-collect.timer.d/90-aicompany.conf >/dev/null <<'EOF'
[Timer]
OnCalendar=
OnCalendar=*-*-* *:*:00
EOF
sudo tee /usr/local/bin/aiwebsite-psi-log.sh >/dev/null <<'PSIEOF'
#!/usr/bin/env bash
while true; do
  printf '%s mem[%s] io[%s] MemAvailable=%skB SwapFree=%skB\n' \
    "$(date -u +%FT%TZ)" \
    "$(tr '\n' ' ' < /proc/pressure/memory)" \
    "$(grep ^full /proc/pressure/io | tr -d '\n')" \
    "$(awk '/MemAvailable/{print $2}' /proc/meminfo)" \
    "$(awk '/SwapFree/{print $2}' /proc/meminfo)" >> /var/log/aiwebsite-psi.log
  sleep 30
done
PSIEOF
sudo chmod +x /usr/local/bin/aiwebsite-psi-log.sh
sudo tee /etc/systemd/system/aiwebsite-psi-log.service >/dev/null <<'EOF'
[Unit]
Description=aiwebsite PSI flight recorder
[Service]
ExecStart=/usr/local/bin/aiwebsite-psi-log.sh
Restart=always
OOMScoreAdjust=-500
MemoryMin=16M
[Install]
WantedBy=multi-user.target
EOF

# 6. apply: daemon-reload; restart earlyoom/journald/psi-log + ssh (existing
#    SSH connections survive an ssh restart); cron untouched (S4)
sudo systemctl daemon-reload
sudo systemctl enable --now earlyoom >/dev/null 2>&1 || true
sudo systemctl restart earlyoom
sudo systemctl enable --now aiwebsite-psi-log.service
sudo systemctl enable --now sysstat-collect.timer >/dev/null 2>&1 || sudo systemctl enable --now sysstat >/dev/null 2>&1 || true
sudo systemctl restart systemd-journald
sudo systemctl restart ssh || sudo systemctl restart sshd
# Apply oom_score_adj to ALREADY-RUNNING protected daemons (drop-ins take
# effect on their next restart; these must be protected NOW).
for p in $(pgrep -x sshd; pgrep -x cloudflared; pgrep -x systemd-journal); do
  echo -1000 | sudo tee /proc/$p/oom_score_adj >/dev/null 2>&1 || true
done

# Node.js 22
if ! command -v node &>/dev/null; then
  echo "Installing Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "Node: $(node -v)"

# PM2
if ! command -v pm2 &>/dev/null; then
  sudo npm install -g pm2
fi

# PostgreSQL
if ! command -v psql &>/dev/null; then
  echo "Installing PostgreSQL..."
  sudo apt-get install -y postgresql
fi
sudo systemctl enable --now postgresql

# Create database and user
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='aiwebsite'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE USER \"aiwebsite\" WITH PASSWORD 'aiwebsite';"
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='aiwebsite'" | grep -q 1 || \
  sudo -u postgres createdb -O "aiwebsite" "aiwebsite"

# Bounded WAL so a burst of writes cannot eat the disk (§9.5)
sudo -u postgres psql -c "ALTER SYSTEM SET max_wal_size = '256MB';" >/dev/null
sudo systemctl reload postgresql || true

# nginx — loopback-only; the Cloudflare tunnel is the sole public entry
if ! command -v nginx &>/dev/null; then
  sudo apt-get install -y nginx
fi
# Fleet-wide log_format (v1.64.0) — installed BEFORE the site config, because
# nginx parses sequentially and a reference to an undeclared format is fatal
# (`[emerg] unknown log format`). Debian's /etc/nginx/nginx.conf includes
# conf.d/*.conf BEFORE sites-enabled/*, both inside http{} — verified on the
# fleet; re-verify if a host's nginx.conf is ever hand-edited.
#
# WHY A SHARED FILE AND NOT THE SITE TEMPLATE: `log_format` is an http-context
# directive. v1.62.0 put it inside server{} and nginx rejected the whole config
# (`[emerg] "log_format" directive is not allowed here`) — it reached production
# and left the box one restart from nginx failing to start. Declaring it from a
# per-site template in http context is equally broken: two slugs on one VM would
# each declare `aic_combined` and collide (`[emerg] duplicate "log_format" name`).
#
# The 00- prefix is deliberate: nginx globs conf.d alphabetically and a format
# must parse before any use, so this stays first even if a host later drops
# another file in. THE FILENAME IS SLUG-AGNOSTIC ON PURPOSE. Co-located slugs must converge on one
# identical file, never install two. Content is byte-identical for every host.
#
# WHY $host EXISTS AT ALL: each vhost answers for ai.xl.net *and* EXTRA_DOMAINS,
# so without it two domains' traffic is indistinguishable in one log — which is
# exactly how a 2026-08-03 session spent hours diagnosing a roleplay.xl.net
# "6% sitemap 404 rate" that was really roleplayxl.net, the outreach sending
# domain, correctly answering 404. Appended, never interleaved: every existing
# positional grep in the runbooks keeps working.
echo ">>> Installing fleet-wide nginx log format (conf.d, http context)..."
sudo mkdir -p /etc/nginx/conf.d
# ASSERT the include order rather than trusting it. nginx resolves a format name
# at PARSE time, so conf.d must be included before sites-enabled or the site
# config is fatal (`unknown log format`). Both were verified on the fleet — but
# /etc/nginx/nginx.conf is a pristine dpkg conffile on every host AND
# unattended-upgrades is enabled, so dpkg is licensed to replace it silently
# (it prompts only for LOCALLY MODIFIED conffiles). This is the one assumption
# the design rests on and nothing else would notice it changing.
confd_ln="$(grep -n 'include */etc/nginx/conf\.d/\*\.conf' /etc/nginx/nginx.conf | head -1 | cut -d: -f1 || true)"
sites_ln="$(grep -n 'include */etc/nginx/sites-enabled/\*' /etc/nginx/nginx.conf | head -1 | cut -d: -f1 || true)"
if [ -z "$confd_ln" ] || [ -z "$sites_ln" ] || [ "$confd_ln" -ge "$sites_ln" ]; then
  echo "!!! /etc/nginx/nginx.conf does not include conf.d BEFORE sites-enabled"
  echo "!!!   conf.d=${confd_ln:-absent} sites-enabled=${sites_ln:-absent}"
  echo "!!! The site config references log_format aic_combined, which would be"
  echo "!!! undefined at parse time. Refusing to install a config that cannot load."
  exit 1
fi

# Back up the current site config BEFORE overwriting it. If the new one fails
# `nginx -t` we restore this and prove the restore is valid, so a rejected
# config never survives on disk. v1.62.0's did: the deploy "succeeded", nginx
# kept the old config in memory, and the box sat one reboot from not starting.
# Was the tree ALREADY invalid before we touched it? (N1) Without this, a host
# whose /etc/nginx broke for an unrelated reason — a hand-added conf.d file, an
# unattended-upgraded nginx.conf, a drop-in naming a deleted upstream — would
# have every future deploy, including an urgent app fix, aborted by the new gate.
# Fail closed on damage WE cause; stay out of the way of damage we did not.
nginx_baseline_ok=1
sudo nginx -t >/dev/null 2>&1 || nginx_baseline_ok=0
if [ "$nginx_baseline_ok" = 0 ]; then
  echo "!!! WARNING: nginx -t was ALREADY FAILING before this deploy."
  echo "!!!   Not installing or reloading nginx config; the deploy CONTINUES."
  echo "!!!   /etc/nginx needs a human — run 'sudo nginx -t' on this box."
  sudo systemctl is-active --quiet nginx || echo "!!!   AND nginx is NOT RUNNING."
else
nginx_backup="$(mktemp -d)"
fmt_conf=/etc/nginx/conf.d/00-aicompany-log-format.conf
if [ -f /etc/nginx/sites-available/aiwebsite ]; then
  sudo cp /etc/nginx/sites-available/aiwebsite "$nginx_backup/site"
fi
if [ -d /etc/nginx/aiwebsite.d ]; then
  sudo cp -a /etc/nginx/aiwebsite.d "$nginx_backup/dropins"
fi
# The format file is snapshotted and written INSIDE the guarded branch too. An
# earlier revision wrote it before the backup and never rolled it back — so if
# the format file was itself what broke `nginx -t`, restoring the site config
# could not fix it and the script would abort having left the box worse than it
# found it, reporting "restore also fails, needs a human".
if [ -f "$fmt_conf" ]; then sudo cp "$fmt_conf" "$nginx_backup/fmt"; fi
sudo tee /etc/nginx/conf.d/00-aicompany-log-format.conf >/dev/null <<'AIC_LOG_FORMAT'
# Managed by @aicompany/core setup-vm.sh — do not edit by hand.
# Shared by every aicompany site on this box; the name must stay unique.
log_format aic_combined '$remote_addr - $remote_user [$time_local] '
                        '"$request" $status $body_bytes_sent '
                        '"$http_referer" "$http_user_agent" '
                        'host=$host up=$upstream_status '
                        'urt=$upstream_response_time rt=$request_time';
AIC_LOG_FORMAT
sudo cp "$app_dir/deploy/nginx.conf" /etc/nginx/sites-available/aiwebsite
# Host nginx drop-ins (v1.4.0): committed deploy/nginx.d/* are installed to
# /etc/nginx/aiwebsite.d/ BEFORE the conf test — the rendered server block
# includes that glob (silently empty for hosts without drop-ins).
# rsync --delete makes the install AUTHORITATIVE: a drop-in removed from the
# repo is removed from the VM (a plain cp would serve deleted config forever)
# and an empty nginx.d/ empties the target instead of aborting on a bare glob.
if [ -d "$app_dir/deploy/nginx.d" ]; then
  echo ">>> Installing host nginx drop-ins (deploy/nginx.d/*)..."
  sudo mkdir -p /etc/nginx/aiwebsite.d
  sudo rsync -a --delete "$app_dir/deploy/nginx.d/" /etc/nginx/aiwebsite.d/
fi
sudo ln -sf /etc/nginx/sites-available/aiwebsite /etc/nginx/sites-enabled/aiwebsite
sudo rm -f /etc/nginx/sites-enabled/default
# `nginx -t && reload` was the shape here until v1.64.0, and it was INERT:
# under `set -euo pipefail`, `set -e` does NOT abort on `A && B` when A fails and
# the compound is not the last command. So a bad config short-circuited, the
# reload was silently skipped, and the deploy reported success — which is exactly
# how v1.62.0's invalid config reached production while this very line ran.
# Verified: `bash -c 'set -e; false && echo x; echo REACHED'` prints REACHED.
if ! sudo nginx -t; then
  echo "!!! nginx -t REJECTED the new config — restoring the previous one"
  if [ -f "$nginx_backup/site" ]; then
    sudo cp "$nginx_backup/site" /etc/nginx/sites-available/aiwebsite
  else
    sudo rm -f /etc/nginx/sites-available/aiwebsite /etc/nginx/sites-enabled/aiwebsite
  fi
  if [ -d "$nginx_backup/dropins" ]; then
    sudo rsync -a --delete "$nginx_backup/dropins/" /etc/nginx/aiwebsite.d/
  fi
  if [ -f "$nginx_backup/fmt" ]; then
    sudo cp "$nginx_backup/fmt" "$fmt_conf"
  else
    sudo rm -f "$fmt_conf"   # we created it this run; leave no trace
  fi
  if sudo nginx -t; then
    echo "    previous config restored and valid — deploy ABORTED before cutover"
  else
    echo "    !!! RESTORE ALSO FAILS nginx -t — /etc/nginx needs a human NOW"
  fi
  # nginx was never reloaded, so it is still serving the last-loaded config —
  # UNLESS the watchdog restarted it during the invalid window. It restarts nginx
  # unconditionally every 60s and is NOT deploy-gated (only the pm2 apps are), so
  # this is a live executioner, not a hypothetical. Say which world we are in;
  # deploy.sh's own banner claims "the old build is still serving" and would lie.
  if sudo systemctl is-active --quiet nginx; then
    echo "    nginx is RUNNING (serving its last valid loaded config)"
  else
    echo "    !!! nginx is NOT RUNNING — the site is DOWN. Fix /etc/nginx and start it."
  fi
  # `sudo rm -rf` (not bare rm) and `|| true`: `sudo cp -a` puts root-owned
  # content in this dir, so an unprivileged rm exits 1 and — under `set -e` —
  # would kill the deploy on the SUCCESS path below, after the reload. It does
  # not bite today only because rsync happens to leave aiwebsite.d unprivileged;
  # setup-vm's own `sudo mkdir -p` on a fresh provision makes it root-owned.
  sudo rm -rf "$nginx_backup" || true
  exit 1
fi
sudo systemctl reload nginx
sudo rm -rf "$nginx_backup" || true
fi   # end: nginx config was installed only when the baseline tree was valid

# ── App install & build (staged, v1.13.0 §9.2) ───────────────────
cd "$app_dir"

if [ ! -f .env ]; then
  echo "ERROR: $app_dir/.env is missing. deploy.sh should have copied it."
  exit 1
fi

stage_dir="/var/www/aiwebsite.stage"
[ -d "$stage_dir" ] || { sudo mkdir -p "$stage_dir"; sudo chown "$(whoami)" "$stage_dir"; }

# ── Pipeline-scoped stage lock (fd 201; fd 200 remains the deploy lock) ──
# Held for the rest of this script: deploy and watchdog stage-build pipelines
# can never interleave subcommand-by-subcommand. Every long-lived spawn below
# closes it (`201>&-`) beside the existing `200>&-` — same B1 fd class.
exec 201>"$stage_dir/.lock"
flock -n 201 || { echo "ERROR: a stage-build pipeline (watchdog rebuild?) holds the stage lock — aborting; live site untouched"; exit 1; }
export STAGE_BUILD_LOCK_HELD=1

# Extra services: validate fail-fast, but KEEP RUNNING through install+build —
# staged npm ci never touches live node_modules; ABI changes land only at the
# cutover flip, so the stop/start bracket moves there (v1.13.0; supersedes the
# v1.4.0 stop-before-ci — same outage class, now a seconds-wide window).
# ABSENT manifest is loud on purpose: on a VM that is in fact running an
# unmanaged service, a silent skip here replays that outage with green logs.
if [ -f deploy/extra-services.json ]; then
  bash deploy/extra-services.sh validate
else
  echo "WARN: no deploy/extra-services.json — extra-service stop-before-cutover and supervision are OFF for this deploy"
fi

# ── Deploy liveness sentinel (v1.15.0, §9.2 — G3) ────────────────
# Watches the LIVE site's /api/health for the whole stage window (heal → the
# config:check gate): 3 consecutive misses at a 10s cadence (a curl timeout
# counts as a miss) means the stage work is starving the box — write the
# abort flag FIRST (systemd-run --collect destroys scope status; the flag is
# the only forensic marker run_capped's banner can read, A10), THEN SIGKILL
# every capped scope. It never covers the cutover bracket — the flip's
# seconds-wide health dip is EXPECTED. Honesty (§9.2): a FULL livelock also
# freezes this sentinel; the §9.5 earlyoom layer owns that band — the
# sentinel exists for the wide near-livelock band where userspace still
# schedules. 45-min self-TTL; the EXIT trap reaps it and the stale flag.
sentinel_should_abort() {  # <misses> <threshold> → exit 0 = abort
  [ "$1" -ge "$2" ]
}
sentinel_flag="$stage_dir/.liveness-abort"
rm -f "$sentinel_flag"

# The sentinel protects a LIVE site from being starved by stage work. On a FIRST
# deploy there is no live site — nothing has ever listened on :3000 — so every
# probe misses, three misses arrive in 30 seconds, and it SIGKILLs the staging it
# was meant to protect: a brand-new host could never complete its first deploy.
# (Observed on topmspnearme: install-brain killed at exit 137 with an empty
# /var/www tree.) Arm only if the site answered healthy BEFORE staging — strictly
# narrowing, since on an established host the probe succeeds and nothing changes.
# A sentinel guarding something that is not running has nothing to protect and can
# only produce false aborts.
sentinel_arm=1
if ! curl -fsS -m 5 "http://127.0.0.1:3000/api/health" 2>/dev/null | grep -q '"status":"ok"'; then
  sentinel_arm=0
  echo ">>> liveness sentinel DISARMED: no healthy site on :3000 before staging"
  echo "    (first deploy, or the site is already down — either way there is no"
  echo "     live traffic for stage work to starve)."
fi
deploy_sentinel() {
  misses=0
  ticks=0
  while :; do
    sleep 10
    ticks=$(( ticks + 1 ))
    if [ "$ticks" -gt 270 ]; then exit 0; fi     # 45-min self-TTL
    body=$(curl -fsS -m 5 "http://127.0.0.1:3000/api/health" 2>/dev/null) || body=""
    if printf '%s' "$body" | grep -q '"status":"ok"'; then
      misses=0
      continue
    fi
    misses=$(( misses + 1 ))
    if sentinel_should_abort "$misses" 3; then
      touch "$sentinel_flag"                     # flag BEFORE the kill (A5/A10)
      sudo -n systemctl kill -s KILL "aiwebsite-stage-*.scope" 2>/dev/null || true
      exit 0
    fi
  done
}
# Spawn closes fd 200 AND 201 (B1 class): the sentinel is a long-lived child
# that must never inherit + pin the deploy or stage lock.
if [ "$sentinel_arm" = "1" ]; then
  deploy_sentinel 200>&- 201>&- &
  sentinel_pid=$!
  trap 'kill "$sentinel_pid" 2>/dev/null || true; rm -f "$sentinel_flag"' EXIT
else
  sentinel_pid=""
  trap 'rm -f "$sentinel_flag"' EXIT
fi

# Re-touch the mutex marker after each staged step (v1.4.0 rule): the whole
# install+build span can outrun the watchdog's 30-min TTL on a small VM.
bash deploy/stage-build.sh heal;      sudo touch "$deploy_marker"
bash deploy/stage-build.sh prepare;   sudo touch "$deploy_marker"
echo ">>> Installing site dependencies (staged)..."
# --include=dev: the VM environment omits devDependencies by default, but the
# build needs them (drizzle-kit, typescript, tailwind, tsx).
bash deploy/stage-build.sh install;   sudo touch "$deploy_marker"
if [ ! -f "$stage_dir/packages/brain/package.json" ]; then
  echo "ERROR: packages/brain is empty — submodule contents were not synced."
  exit 1
fi
echo ">>> Installing brain (packages/brain) dependencies (staged)..."
bash deploy/stage-build.sh install-brain; sudo touch "$deploy_marker"

# Host post-install hook (host-owned, optional, NOT template-rendered): cwd =
# STAGE, so native rebuilds target the trees that ship at cutover. Trees a
# hook rebuilds OUTSIDE the default flip set must be declared in host-owned
# deploy/swap-dirs.txt or the work is silently discarded (MIGRATIONS v1.13.0).
# ENV CONTRACT: hooks that edit env must edit the LIVE $app_dir/.env by
# ABSOLUTE path (itsc pin-prod-env does — its ENV_FILE default IS the live
# path and its hard-verify reads the serving file). setup-vm then re-copies
# the pinned live .env into stage so migrate/build/config:check validate the
# exact env that goes live. .env is NEVER generation-flipped.
#
# SYSTEMD CONTRACT (v1.104.2 — the same trap, found the hard way on roleplay
# 2026-08-25). A hook that installs or updates systemd units MUST NOT derive
# its path from "$0"/"$(dirname "$0")": the cwd here is the STAGE, so a hook
# doing `app_dir="$(cd "$(dirname "$0")/.." && pwd)"` gets
# <app>.stage, and any live-dir guard it carries then SKIPS on every normal
# deploy. roleplay's three install-*-ops.sh all do exactly that, so their
# units were never installed or refreshed by a deploy — the existing timers
# survive only because someone once ran the installer from the live dir, and a
# NEW timer silently did not install while the deploy reported success. The
# skip line reads like routine noise.
#
# Units are LIVE-DIR state, not staged state: they reference absolute
# ExecStart paths under $app_dir and are not generation-flipped. So a
# unit-installing hook must use the LIVE $app_dir by absolute path (the same
# rule as .env above), and should FAIL LOUDLY rather than skip if it cannot
# determine it. A hook that skips silently on the deploy path is a hook that
# does not run — the "a silent skip reads as a pass" family.
#
# VERIFY, do not assume: `systemctl list-timers '<slug>-*'` after a deploy
# that was supposed to add or change one.
if [ -f "$stage_dir/deploy/post-install.sh" ]; then
  echo ">>> Running host post-install hook (stage cwd)..."
  (cd "$stage_dir" && bash deploy/post-install.sh); sudo touch "$deploy_marker"
fi
install -m 600 "$app_dir/.env" "$stage_dir/.env"

if [ "$build_mode" = "local-artifact" ]; then
  # ── Local-artifact install (§9.2 v1.78.0): NO VM-side build, EVER ──
  # The dev box built .next (deploy.sh, which also ran the dev-path
  # relocatability grep) and shipped it via scp/rsync — never a stdin pipe —
  # BEFORE this script started. Extract into the STAGE tree so the existing
  # journaled cutover below flips node_modules + .next as ONE generation: a
  # truncated ship or parity failure is a pre-cutover no-op and can never
  # strand new modules against an old .next (the 2026-08-08 mixed-tree class).
  echo ">>> Installing dev-box-built .next artifact (DEPLOY_BUILD_MODE=local-artifact — no VM-side build)..."
  sudo touch "$deploy_marker"
  artifact_tar="/var/tmp/aiwebsite-next-artifact.tgz"
  if [ -z "${LOCAL_BUILD_ID:-}" ] || [ -z "${LOCAL_NODE_MAJOR:-}" ]; then
    echo "ERROR: LOCAL_BUILD_ID / LOCAL_NODE_MAJOR not set — in local-artifact mode setup-vm.sh"
    echo "       must be driven by deploy/deploy.sh (it builds, ships, and passes the expected"
    echo "       artifact identity). Refusing to guess; live tree untouched."
    exit 1
  fi
  [ -f "$artifact_tar" ] || { echo "ERROR: $artifact_tar missing — deploy.sh ships it before setup-vm runs; live tree untouched"; exit 1; }
  # ── Build-time env pin gate (v1.78.0 fix round, M5) ─────────────
  # On local-artifact hosts, BUILD-TIME env comes VERBATIM from the dev-box
  # .env: the .next was built on the dev box, and NEXT_PUBLIC_* values are
  # INLINED into it at build time. The pin machinery (host post-install hook,
  # e.g. itsc pin-prod-env.sh: committed deploy/prod-env-pins.env + VM-owned
  # /etc/<slug>/env-pins.env) edits the on-disk .env AFTER the build — a
  # NEXT_PUBLIC_ pin would claim a production override the shipped artifact
  # can never honor, and the site would silently serve the dev-box value.
  # Fail loudly, pre-cutover: fix it by setting the value in the DEV .env
  # (it ships verbatim) and removing the pin.
  for pins_f in "$app_dir/deploy/prod-env-pins.env" "/etc/aiwebsite/env-pins.env"; do
    [ -f "$pins_f" ] || continue
    bad_pins="$(grep -E '^[[:space:]]*NEXT_PUBLIC_' "$pins_f" | sed 's/=.*//' || true)"
    if [ -n "$bad_pins" ]; then
      echo "ERROR: $pins_f pins build-time-consumed key(s) on a local-artifact host:"
      printf '%s\n' "$bad_pins" | sed 's/^/       /'
      echo "       NEXT_PUBLIC_* is inlined into .next at BUILD time on the DEV BOX — a pin here"
      echo "       can never take effect on the shipped artifact. Set the value in the dev-box"
      echo "       .env and remove the pin. Pre-cutover no-op; old build serving."
      exit 1
    fi
  done
  # Node-major parity, asserted where it binds: THIS node serves the artifact.
  # (deploy.sh prechecks the same thing dev-box-side to fail before shipping.)
  vm_node_major="$(node -v | sed 's/^v//' | cut -d. -f1)"
  if [ "$vm_node_major" != "$LOCAL_NODE_MAJOR" ]; then
    echo "ERROR: node major mismatch — artifact built under v$LOCAL_NODE_MAJOR.x, VM runs $(node -v)."
    echo "       Pre-cutover no-op; old build serving. Rebuild on the dev box under v${vm_node_major}.x."
    exit 1
  fi
  rm -rf "$stage_dir/.next"
  tar xzf "$artifact_tar" -C "$stage_dir" ./.next
  staged_build_id="$(cat "$stage_dir/.next/BUILD_ID" 2>/dev/null || echo missing)"
  if [ "$staged_build_id" != "$LOCAL_BUILD_ID" ]; then
    echo "ERROR: staged BUILD_ID '$staged_build_id' != shipped '$LOCAL_BUILD_ID' — truncated or stale artifact."
    echo "       Pre-cutover no-op; old build serving. Re-run deploy/deploy.sh."
    exit 1
  fi
  rm -f "$artifact_tar"
  echo "  artifact staged: BUILD_ID $staged_build_id under node v${vm_node_major}.x"
else
  echo ">>> Building Next.js site (staged — live server keeps serving)..."
  # next build CLEARS distDir at build start — that is exactly why the build is
  # staged (the 2026-07-22 itsc outage: 15 min of 502s while .next was empty).
  # Heap cap (site-deploy.env): an uncapped Next build OOM-wedged a 4GB VM
  # mid-build (itsc 2026-07-10). Capped, a too-big build fails cleanly as a
  # pre-cutover no-op; stage-build also self-marks the build as the kernel's
  # preferred OOM victim so an OOM never takes brain-api/postgres.
  sudo touch "$deploy_marker"
  bash deploy/stage-build.sh build
  bash deploy/stage-build.sh verify-relocatable
fi

# Migrations: new code against the live DB, old server still serving
# (expand-contract). AFTER the build so a failed build leaves the DB untouched.
# Pre-migrate hook (host-owned, optional, NOT template-rendered): tracking
# repairs — e.g. baseline drizzle.__drizzle_migrations on a schema that
# predates drizzle-kit tracking (itsc 2026-07-12).
echo ">>> Database migrations (from stage, live DB)..."
if [ -f "$stage_dir/deploy/pre-migrate.sh" ]; then
  echo ">>> Running host pre-migrate hook (stage cwd)..."
  (cd "$stage_dir" && bash deploy/pre-migrate.sh)
fi
(cd "$stage_dir" && npm run db:migrate); sudo touch "$deploy_marker"

# ── config:check gates the CUTOVER (§4.3 layer 3) ────────────────
# Config↔env cross-validation, BRAIN_PUBLIC_URL, brain version range, schema
# drift. AFTER migrate (the drift gate fails on committed-but-unapplied
# migrations), BEFORE the flip so a bad deploy never replaces a good one.
echo ">>> Running config:check (stage, post-migrate)..."
bash deploy/stage-build.sh check

# Sentinel OFF right after the check gate, BEFORE the extra-services bracket
# (v1.15.0): the cutover flip restarts the site — its seconds-wide health dip
# must never be read as starvation and trigger a scope kill.
kill "$sentinel_pid" 2>/dev/null || true
wait "$sentinel_pid" 2>/dev/null || true

# Pre-cutover gate: the seed artifact must exist/generate BEFORE the flip.
# SEED_MODE=file → the host commits a hand-curated deploy/seed-persona-memories.sql
# (e.g. aiwebsite's legacy seed-tron-* rows); "generate" derives it from
# site.config.ts using STAGE deps, writing to the LIVE tree (psql reads it later).
if [ "file" = "file" ]; then
  echo ">>> SEED_MODE=file — using committed deploy/seed-persona-memories.sql as-is"
  test -f "$stage_dir/deploy/seed-persona-memories.sql"
else
  echo ">>> Generating persona seed SQL from site.config.ts (stage deps, live output)..."
  (cd "$stage_dir" && npx tsx "$module_dir/scripts/generate-seed-sql.ts" --out "$app_dir/deploy/seed-persona-memories.sql")
fi

# ── CUTOVER BRACKET (renames only; the only live-tree mutation) ──
# Extra services stop only for the flip so native-ABI trees never change under
# a running service (the 2026-07-10 roleplay class) — a seconds-wide window.
#
# Connection-death shield (v1.78.0 fix round, M2a): a dropped SSH/IAP tunnel
# HUPs this shell — everywhere else that is a clean pre-cutover abort, but
# INSIDE the bracket it can kill the script BETWEEN two renames and leave the
# live tree half-flipped. Ignore HUP from here through the health gate /
# rollback so the bracket always reaches a terminal state (journal cleared,
# or rolled back, or the loud exit 1); heal + `deploy.sh --takeover` own the
# truly-unkillable cases (SIGKILL, power loss). The BRACKET START line below
# is the marker deploy.sh's failure banner tells the operator to grep for.
trap '' HUP
echo ">>> CUTOVER BRACKET START — journaled renames begin (if this log ends before the COMPLETE line, recover with deploy.sh --takeover: it heals first)"
sudo touch "$deploy_marker"
if [ -f deploy/extra-services.json ]; then
  echo ">>> Stopping extra services for the cutover flip..."
  sudo bash deploy/extra-services.sh stop 200>&- 201>&-
fi
bash deploy/stage-build.sh cutover               # ~ms; .old deletion deferred
if [ -f deploy/extra-services.json ]; then
  sudo bash deploy/extra-services.sh start 200>&- 201>&-
  bash deploy/extra-services.sh verify
fi
# `--update-env` (v1.6.1): pm2 reload keeps the env captured at process
# creation, NOT the freshly-evaluated ecosystem env — a deploy that only
# changed .env left a site running with stale caps for hours (aiwebsite
# governance budget incident, 2026-07-16).
pm2 startOrReload deploy/ecosystem.config.cjs --update-env 200>&- 201>&-

# ── Health gate (120s, watchdog-strength) + auto-rollback ────────
# Site body must carry "status":"ok" (not a bare 200), brain-api /health must
# answer, brain-api + skills-host must be pm2-online. On failure: roll the
# flip fully back to the N-1 generation and restart everything — the deploy
# fails with the OLD build serving.
gate_fail=""
site_ok=""
for i in $(seq 1 24); do
  body=$(curl -fsS -m 5 "http://127.0.0.1:3000/api/health" 2>/dev/null) || body=""
  echo "$body" | grep -q '"status":"ok"' && { site_ok=1; break; }
  sleep 5
done
[ -n "$site_ok" ] || gate_fail="site /api/health lacked \"status\":\"ok\" within 120s"
if [ -z "$gate_fail" ]; then
  brain_ok=""
  for i in $(seq 1 12); do
    curl -fsS -m 5 -o /dev/null "http://127.0.0.1:3211/health" && { brain_ok=1; break; }
    sleep 5
  done
  [ -n "$brain_ok" ] || gate_fail="brain-api /health not 200 within 60s"
fi
if [ -z "$gate_fail" ]; then
  # pm2 jlist captured ONCE and jq-validated (v1.78.0 fix round, M3): pm2 can
  # emit interleaved daemon chatter or nothing at all when its God daemon is
  # sick — piping that straight into jq made `jq -e` fail exactly like "app
  # not online" (right verdict, wrong reason) or, worse for the purge below,
  # silently yield ZERO names. A non-array is a hard gate failure, never a
  # silent pass.
  gate_jlist="$(pm2 jlist 200>&- 201>&- 2>/dev/null || true)"
  if ! printf '%s' "$gate_jlist" | jq -e 'type=="array"' >/dev/null 2>&1; then
    gate_fail="pm2 jlist did not return a JSON array — pm2 daemon state unverifiable"
  else
    for a in brain-api skills-host; do
      printf '%s' "$gate_jlist" | jq -e --arg n "$a" '.[] | select(.name==$n) | select(.pm2_env.status=="online")' >/dev/null \
        || gate_fail="pm2 app $a not online"
    done
  fi
fi
if [ -n "$gate_fail" ]; then
  echo "ERROR: post-cutover health gate failed ($gate_fail) — pm2 state follows; rolling back to previous generation"
  pm2 jlist 200>&- 201>&- | head -c 4000 || true
  # Rollback ladder (v1.78.0 fix round, L3): every rung is guarded so the
  # script ALWAYS reaches a truthful terminal message + exit 1. Before this,
  # a failed `stage-build.sh rollback` died mid-ladder under set -e: no pm2
  # restart, no extra-services start, and a log that ends mid-thought.
  if ! bash deploy/stage-build.sh rollback; then
    echo "!!! CRITICAL: stage-build.sh rollback FAILED — the live tree may still be the BAD new"
    echo "!!!           generation (or mixed). Inspect $app_dir/*.old and $stage_dir/.cutover-state,"
    echo "!!!           then heal + roll back by hand (RUNBOOK: local-artifact hosts / module rollback)."
  fi
  pm2 restart aiwebsite brain-api skills-host --update-env 200>&- 201>&- || true   # matches the manual command
  if [ -f deploy/extra-services.json ]; then sudo bash deploy/extra-services.sh start 200>&- 201>&- || true; fi
  # Re-probe the restored tree so the deploy's last words state what is
  # ACTUALLY serving, not the restart command's exit status.
  restored_ok=""
  for i in $(seq 1 12); do
    body=$(curl -fsS -m 5 "http://127.0.0.1:3000/api/health" 2>/dev/null) || body=""
    echo "$body" | grep -q '"status":"ok"' && { restored_ok=1; break; }
    sleep 5
  done
  if [ -n "$restored_ok" ]; then
    echo "ERROR: deploy FAILED ($gate_fail); rollback verified — the PREVIOUS generation is serving again."
  else
    echo "!!! CRITICAL: deploy FAILED ($gate_fail) AND the rolled-back tree did not come healthy"
    echo "!!!           within 60s — the site may be DOWN. Manual recovery NOW (RUNBOOK)."
  fi
  exit 1
fi
echo ">>> CUTOVER COMPLETE — the new build is LIVE (a failure after this line does NOT un-deploy it)"
bash deploy/stage-build.sh purge-trash           # delete the parked N-1 set OUTSIDE the bracket

# ── Config-derived artifacts (live tree now has new node_modules) ─
echo ">>> Rendering crawler config snapshot (data/aiwebsite-config.json)..."
npx tsx "$module_dir/scripts/config-json.ts"

# ── pm2 resurrect-dump hygiene (v1.78.0, local-artifact hosts) ───
# `pm2 save` snapshots EVERY running pm2 app into the resurrect dump — strays
# included — and `pm2 startup` resurrects that dump at boot. That pair is
# exactly what made a HAND-CREATED `itsc-build` app (`bash -c "npm run build"`
# in the live cwd) boot-persistent: on every boot it rewrote .next mid-serve,
# starved the box, and wedged sshd (2026-08-08 outage). "The template does not
# define it" is not prevention — the template must stop RE-PERSISTING it. On
# local-artifact hosts, any pm2 app not defined by deploy/ecosystem.config.cjs
# (plus the pm2-logrotate module) is deleted BEFORE the save, so a re-created
# stray can never survive a deploy into the dump again.
if [ "$build_mode" = "local-artifact" ]; then
  # Same M3 capture+validate discipline as the health gate above: an
  # unparseable jlist here used to yield an EMPTY stray list, so the purge
  # silently no-oped and `pm2 save` could re-persist a stray after all. An
  # unparseable jlist is a HARD error — refusing to save blind beats saving
  # a dump we cannot audit (the itsc-build class this purge exists to kill).
  purge_jlist="$(pm2 jlist 200>&- 201>&- 2>/dev/null || true)"
  if ! printf '%s' "$purge_jlist" | jq -e 'type=="array"' >/dev/null 2>&1; then
    echo "ERROR: pm2 jlist did not return a JSON array — cannot audit the app list before 'pm2 save'."
    echo "       Refusing to save the resurrect dump blind (a stray could re-persist)."
    echo "       The new build IS live (post-cutover step); fix pm2 (pm2 ping / pm2 update) and re-run setup-vm."
    exit 1
  fi
  for stray in $(printf '%s' "$purge_jlist" | jq -r '.[].name' | sort -u); do
    case "$stray" in
      "aiwebsite"|brain-api|skills-host|pm2-logrotate) ;;
      *)
        echo "!!! deleting stray pm2 app '$stray' (not in deploy/ecosystem.config.cjs) so pm2 save cannot re-persist it"
        pm2 delete "$stray" 200>&- 201>&- || true
        ;;
    esac
  done
fi
pm2 save 200>&- 201>&-
pm2 startup systemd -u "$(whoami)" --hp "$HOME" 2>/dev/null 200>&- 201>&- || true

# pm2-logrotate: 10M per file, retain 7 (§9.5 default-on log rotation)
pm2 install pm2-logrotate >/dev/null 2>&1 200>&- 201>&- || true
pm2 set pm2-logrotate:max_size 10M >/dev/null 200>&- 201>&-
pm2 set pm2-logrotate:retain 7 >/dev/null 200>&- 201>&-

# ── Persona seed memories ────────────────────────────────────────
# Public-scope brain memories that keep the persona identical across webchat,
# SMS, and phone calls (the voice path has no system-prompt injection point —
# these rows are its knowledge base). brain-api creates its tables on first
# boot, so wait for it before seeding. Idempotent upsert; safe on every deploy.
echo ">>> Waiting for brain-api and seeding persona memories..."
for i in $(seq 1 12); do
  curl -fsS -o /dev/null http://127.0.0.1:3211/health && break
  sleep 5
done
# Feed the seed over STDIN (opened by THIS shell, which can read $app_dir):
# `psql -f` makes the postgres user open the path itself, which fails with
# "Permission denied" whenever APP_DIR sits under a 0750 home directory
# (roleplay's /home/xladmin/roleplay, v1.4.1) — /var/www hosts never noticed.
sudo -u postgres psql -d "aiwebsite" -v ON_ERROR_STOP=1 < "$app_dir/deploy/seed-persona-memories.sql"

# ── Ops helper scripts → /usr/local/bin ──────────────────────────
echo ">>> Installing ops scripts..."
sudo install -m 755 "$app_dir/deploy/backup-db.sh"          /usr/local/bin/aiwebsite-backup-db.sh
sudo install -m 755 "$app_dir/deploy/restore-drill.sh"      /usr/local/bin/aiwebsite-restore-drill.sh
sudo install -m 755 "$app_dir/deploy/retention-sweeper.sh"  /usr/local/bin/aiwebsite-retention-sweeper.sh

# Daily disk check (§9.5: alert at >80%). Small enough to live inline here.
sudo tee /usr/local/bin/aiwebsite-disk-check.sh >/dev/null <<'EOS'
#!/usr/bin/env bash
# Daily disk-usage check — alerts via Resend at >80% on /.
set -uo pipefail
threshold=80
usage=$(df --output=pcent / | tail -1 | tr -dc '0-9')
if [ "$usage" -le "$threshold" ]; then
  echo "disk OK: $usage% used"
  exit 0
fi
key=$(grep -E '^RESEND_API_KEY=' "/var/www/aiwebsite/.env" 2>/dev/null | head -1 | cut -d'=' -f2- | tr -d '"' | tr -d "'")
echo "disk usage $usage% exceeds $threshold%"
issue_source="disk-check"
issue_spool_dir="/var/lib/aiwebsite/issue-spool.d"
record_issue() { # 1=severity-prefixed subject 2=body 3=issue key 4=emailed 0|1 [5=resolve 0|1] [6=resolvedBy]
  command -v jq >/dev/null 2>&1 || return 0
  local rf="$issue_spool_dir/${issue_source:-unknown}.ndjson"
  if [ ! -d "$issue_spool_dir" ]; then mkdir -p "$issue_spool_dir" 2>/dev/null || return 0; fi
  local rsz; rsz=$(stat -c %s "$rf" 2>/dev/null || echo 0)
  if [ "$rsz" -gt 1048576 ]; then return 0; fi
  local rsev
  rsev=$(printf '%s' "${1:-}" | grep -oE '^((HI-SPEED|SYNTH) )?(CRITICAL|ERROR|WARN)' || echo WARN)
  jq -nc --arg src "${issue_source:-unknown}" --arg k "${3:-}" --arg sev "$rsev" \
    --arg s "${1:-}" --arg b "${2:-}" --arg e "${4:-0}" --arg r "${5:-0}" --arg by "${6:-}" \
    --arg ts "$(date -u +%FT%TZ)" \
    '{action:(if $r=="1" then "resolve" else "record" end),source:$src,key:$k,severity:$sev,subject:($s|.[0:300]),detail:($b|.[0:4000]),emailed:($e=="1"),seenAt:$ts} + (if $r=="1" then {resolvedBy:(if ($by|length)>0 then $by else "auto" end),note:($s|.[0:300])} else {} end)' \
    >> "$rf" 2>/dev/null || true
  return 0
}
disk_body="Disk usage on $(hostname) is at $usage% (threshold $threshold%). Triage per deploy/RUNBOOK.md (disk-full section) before it reaches 100%."
if [ -z "$key" ]; then
  record_issue "WARN Disk usage at $usage%" "$disk_body" "disk-usage" 0
  exit 1
fi
if curl -s -X POST https://api.resend.com/emails \
  -H "Authorization: Bearer $key" \
  -H "Content-Type: application/json" \
  -d "{\"from\":\"ai.xl.net Watchdog <noreply@ai.xl.net>\",\"to\":[\"adam@xl.net\"],\"subject\":\"[aiwebsite] WARN Disk usage at $usage%\",\"text\":\"$disk_body\",\"headers\":{\"Auto-Submitted\":\"auto-generated\",\"X-Auto-Response-Suppress\":\"All\"}}" >/dev/null; then
  record_issue "WARN Disk usage at $usage%" "$disk_body" "disk-usage" 1
else
  record_issue "WARN Disk usage at $usage%" "$disk_body" "disk-usage" 0
fi
exit 1
EOS
sudo chmod 755 /usr/local/bin/aiwebsite-disk-check.sh

# ── Scheduled work: systemd timers (Persistent=true), NOT cron (§9.3) ─
echo ">>> Installing systemd timer units..."
deploy_user="$(whoami)"

# Issue-ledger spool (§5.15 v1.30) — one NDJSON file per emitter, drained by
# the watchdog into reported_issues. UNCONDITIONAL (not gated on backups) and
# setgid-group-writable: root emitters (watchdog, peer-monitor, backup,
# restore-drill, disk-check) and the deploy-user hi-speed unit both append
# here, so a plain 0755 root dir would make hi-speed's best-effort helper a
# permanent silent no-op.
sudo install -d -m 2775 -o root -g "$deploy_user" /var/lib/aiwebsite
sudo install -d -m 2775 -o root -g "$deploy_user" /var/lib/aiwebsite/issue-spool.d

# Nightly knowledge crawl. ExecStartPre re-renders the JSON config snapshot so
# the crawler always sees the currently deployed site.config.ts (§8).
sudo tee /etc/systemd/system/aiwebsite-knowledge.service >/dev/null <<UNIT
[Unit]
Description=aiwebsite nightly knowledge crawl (§8)
After=network-online.target postgresql.service

[Service]
Type=oneshot
User=$deploy_user
WorkingDirectory=/var/www/aiwebsite
ExecStartPre=/usr/bin/env npx tsx /var/www/aiwebsite/packages/aicompany/scripts/config-json.ts
ExecStart=/usr/bin/env node /var/www/aiwebsite/packages/aicompany/scripts/refresh-knowledge.mjs --config /var/www/aiwebsite/data/aiwebsite-config.json
StandardOutput=append:/var/log/aiwebsite-knowledge.log
StandardError=append:/var/log/aiwebsite-knowledge.log
UNIT
sudo tee /etc/systemd/system/aiwebsite-knowledge.timer >/dev/null <<'UNIT'
[Unit]
Description=Nightly aiwebsite knowledge crawl

[Timer]
OnCalendar=*-*-* 08:00:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
UNIT

# Nightly blog generate/refresh (§19.11) — installed only when BLOG_ENABLED=1
# in site-deploy.env (same gating pattern as the backup stack below).
# After=<slug>-knowledge.service: ordering is enforced, not assumed — the
# 08:00 crawl's worst case overruns 09:30. RandomizedDelaySec is derived from
# a slug hash (2700–5400s) so N hosts never share a publish window
# (network-footprint mitigation). The log is covered by the
# /var/log/aiwebsite-*.log logrotate glob installed below.
# RuntimeMaxSec=7200 (v1.102.0): the run-level deadline. Type=oneshot never
# double-starts, so a HUNG run (the v1.99.0 class: a poisoned shared pg
# client waiting forever) silently blocks EVERY future timer fire — no
# alert, no catch-up, just a nightly that stops happening. Derivation: max
# observed run 71 min (2026-08-22); worst-case HONEST run is 12 articles ×
# the 450s panel ceiling + audio ≈ 100 min; 2h kills only runs that are
# already dead. Failure surface, named: a systemd SIGTERM/SIGKILL at the
# deadline may skip blog-nightly's data/blog-last-run heartbeat write, so
# the stamp goes stale — the watchdog's 26h blog-heartbeat age check is the
# backstop that surfaces a killed-every-night job as a WARN.
if [ "1" = "1" ]; then
  blog_delay=$(( 2700 + $(printf '%s' "aiwebsite" | cksum | cut -d' ' -f1) % 2700 ))
  sudo tee /etc/systemd/system/aiwebsite-blog.service >/dev/null <<UNIT
[Unit]
Description=aiwebsite nightly blog generate/refresh (§19)
After=network-online.target postgresql.service aiwebsite-knowledge.service

[Service]
Type=oneshot
RuntimeMaxSec=7200
User=$deploy_user
WorkingDirectory=/var/www/aiwebsite
ExecStart=/var/www/aiwebsite/node_modules/.bin/tsx /var/www/aiwebsite/packages/aicompany/scripts/blog-nightly.ts
StandardOutput=append:/var/log/aiwebsite-blog.log
StandardError=append:/var/log/aiwebsite-blog.log
UNIT
  sudo tee /etc/systemd/system/aiwebsite-blog.timer >/dev/null <<UNIT
[Unit]
Description=Nightly aiwebsite blog run

[Timer]
OnCalendar=*-*-* 09:30:00 UTC
RandomizedDelaySec=$blog_delay
Persistent=true

[Install]
WantedBy=timers.target
UNIT
  # Blog monthly digest (§19.18) — same BLOG_ENABLED conditional. The timer
  # fires DAILY on the bare BLOG_DIGEST_ONCALENDAR placeholder (REQUIRED key —
  # render.mjs substitutes bare UPPER_SNAKE placeholders only; a
  # fallback-default form would pass through to systemd as a dead timer, so a
  # host that skips the MIGRATIONS v1.1.0 env step fails loudly at render).
  # The SCRIPT is the gate: monthlyDigest.enabled
  # false ⇒ OK-skip, and the in-script month guard (day ≥ dayOfMonth ∧
  # lastSentMonth < currentMonth) makes Persistent=true boot catch-up correct
  # regardless of systemd stamp state. Log covered by the aiwebsite-*.log
  # logrotate glob below; the watchdog alerts when data/blog-digest-last is
  # >35d stale while BLOG_ENABLED.
  sudo tee /etc/systemd/system/aiwebsite-blog-digest.service >/dev/null <<UNIT
[Unit]
Description=aiwebsite monthly blog digest (§19.18)
After=network-online.target postgresql.service

[Service]
Type=oneshot
User=$deploy_user
WorkingDirectory=/var/www/aiwebsite
ExecStart=/var/www/aiwebsite/node_modules/.bin/tsx /var/www/aiwebsite/packages/aicompany/scripts/blog-digest.ts
StandardOutput=append:/var/log/aiwebsite-blog-digest.log
StandardError=append:/var/log/aiwebsite-blog-digest.log
UNIT
  sudo tee /etc/systemd/system/aiwebsite-blog-digest.timer >/dev/null <<UNIT
[Unit]
Description=Daily aiwebsite blog digest (self-gating month guard)

[Timer]
OnCalendar=*-*-* 14:00:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
UNIT
fi

# Nightly DB backup (default-on invariant, §9.4)
sudo tee /etc/systemd/system/aiwebsite-backup.service >/dev/null <<'UNIT'
[Unit]
Description=aiwebsite nightly pg_dump backup (§9.4)
After=postgresql.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/aiwebsite-backup-db.sh
StandardOutput=append:/var/log/aiwebsite-backup.log
StandardError=append:/var/log/aiwebsite-backup.log
UNIT
sudo tee /etc/systemd/system/aiwebsite-backup.timer >/dev/null <<'UNIT'
[Unit]
Description=Nightly aiwebsite DB backup

[Timer]
OnCalendar=*-*-* 07:15:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
UNIT

# Quarterly restore drill — a backup that cannot be restored is not a backup.
sudo tee /etc/systemd/system/aiwebsite-restore-drill.service >/dev/null <<'UNIT'
[Unit]
Description=aiwebsite quarterly backup restore drill (§9.4)
After=postgresql.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/aiwebsite-restore-drill.sh
StandardOutput=append:/var/log/aiwebsite-restore-drill.log
StandardError=append:/var/log/aiwebsite-restore-drill.log
UNIT
sudo tee /etc/systemd/system/aiwebsite-restore-drill.timer >/dev/null <<'UNIT'
[Unit]
Description=Quarterly aiwebsite restore drill

[Timer]
OnCalendar=*-01,04,07,10-05 06:30:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
UNIT

# Weekly retention sweep — keeps the DB in lockstep with the privacy page (§1).
sudo tee /etc/systemd/system/aiwebsite-retention-sweeper.service >/dev/null <<'UNIT'
[Unit]
Description=aiwebsite weekly retention sweep (§9.5)
After=postgresql.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/aiwebsite-retention-sweeper.sh
StandardOutput=append:/var/log/aiwebsite-retention-sweeper.log
StandardError=append:/var/log/aiwebsite-retention-sweeper.log
UNIT
sudo tee /etc/systemd/system/aiwebsite-retention-sweeper.timer >/dev/null <<'UNIT'
[Unit]
Description=Weekly aiwebsite retention sweep

[Timer]
OnCalendar=Sun *-*-* 05:30:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
UNIT

# Daily disk-usage check (§9.5)
sudo tee /etc/systemd/system/aiwebsite-disk-check.service >/dev/null <<'UNIT'
[Unit]
Description=aiwebsite daily disk-usage check (§9.5)

[Service]
Type=oneshot
ExecStart=/usr/local/bin/aiwebsite-disk-check.sh
StandardOutput=append:/var/log/aiwebsite-disk-check.log
StandardError=append:/var/log/aiwebsite-disk-check.log
UNIT
sudo tee /etc/systemd/system/aiwebsite-disk-check.timer >/dev/null <<'UNIT'
[Unit]
Description=Daily aiwebsite disk check

[Timer]
OnCalendar=*-*-* 06:45:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
UNIT

# Cross-site peer monitor (§9.7 — template-managed since v1.15.0; formerly a
# manual runbook step: the 2026-07-22 forensics burned an hour establishing
# whether the DOWN alert had even fired, because hand-managed units are
# unverifiable from the module). Runs the RENDERED deploy/peer-monitor.sh
# from the app tree, so a re-render lands on the next fire with no unit edit.
sudo tee /etc/systemd/system/aiwebsite-peer-monitor.service >/dev/null <<'UNIT'
[Unit]
Description=aiwebsite cross-site peer monitor (§9.7)
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/bin/env bash /var/www/aiwebsite/deploy/peer-monitor.sh
StandardOutput=append:/var/log/aiwebsite-peer-monitor.log
StandardError=append:/var/log/aiwebsite-peer-monitor.log
UNIT
sudo tee /etc/systemd/system/aiwebsite-peer-monitor.timer >/dev/null <<'UNIT'
[Unit]
Description=aiwebsite peer monitor every 5 min (§9.7)

[Timer]
OnCalendar=*:0/5
Persistent=true

[Install]
WantedBy=timers.target
UNIT

# Nightly "Hi" speed gate (§9.9 v1.20.0 — alert-only; after the itsc 5-7s
# and ai.xl.net 36s greeting incidents). Runs the RENDERED deploy/hi-speed.sh
# (same re-render-lands-next-fire contract as the peer monitor). 05:10 UTC
# sits ≥85 min clear of every module timer and ~1h50m before itsc's 07:00 UTC
# collect-nightly brain hammering. WorkingDirectory is load-bearing: the
# probe resolves .env (bearer) from cwd.
sudo tee /etc/systemd/system/aiwebsite-hi-speed.service >/dev/null <<UNIT
[Unit]
Description=aiwebsite nightly Hi-speed gate (§9.9, alert-only)
After=network-online.target

[Service]
Type=oneshot
User=$deploy_user
WorkingDirectory=/var/www/aiwebsite
ExecStart=/usr/bin/env bash /var/www/aiwebsite/deploy/hi-speed.sh
StandardOutput=append:/var/log/aiwebsite-hi-speed.log
StandardError=append:/var/log/aiwebsite-hi-speed.log
UNIT
sudo tee /etc/systemd/system/aiwebsite-hi-speed.timer >/dev/null <<'UNIT'
[Unit]
Description=aiwebsite nightly Hi-speed gate (§9.9)

[Timer]
OnCalendar=*-*-* 05:10:00 UTC
RandomizedDelaySec=600
Persistent=true

[Install]
WantedBy=timers.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now aiwebsite-knowledge.timer \
  aiwebsite-retention-sweeper.timer aiwebsite-disk-check.timer \
  aiwebsite-peer-monitor.timer aiwebsite-hi-speed.timer
# Backups are a §1 default-on invariant, but enabling the timer with no bucket
# just produces nightly failure alerts — gate on BACKUP_BUCKET and leave a flag
# the watchdog uses to decide whether the heartbeat check applies.
# azure-cli, ONLY for azblob:// hosts (v1.66.0). Gated three ways: on the
# bucket scheme, so a gs:// host (itsupportchicago) installs nothing and its
# deploy is byte-identical to before; on `command -v az`, because deploy.sh runs
# this script on EVERY deploy and re-running the install would add minutes each
# time; and on the apt-get succeeding, since it needs a THIRD-PARTY Microsoft
# repo (azure-cli is not in Ubuntu's archive — verified: `apt-cache policy
# azure-cli` is empty on 24.04).
#
# That third-party repo is a real, known liability on this fleet: roleplay still
# carries /etc/apt/sources.list.d/nodesource.sources.disabled-403 from a vendor
# repo that started 403ing and had to be disabled by hand. So the failure is
# made LOUD here rather than left to the generic apt warning — a box that
# silently loses `az` would take its backups down with it, and the whole point
# of this release is to stop backups failing quietly.
case "azblob://xlaiwebbackups/backups" in
  azblob://*)
    if ! command -v az >/dev/null 2>&1; then
      echo ">>> Installing azure-cli (required by BACKUP_BUCKET=azblob://xlaiwebbackups/backups)..."
      if curl -sLS https://packages.microsoft.com/keys/microsoft.asc \
           | sudo gpg --dearmor --yes -o /usr/share/keyrings/microsoft.gpg \
         && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/microsoft.gpg] https://packages.microsoft.com/repos/azure-cli/ $(lsb_release -cs) main" \
           | sudo tee /etc/apt/sources.list.d/azure-cli.list >/dev/null \
         && sudo apt-get update -qq \
         && sudo apt-get install -y azure-cli; then
        echo "    azure-cli installed: $(az version --query '\"azure-cli\"' -o tsv 2>/dev/null || echo unknown)"
      else
        echo "!!! azure-cli install FAILED — nightly backups to azblob://xlaiwebbackups/backups CANNOT run."
        echo "!!! The Microsoft apt repo is third-party and has 403'd on this fleet before."
        echo "!!! Deploy continues (the app is unaffected), but backups are DOWN until fixed."
      fi
    fi
    ;;
esac

if [ -n "azblob://xlaiwebbackups/backups" ]; then
  sudo systemctl enable --now aiwebsite-backup.timer aiwebsite-restore-drill.timer
  sudo mkdir -p /var/lib/aiwebsite && sudo touch /var/lib/aiwebsite/backups-enabled
else
  echo "WARN: BACKUP_BUCKET is empty — nightly pg_dump backups are NOT enabled."
  echo "      Provision a bucket, set BACKUP_BUCKET in deploy/site-deploy.env, re-render, redeploy."
  sudo systemctl disable --now aiwebsite-backup.timer aiwebsite-restore-drill.timer 2>/dev/null || true
  sudo rm -f /var/lib/aiwebsite/backups-enabled
fi
# Blog timer follows the same conditional pattern: BLOG_ENABLED=0 must actively
# disable a previously enabled timer (a host turning the blog off should not
# keep publishing), and the watchdog's rendered BLOG_ENABLED gate keeps the
# heartbeat check in lockstep.
if [ "1" = "1" ]; then
  sudo systemctl enable --now aiwebsite-blog.timer aiwebsite-blog-digest.timer
else
  sudo systemctl disable --now aiwebsite-blog.timer aiwebsite-blog-digest.timer 2>/dev/null || true
fi
echo ">>> Timers installed:"
systemctl list-timers "aiwebsite-*" --no-pager || true

# ── logrotate for non-PM2 logs (§9.5: weekly, keep 4, compress) ──
# NOTE: this site's nginx logs (/var/log/nginx/aiwebsite.*.log) are deliberately
# NOT listed here — the distro's /etc/logrotate.d/nginx glob already covers
# them (daily, rotate 14 on Debian), and a duplicate logrotate entry makes it
# skip entries unpredictably. §9.5 documents this delegation.
sudo tee /etc/logrotate.d/aiwebsite >/dev/null <<'EOF'
/var/log/aiwebsite-*.log {
    weekly
    rotate 4
    compress
    missingok
    notifempty
    copytruncate
}
EOF

# ── Initial knowledge crawl ──────────────────────────────────────
# Run once per deploy (without the email) so fresh knowledge is live from this
# deploy instead of after the first timer fire.
echo ">>> Running initial knowledge crawl (no email)..."
node "$module_dir/scripts/refresh-knowledge.mjs" --config "$app_dir/data/aiwebsite-config.json" --no-email || \
  echo "WARN: initial knowledge crawl failed — the persona uses the existing/starter knowledge doc until tonight's timer run"

# ── Cloudflare tunnel ────────────────────────────────────────────
sudo bash "$app_dir/deploy/setup-cloudflared.sh"

# ── Watchdog (self-healing service checks + email alerts) ────────
# watchdog-cron.sh expects the watchdog at /usr/local/bin/aiwebsite-watchdog.sh.
# The */5 cron supervisor is the ONE deliberate cron entry (§9.5).
echo ">>> Installing watchdog + cron supervisor..."
sudo install -m 755 "$app_dir/deploy/watchdog.sh"      /usr/local/bin/aiwebsite-watchdog.sh
sudo install -m 755 "$app_dir/deploy/watchdog-cron.sh" /usr/local/bin/aiwebsite-watchdog-cron.sh
# Merge keeps unrelated root-cron entries but strips jobs the systemd timers
# replaced (a leftover legacy crawl cron would double-run nightly).
# `|| true` on BOTH stages (v1.4.2): an EMPTY root crontab exits `crontab -l`
# nonzero, and a no-match `grep -v` exits nonzero on empty input — under
# `set -euo pipefail` either killed the subshell before the echo and the
# deploy died silently on any VM getting its FIRST module watchdog (roleplay
# cutover); hosts with existing root crontabs never hit it.
( { sudo crontab -l 2>/dev/null || true; } | { grep -vE 'refresh-tron-knowledge|refresh-knowledge\.(mjs|js)' || true; } ; \
  echo "*/5 * * * * /usr/local/bin/aiwebsite-watchdog-cron.sh" ) | sort -u | sudo crontab -
# Restart the watchdog so it picks up the freshly installed version, then
# start immediately instead of waiting up to 5 minutes for cron.
#
# Terminate ALL old instances deterministically, not just the pid-file one:
# the pid file only ever named the last writer, so a pid-file kill orphaned
# every other live daemon and they accumulated (23 concurrent, aiwebsite
# 2026-07-13). Match by the daemon's full script name via a bracket-glob
# ([a]iwebsite-watchdog.sh) so the pkill/pgrep command lines do NOT self-match
# and neither does the SSH wrapper or the "-cron.sh" supervisor (whose cmdline
# does not contain the substring "aiwebsite-watchdog.sh"). Do NOT delete the
# lock file — its stable inode is the singleton's authority; removing it would
# let a straggler and a fresh start hold two independent locks.
wd_slug="aiwebsite"
wd_pattern="[${wd_slug:0:1}]${wd_slug:1}-watchdog.sh"
sudo pkill -f "$wd_pattern" 2>/dev/null || true
for _ in $(seq 1 10); do
  sudo pgrep -f "$wd_pattern" >/dev/null 2>&1 || break
  sleep 1
done
if sudo pgrep -f "$wd_pattern" >/dev/null 2>&1; then
  echo "WARN: watchdog instances survived SIGTERM — escalating to SIGKILL"
  sudo pkill -9 -f "$wd_pattern" 2>/dev/null || true
  sleep 1
fi
sudo rm -f /var/run/aiwebsite-watchdog.pid
# v1.30.1: WAIT FOR THE LOCK, not just for the process. pkill matched the
# daemon's own cmdline; its children (the inter-pass `sleep`, an in-flight
# curl) do NOT match, survive the signal, and INHERIT the singleton lock fd —
# so the lock can stay held for up to check_interval (60 s) after the daemon
# is gone. watchdog-cron.sh decides liveness by trying to TAKE that lock, so
# calling it inside that window makes it log "Watchdog is running", no-op, and
# leave ZERO watchdogs until the next */5 cron tick (proven on
# itsupportchicago 2026-07-26 — a 5-minute self-healing hole after every
# deploy). Probing with `flock -n <file> true` neither deletes nor truncates
# the lock file, so the singleton's stable inode is preserved.
wd_lock="/var/run/aiwebsite-watchdog.lock"
for _ in $(seq 1 75); do
  sudo flock -n "$wd_lock" true 2>/dev/null && break
  sleep 1
done
if ! sudo flock -n "$wd_lock" true 2>/dev/null; then
  echo "WARN: aiwebsite-watchdog.lock still held after 75s — a straggler child outlived the daemon;"
  echo "      the supervisor may no-op and cron will start the watchdog within 5 minutes."
fi
# `200>&- 201>&-`: the freshly started watchdog is the archetypal long-lived
# spawn — it must not inherit + pin this deploy's lock (fd 200) or the stage
# lock (fd 201).
sudo /usr/local/bin/aiwebsite-watchdog-cron.sh 200>&- 201>&- || true
# Confirm the restart actually took, and retry ONCE: the supervisor no-ops
# whenever the lock is held, so a straggler that released it between the probe
# and the call would otherwise leave the deploy finishing watchdog-less.
sleep 2
if ! sudo pgrep -f "$wd_pattern" >/dev/null 2>&1; then
  echo "WARN: no watchdog after the supervisor call — retrying once"
  sleep 5
  sudo /usr/local/bin/aiwebsite-watchdog-cron.sh 200>&- 201>&- || true
  sleep 2
  sudo pgrep -f "$wd_pattern" >/dev/null 2>&1 || \
    echo "WARN: watchdog STILL not running — cron's */5 supervisor is the backstop; see /var/log/aiwebsite-watchdog-cron.log"
fi

# ── Version stamp (v1.4.0, §13) ──────────────────────────────────
# Record the applied module tag in the DB (aicompany_version) so
# upgrade:check --dry-run can list pending MIGRATIONS entries before the
# next bump. Non-fatal: a missing host script must not fail the deploy.
echo ">>> Stamping deployed module version (upgrade:check --stamp)..."
npm run --silent upgrade:check -- --stamp 200>&- 201>&- || \
  echo "WARNING: upgrade:check --stamp failed (non-fatal — stamp manually or add the host npm script)"

# Deploy done — clear the mutex marker so the watchdog resumes repair ACTIONS
# immediately. set -euo pipefail means we only reach here on success; a crashed
# deploy deliberately leaves the marker to age out over the TTL (§9.5).
sudo rm -f "$deploy_marker"

echo ""
echo "=== Setup complete ==="
echo "Local checks:"
echo "  curl -fsS http://127.0.0.1:3000/api/health          # Next.js"
echo "  curl -fsS http://127.0.0.1:3211/health            # brain-api"
echo "  systemctl list-timers 'aiwebsite-*'                          # all 7 timers present (+ blog when BLOG_ENABLED=1)"
echo "Public check (after the human DNS step propagates):"
echo "  curl -fsS https://ai.xl.net/api/health"
