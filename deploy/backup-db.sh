#!/usr/bin/env bash
# aicompany-template: backup-db.sh.tpl@b7d3ba526027ded44d8fef06f5ca89c07248ddcc401164396e7f4dae0462920c
# Nightly pg_dump to a cloud bucket with failure alerting and a success
# heartbeat (§9.4, from host B's hardened version). Failures email
# adam@xl.net via Resend; success stamps /var/lib/aiwebsite/last-backup-ok,
# which the watchdog checks for freshness (alerts if > 26h old).
# Installed as the aiwebsite-backup systemd timer (root).
#
# TWO artifacts land in the bucket each night:
#   1. aiwebsite_<ts>.sql.gz  + latest.sql.gz            (Postgres)
#   2. aiwebsite-work-archives_<ts>.tar.gz
#      + latest-work-archives.tar.gz                     (the §5.16 on-disk
#      work archive store, which no other backup covered and which deploy
#      rsync excludes. See the block at the bottom of this file)
#
# THE TWO ARE NOT INDEPENDENT, AND THE ASYMMETRY IS ONE-WAY. The store block
# runs at the END of this script, so it is strictly downstream of the dump
# half: any dump-half failure (a missing AZURE_STORAGE_KEY, a full disk, a
# failed pg_dump, a failed upload) kills the script under errexit BEFORE the
# store is ever packaged. A store failure alerts on its own and leaves the
# dump alone; a dump failure takes the store down with it silently, so
# on_error below says so in the mail rather than naming only the database.
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

# ── One run at a time ────────────────────────────────────────────
# The archive block sweeps leftover `aiwebsite-work-archives_*.tar.gz` from
# $workdir before it measures free space, and that glob matches EVERY run's
# tarball, not just this one. Two overlapping executions (the 07:15 timer plus
# an operator running the job by hand, or a slow run meeting the next fire)
# therefore delete each other's in-flight artifact, and the victim raises a
# CRITICAL saying the store is unprotected when the other run has in fact just
# backed it up correctly. A same-second pair additionally shares $timestamp,
# so they share the local temp path and the blob names. flock makes the whole
# script single-instance; a second run exits 0 quietly rather than alerting.
# The lock is held on a FILE DESCRIPTOR in this very process, not by
# re-exec'ing through `flock <file> <cmd>`: that form makes flock exec $0
# directly, which fails with "Permission denied" whenever the script is
# invoked as `bash deploy/backup-db.sh` on a non-executable checkout copy
# (measured). fd 9 costs nothing, needs no argument round-trip, and the
# kernel drops the lock on exit however the script ends.
lock_file="$state_dir/backup-db.lock"
if command -v flock >/dev/null 2>&1; then
  mkdir -p "$state_dir" 2>/dev/null || true
  # Probe writability with a plain redirect FIRST. `exec 9>file` cannot be
  # tested with `if`: a failed exec redirection kills a non-interactive shell,
  # and `exec 9>file 2>/dev/null` would silence this script's stderr for the
  # REST OF THE RUN, because a bare `exec` applies its redirections to the
  # current shell permanently (measured: it swallowed the whole log).
  if : >>"$lock_file" 2>/dev/null; then
    exec 9>>"$lock_file"
    if ! flock -n 9; then
      echo "backup-db.sh: another run already holds $lock_file -- exiting without doing anything."
      exit 0
    fi
  fi
fi

