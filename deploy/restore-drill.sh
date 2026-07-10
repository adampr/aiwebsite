#!/usr/bin/env bash
# aicompany-template: restore-drill.sh.tpl@4de27d5106fd7c96981cc39320ed03e64c6915793823045ce332b2064131c56a
# Automated backup restore drill (§9.4): prove latest.sql.gz actually restores.
# Installed as the aiwebsite-restore-drill systemd timer (quarterly). Restores
# the latest bucket backup into a scratch database, sanity-checks row counts,
# drops the scratch DB, and emails the result either way. A backup that cannot
# be restored is not a backup.
set -uo pipefail

bucket=""
scratch_db="aiwebsite_restore_drill"
workdir="/var/backups/aiwebsite"
env_file="/var/www/aiwebsite/.env"

notify() { # subject-after-prefix body
  local key
  key=$(grep -E '^RESEND_API_KEY=' "$env_file" 2>/dev/null | head -1 | cut -d'=' -f2- | tr -d '"' | tr -d "'")
  [ -z "$key" ] && return 0
  curl -s -X POST https://api.resend.com/emails \
    -H "Authorization: Bearer $key" \
    -H "Content-Type: application/json" \
    -d "{\"from\":\"ai.xl.net Watchdog <noreply@ai.xl.net>\",\"to\":\"adam@xl.net\",\"subject\":\"[aiwebsite] $1\",\"text\":\"$2\"}" >/dev/null || true
}

fail() {
  echo "[restore-drill] FAIL: $1"
  notify "CRITICAL Backup restore drill FAILED" \
    "$1 -- on $(hostname) at $(date -Is). Investigate before assuming backups are usable."
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
    az storage blob download --auth-mode login --account-name "$az_account" --container-name "$az_container" \
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
