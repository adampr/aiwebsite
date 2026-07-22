#!/usr/bin/env bash
# aicompany-template: stage-build.sh.tpl@23e5584b608ec70a090d6e236d542e37a2bbdfb858534e23b73f4eb31dbf0c9a
set -euo pipefail
# Staged-build engine (v1.13.0, §9.2): all mutation happens in the sibling
# stage tree; the live tree changes only during a renames-only journaled flip.
# Callers: setup-vm.sh (deploy pipeline) and watchdog.sh (repair pipeline).
app="/var/www/aiwebsite"; stage="/var/www/aiwebsite.stage"
trash="$stage/.trash"; state="$stage/.cutover-state"; lockfile="$stage/.lock"

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

prepare() {
  avail_mb=$(( $(df --output=avail -k "$app" | tail -1) / 1024 ))
  [ "$avail_mb" -ge 6144 ] || { echo "ERROR: ${avail_mb}MB free < 6144MB floor (live+stage+parked generation, incl. brain's ~813M)"; exit 1; }
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
  rc=0; rsync -a --delete "${excl[@]}" "$app/" "$stage/" || rc=$?
  { [ "$rc" -eq 0 ] || [ "$rc" -eq 24 ]; } || exit "$rc"
}

install_site()  { (cd "$stage" && npm ci --include=dev); }
install_brain() { (cd "$stage/packages/brain" && npm ci --include=dev); }

refresh_modules() {  # watchdog repair: ABI-exact hardlink clone of LIVE deps, no npm
  rm -rf "$stage/node_modules"
  cp -al "$app/node_modules" "$stage/node_modules"
  rm -rf "$stage/node_modules/.cache"
}

build() {
  rm -rf "$stage/.next"   # kills the stale-Turbopack-cache class; fresh build
  # Heap cap preserved (2026-07-10 OOM invariant). oom_score_adj=900 makes the
  # BUILD the kernel's preferred OOM victim (an OOM'd build = safe pre-cutover
  # abort, never brain-api/postgres); nice/ionice keep the live server serving.
  (cd "$stage" && { echo 900 > /proc/self/oom_score_adj 2>/dev/null || true; } \
    && exec nice -n 10 ionice -c3 env NODE_OPTIONS="--max-old-space-size=1024" npm run build)
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
  check) take_lock; check ;;
  cutover) take_lock; cutover ;;           cutover-repair) take_lock; cutover_repair ;;
  rollback) take_lock; rollback ;;         purge-trash) take_lock; purge_trash ;;
  *) echo "usage: stage-build.sh heal|prepare|install|install-brain|refresh-modules|build|verify-relocatable|check|cutover|cutover-repair|rollback|purge-trash"; exit 2 ;;
esac
