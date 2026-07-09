#!/usr/bin/env bash
# ai.xl.net watchdog -- persistent health-check loop.
# Modeled on itsupportchicago/deploy/watchdog.sh.
# Checks PostgreSQL, nginx, cloudflared, and the three PM2 apps
# (aiwebsite :3000, brain-api :3211, skills-host :3213) every 60 seconds.
# Page-render checks run every 5 minutes (every 5th iteration).
# Restarts failed services and sends throttled email alerts via Resend.
# Email alerts are throttled per-issue: max 1 email per 24h per unique issue.
set -uo pipefail

APP_ROOT="/var/www/aiwebsite"
PID_FILE="/var/run/aiwebsite-watchdog.pid"
LOG_FILE="/var/log/aiwebsite-watchdog.log"
THROTTLE_DIR="/tmp/aiwebsite-watchdog-throttle"
ISSUE_THROTTLE_SECONDS=86400  # 24 hours per unique issue
AI_THROTTLE_SECONDS=14400     # 4 hours for AI-provider failures (per Adam)
CHECK_INTERVAL=60
PAGE_CHECK_EVERY=5   # run page checks every Nth iteration (5 × 60s = 5 min)
AI_CHECK_EVERY=30    # run AI-provider checks every Nth iteration (30 × 60s = 30 min)
NOTIFY_TO="adam@xl.net"
NOTIFY_FROM="ai.xl.net Watchdog <noreply@ai.xl.net>"

SITE_HEALTH_URL="http://127.0.0.1:3000/api/health"
BRAIN_HEALTH_URL="http://127.0.0.1:3211/health"
SKILLS_HEALTH_URL="http://127.0.0.1:3213/health"

PAGE_CHECK_URLS=(
  "http://127.0.0.1:3000/"
  "http://127.0.0.1:3000/contact"
  "http://127.0.0.1:3000/login"
)

# ── Helpers ──────────────────────────────────────────────────────

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S %Z') $1" >> "$LOG_FILE"
}

load_resend_key() {
  local env_file="$APP_ROOT/.env"
  if [[ -f "$env_file" ]]; then
    RESEND_API_KEY=$(grep -E '^RESEND_API_KEY=' "$env_file" | head -1 | cut -d'=' -f2- | tr -d '"' | tr -d "'")
  fi
  if [[ -z "${RESEND_API_KEY:-}" ]]; then
    log "WARN: RESEND_API_KEY not found in $env_file -- email alerts disabled"
  fi
}

send_email() {
  local subject="$1"
  local body="$2"
  local issue_key="${3:-global}"
  local throttle_seconds="${4:-$ISSUE_THROTTLE_SECONDS}"

  if [[ -z "${RESEND_API_KEY:-}" ]]; then
    log "WARN: Skipping email (no API key): $subject"
    return
  fi

  mkdir -p "$THROTTLE_DIR"
  local safe_key
  safe_key=$(echo "$issue_key" | tr '/:. ' '____')
  local throttle_file="$THROTTLE_DIR/$safe_key"

  if [[ -f "$throttle_file" ]]; then
    local last_sent now
    last_sent=$(cat "$throttle_file")
    now=$(date +%s)
    if (( now - last_sent < throttle_seconds )); then
      log "INFO: Email throttled for issue '$issue_key' (last sent $(( now - last_sent ))s ago): $subject"
      return
    fi
  fi

  local timestamp
  timestamp=$(TZ='America/Chicago' date '+%Y-%m-%d %I:%M:%S %p %Z')

  local html_body="<div style=\"font-family:monospace;background:#111827;color:#f1f5f9;padding:24px;border-radius:8px;\">
<h2 style=\"color:#ef4444;margin:0 0 12px;\">[WATCHDOG] Service Alert</h2>
<p><strong>Time:</strong> ${timestamp}</p>
<p><strong>Host:</strong> aiwebsite (Azure VM, ai.xl.net)</p>
<hr style=\"border:none;border-top:1px solid #374151;margin:16px 0;\"/>
<pre style=\"white-space:pre-wrap;\">${body}</pre>
</div>"

  curl -sf -m 15 -X POST "https://api.resend.com/emails" \
    -H "Authorization: Bearer ${RESEND_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "$(printf '{"from":"%s","to":["%s"],"subject":"%s","html":"%s"}' \
      "$NOTIFY_FROM" "$NOTIFY_TO" "$subject" \
      "$(echo "$html_body" | sed 's/"/\\"/g' | tr -d '\n')")" \
    >> "$LOG_FILE" 2>&1 && {
      date +%s > "$throttle_file"
      log "INFO: Alert email sent: $subject"
    } || {
      log "WARN: Failed to send alert email: $subject"
    }
}

