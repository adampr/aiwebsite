#!/usr/bin/env bash
# aicompany-template: retention-sweeper.sh.tpl@d352d82132e92c112f46d9307c0c9b407df2ad8cf0538312591305c66a5d8dd6
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

# blog_cta_events (fifth table, §19.17) exists only for cta.funnelEvents
# adopters — probe with to_regclass so non-adopters' sweeps don't fail.
if [ "$(sudo -u postgres psql -d "aiwebsite" -tAc "SELECT to_regclass('public.blog_cta_events') IS NOT NULL;")" = "t" ]; then
  run "DELETE FROM blog_cta_events WHERE created_at < now() - interval '400 days';"
fi

echo "[retention] sweep completed $(date -Is)"
