#!/usr/bin/env bash
# aicompany-template: backup-db.sh.tpl@060fe015927203443f1e49fb441544c1f5a8f88c1332219a1cb1bf496fd6159b
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

# ── Second artifact (§9.4 v1.114.0) — inert when extra_name is empty ─────
# The four values come from site-deploy.env and therefore SURVIVE EVERY
# RENDER, which is the entire point of this seam: the host customisation that
# motivated it lived in the rendered file and was deleted twice.
extra_name="work-archives"
extra_dir_default="/var/www/aiwebsite/data/work-archives"
extra_why="A published submission whose row bytea has been cleared has its ONLY remaining copy in that store (ARCHITECTURE.md 5.16)."
extra_filename="aiwebsite-work-archives_$timestamp.tar.gz"
extra_latest="latest-work-archives.tar.gz"
extra_stamp_file="$state_dir/last-work-archives-backup-ok"
# Ceiling in KB. The RENDERED default survives every render; BACKUP_EXTRA_MAX_KB
# in /var/www/aiwebsite/.env overrides it at run time, which is the 3am lever: an alert
# can be answered with a one-line VM edit instead of a re-render and a deploy.
# `{ grep || true; }`, not a bare grep: this runs at TOP LEVEL under
# `set -euo pipefail`, where a grep that finds nothing returns 1, pipefail
# promotes it, and errexit kills the script at an assignment. The credential
# greps below survive only because a deployed .env always has those lines; this
# one is expected to be absent almost always.
extra_max_kb=$({ grep -E '^BACKUP_EXTRA_MAX_KB=' "$env_file" 2>/dev/null || true; } | head -1 | cut -d'=' -f2- | tr -d '"' | tr -d "'")
case "$extra_max_kb" in ''|*[!0-9]*) extra_max_kb=2097152 ;; esac
extra_max_bytes=$((extra_max_kb * 1024))
# Read by on_error, which is the ERR trap: assigned HERE, before `trap` is armed.
extra_note=""
if [ -n "$extra_name" ]; then
  extra_note=" THE SECOND ARTIFACT ($extra_name) WAS NOT BACKED UP ON THIS RUN EITHER: its block runs at the end of this script, so it never executed and it raises no separate alert. Treat both artifacts as missing for tonight."
fi

# ── One run at a time (v1.114.0, all hosts) ─────────────────────────────
# Two overlapping executions (the timer plus an operator running the job by
# hand) share $workdir and, in the same second, $timestamp — so they share the
# local temp path and the blob names, and the second-artifact block's
# leftover-sweep glob matches EVERY run's tarball, not just its own. The victim
# then raises a CRITICAL saying the artifact is unprotected when the other run
# has in fact just backed it up correctly.
#
# The lock is held on a FILE DESCRIPTOR in this process, not by re-exec'ing
# through `flock <file> <cmd>`: that form makes flock exec $0 directly, which
# fails "Permission denied" whenever the script is invoked as
# `bash deploy/backup-db.sh` on a non-executable checkout copy (measured).
#
# CONTENTION IS RECORDED, NOT SILENT. An `exit 0` with no trace is how a
# permanently-wedged run hides: fd 9 is INHERITED by gsutil/az children, and a
# measured test confirms an orphaned child keeps the lock after the parent
# exits — so a wedge is possible and must leave evidence. The 26h backup
# heartbeat is the outer backstop (watchdog.sh), and RuntimeMaxSec on the unit
# bounds the wedge itself; this row is what tells the operator WHY.
lock_file="$state_dir/backup-db.lock"
mkdir -p "$state_dir" 2>/dev/null || true
if command -v flock >/dev/null 2>&1 && : >>"$lock_file" 2>/dev/null; then
  exec 9>>"$lock_file"
  if ! flock -n 9; then
    echo "another backup-db.sh run holds $lock_file — exiting without running"
    record_issue "WARN Database backup skipped (another run holds the lock)" \
      "backup-db.sh found $lock_file held on $(hostname) at $(date -Is) and exited without backing anything up. One run is normal (an operator ran it by hand while the timer fired). REPEATED rows here mean a previous run never released the lock: check for a wedged process, and note that the aiwebsite-backup unit's RuntimeMaxSec bounds it. The 26h backup-heartbeat check is the outer backstop." \
      "backup-lock-contended" "0"
    exit 0
  fi
fi

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

