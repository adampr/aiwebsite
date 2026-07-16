#!/usr/bin/env bash
# aicompany-template: setup-vm.sh.tpl@f330c333a3bc93d8088ebb25df15d2526f2ecc8daf92df4379fb495218db5252
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

# ── System packages ──────────────────────────────────────────────
# build-essential/python3/libpq-dev are required to compile the brain's
# native deps (better-sqlite3, pg-native).
sudo apt-get update -qq
# lsof: extra-services stop/start identity (v1.4.0) — without it, port-holder
# detection silently degrades and services can double-start.
sudo apt-get install -y -qq build-essential python3 libpq-dev pkg-config jq rsync logrotate lsof

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
sudo nginx -t && sudo systemctl reload nginx

# ── App install & build ──────────────────────────────────────────
cd "$app_dir"

if [ ! -f .env ]; then
  echo "ERROR: $app_dir/.env is missing. deploy.sh should have copied it."
  exit 1
fi

# ── Extra services: stop BEFORE npm ci (v1.4.0, §9.5) ───────────
# `npm ci` wipes node_modules under a RUNNING extra service — native-ABI
# crash-loop, the 2026-07-10 roleplay outage class. Validate fail-fast, then
# stop every declared service; they restart (health-gated) after db:migrate.
# ABSENT manifest is loud on purpose: on a VM that is in fact running an
# unmanaged service, a silent skip here replays that outage with green logs.
if [ -f deploy/extra-services.json ]; then
  bash deploy/extra-services.sh validate
  echo ">>> Stopping extra services before npm ci..."
  sudo bash deploy/extra-services.sh stop 200>&-
else
  echo "WARN: no deploy/extra-services.json — extra-service stop-before-ci and supervision are OFF for this deploy"
fi

echo ">>> Installing site dependencies..."
# --include=dev: the VM environment omits devDependencies by default, but the
# build needs them (drizzle-kit, typescript, tailwind, tsx) — same reason as
# the brain install below.
npm ci --include=dev
# Re-touch the mutex marker after EACH npm ci block (v1.4.0): the span between
# the initial touch and the pre-build re-touch now carries es_stop + two npm
# ci runs + native rebuilds + migrate — on a small VM that can outrun the
# 30-min TTL, letting the watchdog resume repairs mid-install (§9.5).
sudo touch "$deploy_marker"

echo ">>> Installing brain (packages/brain) dependencies..."
if [ ! -f packages/brain/package.json ]; then
  echo "ERROR: packages/brain is empty — submodule contents were not synced."
  exit 1
fi
(cd packages/brain && npm ci --include=dev)
sudo touch "$deploy_marker"

# Post-install hook (host-owned, optional, NOT template-rendered — v1.4.0,
# the pre-migrate.sh precedent): native ABI rebuilds / require gates for
# hosts whose services run under a different Node than the toolchain. Runs
# after BOTH npm ci blocks, before migrations; failure aborts the deploy
# before any restart (`set -e`).
if [ -f deploy/post-install.sh ]; then
  echo ">>> Running host post-install hook (deploy/post-install.sh)..."
  bash deploy/post-install.sh
  sudo touch "$deploy_marker"
fi

echo ">>> Database migrations (site tables, committed history)..."
# Pre-migrate hook (host-owned, optional, NOT template-rendered): runs before
# drizzle-kit migrate when the host commits deploy/pre-migrate.sh. Use it for
# host-specific tracking repairs — e.g. a schema that predates drizzle-kit
# tracking must baseline drizzle.__drizzle_migrations first, or migrate
# replays migration 0000 into the live schema and aborts the deploy (itsc
# 2026-07-12; their hook runs src/scripts/baseline-drizzle.ts).
if [ -f deploy/pre-migrate.sh ]; then
  echo ">>> Running host pre-migrate hook (deploy/pre-migrate.sh)..."
  bash deploy/pre-migrate.sh
fi
npm run db:migrate

# ── Extra services: start + health-gate AFTER migrate, BEFORE build ─
# (v1.4.0, §9.5) Restarting here keeps the service window off the build's
# critical path: fresh code + fresh node_modules are live the moment the DB
# is migrated. verify fails the deploy if a service can't pass health inside
# its startTimeoutSeconds.
if [ -f deploy/extra-services.json ]; then
  echo ">>> Starting extra services (health-gated)..."
  sudo bash deploy/extra-services.sh start 200>&-
  bash deploy/extra-services.sh verify
fi

echo ">>> Building Next.js site..."
# deploy.sh excludes .next from rsync, and a stale Turbopack cache from a
# previous next version breaks module resolution ("Can't resolve" errors on
# deps that are installed). Clear only the cache — the rest of .next is
# replaced atomically by the build while the live server keeps serving it.
rm -rf .next/cache
# Heap cap (site-deploy.env): an uncapped Next build OOM-wedged a 4GB VM
# mid-build (itsc 2026-07-10 — kernel OOM killer destroyed .next/BUILD_ID,
# dropped the tunnel, needed a hard instance reset). Capped, a too-big build
# fails cleanly with a JS heap error while the live site keeps serving.
# Re-touch the mutex marker so its mtime stays fresh across the build window
# (the watchdog's repair grace is 30 min; a slow install+build can approach it).
sudo touch "$deploy_marker"
NODE_OPTIONS="--max-old-space-size=1024" npm run build

