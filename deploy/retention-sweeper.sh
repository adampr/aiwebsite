#!/usr/bin/env bash
# aicompany-template: retention-sweeper.sh.tpl@e2107589a1aee92bd617e302532e43fdc8455072221168275ccc3a2ccbbe2f35
# Enforces the data-retention windows stated on the privacy page (§9.5). The
# windows are rendered from site-deploy.env RETAIN_* values, which must match
# privacy.retentionDays in site.config.ts — if you change one, change the
# other in the same commit: the policy and the sweeper must never disagree.
#
# sms_consent_logs is EXEMPT BY DESIGN and must never appear here: it is
# append-only TCPA consent evidence, retained for the life of the messaging
# program + 4 years (§6). This script deliberately touches nothing else.
#
# Installed as the aiwebsite-retention-sweeper systemd timer (weekly, root).
set -euo pipefail

run() {
  sudo -u postgres psql -d "aiwebsite" -v ON_ERROR_STOP=1 -c "$1"
}

run "DELETE FROM page_visits  WHERE created_at < now() - interval '730 days';"
run "DELETE FROM auth_logs    WHERE created_at < now() - interval '365 days';"
run "DELETE FROM ip_orgs      WHERE looked_up_at < now() - interval '730 days';"
run "DELETE FROM admin_emails WHERE created_at < now() - interval '730 days';"

echo "[retention] sweep completed $(date -Is)"