# v1.114.0 — `-sf -m 15`, not `-s`. The contract on the next line says this
# returns 0 IFF the mail went out, and with a bare `curl -s` that was FALSE: curl
# exits 0 on an HTTP 4xx/5xx, so a revoked key, a rate limit, or a malformed body
# (alert() builds its JSON by hand and escapes nothing) returned success, and
# on_error then recorded `emailed=1` in the ledger for a CRITICAL nobody
# received. Measured against the real endpoint: `curl -s` with a bogus key exits
# 0; `curl -sf` exits 22. `-m 15` because a hung send inside an ERR trap holds
# the whole nightly. watchdog.sh.tpl's sender has always had both; these three
# did not, and the alert-channel bounce incident is what that costs.
alert() { # subject-after-prefix body — returns 0 iff the mail actually went out
  local key
  key=$(grep -E '^RESEND_API_KEY=' "$env_file" 2>/dev/null | head -1 | cut -d'=' -f2- | tr -d '"' | tr -d "'")
  [ -z "$key" ] && return 1
  curl -sf -m 15 -X POST https://api.resend.com/emails \
    -H "Authorization: Bearer $key" \
    -H "Content-Type: application/json" \
    -d "{\"from\":\"ai.xl.net Watchdog <noreply@ai.xl.net>\",\"to\":\"adam@xl.net\",\"subject\":\"[aiwebsite] $1\",\"text\":\"$2\",\"headers\":{\"Auto-Submitted\":\"auto-generated\",\"X-Auto-Response-Suppress\":\"All\"}}" >/dev/null || return 1
  return 0
}

