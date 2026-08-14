#!/usr/bin/env bash
# aicompany-template: deploy.sh.tpl@adbc2e92d4367b5998de320d085735710775642dbfb6318c7f8cf5402ee891d9
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
#
# Banner honesty (v1.78.0 fix round, M2b): "production was NOT touched" is
# only TRUE before the cutover bracket. setup-vm logs ">>> CUTOVER BRACKET
# START" when the journaled renames begin — a log that shows the bracket
# started but never reached CUTOVER COMPLETE means the tree may be MID-FLIP
# (connection death inside the bracket), and the recovery is `deploy.sh
# --takeover`, whose pipeline runs stage-build heal (renames only) first.
# The EXIT trap also reaps the local-artifact mktemp dir on EVERY exit (L1 —
# a pre-ship failure used to leak the ~305M tarball into /tmp).
trap 'code=$?
if [ -n "${artifact_tmp:-}" ]; then rm -rf "$artifact_tmp"; fi
if [ "$code" -ne 0 ]; then
  echo "" >&2
  echo "!!! DEPLOY FAILED (exit $code)." >&2
  echo "!!! If the remote log has NO \">>> CUTOVER BRACKET START\" line, aiwebsite production was NOT touched — the old build is still serving." >&2
  echo "!!! If \">>> CUTOVER BRACKET START\" IS present but \">>> CUTOVER COMPLETE\" is NOT, the live tree may be MID-FLIP:" >&2
  echo "!!!   recover with \`bash deploy/deploy.sh --takeover\` — its pipeline runs stage-build heal (renames only, no build) before re-staging." >&2
  echo "!!! If \">>> CUTOVER COMPLETE\" IS present, the NEW build is live and a post-cutover step failed; it was NOT un-deployed." >&2
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
# Build placement (§9.2 v1.78.0): "remote" = staged VM-side build (unchanged
# default); "local-artifact" = the dev box builds .next below and ships it —
# the VM NEVER runs `next build` (the 2026-08-08 itsc outage class).
build_mode="remote"
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

