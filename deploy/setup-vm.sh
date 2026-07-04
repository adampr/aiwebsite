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

# ── Cloudflare tunnel ────────────────────────────────────────────
sudo bash "$APP_DIR/deploy/setup-cloudflared.sh"

echo ""
echo "=== Setup complete ==="
echo "Local checks:"
echo "  curl -fsS http://127.0.0.1:3000/api/health          # Next.js"
echo "  curl -fsS http://127.0.0.1:3211/health              # brain-api"
echo "Public check (after DNS propagates):"
echo "  curl -fsS https://ai.xl.net/api/health"
