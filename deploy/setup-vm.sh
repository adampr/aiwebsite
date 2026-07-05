#!/usr/bin/env bash
set -euo pipefail

# One-time VM provisioning for ai.xl.net (idempotent — safe to re-run).
# Assumes the repo (incl. packages/brain submodule contents and .env) has
# been synced to $APP_DIR by deploy/deploy.sh.

APP_DIR="/var/www/aiwebsite"

echo "=== XL.net AI Website — VM Setup ==="

# ── System packages ──────────────────────────────────────────────
# build-essential/python3/libpq-dev are required to compile the brain's
# native deps (better-sqlite3, pg-native).
sudo apt-get update -qq
sudo apt-get install -y -qq build-essential python3 libpq-dev pkg-config jq rsync

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
  sudo -u postgres psql -c "CREATE USER aiwebsite WITH PASSWORD 'aiwebsite';"
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='aiwebsite'" | grep -q 1 || \
  sudo -u postgres createdb -O aiwebsite aiwebsite

# nginx — loopback-only; the Cloudflare tunnel is the sole public entry
if ! command -v nginx &>/dev/null; then
  sudo apt-get install -y nginx
fi
sudo cp "$APP_DIR/deploy/nginx.conf" /etc/nginx/sites-available/aiwebsite
sudo ln -sf /etc/nginx/sites-available/aiwebsite /etc/nginx/sites-enabled/aiwebsite
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

# ── App install & build ──────────────────────────────────────────
cd "$APP_DIR"

if [ ! -f .env ]; then
  echo "ERROR: $APP_DIR/.env is missing. deploy.sh should have copied it."
  exit 1
fi

echo ">>> Installing site dependencies..."
npm ci

echo ">>> Installing brain (packages/brain) dependencies..."
if [ ! -f packages/brain/package.json ]; then
  echo "ERROR: packages/brain is empty — submodule contents were not synced."
  exit 1
fi
(cd packages/brain && npm ci --include=dev)

echo ">>> Database migrations (site tables)..."
npm run db:generate
npm run db:migrate

echo ">>> Building Next.js site..."
npm run build

# ── PM2: site + brain-api + skills-host ──────────────────────────
pm2 startOrReload deploy/ecosystem.config.cjs
pm2 save
pm2 startup systemd -u "$(whoami)" --hp "$HOME" 2>/dev/null || true

# ── Tron Netter shared persona memories ──────────────────────────
# Public-scope brain memories that keep the persona identical across webchat,
# SMS, and phone calls (the voice path has no system-prompt injection point —
# these rows are its knowledge base). brain-api creates its tables on first
# boot, so wait for it before seeding. Idempotent upsert; safe on every deploy.
echo ">>> Seeding Tron Netter persona memories..."
for i in $(seq 1 12); do
  curl -fsS -o /dev/null http://127.0.0.1:3211/health && break
  sleep 5
done
sudo -u postgres psql -d aiwebsite -v ON_ERROR_STOP=1 -f "$APP_DIR/deploy/seed-tron-memories.sql"

# ── Cloudflare tunnel ────────────────────────────────────────────
sudo bash "$APP_DIR/deploy/setup-cloudflared.sh"

# ── Watchdog (self-healing service checks + email alerts) ────────
# watchdog-cron.sh expects the watchdog at /usr/local/bin/aiwebsite-watchdog.sh
echo ">>> Installing watchdog + cron supervisor..."
sudo cp "$APP_DIR/deploy/watchdog.sh" /usr/local/bin/aiwebsite-watchdog.sh
sudo cp "$APP_DIR/deploy/watchdog-cron.sh" /usr/local/bin/aiwebsite-watchdog-cron.sh
sudo chmod +x /usr/local/bin/aiwebsite-watchdog.sh /usr/local/bin/aiwebsite-watchdog-cron.sh
( sudo crontab -l 2>/dev/null; echo "*/5 * * * * /usr/local/bin/aiwebsite-watchdog-cron.sh" ) | sort -u | sudo crontab -
# Restart the watchdog so it picks up the freshly installed version, then
# start immediately instead of waiting up to 5 minutes for cron.
# Kill via PID file, not pkill -f: the script path may appear in an SSH
# wrapper's command line, and pkill -f would kill that session too.
if sudo test -f /var/run/aiwebsite-watchdog.pid; then
  sudo kill "$(sudo cat /var/run/aiwebsite-watchdog.pid)" 2>/dev/null || true
fi
sudo rm -f /var/run/aiwebsite-watchdog.pid
sudo /usr/local/bin/aiwebsite-watchdog-cron.sh || true

echo ""
echo "=== Setup complete ==="
echo "Local checks:"
echo "  curl -fsS http://127.0.0.1:3000/api/health          # Next.js"
echo "  curl -fsS http://127.0.0.1:3211/health              # brain-api"
echo "Public check (after DNS propagates):"
echo "  curl -fsS https://ai.xl.net/api/health"