# ── Rendered-artifact syntax gate (v1.30.3, §9) ──────────────────
# The stamp check above proves the rendered files MATCH the module templates —
# not that they RUN. Templates cannot be linted directly (their unsubstituted
# placeholder tokens are not bash, so `bash -n` on a .tpl fails even when the
# template is perfect), so the rendered artifact is the only lintable form.
# v1.30.0 shipped a watchdog.sh whose `check_freshness()` had an unclosed
# `if`: it rendered, stamped, installed and deployed cleanly, and could never
# start — three hosts ran with ZERO watchdogs, silently, because the cron
# supervisor only logs that it tried (MIGRATIONS v1.30.1).
#
# v1.30.2 added the same parse gate to the module's test suite. This is the
# HOST-SIDE backstop, and it is not redundant: the test suite only protects a
# host whose module bump was actually tested, and v1.30.0 reached production
# precisely because nothing between "template edited" and "script running on
# the VM" ever parsed the output. Fail closed here, before anything is rsynced.
# nginx.conf is exempt from THIS check (it is not a shell script), but it is no
# longer unvalidated. Both halves of the old excuse here — "validating it needs
# an nginx binary plus server context, so the VM's own nginx -t remains its
# gate" — were false: nginx is installed on the dev box (/usr/sbin/nginx, just
# not on the interactive PATH) and server context is a 9-line wrapper, while the
# VM-side gate was an inert `A && B` that never gated. Since v1.64.0 CI runs a
# real `nginx -t` on every rendered fixture and setup-vm.sh's gate is an `if !`
# that aborts. Do not read this exemption as "nginx.conf is somebody else's
# problem" — that reading is how v1.62.0 shipped an invalid config.
echo ">>> Syntax-checking rendered deploy scripts..."
bad_syntax=0
for f in "$repo_dir"/deploy/*.sh; do
  [ -f "$f" ] || continue
  if ! err="$(bash -n "$f" 2>&1)"; then
    echo "ERROR: deploy/$(basename "$f") is not valid bash:"
    printf '%s\n' "$err" | sed 's/^/    /'
    bad_syntax=1
  fi
done
# Rendered JS is just as load-bearing: a broken ecosystem.config.cjs or
# pm2-start.cjs takes down the PM2 apps the same way a broken watchdog.sh
# takes down self-healing. `node --check` is the equivalent parse-only test.
if command -v node >/dev/null 2>&1; then
  for f in "$repo_dir"/deploy/*.cjs "$repo_dir"/deploy/*.mjs; do
    [ -f "$f" ] || continue
    if ! err="$(node --check "$f" 2>&1)"; then
      echo "ERROR: deploy/$(basename "$f") is not valid JavaScript:"
      printf '%s\n' "$err" | sed 's/^/    /'
      bad_syntax=1
    fi
  done
fi
if [ "$bad_syntax" -ne 0 ]; then
  echo ""
  echo "A rendered deploy script would not execute. Fix the module template,"
  echo "re-render, and commit before deploying:"
  echo "  node packages/aicompany/deploy/render.mjs && git add deploy/ && git commit"
  exit 1
fi
echo "  syntax OK"

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
    # Artifact ship (v1.78.0): dest is an absolute remote FILE path. Same rsync
    # channel as push_file — kept a separate primitive so the artifact never
    # silently regresses onto a stdin pipe if push_file's shape changes.
    ship_file() { rsync -az -e "$ssh_e" "$1" "$ssh_user@$ssh_ip:$2"; }
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
    ship_file() { sshpass -e rsync -az "$1" "$ssh_user@$ssh_ip:$2"; }
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
    # Artifact ship (v1.78.0): NEVER a stdin pipe through `gcloud compute ssh`
    # for the ~305M .next artifact — the pipe-through-gcloud form above is the
    # known instant-255 class and is tolerated only for the small legacy
    # payloads. One `gcloud compute scp` CONNECTION PER ATTEMPT with backoff
    # (IAP tunnels flap under rapid reconnects), and mux forced OFF: the fleet
    # ~/.ssh/config `Host compute.*` ControlMaster can leave dead sockets that
    # poison every follow-up connection.
    ship_file() {
      local attempt rc
      for attempt in 1 2 3; do
        rc=0
        # timeout -k 30 900 (v1.78.0 fix round, M4): an IAP tunnel can wedge
        # mid-transfer with the TCP session open — without a bound, one hung
        # scp holds the deploy (and its locks/marker) forever instead of
        # falling through to the backoff/retry path. 900s moves ~305M at a
        # leisurely ~350KB/s; a healthy ship takes a fraction of that.
        timeout -k 30 900 gcloud compute scp "${gcloud_args[@]}" \
          --scp-flag=-oControlMaster=no --scp-flag=-oControlPath=none \
          "$1" ":$2" && return 0 || rc=$?
        echo "WARN: gcloud compute scp attempt $attempt failed (rc=$rc) — backing off $(( attempt * 15 ))s"
        sleep $(( attempt * 15 ))
      done
      echo "ERROR: artifact ship failed after 3 gcloud compute scp attempts — aborting before setup-vm (old build still serving)"
      return 1
    }
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
  # v1.84.0 SECRETS: `--exclude .env` is an EXACT-NAME match, so every
  # `.env.<anything>` sailed straight through — `.env.pre-cutover-fix.bak`,
  # `.env.bak-*`, `.env.pre-v1.5.1.bak`. Measured 2026-08-13 on the
  # itsupportchicago tree: six such files, each a full copy of a live .env with
  # ~20 named provider secrets, and they were rsynced to BOTH the live and stage
  # app dirs on the production VM. `.gitignore` never protected anything here —
  # rsync does not read it. The fleet's own prescribed sweep glob (`.env.bak*`)
  # missed most of them too, so detection had the same hole as prevention.
  # `--include` MUST precede the excludes: rsync takes the FIRST matching rule.
  --include .env.example --exclude .env --exclude ".env.*" --exclude /data/
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
  # Same exact-name hole on the gcloud-iap transport (itsupportchicago), which
  # is the host the leak was measured on. GNU tar also takes the first match,
  # so the .env.example reprieve goes first.
  --exclude ./.git --exclude "node_modules" --exclude ./.next
  # v1.84.1: tar patterns with a leading `./` are ANCHORED to the archive root,
  # so v1.84.0's fix covered only top-level files — `./nested/.claude/worktrees/
  # roadmap/.env` still shipped. Demonstrated against a real tree. This is the
  # gcloud-iap transport, i.e. itsupportchicago, the exact host where six live
  # `.env` copies were found on the production VM. The unanchored `*/` patterns
  # cover every depth; rsync needs no equivalent because its patterns are
  # basename-matched at any depth already (verified).
  --exclude ./.env --exclude "./.env.*" --exclude "*/.env" --exclude "*/.env.*"
  --exclude ./data
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

# ── Local artifact build (§9.2 v1.78.0, DEPLOY_BUILD_MODE=local-artifact) ──
# The 2026-08-08 itsc outage (~5h, worst to date) proved a Next 16/Turbopack
# build is IMPOSSIBLE on the small VM: cgroup OOM at the stage cap, liveness-
# sentinel kills, earlyoom silent SIGKILLs, and two kernel-level hard hangs
# even on the resized box. In local-artifact mode the .next tree is built HERE
# on the dev box and shipped as a tarball; the VM never runs `next build`
# (stage-build.sh build refuses outright on such hosts). This block sits
# BEFORE the remote preflight on purpose: ANY local failure aborts with ZERO
# VM contact — no marker, no sync, no mutation, old build serving.
artifact_local=""
artifact_tmp=""
local_build_id=""
local_node_major=""
if [ "$build_mode" = "local-artifact" ]; then
  echo ">>> Local artifact build (DEPLOY_BUILD_MODE=local-artifact — the VM never builds)..."
  local_node_major="$(node -v | sed 's/^v//' | cut -d. -f1)"
  # ── Node-major gate FIRST (v1.78.0 fix round, H1a) ──────────────
  # Checked against the rendered EXPECTED_NODE_MAJOR (site-deploy.env,
  # OPTIONAL, default 22 — the fleet's provisioned Node) BEFORE npm ci, the
  # build, and any 2FA window or remote contact: a wrong dev shell must fail
  # in seconds with the remediation, not after minutes of build — and never
  # after a host wrapper has already opened a 2FA window or bounced pm2. The
  # VM-side parity assert below/in setup-vm stays: defense in depth.
  expected_node_major="22"
  if [ "$local_node_major" != "$expected_node_major" ]; then
    echo "ERROR: local node is v${local_node_major}.x but this host's artifact must be built under v${expected_node_major}.x (EXPECTED_NODE_MAJOR)."
    echo "       Rebuild under the expected major:"
    echo "         nvm install ${expected_node_major} && nvm exec ${expected_node_major} bash deploy/deploy.sh"
    echo "       Nothing ran: no npm ci, no build, no VM contact. Do NOT weaken this gate —"
    echo "       a cross-major .next is unproven, not proven-fine."
    exit 1
  fi
  # npm ci only when the installed tree is stale: npm stamps
  # node_modules/.package-lock.json on every install, and `npm ci` deletes
  # node_modules first — unconditional ci costs minutes per deploy for nothing.
  # The node major is part of the staleness decision (L2): a tree installed
  # under another major carries wrong-ABI native deps that a lockfile mtime
  # check can never see — the stamp file beside node_modules records the
  # major that ran the last ci, and a differing major forces a fresh ci.
  node_major_stamp="$repo_dir/node_modules/.aicompany-node-major"
  if [ ! -f "$repo_dir/node_modules/.package-lock.json" ] || \
     [ "$repo_dir/package-lock.json" -nt "$repo_dir/node_modules/.package-lock.json" ] || \
     [ "$(cat "$node_major_stamp" 2>/dev/null || true)" != "$local_node_major" ]; then
    echo ">>> npm ci --include=dev (lockfile newer than the installed tree, or node major changed)..."
    (cd "$repo_dir" && npm ci --include=dev)
    printf '%s\n' "$local_node_major" > "$node_major_stamp"
  fi
  # Fresh build every time — a stale Turbopack cache is the same class the VM
  # pipeline kills with `rm -rf stage/.next` (§9.2).
  rm -rf "$repo_dir/.next"
  echo ">>> next build (dev box, heap 8192MB)..."
  (cd "$repo_dir" && env NODE_OPTIONS=--max-old-space-size=8192 npm run build)
  [ -f "$repo_dir/.next/BUILD_ID" ] || { echo "ERROR: build produced no .next/BUILD_ID — aborting (VM untouched)"; exit 1; }
  local_build_id="$(cat "$repo_dir/.next/BUILD_ID")"
  # Relocatability gate — the local twin of stage-build verify-relocatable: a
  # build embedding THIS repo's absolute path breaks the moment it serves from
  # $app_dir on the VM. Same allowlist (required-server-files.{js,json} are the
  # two files `next build` always stamps with the project dir and `next start`
  # never reads).
  reloc_hits=$(grep -rlF --exclude-dir=cache \
      --exclude=required-server-files.js --exclude=required-server-files.json \
      "$repo_dir" "$repo_dir/.next" | head -5 || true)
  if [ -n "$reloc_hits" ]; then
    echo "ERROR: local build embeds the dev-box path $repo_dir — NOT relocatable:"
    echo "$reloc_hits"
    exit 1
  fi
  # Tar minus .next/cache (~577M -> ~305M). Member names are ./-anchored — the
  # gcloud-iap exclude caveat (tar_excludes above) applies to THIS tar too.
  artifact_tmp="$(mktemp -d)"
  artifact_local="$artifact_tmp/aiwebsite-next-artifact.tgz"
  tar czf "$artifact_local" -C "$repo_dir" --exclude='./.next/cache' ./.next
  echo "  artifact ready: $(du -h "$artifact_local" | cut -f1) build_id=$local_build_id node=v${local_node_major}.x"
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
echo "NODE_V $(command -v node >/dev/null 2>&1 && node -v || echo none)"
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
# Node-major parity precheck (v1.78.0, local-artifact only): .next output is
# portable JS but is only asserted safe across the SAME node major. Cheap
# dev-box-side check so a mismatch aborts before shipping ~305M; the
# authoritative gate re-asserts VM-side right before the flip (setup-vm). The
# NODE_V probe line is emitted for every mode and ignored in remote mode.
if [ "$build_mode" = "local-artifact" ]; then
  vm_node_v=$(printf '%s\n' "$preflight_out" | awk '/^NODE_V/{print $2; exit}')
  if [ -z "$vm_node_v" ] || [ "$vm_node_v" = "none" ]; then
    echo "NOTE: VM has no node yet (fresh provision) — setup-vm installs Node 22; parity is re-asserted VM-side before the flip."
  else
    vm_node_major="${vm_node_v#v}"; vm_node_major="${vm_node_major%%.*}"
    if [ "$vm_node_major" != "$local_node_major" ]; then
      echo "ERROR: node major mismatch — dev box v${local_node_major}.x built the artifact, VM runs ${vm_node_v}."
      echo "       Rebuild under the VM's major (e.g. nvm install ${vm_node_major} && nvm exec ${vm_node_major} bash deploy/deploy.sh)."
      echo "       Do NOT weaken this gate — a cross-major .next is unproven, not proven-fine."
      exit 1
    fi
  fi
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

# ── Artifact ship (v1.78.0) — BEFORE setup-vm, so the staged pipeline can
# extract it into $app_dir.stage/.next and the EXISTING journaled cutover
# flips node_modules + .next as ONE generation. Shipping after setup-vm would
# re-create the mixed-tree window this mode exists to kill (new modules live
# against an old .next on any post-flip ship failure). Ships to /var/tmp —
# outside the app tree, so neither sync_dir nor stage-prepare's rsync ever
# copies the ~305M tarball around.
if [ "$build_mode" = "local-artifact" ]; then
  echo ">>> Shipping .next artifact ($(du -h "$artifact_local" | cut -f1)) — scp/rsync, never a stdin pipe..."
  ship_file "$artifact_local" "/var/tmp/aiwebsite-next-artifact.tgz"
  rm -rf "$artifact_tmp"
fi

echo ">>> Running setup-vm.sh on VM (installs everything, config:check gates the PM2 reload)..."
if [ "$build_mode" = "local-artifact" ]; then
  # The expected artifact identity rides the command line (BUILD_ID is
  # base64url-safe): setup-vm hard-fails without it, so a hand-run setup-vm
  # can never silently skip the BUILD_ID/parity gates.
  run_remote "cd $app_dir && LOCAL_BUILD_ID=$local_build_id LOCAL_NODE_MAJOR=$local_node_major bash deploy/setup-vm.sh"
else
  run_remote "cd $app_dir && bash deploy/setup-vm.sh"
fi

echo ""
echo ">>> Verifying..."
# `set -o pipefail` on the REMOTE shell (v1.64.0): without it `curl … | head`
# reports head's status, so a FAILING brain health probe exited 0 and this
# verification silently passed. The remote shell does not inherit the local
# `set -euo pipefail`.
run_remote "set -o pipefail; curl -fsS http://127.0.0.1:3000/api/health && echo && curl -fsS http://127.0.0.1:3211/health | head -c 300 && echo"
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
