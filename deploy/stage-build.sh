#!/usr/bin/env bash
# aicompany-template: stage-build.sh.tpl@e3e76d6acd6b396836891f91d29d04e1237a9c51b1e9bd121c03ace5f398de15
set -euo pipefail
# Staged-build engine (v1.13.0, §9.2): all mutation happens in the sibling
# stage tree; the live tree changes only during a renames-only journaled flip.
# Callers: setup-vm.sh (deploy pipeline) and watchdog.sh (repair pipeline).
app="/var/www/aiwebsite"; stage="/var/www/aiwebsite.stage"
trash="$stage/.trash"; state="$stage/.cutover-state"; lockfile="$stage/.lock"
# Build placement (§9.2 v1.78.0): on local-artifact hosts the VM-side build is
# REMOVED — build() below refuses structurally (see the 2026-08-08 outage).
build_mode="local-artifact"
# >>> app-user-active
# §9.10 (v1.175.0): the app account split is ACTIVE only when the rendered name
# is set AND the root-owned marker names it. This region is byte-identical in
# every template that carries it (tests/app-user-split.test.ts pins that).
app_user='aiwebsite'
app_user_marker="/etc/aiwebsite/app-user"
app_user_active() {
  [ -n "$app_user" ] || return 1
  [ -f "$app_user_marker" ] && [ ! -L "$app_user_marker" ] || return 1
  [ "$(stat -c %u "$app_user_marker" 2>/dev/null)" = "0" ] || return 1
  [ "$(head -n 1 "$app_user_marker" 2>/dev/null)" = "$app_user" ]
}
# <<< app-user-active

