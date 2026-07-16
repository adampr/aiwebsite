#!/usr/bin/env bash
# Host-owned post-install hook (NOT template-rendered, no stamp line).
# setup-vm.sh runs this after `npm ci`, before `db:migrate`, on EVERY deploy —
# everything here must be idempotent. It installs the host-owned governance
# units (ARCHITECTURE.md §5.12/§9.7): the daily timer (retention sweep, stale-
# research reaper, queued kicks, self-gated quarterly standards refresh), its
# OnFailure alert unit, and the research job's log file.
#
# Uninstall/rename path: units are managed via the manifest below — any
# aiwebsite-governance* unit not listed gets disabled and removed, so renames
# and feature removal cannot leave zombie timers firing forever.

set -euo pipefail

APP_DIR="${APP_DIR:-/var/www/aiwebsite}"
APP_USER="${APP_USER:-$(stat -c '%U' "$APP_DIR")}"

echo "post-install: governance units (app dir $APP_DIR, user $APP_USER)"

# ── Log files: the detached research job appends via an inherited fd (it
# gets no systemd StandardOutput), so the file must exist and be writable by
# the app user. Both files match the existing /var/log/aiwebsite-*.log
# logrotate glob — no logrotate change needed.
for f in /var/log/aiwebsite-governance.log /var/log/aiwebsite-governance-research.log; do
  sudo touch "$f"
  sudo chown "$APP_USER" "$f"
  sudo chmod 0644 "$f"
done

# ── OnFailure alert: emails CRITICAL when the governance service itself dies
# (script exit 1 = retention/cleanup failure; standards-refresh failures are
# WARN-emailed in-script and exit 0). Reads RESEND_API_KEY literally from the
# shared .env (backup-db.sh pattern) — never sourced.
sudo tee /usr/local/bin/aiwebsite-governance-alert.sh >/dev/null <<'ALERT'
#!/usr/bin/env bash
set -u
ENV_FILE="/var/www/aiwebsite/.env"
KEY=$(grep -E '^RESEND_API_KEY=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
TO=$(grep -E '^ADMIN_EMAIL=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | cut -d, -f1)
TO="${TO:-adam@xl.net}"
[ -z "$KEY" ] && exit 0
TAIL=$(tail -c 1500 /var/log/aiwebsite-governance.log 2>/dev/null | sed 's/"/\\"/g' | tr '\n' ' ')
curl -sS -m 20 -X POST https://api.resend.com/emails \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d "{\"from\":\"ai.xl.net Watchdog <noreply@ai.xl.net>\",\"to\":[\"$TO\"],\"subject\":\"[aiwebsite] CRITICAL Governance timer unit FAILED\",\"text\":\"aiwebsite-governance.service exited nonzero. The 30-day retention sweep may not have run. Log tail: $TAIL\"}" \
  >/dev/null || true
ALERT
sudo chmod 0755 /usr/local/bin/aiwebsite-governance-alert.sh

sudo tee /etc/systemd/system/aiwebsite-governance-alert.service >/dev/null <<'UNIT'
[Unit]
Description=aiwebsite governance failure alert (email via Resend)

[Service]
Type=oneshot
ExecStart=/usr/local/bin/aiwebsite-governance-alert.sh
UNIT

# ── The daily governance service + timer. NODE_OPTIONS heap cap: this VM has
# OOM history and the quarterly refresh holds source text in memory.
sudo tee /etc/systemd/system/aiwebsite-governance.service >/dev/null <<UNIT
[Unit]
Description=aiwebsite governance daily duties (retention, reaper, standards refresh)
After=network-online.target postgresql.service
OnFailure=aiwebsite-governance-alert.service

[Service]
Type=oneshot
User=$APP_USER
WorkingDirectory=$APP_DIR
Environment=NODE_OPTIONS=--max-old-space-size=256
ExecStart=/usr/bin/env npx tsx $APP_DIR/scripts/governance-standards-refresh.ts
StandardOutput=append:/var/log/aiwebsite-governance.log
StandardError=append:/var/log/aiwebsite-governance.log
TimeoutStartSec=3600
UNIT

# RandomizedDelaySec softens the Persistent=true boot/first-enable catch-up;
# the script additionally exits quietly while the deploy marker is fresh, so
# a first-deploy immediate fire cannot race db:migrate or the brain restart.
sudo tee /etc/systemd/system/aiwebsite-governance.timer >/dev/null <<'UNIT'
[Unit]
Description=aiwebsite governance daily timer (04:30 UTC)

[Timer]
OnCalendar=*-*-* 04:30:00 UTC
RandomizedDelaySec=300
Persistent=true

[Install]
WantedBy=timers.target
UNIT

# ── Manifest cleanup: disable any aiwebsite-governance* unit this script no
# longer installs (rename/removal safety).
MANIFEST="aiwebsite-governance.service aiwebsite-governance.timer aiwebsite-governance-alert.service"
for unit in $(ls /etc/systemd/system/ 2>/dev/null | grep '^aiwebsite-governance' || true); do
  case " $MANIFEST " in
    *" $unit "*) ;;
    *)
      echo "post-install: removing stale unit $unit"
      sudo systemctl disable --now "$unit" 2>/dev/null || true
      sudo rm -f "/etc/systemd/system/$unit"
      ;;
  esac
done

sudo systemctl daemon-reload
# Enable the TIMER only — never start the service mid-deploy (the script
# self-gates on the deploy marker anyway; this keeps first deploys quiet).
sudo systemctl enable aiwebsite-governance.timer
sudo systemctl start aiwebsite-governance.timer

echo "post-install: governance units installed"