# ── Config-derived artifacts (need node_modules, hence after npm ci) ─
echo ">>> Rendering crawler config snapshot (data/aiwebsite-config.json)..."
npx tsx "$module_dir/scripts/config-json.ts"

# SEED_MODE=file → the host commits a hand-curated deploy/seed-persona-memories.sql
# (e.g. aiwebsite's legacy seed-tron-* rows, which prod already carries and the
# voice channel depends on); "generate" derives it from site.config.ts.
if [ "file" = "file" ]; then
  echo ">>> SEED_MODE=file — using committed deploy/seed-persona-memories.sql as-is"
  test -f deploy/seed-persona-memories.sql
else
  echo ">>> Generating persona seed SQL from site.config.ts..."
  npx tsx "$module_dir/scripts/generate-seed-sql.ts" --out deploy/seed-persona-memories.sql
fi

# ── config:check gates the reload (§4.3 layer 3) ─────────────────
# Config↔env cross-validation, BRAIN_PUBLIC_URL, brain version range, schema
# drift. Runs BEFORE the PM2 reload so a bad deploy never replaces a good one.
echo ">>> Running config:check..."
npm run config:check

# ── PM2: site + brain-api + skills-host ──────────────────────────
# Re-touch the mutex marker before the long post-build tail (pm2 reload → brain
# health wait → seed → timers → initial knowledge crawl → cloudflared). A slow
# build followed by this tail can otherwise age the marker past its 30-min TTL
# mid-deploy, letting the watchdog resume repairs while the deploy is still
# running (§9.5).
sudo touch "$deploy_marker"
# `200>&-` on every pm2 invocation: first contact resurrects the pm2 God
# daemon, which must not inherit + pin the deploy lock (fd 200).
# `--update-env` (v1.6.1): pm2 reload keeps the env captured at process
# creation, NOT the freshly-evaluated ecosystem env — a deploy that only
# changed .env left a site running with stale caps for hours (aiwebsite
# governance budget incident, 2026-07-16). Upstream adoption of that host's
# documented HOST EDIT.
pm2 startOrReload deploy/ecosystem.config.cjs --update-env 200>&-
pm2 save 200>&-
pm2 startup systemd -u "$(whoami)" --hp "$HOME" 2>/dev/null 200>&- || true

# pm2-logrotate: 10M per file, retain 7 (§9.5 default-on log rotation)
pm2 install pm2-logrotate >/dev/null 2>&1 200>&- || true
pm2 set pm2-logrotate:max_size 10M >/dev/null 200>&-
pm2 set pm2-logrotate:retain 7 >/dev/null 200>&-

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
[ -z "$key" ] && exit 1
curl -s -X POST https://api.resend.com/emails \
  -H "Authorization: Bearer $key" \
  -H "Content-Type: application/json" \
  -d "{\"from\":\"ai.xl.net Watchdog <noreply@ai.xl.net>\",\"to\":[\"adam@xl.net\"],\"subject\":\"[aiwebsite] WARN Disk usage at $usage%\",\"text\":\"Disk usage on $(hostname) is at $usage% (threshold $threshold%). Triage per deploy/RUNBOOK.md (disk-full section) before it reaches 100%.\"}" >/dev/null || true
exit 1
EOS
sudo chmod 755 /usr/local/bin/aiwebsite-disk-check.sh

# ── Scheduled work: systemd timers (Persistent=true), NOT cron (§9.3) ─
echo ">>> Installing systemd timer units..."
deploy_user="$(whoami)"

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
if [ "1" = "1" ]; then
  blog_delay=$(( 2700 + $(printf '%s' "aiwebsite" | cksum | cut -d' ' -f1) % 2700 ))
  sudo tee /etc/systemd/system/aiwebsite-blog.service >/dev/null <<UNIT
[Unit]
Description=aiwebsite nightly blog generate/refresh (§19)
After=network-online.target postgresql.service aiwebsite-knowledge.service

[Service]
Type=oneshot
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

sudo systemctl daemon-reload
sudo systemctl enable --now aiwebsite-knowledge.timer \
  aiwebsite-retention-sweeper.timer aiwebsite-disk-check.timer
# Backups are a §1 default-on invariant, but enabling the timer with no bucket
# just produces nightly failure alerts — gate on BACKUP_BUCKET and leave a flag
# the watchdog uses to decide whether the heartbeat check applies.
if [ -n "" ]; then
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
# `200>&-`: the freshly started watchdog is the archetypal long-lived spawn —
# it must not inherit + pin this deploy's lock (fd 200).
sudo /usr/local/bin/aiwebsite-watchdog-cron.sh 200>&- || true

# ── Version stamp (v1.4.0, §13) ──────────────────────────────────
# Record the applied module tag in the DB (aicompany_version) so
# upgrade:check --dry-run can list pending MIGRATIONS entries before the
# next bump. Non-fatal: a missing host script must not fail the deploy.
echo ">>> Stamping deployed module version (upgrade:check --stamp)..."
npm run --silent upgrade:check -- --stamp 200>&- || \
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
echo "  systemctl list-timers 'aiwebsite-*'                          # all 5 timers present (+ blog when BLOG_ENABLED=1)"
echo "Public check (after the human DNS step propagates):"
echo "  curl -fsS https://ai.xl.net/api/health"
