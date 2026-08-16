#!/usr/bin/env bash
# aicompany-template: watchdog.sh.tpl@026076e6d0b597c239c3e727a96f4642b8b74acf3d4ed6fa59d01664a3a2d0d6
# ai.xl.net watchdog — persistent health-check loop (§9.5).
# Checks PostgreSQL, nginx, cloudflared, and the three PM2 apps
# (aiwebsite :3000, brain-api :3211, skills-host :3213)
# every 60 seconds, plus the backup/blog heartbeats and knowledge-doc freshness
# (>26h → alert). Page-render checks run every 5 minutes (every 5th pass) and
# can trigger a clean rebuild. Restarts failed services and sends throttled
# email alerts via Resend — every subject starts "[aiwebsite] <SEVERITY>" so one
# operator can triage N sites' streams; max 1 email per 24h per unique issue.
#
# Singleton (§9.5): an exclusive flock on $lock_file is held for the whole
# process lifetime — a second instance exits 0 at startup. The pid file is
# observability only and never decides liveness (pid-file heuristics let 23
# unrecorded daemons accumulate on aiwebsite, 2026-07-13).
set -uo pipefail

# Explicit PATH (v1.4.0): a CRON-respawned watchdog inherits cron's minimal
# PATH=/usr/bin:/bin, under which a pm2 living in /usr/local/bin (a toolchain
# shim, or any non-nodesource install) is exit-127-invisible inside
# run_as_pm2_user — every pm2 repair would fail CRITICAL with no self-heal.
# Existing hosts only worked by accident of nodesource's npm -g landing pm2
# in /usr/bin.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# Node-split hosts: repair paths (attempt_clean_rebuild's `npm run build`,
# pm2 calls) must use the SAME toolchain the deploy used, or the recovery
# build runs under the wrong Node major. Guarded against empty — a bare
# `PATH=:$PATH` with an empty value would put CWD on
# root's PATH via the leading colon.
toolchain_prefix=''
if [ -n "$toolchain_prefix" ]; then
  export PATH="$toolchain_prefix:$PATH"
fi

app_root="/var/www/aiwebsite"
# Build placement (§9.2 v1.78.0): on local-artifact hosts the repair rebuild
# is DISABLED (alert-only) — a VM-side build is the 2026-08-08 outage class,
# and stage-build.sh build refuses on such hosts anyway.
build_mode='remote'
pid_file="/var/run/aiwebsite-watchdog.pid"
lock_file="/var/run/aiwebsite-watchdog.lock"
deploy_marker="/var/run/aiwebsite-deploy-in-progress"
deploy_grace_seconds=1800     # defer repair ACTIONS while the deploy marker is fresher than this (§9.5)
log_file="/var/log/aiwebsite-watchdog.log"
throttle_dir="/tmp/aiwebsite-watchdog-throttle"
issue_throttle_seconds=86400  # 24 hours per unique issue
check_interval=60
page_check_every=5            # run page checks every Nth iteration (5 × 60s = 5 min)
stale_seconds=93600           # 26h — backup heartbeat + knowledge doc freshness
earlyoom_scan_stamp="/var/run/aiwebsite-watchdog-earlyoom-scan"  # journal-scan cursor (v1.15.0)
notify_to="adam@xl.net"
notify_from="ai.xl.net Watchdog <noreply@ai.xl.net>"

