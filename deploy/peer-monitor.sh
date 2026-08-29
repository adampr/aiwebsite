#!/usr/bin/env bash
# aicompany-template: peer-monitor.sh.tpl@6aedc126e6831204e6860986f6af38ad16b882ec2d958730a00aabb3d45fef13
# Cross-site peer monitor (@aicompany/core template, §9.7 v1.15). The
# self-hosted watchdog can't report a dead VM or severed tunnel, so sibling
# sites watch each other across hosting providers — FULL MESH is normative
# since v1.15.0 (single-watcher chains left "did an alert even fire?"
# unanswerable in the 2026-07-22 outage forensics). Runs every 5 min from the
# aiwebsite-peer-monitor.timer that setup-vm.sh now installs (template-managed
# since v1.15.0; formerly a manual runbook step). Alerts via Resend using
# this site's own .env; 3 consecutive failures trip an alert, throttled to
# one per 6h per peer while down, plus a one-time recovery notice. Every
# send attempt is LOGGED — success included (the 07-22 DOWN mail HAD fired
# at 14:50Z, but the silent send path burned an hour proving it).
#
# SMS escalation (v1.15.0, optional): when PEER_MONITOR_SMS_TO (E.164) is
# set, a peer down >=15 min (fails >= 3 AND fails*check_period >= 900s) also
# triggers a Twilio SMS using the host .env's TWILIO_* credentials —
# best-effort, same 6h throttle in a .sms-suffixed state file. This is an
# ATTENTION-layer fix, not detection: the 07-22 DOWN email was DELIVERED at
# 14:50Z and sat unread for an hour.
#
# Geo gate (v1.110.0, §5.2/§9.7): outbound SMS is US/Canada ONLY — Twilio's
# account-level Geo Permissions were opened account-wide for an unrelated
# consumer, so this second direct sender re-checks the rule itself.
# render.mjs already refuses a non-US/CA PEER_MONITOR_SMS_TO at render time,
# but PEER_MONITOR_SMS_TO_OVERRIDE never passes through render, so send_sms
# validates the target at send time too: full NANP shape, then the non-US/CA
# territory NPA denylist (mirrors NON_US_CA_NANP_NPAS in src/lib/phone.ts;
# sync-pinned by tests/templates.test.ts). Malformed target => refused
# (fail-safe). Log lines carry at most "+1"+NPA, never the full number.
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
peers="${PEER_MONITOR_PEERS_OVERRIDE:-itsupportchicago.net|https://itsupportchicago.net/api/health roleplay.xl.net|https://roleplay.xl.net/api/health}"
# Optional E.164 SMS escalation target (render key PEER_MONITOR_SMS_TO — may
# be absent/empty in site-deploy.env, which disables the SMS path entirely).
sms_to="${PEER_MONITOR_SMS_TO_OVERRIDE:-}"

fail_threshold=3
check_period=300              # systemd timer cadence (5 min) — down-time math
sms_after_seconds=900         # SMS at >=15 min down (fails*check_period >= this)
throttle_sec=$((6 * 3600))

resend_api_key=$(grep -m1 '^RESEND_API_KEY=' "$env_file" | cut -d= -f2-)
mkdir -p "$state_dir"

# ── Issue ledger hook (§5.15 v1.30) — spool-first, strictly best-effort ──
# Mirrors every alert email into the per-host reported_issues table via the
# watchdog's drain. jq-only JSON (correct escaping by construction); every
# expansion ${n:-}-defaulted (set -u safe); every failure path absorbed
# (set -e safe); 1MB per-emitter cap. NEVER blocks or fails the alert path.
# This function must stay BYTE-IDENTICAL across every template that carries
# it (templates.test.ts pins that); per-template identity is $issue_source.
issue_source="peer-monitor"
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

send_alert() { # subject body — returns 0 iff the mail actually went out
  [ -n "$resend_api_key" ] || { echo "$(date -Is) no RESEND_API_KEY; cannot alert"; return 1; }
  if curl -sS -m 20 https://api.resend.com/emails \
    -H "Authorization: Bearer $resend_api_key" \
    -H "Content-Type: application/json" \
    -d "$(printf '{"from":"%s","to":"%s","subject":"%s","text":"%s","headers":{"Auto-Submitted":"auto-generated","X-Auto-Response-Suppress":"All"}}' \
          "$alert_from" "$alert_to" "$1" "$2")" >/dev/null; then
    # Logged on SUCCESS too (v1.15.0): silent success made the 2026-07-22
    # "did the DOWN alert fire?" question a forensic exercise.
    echo "$(date -Is) alert email SENT: $1"
    return 0
  else
    echo "$(date -Is) alert email send FAILED: $1"
    return 1
  fi
}