# §5.16 work archive store (second artifact; the block at the bottom).
# The store root follows WORK_ARCHIVE_DIR in .env when that is set (the same
# literal grep the credentials use below), else this default, so moving the
# store does not silently leave the backup packaging an empty directory.
archive_dir_default="/var/www/aiwebsite/data/work-archives"
# Both names carry EXACTLY ONE run of 8 digits (the date), because
# bucket_sweep extracts the retention date with `grep -oP '\d{8}'` and a
# second match would make its `-lt` comparison a multi-word argument. The
# `latest` copy has no digits at all, so the sweep leaves it alone -- same
# contract as latest.sql.gz.
archive_filename="aiwebsite-work-archives_$timestamp.tar.gz"
archive_latest="latest-work-archives.tar.gz"
archive_stamp_file="$state_dir/last-archive-backup-ok"
# Ceiling on the store this script will package. It is not a disk guard (the
# free-space arithmetic below is); it is the "something is wrong, tell a
# human" line. The store was 7.7 MB across 87 submissions on 2026-08-29 and
# a single upload is capped at 100 MB, so 2 GiB is ~260x the real store and
# cannot be reached by ordinary intake. Raise it deliberately, after looking
# at the disk and the bucket -- never to silence a nightly alert.
# WORK_ARCHIVE_BACKUP_MAX_KB in .env overrides it (same literal grep the
# credentials use). Read from the environment rather than hand-edited here,
# because this file is RENDERED: an edit to the constant is reverted by the
# next render.mjs run, and telling an operator to edit a rendered file is
# telling them to make a change that disappears.
# `{ grep || true; }`, not a bare grep: this runs at TOP LEVEL under
# `set -euo pipefail`, where a grep that simply finds nothing returns 1,
# pipefail promotes it, and errexit kills the script at an assignment. The
# credential greps below survive only because the deployed .env always has
# those lines; this one is expected to be absent almost always.
archive_max_kb=$({ grep -E '^WORK_ARCHIVE_BACKUP_MAX_KB=' "$env_file" 2>/dev/null || true; } | head -1 | cut -d'=' -f2- | tr -d '"' | tr -d "'")
case "$archive_max_kb" in ''|*[!0-9]*) archive_max_kb=2097152 ;; esac
archive_max_bytes=$((archive_max_kb * 1024))

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
    -d "{\"from\":\"ai.xl.net Watchdog <noreply@ai.xl.net>\",\"to\":\"adam@xl.net\",\"subject\":\"[aiwebsite] $1\",\"text\":\"$2\",\"headers\":{\"Auto-Submitted\":\"auto-generated\",\"X-Auto-Response-Suppress\":\"All\"}}" >/dev/null || return 1
  return 0
}

