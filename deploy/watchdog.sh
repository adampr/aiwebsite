#!/usr/bin/env bash
# aicompany-template: watchdog.sh.tpl@677073dd6e9d6d0d47ae8c8c9c28b021455311b1846c1ff6a5ebf81cb624887c
# ai.xl.net watchdog — persistent health-check loop (§9.5).
# Checks PostgreSQL, nginx, cloudflared, and the three PM2 apps
# (aiwebsite :3000, brain-api :3211, skills-host :3213)
# every 60 seconds, plus the backup/blog heartbeats and knowledge-doc freshness
# (>26h → alert). Page-render checks run every 5 minutes (every 5th pass) and
# can trigger a clean rebuild. Restarts failed services and sends throttled
# email alerts via Resend — every subject starts "[aiwebsite] <SEVERITY>" so one
# operator can triage N sites' streams; max 1 email per 24h per unique issue.
set -uo pipefail

app_root="/var/www/aiwebsite"
pid_file="/var/run/aiwebsite-watchdog.pid"
log_file="/var/log/aiwebsite-watchdog.log"
throttle_dir="/tmp/aiwebsite-watchdog-throttle"
issue_throttle_seconds=86400  # 24 hours per unique issue
check_interval=60
page_check_every=5            # run page checks every Nth iteration (5 × 60s = 5 min)
stale_seconds=93600           # 26h — backup heartbeat + knowledge doc freshness
notify_to="adam@xl.net"
notify_from="ai.xl.net Watchdog <noreply@ai.xl.net>"

site_health_url="http://127.0.0.1:3000/api/health"
brain_health_url="http://127.0.0.1:3211/health"
skills_health_url="http://127.0.0.1:3213/health"
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

# ── Helpers ──────────────────────────────────────────────────────

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S %Z') $1" >> "$log_file"
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