send_sms() { # body — best-effort Twilio escalation (attention layer)
  [ -n "$sms_to" ] || return 0
  # §5.2 geo gate (v1.110.0): US/Canada ONLY, enforced HERE because the
  # OVERRIDE env var bypasses render.mjs's validator and Twilio's account
  # no longer backstops geography. Shape first — "+1" + exactly 10 digits,
  # NPA in [2-9]xx — so anything malformed refuses (fail-safe), then the
  # non-US/CA NANP territory denylist (Jamaica/Bahamas/DR/… share "+1";
  # mirrors NON_US_CA_NANP_NPAS in src/lib/phone.ts — update BOTH).
  case "$sms_to" in
    +1[2-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) : ;;
    *)
      echo "$(date -Is) SMS escalation REFUSED: target ${sms_to:0:5}... is not a US/CA number (geo gate, §9.7)"
      return 0 ;;
  esac
  npa=${sms_to:2:3}
  case " 242 246 264 268 284 345 441 473 649 658 664 721 758 767 784 809 829 849 868 869 876 " in
    *" $npa "*)
      echo "$(date -Is) SMS escalation REFUSED: +1$npa is a non-US/CA NANP territory (geo gate, §9.7)"
      return 0 ;;
  esac
  sid=$(grep -m1 '^TWILIO_ACCOUNT_SID=' "$env_file" | cut -d= -f2-)
  tok=$(grep -m1 '^TWILIO_AUTH_TOKEN=' "$env_file" | cut -d= -f2-)
  from=$(grep -m1 '^TWILIO_PHONE_NUMBER=' "$env_file" | cut -d= -f2-)
  if [ -z "$sid" ] || [ -z "$tok" ] || [ -z "$from" ]; then
    echo "$(date -Is) SMS escalation skipped: TWILIO_* credentials not in $env_file"
    return 0
  fi
  curl -sS -m 20 "https://api.twilio.com/2010-04-01/Accounts/$sid/Messages.json" \
    -u "$sid:$tok" \
    --data-urlencode "From=$from" \
    --data-urlencode "To=$sms_to" \
    --data-urlencode "Body=$1" >/dev/null || true
  # Masked (v1.110.0): "+1"+NPA only — log lines never carry a full number.
  echo "$(date -Is) SMS escalation attempted to ${sms_to:0:5}...: $1"
}

for peer in $peers; do
  name="${peer%%|*}"; url="${peer#*|}"
  fails_f="$state_dir/$name.fails"; alerted_f="$state_dir/$name.alerted"
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 15 "$url" || echo 000)

  if [ "$code" = "200" ]; then
    if [ -f "$alerted_f" ]; then
      send_alert "[$site_name peer-monitor] RECOVERED: $name" \
        "$name ($url) is answering 200 again as of $(date -Is), observed from $site_name."
      # §5.15: RECOVERED is a machine recovery signal — close the episode.
      record_issue "WARN peer $name recovered" "$name ($url) answering 200 again" "peer:$name" 0 1 "auto:peer-recovered"
      rm -f "$alerted_f" "$alerted_f.sms"   # re-arm BOTH throttles for the next outage
    fi
    rm -f "$fails_f"
    continue
  fi

  fails=$(( $(cat "$fails_f" 2>/dev/null || echo 0) + 1 ))
  echo "$fails" > "$fails_f"
  echo "$(date -Is) $name check failed (HTTP $code, consecutive $fails)"
  now=$(date +%s)
  if [ "$fails" -ge "$fail_threshold" ]; then
    last=$(cat "$alerted_f" 2>/dev/null || echo 0)
    down_body="$name ($url) has failed $fails consecutive checks (latest HTTP $code) as of $(date -Is), observed from $site_name. The site's own watchdog cannot report a dead VM or severed tunnel — check the hosting console (RUNBOOK: 'VM unreachable')."
    down_emailed=0
    if [ $((now - last)) -ge "$throttle_sec" ]; then
      if send_alert "[$site_name peer-monitor] DOWN: $name (HTTP $code)" "$down_body"; then
        down_emailed=1
      fi
      echo "$now" > "$alerted_f"
    fi
    # §5.15: record on EVERY at-or-over-threshold pass — a throttled but
    # persisting outage bumps count/last_seen with emailed=0. The row lands in
    # the OBSERVER's ledger (the dead peer's own DB is what is unreachable).
    record_issue "CRITICAL peer $name DOWN (HTTP $code)" "$down_body" "peer:$name" "$down_emailed"
    # SMS escalation (v1.15.0): >=15 min down; 6h throttle in the .sms file.
    if [ -n "$sms_to" ] && [ $(( fails * check_period )) -ge "$sms_after_seconds" ]; then
      last_sms=$(cat "$alerted_f.sms" 2>/dev/null || echo 0)
      if [ $((now - last_sms)) -ge "$throttle_sec" ]; then
        send_sms "[$site_name peer-monitor] DOWN >=15min: $name (HTTP $code). Email alert already sent - check the hosting console (RUNBOOK: VM unreachable)."
        echo "$now" > "$alerted_f.sms"
      fi
    fi
  fi
done