# Flip set = defaults (regenerated in stage) + host extras (deploy/swap-dirs.txt,
# copied live->stage as INPUTS and hook-rebuilt there). .env is deliberately
# ABSENT: the live .env is VM-owned and pinned in place by host hooks
# (itsc pin-prod-env targets the LIVE path by design); it is never flipped.
default_flip=(node_modules packages/brain/node_modules .next)
extra_flip=()
if [ -f "$app/deploy/swap-dirs.txt" ]; then
  while IFS= read -r p || [ -n "$p" ]; do
    p="${p%$'\r'}"; case "$p" in ''|'#'*) continue ;; esac
    case "$p" in /*|*..*) echo "ERROR: swap-dirs.txt entry '$p' must be a relative in-tree path"; exit 1 ;; esac
    extra_flip+=("$p")
  done < "$app/deploy/swap-dirs.txt"
fi
flip_paths=("${default_flip[@]}" "${extra_flip[@]}")

# Pipeline callers (setup-vm, watchdog) hold flock on fd 201 across their WHOLE
# pipeline and export STAGE_BUILD_LOCK_HELD=1; subcommands run under the
# inherited lock (re-flocking the caller's own fd would deadlock — the env
# sentinel is the correct mechanism). One-shot calls self-lock. flock -n:
# the loser aborts loudly, never queues. The lock lives on REAL DISK owned by
# the deploy user — no /var/run tmpfs EACCES-after-reboot class.
take_lock() {
  [ "${STAGE_BUILD_LOCK_HELD:-0}" = "1" ] && return 0
  mkdir -p "$stage"
  exec 201>"$lockfile"
  flock -n 201 || { echo "ERROR: another stage-build pipeline holds $lockfile"; exit 1; }
}

park()    { mkdir -p "$trash"; mv "$1" "$trash/$(printf %s "$2" | tr / _).$(date +%s%N).$$"; }
journal() { echo "$1 $2" >> "$state"; sync "$state"; }   # fsync'd append

# ── Memory-capped step execution (v1.15.0, §9.2) ─────────────────
# 2026-07-22 aiwebsite outage: uncapped staged npm ci ×2 + next build beside
# the resident stack pushed a swapless 3.8GB VM into near-OOM direct-reclaim
# livelock — the kernel OOM killer never fired and the whole box (sshd,
# journald, cron, cloudflared) was unschedulable for 78 minutes. Every
# memory-heavy step now runs inside a transient systemd scope with a hard
# MemoryMax (STAGE_MEM_MAX_MB, per-host site-deploy.env, render-validated
# 1024–5120) and MemorySwapMax=0: the cap must KILL an oversized step, not
# let it sprawl into swap and thrash the box — the v1.15.0 swapfile exists
# for the RESIDENT stack's cold pages, never for the build's working set.
# Deliberately NO soft high-watermark property (A2): that throttles
# indefinitely instead of failing, turning "deploy dies cleanly" into
# "deploy hangs holding the locks + marker" — the wall clock is bounded by
# timeout -k 30 1800 per step instead.
# FAIL-CLOSED: a VM where sudo -n systemd-run does not work refuses to run
# the step uncapped (setup-vm probes the same capability before any staging).
run_capped() {  # run_capped <step> <workdir> <payload...>
  local step="$1" workdir="$2"; shift 2
  local capped_user capped_path rc=0
  # Captured BEFORE sudo (A1): inside the scope $(id -un) is root — a
  # root-owned stage tree bricks every later deploy — and sudo resets PATH,
  # losing a Node-split host's toolchain prefix (roleplay's Node 22).
  capped_user=$(id -un)
  capped_path=$PATH
  if ! sudo -n systemd-run --version >/dev/null 2>&1; then
    echo "ERROR: sudo -n systemd-run unavailable — REFUSING to run '$step' uncapped (fail-closed; see MIGRATIONS.md v1.15.0 step 4)"
    exit 1
  fi
  # In-scope prologue runs as root: memory.oom.group=1 is a cgroupfs
  # attribute, NOT a systemd-run -p property (A3) — best-effort (|| true) so
  # the step's whole process tree dies together on a cgroup OOM instead of
  # leaving half a build running; then runuser drops back to the captured
  # deploy user + PATH. nice/ionice keep the live server serving;
  # oom_score_adj=900 keeps the step the kernel's preferred GLOBAL OOM victim
  # (2026-07-10 invariant). fd 200/201 closed: the capped child must never
  # inherit + pin the deploy/stage locks (B1 class).
  timeout -k 30 1800 sudo -n systemd-run --quiet --collect --scope \
    --unit="aiwebsite-stage-${step}-$$" \
    -p MemoryMax=5120M -p MemorySwapMax=0 \
    bash -c "echo 1 > /sys/fs/cgroup\$(cut -d: -f3 /proc/self/cgroup)/memory.oom.group 2>/dev/null || true; exec runuser -u $capped_user -- bash -c 'export PATH=$capped_path; cd $workdir && { echo 900 > /proc/self/oom_score_adj 2>/dev/null || true; } && exec nice -n 10 ionice -c3 $*'" \
    200>&- 201>&- || rc=$?
  if [ "$rc" -eq 137 ] || [ "$rc" -eq 143 ]; then
    if [ -f "$stage/.liveness-abort" ]; then
      echo "ERROR: step '$step' was KILLED by the deploy liveness sentinel (exit $rc):"
      echo "       the LIVE site's /api/health went dark mid-stage — the stage work was"
      echo "       starving the box. The stage tree is abandoned; the live tree is"
      echo "       untouched. Check 'free -m' and /var/log/aiwebsite-psi.log, then re-run."
    else
      echo "ERROR: step '$step' died inside its 5120M cgroup cap (exit $rc):"
      echo "       cgroup OOM (MemoryMax) or the 1800s step timeout — a pre-cutover"
      echo "       no-op; the live site keeps serving. If the build legitimately needs"
      echo "       more, raise STAGE_MEM_MAX_MB in deploy/site-deploy.env (1024–5120),"
      echo "       re-render, commit, redeploy."
    fi
    exit "$rc"
  fi
  [ "$rc" -eq 0 ] || exit "$rc"
}

heal() {
  # A journal file means a cutover/rollback died in flight -> roll it FULLY
  # BACKWARD (single deterministic policy; the caller re-runs the operation).
  # "parked <p>" is journalled BETWEEN each path's two renames, so per-path
  # state is unambiguous. After a successful flip the journal is gone — heal
  # never touches live paths post-success.
  if [ -f "$state" ]; then
    mode=$(awk '$1=="mode"{print $2}' "$state"); : "${mode:=deploy}"
    old_sfx=.old; [ "$mode" = repair ] && old_sfx=.repair-old
    while IFS=' ' read -r k p; do [ "$k" = path ] || continue
      if grep -qx "parked $p" "$state" && [ -e "$app/$p" ] && [ -e "$app/$p$old_sfx" ]; then
        park "$app/$p" "$p"; mv "$app/$p$old_sfx" "$app/$p"
      elif [ ! -e "$app/$p" ] && [ -e "$app/$p$old_sfx" ]; then
        mv "$app/$p$old_sfx" "$app/$p"
      fi
      [ -e "$app/$p.new" ] && park "$app/$p.new" "$p.new" || true
    done < "$state"
    rm -f "$state"
  fi
  for p in "${flip_paths[@]}"; do   # strays from a crash before journalling
    [ -e "$app/$p.new" ] && park "$app/$p.new" "$p.new" || true
    [ -e "$app/$p.repair-old" ] && park "$app/$p.repair-old" "$p.repair-old" || true
  done
  purge_trash                        # heal is never inside a cutover bracket
}
purge_trash() { rm -rf "$trash"; }
# >>> app-user-purge
# §9.10 (v1.175.0, refuter B1): with the app account split active, a parked
# generation holds app-account-owned .next write paths the deploy user cannot
# delete. Root deletes it, and only from inside the stage, which is 0750 and
# the deploy user's, so the app account cannot reach the tree root is deleting
# (GNU rm -rf never follows a symbolic link; fs.protected_hardlinks=1).
if app_user_active; then
  purge_trash() { chmod 0750 "$stage"; sudo -n rm -rf -- "$trash"; }
fi
# <<< app-user-purge

prepare() {
  # v1.15.0 pre-stage hygiene + floors (2026-07-22 outage, §9.2), all BEFORE
  # the rsync. (A4) reap orphaned capped scopes from a crashed or taken-over
  # run first: sudo's closefrom drops fd 201 inside the scope, so a live
  # orphan is NOT pinned by our lock and would race this fresh rsync.
  sudo -n systemctl stop "aiwebsite-stage-*.scope" 2>/dev/null || true
  rm -f "$stage/.liveness-abort"   # stale sentinel flag (A5) — never inherit an old abort verdict
  avail_mb=$(( $(df --output=avail -k "$app" | tail -1) / 1024 ))
  [ "$avail_mb" -ge 6144 ] || { echo "ERROR: ${avail_mb}MB free < 6144MB floor (live+stage+parked generation, incl. brain's ~813M)"; exit 1; }
  # Memory floor: refuse to stage on a box with no headroom — a refused
  # deploy beats a livelocked VM (deploy.sh preflights the same floor from
  # the dev box; this VM-side check also gates the watchdog's repair path).
  mem_avail_mb=$(( $(awk '/^MemAvailable:/{print $2}' /proc/meminfo) / 1024 ))
  if [ "$mem_avail_mb" -lt 1024 ]; then
    echo "ERROR: MemAvailable ${mem_avail_mb}MB < 1024MB floor — refusing to stage. Top-3 RSS:"
    ps -eo rss=,comm= --sort=-rss | head -3
    exit 1
  fi
  # Swap prerequisite: the caps + earlyoom thresholds PRESUME active swap
  # (A12 — earlyoom's both-thresholds logic never trips swapless, and a
  # swapless squeeze is exactly the 2026-07-22 livelock). setup-vm creates
  # the swapfile; a VM that lost it must not stage.
  if [ -z "$(swapon --show --noheadings 2>/dev/null)" ]; then
    echo "ERROR: no active swap (swapon --show is empty) — the v1.15.0 memory defenses require the swapfile; run deploy/setup-vm.sh or see MIGRATIONS.md v1.15.0"
    exit 1
  fi
  # Stage-internal artifacts must survive --delete: .lock is HELD on fd 201
  # right now (deleting it would let a later locker open a fresh inode and
  # acquire a second, independent lock — two pipelines interleaving).
  excl=(--exclude /.git --exclude "/data/"
        --exclude /.lock --exclude /.trash --exclude /.cutover-state)
  for p in "${default_flip[@]}"; do excl+=(--exclude "/$p"); done          # regenerated
  for p in "${flip_paths[@]}"; do excl+=(--exclude "/$p.old" --exclude "/$p.new"); done
  # Host-owned exclude list — same parser/newline/CR handling as deploy.sh
  if [ -f "$app/deploy/rsync-excludes.txt" ]; then
    while IFS= read -r pat || [ -n "$pat" ]; do
      pat="${pat%$'\r'}"; case "$pat" in ''|'#'*) continue ;; esac; excl+=(--exclude "$pat")
    done < "$app/deploy/rsync-excludes.txt"
  fi
  # Copies live .env into stage (build/migrate need env values); setup-vm
  # re-copies it AFTER the pin hook so gates see final pinned values.
  # NOTE: extra_flip trees are NOT excluded — they are inputs the host hook
  # rebuilds in stage (roleplay vendor natives). rsync 24 (files vanished:
  # live-tree writers) is tolerated; anything else aborts.
  #
  # v1.130.0 SECRETS: of the top-level env files, ONLY .env (above) and
  # .env.example (config:check requires it) are staged. A bare
  # `rsync -a --delete` carried every .env.<suffix> in the live app dir into
  # <app>.stage/: a hand-made .env.bak-* became a second full copy of the live
  # secrets on two production VMs, and the shipped .env.next (v1.117.0) got a
  # stage twin on every deploy. Nothing reads a stage .env.<suffix> — verified
  # against setup-vm.sh, deploy.sh and this file: setup-vm installs
  # "$stage_dir/.env" FROM the LIVE-dir .env.next by absolute path, .env.prev
  # exists only in the live dir, and the pin hooks edit $AICOMPANY_ENV_FILE (the
  # live-dir .env.next). The .env.next contract is untouched: it still lives in
  # the LIVE app dir. Anchored (leading /) = the transfer root only; the
  # includes precede the exclude because rsync's FIRST matching rule wins, and
  # they precede the host excludes for the same reason.
  env_filter=(--include /.env.example --include /.env --exclude '/.env.*')
  rc=0; rsync -a --delete "${env_filter[@]}" "${excl[@]}" "$app/" "$stage/" || rc=$?
  { [ "$rc" -eq 0 ] || [ "$rc" -eq 24 ]; } || exit "$rc"
  reap_stage_env_copies
  # §9.10: `rsync -a "$app/" "$stage/"` has just given the stage root the live
  # tree's mode (0775); under the split it must stay unreachable for the app account.
  if app_user_active; then chmod 0750 "$stage"; fi
}

# v1.130.0: --delete never removes an EXCLUDED path (no --delete-excluded), so
# the filter above stops new copies but would leave every copy staged before
# this release in place. Reap them: any top-level .env.<suffix> in the stage
# tree except .env.example. .env itself does not match the glob. A file that
# cannot be removed is named, never skipped silently, and does not abort the
# deploy (the filter already keeps it from being refreshed).
reap_stage_env_copies() {
  local f
  for f in "$stage"/.env.*; do
    [ -e "$f" ] || [ -L "$f" ] || continue
    [ -d "$f" ] && continue
    [ "$(basename "$f")" = ".env.example" ] && continue
    if rm -f -- "$f"; then
      echo ">>> stage: removed $(basename "$f") (a secret-shaped copy; never staged since v1.130.0)"
    else
      echo "WARN: could not remove $f — a copy of live secrets; remove it by hand"
    fi
  done
  return 0
}

install_site()  { run_capped install "$stage" npm ci --include=dev; }
install_brain() { run_capped install-brain "$stage/packages/brain" npm ci --include=dev; }

refresh_modules() {  # watchdog repair: ABI-exact hardlink clone of LIVE deps, no npm
  rm -rf "$stage/node_modules"
  cp -al "$app/node_modules" "$stage/node_modules"
  rm -rf "$stage/node_modules/.cache"
}

build() {
  # REMOVED, not tuned (v1.78.0): on a local-artifact host a VM-side
  # `next build` is the 2026-08-08 outage — cgroup OOM at the stage cap,
  # earlyoom SIGKILLs, kernel-level hard hangs. This refusal is structural:
  # it covers the deploy pipeline, the watchdog's repair rebuild (also gated
  # alert-only), and a hand-typed `bash deploy/stage-build.sh build` alike.
  if [ "$build_mode" = "local-artifact" ]; then
    echo "ERROR: DEPLOY_BUILD_MODE=local-artifact — VM-side 'next build' is REMOVED for this site."
    echo "       Build on the dev box via deploy/deploy.sh (it builds, ships the .next artifact,"
    echo "       and the staged cutover flips it atomically with node_modules)."
    exit 1
  fi
  rm -rf "$stage/.next"   # kills the stale-Turbopack-cache class; fresh build
  # Heap cap preserved (2026-07-10 OOM invariant) INSIDE the v1.15.0 cgroup
  # cap: NODE_OPTIONS bounds the V8 heap, MemoryMax bounds the whole step
  # (node native allocs, workers, subprocesses). run_capped supplies the
  # oom_score_adj=900 self-mark and the nice/ionice courtesy.
  run_capped build "$stage" env NODE_OPTIONS=--max-old-space-size=1024 npm run build
}

verify_relocatable() {
  # Relocation gate: a staged build that embeds the stage path would break the
  # moment it serves from $app. required-server-files.{js,json} are the two
  # files `next build` ALWAYS stamps with the absolute project dir; `next
  # start` never reads them (standalone/hosting-provider surface only) — the
  # empirical allowlist from the running prod .next, 2026-07-22.
  hits=$(grep -rlF --exclude-dir=cache \
           --exclude=required-server-files.js --exclude=required-server-files.json \
           "$stage" "$stage/.next" | head -5 || true)
  [ -z "$hits" ] || { echo "ERROR: staged build embeds the stage path — NOT relocatable:"; echo "$hits"; exit 1; }
}

check() { (cd "$stage" && npm run config:check); }   # MUST run after db:migrate (drift gate)

# ── Headless browser for the app's playwright-core (v1.161.0, §9.2) ──
# Hosts whose collectors drive Chromium through playwright-core (itsupportchicago,
# topmspnearme) had NO deploy-provisioned browser: itsc's was hand-installed and
# topmspnearme had none, so every nightly "succeeded" with its browser source
# logged as a launch failure. This step makes the browser part of the deploy.
#   * The version is never written here: it is the STAGE tree's installed
#     playwright-core (what goes live at cutover), and the browser comes from
#     that package's OWN installer (`playwright-core/cli.js install`), so the
#     Chromium build always matches the code that drives it — no second
#     package download from npm, no second version number to drift.
#   * Into the deploy user's ~/.cache/ms-playwright — playwright-core's default
#     when PLAYWRIGHT_BROWSERS_PATH is unset — OUTSIDE the app tree, so the
#     deploy's rsync --delete and the generation flip never touch it. The
#     deploy user owns $app; units that launch the browser must run as that
#     user (topmspnearme collect-nightly: User=adam_xl_net, the app owner).
#   * Full Chromium only (--no-shell): the hosts' browser.ts launches
#     chromium.executablePath() explicitly, never the headless shell.
#   * Disk is bounded by playwright's own GC: the LIVE tree's package is linked
#     first (a no-op download when its build is present), then the STAGE's, so
#     the GC keeps exactly the live + incoming builds — the N-1 generation a
#     health-gate rollback restores still finds its browser — and deletes older
#     builds. A 2048MB free-disk floor is checked before any download.
#   * Memory is bounded by run_capped (MemoryMax, 1800s timeout, sentinel-
#     covered scope); the system libraries go in through playwright's own
#     install-deps as root (apt), ONLY when ldd shows the binary cannot load —
#     a host whose browser already runs (itsc) is a no-op.
#   * NON-FATAL by design: a CDN or apt outage must not block an app deploy
#     (the apt-get-update precedent in setup-vm). setup-vm calls this with
#     `|| echo WARN` and the WARN names what is missing.
browser() {
  local pw_rel=node_modules/playwright-core pw_ver live_ver exe missing home_dir browsers_dir free_mb node_bin
  if [ ! -f "$stage/$pw_rel/package.json" ]; then
    echo ">>> browser: no playwright-core in the staged app — nothing to provision"
    return 0
  fi
  pw_ver=$(node -p "require('$stage/$pw_rel/package.json').version")
  home_dir=$(getent passwd "$(id -un)" | cut -d: -f6)
  browsers_dir="$home_dir/.cache/ms-playwright"
  echo ">>> browser: playwright-core $pw_ver (staged) -> $browsers_dir (user $(id -un))"
  mkdir -p "$browsers_dir"
  free_mb=$(( $(df --output=avail -k "$browsers_dir" | tail -1) / 1024 ))
  if [ "$free_mb" -lt 2048 ]; then
    echo "ERROR: browser: ${free_mb}MB free under $browsers_dir < 2048MB floor — not downloading"
    exit 1
  fi
  # Live first (links its build for the GC; downloads only if it is missing),
  # then stage. PLAYWRIGHT_BROWSERS_PATH is pinned to the default path so the
  # sudo'd scope (env reset) and the unit (systemd HOME) resolve the same dir.
  if [ -f "$app/$pw_rel/package.json" ]; then
    live_ver=$(node -p "require('$app/$pw_rel/package.json').version")
    echo ">>> browser: linking the live tree's playwright-core $live_ver"
    run_capped browser-live "$app" env PLAYWRIGHT_BROWSERS_PATH=$browsers_dir node $pw_rel/cli.js install --no-shell --no-progress chromium
  fi
  run_capped browser "$stage" env PLAYWRIGHT_BROWSERS_PATH=$browsers_dir node $pw_rel/cli.js install --no-shell --no-progress chromium
  exe=$(cd "$stage" && PLAYWRIGHT_BROWSERS_PATH="$browsers_dir" node -e 'process.stdout.write(require("playwright-core").chromium.executablePath())')
  if [ ! -x "$exe" ]; then
    echo "ERROR: browser: $exe is not an executable after install"
    exit 1
  fi
  missing=$(ldd "$exe" 2>/dev/null | grep -c 'not found' || true)
  if [ "$missing" -gt 0 ]; then
    echo ">>> browser: $missing shared libraries missing — playwright install-deps chromium (apt, as root, capped)"
    node_bin=$(command -v node)
    timeout -k 30 1800 sudo -n systemd-run --quiet --collect --scope \
      --unit="aiwebsite-stage-browser-deps-$$" -p MemoryMax=5120M \
      env DEBIAN_FRONTEND=noninteractive "$node_bin" "$stage/$pw_rel/cli.js" install-deps chromium \
      200>&- 201>&-
    missing=$(ldd "$exe" 2>/dev/null | grep -c 'not found' || true)
    if [ "$missing" -gt 0 ]; then
      echo "ERROR: browser: still $missing missing shared libraries after install-deps:"
      ldd "$exe" | grep 'not found' | head -5
      exit 1
    fi
  else
    echo ">>> browser: system libraries present (ldd clean) — install-deps skipped"
  fi
  echo ">>> browser: executable $exe"
  echo ">>> browser: version $("$exe" --version 2>&1 | head -1)"
}

cutover() {   # deploy mode: RENAMES ONLY (~ms). Full flip set required.
  for p in "${flip_paths[@]}"; do
    [ -e "$stage/$p" ] || { echo "ERROR: $stage/$p not staged — deploy cutover needs the complete set"; exit 1; }
  done
  # 1. park the N-1 rollback set -> trash (rename; DELETION deferred to purge-trash)
  for p in "${flip_paths[@]}"; do [ -e "$app/$p.old" ] && park "$app/$p.old" "$p.old" || true; done
  # 2. pre-position candidates (park any stray .new — rename guard, never rm/nest)
  for p in "${flip_paths[@]}"; do
    [ -e "$app/$p.new" ] && park "$app/$p.new" "$p.new" || true
    mv "$stage/$p" "$app/$p.new"
  done
  # 3. journaled flips: rename(2) preserves inodes, open fds unaffected
  { echo "mode deploy"; for p in "${flip_paths[@]}"; do echo "path $p"; done; } > "$state"; sync "$state"
  for p in "${flip_paths[@]}"; do
    mv "$app/$p" "$app/$p.old"; journal parked "$p"; mv "$app/$p.new" "$app/$p"
  done
  rm -f "$state"    # journal gone => heal will never touch live paths again
}

cutover_repair() {  # watchdog: flip ONLY .next; the deploy .old generation UNTOUCHED
  p=.next
  [ -e "$stage/$p" ] || { echo "ERROR: no staged .next"; exit 1; }
  [ -e "$app/$p.new" ] && park "$app/$p.new" "$p.new" || true
  mv "$stage/$p" "$app/$p.new"
  { echo "mode repair"; echo "path $p"; } > "$state"; sync "$state"
  mv "$app/$p" "$app/$p.repair-old"; journal parked "$p"; mv "$app/$p.new" "$app/$p"
  rm -f "$state"
  park "$app/$p.repair-old" "$p.repair-old"   # displaced build -> trash; .next.old preserved
}

rollback() {  # manual or health-gate; refuses mixed/incomplete generations
  [ -f "$state" ] && { echo "ERROR: interrupted cutover journal present — run heal first"; exit 1; }
  for p in "${flip_paths[@]}"; do
    [ -e "$app/$p.old" ] || { echo "ERROR: $p.old missing — refusing a mixed-generation rollback"; exit 1; }
  done
  { echo "mode deploy"; for p in "${flip_paths[@]}"; do echo "path $p"; done; } > "$state"; sync "$state"
  for p in "${flip_paths[@]}"; do
    [ -e "$app/$p.new" ] && park "$app/$p.new" "$p.new" || true
    mv "$app/$p" "$app/$p.new"          # bad candidate kept for forensics (trash-parked on next heal)
    journal parked "$p"; mv "$app/$p.old" "$app/$p"
  done
  rm -f "$state"
}

case "${1:-}" in
  heal) take_lock; heal ;;                 prepare) take_lock; heal; prepare ;;
  install) take_lock; install_site ;;      install-brain) take_lock; install_brain ;;
  refresh-modules) take_lock; refresh_modules ;;
  build) take_lock; build ;;               verify-relocatable) take_lock; verify_relocatable ;;
  check) take_lock; check ;;               browser) take_lock; browser ;;
  cutover) take_lock; cutover ;;           cutover-repair) take_lock; cutover_repair ;;
  rollback) take_lock; rollback ;;         purge-trash) take_lock; purge_trash ;;
  *) echo "usage: stage-build.sh heal|prepare|install|install-brain|refresh-modules|build|verify-relocatable|check|browser|cutover|cutover-repair|rollback|purge-trash"; exit 2 ;;
esac