# send_email "<subject after the [slug] prefix>" "<body>" "<issue key>"
# Subject convention (§9.5): "[aiwebsite] <SEVERITY> ..." — callers pass
# "CRITICAL ..." / "WARN ..." and the site prefix is added here.
send_email() {
  local subject="[aiwebsite] $1"
  local body="$2"
  local issue_key="$3"

  if [[ -z "${resend_api_key:-}" ]]; then
    log "WARN: Skipping email (no API key): $subject"
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
    if (( now - last_sent < issue_throttle_seconds )); then
      log "INFO: Email throttled for issue '$issue_key' (last sent $(( now - last_sent ))s ago): $subject"
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
    -d "$(printf '{"from":"%s","to":["%s"],"subject":"%s","html":"%s"}' \
      "$notify_from" "$notify_to" "$subject" \
      "$(echo "$html_body" | sed 's/"/\\"/g' | tr -d '\n')")" \
    >> "$log_file" 2>&1 && {
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
  eval "$restart_cmd" >> "$log_file" 2>&1
  local rc=$?

  if [[ $rc -eq 0 ]]; then
    log "ACTION: $service_name restarted successfully"
    send_email \
      "WARN Restarted $service_name" \
      "Service: $service_name\nAction: Restarted\nResult: Success\n\nDetails:\n$details" \
      "restart-$service_name"
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

run_as_pm2_user() {
  if [[ "$(id -un)" == "$pm2_user" ]]; then
    bash -c "$1"
  else
    runuser -u "$pm2_user" -- bash -c "$1"
  fi
}

# ── Page-render checks ────────────────────────────────────────────

attempt_clean_rebuild() {
  log "ACTION: Attempting rebuild (npm run build) ..."
  # No rm -rf .next: next build writes to a temp dir and swaps atomically, so
  # the running process keeps serving; deleting first causes 30-90s of 500s.
  run_as_pm2_user "cd '$app_root' && NODE_OPTIONS='--max-old-space-size=1024' npm run build" >> "$log_file" 2>&1
  local rc=$?
  if [[ $rc -eq 0 ]]; then
    log "ACTION: Rebuild succeeded, restarting PM2 ..."
    run_as_pm2_user "pm2 restart aiwebsite" >> "$log_file" 2>&1
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

    log "ACTION: Pages failing but health OK -- attempting clean rebuild"
    if attempt_clean_rebuild; then
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
      fi
    else
      send_email \
        "CRITICAL Page errors and the rebuild failed" \
        "Pages returning errors:\n$detail_list\n\nA clean rebuild was attempted but the build itself failed.\nManual investigation required." \
        "page-render-fail"
    fi
  else
    log "OK: All page checks passed"
  fi
}

# ── Freshness checks: backup heartbeat + knowledge doc (§9.5) ─────

file_age_alert() { # path, label, severity, issue_key, remedy
  local path="$1" label="$2" severity="$3" issue_key="$4" remedy="$5"
  local mtime age
  mtime=$(stat -c %Y "$path" 2>/dev/null) || {
    send_email \
      "$severity $label missing" \
      "$path does not exist.\n\n$remedy" \
      "$issue_key"
    return 1
  }
  age=$(( $(date +%s) - mtime ))
  if (( age > stale_seconds )); then
    send_email \
      "$severity $label stale (>26h)" \
      "$path was last updated $(( age / 3600 ))h ago (threshold 26h).\n\n$remedy" \
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
  if [ "0" = "1" ]; then
    file_age_alert "$app_root/data/blog-last-run" "Blog heartbeat" "WARN" "blog-heartbeat" \
      "The nightly blog job has not written its heartbeat in over a day — the timer is dead or the job is crashing before its exit paths. Check /var/log/aiwebsite-blog.log and 'systemctl list-timers aiwebsite-blog.timer'." \
      || log "FAIL: blog heartbeat missing/stale"
  fi
}

# ── Lifecycle ────────────────────────────────────────────────────

cleanup() {
  log "INFO: Watchdog shutting down (PID $$)"
  rm -f "$pid_file"
  exit 0
}
trap cleanup SIGTERM SIGINT

# Write PID file
echo $$ > "$pid_file"
load_resend_key
log "INFO: Watchdog started (PID $$, pm2_user=$pm2_user)"

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
  brain_response=$(curl -sf -m 10 "$brain_health_url" 2>&1) || brain_response=""
  if [[ -z "$brain_response" ]] || ! echo "$brain_response" | grep -q '"ok":true'; then
    log "FAIL: brain-api health check failed: $brain_response"
    any_failure=true
    restart_and_alert "brain-api (PM2)" \
      "run_as_pm2_user 'pm2 restart brain-api'" \
      "Health URL: $brain_health_url\nResponse: ${brain_response:-<empty>}"
  fi

  # 5. skills-host (:3213)
  skills_response=$(curl -sf -m 10 "$skills_health_url" 2>&1) || skills_response=""
  if [[ -z "$skills_response" ]] || ! echo "$skills_response" | grep -q '"ok":true'; then
    log "FAIL: skills-host health check failed: $skills_response"
    any_failure=true
    restart_and_alert "skills-host (PM2)" \
      "run_as_pm2_user 'pm2 restart skills-host'" \
      "Health URL: $skills_health_url\nResponse: ${skills_response:-<empty>}"
  fi

  # 6. Next.js site (:3000) -- check last since it depends on postgres + brain
  site_response=$(curl -sf -m 10 "$site_health_url" 2>&1) || site_response=""
  if [[ -z "$site_response" ]] || ! echo "$site_response" | grep -q '"status":"ok"'; then
    log "FAIL: site health check failed: $site_response"
    any_failure=true

    pm2_status=$(run_as_pm2_user "pm2 jlist" 2>/dev/null | grep -o '"status":"[^"]*"' | head -1 || echo "unknown")
    restart_and_alert "aiwebsite (Next.js/PM2)" \
      "run_as_pm2_user 'pm2 restart aiwebsite'" \
      "Health URL: $site_health_url\nResponse: ${site_response:-<empty>}\nPM2 status: $pm2_status"
  fi

  # 7. Backup heartbeat + knowledge freshness (cheap stats; alerts throttled 24h)
  check_freshness

  # 8. Page-render checks (every 5 minutes)
  if (( iteration % page_check_every == 0 )); then
    check_pages
  fi

  if [[ "$any_failure" == "false" ]]; then
    log "OK: All checks passed"
  fi

  sleep "$check_interval"
done
