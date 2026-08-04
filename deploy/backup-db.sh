#!/usr/bin/env bash
# aicompany-template: backup-db.sh.tpl@6f7e689c905e67baa8b00c41f188c992fd1bc2867eea645e948d1cc17a951648
# Nightly pg_dump to a cloud bucket with failure alerting and a success
# heartbeat (§9.4, from host B's hardened version). Failures email
# adam@xl.net via Resend; success stamps /var/lib/aiwebsite/last-backup-ok,
# which the watchdog checks for freshness (alerts if > 26h old).
# Installed as the aiwebsite-backup systemd timer (root).
#
# BACKUP_BUCKET forms: gs://bucket[/prefix] (GCS, needs gsutil + a service
# account) or azblob://account/container (Azure Blob, needs az login/identity).
set -euo pipefail

bucket="azblob://xlaiwebbackups/backups"
timestamp=$(date +%Y%m%d_%H%M%S)
filename="aiwebsite_$timestamp.sql.gz"
workdir="/var/backups/aiwebsite"
state_dir="/var/lib/aiwebsite"
heartbeat_file="$state_dir/last-backup-ok"
env_file="/var/www/aiwebsite/.env"
min_bytes=100000     # a healthy compressed dump is well over 100 KB
min_free_kb=512000   # refuse to dump with < 500 MB free
retention_days=30

# ── Issue ledger hook (§5.15 v1.30) — spool-first, strictly best-effort ──
# Mirrors every alert email into the per-host reported_issues table via the
# watchdog's drain. jq-only JSON (correct escaping by construction); every
# expansion ${n:-}-defaulted (set -u safe); every failure path absorbed
# (set -e safe); 1MB per-emitter cap. NEVER blocks or fails the alert path.
# This function must stay BYTE-IDENTICAL across every template that carries
# it (templates.test.ts pins that); per-template identity is $issue_source.
issue_source="backup"
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

alert() { # subject-after-prefix body — returns 0 iff the mail actually went out
  local key
  key=$(grep -E '^RESEND_API_KEY=' "$env_file" 2>/dev/null | head -1 | cut -d'=' -f2- | tr -d '"' | tr -d "'")
  [ -z "$key" ] && return 1
  curl -s -X POST https://api.resend.com/emails \
    -H "Authorization: Bearer $key" \
    -H "Content-Type: application/json" \
    -d "{\"from\":\"ai.xl.net Watchdog <noreply@ai.xl.net>\",\"to\":\"adam@xl.net\",\"subject\":\"[aiwebsite] $1\",\"text\":\"$2\"}" >/dev/null || return 1
  return 0
}

on_error() {
  # Mail FIRST (alerting is primary), then mirror the outcome into the ledger.
  local body emailed=0
  body="backup-db.sh failed at line $1 on $(hostname) at $(date -Is). Check /var/log/aiwebsite-backup.log. The last-known-good backup heartbeat is NOT updated until a backup succeeds."
  alert "CRITICAL Database backup FAILED" "$body" && emailed=1
  record_issue "CRITICAL Database backup FAILED" "$body" "backup-failed" "$emailed"
  return 0
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
    # KEY auth, not `--auth-mode login` (v1.66.0). Azure AD auth needs the VM to
    # hold a Storage Blob Data Contributor role assignment, and granting that
    # requires permissions above Contributor — i.e. a human in a portal, per
    # host, to arm a default-on invariant. This fleet has no managed identity on
    # any VM and no human in the loop, so AD auth meant backups stayed OFF.
    #
    # THE KEY IS READ AT RUNTIME FROM .env, NOT RENDERED. deploy/site-deploy.env
    # is GIT-TRACKED (so is the rendered backup-db.sh), so making the key a
    # render placeholder would COMMIT THE SECRET — render.mjs enforces this and
    # will reject the template if anyone tries. Same grep idiom as RESEND_API_KEY
    # above; .env is pushed separately by deploy.sh and is 0600 on the VM.
    az_key=$(grep -E '^AZURE_STORAGE_KEY=' "$env_file" 2>/dev/null | head -1 | cut -d'=' -f2- | tr -d '"' | tr -d "'")
    # Fail BEFORE pg_dump. With an empty --account-key, `--auth-mode key` falls
    # back to an ARM key lookup and you get a multi-minute retry storm after
    # having already spent the dump, instead of one clear error.
    if [ -z "$az_key" ]; then
      echo "AZURE_STORAGE_KEY is not set in $env_file — cannot upload to $bucket"
      false
    fi
    bucket_put()   { az storage blob upload --auth-mode key --account-key "$az_key" --account-name "$az_account" --container-name "$az_container" --overwrite --file "$1" --name "$2" >/dev/null; }
    bucket_sweep() {
      local cutoff
      cutoff=$(date -d "$retention_days days ago" +%Y%m%d)
      az storage blob list --auth-mode key --account-key "$az_key" --account-name "$az_account" --container-name "$az_container" --query '[].name' -o tsv | while read -r name; do
        local file_date
        file_date=$(basename "$name" | grep -oP '\d{8}' || true)
        if [ -n "$file_date" ] && [ "$file_date" -lt "$cutoff" ]; then
          az storage blob delete --auth-mode key --account-key "$az_key" --account-name "$az_account" --container-name "$az_container" --name "$name" >/dev/null
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