restart_and_alert() {
  local service_name="$1"
  local restart_cmd="$2"
  local details="$3"

  log "ACTION: Restarting $service_name ..."
  eval "$restart_cmd" >> "$LOG_FILE" 2>&1
  local rc=$?

  if [[ $rc -eq 0 ]]; then
    log "ACTION: $service_name restarted successfully"
    send_email \
      "[WATCHDOG] Restarted $service_name on ai.xl.net" \
      "Service: $service_name\nAction: Restarted\nResult: Success\n\nDetails:\n$details" \
      "restart-$service_name"
  else
    log "ERROR: Failed to restart $service_name (exit $rc)"
    send_email \
      "[WATCHDOG] FAILED to restart $service_name on ai.xl.net" \
      "Service: $service_name\nAction: Restart attempted\nResult: FAILED (exit $rc)\n\nDetails:\n$details" \
      "restart-fail-$service_name"
  fi
}

# ── PM2 user handling ─────────────────────────────────────────────

# The watchdog runs as root (root cron), but PM2 and the app files belong to
# the deploy user. pm2/npm commands must run as that user or they hit root's
# empty PM2 daemon and create root-owned build artifacts.
PM2_USER="${PM2_USER:-$(stat -c %U "$APP_ROOT" 2>/dev/null || echo root)}"

run_as_pm2_user() {
  if [[ "$(id -un)" == "$PM2_USER" ]]; then
    bash -c "$1"
  else
    runuser -u "$PM2_USER" -- bash -c "$1"
  fi
}

# ── Page-render checks ────────────────────────────────────────────

attempt_clean_rebuild() {
  log "ACTION: Attempting rebuild (npm run build) ..."
  # No rm -rf .next: next build writes to a temp dir and swaps atomically, so
  # the running process keeps serving; deleting first causes 30-90s of 500s.
  run_as_pm2_user "cd '$APP_ROOT' && NODE_OPTIONS='--max-old-space-size=1024' npm run build" >> "$LOG_FILE" 2>&1
  local rc=$?
  if [[ $rc -eq 0 ]]; then
    log "ACTION: Rebuild succeeded, restarting PM2 ..."
    run_as_pm2_user "pm2 restart aiwebsite" >> "$LOG_FILE" 2>&1
    sleep 3
    return 0
  else
    log "ERROR: Rebuild failed (exit $rc)"
    return 1
  fi
}

check_pages() {
  local any_page_fail=false
  local failed_urls=()

  # Quick health check first — if the app is completely down, skip page checks
  # (the main loop's service checks will handle that)
  local hc
  hc=$(curl -sf -m 5 "$SITE_HEALTH_URL" 2>&1) || hc=""
  if [[ -z "$hc" ]] || ! echo "$hc" | grep -q '"status":"ok"'; then
    log "INFO: Skipping page checks -- health endpoint down"
    return
  fi

  for url in "${PAGE_CHECK_URLS[@]}"; do
    local http_code body
    http_code=$(curl -s -o /tmp/watchdog-page-body -w '%{http_code}' -m 15 "$url" 2>/dev/null) || http_code="000"
    body=$(cat /tmp/watchdog-page-body 2>/dev/null) || body=""

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

  rm -f /tmp/watchdog-page-body

  if [[ "$any_page_fail" == "true" ]]; then
    local detail_list
    detail_list=$(printf '%s\n' "${failed_urls[@]}")

    log "ACTION: Pages failing but health OK -- attempting clean rebuild"
    if attempt_clean_rebuild; then
      # Verify the fix worked
      local still_broken=false
      for url in "${PAGE_CHECK_URLS[@]}"; do
        local rc2
        rc2=$(curl -s -o /dev/null -w '%{http_code}' -m 15 "$url" 2>/dev/null) || rc2="000"
        if [[ "$rc2" -ge 500 || "$rc2" == "000" ]]; then
          still_broken=true
          break
        fi
      done

      if [[ "$still_broken" == "true" ]]; then
        send_email \
          "[WATCHDOG] Page errors persist after rebuild on ai.xl.net" \
          "Pages returning errors:\n${detail_list}\n\nA clean rebuild was attempted but pages are still broken.\nManual investigation required." \
          "page-render-fail"
      else
        send_email \
          "[WATCHDOG] Auto-fixed page errors via clean rebuild on ai.xl.net" \
          "Pages that were failing:\n${detail_list}\n\nA clean rebuild + PM2 restart resolved the issue.\nLikely cause: corrupted build cache." \
          "page-render-autofix"
      fi
    else
      send_email \
        "[WATCHDOG] Page errors on ai.xl.net (rebuild failed)" \
        "Pages returning errors:\n${detail_list}\n\nA clean rebuild was attempted but the build itself failed.\nManual investigation required." \
        "page-render-fail"
    fi
  else
    log "OK: All page checks passed"
  fi
}

