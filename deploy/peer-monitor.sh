#!/usr/bin/env bash
# Cross-site peer monitor (host-owned, not an @aicompany/core template).
# The self-hosted watchdog can't report a dead VM or severed tunnel, so the
# sibling sites watch each other across hosting providers (module README §3.8):
#   Azure ai.xl.net        →  itsupportchicago.net (GCP)
#   GCP  itsupportchicago  →  ai.xl.net + roleplay.xl.net (Azure)
# Runs every 5 min from a systemd timer. Alerts via Resend using the site's
# own .env; 3 consecutive failures trip an alert, throttled to one per 6h per
# peer while down, plus a one-time recovery notice. Keep in sync with
# itsupportchicago's deploy/peer-monitor.sh (same script, different defaults).
set -uo pipefail

SITE_NAME="${PEER_MONITOR_SITE:-aiwebsite}"
ENV_FILE="${PEER_MONITOR_ENV:-/var/www/aiwebsite/.env}"
STATE_DIR="${PEER_MONITOR_STATE:-/var/lib/${SITE_NAME}/peer-monitor}"
ALERT_TO="${PEER_MONITOR_TO:-adam@xl.net}"
ALERT_FROM="${PEER_MONITOR_FROM:-Site Watchdog <alerts@ai.xl.net>}"
# name|url pairs; a peer is healthy when the URL returns HTTP 200 within 15s.
PEERS="${PEER_MONITOR_PEERS:-itsupportchicago.net|https://itsupportchicago.net/api/health}"

FAIL_THRESHOLD=3
THROTTLE_SEC=$((6 * 3600))

RESEND_API_KEY=$(grep -m1 '^RESEND_API_KEY=' "$ENV_FILE" | cut -d= -f2-)
mkdir -p "$STATE_DIR"

send_alert() { # subject body
  [ -n "$RESEND_API_KEY" ] || { echo "$(date -Is) no RESEND_API_KEY; cannot alert"; return 1; }
  curl -sS -m 20 https://api.resend.com/emails \
    -H "Authorization: Bearer $RESEND_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$(printf '{"from":"%s","to":"%s","subject":"%s","text":"%s"}' \
          "$ALERT_FROM" "$ALERT_TO" "$1" "$2")" >/dev/null || true
}

for peer in $PEERS; do
  name="${peer%%|*}"; url="${peer#*|}"
  fails_f="$STATE_DIR/$name.fails"; alerted_f="$STATE_DIR/$name.alerted"
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 15 "$url" || echo 000)

  if [ "$code" = "200" ]; then
    if [ -f "$alerted_f" ]; then
      send_alert "[$SITE_NAME peer-monitor] RECOVERED: $name" \
        "$name ($url) is answering 200 again as of $(date -Is), observed from $SITE_NAME."
      rm -f "$alerted_f"
    fi
    rm -f "$fails_f"
    continue
  fi

  fails=$(( $(cat "$fails_f" 2>/dev/null || echo 0) + 1 ))
  echo "$fails" > "$fails_f"
  echo "$(date -Is) $name check failed (HTTP $code, consecutive $fails)"
  if [ "$fails" -ge "$FAIL_THRESHOLD" ]; then
    last=$(cat "$alerted_f" 2>/dev/null || echo 0)
    now=$(date +%s)
    if [ $((now - last)) -ge "$THROTTLE_SEC" ]; then
      send_alert "[$SITE_NAME peer-monitor] DOWN: $name (HTTP $code)" \
        "$name ($url) has failed $fails consecutive checks (latest HTTP $code) as of $(date -Is), observed from $SITE_NAME. The site's own watchdog cannot report a dead VM or severed tunnel — check the hosting console."
      echo "$now" > "$alerted_f"
    fi
  fi
done
