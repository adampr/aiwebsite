#!/usr/bin/env bash
# aicompany-template: hi-speed.sh.tpl@d1ee9a01894c6781360d7ae9e42ea02b8c5ea3230946f23151401cc9c7ce1bb2
# ai.xl.net nightly "Hi" speed gate (§9.9 v1.20.0) — ALERT-ONLY.
# Runs the HOST repo's probe (scripts/qa/hi-speed-test.mjs, verbatim copy of
# xldev scripts/qa/hi_speed_test.mjs) against the loopback brain with the VM
# .env. Never restarts anything. Breach/failure ⇒ probe emails via Resend
# (identity below) + appends data/hi-speed-open-issues.md (data/ survives
# deploys) + exit 1. Threshold is the owner's fixed 5000ms — deliberately no
# per-host override key (§9.9); itsc breaching is a designed pressure signal.
set -uo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
toolchain_prefix=''
[ -n "$toolchain_prefix" ] && export PATH="$toolchain_prefix:$PATH"

app_root="/var/www/aiwebsite"
# cwd-independence (§9.9 M1): the probe resolves .env from cwd; the unit sets
# WorkingDirectory but manual drills run from anywhere.
cd "$app_root"
probe="$app_root/scripts/qa/hi-speed-test.mjs"
brain_url="http://127.0.0.1:3211"
deploy_marker="/var/run/aiwebsite-deploy-in-progress"
deploy_grace_seconds=1800
heartbeat="$app_root/data/hi-speed-last-run"
issues_file="$app_root/data/hi-speed-open-issues.md"
scratch="/tmp/aiwebsite-hi-speed-attempt1.md"
stamp() { date +%s > "$heartbeat" 2>/dev/null || true; }

marker_mtime=$(stat -c %Y "$deploy_marker" 2>/dev/null || echo 0)
if [ "$marker_mtime" != 0 ] && (( $(date +%s) - marker_mtime < deploy_grace_seconds )); then
  echo "SKIP: deploy in progress — probe not run"; stamp; exit 0
fi
[ -f "$probe" ] || { echo "ERROR: $probe missing — host repo copy not deployed"; stamp; exit 1; }

# Boot/downtime pre-gate (§9.9 M2): Persistent=true catch-up fires can land
# while pm2 is still resurrecting the brain after a reboot. DOWN is the
# watchdog's jurisdiction (60s health loop + restart machinery) — this gate
# measures SLOW. Poll /health up to ~3 min; still down ⇒ skip, not alert.
brain_up=0
for _ in $(seq 1 18); do
  if curl -sf -m 5 "$brain_url/health" >/dev/null 2>&1; then brain_up=1; break; fi
  sleep 10
done
if [ "$brain_up" != 1 ]; then
  echo "SKIP: brain /health not answering after ~3 min — downtime is the watchdog's alert, not a speed breach"
  stamp; exit 0
fi

# Mail identity = the pair the §9.5 watchdog demonstrably delivers with.
# (The canonical probe fallback 403'd on itsc 2026-07-24: its Resend account
# only sends from the site's verified domain.)
export HI_SPEED_ALERT_FROM="ai.xl.net Watchdog <noreply@ai.xl.net>"
export HI_SPEED_ALERT_TO="adam@xl.net"

# Best-of-2: attempt 1 alert-suppressed (empty RESEND_API_KEY overrides the
# .env value in the probe's env merge; scratch issues file). A single 5.1s
# blip must not mail; two in a row must.
if env RESEND_API_KEY= node "$probe" --label 'aiwebsite' --url "$brain_url" \
     --env "$app_root/.env" --open-issues "$scratch"; then
  rm -f "$scratch"; stamp; exit 0
fi
rm -f "$scratch"
echo "attempt 1 over threshold or failed — re-probing (best-of-2), alerting armed"
if node "$probe" --label 'aiwebsite' --url "$brain_url" \
     --env "$app_root/.env" --open-issues "$issues_file"; then
  stamp; exit 0
fi
stamp; exit 1