# ── AI-provider checks ────────────────────────────────────────────

# Probes every AI lab key the stack depends on (OpenAI, Anthropic, xAI,
# Gemini, Deepgram, Tavily) plus a 1-token completion against every model id
# the brain's router would select right now (GET /v1/model-routing). Catches
# registry/routing failures — e.g. the router selecting a model the OpenAI
# key can't call, which surfaced to SMS users as "Sorry, I hit a snag" — and
# key expiry/quota exhaustion, before visitors do. Runs at watchdog startup
# (i.e. at boot) and every AI_CHECK_EVERY iterations; failures email
# NOTIFY_TO at most once per AI_THROTTLE_SECONDS (4h).
check_ai_providers() {
  local report rc
  report=$(run_as_pm2_user "cd '$APP_ROOT' && node scripts/ai-provider-health.mjs 2>&1")
  rc=$?

  if [[ $rc -eq 0 ]]; then
    log "OK: AI provider checks passed"
    return
  fi

  log "FAIL: AI provider checks failed:"
  while IFS= read -r line; do log "    $line"; done <<< "$report"

  send_email \
    "[WATCHDOG] AI provider failure on ai.xl.net" \
    "One or more AI providers/models the site depends on are failing.\nVisitor-facing symptom when this breaks the chat pipeline: Tron Netter answers 'Sorry, I hit a snag' over SMS / 'temporarily unavailable' on webchat.\n\n${report}\n\nRuns from deploy/watchdog.sh via scripts/ai-provider-health.mjs. This alert repeats at most every 4 hours while the failure persists." \
    "ai-provider-health" \
    "$AI_THROTTLE_SECONDS"
}

# ── Lifecycle ────────────────────────────────────────────────────

cleanup() {
  log "INFO: Watchdog shutting down (PID $$)"
  rm -f "$PID_FILE"
  exit 0
}
trap cleanup SIGTERM SIGINT

# Write PID file
echo $$ > "$PID_FILE"
load_resend_key
log "INFO: Watchdog started (PID $$, PM2_USER=$PM2_USER)"

# ── Main loop ────────────────────────────────────────────────────

iteration=0

while true; do
  any_failure=false
  iteration=$(( iteration + 1 ))

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
  brain_response=$(curl -sf -m 10 "$BRAIN_HEALTH_URL" 2>&1) || brain_response=""
  if [[ -z "$brain_response" ]] || ! echo "$brain_response" | grep -q '"ok":true'; then
    log "FAIL: brain-api health check failed: $brain_response"
    any_failure=true
    restart_and_alert "brain-api (PM2)" \
      "run_as_pm2_user 'pm2 restart brain-api'" \
      "Health URL: $BRAIN_HEALTH_URL\nResponse: ${brain_response:-<empty>}"
  fi

  # 5. skills-host (:3213)
  skills_response=$(curl -sf -m 10 "$SKILLS_HEALTH_URL" 2>&1) || skills_response=""
  if [[ -z "$skills_response" ]] || ! echo "$skills_response" | grep -q '"ok":true'; then
    log "FAIL: skills-host health check failed: $skills_response"
    any_failure=true
    restart_and_alert "skills-host (PM2)" \
      "run_as_pm2_user 'pm2 restart skills-host'" \
      "Health URL: $SKILLS_HEALTH_URL\nResponse: ${skills_response:-<empty>}"
  fi

  # 6. Next.js site (:3000) -- check last since it depends on postgres + brain
  site_response=$(curl -sf -m 10 "$SITE_HEALTH_URL" 2>&1) || site_response=""
  if [[ -z "$site_response" ]] || ! echo "$site_response" | grep -q '"status":"ok"'; then
    log "FAIL: site health check failed: $site_response"
    any_failure=true

    pm2_status=$(run_as_pm2_user "pm2 jlist" 2>/dev/null | grep -o '"status":"[^"]*"' | head -1 || echo "unknown")
    restart_and_alert "aiwebsite (Next.js/PM2)" \
      "run_as_pm2_user 'pm2 restart aiwebsite'" \
      "Health URL: $SITE_HEALTH_URL\nResponse: ${site_response:-<empty>}\nPM2 status: $pm2_status"
  fi

  # 7. Page-render checks (every 5 minutes)
  if (( iteration % PAGE_CHECK_EVERY == 0 )); then
    check_pages
  fi

  # 8. AI-provider checks (at startup/boot, then every 30 minutes)
  if (( iteration == 1 || iteration % AI_CHECK_EVERY == 0 )); then
    check_ai_providers
  fi

  if [[ "$any_failure" == "false" ]]; then
    log "OK: All checks passed"
  fi

  sleep "$CHECK_INTERVAL"
done