on_error() {
  # Mail FIRST (alerting is primary), then mirror the outcome into the ledger.
  local body emailed=0
  body="backup-db.sh failed at line $1 on $(hostname) at $(date -Is). Check /var/log/aiwebsite-backup.log. The last-known-good backup heartbeat is NOT updated until a backup succeeds.${extra_note:-}"
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

if [ -n "$extra_name" ]; then
  # ── Second artifact (§9.4 v1.114.0) — INERT unless BACKUP_EXTRA_NAME is set ──
  # Everything above backs up Postgres, and §9.4 has always said so in as many
  # words: "the dump covers Postgres only". A host with irreplaceable on-disk
  # state had nowhere to put it, so one host hand-edited its RENDERED
  # backup-db.sh to add one — and render.mjs deleted that edit on v1.110.0 and
  # again on v1.111.0. This block is that engine, hoisted, with the host-specific
  # parts moved out to four site-deploy.env keys. The module never learns what
  # the directory contains.
  #
  # It ships as its OWN artifact beside the SQL dump: same bucket, same
  # bucket_put, same credentials resolved in the same place, so there is one
  # credential to keep working and one listing to look at.
  #
  # The dump half above is deliberately untouched, including WHERE the heartbeat
  # is stamped. /var/lib/aiwebsite/last-backup-ok means "the DATABASE dump
  # succeeded": the watchdog's 26h freshness check and the quarterly restore
  # drill both reason about the dump, and letting this half withhold that stamp
  # would raise "backups are dead" about a database whose backup is sitting in
  # the bucket. This artifact gets its own stamp, its own CRITICAL mail, its own
  # ledger key and its own non-zero exit instead, so a failure here is exactly as
  # loud as a failed dump and says which half failed.
  #
  # NOT COVERED, and named rather than implied: restore-drill.sh restores only
  # latest.sql.gz. This artifact is written nightly and never test-restored,
  # against §9.4's own "a backup that cannot be restored is not a backup".

  extra_alert() { # 1=reason. CRITICAL mail + ledger mirror; never throws.
    local body emailed=0 dir_display="${extra_dir_default:-the extra artifact directory}"
    body="backup-db.sh could not back up the extra artifact '$extra_name' on $(hostname) at $(date -Is): $1. The nightly pg_dump SUCCEEDED and is unaffected -- only $dir_display is unprotected. Check /var/log/aiwebsite-backup.log.${extra_why:+ }${extra_why:-}"
    # `if alert` rather than on_error's `alert ... && emailed=1` idiom: that
    # one runs inside the ERR trap, this one runs with errexit LIVE, and on a
    # host with no RESEND_API_KEY the && form returns 1 and would kill the
    # script here -- before record_issue and before the exit below.
    if alert "CRITICAL Extra artifact backup FAILED" "$body"; then emailed=1; fi
    record_issue "CRITICAL Extra artifact backup FAILED" "$body" "extra-backup-failed" "$emailed"
    return 0
  }

  # Returns 0 on success OR on a legitimate skip, 1 with $extra_fail_reason
  # set on failure. Called from an `if`, so bash suppresses errexit and the
  # ERR trap for everything inside it; every step therefore checks itself
  # explicitly. That is the point: it is what lets a store failure raise its
  # own named alert instead of the dump's generic "Database backup FAILED".
  extra_fail_reason=""
  extra_backup() {
    local dir="" parent="" base="" store_kb="" free_now_kb="" need_kb=0
    local tar_status=0 extra_bytes=0 entries=0 stamp_seen=0
    local prev_entries=0 prev_store_kb=0

    # v1.114.0: the rendered literal is the ONLY source of truth for the path.
    # A runtime .env override was deliberately NOT carried over from the host
    # edit: it would make render.mjs's validators decorative (the effective
    # directory would be an unvalidated .env line on the VM) and the key name
    # was interpolated into a single-quoted grep, where a quote runs as root.
    # Relocating the store is a re-render, which is the point of this seam.
    dir="$extra_dir_default"
    local extra_tmp="$workdir/$extra_filename"
    # v1.114.0 F2 — RESOLVE SYMLINKS FIRST. Measured: with $dir a symlink to a
    # real directory, `[ -d ]` is true, `find "$dir" -type f` returns NOTHING
    # (GNU find does not dereference the start point), `du -sk` returns 0, and
    # tar packages the SYMLINK as a single entry that passes an `entries -lt 1`
    # check. On a fresh host that reads as "nothing to do" (no CRITICAL, no
    # backup, ever); on an established one it raises a false "files that existed
    # are gone". Relocating a store onto another disk via a symlink is the
    # natural response to a full disk, so this is reachable, not theoretical.
    if [ -L "$dir" ]; then
      local resolved=""
      resolved=$(readlink -f "$dir" 2>/dev/null || true)
      [ -n "$resolved" ] && dir="$resolved"
    fi

    # The stamp is both "a good backup has happened here" AND the size of that
    # backup, so this run can tell a shrinking store from a steady one.
    if [ -f "$extra_stamp_file" ]; then
      stamp_seen=1
      prev_entries=$(sed -n 's/^entries=\([0-9]\{1,\}\)$/\1/p' "$extra_stamp_file" 2>/dev/null | head -1)
      prev_store_kb=$(sed -n 's/^store_kb=\([0-9]\{1,\}\)$/\1/p' "$extra_stamp_file" 2>/dev/null | head -1)
      case "$prev_entries" in ''|*[!0-9]*) prev_entries=0 ;; esac
      case "$prev_store_kb" in ''|*[!0-9]*) prev_store_kb=0 ;; esac
    fi

    # Absent or empty is NOT a failure on a fresh host -- no submission has
    # ever been accepted there. It IS a failure once we have successfully
    # backed a non-empty store up before, because then files that existed
    # have gone: that is the disaster this artifact exists to survive, and it
    # must not be reported as "nothing to do". Ignore in-flight writes, using
    # the app's OWN temp-file pattern and not a looser glob: it sweeps
    # /\.tmp-\d+-\d+$/, while `*.tmp-*` also matches ordinary submitter
    # filenames -- a store that keeps '.' in stored filenames
    # and '-' verbatim, so a package literally called `build.tmp-1.zip` is
    # stored as `<uuid>/00-build.tmp-1.zip`. Under the loose glob that real,
    # ledgered file was silently dropped from the tarball, and a store whose
    # files all carried such names read here as "empty" and was reported as a
    # fresh host. Measured 2026-08-29: `*.tmp-*` kept 1 of 4 real files,
    # `*.tmp-[0-9]*-[0-9]*` keeps 4 of 4 and still excludes a genuine orphan.
    if [ ! -d "$dir" ] || [ -z "$(find "$dir" -type f ! -name '*.tmp-[0-9]*-[0-9]*' -print -quit 2>/dev/null)" ]; then
      if [ "$stamp_seen" -eq 1 ]; then
        extra_fail_reason="$dir holds no files, but $extra_stamp_file records an earlier SUCCESSFUL store backup, so files that existed are gone. Restore from $bucket/$extra_latest before anything else. If instead an operator deliberately emptied the whole store, delete $extra_stamp_file to acknowledge it and this alert stops."
        return 1
      fi
      local fresh_msg="Archive store: $dir is absent or empty and has never been backed up -- nothing to do (fresh host) on $(hostname) at $(date -Is). Recorded rather than merely echoed because NOTHING reads $extra_stamp_file for freshness (watchdog.sh checks only the DATABASE heartbeat, §9.6), so this branch is the one way the store backup can go on not happening with nobody told."
      echo "$fresh_msg"
      record_issue "WARN Extra artifact not backed up (nothing to back up)" "$fresh_msg" "extra-backup-skipped" "0"
      return 0
    fi

    # A run that died between tar and upload leaves a (possibly large)
    # tarball behind. Ours is timestamped, so anything matching here is from
    # an earlier run; clear it BEFORE measuring free space so the reclaimed
    # space counts. This is also what keeps a second run in the same minute
    # safe: it rewrites its own file rather than accumulating.
    find "$workdir" -maxdepth 1 -type f -name "aiwebsite-${extra_name}_*.tar.gz" \
      ! -name "$extra_filename" -delete 2>/dev/null || true

    if ! store_kb=$(du -sk "$dir" 2>/dev/null | cut -f1); then
      extra_fail_reason="could not measure $dir (du failed)"
      return 1
    fi
    case "$store_kb" in ''|*[!0-9]*)
      extra_fail_reason="du returned a non-numeric size for $dir: '$store_kb'"
      return 1 ;;
    esac
    if [ "$store_kb" -gt "$extra_max_kb" ]; then
      extra_fail_reason="$dir is $store_kb KB, over the $extra_max_kb KB ceiling this script packages. NOTHING was uploaded and the last good store backup in the bucket is untouched. Run the app's own cleanup path, or raise the ceiling deliberately after checking disk and bucket headroom by setting BACKUP_EXTRA_MAX_KB in /var/www/aiwebsite/.env -- NOT by editing this file, which is template-rendered and reverts on the next render."
      return 1
    fi

    # A full disk corrupts the tarball exactly when a good backup matters
    # most -- the dump half's reasoning, with the store's size in it, because
    # the store can be far larger than a dump and grows with every upload.
    free_now_kb=$(df --output=avail "$workdir" 2>/dev/null | tail -1)
    case "$free_now_kb" in ''|*[!0-9]*)
      extra_fail_reason="could not read free space on $workdir (df returned '$free_now_kb')"
      return 1 ;;
    esac
    need_kb=$((store_kb + min_free_kb))
    if [ "$free_now_kb" -lt "$need_kb" ]; then
      extra_fail_reason="insufficient disk for the store tarball ($free_now_kb KB free on $workdir, need $need_kb KB = store $store_kb KB + the $min_free_kb KB margin)"
      return 1
    fi

    # -C parent basename, so the tar carries `<basename>/...`
    # and unpacks into a named directory instead of scattering submission
    # dirs into whatever cwd the operator restored from. The single top-level
    # entry is the BASENAME of the store root as configured when the artifact
    # was taken (the directory's own basename), which is why the
    # completion line below prints it: a restore untars into the store root's
    # PARENT, and an operator holding an old artifact should not have to guess.
    parent=$(dirname "$dir")
    base=$(basename "$dir")
    # Same narrow pattern as the emptiness probe above, for the same reason: a
    # broad `*.tmp-*` exclusion drops real submitter-named files out of the
    # artifact with no signal at all. Dropping the exclusion entirely would also
    # be safe (orphans are tiny and such a store usually sweeps them itself).
    tar --exclude='.env' --exclude='.env.*' --exclude='*.tmp-[0-9]*-[0-9]*' -czf "$extra_tmp" -C "$parent" -- "$base" || tar_status=$?
    if [ "$tar_status" -gt 1 ]; then
      rm -f "$extra_tmp"
      extra_fail_reason="tar exited $tar_status packaging $dir"
      return 1
    fi
    if [ "$tar_status" -eq 1 ]; then
      # GNU tar's warning class: a file changed or vanished while being read.
      # Expected against live intake and admin cleanup, and harmless here
      # because a store that writes temp-then-rename (a ledgered path
      # never holds partial bytes). The read-back below is the real gate.
      echo "Archive store: tar reported changed/vanished files during packaging (exit 1) -- verifying the artifact."
    fi

    if ! extra_bytes=$(stat -c%s "$extra_tmp" 2>/dev/null); then
      rm -f "$extra_tmp"
      extra_fail_reason="the store tarball was not created at $extra_tmp"
      return 1
    fi
    if [ "$extra_bytes" -gt "$extra_max_bytes" ]; then
      rm -f "$extra_tmp"
      extra_fail_reason="the tarball is $extra_bytes bytes, over the $extra_max_bytes byte ceiling; nothing was uploaded"
      return 1
    fi
    # Read the whole artifact back before it is allowed to overwrite
    # $extra_latest. This is the tar analogue of the dump's min_bytes
    # floor, and it is strictly stronger: `tar -tzf` validates the gzip CRC
    # and the tar structure end to end, so a truncated archive cannot become
    # the copy an operator restores from.
    if ! entries=$(tar -tzf "$extra_tmp" | wc -l); then
      rm -f "$extra_tmp"
      extra_fail_reason="the store tarball does not read back (tar -tzf failed); $extra_latest was NOT overwritten"
      return 1
    fi
    if [ "$entries" -lt 1 ]; then
      rm -f "$extra_tmp"
      extra_fail_reason="the store tarball lists no entries although $dir is not empty"
      return 1
    fi

    if ! bucket_put "$extra_tmp" "$extra_filename"; then
      rm -f "$extra_tmp"
      extra_fail_reason="upload of $extra_filename to $bucket failed"
      return 1
    fi
    # ── Partial-loss guard, between the dated upload and `latest` ─────
    # The emptiness check at the top of this function is all-or-nothing: it
    # fires only when the store is COMPLETELY empty. A PARTIAL loss (a bad rm, a
    # bug in admin cleanup, a half-failed filesystem) used to pass every guard
    # and overwrite $extra_latest with the damaged store at exit 0 with no
    # alert -- and $extra_latest is exactly the blob the §9.7 restore runbook
    # tells an operator to download, so the 3am restore handed back the damage.
    # Measured 2026-08-29: 7 files became 1, a 99.8% collapse, in complete
    # silence. The dated blob has already uploaded above, so tonight's state is
    # never lost; what this refuses is letting a collapse become the POINTER.
    # `latest` keeps last night's copy and the run alerts instead.
    if [ "$prev_entries" -gt 0 ] && [ $((entries * 2)) -lt "$prev_entries" ]; then
      rm -f "$extra_tmp"
      extra_fail_reason="the store collapsed from $prev_entries tar entries to $entries since the last successful backup (more than half of it is gone). $extra_filename DID upload, so tonight's state is in the bucket under that dated name, but $extra_latest was deliberately NOT overwritten and still holds the last good copy -- restore from that. If an operator deliberately emptied most of the store, delete $extra_stamp_file to acknowledge it and the next run proceeds."
      return 1
    fi
    if [ "$prev_store_kb" -gt 0 ] && [ $((store_kb * 2)) -lt "$prev_store_kb" ]; then
      rm -f "$extra_tmp"
      extra_fail_reason="the store shrank from $prev_store_kb KB to $store_kb KB since the last successful backup (more than half of it is gone). $extra_filename DID upload, so tonight's state is in the bucket under that dated name, but $extra_latest was deliberately NOT overwritten and still holds the last good copy -- restore from that. If an operator deliberately deleted most of the store, delete $extra_stamp_file to acknowledge it and the next run proceeds."
      return 1
    fi

    # Timestamped copy first, `latest` second: if the second upload fails the
    # night's store is still IN the bucket under its dated name, and the
    # reason below says so rather than implying nothing was saved.
    if ! bucket_put "$extra_tmp" "$extra_latest"; then
      rm -f "$extra_tmp"
      extra_fail_reason="upload of $extra_latest to $bucket failed -- the dated $extra_filename DID upload, so tonight's store is in the bucket under that name"
      return 1
    fi
    rm -f "$extra_tmp"

    # Epoch on line 1 so a future freshness check can `head -1` it exactly like
    # last-backup-ok; the size lines below are what the partial-loss guard above
    # compares the next run against.
    printf '%s\nentries=%s\nstore_kb=%s\n' "$(date +%s)" "$entries" "$store_kb" \
      > "$extra_stamp_file" 2>/dev/null || echo "NOTE: could not write $extra_stamp_file"
    echo "Extra artifact backup completed: $extra_filename ($extra_bytes bytes, $entries entries, store $store_kb KB, unpacks as $base/ into $parent) + $extra_latest"
    return 0
  }

  if ! extra_backup; then
    extra_alert "$extra_fail_reason"
    exit 1
  fi

fi
