#!/usr/bin/env bash
# aicompany-template: restore-drill.sh.tpl@cf34c1dd3eb05dc17a3ed0a8cd5775b82ca7293855689734c41c863fca8e56d0
# Automated backup restore drill (§9.4): prove latest.sql.gz actually restores.
# Installed as the aiwebsite-restore-drill systemd timer (quarterly). Restores
# the latest bucket backup into a scratch database, sanity-checks row counts,
# drops the scratch DB, and emails the result either way. A backup that cannot
# be restored is not a backup.
set -uo pipefail

bucket="azblob://xlaiwebbackups/backups"
scratch_db="aiwebsite_restore_drill"
workdir="/var/backups/aiwebsite"
env_file="/var/www/aiwebsite/.env"

# ── Issue ledger hook (§5.15 v1.30) — spool-first, strictly best-effort ──
# Mirrors every alert email into the per-host reported_issues table via the
# watchdog's drain. jq-only JSON (correct escaping by construction); every
# expansion ${n:-}-defaulted (set -u safe); every failure path absorbed
# (set -e safe); 1MB per-emitter cap. NEVER blocks or fails the alert path.
# This function must stay BYTE-IDENTICAL across every template that carries
# it (templates.test.ts pins that); per-template identity is $issue_source.
issue_source="restore-drill"
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

notify() { # subject-after-prefix body — returns 0 iff the mail actually went out
  local key
  key=$(grep -E '^RESEND_API_KEY=' "$env_file" 2>/dev/null | head -1 | cut -d'=' -f2- | tr -d '"' | tr -d "'")
  [ -z "$key" ] && return 1
  curl -s -X POST https://api.resend.com/emails \
    -H "Authorization: Bearer $key" \
    -H "Content-Type: application/json" \
    -d "{\"from\":\"ai.xl.net Watchdog <noreply@ai.xl.net>\",\"to\":\"adam@xl.net\",\"subject\":\"[aiwebsite] $1\",\"text\":\"$2\"}" >/dev/null || return 1
  return 0
}

fail() {
  echo "[restore-drill] FAIL: $1"
  local body emailed=0
  body="$1 -- on $(hostname) at $(date -Is). Investigate before assuming backups are usable."
  # Mail FIRST (alerting is primary), then mirror into the ledger, then exit.
  notify "CRITICAL Backup restore drill FAILED" "$body" && emailed=1
  record_issue "CRITICAL Backup restore drill FAILED" "$body" "restore-drill-failed" "$emailed"
  sudo -u postgres dropdb --if-exists "$scratch_db" 2>/dev/null
  rm -f "$dump"
  exit 1
}

mkdir -p "$workdir"
dump="$workdir/restore-drill.sql.gz"

case "$bucket" in
  gs://*)
    gsutil cp "$bucket/latest.sql.gz" "$dump" || fail "Could not download latest.sql.gz from $bucket"
    ;;
  azblob://*)
    az_account="$(echo "$bucket" | cut -d/ -f3)"
    az_container="$(echo "$bucket" | cut -d/ -f4)"
    # Key auth read at runtime from .env — see backup-db.sh for why (v1.66.0).
    # A drill that cannot authenticate must FAIL, not silently pass: this is the
    # only thing that proves the backups are restorable rather than merely written.
    az_key=$(grep -E '^AZURE_STORAGE_KEY=' "$env_file" 2>/dev/null | head -1 | cut -d'=' -f2- | tr -d '"' | tr -d "'")
    [ -z "$az_key" ] && fail "AZURE_STORAGE_KEY is not set in $env_file — cannot download from $bucket"
    az storage blob download --auth-mode key --account-key "$az_key" --account-name "$az_account" --container-name "$az_container" \
      --name latest.sql.gz --file "$dump" >/dev/null || fail "Could not download latest.sql.gz from $bucket"
    ;;
  *)
    fail "Unsupported BACKUP_BUCKET '$bucket' (expected gs://... or azblob://account/container)"
    ;;
esac

sudo -u postgres dropdb --if-exists "$scratch_db" || fail "Could not drop stale scratch DB"
sudo -u postgres createdb "$scratch_db" || fail "Could not create scratch DB"

# psql exits 0 even when individual statements error (e.g. ownership grants),
# so the gate is the sanity queries below, not the restore exit code.
gunzip -c "$dump" | sudo -u postgres psql -q -d "$scratch_db" >/dev/null 2>&1

# Sanity: users must exist (module table), and the persona seed guarantees
# brain_memories rows on any deployed site.
users_count=$(sudo -u postgres psql -tA -d "$scratch_db" -c "SELECT count(*) FROM users;" 2>/dev/null || echo "")
memories_count=$(sudo -u postgres psql -tA -d "$scratch_db" -c "SELECT count(*) FROM brain_memories;" 2>/dev/null || echo "")

if [ -z "$users_count" ]; then
  fail "Restored DB has no users table"
fi
if [ -z "$memories_count" ] || ! [ "$memories_count" -gt 0 ] 2>/dev/null; then
  fail "Restored DB has no brain_memories table or zero rows (got: '$memories_count')"
fi

sudo -u postgres dropdb "$scratch_db"
rm -f "$dump"

echo "[restore-drill] OK: restored latest.sql.gz -- users=$users_count brain_memories=$memories_count"
notify "OK Backup restore drill passed" \
  "latest.sql.gz restored cleanly on $(hostname): users=$users_count, brain_memories=$memories_count. Scratch DB dropped."
