#!/usr/bin/env bash
# aicompany-template: retention-sweeper.sh.tpl@62a809788ea85330888d01560ecdffca1f0f2051025f1c200abdef3d8924202c
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

# conversions + agent_hits (v1.46, §5.6) exist only for hosts that turned on
# tracking.recordConversions / tracking.aiAgentLog. Same to_regclass probe as
# blog_cta_events: this script runs under `set -euo pipefail`, so a DELETE
# against a missing table would abort the sweep and silently skip everything
# above it as well.
if [ "$(sudo -u postgres psql -d "aiwebsite" -tAc "SELECT to_regclass('public.conversions') IS NOT NULL;")" = "t" ]; then
  run "DELETE FROM conversions WHERE created_at < now() - interval '730 days';"
fi
if [ "$(sudo -u postgres psql -d "aiwebsite" -tAc "SELECT to_regclass('public.agent_hits') IS NOT NULL;")" = "t" ]; then
  run "DELETE FROM agent_hits WHERE created_at < now() - interval '180 days';"
fi

# csp_reports (v1.177.0, §5.18 browser security reports) exists only on hosts
# that adopted the report inbox — same to_regclass probe, for the same reason.
# Rows are aggregates keyed by their UTC day. The 90 is
# CSP_REPORT_RETENTION_DAYS (src/security/csp-constants.ts), the number the
# privacy page prints; tests/csp-retention.test.ts pins the two together. It is
# deliberately not a RETAIN_* key: an unknown site-deploy.env key is fatal to
# an older render.mjs, so a key here would turn every rollback into a hand edit.
if [ "$(sudo -u postgres psql -d "aiwebsite" -tAc "SELECT to_regclass('public.csp_reports') IS NOT NULL;")" = "t" ]; then
  run "DELETE FROM csp_reports WHERE day < (now() AT TIME ZONE 'UTC')::date - 90;"
fi

echo "[retention] sweep completed $(date -Is)"
