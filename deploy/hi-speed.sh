#!/usr/bin/env bash
# aicompany-template: hi-speed.sh.tpl@0cb0a8c7102e6f1e25aa31147e64ed585534949c013382d0f01ec7ba72354c51
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

# ── Issue ledger hook (§5.15 v1.30) — spool-first, strictly best-effort ──
# Mirrors every alert email into the per-host reported_issues table via the
# watchdog's drain. jq-only JSON (correct escaping by construction); every
# expansion ${n:-}-defaulted (set -u safe); every failure path absorbed
# (set -e safe); 1MB per-emitter cap. NEVER blocks or fails the alert path.
# This function must stay BYTE-IDENTICAL across every template that carries
# it (templates.test.ts pins that); per-template identity is $issue_source.
issue_source="hi-speed"
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
  # §5.15: a passing second attempt closes any open breach episode.
  record_issue "HI-SPEED WARN nightly gate breach" "self-cleared: a later probe passed" "hi-speed-breach" 0 1 "auto:self-cleared"
  stamp; exit 0
fi
# §5.15 wrapper-level hook: the MAIL itself is sent by the host repo's probe
# copy (scripts/qa/hi-speed-test.mjs — verbatim xldev sync, §9.9), so the
# module records at the wrapper's failure exit path instead. emailed=1 is the
# probe's documented behavior when RESEND_API_KEY resolves (attempt 2 runs
# alert-armed); a keyless host over-reports emailed here, which is the safe
# direction for a ledger.
record_issue "HI-SPEED WARN nightly gate breach (best-of-2)" \
  "Both hi-speed probe attempts were over the 5000ms threshold or failed on $(hostname) at $(date -Is). Details: $issues_file (data/hi-speed-open-issues.md, §9.9)." \
  "hi-speed-breach" 1
stamp; exit 1
