#!/usr/bin/env bash
# aicompany-template: backup-db.sh.tpl@d1cfed40186c46aa3114d89e3b9b001584a6b4c6a2566fb9260a89d4075b2252
# Nightly pg_dump to a cloud bucket with failure alerting and a success
# heartbeat (§9.4, from host B's hardened version). Failures email
# adam@xl.net via Resend; success stamps /var/lib/aiwebsite/last-backup-ok,
# which the watchdog checks for freshness (alerts if > 26h old).
# Installed as the aiwebsite-backup systemd timer (root).
#
# BACKUP_BUCKET forms: gs://bucket[/prefix] (GCS, needs gsutil + a service
# account) or azblob://account/container (Azure Blob, needs az login/identity).
set -euo pipefail

bucket=""
timestamp=$(date +%Y%m%d_%H%M%S)
filename="aiwebsite_$timestamp.sql.gz"
workdir="/var/backups/aiwebsite"
state_dir="/var/lib/aiwebsite"
heartbeat_file="$state_dir/last-backup-ok"
env_file="/var/www/aiwebsite/.env"
min_bytes=100000     # a healthy compressed dump is well over 100 KB
min_free_kb=512000   # refuse to dump with < 500 MB free
retention_days=30

alert() { # subject-after-prefix body
  local key
  key=$(grep -E '^RESEND_API_KEY=' "$env_file" 2>/dev/null | head -1 | cut -d'=' -f2- | tr -d '"' | tr -d "'")
  [ -z "$key" ] && return 0
  curl -s -X POST https://api.resend.com/emails \
    -H "Authorization: Bearer $key" \
    -H "Content-Type: application/json" \
    -d "{\"from\":\"ai.xl.net Watchdog <noreply@ai.xl.net>\",\"to\":\"adam@xl.net\",\"subject\":\"[aiwebsite] $1\",\"text\":\"$2\"}" >/dev/null || true
}

on_error() {
  alert "CRITICAL Database backup FAILED" \
    "backup-db.sh failed at line $1 on $(hostname) at $(date -Is). Check /var/log/aiwebsite-backup.log. The last-known-good backup heartbeat is NOT updated until a backup succeeds."
}
trap 'on_error $LINENO' ERR

# ── Bucket transport (GCS or Azure Blob) ─────────────────────────
case "$bucket" in
  gs://*)
    bucket_put()    { gsutil cp "$1" "$bucket/$2"; }
    bucket_sweep()  {
      local cutoff
      cutoff=$(date -d "$retention_days days ago" +%Y%m%d)
      gsutil ls "$bucket/" | while read -r file; do
        local file_date
        file_date=$(basename "$file" | grep -oP '\d{8}' || true)
        if [ -n "$file_date" ] && [ "$file_date" -lt "$cutoff" ]; then
          gsutil rm "$file"
        fi
      done
    }
    ;;
  azblob://*)
    az_account="$(echo "$bucket" | cut -d/ -f3)"
    az_container="$(echo "$bucket" | cut -d/ -f4)"
    bucket_put()   { az storage blob upload --auth-mode login --account-name "$az_account" --container-name "$az_container" --overwrite --file "$1" --name "$2" >/dev/null; }
    bucket_sweep() {
      local cutoff
      cutoff=$(date -d "$retention_days days ago" +%Y%m%d)
      az storage blob list --auth-mode login --account-name "$az_account" --container-name "$az_container" --query '[].name' -o tsv | while read -r name; do
        local file_date
        file_date=$(basename "$name" | grep -oP '\d{8}' || true)
        if [ -n "$file_date" ] && [ "$file_date" -lt "$cutoff" ]; then
          az storage blob delete --auth-mode login --account-name "$az_account" --container-name "$az_container" --name "$name" >/dev/null
        fi
      done
    }
    ;;
  *)
    echo "Unsupported BACKUP_BUCKET '$bucket' (expected gs://... or azblob://account/container)"
    false
    ;;
esac

mkdir -p "$workdir" "$state_dir"
tmpfile="$workdir/$filename"

# A full disk corrupts the dump exactly when a good backup matters most.
free_kb=$(df --output=avail "$workdir" | tail -1)
if [ "$free_kb" -lt "$min_free_kb" ]; then
  echo "Insufficient disk space for backup ($free_kb KB free, need $min_free_kb)"
  false
fi

sudo -u postgres pg_dump "aiwebsite" | gzip > "$tmpfile"

# Truncated/empty dumps must not silently overwrite latest.sql.gz.
bytes=$(stat -c%s "$tmpfile")
if [ "$bytes" -lt "$min_bytes" ]; then
  echo "Dump suspiciously small ($bytes bytes, threshold $min_bytes)"
  rm -f "$tmpfile"
  false
fi

bucket_put "$tmpfile" "$filename"
bucket_put "$tmpfile" "latest.sql.gz"
rm "$tmpfile"

bucket_sweep

date +%s > "$heartbeat_file"
echo "Backup completed: $filename ($bytes bytes)"