on_error() {
  # Mail FIRST (alerting is primary), then mirror the outcome into the ledger.
  local body emailed=0
  body="backup-db.sh failed at line $1 on $(hostname) at $(date -Is). Check /var/log/aiwebsite-backup.log. The last-known-good backup heartbeat is NOT updated until a backup succeeds. THE §5.16 WORK ARCHIVE STORE WAS NOT BACKED UP ON THIS RUN EITHER: its block runs at the end of this script, so it never executed and it raises no separate alert. Treat both artifacts as missing for tonight."
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

# ── §5.16 work archive store ─────────────────────────────────────
# Everything above backs up Postgres. It does NOT back up the on-disk work
# archive store (ARCHITECTURE.md §5.16, src/lib/work/archive-store.ts).
# That store is the LAST copy of a team member's submitted work: once a
# published submission's retention email has gone out and
# verifyAndClearRowBytes has cleared the row's archive_data/md_data, the
# file under data/work-archives is the only copy anywhere. deploy.sh
# excludes /data/ from its rsync (which is exactly what makes the store
# survive deploys), so before this block the store lived on one VM disk,
# in no backup, and a disk loss destroyed it.
#
# It ships as its OWN artifact beside the SQL dump: same bucket, same
# bucket_put, same credentials resolved in the same place, so there is one
# credential to keep working and one listing to look at.
#
# The dump half above is deliberately untouched, including WHERE the
# heartbeat is stamped. /var/lib/aiwebsite/last-backup-ok means "the
# DATABASE dump succeeded": the watchdog's 26h freshness check and the
# quarterly restore drill both reason about the dump, and letting a store
# hiccup withhold that stamp would raise "backups are dead" about a
# database whose backup is sitting in the bucket. The store gets its own
# stamp (last-archive-backup-ok), its own CRITICAL mail, its own ledger key
# and its own non-zero exit instead, so a failed store backup is exactly as
# loud as a failed dump and says which half failed.

archive_alert() { # 1=reason. CRITICAL mail + ledger mirror; never throws.
  local body emailed=0
  body="backup-db.sh could not back up the work archive store on $(hostname) at $(date -Is): $1. The nightly pg_dump SUCCEEDED and is unaffected -- only the on-disk §5.16 store is unprotected. Check /var/log/aiwebsite-backup.log. This is CRITICAL because a published submission whose row bytea has been cleared has its ONLY remaining copy in that store."
  # `if alert` rather than on_error's `alert ... && emailed=1` idiom: that
  # one runs inside the ERR trap, this one runs with errexit LIVE, and on a
  # host with no RESEND_API_KEY the && form returns 1 and would kill the
  # script here -- before record_issue and before the exit below.
  if alert "CRITICAL Work archive store backup FAILED" "$body"; then emailed=1; fi
  record_issue "CRITICAL Work archive store backup FAILED" "$body" "archive-store-backup-failed" "$emailed"
  return 0
}

# Returns 0 on success OR on a legitimate skip, 1 with $archive_fail_reason
# set on failure. Called from an `if`, so bash suppresses errexit and the
# ERR trap for everything inside it; every step therefore checks itself
# explicitly. That is the point: it is what lets a store failure raise its
# own named alert instead of the dump's generic "Database backup FAILED".
archive_fail_reason=""
archive_store_backup() {
  local dir="" parent="" base="" store_kb="" free_now_kb="" need_kb=0
  local tar_status=0 archive_bytes=0 entries=0 stamp_seen=0
  local prev_entries=0 prev_store_kb=0

  dir=$(grep -E '^WORK_ARCHIVE_DIR=' "$env_file" 2>/dev/null | head -1 | cut -d'=' -f2- | tr -d '"' | tr -d "'")
  [ -n "$dir" ] || dir="$archive_dir_default"
  local archive_tmp="$workdir/$archive_filename"

  # The stamp is both "a good backup has happened here" AND the size of that
  # backup, so this run can tell a shrinking store from a steady one.
  if [ -f "$archive_stamp_file" ]; then
    stamp_seen=1
    prev_entries=$(sed -n 's/^entries=\([0-9]\{1,\}\)$/\1/p' "$archive_stamp_file" 2>/dev/null | head -1)
    prev_store_kb=$(sed -n 's/^store_kb=\([0-9]\{1,\}\)$/\1/p' "$archive_stamp_file" 2>/dev/null | head -1)
    case "$prev_entries" in ''|*[!0-9]*) prev_entries=0 ;; esac
    case "$prev_store_kb" in ''|*[!0-9]*) prev_store_kb=0 ;; esac
  fi

  # Absent or empty is NOT a failure on a fresh host -- no submission has
  # ever been accepted there. It IS a failure once we have successfully
  # backed a non-empty store up before, because then files that existed
  # have gone: that is the disaster this artifact exists to survive, and it
  # must not be reported as "nothing to do". Ignore in-flight writes, using
  # archive-store.ts's OWN orphan pattern and not a looser glob: it sweeps
  # /\.tmp-\d+-\d+$/, while `*.tmp-*` also matches ordinary submitter
  # filenames -- sanitizeStoredName (src/lib/work/archive-naming.ts) keeps '.'
  # and '-' verbatim, so a package literally called `build.tmp-1.zip` is
  # stored as `<uuid>/00-build.tmp-1.zip`. Under the loose glob that real,
  # ledgered file was silently dropped from the tarball, and a store whose
  # files all carried such names read here as "empty" and was reported as a
  # fresh host. Measured 2026-08-29: `*.tmp-*` kept 1 of 4 real files,
  # `*.tmp-[0-9]*-[0-9]*` keeps 4 of 4 and still excludes a genuine orphan.
  if [ ! -d "$dir" ] || [ -z "$(find "$dir" -type f ! -name '*.tmp-[0-9]*-[0-9]*' -print -quit 2>/dev/null)" ]; then
    if [ "$stamp_seen" -eq 1 ]; then
      archive_fail_reason="$dir holds no archive files, but $archive_stamp_file records an earlier SUCCESSFUL store backup, so files that existed are gone. Restore from $bucket/$archive_latest before anything else. If instead an operator deliberately emptied the whole store, delete $archive_stamp_file to acknowledge it and this alert stops."
      return 1
    fi
    local fresh_msg="Archive store: $dir is absent or empty and has never been backed up -- nothing to do (fresh host) on $(hostname) at $(date -Is). Recorded rather than merely echoed because NOTHING reads $archive_stamp_file for freshness (watchdog.sh checks only the DATABASE heartbeat, §9.6), so this branch is the one way the store backup can go on not happening with nobody told."
    echo "$fresh_msg"
    record_issue "WARN Work archive store not backed up (nothing to back up)" "$fresh_msg" "archive-store-backup-skipped" "0"
    return 0
  fi

  # A run that died between tar and upload leaves a (possibly large)
  # tarball behind. Ours is timestamped, so anything matching here is from
  # an earlier run; clear it BEFORE measuring free space so the reclaimed
  # space counts. This is also what keeps a second run in the same minute
  # safe: it rewrites its own file rather than accumulating.
  find "$workdir" -maxdepth 1 -type f -name 'aiwebsite-work-archives_*.tar.gz' \
    ! -name "$archive_filename" -delete 2>/dev/null || true

  if ! store_kb=$(du -sk "$dir" 2>/dev/null | cut -f1); then
    archive_fail_reason="could not measure $dir (du failed)"
    return 1
  fi
  case "$store_kb" in ''|*[!0-9]*)
    archive_fail_reason="du returned a non-numeric size for $dir: '$store_kb'"
    return 1 ;;
  esac
  if [ "$store_kb" -gt "$archive_max_kb" ]; then
    archive_fail_reason="the store is $store_kb KB, over the $archive_max_kb KB ceiling this script packages. NOTHING was uploaded and the last good store backup in the bucket is untouched. Run the §5.16 admin cleanup console, or raise the ceiling deliberately after checking disk and bucket headroom by setting WORK_ARCHIVE_BACKUP_MAX_KB in /var/www/aiwebsite/.env -- NOT by editing this file, which is template-rendered and reverts on the next render."
    return 1
  fi

  # A full disk corrupts the tarball exactly when a good backup matters
  # most -- the dump half's reasoning, with the store's size in it, because
  # the store can be far larger than a dump and grows with every upload.
  free_now_kb=$(df --output=avail "$workdir" 2>/dev/null | tail -1)
  case "$free_now_kb" in ''|*[!0-9]*)
    archive_fail_reason="could not read free space on $workdir (df returned '$free_now_kb')"
    return 1 ;;
  esac
  need_kb=$((store_kb + min_free_kb))
  if [ "$free_now_kb" -lt "$need_kb" ]; then
    archive_fail_reason="insufficient disk for the store tarball ($free_now_kb KB free on $workdir, need $need_kb KB = store $store_kb KB + the $min_free_kb KB margin)"
    return 1
  fi

  # -C parent basename, so the tar carries `work-archives/<id>/<NN>-<name>`
  # and unpacks into a named directory instead of scattering submission
  # dirs into whatever cwd the operator restored from. The single top-level
  # entry is the BASENAME of the store root as configured when the artifact
  # was taken (`work-archives` on the default path), which is why the
  # completion line below prints it: a restore untars into the store root's
  # PARENT, and an operator holding an old artifact should not have to guess.
  parent=$(dirname "$dir")
  base=$(basename "$dir")
  # Same narrow pattern as the emptiness probe above, for the same reason: a
  # broad `*.tmp-*` exclusion drops real submitter-named files out of the
  # artifact with no signal at all. Dropping the exclusion entirely would also
  # be safe (orphans are tiny and archive-store.ts sweeps them itself).
  tar --exclude='*.tmp-[0-9]*-[0-9]*' -czf "$archive_tmp" -C "$parent" "$base" || tar_status=$?
  if [ "$tar_status" -gt 1 ]; then
    rm -f "$archive_tmp"
    archive_fail_reason="tar exited $tar_status packaging $dir"
    return 1
  fi
  if [ "$tar_status" -eq 1 ]; then
    # GNU tar's warning class: a file changed or vanished while being read.
    # Expected against live intake and admin cleanup, and harmless here
    # because archive-store.ts writes temp-then-rename (a ledgered path
    # never holds partial bytes). The read-back below is the real gate.
    echo "Archive store: tar reported changed/vanished files during packaging (exit 1) -- verifying the artifact."
  fi

  if ! archive_bytes=$(stat -c%s "$archive_tmp" 2>/dev/null); then
    rm -f "$archive_tmp"
    archive_fail_reason="the store tarball was not created at $archive_tmp"
    return 1
  fi
  if [ "$archive_bytes" -gt "$archive_max_bytes" ]; then
    rm -f "$archive_tmp"
    archive_fail_reason="the store tarball is $archive_bytes bytes, over the $archive_max_bytes byte ceiling; nothing was uploaded"
    return 1
  fi
  # Read the whole artifact back before it is allowed to overwrite
  # $archive_latest. This is the tar analogue of the dump's min_bytes
  # floor, and it is strictly stronger: `tar -tzf` validates the gzip CRC
  # and the tar structure end to end, so a truncated archive cannot become
  # the copy an operator restores from.
  if ! entries=$(tar -tzf "$archive_tmp" | wc -l); then
    rm -f "$archive_tmp"
    archive_fail_reason="the store tarball does not read back (tar -tzf failed); $archive_latest was NOT overwritten"
    return 1
  fi
  if [ "$entries" -lt 1 ]; then
    rm -f "$archive_tmp"
    archive_fail_reason="the store tarball lists no entries although $dir is not empty"
    return 1
  fi

  if ! bucket_put "$archive_tmp" "$archive_filename"; then
    rm -f "$archive_tmp"
    archive_fail_reason="upload of $archive_filename to $bucket failed"
    return 1
  fi
  # ── Partial-loss guard, between the dated upload and `latest` ─────
  # The emptiness check at the top of this function is all-or-nothing: it
  # fires only when the store is COMPLETELY empty. A PARTIAL loss (a bad rm, a
  # bug in admin cleanup, a half-failed filesystem) used to pass every guard
  # and overwrite $archive_latest with the damaged store at exit 0 with no
  # alert -- and $archive_latest is exactly the blob the §9.7 restore runbook
  # tells an operator to download, so the 3am restore handed back the damage.
  # Measured 2026-08-29: 7 files became 1, a 99.8% collapse, in complete
  # silence. The dated blob has already uploaded above, so tonight's state is
  # never lost; what this refuses is letting a collapse become the POINTER.
  # `latest` keeps last night's copy and the run alerts instead.
  if [ "$prev_entries" -gt 0 ] && [ $((entries * 2)) -lt "$prev_entries" ]; then
    rm -f "$archive_tmp"
    archive_fail_reason="the store collapsed from $prev_entries tar entries to $entries since the last successful backup (more than half of it is gone). $archive_filename DID upload, so tonight's state is in the bucket under that dated name, but $archive_latest was deliberately NOT overwritten and still holds the last good copy -- restore from that. If an operator deliberately emptied most of the store, delete $archive_stamp_file to acknowledge it and the next run proceeds."
    return 1
  fi
  if [ "$prev_store_kb" -gt 0 ] && [ $((store_kb * 2)) -lt "$prev_store_kb" ]; then
    rm -f "$archive_tmp"
    archive_fail_reason="the store shrank from $prev_store_kb KB to $store_kb KB since the last successful backup (more than half of it is gone). $archive_filename DID upload, so tonight's state is in the bucket under that dated name, but $archive_latest was deliberately NOT overwritten and still holds the last good copy -- restore from that. If an operator deliberately deleted most of the store, delete $archive_stamp_file to acknowledge it and the next run proceeds."
    return 1
  fi

  # Timestamped copy first, `latest` second: if the second upload fails the
  # night's store is still IN the bucket under its dated name, and the
  # reason below says so rather than implying nothing was saved.
  if ! bucket_put "$archive_tmp" "$archive_latest"; then
    rm -f "$archive_tmp"
    archive_fail_reason="upload of $archive_latest to $bucket failed -- the dated $archive_filename DID upload, so tonight's store is in the bucket under that name"
    return 1
  fi
  rm -f "$archive_tmp"

  # Epoch on line 1 so a future freshness check can `head -1` it exactly like
  # last-backup-ok; the size lines below are what the partial-loss guard above
  # compares the next run against.
  printf '%s\nentries=%s\nstore_kb=%s\n' "$(date +%s)" "$entries" "$store_kb" \
    > "$archive_stamp_file" 2>/dev/null || echo "NOTE: could not write $archive_stamp_file"
  echo "Archive store backup completed: $archive_filename ($archive_bytes bytes, $entries entries, store $store_kb KB, unpacks as $base/ into $parent) + $archive_latest"
  return 0
}

if ! archive_store_backup; then
  archive_alert "$archive_fail_reason"
  exit 1
fi
