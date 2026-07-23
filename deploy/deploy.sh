#!/usr/bin/env bash
# aicompany-template: deploy.sh.tpl@47d6811d1b383c5a561082d45005bb203780cdc61cafc4bff2972cd2ffff307c
#
# Deploy ai.xl.net from the dev box to the production VM.
#
#   bash deploy/deploy.sh [--allow-sshpass] [--takeover]
#
# --takeover (v1.15.0): skip the pre-rsync deploy-busy guard (fresh remote
# deploy marker) and reap orphaned capped build scopes first — ONLY for
# taking over from a deploy that is provably dead (crashed session).
#
# Transport ("ssh-key", rendered from deploy/site-deploy.env):
#   ssh-key    (default) key auth via SSH_KEY_PATH; reads AIWEBSITE_SSH_IP /
#              AIWEBSITE_USER from .env
#   sshpass    LEGACY password auth via AIWEBSITE_PW; refuses to run
#              without the explicit --allow-sshpass flag
#   gcloud-iap `gcloud compute ssh` IAP tunneling for GCP VMs with no
#              external IP (files ship as tar streams; no rsync --delete)
#
# Syncs the repo (incl. packages/brain submodule working tree), the production
# .env, the MaxMind DB, and the pre-provisioned Cloudflare tunnel credentials,
# then runs deploy/setup-vm.sh on the VM (which runs config:check BEFORE the
# PM2 reload). DNS is always a human step — this script never writes DNS.
#
set -euo pipefail

# Failure must be unmistakable in the LOG, not just the exit code: callers
# routinely mask exit codes (`deploy.sh | tee log` returns tee's status; a
# `| tail` invocation did exactly this on 2026-07-13 — the VM build failed,
# the script aborted correctly, but the pipeline reported 0 and the log just
# ended mid-build with no FAILED marker). Also note the gcloud-iap transport
# collapses remote exit codes to 1 — zero/non-zero is the only reliable
# signal, and this banner is its human-readable form.
trap 'code=$?; if [ "$code" -ne 0 ]; then
  echo "" >&2
  echo "!!! DEPLOY FAILED (exit $code)." >&2
  echo "!!! If the remote log has NO \">>> CUTOVER COMPLETE\" line, aiwebsite production was NOT touched — the old build is still serving." >&2
  echo "!!! If that line IS present, the NEW build is live and a post-cutover step failed; it was NOT un-deployed." >&2
  echo "!!! Fix the error above and re-run deploy/deploy.sh." >&2
fi' EXIT

# ── Dev-box per-host deploy serialization (v1.15.0, A7/G5) ───────
# Two agent sessions deployed the same host within minutes on 2026-07-22 —
# the VM-side locks (fd 200/201) only start AFTER rsync, so the source-sync
# window needs a dev-box mutex too. fd 202 (200/201 are the VM-side pair).
# XDG_RUNTIME_DIR may be unset in cron/CI shells (set -u) — fall back
# through TMPDIR to /tmp. Opened APPEND (not truncate) so a losing session
# can still read the winner's holder line; the winner rewrites it below.
deploy_local_lock="${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/aicompany-deploy-aiwebsite.lock"
exec 202>>"$deploy_local_lock"
if ! flock -n 202; then
  echo "ERROR: another deploy of aiwebsite is already running from this dev box — aborting."
  echo "       lock:   $deploy_local_lock"
  echo "       holder: $(cat "$deploy_local_lock" 2>/dev/null || echo '<unknown>')"
  exit 1
fi
printf 'pid %s started %s\n' "$$" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" > "$deploy_local_lock"

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
app_dir="/var/www/aiwebsite"
module_dir="$repo_dir/packages/aicompany"
transport="ssh-key"
tunnel_cred_local="${TUNNEL_CRED_LOCAL:-$HOME/.cloudflared/aiwebsite-tunnel.json}"

