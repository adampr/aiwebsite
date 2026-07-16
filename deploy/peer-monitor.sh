#!/usr/bin/env bash
# aicompany-template: peer-monitor.sh.tpl@299c923851cd4f8a8a9155150eee799190fc6fee6332cc99d7e51de2a4d425b3
# Cross-site peer monitor (@aicompany/core template, §9.7 v1.6). The
# self-hosted watchdog can't report a dead VM or severed tunnel, so sibling
# sites watch each other across hosting providers. Runs every 5 min from a
# systemd timer (installation is a runbook step, §9.7 — deploy never touches
# units). Alerts via Resend using this site's own .env; 3 consecutive
# failures trip an alert, throttled to one per 6h per peer while down, plus a
# one-time recovery notice.
#
# Rendered per host from PEER_MONITOR_PEERS in deploy/site-deploy.env
# (space-separated name|url pairs); every default below is overridable via
# PEER_MONITOR_* environment for ad-hoc runs.
set -uo pipefail

site_name="${PEER_MONITOR_SITE:-aiwebsite}"
env_file="${PEER_MONITOR_ENV:-/var/www/aiwebsite/.env}"
state_dir="${PEER_MONITOR_STATE:-/var/lib/aiwebsite/peer-monitor}"
alert_to="${PEER_MONITOR_TO:-adam@xl.net}"
alert_from="${PEER_MONITOR_FROM:-ai.xl.net Watchdog <noreply@ai.xl.net>}"
# name|url pairs; a peer is healthy when the URL returns HTTP 200 within 15s.
peers="${PEER_MONITOR_PEERS_OVERRIDE:-itsupportchicago.net|https://itsupportchicago.net/api/health}"

fail_threshold=3
throttle_sec=$((6 * 3600))

resend_api_key=$(grep -m1 '^RESEND_API_KEY=' "$env_file" | cut -d= -f2-)
mkdir -p "$state_dir"

send_alert() { # subject body
  [ -n "$resend_api_key" ] || { echo "$(date -Is) no RESEND_API_KEY; cannot alert"; return 1; }
  curl -sS -m 20 https://api.resend.com/emails \
    -H "Authorization: Bearer $resend_api_key" \
    -H "Content-Type: application/json" \
    -d "$(printf '{"from":"%s","to":"%s","subject":"%s","text":"%s"}' \
          "$alert_from" "$alert_to" "$1" "$2")" >/dev/null || true
}

for peer in $peers; do
  name="${peer%%|*}"; url="${peer#*|}"
  fails_f="$state_dir/$name.fails"; alerted_f="$state_dir/$name.alerted"
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 15 "$url" || echo 000)

  if [ "$code" = "200" ]; then
    if [ -f "$alerted_f" ]; then
      send_alert "[$site_name peer-monitor] RECOVERED: $name" \
        "$name ($url) is answering 200 again as of $(date -Is), observed from $site_name."
      rm -f "$alerted_f"
    fi
    rm -f "$fails_f"
    continue
  fi

  fails=$(( $(cat "$fails_f" 2>/dev/null || echo 0) + 1 ))
  echo "$fails" > "$fails_f"
  echo "$(date -Is) $name check failed (HTTP $code, consecutive $fails)"
  if [ "$fails" -ge "$fail_threshold" ]; then
    last=$(cat "$alerted_f" 2>/dev/null || echo 0)
    now=$(date +%s)
    if [ $((now - last)) -ge "$throttle_sec" ]; then
      send_alert "[$site_name peer-monitor] DOWN: $name (HTTP $code)" \
        "$name ($url) has failed $fails consecutive checks (latest HTTP $code) as of $(date -Is), observed from $site_name. The site's own watchdog cannot report a dead VM or severed tunnel — check the hosting console."
      echo "$now" > "$alerted_f"
    fi
  fi
done