site_health_url="http://127.0.0.1:3000/api/health"
brain_health_url="http://127.0.0.1:3211/health"
skills_health_url="http://127.0.0.1:3213/health"
# Service names are DEFINED ONCE and used at both the restart_and_alert call
# site and the matching clear_deploy_defer site. The ledger key is
# "deploy-defer-$service_name" verbatim — spaces and parens included — so a
# resolve site that spells the name differently resolves NOTHING, silently
# (an unknown key is `ok:true, resolved:0` in the NDJSON batch path, never a
# 404). One definition per service is what makes that drift impossible.
svc_brain="brain-api (PM2)"
svc_skills="skills-host (PM2)"
svc_site="aiwebsite (Next.js/PM2)"
backup_heartbeat_file="/var/lib/aiwebsite/last-backup-ok"
# persona.knowledgeFile is config-driven — read the deployed config snapshot
# (same source of truth the crawler writes to) so a host with a non-default
# path monitors the REAL file; fall back to the conventional default.
knowledge_file="$app_root/data/aiwebsite-knowledge.md"
config_snapshot="$app_root/data/aiwebsite-config.json"
if [[ -f "$config_snapshot" ]]; then
  kf=$(jq -r '.knowledgeFile // empty' "$config_snapshot" 2>/dev/null || true)
  if [[ -n "$kf" ]]; then
    [[ "$kf" = /* ]] && knowledge_file="$kf" || knowledge_file="$app_root/$kf"
  fi
fi

page_check_urls=(
  "http://127.0.0.1:3000/"
  "http://127.0.0.1:3000/login"
)

# Synthetic page list (§9.8 v1.17.0): paths from SYNTH_PAGES, checked locally
# on every page pass, ALERT-ONLY — never rebuild-eligible. Tokens are "path"
# or "path|minBytes". The rebuild-eligible set stays exactly page_check_urls
# above. The heartbeat gate is consumed in check_freshness.
synth_pages='/blog|27000 /texting|12000 /api/auth/session'
synth_heartbeat_enabled='1'

# ── Helpers ──────────────────────────────────────────────────────

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S %Z') $1" >> "$log_file"
}

# Deploy↔watchdog mutex (§9.5): setup-vm.sh touches $deploy_marker at deploy
# start (re-touched before the Next build) and removes it at the end. While
# the marker is fresher than $deploy_grace_seconds the watchdog still
# OBSERVES (FAIL log lines, freshness alerts) but defers repair ACTIONS — a
# watchdog repair `npm run build` racing a deploy's npm ci/build on the same
# tree produced 2026-07-13's EEXIST symlink collision and phantom
# module-not-found build failures. TTL failure mode (documented, accepted):
# a deploy that crashes before removing the marker leaves repairs deferred
# until the TTL expires; then self-healing resumes unaided.
deploy_in_progress() {
  local marker_mtime age
  marker_mtime=$(stat -c %Y "$deploy_marker" 2>/dev/null) || return 1
  age=$(( $(date +%s) - marker_mtime ))
  (( age < deploy_grace_seconds ))
}

load_resend_key() {
  local env_file="$app_root/.env"
  if [[ -f "$env_file" ]]; then
    resend_api_key=$(grep -E '^RESEND_API_KEY=' "$env_file" | head -1 | cut -d'=' -f2- | tr -d '"' | tr -d "'")
  fi
  if [[ -z "${resend_api_key:-}" ]]; then
    log "WARN: RESEND_API_KEY not found in $env_file -- email alerts disabled"
  fi
}

# ── Issue ledger hook (§5.15 v1.30) — spool-first, strictly best-effort ──
# Mirrors every alert email into the per-host reported_issues table via this
# watchdog's drain. jq-only JSON (correct escaping by construction); every
# expansion ${n:-}-defaulted (set -u safe); every failure path absorbed
# (set -e safe); 1MB per-emitter cap. NEVER blocks or fails the alert path.
# This function must stay BYTE-IDENTICAL across every template that carries
# it (templates.test.ts pins that); per-template identity is $issue_source.
issue_source="watchdog"
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

# ── Deferred-repair episode state (§5.15 / §9.5, v1.53.0) ─────────
# A `deploy-defer-*` row asserts "a repair is OWED but was withheld", never
# "the service is broken". So its resolution signal is: the deploy marker is
# GONE, and the same check that opened the episode now passes. Before v1.53.0
# nothing ever resolved these keys — only `restart-*` and `page-render-*`
# self-healed — so every deploy that reloaded a gated service left a permanent
# row. 31 of them were closed BY HAND across the fleet in the week to
# 2026-08-03, none by machine.
#
# Gated on `[ -e "$deploy_marker" ]` and deliberately NOT on
# `deploy_in_progress`: those two disagree in exactly the case that matters.
# deploy_in_progress is ALSO false for a marker that still exists but has aged
# past the TTL, and setup-vm.sh removes the marker only on success — a crashed
# deploy deliberately leaves it to age out (§9.5). A half-deployed box is the
# one state a human must still look at, so a stale marker must never
# auto-resolve.
#
# State lives in /var/run beside the marker/pid/lock: root-only by
# construction, needs no directory (so no setup-vm change and no group-write
# question), and being tmpfs is CORRECT — a reboot restarts every service, so a
# defer recorded before a reboot must not be closed by a green probe after one.
defer_stamp() { # 1=issue key
  echo "/var/run/aiwebsite-deploy-defer-$(printf '%s' "${1:-}" | tr '/:. ' '____')"
}

mark_deploy_defer() { # 1=issue key
  local f; f=$(defer_stamp "${1:-}")
  : > "$f" 2>/dev/null || log "WARN: could not stamp deploy-defer episode ${1:-}"
  return 0
}

# 1=issue key  2=recovery sentence — this BECOMES the resolved row's note
# (record_issue writes note:($s|.[0:300]) from arg 1), so it must state what
# was actually observed and never claim more.
clear_deploy_defer() {
  local f; f=$(defer_stamp "${1:-}")
  [ -e "$f" ] || return 0             # never deferred here ⇒ never resolve, never spam
  [ -e "$deploy_marker" ] && return 0 # marker present (fresh OR stale) ⇒ the debt stands
  record_issue "WARN ${2:-}" \
    "self-healed: the deploy marker cleared and the check that opened this episode passed on a later pass." \
    "${1:-}" 0 1 "auto:deploy-window-cleared"
  rm -f "$f" 2>/dev/null || true
  log "RESOLVE: ${1:-} — deploy marker gone and check green"
  return 0
}

# send_email "<subject after the [slug] prefix>" "<body>" "<issue key>"
# Subject convention (§9.5): "[aiwebsite] <SEVERITY> ..." — callers pass
# "CRITICAL ..." / "WARN ..." and the site prefix is added here.
# Every invocation ALSO records into the issue ledger (§5.15) — including the
# throttled and no-API-key early returns: a persisting throttled issue bumps
# its open row's count/last_seen on every occurrence, with emailed=0.
send_email() {
  local subject="[aiwebsite] $1"
  local body="$2"
  local issue_key="$3"

  if [[ -z "${resend_api_key:-}" ]]; then
    log "WARN: Skipping email (no API key): $subject"
    record_issue "$1" "$body" "$issue_key" 0
    return
  fi

  mkdir -p "$throttle_dir"
  local safe_key
  safe_key=$(echo "$issue_key" | tr '/:. ' '____')
  local throttle_file="$throttle_dir/$safe_key"

  if [[ -f "$throttle_file" ]]; then
    local last_sent now
    last_sent=$(cat "$throttle_file")
    now=$(date +%s)
    # v1.15.2: earlyoom kills throttle at 1h (a SECOND distinct kill inside
    # the default 24h window must not go silent — it means sustained
    # pressure); everything else keeps the default.
    local key_throttle="$issue_throttle_seconds"
    [[ "$issue_key" == "earlyoom-kill" ]] && key_throttle=3600
    if (( now - last_sent < key_throttle )); then
      log "INFO: Email throttled for issue '$issue_key' (last sent $(( now - last_sent ))s ago): $subject"
      record_issue "$1" "$body" "$issue_key" 0
      return
    fi
  fi

  local timestamp
  timestamp=$(date '+%Y-%m-%d %I:%M:%S %p %Z')

  local html_body="<div style=\"font-family:monospace;background:#111827;color:#f1f5f9;padding:24px;border-radius:8px;\">
<h2 style=\"color:#ef4444;margin:0 0 12px;\">[aiwebsite] Watchdog Alert</h2>
<p><strong>Time:</strong> $timestamp</p>
<p><strong>Host:</strong> aiwebsite (ai.xl.net)</p>
<hr style=\"border:none;border-top:1px solid #374151;margin:16px 0;\"/>
<pre style=\"white-space:pre-wrap;\">$body</pre>
</div>"

  curl -sf -m 15 -X POST "https://api.resend.com/emails" \
    -H "Authorization: Bearer $resend_api_key" \
    -H "Content-Type: application/json" \
    -d "$(printf '{"from":"%s","to":["%s"],"subject":"%s","html":"%s","headers":{"Auto-Submitted":"auto-generated","X-Auto-Response-Suppress":"All"}}' \
      "$notify_from" "$notify_to" "$subject" \
      "$(echo "$html_body" | sed 's/"/\\"/g' | tr -d '\n')")" \
    >> "$log_file" 2>&1 && {
      date +%s > "$throttle_file"
      log "INFO: Alert email sent: $subject"
      record_issue "$1" "$body" "$issue_key" 1
    } || {
      log "WARN: Failed to send alert email: $subject"
      record_issue "$1" "$body" "$issue_key" 0
    }
}

restart_and_alert() {
  local service_name="$1"
  local restart_cmd="$2"
  local details="$3"
  local gate_on_deploy="${4:-false}"

  # Deploy↔watchdog mutex (§9.5): defer ONLY the pm2/rebuild repair ACTIONS
  # (callers pass gate_on_deploy=true) while a deploy holds the marker — those
  # race the deploy's own npm ci/build + pm2 reload on the app tree. systemctl
  # restarts of postgres/nginx/cloudflared are NEVER gated (default false): the
  # deploy does not touch them, and a genuine infra death during a deploy must
  # be repaired at once. The human is alerted either way — a deferred pm2
  # failure still emails (throttled 24h), so a real service-down during a deploy
  # window (or the ≤30-min tail of a crashed deploy that left the marker) is
  # never silently swallowed; only the repair ACTION waits.
  if [[ "$gate_on_deploy" == "true" ]] && deploy_in_progress; then
    log "DEFER: $service_name repair action skipped — deploy in progress (marker <${deploy_grace_seconds}s); alerting only"
    # Stamp BEFORE the send_email: the failure direction must be a stray stamp
    # (harmless — clear_deploy_defer only ever resolves a key that was opened)
    # rather than a row with no stamp, which is the v1.52 bug itself.
    mark_deploy_defer "deploy-defer-$service_name"
    send_email \
      "WARN $service_name failed during deploy — repair deferred" \
      "Service: $service_name\nAction: DEFERRED while a deploy holds the mutex marker (a watchdog pm2 restart/rebuild would race the deploy on the app tree).\nThe watchdog repairs automatically once the deploy window — or its 30-min TTL — clears, if the failure persists.\n\nDetails:\n$details" \
      "deploy-defer-$service_name"
    return
  fi

  log "ACTION: Restarting $service_name ..."
  eval "$restart_cmd" >> "$log_file" 2>&1
  local rc=$?

  if [[ $rc -eq 0 ]]; then
    log "ACTION: $service_name restarted successfully"
    send_email \
      "WARN Restarted $service_name" \
      "Service: $service_name\nAction: Restarted\nResult: Success\n\nDetails:\n$details" \
      "restart-$service_name"
    # §5.15: a successful restart is a RESOLUTION event — close the episode the
    # send_email above just opened (and any prior failed-restart episode) so
    # self-healed incidents never sit open in build-start triage. The resolved
    # rows keep the incident history.
    record_issue "WARN Restarted $service_name" "self-healed: restart succeeded" "restart-$service_name" 0 1 "auto:self-healed"
    record_issue "WARN Restarted $service_name" "self-healed: a later restart succeeded" "restart-fail-$service_name" 0 1 "auto:self-healed"
  else
    log "ERROR: Failed to restart $service_name (exit $rc)"
    send_email \
      "CRITICAL Failed to restart $service_name" \
      "Service: $service_name\nAction: Restart attempted\nResult: FAILED (exit $rc)\n\nDetails:\n$details" \
      "restart-fail-$service_name"
  fi
}

# ── PM2 user handling ─────────────────────────────────────────────

# The watchdog runs as root (root cron supervisor), but PM2 and the app files
# belong to the deploy user. pm2/npm commands must run as that user or they
# hit root's empty PM2 daemon and create root-owned build artifacts.
pm2_user="${PM2_USER:-$(stat -c %U "$app_root" 2>/dev/null || echo root)}"

# Close the singleton lock fd (9) in every spawned child (`9>&-`). The watchdog
# holds an exclusive flock on fd 9 for its lifetime (see §9.5, below); without
# this, a long-lived pm2/npm spawn — the resurrected pm2 God daemon in
# particular — INHERITS fd 9 and, if it outlives the watchdog, keeps the lock
# held forever. The cron supervisor's flock probe would then always fail
# ("watchdog alive"), never restart one, and log OK every 5 min: zero watchdogs,
# no alerts, indefinitely. bash's auto-fd form (`exec {v}>`) does NOT set
# close-on-exec here, so the explicit `9>&-` on each spawn is required.
run_as_pm2_user() {
  if [[ "$(id -un)" == "$pm2_user" ]]; then
    bash -c "$1" 9>&-
  else
    runuser -u "$pm2_user" -- bash -c "$1" 9>&-
  fi
}

# ── Page-render checks ────────────────────────────────────────────

attempt_clean_rebuild() {
  log "ACTION: staged rebuild via deploy/stage-build.sh (live tree keeps serving; failure = no-op) ..."
  # Staged (v1.13.0, §9.2): next build CLEARS distDir at build start, so an
  # in-live-tree rebuild was never atomic — the build runs in the sibling
  # stage tree and only a ms-wide rename flip touches the live one. Deps come
  # from a hardlink clone of the LIVE node_modules (refresh-modules): ABI-
  # exact, no npm-registry dependence, and the deploy's .old rollback set is
  # never consumed (cutover-repair flips .next only). One shell invocation so
  # the fd-201 flock spans the WHOLE pipeline; a concurrent deploy makes
  # flock -n fail -> rc 3 = benign skip, never interleave.
  run_as_pm2_user "cd '$app_root' && mkdir -p '$app_root.stage' && exec 201>'$app_root.stage/.lock' && { flock -n 201 || exit 3; } \
    && export STAGE_BUILD_LOCK_HELD=1 \
    && bash deploy/stage-build.sh prepare \
    && bash deploy/stage-build.sh refresh-modules \
    && bash deploy/stage-build.sh build \
    && bash deploy/stage-build.sh verify-relocatable \
    && bash deploy/stage-build.sh check \
    && bash deploy/stage-build.sh cutover-repair" >> "$log_file" 2>&1
  local rc=$?
  if [[ $rc -eq 0 ]]; then
    log "ACTION: staged repair flip done (deploy .old rollback set untouched), restarting PM2 ..."
    run_as_pm2_user "pm2 restart aiwebsite" >> "$log_file" 2>&1
    sleep 3
    return 0
  elif [[ $rc -eq 3 ]]; then
    log "SKIP: stage lock held (deploy pipeline active) — rebuild deferred, live tree untouched"
    return 2
  else
    log "ERROR: staged rebuild failed (exit $rc) — live tree untouched"
    return 1
  fi
}

# ── Interrupted-cutover HEAL-ONLY recovery (v1.78.0 fix round, M2c) ──
# local-artifact hosts only. A cutover journal ($APP_DIR.stage/.cutover-state)
# left behind means a flip died BETWEEN renames (connection death inside the
# bracket) and the live tree may be half-flipped — the one broken state the
# alert-only policy would otherwise leave down until a human redeploys.
# `stage-build.sh heal` is RENAMES ONLY (roll the journal fully backward,
# park strays, zero build), so running it here does NOT violate the
# never-build rule; the page-repair REBUILD stays alert-only. Deploy-marker
# gated like every repair action: a live deploy owns its own heal (setup-vm
# runs heal at pipeline start); a crashed one ages out over the 30-min TTL.
check_cutover_journal() {
  [[ "$build_mode" == "local-artifact" ]] || return 0
  local journal="$app_root.stage/.cutover-state"
  [[ -f "$journal" ]] || return 0
  if deploy_in_progress; then
    log "DEFER: cutover journal present but the deploy marker is fresh — the deploy pipeline owns heal"
    return 0
  fi
  log "ACTION: cutover journal present with no live deploy — HEAL-ONLY recovery (stage-build.sh heal: renames only, zero build)"
  if run_as_pm2_user "cd '$app_root' && bash deploy/stage-build.sh heal" >> "$log_file" 2>&1; then
    run_as_pm2_user "pm2 restart aiwebsite brain-api skills-host" >> "$log_file" 2>&1 || true
    send_email \
      "WARN Healed an interrupted cutover (renames rolled back; no build)" \
      "A cutover journal was found at $journal with no deploy in progress — a flip died mid-rename (likely connection death inside the cutover bracket).\nstage-build.sh heal rolled the flip fully BACKWARD (renames only; this host never builds) and pm2 was restarted.\nThe PREVIOUS generation is serving. Re-run the deploy from the dev box: bash deploy/deploy.sh --takeover" \
      "cutover-heal"
    record_issue "WARN Healed an interrupted cutover (renames rolled back; no build)" "self-healed: journal rolled backward, previous generation restored" "cutover-heal" 0 1 "auto:self-healed"
  else
    send_email \
      "CRITICAL Interrupted cutover found and heal FAILED (local-artifact host)" \
      "A cutover journal exists at $journal (flip died mid-rename) and stage-build.sh heal FAILED — the live tree may be half-flipped and the site broken.\nManual recovery NOW: on the VM, cd $app_root && bash deploy/stage-build.sh heal (inspect its error), then pm2 restart aiwebsite brain-api skills-host. Then redeploy from the dev box with --takeover." \
      "cutover-heal-fail"
  fi
}

check_pages() {
  local any_page_fail=false
  local failed_urls=()

  # Quick health check first — if the app is completely down, skip page checks
  # (the main loop's service checks will handle that)
  local hc
  hc=$(curl -sf -m 5 "$site_health_url" 2>&1) || hc=""
  if [[ -z "$hc" ]] || ! echo "$hc" | grep -q '"status":"ok"'; then
    log "INFO: Skipping page checks -- health endpoint down"
    return
  fi

  for url in "${page_check_urls[@]}"; do
    local http_code body
    http_code=$(curl -s -o /tmp/aiwebsite-watchdog-page-body -w '%{http_code}' -m 15 "$url" 2>/dev/null) || http_code="000"
    body=$(cat /tmp/aiwebsite-watchdog-page-body 2>/dev/null) || body=""

    if [[ "$http_code" -ge 500 ]] || echo "$body" | grep -qi "application error\|internal server error\|NEXT_NOT_FOUND"; then
      log "FAIL: Page check $url returned HTTP $http_code"
      any_page_fail=true
      failed_urls+=("$url (HTTP $http_code)")
    elif [[ "$http_code" == "000" ]]; then
      log "FAIL: Page check $url timed out or connection refused"
      any_page_fail=true
      failed_urls+=("$url (timeout/refused)")
    fi
  done

  rm -f /tmp/aiwebsite-watchdog-page-body

  if [[ "$any_page_fail" == "true" ]]; then
    local detail_list
    detail_list=$(printf '%s\n' "${failed_urls[@]}")

    # local-artifact hosts (§9.2 v1.78.0): the VM must NEVER build — the
    # repair rebuild is exactly the workload that starved this box on
    # 2026-08-08 (and stage-build.sh build refuses on such hosts anyway, so
    # attempting it would only burn a failed pipeline). ALERT-ONLY, before
    # the deploy-defer branch: that branch's mail promises "the watchdog
    # rebuilds automatically", which would be a lie here. Recovery is a
    # dev-box redeploy (auto-rolls-back to .next.old on health failure).
    if [[ "$build_mode" == "local-artifact" ]]; then
      log "ALERT-ONLY: pages failing but VM-side rebuild is DISABLED (DEPLOY_BUILD_MODE=local-artifact)"
      send_email \
        "CRITICAL Page errors — VM rebuild disabled (local-artifact host)" \
        "Pages returning errors:\n$detail_list\n\nThis host is DEPLOY_BUILD_MODE=local-artifact: the watchdog will NOT rebuild on the VM (that workload caused the 2026-08-08 outage). Recover from the dev box: bash deploy/deploy.sh (builds locally, ships the artifact, auto-rolls-back on health failure). Manual rollback on the VM: stage-build.sh rollback (or mv .next .next.bad && mv .next.old .next) then pm2 restart aiwebsite." \
        "page-render-local-artifact"
      return
    fi

    # Deploy↔watchdog mutex (§9.5): a rebuild racing the deploy's own
    # npm ci/build on the same tree caused 2026-07-13's EEXIST symlink
    # collision + phantom module-not-found failures. Defer the rebuild ACTION
    # (the FAIL lines above are the retained observation) but still alert
    # (throttled 24h) so a human is not blind to page errors during the window.
    if deploy_in_progress; then
      log "DEFER: page rebuild skipped — deploy in progress (marker <${deploy_grace_seconds}s); alerting only"
      mark_deploy_defer "page-render-deploy-defer"
      send_email \
        "WARN Page errors during deploy — rebuild deferred" \
        "Pages returning errors:\n$detail_list\n\nA clean rebuild would race the in-progress deploy's build on the same tree, so it is deferred. If pages are still broken after the deploy window — or its 30-min TTL — the watchdog rebuilds and escalates automatically." \
        "page-render-deploy-defer"
      return
    fi

    log "ACTION: Pages failing but health OK -- attempting clean rebuild"
    attempt_clean_rebuild; local rebuild_rc=$?
    if [[ $rebuild_rc -eq 2 ]]; then
      # Benign lock-held skip (a deploy pipeline owns the stage) — already
      # logged; the deploy marker/DEFER machinery owns alerting for that window.
      :
    elif [[ $rebuild_rc -eq 0 ]]; then
      # Verify the fix worked
      local still_broken=false
      for url in "${page_check_urls[@]}"; do
        local rc2
        rc2=$(curl -s -o /dev/null -w '%{http_code}' -m 15 "$url" 2>/dev/null) || rc2="000"
        if [[ "$rc2" -ge 500 || "$rc2" == "000" ]]; then
          still_broken=true
          break
        fi
      done

      if [[ "$still_broken" == "true" ]]; then
        send_email \
          "CRITICAL Page errors persist after rebuild" \
          "Pages returning errors:\n$detail_list\n\nA clean rebuild was attempted but pages are still broken.\nManual investigation required." \
          "page-render-fail"
      else
        send_email \
          "WARN Auto-fixed page errors via clean rebuild" \
          "Pages that were failing:\n$detail_list\n\nA clean rebuild + PM2 restart resolved the issue.\nLikely cause: corrupted build cache." \
          "page-render-autofix"
        # §5.15 self-heal resolution — close this episode and any prior
        # page-render-fail episode the rebuild just fixed.
        record_issue "WARN Auto-fixed page errors via clean rebuild" "self-healed: clean rebuild fixed pages" "page-render-autofix" 0 1 "auto:self-healed"
        record_issue "WARN Auto-fixed page errors via clean rebuild" "self-healed: clean rebuild fixed pages" "page-render-fail" 0 1 "auto:self-healed"
      fi
    else
      send_email \
        "CRITICAL Page errors and the rebuild failed" \
        "Pages returning errors:\n$detail_list\n\nA clean rebuild was attempted but the build itself failed.\nManual investigation required." \
        "page-render-fail"
    fi
  else
    log "OK: All page checks passed"
    # Resolved from the PAGE loop, never from $site_health_url. The health
    # endpoint is the pre-gate this function already passed to get here
    # (see the early return above), so it is green on every pass that can open
    # a page-render defer — itsupportchicago's 2026-08-02 episode is exactly
    # that shape: /api/health served "status":"ok" for 72 minutes while / and
    # /login timed out. Resolving on health alone would have closed the row on
    # the same pass that opened it.
    clear_deploy_defer "page-render-deploy-defer" "page checks passing again after a deploy-window deferral"
  fi
}

# ── Synthetic page checks (§9.8 v1.17.0) — ALERT-ONLY ─────────────
# A >=400 or thin body on a SYNTH_PAGES path is a content/route regression a
# rebuild cannot fix, so this class never touches the rebuild machinery; the
# dev-box sweep covers the same paths from the public side.
check_synth_pages() {
  [ -n "$synth_pages" ] || return 0
  local hc
  hc=$(curl -sf -m 5 "$site_health_url" 2>&1) || hc=""
  if [[ -z "$hc" ]] || ! echo "$hc" | grep -q '"status":"ok"'; then
    return 0   # total-down belongs to the main-loop service checks
  fi
  if deploy_in_progress; then
    log "INFO: synth page checks skipped -- deploy in progress"
    return 0
  fi
  local tok p want_bytes url out http_code size
  for tok in $synth_pages; do
    p="${tok%%|*}"
    want_bytes=0
    [[ "$tok" == *"|"* ]] && want_bytes="${tok##*|}"
    url="http://127.0.0.1:3000${p}"
    out=$(curl -s -o /dev/null -w '%{http_code} %{size_download}' -m 15 "$url" 2>/dev/null) || out="000 0"
    http_code="${out%% *}"
    size="${out##* }"
    if [[ "$http_code" == "000" || "$http_code" -ge 400 ]]; then
      log "FAIL: synth page $p HTTP $http_code (alert-only)"
      send_email \
        "SYNTH WARN page $p failing (HTTP $http_code)" \
        "Local check of $url returned HTTP $http_code.\n\nAlert-only class (§9.8): no rebuild is attempted — a >=400 here is a content/route regression, not a corrupted build. The dev-box sweep checks the same path from the public side." \
        "synth-page-$p"
    elif (( want_bytes > 0 && size < want_bytes )); then
      log "FAIL: synth page $p thin body (${size}B < ${want_bytes}B, alert-only)"
      send_email \
        "SYNTH WARN page $p body ${size}B below floor ${want_bytes}B" \
        "Local check of $url returned HTTP $http_code with a ${size}-byte body (floor ${want_bytes}).\n\nUsually an empty shell or half-rendered page. Alert-only class (§9.8); no rebuild attempted." \
        "synth-page-$p"
    fi
  done
}

# ── Freshness checks: backup heartbeat + knowledge doc (§9.5) ─────

file_age_alert() { # path, label, severity, issue_key, remedy [, threshold_seconds]
  local path="$1" label="$2" severity="$3" issue_key="$4" remedy="$5"
  local threshold="${6:-$stale_seconds}"
  local mtime age
  mtime=$(stat -c %Y "$path" 2>/dev/null) || {
    send_email \
      "$severity $label missing" \
      "$path does not exist.\n\n$remedy" \
      "$issue_key"
    return 1
  }
  age=$(( $(date +%s) - mtime ))
  if (( age > threshold )); then
    send_email \
      "$severity $label stale (>$(( threshold / 3600 ))h)" \
      "$path was last updated $(( age / 3600 ))h ago (threshold $(( threshold / 3600 ))h).\n\n$remedy" \
      "$issue_key"
    return 1
  fi
  return 0
}

check_freshness() {
  # Heartbeat check applies only when setup-vm enabled the backup timers
  # (BACKUP_BUCKET set) — otherwise it would alert nightly about a timer
  # that is deliberately off.
  if [ -f "/var/lib/aiwebsite/backups-enabled" ]; then
    file_age_alert "$backup_heartbeat_file" "Backup heartbeat" "CRITICAL" "backup-heartbeat" \
      "The nightly pg_dump has not succeeded in over a day. Check /var/log/aiwebsite-backup.log and 'systemctl list-timers aiwebsite-backup.timer'." \
      || log "FAIL: backup heartbeat missing/stale"
  fi
  file_age_alert "$knowledge_file" "Knowledge doc" "WARN" "knowledge-stale" \
    "The nightly crawl has not refreshed the prompt doc in over a day; the persona is answering from stale knowledge. Check /var/log/aiwebsite-knowledge.log and 'systemctl list-timers aiwebsite-knowledge.timer'." \
    || log "FAIL: knowledge doc missing/stale"
  # Blog heartbeat (§19.5): blog-nightly.ts touches data/blog-last-run on
  # EVERY exit path (incl. lock-held and preflight skips), so missing/stale
  # means the timer itself is dead — a human's problem, not silence. Gated on
  # the rendered BLOG_ENABLED exactly like setup-vm's timer install.
  if [ "1" = "1" ]; then
    file_age_alert "$app_root/data/blog-last-run" "Blog heartbeat" "WARN" "blog-heartbeat" \
      "The nightly blog job has not written its heartbeat in over a day — the timer is dead or the job is crashing before its exit paths. Check /var/log/aiwebsite-blog.log and 'systemctl list-timers aiwebsite-blog.timer'." \
      || log "FAIL: blog heartbeat missing/stale"
    # Digest staleness (§19.18/§19.11): blog-digest.ts stamps
    # data/blog-digest-last on EVERY exit path (incl. OK-skips), so >35d
    # stale means the daily digest timer is dead — not merely "not due".
    file_age_alert "$app_root/data/blog-digest-last" "Blog digest state" "WARN" "blog-digest-stale" \
      "The blog digest job has not stamped its state file in over 35 days — the timer is dead or the script is crashing before its exit paths. Check /var/log/aiwebsite-blog-digest.log and 'systemctl list-timers aiwebsite-blog-digest.timer'." \
      3024000 \
      || log "FAIL: blog digest state missing/stale"
  fi
  # Synthetic-sweep heartbeat (§9.8 v1.17.0): the dev-box sweep stamps this
  # file over ssh after every completed run. Render-key-gated so
  # non-participating (gcloud-iap) hosts never false-fire. Seeded on first
  # sight — a fresh enable must not fire "missing" before the first sweep
  # lands — and chowned to $pm2_user so the ssh login user can overwrite it
  # (the watchdog runs as root).
  if [ "$synth_heartbeat_enabled" = "1" ]; then
    if [ ! -f "$app_root/data/synth-last-sweep" ]; then
      if date +%s > "$app_root/data/synth-last-sweep" 2>/dev/null; then
        chown "$pm2_user" "$app_root/data/synth-last-sweep" 2>/dev/null || true
        log "INFO: seeded synth sweep heartbeat"
      fi
    else
      file_age_alert "$app_root/data/synth-last-sweep" "Synthetic sweep heartbeat" "SYNTH WARN" "synth-heartbeat" \
        "The dev-box sweep runner has not stamped in >2h (8 missed 15-min cycles) — dead cron or dead runner. On the dev box: crontab -l | grep synth-sweep; tail ~/.local/state/aicompany-synth/sweep.log (RUNBOOK: Synthetic sweep)." \
        7200 \
        || log "FAIL: synth sweep heartbeat stale"
    fi
  fi

  # §9.9 v1.20.0: nightly hi-speed gate dead-man. hi-speed.sh stamps
  # data/hi-speed-last-run on EVERY exit path (incl. skips); >26h of silence
  # means the timer/unit itself is dead. Seed-on-first-sight so a fresh
  # v1.20.0 render never fires "missing" before the first 05:10 UTC fire.
  if [ ! -f "$app_root/data/hi-speed-last-run" ]; then
    if date +%s > "$app_root/data/hi-speed-last-run" 2>/dev/null; then
      chown "$pm2_user" "$app_root/data/hi-speed-last-run" 2>/dev/null || true
      log "INFO: seeded hi-speed heartbeat"
    fi
  else
    file_age_alert "$app_root/data/hi-speed-last-run" "Hi-speed gate heartbeat" "HI-SPEED WARN" "hi-speed-heartbeat" \
      "The nightly hi-speed timer has not stamped in >26h — dead timer or unit. On the VM: systemctl list-timers '*hi-speed*'; tail /var/log/*-hi-speed.log (RUNBOOK: Hi-speed gate)." \
      93600 \
      || log "FAIL: hi-speed heartbeat stale"
  fi

  # §5.15 drain honesty: a spool/.sending line older than 26h means issue
  # RECORDING is dead (secret missing in .env, /api/internal/issues not
  # mounted, endpoint erroring, drain wedged) while alerting still works —
  # say so once per 24h. Existence-guarded: no files = healthy silence,
  # never a "missing" mail (the .sending file only exists mid-retry).
  local sf first_ts first_epoch
  for sf in "$issue_spool_dir"/.sending "$issue_spool_dir"/*.ndjson; do
    [ -s "$sf" ] || continue
    first_ts=$(head -1 "$sf" 2>/dev/null | jq -r '.seenAt // empty' 2>/dev/null || true)
    [ -n "$first_ts" ] || continue
    first_epoch=$(date -d "$first_ts" +%s 2>/dev/null || echo 0)
    if (( first_epoch > 0 && $(date +%s) - first_epoch > stale_seconds )); then
      send_email \
        "WARN issue-ledger drain stuck (oldest spool line >26h)" \
        "Issue recording has not drained in over 26h while alert emails still send.\nFile: $sf\nLikely causes: ISSUE_TRACKER_SECRET missing from $app_root/.env, the host has not mounted /api/internal/issues, or the endpoint is failing.\nAlert emails are UNAFFECTED — only the reported_issues mirror is behind (§5.15)." \
        "issues-spool-stuck"
      break
    fi
  done
}

# ── Issue-ledger drain (§5.15 v1.30) ─────────────────────────────
# One NDJSON batch POST per pass, run ONLY after the site health check just
# passed (the endpoint lives in the app we verified — zero added latency on
# sick passes, where the spool simply grows). Two-phase: an existing .sending
# (a prior failed POST) is retried FIRST and its mtime is never touched (the
# check_freshness stuck alert keys on its first line's seenAt); new spool
# files are claimed only when nothing is pending. The batch is line- AND
# byte-bounded BELOW the server caps (2000 lines/512KB): 500 lines, then
# drop-oldest to <=256KB on line boundaries. Fail-closed: no secret ⇒ no
# drain (the spool ages into the stuck alert). All failure paths absorbed.
issue_sending="$issue_spool_dir/.sending"
drain_issue_spool() {
  [ -d "$issue_spool_dir" ] || return 0
  if [ ! -s "$issue_sending" ]; then
    local f claimed=0
    rm -f "$issue_sending" "$issue_sending.tmp" 2>/dev/null || true
    for f in "$issue_spool_dir"/*.ndjson; do
      [ -s "$f" ] || continue
      cat "$f" >> "$issue_sending.tmp" 2>/dev/null && : > "$f" && claimed=1
    done
    if [ "$claimed" = "1" ]; then
      tail -n 500 "$issue_sending.tmp" > "$issue_sending" 2>/dev/null || true
      rm -f "$issue_sending.tmp" 2>/dev/null || true
      local bsz
      bsz=$(stat -c %s "$issue_sending" 2>/dev/null || echo 0)
      while [ "$bsz" -gt 262144 ]; do
        tail -n +51 "$issue_sending" > "$issue_sending.tmp" 2>/dev/null && mv "$issue_sending.tmp" "$issue_sending" || break
        bsz=$(stat -c %s "$issue_sending" 2>/dev/null || echo 0)
      done
    else
      rm -f "$issue_sending.tmp" 2>/dev/null || true
    fi
  fi
  [ -s "$issue_sending" ] || return 0
  local ledger_secret
  ledger_secret=$(grep -E '^ISSUE_TRACKER_SECRET=' "$app_root/.env" 2>/dev/null | head -1 | cut -d'=' -f2- | tr -d '"' | tr -d "'")
  [ -n "$ledger_secret" ] || return 0
  curl -sf -m 10 -X POST "http://127.0.0.1:3000/api/internal/issues" \
    -H "content-type: application/x-ndjson" -H "x-issue-secret: $ledger_secret" \
    --data-binary @"$issue_sending" >/dev/null 2>&1 && rm -f "$issue_sending" || true
  return 0
}

# ── Lifecycle ────────────────────────────────────────────────────

cleanup() {
  log "INFO: Watchdog shutting down (PID $$)"
  # Only the lock holder owns the pid file; the flock is released implicitly
  # when the process (and fd 9) dies, so no explicit unlock is needed.
  rm -f "$pid_file"
  exit 0
}
trap cleanup SIGTERM SIGINT

# ── Singleton lock (§9.5) ────────────────────────────────────────
# Hold an exclusive advisory lock for the whole process lifetime. A second
# instance fails the non-blocking acquire and exits 0 — this is the ONLY
# liveness authority (the pid file below is observability only). Replaces the
# pid-file heuristic under which unrecorded daemons were invisible and
# accumulated (23 concurrent on aiwebsite, 2026-07-13). fd 9 stays open for
# the life of the process; the kernel drops the lock automatically on exit.
exec 9>"$lock_file" || { log "ERROR: cannot open lock file $lock_file"; exit 1; }
if ! flock -n 9; then
  log "INFO: another watchdog instance holds $lock_file — exiting"
  exit 0
fi

# Record PID for observability only (crontab/humans read it; liveness is the
# flock). Written AFTER the lock so the file always names the live holder.
echo $$ > "$pid_file"
load_resend_key
log "INFO: Watchdog started (PID $$, pm2_user=$pm2_user)"

# ── Extra services (v1.4.0, §9.5): host-declared non-pm2 services ─
# Supervision runs INSIDE this singleton loop — no second daemon, no new
# liveness authority. Config is the host-owned deploy/extra-services.json
# next to the rendered deploy/extra-services.sh library; absent manifest ⇒
# everything below is a no-op and the loop cadence is byte-identical to
# v1.3.4. An INVALID manifest alerts CRITICAL once and skips extra
# supervision — the watchdog never crash-loops on host config. Fail counts
# are in-process; last-start stamps live in /var/run (written by es_start, so
# the cooldown grace also covers deploy-time starts). Manifest edits take
# effect on watchdog restart.
es_enabled=false
es_lib="$app_root/deploy/extra-services.sh"
es_fail_counts=()
es_tick_every=()
tick_seconds=$check_interval
if [[ -f "$es_lib" ]]; then
  # shellcheck source=/dev/null
  source "$es_lib"
  if es_manifest_present; then
    if es_validate >> "$log_file" 2>&1 && es_load; then
      es_enabled=true
      for esi in "${!es_names[@]}"; do
        es_fail_counts+=(0)
        if (( ${es_check_intervals[$esi]} < tick_seconds )); then
          tick_seconds=${es_check_intervals[$esi]}
        fi
      done
      log "INFO: extra-services supervision ON (${es_names[*]}; tick ${tick_seconds}s)"
    else
      log "ERROR: extra-services manifest invalid — extra supervision SKIPPED (standard checks continue)"
      send_email \
        "CRITICAL extra-services manifest invalid — supervision skipped" \
        "deploy/extra-services.json failed validation; extra services are NOT supervised until it is fixed and the watchdog restarts.\nRun: bash deploy/extra-services.sh validate" \
        "es-manifest-invalid"
    fi
  fi
fi
# Standard 60s checks run every Nth tick — their cadence is unchanged; page
# checks stay at every 5th STANDARD pass (5 min). No manifest ⇒ tick=60, N=1.
standard_every=$(( check_interval / tick_seconds ))
(( standard_every < 1 )) && standard_every=1
if [[ "$es_enabled" == "true" ]]; then
  for esi in "${!es_names[@]}"; do
    ete=$(( ${es_check_intervals[$esi]} / tick_seconds ))
    (( ete < 1 )) && ete=1
    es_tick_every+=("$ete")
  done
fi

# ── Main loop ────────────────────────────────────────────────────

iteration=0
standard_pass=0

while true; do
  iteration=$(( iteration + 1 ))

  # Extra services: per-service cadence in ticks; failures during the
  # post-start cooldown are NOT counted (start grace, legacy parity); the
  # cooldown check runs BEFORE restart_and_alert so a refusal is a logged
  # SKIP, never a CRITICAL failed-restart mail; repairs route through
  # restart_and_alert with the deploy-marker gate (per-service gateOnDeploy)
  # so a deploy that owns es_stop/es_start is never raced (§9.5).
  if [[ "$es_enabled" == "true" ]]; then
    for esi in "${!es_names[@]}"; do
      (( (iteration - 1) % ${es_tick_every[$esi]} == 0 )) || continue
      es_name="${es_names[$esi]}"
      if es_health_one "$esi"; then
        es_fail_counts[$esi]=0
        # Fourth deploy-defer key family: a gateOnDeploy service defers as
        # "svc-<name>" (roleplay ships voice with gateOnDeploy true), so it
        # mints deploy-defer-svc-voice and needs the same resolution path as
        # the three PM2 services. $es_name is the SAME variable the defer site
        # uses, so the two can never drift.
        clear_deploy_defer "deploy-defer-svc-$es_name" "svc-$es_name healthy again after a deploy-window deferral"
      elif es_in_cooldown "$esi"; then
        log "INFO: svc-$es_name health failed during start cooldown — not counted"
      else
        es_fail_counts[$esi]=$(( ${es_fail_counts[$esi]} + 1 ))
        log "FAIL: svc-$es_name health check failed (${es_fail_counts[$esi]}/${es_fail_thresholds[$esi]}) — ${es_health_urls[$esi]}"
        if (( ${es_fail_counts[$esi]} >= ${es_fail_thresholds[$esi]} )); then
          es_fail_counts[$esi]=0
          es_details="Health URL: ${es_health_urls[$esi]}\nPort: :${es_ports[$esi]}\nService log: ${es_log_files[$esi]}"
          # The decision routes through es_should_restart (the pure function
          # the truth-table tests pin) BEFORE restart_and_alert is entered —
          # a cooldown refusal is a logged SKIP, never a CRITICAL mail.
          if ! es_decision=$(es_should_restart "$(date +%s)" "$(es_last_start_epoch "$es_name")" "${es_fail_thresholds[$esi]}" "${es_fail_thresholds[$esi]}" "${es_cooldowns[$esi]}"); then
            log "SKIP: svc-$es_name restart — $es_decision"
          elif [[ "${es_gate_on_deploys[$esi]}" == "true" ]]; then
            restart_and_alert "svc-$es_name" \
              "es_restart $es_name" \
              "$es_details" \
              "true"
          else
            restart_and_alert "svc-$es_name" \
              "es_restart $es_name" \
              "$es_details"
          fi
        fi
      fi
    done
  fi

  if (( (iteration - 1) % standard_every != 0 )); then
    sleep "$tick_seconds" 9>&-
    continue
  fi

  standard_pass=$(( standard_pass + 1 ))
  any_failure=false

  # 0. Interrupted-cutover heal (M2c) — BEFORE the service checks: restarting
  # pm2 against a half-flipped tree just crash-loops; heal first, then the
  # checks below verify the restored generation on this same pass.
  check_cutover_journal

  # 1. PostgreSQL
  if ! pg_isready -h localhost -p 5432 -q 2>/dev/null; then
    log "FAIL: PostgreSQL is not ready"
    any_failure=true
    restart_and_alert "postgresql" "systemctl restart postgresql" \
      "pg_isready -h localhost -p 5432 returned non-zero"
    sleep 5
  fi

  # 2. nginx
  if [[ "$(systemctl is-active nginx 2>/dev/null)" != "active" ]]; then
    log "FAIL: nginx is not active"
    any_failure=true
    restart_and_alert "nginx" "systemctl restart nginx" \
      "systemctl is-active nginx returned: $(systemctl is-active nginx 2>&1)"
  fi

  # 3. cloudflared (the sole public entry point for ai.xl.net)
  if [[ "$(systemctl is-active cloudflared 2>/dev/null)" != "active" ]]; then
    log "FAIL: cloudflared is not active"
    any_failure=true
    restart_and_alert "cloudflared" "systemctl restart cloudflared" \
      "systemctl is-active cloudflared returned: $(systemctl is-active cloudflared 2>&1)"
  fi

  # 4. brain-api (:3211) -- /health is unauthenticated even in fail-closed mode
  brain_response=$(curl -sf -m 10 "$brain_health_url" 2>&1) || brain_response=""
  if [[ -z "$brain_response" ]] || ! echo "$brain_response" | grep -q '"ok":true'; then
    log "FAIL: brain-api health check failed: $brain_response"
    any_failure=true
    restart_and_alert "$svc_brain" \
      "run_as_pm2_user 'pm2 restart brain-api'" \
      "Health URL: $brain_health_url\nResponse: ${brain_response:-<empty>}" \
      "true"
  else
    clear_deploy_defer "deploy-defer-$svc_brain" "$svc_brain healthy again after a deploy-window deferral"
  fi

  # 5. skills-host (:3213)
  skills_response=$(curl -sf -m 10 "$skills_health_url" 2>&1) || skills_response=""
  if [[ -z "$skills_response" ]] || ! echo "$skills_response" | grep -q '"ok":true'; then
    log "FAIL: skills-host health check failed: $skills_response"
    any_failure=true
    restart_and_alert "$svc_skills" \
      "run_as_pm2_user 'pm2 restart skills-host'" \
      "Health URL: $skills_health_url\nResponse: ${skills_response:-<empty>}" \
      "true"
  else
    clear_deploy_defer "deploy-defer-$svc_skills" "$svc_skills healthy again after a deploy-window deferral"
  fi

  # 6. Next.js site (:3000) -- check last since it depends on postgres + brain
  site_healthy=false
  site_response=$(curl -sf -m 10 "$site_health_url" 2>&1) || site_response=""
  if [[ -z "$site_response" ]] || ! echo "$site_response" | grep -q '"status":"ok"'; then
    log "FAIL: site health check failed: $site_response"
    any_failure=true

    pm2_status=$(run_as_pm2_user "pm2 jlist" 2>/dev/null | grep -o '"status":"[^"]*"' | head -1 || echo "unknown")
    restart_and_alert "$svc_site" \
      "run_as_pm2_user 'pm2 restart aiwebsite'" \
      "Health URL: $site_health_url\nResponse: ${site_response:-<empty>}\nPM2 status: $pm2_status" \
      "true"
  else
    site_healthy=true
    clear_deploy_defer "deploy-defer-$svc_site" "$svc_site healthy again after a deploy-window deferral"
  fi

  # 7. Livelock defenses armed? (v1.15.0 §9.5 — 2026-07-22 aiwebsite outage)
  # swap + earlyoom turn a memory squeeze into a bounded kill instead of a
  # 78-min reclaim livelock; if either is missing the box is one heavy build
  # away from unrecoverable-without-console. WARNs throttle 24h as usual.
  if [[ "$(systemctl is-active earlyoom 2>/dev/null)" != "active" ]]; then
    log "FAIL: earlyoom is not active — livelock breaker unarmed"
    any_failure=true
    send_email \
      "WARN earlyoom not active — livelock breaker unarmed" \
      "systemctl is-active earlyoom: $(systemctl is-active earlyoom 2>&1)\n\nWithout earlyoom a memory squeeze can relapse into the 2026-07-22 near-OOM reclaim livelock (box dead 78 min, console reboot required). Re-run deploy/setup-vm.sh, or: sudo systemctl enable --now earlyoom" \
      "earlyoom-inactive"
  fi
  if [[ -z "$(swapon --show --noheadings 2>/dev/null)" ]]; then
    log "FAIL: no active swap — schedulability under memory pressure lost"
    any_failure=true
    send_email \
      "WARN no active swap — livelock defenses degraded" \
      "swapon --show is empty. The v1.15.0 defenses assume the 4G swapfile: swap = schedulability under pressure, and earlyoom's swap threshold never trips without it. stage-build will refuse to deploy until it is back. Re-run deploy/setup-vm.sh (MIGRATIONS v1.15.0)." \
      "swap-missing"
  else
    # v1.29.1 drift detector: setup-vm's size gate only runs at deploy time —
    # a host that pre-dates it (or hasn't deployed since) can still run an
    # undersized legacy swapfile, whose SwapFree arms earlyoom's -s 30 leg
    # permanently once utilization climbs (itsupportchicago 2026-07-26).
    # Alert-only, deliberately NOT any_failure: the box is degraded, not down.
    swap_total_kb=$(awk '/^SwapTotal:/{print $2}' /proc/meminfo)
    if (( swap_total_kb < 4000000 )); then
      log "WARN: SwapTotal ${swap_total_kb}kB is below the 4G fleet standard"
      send_email \
        "WARN swap undersized — SwapTotal ${swap_total_kb}kB < 4G standard" \
        "SwapTotal is ${swap_total_kb} kB; the §9.5 defenses assume a 4G /swapfile. At high utilization an undersized swap holds SwapFree below earlyoom's 30% SIGTERM leg permanently, so deploy builds get killed whenever MemAvailable dips under 15%. Live-resize it (temp-swap-first, never a bare swapoff under load — MIGRATIONS v1.29.1); setup-vm.sh now refuses to deploy over an undersized swapfile." \
        "swap-undersized"
    fi
  fi
  # earlyoom kill events since the last pass → alert naming the victim.
  # This REPLACES earlyoom's -N notifier: Debian's unit sandboxing broke the
  # mailer silently (S2) — the journal is the source of truth.
  # v1.15.2: match KILL EVENTS ONLY — earlyoom's startup banner ("sending
  # SIGTERM when mem <= ...") matched the v1.15.0 pattern and fired one false
  # CRITICAL per host per restart (2026-07-22, three in one rollout). Kill
  # lines (earlyoom 1.8.x, C locale — re-verify formats on earlyoom upgrades,
  # MIGRATIONS v1.15.2) name a pid: `sending SIGTERM to process <pid> uid
  # <uid> "<name>": badness ...`, SIGKILL escalation same shape; pre-1.0 used
  # `Killing process <pid>`. The discriminator is "to process".
  now_ts=$(date +%s)
  if ! last_scan=$(cat "$earlyoom_scan_stamp" 2>/dev/null) || [[ -z "$last_scan" ]]; then
    last_scan=$(( now_ts - 3600 ))
  fi
  earlyoom_window=$(journalctl -u earlyoom --since "@${last_scan}" --no-pager 2>/dev/null || true)
  earlyoom_kills=$(printf '%s' "$earlyoom_window" | grep -aE 'sending SIG(TERM|KILL) to (process|pid) [0-9]+|[Kk]illing process [0-9]+' || true)
  if printf '%s' "$earlyoom_window" | grep -aq 'sending SIGTERM when'; then
    # Banner = unit (re)start — routine during deploys; log-only, never mail.
    log "INFO: earlyoom (re)started in this window"
  fi
  if [[ -n "$earlyoom_kills" ]]; then
    # Threshold evidence, quoted verbatim when earlyoom logged it.
    earlyoom_evidence=$(printf '%s' "$earlyoom_window" | grep -a 'low memory' | tail -2 || true)
    # Severity taxonomy (ops panel 2026-07-22): a killed BUILD step during a
    # live deploy window is the designed pre-cutover abort → WARN; anything
    # else (app/infra victim, or no deploy running) is the livelock
    # precursor → CRITICAL, even though pm2 auto-restarts.
    kill_sev="CRITICAL"
    marker="/var/run/aiwebsite-deploy-in-progress"
    if [[ -f "$marker" ]] && (( now_ts - $(stat -c %Y "$marker" 2>/dev/null || echo 0) < 1800 )); then
      if ! printf '%s' "$earlyoom_kills" | grep -aqvE '"(npm|node|next-server|tsx|npx)[^"]*"'; then
        kill_sev="WARN (deploy window)"
      fi
    fi
    log "FAIL: earlyoom killed under memory pressure: $(echo "$earlyoom_kills" | tail -1)"
    any_failure=true
    send_email \
      "$kill_sev earlyoom killed a process (memory pressure)" \
      "earlyoom kill events since the last watchdog pass (victim named per line):\n$earlyoom_kills\n\nThreshold evidence from earlyoom (verbatim, may be empty):\n$earlyoom_evidence\n\nConfigured thresholds: SIGTERM at MemAvail<=15% AND SwapFree<=30%; SIGKILL at 8%/15%. A killed npm/node build step means a deploy aborted safely pre-cutover; a killed app SHOULD have been restarted by pm2/this watchdog — verify below. The PRESSURE is the story: check free -m, /var/log/aiwebsite-psi.log and sar -r before the next deploy.\n\npm2 status now:\n$(run_as_pm2_user pm2 ls 2>/dev/null | head -12)" \
      "earlyoom-kill"
  fi
  # Stamp written AFTER the mail path so a crash between scan and send never
  # loses a kill (re-reporting a window once is the safe direction).
  echo "$now_ts" > "$earlyoom_scan_stamp"

  # 8. Backup heartbeat + knowledge freshness (cheap stats; alerts throttled 24h)
  check_freshness

  # 9. Page-render checks (every 5th standard pass = 5 minutes)
  if (( standard_pass % page_check_every == 0 )); then
    check_pages
    check_synth_pages
  fi

  if [[ "$any_failure" == "false" ]]; then
    log "OK: All checks passed"
  fi

  # §5.15 issue-ledger drain — only when the site health check just passed
  # (never inside send_email; never on a sick pass).
  if [[ "$site_healthy" == "true" ]]; then
    drain_issue_spool || true
  fi

  # v1.30.1: `9>&-` for the same reason it is on every run_as_pm2_user spawn
  # above — this sleep is the watchdog's LONGEST-LIVED child (a full tick), so
  # without it a `pkill -f <daemon-name>` (which never matches a bare `sleep`)
  # leaves the singleton lock held for up to tick_seconds after the daemon is
  # gone. The cron supervisor's flock probe then reports "alive", no-ops, and
  # the box runs with ZERO watchdogs until the next */5 tick — observed on
  # itsupportchicago 2026-07-26 during a watchdog reinstall.
  sleep "$tick_seconds" 9>&-
done