# ── Template drift gate (§9): rendered deploy/ files must match the module's
# current templates, or a module bump would silently run stale scripts.
echo ">>> Checking rendered deploy scripts against module templates..."
stale=0
for f in "$repo_dir"/deploy/*; do
  [ -f "$f" ] || continue
  line=$(grep -m1 -E '^(#|//) aicompany-template: ' "$f" 2>/dev/null || true)
  [ -n "$line" ] || continue
  ref="$(printf '%s' "$line" | sed 's/^.*aicompany-template: //')"
  name="$(printf '%s' "$ref" | cut -d@ -f1)"
  want="$(printf '%s' "$ref" | cut -d@ -f2)"
  tpl="$module_dir/deploy/templates/$name"
  if [ ! -f "$tpl" ]; then
    echo "ERROR: deploy/$(basename "$f") references a template that no longer exists: $name"
    stale=1
    continue
  fi
  have="$(sha256sum "$tpl" | cut -d' ' -f1)"
  if [ "$want" != "$have" ]; then
    echo "ERROR: deploy/$(basename "$f") was rendered from an outdated $name"
    stale=1
  fi
done
if [ "$stale" -ne 0 ]; then
  echo ""
  echo "Rendered deploy scripts are out of date with the module templates —"
  echo "re-run render.mjs and commit:"
  echo "  node packages/aicompany/deploy/render.mjs && git add deploy/ && git commit"
  exit 1
fi
echo "  stamps OK"

# ── Dev-box credentials: read values literally — do NOT `source` .env:
# passwords may contain shell-special characters ($, #, *) that expansion
# would mangle. `|| true`: a missing key must return empty, not kill the
# script — under `set -euo pipefail` a bare failed grep aborted the deploy
# with NO error message when the OPTIONAL <PREFIX>_SSH_KEY was absent
# (roleplay first-deploy, v1.4.1); the REQUIRED keys have explicit :? guards.
envval() { { grep -E "^$1=" "$repo_dir/.env" || true; } | head -1 | cut -d= -f2-; }

# ── Transport wrappers ───────────────────────────────────────────
case "$transport" in
  ssh-key)
    ssh_ip="$(envval AIWEBSITE_SSH_IP)"
    ssh_user="$(envval AIWEBSITE_USER)"
    ssh_key="$(envval AIWEBSITE_SSH_KEY)"
    ssh_key="${ssh_key:-~/.ssh/id_ed25519}"
    # site-deploy.env ships a ~-prefixed default; inside quotes bash never
    # tilde-expands, so do it explicitly before the -f test.
    ssh_key="${ssh_key/#\~/$HOME}"
    : "${ssh_ip:?set AIWEBSITE_SSH_IP in .env}"
    : "${ssh_user:?set AIWEBSITE_USER in .env}"
    [ -f "$ssh_key" ] || { echo "ERROR: SSH key $ssh_key not found (set AIWEBSITE_SSH_KEY in .env or SSH_KEY_PATH in deploy/site-deploy.env)"; exit 1; }
    ssh_e="ssh -i $ssh_key -o StrictHostKeyChecking=accept-new"
    # REMOTE_TIMEOUT (v1.15.0): the preflight probe sets 15s so a livelocked
    # box (TCP accepts, SSH banner hangs — the 2026-07-22 signature) fails
    # fast; everywhere else it is unset ⇒ `timeout 0` ⇒ no timeout.
    run_remote() { timeout "${REMOTE_TIMEOUT:-0}" $ssh_e "$ssh_user@$ssh_ip" "$@"; }
    sync_dir()  { rsync -az --delete "${rsync_excludes[@]}" -e "$ssh_e" "$1" "$ssh_user@$ssh_ip:$2"; }
    push_file() { rsync -az -e "$ssh_e" "$1" "$ssh_user@$ssh_ip:$2"; }
    ;;
  sshpass)
    allow_flag="no"
    for arg in "$@"; do [ "$arg" = "--allow-sshpass" ] && allow_flag="yes"; done
    if [ "$allow_flag" != "yes" ]; then
      echo "ERROR: DEPLOY_TRANSPORT=sshpass is a legacy transport (password auth)."
      echo "Re-run with --allow-sshpass to confirm, or switch to ssh-key in deploy/site-deploy.env."
      exit 1
    fi
    ssh_ip="$(envval AIWEBSITE_SSH_IP)"
    ssh_user="$(envval AIWEBSITE_USER)"
    ssh_pw="$(envval AIWEBSITE_PW)"
    : "${ssh_ip:?set AIWEBSITE_SSH_IP in .env}"
    : "${ssh_user:?set AIWEBSITE_USER in .env}"
    : "${ssh_pw:?set AIWEBSITE_PW in .env}"
    export SSHPASS="$ssh_pw"
    run_remote() { timeout "${REMOTE_TIMEOUT:-0}" sshpass -e ssh -o StrictHostKeyChecking=accept-new "$ssh_user@$ssh_ip" "$@"; }
    sync_dir()  { sshpass -e rsync -az --delete "${rsync_excludes[@]}" "$1" "$ssh_user@$ssh_ip:$2"; }
    push_file() { sshpass -e rsync -az "$1" "$ssh_user@$ssh_ip:$2"; }
    ;;
  gcloud-iap)
    gcloud_args=(--project "" --zone "" --tunnel-through-iap)
    run_remote() { timeout "${REMOTE_TIMEOUT:-0}" gcloud compute ssh "" "${gcloud_args[@]}" --command "$*"; }
    # No rsync over IAP: ship a tar stream. --delete semantics are lost; the
    # exclude list still keeps VM-owned paths (data/, .env) untouched.
    sync_dir() {
      tar czf - -C "$1" "${tar_excludes[@]}" . | run_remote "mkdir -p $2 && tar xzf - -C $2"
    }
    push_file() { run_remote "cat > $2$(basename "$1")" < "$1"; }
    ;;
  *)
    echo "ERROR: unknown DEPLOY_TRANSPORT '$transport' (expected ssh-key | sshpass | gcloud-iap)"
    exit 1
    ;;
esac

# data/ holds the VM-generated knowledge docs (nightly crawl) and the config
# snapshot; it exists only on the VM, so --delete must not remove it.
rsync_excludes=(
  --exclude .git --exclude node_modules --exclude .next
  --exclude .env --exclude /data/
  --exclude packages/brain/node_modules
  --exclude packages/brain/scripts/benchmark/cache
  # Staged-deploy artifacts (v1.13.0): the VM-side rollback (.old) and
  # candidate (.new) generations must survive rsync --delete. Unanchored
  # basename patterns also cover packages/brain/node_modules.old and any
  # host swap-dirs extras (e.g. vendor/brain-sdk/node_modules.old).
  --exclude node_modules.old --exclude node_modules.new
  --exclude .next.old --exclude .next.new
)
tar_excludes=(
  --exclude ./.git --exclude "node_modules" --exclude ./.next
  --exclude ./.env --exclude ./data
  --exclude "./packages/brain/scripts/benchmark/cache"
)

# Host-owned exclude list (v1.4.0): deploy/rsync-excludes.txt patterns (one
# per line, # comments) are appended to BOTH exclude sets — VM-owned trees a
# host must protect from rsync --delete (e.g. service data dirs, sqlite
# files). rsync never deletes excluded paths (this is not --delete-excluded).
if [ -f "$repo_dir/deploy/rsync-excludes.txt" ]; then
  # `|| [ -n "$pat" ]`: read returns non-zero on a final unterminated line
  # while still filling $pat — without this, a file missing its trailing
  # newline silently drops its LAST pattern and rsync --delete removes the
  # very tree the file protects. The ${pat%…} strips a CR from CRLF files,
  # which would otherwise make every pattern match nothing.
  while IFS= read -r pat || [ -n "$pat" ]; do
    pat="${pat%$'\r'}"
    case "$pat" in ''|'#'*) continue ;; esac
    rsync_excludes+=(--exclude "$pat")
    tar_excludes+=(--exclude "$pat")
  done < "$repo_dir/deploy/rsync-excludes.txt"
fi

# ── Remote preflight (v1.15.0): ONE probe call before any rsync ──
# (i)   dead-box guard: `free` under a 15s timeout — the 2026-07-22
#       livelocked VM accepted TCP but hung at the SSH banner, and a 15:02
#       rsync piled onto the dead box. No answer ⇒ console runbook, never a
#       blind retry.
# (ii)  memory floor: MemAvailable < 1024MB ⇒ refuse before shipping bytes
#       (stage-build's prepare re-checks the same floor VM-side).
# (iii) deploy-busy guard: a fresh (<30min) deploy marker means another
#       session's deploy owns the VM — abort BEFORE rsync (the VM-side
#       flocks only protect setup-vm, not the source sync; two sessions
#       deployed the same host on 2026-07-22). Detection is TOKEN-GREP on
#       the probe output, not exit codes: gcloud-iap collapses every remote
#       exit code to 1.
takeover="no"
for arg in "$@"; do [ "$arg" = "--takeover" ] && takeover="yes"; done
echo ">>> Remote preflight (VM liveness + memory floor + busy guard)..."
pf_script='free -m | head -2
awk "/^MemAvailable:/{print \"MEMAVAIL_KB\", \$2}" /proc/meminfo
ps -eo rss=,comm= --sort=-rss | head -3 | sed "s/^/TOP-RSS /"
if [ -f /var/run/aiwebsite-deploy-in-progress ]; then
  echo "MARKER_AGE $(( $(date +%s) - $(stat -c %Y /var/run/aiwebsite-deploy-in-progress) ))"
else
  echo "MARKER_AGE none"
fi'
pf_rc=0
# v1.15.1: transport-aware probe budget — gcloud-iap spends 20-40s ESTABLISHING
# the tunnel on a perfectly healthy box (observed: itsc false-positive
# "VM unresponsive" on the v1.15.0 canary rollout), so IAP gets 75s; direct
# ssh keeps the tight 15s that actually discriminates a livelocked guest.
case "$transport" in
  gcloud-iap) REMOTE_TIMEOUT=75 ;;
  *)          REMOTE_TIMEOUT=15 ;;
esac
pf_budget=$REMOTE_TIMEOUT
preflight_out=$(run_remote "$pf_script" 2>&1) || pf_rc=$?
REMOTE_TIMEOUT=0
if ! printf '%s' "$preflight_out" | grep -q 'MEMAVAIL_KB'; then
  echo "ERROR: VM unresponsive — the preflight probe got no answer in ${pf_budget}s (rc=$pf_rc)."
  printf '%s\n' "$preflight_out" | head -5
  echo "       A hung SSH banner plus a public 530 is the livelock/dead-box signature."
  echo "       Do NOT retry-loop the deploy — see deploy/RUNBOOK.md, section"
  echo "       'VM unreachable (SSH dead / site 530) — console recovery'."
  exit 1
fi
mem_avail_kb=$(printf '%s\n' "$preflight_out" | awk '/^MEMAVAIL_KB/{print $2; exit}')
if [ -n "$mem_avail_kb" ] && [ $(( mem_avail_kb / 1024 )) -lt 1024 ]; then
  echo "ERROR: VM MemAvailable is $(( mem_avail_kb / 1024 ))MB — under the 1024MB deploy floor."
  echo "       Top-3 RSS on the VM:"
  printf '%s\n' "$preflight_out" | grep '^TOP-RSS' || true
  echo "       Free memory first (leaky app? blog window?) and re-run."
  exit 1
fi
marker_age=$(printf '%s\n' "$preflight_out" | awk '/^MARKER_AGE/{print $2; exit}')
if [ "$takeover" = "yes" ]; then
  echo ">>> --takeover: skipping the busy guard; reaping orphaned capped stage scopes (A4)..."
  run_remote "sudo -n systemctl stop 'aiwebsite-stage-*.scope' 2>/dev/null || true"
elif [ "$marker_age" != "none" ] && [ "$marker_age" -lt 1800 ]; then
  echo "DEPLOY-BUSY age=${marker_age}s — another deploy touched this VM's marker under 30min ago."
  echo "If that deploy is still running, let it finish. If it is provably dead"
  echo "(crashed session, closed pipe), take over with:"
  echo "  bash deploy/deploy.sh --takeover"
  exit 1
fi

echo ">>> Preparing $app_dir on VM..."
run_remote "sudo mkdir -p $app_dir && sudo chown \$(whoami): $app_dir"

# Cover the source-sync window with the deploy↔watchdog marker: a watchdog
# staged rebuild must never stage half-synced sources (§9.5). setup-vm
# re-touches and finally removes it as before; a crashed sync ages out via TTL.
run_remote "sudo touch /var/run/aiwebsite-deploy-in-progress"

echo ">>> Syncing repo..."
sync_dir "$repo_dir/" "$app_dir/"

echo ">>> Copying production .env..."
push_file "$repo_dir/.env" "$app_dir/"

# GeoLite2-ASN is gitignored (12 MB binary) but lives inside the otherwise
# VM-owned data/, so it is shipped explicitly. Powers /admin/companies
# IP→organization lookups.
if [ -f "$repo_dir/data/GeoLite2-ASN.mmdb" ]; then
  echo ">>> Copying GeoLite2-ASN.mmdb..."
  run_remote "mkdir -p $app_dir/data"
  push_file "$repo_dir/data/GeoLite2-ASN.mmdb" "$app_dir/data/"
fi

if [ -f "$tunnel_cred_local" ]; then
  echo ">>> Copying Cloudflare tunnel credentials..."
  push_file "$tunnel_cred_local" "/tmp/"
  run_remote "sudo mkdir -p /etc/cloudflared && sudo mv /tmp/$(basename "$tunnel_cred_local") /etc/cloudflared/aiwebsite-tunnel.json && sudo chmod 600 /etc/cloudflared/aiwebsite-tunnel.json"
else
  echo "NOTE: $tunnel_cred_local not found — setup-cloudflared.sh will fall back to interactive login."
fi

echo ">>> Running setup-vm.sh on VM (installs everything, config:check gates the PM2 reload)..."
run_remote "cd $app_dir && bash deploy/setup-vm.sh"

echo ""
echo ">>> Verifying..."
run_remote "curl -fsS http://127.0.0.1:3000/api/health && echo && curl -fsS http://127.0.0.1:3211/health | head -c 300 && echo"
# Extra services (v1.4.0): an `if` guard, NOT `[ -f … ] && verify || true` —
# that form exits 0 on both missing-manifest AND verify failure, making the
# check decorative. With `if`, a verify failure propagates through
# run_remote's exit status into `set -e` and the failure banner; a missing
# manifest is exit 0 by construction.
run_remote "cd $app_dir && if [ -f deploy/extra-services.json ]; then bash deploy/extra-services.sh verify; fi"
echo ""
echo "=== Deploy complete. Public check: curl -fsS https://ai.xl.net/api/health ==="

# ── Post-deploy synthetic sweep (§9.8 v1.17.0) — ALERT-ONLY ──────
# Runs dev-box-side against the PUBLIC domain. --post-deploy gates every
# assertion on public-health SETTLE (3 consecutive /api/health OKs — the
# documented ~90s PM2/tunnel bounce must not false-alarm) and does one retry
# before alerting. NOTHING here may fail the deploy: missing runner or
# inventory ⇒ NOTE; sweep findings ⇒ WARN line (the runner already mailed).
synth_runner="$module_dir/scripts/synth-sweep.mjs"
if [ -f "$synth_runner" ] && [ -f "$repo_dir/deploy/synth-inventory.json" ]; then
  echo ">>> Post-deploy synthetic sweep of https://ai.xl.net (alert-only)..."
  node "$synth_runner" --host-dir "$repo_dir" --post-deploy \
    || echo "WARN: synthetic sweep failed or found problems — see its [aiwebsite] SYNTH mail and ~/.local/state/aicompany-synth/ (deploy NOT failed)"
else
  echo "NOTE: synth-sweep runner or deploy/synth-inventory.json absent — post-deploy sweep skipped."
fi
