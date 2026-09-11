#!/usr/bin/env bash
# Tests for scripts/deploy-safe.sh, the guarded deploy wrapper.
#
#   bash scripts/deploy-safe-tests.sh
#
# NO VM, NO NETWORK, NO REAL DEPLOY. Each case builds a throwaway git repo in
# a temp dir, copies the real wrapper into it, and puts two stubs in front of
# the two things the wrapper reaches for:
#
#   * deploy/deploy.sh  - records the argv and DEPLOY_ALLOW_DIRTY it was given,
#                         then exits STUB_DEPLOY_RC.
#   * ssh (on PATH)     - serves a file that stands in for the VM's
#                         ~/.aiwebsite-deploy-commit marker, and captures the
#                         marker the wrapper writes back after a success.
#                         The registry seed pre-pass (section 6b, 2026-09-10)
#                         is served SEPARATELY: the stub runs the wrapper's
#                         REAL remote body against a fake app dir
#                         ($vmapp), so SSH_STUB_MODE governs the marker
#                         traffic only and SSH_STUB_REGISTRY_MODE the pre-pass.
#   * sudo (on PATH)    - drops -n/-u and runs the rest (the pre-pass's
#                         fresh-VM branch creates the app dir with sudo -n).
#
# What this CANNOT cover, and only a real deploy can: that the marker path is
# writable by the deploy user on the VM, that the marker survives a real
# rsync --delete of $app_dir (it lives in $HOME precisely so it does), and the
# real ssh timeout behaviour against a livelocked box.
set -uo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
wrapper="$root/scripts/deploy-safe.sh"
tmp_root="$(mktemp -d)"
trap 'rm -rf "$tmp_root"' EXIT

pass=0
fail=0
case_name=""

note()  { printf '  %s\n' "$1"; }
start() { case_name="$1"; printf '\n== %s\n' "$1"; }
ok()    { pass=$((pass+1)); printf '  ok   %s\n' "$1"; }
bad()   { fail=$((fail+1)); printf '  FAIL %s\n' "$1"; }

assert_rc() { # want, got, label
  if [ "$1" = "$2" ]; then ok "$3 (rc=$2)"; else bad "$3: wanted rc=$1, got rc=$2"; fi
}
assert_has() { # haystack, needle, label
  if printf '%s' "$1" | grep -qF -- "$2"; then ok "$3"; else
    bad "$3: output did not contain: $2"
    printf '%s\n' "$1" | sed 's/^/       | /' | head -40
  fi
}
assert_hasnt() { # haystack, needle, label
  if printf '%s' "$1" | grep -qF -- "$2"; then
    bad "$3: output unexpectedly contained: $2"
  else ok "$3"; fi
}
assert_count() { # haystack, needle, want, label
  local got; got="$(printf '%s\n' "$1" | grep -cF -- "$2")"
  if [ "$got" = "$3" ]; then ok "$4"; else bad "$4: wanted $3 line(s) with '$2', got $got"; fi
}

# ── fixture ──────────────────────────────────────────────────────
# Builds $work/repo with `n` commits and returns with $repo/$bin/$marker set.
repo=""; bin=""; marker=""; ranfile=""; vmapp=""
# A registry SHAPED like a real one: `.models` an array of $1 curated rows
# (brain's rule: `provenance`, else "no aa_slug = curated"). The pre-pass's
# validity predicate needs >= 10 curated rows on BOTH sides, dev box and VM, so
# every fixture registry here is built through this helper and `mkreg 3` /
# `mkreg 0` are how a DEGENERATE one is made.
mkreg() { # curated-rows marker
  local n="$1" m="$2" i rows=""
  for i in $(seq 1 "$n"); do rows="$rows${rows:+,}{\"id\":\"m$i\",\"provenance\":\"curated\"}"; done
  printf '{"updated_at":"2026-09-10T16:17:18.021Z","marker":"%s","models":[%s]}\n' "$m" "$rows"
}
mkfixture() { # commits
  local n="${1:-3}" i
  local work; work="$(mktemp -d "$tmp_root/caseXXXX")"
  repo="$work/repo"; bin="$work/bin"; marker="$work/vm-marker"; ranfile="$work/deploy-ran"
  vmapp="$work/vm-app"
  mkdir -p "$repo/scripts" "$repo/deploy" "$bin"
  # The fake VM app dir already holds a REAL registry (the steady state on every
  # real host); the pre-pass cases below remove it, degrade it, or remove the
  # whole app dir.
  mkdir -p "$vmapp/packages/brain/data"
  mkreg 12 vm-own > "$vmapp/packages/brain/data/model-registry.json"
  cp "$wrapper" "$repo/scripts/deploy-safe.sh"

  cat > "$repo/deploy/deploy.sh" <<'STUB'
#!/usr/bin/env bash
{
  echo "ARGS:$*"
  echo "DIRTY_ENV:${DEPLOY_ALLOW_DIRTY:-unset}"
} >> "$DEPLOY_RAN_FILE"
echo ">>> stub deploy.sh ran"
exit "${STUB_DEPLOY_RC:-0}"
STUB

  cat > "$repo/deploy/site-deploy.env" <<CFG
SLUG=aiwebsite
APP_DIR=$vmapp
DEPLOY_TRANSPORT=ssh-key
SSH_KEY_PATH=$work/fake-key
CFG

  : > "$work/fake-key"
  cat > "$repo/.env" <<ENVF
AIWEBSITE_SSH_IP=203.0.113.9
AIWEBSITE_USER=deployuser
AIWEBSITE_SSH_KEY=$work/fake-key
ENVF
  printf '.env\n' > "$repo/.gitignore"

  # ssh stub: last argument is the remote command.
  cat > "$bin/ssh" <<'SSHSTUB'
#!/usr/bin/env bash
cmd="${!#}"
# Ordinary remote/ssh chatter on stderr, e.g. the accept-new host-key warning
# or a remote locale warning. It must never reach the marker body.
if [ -n "${SSH_STUB_NOISE:-}" ]; then printf '%s\n' "$SSH_STUB_NOISE" >&2; fi
# Registry seed pre-pass: run the wrapper's real remote body locally.
case "$cmd" in
  *REGISTRY_STATE*|*SEED_RESULT*)
    case "${SSH_STUB_REGISTRY_MODE:-ok}" in
      fail) echo "ssh: connect to host 203.0.113.9 port 22: Connection timed out" >&2; exit 255 ;;
      corrupt) { cat; echo corrupt; } | bash -c "$cmd"; exit $? ;;
      race)
        # A real registry appears between the probe and the push.
        case "$cmd" in *SEED_RESULT*) mkreg 11 raced > "$SSH_STUB_VMREG" ;; esac
        exec bash -c "$cmd" ;;
      lostpush)
        # The push LANDS and only its answer is lost (a tunnel dropped after the
        # remote side finished). The probe still answers normally, so the
        # wrapper's wording -- never "nothing was placed" -- is what is on test.
        case "$cmd" in
          *SEED_RESULT*) bash -c "$cmd" >/dev/null 2>&1; exit 0 ;;
          *) exec bash -c "$cmd" ;;
        esac ;;
      *) exec bash -c "$cmd" ;;
    esac ;;
esac
if [ "${SSH_STUB_MODE:-ok}" = "fail" ]; then
  echo "ssh: connect to host 203.0.113.9 port 22: Connection timed out" >&2
  exit 255
fi
case "$cmd" in
  "cat > "*) cat > "$SSH_STUB_MARKER"; exit 0 ;;
  *)
    if [ -s "$SSH_STUB_MARKER" ]; then cat "$SSH_STUB_MARKER"; else echo "__NO_MARKER__"; fi
    exit 0 ;;
esac
SSHSTUB
  cat > "$bin/sudo" <<'SUDOSTUB'
#!/usr/bin/env bash
while :; do case "${1:-}" in -n) shift ;; -u) shift 2 ;; *) break ;; esac; done
exec "$@"
SUDOSTUB
  # mkreg, on PATH, so the ssh stub's `race` mode can drop a REAL registry on
  # the fake VM (a degenerate one would be refused, which is a different case).
  cat > "$bin/mkreg" <<'MKREG'
#!/usr/bin/env bash
n="$1"; m="$2"; rows=""
for i in $(seq 1 "$n"); do rows="$rows${rows:+,}{\"id\":\"m$i\",\"provenance\":\"curated\"}"; done
printf '{"updated_at":"2026-09-10T16:17:18.021Z","marker":"%s","models":[%s]}\n' "$m" "$rows"
MKREG
  chmod +x "$bin/ssh" "$bin/sudo" "$bin/mkreg" "$repo/deploy/deploy.sh"

  git -C "$repo" init -q
  git -C "$repo" config user.email "deploy-tests@example.invalid"
  git -C "$repo" config user.name "Deploy Tests"
  git -C "$repo" config commit.gpgsign false
  for i in $(seq 1 "$n"); do
    printf 'round %s\n' "$i" > "$repo/round$i.txt"
    git -C "$repo" add -A
    git -C "$repo" commit -q -m "feat(round$i): change number $i"
  done
  : > "$ranfile"
}

out=""; rc=0
run() { # args...
  out="$(cd "$repo" && env PATH="$bin:$PATH" \
        DEPLOY_RAN_FILE="$ranfile" \
        SSH_STUB_MARKER="$marker" \
        SSH_STUB_MODE="${SSH_STUB_MODE:-ok}" \
        SSH_STUB_NOISE="${SSH_STUB_NOISE:-}" \
        SSH_STUB_REGISTRY_MODE="${SSH_STUB_REGISTRY_MODE:-ok}" \
        SSH_STUB_VMREG="${SSH_STUB_VMREG:-}" \
        DEPLOY_SAFE_REG_RETRY_SLEEP=0 \
        STUB_DEPLOY_RC="${STUB_DEPLOY_RC:-0}" \
        bash scripts/deploy-safe.sh "$@" 2>&1)"
  rc=$?
}
# Same run, but keeping ONLY stderr. The banner goes to stdout and the refusal
# to stderr, so this is what a caller that logs the two separately sees.
err=""
run_err() { # args...
  err="$( (cd "$repo" && env PATH="$bin:$PATH" \
        DEPLOY_RAN_FILE="$ranfile" \
        SSH_STUB_MARKER="$marker" \
        SSH_STUB_MODE="${SSH_STUB_MODE:-ok}" \
        SSH_STUB_NOISE="${SSH_STUB_NOISE:-}" \
        SSH_STUB_REGISTRY_MODE="${SSH_STUB_REGISTRY_MODE:-ok}" \
        SSH_STUB_VMREG="${SSH_STUB_VMREG:-}" \
        DEPLOY_SAFE_REG_RETRY_SLEEP=0 \
        STUB_DEPLOY_RC="${STUB_DEPLOY_RC:-0}" \
        bash scripts/deploy-safe.sh "$@" 2>&1 1>/dev/null) )"
  rc=$?
}
sha()  { git -C "$repo" rev-parse "$1"; }
shrt() { git -C "$repo" rev-parse --short "$1"; }
set_marker() { printf '%s\n# deployed_at: 2026-08-29T09:00:00Z\n' "$(sha "$1")" > "$marker"; }
deploy_ran()  { grep -q '^ARGS:' "$ranfile"; }

# ── 1. baseline equals HEAD: nothing new, no acknowledgement ─────
start "marker == HEAD: no ack required, deploy runs"
mkfixture 3; set_marker HEAD
run
assert_rc 0 "$rc" "deploy allowed"
assert_has "$out" "NEW       : nothing" "says nothing new ships"
if deploy_ran; then ok "deploy.sh ran"; else bad "deploy.sh did not run"; fi
assert_has "$(cat "$marker")" "$(sha HEAD)" "marker re-stamped with HEAD"

# ── 2. three commits ahead, no --ack: refused, subjects printed ──
start "3 commits beyond the VM without --ack: refused"
mkfixture 4; set_marker HEAD~3
run
assert_rc 1 "$rc" "refused"
assert_has "$out" "NEW       : 3 commit(s)" "counts the new commits"
assert_has "$out" "change number 2" "prints subject 2"
assert_has "$out" "change number 3" "prints subject 3"
assert_has "$out" "change number 4" "prints subject 4"
# "change number 1" is the commit the VM already has: it must appear ONCE, on
# the "live now" line, and never inside the NEW list.
assert_count "$out" "change number 1" 1 "the already-live commit is named once, as the baseline"
assert_has "$out" "--ack=$(shrt HEAD)" "suggests the exact ack command"
assert_has "$out" "DEPLOY REFUSED" "refusal banner"
if deploy_ran; then bad "deploy.sh ran despite the refusal"; else ok "deploy.sh never ran"; fi
assert_has "$(cat "$marker")" "$(sha HEAD~3)" "marker untouched by a refusal"

# ── 3. the same run with the right --ack proceeds ────────────────
start "correct --ack: deploy proceeds"
mkfixture 4; set_marker HEAD~3
run "--ack=$(shrt HEAD)"
assert_rc 0 "$rc" "deploy allowed"
assert_has "$out" "Acknowledged: 3 new" "acknowledgement recorded in the log"
if deploy_ran; then ok "deploy.sh ran"; else bad "deploy.sh did not run"; fi
assert_hasnt "$(cat "$ranfile")" "--ack" "--ack is consumed, not forwarded"

# ── 4. an --ack for the wrong commit is refused ──────────────────
start "stale --ack (HEAD moved): refused"
mkfixture 4; set_marker HEAD~3
run "--ack=$(shrt HEAD~1)"
assert_rc 1 "$rc" "refused"
assert_has "$out" "but HEAD is now $(shrt HEAD)" "names the drift"
if deploy_ran; then bad "deploy.sh ran"; else ok "deploy.sh never ran"; fi

# ── 5. a symbolic --ack is refused (it would acknowledge nothing) ─
start "--ack=HEAD: refused as a name, not a sha"
mkfixture 4; set_marker HEAD~3
run "--ack=HEAD"
assert_rc 1 "$rc" "refused"
assert_has "$out" "not a name like 'HEAD'" "explains why a name is not an ack"

# ── 6. --ack without a value ─────────────────────────────────────
start "--ack with no value: refused with the right form"
mkfixture 4; set_marker HEAD~3
run "--ack"
assert_rc 1 "$rc" "refused"
assert_has "$out" "--ack needs the sha" "says what to type"

# ── 7. a stale --ack is not echoed back into the suggestion ──────
start "refusal suggestion carries the fresh sha and the passthru flags only"
mkfixture 4; set_marker HEAD~3
run "--ack=$(shrt HEAD~1)" "--takeover"
assert_has "$out" "--ack=$(shrt HEAD) --takeover" "suggestion = fresh ack + original flags"
assert_hasnt "$out" "--ack=$(shrt HEAD) --ack" "the stale ack is not re-issued"

# ── 8. ssh unreachable: degrade loudly, never refuse ─────────────
# The MARKER traffic fails here; the registry seed pre-pass is served
# separately (see the stub) and still answers "present", so this case keeps
# testing the section-3 degrade path on its own. Total ssh loss — where the
# pre-pass refuses before deploy.sh — is case 22d below.
start "ssh failure on the marker read: unknown baseline, deploy still allowed"
mkfixture 3; set_marker HEAD~2
SSH_STUB_MODE=fail run
SSH_STUB_MODE=ok
assert_rc 0 "$rc" "deploy allowed"
assert_has "$out" "live now  : UNKNOWN" "says the baseline is unknown"
assert_has "$out" "could not read" "names the reason"
assert_has "$out" "change number 3" "still lists recent commits"
assert_has "$out" "writing ~/.aiwebsite-deploy-commit failed" "warns that the post-deploy stamp failed"
assert_has "$out" "Nothing is wrong with the site" "does not turn a marker failure into an alarm"
if deploy_ran; then ok "deploy.sh ran"; else bad "deploy.sh did not run"; fi

# ── 9. first run ever: no marker on the VM ───────────────────────
start "no marker yet (first run): deploy allowed, marker created"
mkfixture 3; : > "$marker"
run
assert_rc 0 "$rc" "deploy allowed"
assert_has "$out" "carries no" "explains the missing marker"
assert_has "$out" "No acknowledgement is required" "does not block the first run"
assert_has "$(cat "$marker")" "$(sha HEAD)" "marker created at HEAD"
assert_has "$(cat "$marker")" "# dirty: no" "marker records the tree state"

# ── 10. rollback: the VM has commits HEAD does not ───────────────
start "deploying an older commit: the removed commits are named"
mkfixture 4; set_marker HEAD
git -C "$repo" checkout -q HEAD~2
run
assert_rc 1 "$rc" "refused without an ack"
assert_has "$out" "REMOVED   : 2 commit(s)" "counts what would be rolled back"
assert_has "$out" "ROLLS THEM BACK" "says it plainly"
assert_has "$out" "change number 4" "names a commit that would disappear"

# ── 11. the dirty-tree refusal still works ───────────────────────
start "dirty tree: refused before anything else"
mkfixture 2; set_marker HEAD
echo "half a feature" > "$repo/wip.txt"
run
assert_rc 1 "$rc" "refused"
assert_has "$out" "DEPLOY REFUSED" "refusal banner"
assert_has "$out" "wip.txt" "names the offending path"
assert_has "$out" "another session is mid-flight" "keeps the shared-checkout warning"
if deploy_ran; then bad "deploy.sh ran on a dirty tree"; else ok "deploy.sh never ran"; fi

# ── 12. --dirty-ok still works, and still exports the env escape ─
start "--dirty-ok: ships, consumed locally, exports DEPLOY_ALLOW_DIRTY=1"
mkfixture 2; set_marker HEAD
echo "deliberate" > "$repo/wip.txt"
run "--dirty-ok"
assert_rc 0 "$rc" "deploy allowed"
assert_has "$out" "uncommitted path(s) WILL ship" "says what the escape does"
assert_has "$(cat "$ranfile")" "DIRTY_ENV:1" "DEPLOY_ALLOW_DIRTY exported to deploy.sh"
assert_hasnt "$(cat "$ranfile")" "--dirty-ok" "--dirty-ok consumed, not forwarded"
assert_has "$(cat "$marker")" "# dirty: yes" "marker records that a dirty tree shipped"

# ── 13. unknown flags are forwarded verbatim ─────────────────────
start "passthru: --takeover and --allow-sshpass reach deploy.sh"
mkfixture 2; set_marker HEAD
run "--takeover" "--allow-sshpass"
assert_rc 0 "$rc" "deploy allowed"
assert_has "$(cat "$ranfile")" "ARGS:--takeover --allow-sshpass" "argv forwarded in order"

# ── 14. a failed deploy must not stamp the marker ────────────────
start "deploy.sh exits 3: status propagated, marker left alone"
mkfixture 3; set_marker HEAD~2
STUB_DEPLOY_RC=3 run "--ack=$(shrt HEAD)"
STUB_DEPLOY_RC=0
assert_rc 3 "$rc" "exit status propagated verbatim"
assert_has "$(cat "$marker")" "$(sha HEAD~2)" "marker still names the commit that is really live"
assert_hasnt "$(cat "$marker")" "$(sha HEAD)" "the failed commit was not recorded as live"

# ── 15. an unpushed HEAD still only warns ────────────────────────
start "unpushed commits: warning, not a refusal"
mkfixture 2; set_marker HEAD
bare="$tmp_root/origin.git"; rm -rf "$bare"; git init -q --bare "$bare"
git -C "$repo" remote add origin "$bare"
git -C "$repo" push -q origin "HEAD:refs/heads/$(git -C "$repo" rev-parse --abbrev-ref HEAD)"
echo "local only" > "$repo/late.txt"
git -C "$repo" add -A; git -C "$repo" commit -q -m "feat(late): not pushed yet"
set_marker HEAD~1
run "--ack=$(shrt HEAD)"
assert_rc 0 "$rc" "deploy allowed"
assert_has "$out" "not pushed to origin" "still warns about unpushed work"

# ── 16. commits by another identity are called out ───────────────
start "a commit by a different author identity is flagged"
mkfixture 2; set_marker HEAD
echo "theirs" > "$repo/theirs.txt"
git -C "$repo" add -A
git -C "$repo" -c user.email="other-session@example.invalid" \
  -c user.name="Other Session" commit -q -m "feat(other): somebody else's round"
run
assert_rc 1 "$rc" "refused"
assert_has "$out" "authored under other identities" "flags the foreign identity"
assert_has "$out" "other-session@example.invalid" "names it"
assert_has "$out" "authorship does NOT tell you" "still says authorship is weak evidence"

# ── 17. ssh stderr noise must not switch the gate off ────────────
# Regression: the marker read used `2>&1`, so one line of ssh or remote-shell
# stderr became line 1 of the "marker", failed the sha test and dropped the
# run into the degrade-open path -- deploy ships, no ack, and the printed
# reason blames a marker file that is perfectly intact. The likeliest trigger
# is this wrapper's own StrictHostKeyChecking=accept-new after a VM rebuild,
# i.e. exactly the --takeover recovery the degrade path exists to protect.
start "ssh stderr noise does not disable the commit gate"
mkfixture 4; set_marker HEAD~3
SSH_STUB_NOISE="Warning: Permanently added '203.0.113.9' (ED25519) to the list of known hosts." run
SSH_STUB_NOISE=""
assert_rc 1 "$rc" "still refused"
assert_has "$out" "NEW       : 3 commit(s)" "the baseline was still read"
assert_hasnt "$out" "live now  : UNKNOWN" "did not degrade to an unknown baseline"
if deploy_ran; then bad "deploy.sh ran despite the refusal"; else ok "deploy.sh never ran"; fi

start "a locale warning on stderr does not disable the gate either"
mkfixture 4; set_marker HEAD~3
SSH_STUB_NOISE="perl: warning: Setting locale failed." run
SSH_STUB_NOISE=""
assert_rc 1 "$rc" "still refused"
assert_has "$out" "NEW       : 3 commit(s)" "the baseline was still read"

# ── 18. an oversized marker must degrade, never die silently ─────
# Regression: `printf | head -1` under `set -o pipefail` made printf take
# SIGPIPE once the body passed the 64 KiB pipe buffer, errexit killed the
# wrapper at an assignment, and the run exited 141 with NO banner and NO
# refusal text -- a hard stop in the path that is designed never to refuse.
start "a 70 KB marker body degrades loudly instead of exiting 141"
mkfixture 4; set_marker HEAD~3
{ cat "$marker"; head -c 70000 /dev/zero | tr '\0' '#'; printf '\n'; } > "$marker.big"
mv "$marker.big" "$marker"
run
assert_rc 1 "$rc" "refused (the sha is still the first sha-shaped line)"
assert_has "$out" "WHAT THIS DEPLOY PUTS ON" "printed its banner"
assert_hasnt "$out" "Deploying from a clean tree" "did not hand over"

start "a marker whose only sha-shaped line is not first is still read"
mkfixture 4; set_marker HEAD~3
{ printf 'MOTD: welcome to the box\n'; cat "$marker"; } > "$marker.x"; mv "$marker.x" "$marker"
run
assert_rc 1 "$rc" "refused"
assert_has "$out" "NEW       : 3 commit(s)" "found the sha below the noise line"

# ── 19. the refusal must carry its own evidence ──────────────────
# The banner goes to stdout and `fail` writes to stderr, so a caller keeping
# only stderr used to see the ready-to-run --ack bypass with none of the
# commits it was bypassing.
start "the refusal repeats the commit list on stderr"
mkfixture 4; set_marker HEAD~3
run_err
assert_rc 1 "$rc" "refused"
assert_has "$err" "--ack=$(shrt HEAD)" "stderr carries the override"
assert_has "$err" "change number 4" "stderr also carries the commit it is guarding"
assert_has "$err" "change number 2" "and the rest of the list"

start "a rollback refusal names the commits it would remove, on stderr"
mkfixture 4; set_marker HEAD
git -C "$repo" reset -q --hard HEAD~2
run_err
assert_rc 1 "$rc" "refused"
assert_has "$err" "would ROLL BACK" "says it is a rollback"
assert_has "$err" "change number 4" "names the commit that would disappear"

# ── 20. a dirty deploy must not be logged as a clean one ─────────
start "--dirty-ok never writes 'clean tree' into the deploy log"
mkfixture 3; set_marker HEAD
echo "uncommitted" > "$repo/scratch.txt"
run --dirty-ok
assert_rc 0 "$rc" "deploy allowed"
assert_has "$out" "Deploying a DIRTY tree" "names what it is really shipping"
assert_hasnt "$out" "Deploying from a clean tree" "does not also claim a clean tree"
assert_has "$out" "uncommitted path(s) WILL ship" "still spells out the consequence"

# ── 21. an ungated deploy announces itself ───────────────────────
# Nine conditions ship completely ungated by design. Each is correct; being
# silent about it is not, because a gate dead for weeks looked exactly like a
# gate that was working.
start "an UNKNOWN baseline is announced after the deploy, not just before"
mkfixture 3; : > "$marker"
run
assert_rc 0 "$rc" "deploy allowed (degrade never refuses)"
assert_has "$out" "live now  : UNKNOWN" "warned before"
assert_has "$out" "shipped with an UNKNOWN baseline" "and warned again after it shipped"
if deploy_ran; then ok "deploy.sh still ran"; else bad "deploy.sh did not run"; fi

start "a gated deploy does NOT raise the ungated warning"
mkfixture 3; set_marker HEAD
run
assert_rc 0 "$rc" "deploy allowed"
assert_hasnt "$out" "shipped with an UNKNOWN baseline" "no false ungated warning"

# ── 22. registry seed pre-pass (section 6b, 2026-09-10; hardened 2026-09-11) ──
# deploys no longer ship packages/brain/data/model-registry.json (it is
# brain-api's runtime state); the pre-pass seeds the COMMITTED PIN's blob only
# onto a VM that has none, never overwrites, refuses a DEGENERATE copy rather
# than replacing it, and refuses when it cannot tell.
vmreg() { printf '%s' "$vmapp/packages/brain/data/model-registry.json"; }
# A brain "submodule" whose three registries all differ, which is the whole
# point of the B1 case: the COMMITTED PIN (what must be seeded), the submodule's
# own checked-out HEAD one commit later (what the first draft seeded), and an
# uncommitted working-copy edit on top (what a naive `cat` would seed).
# $1 picks what the PIN holds: good (12 curated rows) | empty (0 bytes) |
# notregistry (valid JSON, `.models` empty). The submodule HEAD is always a real
# registry, so a refusal in the empty/notregistry cases can only come from the
# pin being validated -- not from there being no registry anywhere.
mkbrain() { # pin-kind
  local kind="${1:-good}"
  mkdir -p "$repo/packages/brain/data"
  git -C "$repo/packages/brain" init -q
  git -C "$repo/packages/brain" config user.email "deploy-tests@example.invalid"
  git -C "$repo/packages/brain" config user.name "Deploy Tests"
  git -C "$repo/packages/brain" config commit.gpgsign false
  case "$kind" in
    empty)       : > "$repo/packages/brain/data/model-registry.json" ;;
    notregistry) mkreg 0 PINNED-BUT-EMPTY > "$repo/packages/brain/data/model-registry.json" ;;
    *)           mkreg 12 PINNED > "$repo/packages/brain/data/model-registry.json" ;;
  esac
  git -C "$repo/packages/brain" add -A
  git -C "$repo/packages/brain" commit -q -m "brain at the pin"
  # The gitlink the OUTER repo records at HEAD. This is the pin the pre-pass
  # must read through; `git add` of a nested repo records mode 160000.
  git -C "$repo" add packages/brain 2>/dev/null
  git -C "$repo" commit -q -m "chore(brain): pin"
  # A moved submodule HEAD is a dirty gitlink in the outer repo, which the
  # section-1 gate would refuse; every real host carries exactly this state
  # while a pin bump is in flight, so the fixture silences it the way a real
  # operator would have to rather than avoiding the case.
  git -C "$repo" config diff.ignoreSubmodules all
  mkreg 12 SUBMODULE-HEAD > "$repo/packages/brain/data/model-registry.json"
  git -C "$repo/packages/brain" add -A
  git -C "$repo/packages/brain" commit -q -m "brain one commit past the pin"
  printf '{"updated_at":"DEV-BOX-EDIT","models":[]}\n' > "$repo/packages/brain/data/model-registry.json"
}

start "22a registry present and valid on the VM: left alone, never pushed, deploy runs"
mkfixture 2; set_marker HEAD
before="$(cat "$(vmreg)")"
run
assert_rc 0 "$rc" "deploy allowed"
assert_has "$out" "VM already has packages/brain/data/model-registry.json" "reports the VM's copy"
assert_has "$out" "12 curated" "classifies it by the curated-row count, not mere existence"
assert_has "$out" "left alone" "and leaves it alone"
if [ "$(cat "$(vmreg)")" = "$before" ]; then ok "VM registry byte-identical"; else bad "VM registry changed"; fi
if deploy_ran; then ok "deploy.sh ran"; else bad "deploy.sh did not run"; fi

start "22b registry absent on the VM: the COMMITTED PIN's blob is seeded, then deploy runs"
mkfixture 2; mkbrain; set_marker HEAD; rm -f "$(vmreg)"
run
assert_rc 0 "$rc" "deploy allowed"
assert_has "$out" "pushed the committed pin" "says it seeded"
assert_has "$out" "sha256 verified on the VM" "says the bytes were verified"
assert_has "$(cat "$(vmreg)")" '"marker":"PINNED"' "the VM got the pinned blob"
assert_count "$(ls -a "$vmapp/packages/brain/data")" ".model-registry.json.seed." 0 "no seed temp left behind"
if deploy_ran; then ok "deploy.sh ran after the seed"; else bad "deploy.sh did not run"; fi

# B1, the defect this port exists for. The first draft seeded
# `git show HEAD:data/model-registry.json` INSIDE the submodule, i.e. whatever
# the submodule happens to be checked out at -- which on this host today is one
# commit PAST the recorded pin. The seed must be the gitlink the outer repo
# committed, and neither the submodule's HEAD nor the working file.
start "22b2 the submodule HEAD is off the pin: the PINNED blob is seeded, not HEAD's, not the working copy"
mkfixture 2; mkbrain; set_marker HEAD; rm -f "$(vmreg)"
if [ "$(git -C "$repo" rev-parse HEAD:packages/brain)" != "$(git -C "$repo/packages/brain" rev-parse HEAD)" ]; then
  ok "fixture really has the submodule HEAD off the committed pin"
else bad "fixture did not diverge the submodule HEAD from the pin"; fi
run
assert_rc 0 "$rc" "deploy allowed"
assert_has "$(cat "$(vmreg)")" '"marker":"PINNED"' "the VM got the committed pin's blob"
assert_hasnt "$(cat "$(vmreg)")" "SUBMODULE-HEAD" "never the submodule's checked-out HEAD"
assert_hasnt "$(cat "$(vmreg)")" "DEV-BOX-EDIT" "never the working-copy edit"
assert_has "$out" "$(git -C "$repo" rev-parse HEAD:packages/brain)" "names the pin it read"

start "22c fresh VM with no app dir: app dir created, then seeded"
mkfixture 2; mkbrain; set_marker HEAD; rm -rf "$vmapp"
run
assert_rc 0 "$rc" "deploy allowed"
assert_has "$out" "(no-app-dir)" "names the fresh-box case"
assert_has "$(cat "$(vmreg)" 2>/dev/null)" '"marker":"PINNED"' "the VM got the pinned blob"

start "22d ssh down for everything: the pre-pass refuses BEFORE deploy.sh"
mkfixture 3; set_marker HEAD~2
SSH_STUB_MODE=fail SSH_STUB_REGISTRY_MODE=fail run
SSH_STUB_MODE=ok; SSH_STUB_REGISTRY_MODE=ok
assert_rc 1 "$rc" "refused"
assert_has "$out" "registry seed probe got no answer after 3 attempts" "names the failed probe and the retries"
assert_has "$out" "may or may not hold" "does not claim to know what the VM has"
assert_has "$out" "deploy.sh did NOT run" "says nothing shipped"
if deploy_ran; then bad "deploy.sh ran"; else ok "deploy.sh never ran"; fi
assert_has "$(cat "$marker")" "$(sha HEAD~2)" "marker untouched"

start "22e VM has none and the checkout records no brain pin: refused, nothing placed"
mkfixture 2; set_marker HEAD; rm -f "$(vmreg)"
run
assert_rc 1 "$rc" "refused"
assert_has "$out" "cannot be seeded" "says why"
if [ -e "$(vmreg)" ]; then bad "something was placed on the VM"; else ok "nothing placed on the VM"; fi
if deploy_ran; then bad "deploy.sh ran"; else ok "deploy.sh never ran"; fi

# B1's second half: the seed is VALIDATED before it is hashed. Without that, an
# empty blob hashes to sha256("") = e3b0c442...b855, the empty stream the VM
# receives verifies against it, and a 0-byte registry is linked -- which
# brain-api then rewrites as a FEED-ONLY registry, the exact failure the
# pre-pass exists to prevent.
start "22e2 the committed pin's blob is EMPTY: refused, and no 0-byte registry is linked"
mkfixture 2; mkbrain empty; set_marker HEAD; rm -f "$(vmreg)"
run
assert_rc 1 "$rc" "refused"
assert_has "$out" "missing, unreadable, or not a registry" "names the validation failure"
assert_has "$out" "NOTHING was pushed" "says nothing was pushed"
if [ -e "$(vmreg)" ]; then bad "a 0-byte registry was linked"; else ok "nothing placed on the VM"; fi
if deploy_ran; then bad "deploy.sh ran"; else ok "deploy.sh never ran"; fi

start "22e3 the committed pin's blob is JSON but not a registry: refused, nothing placed"
mkfixture 2; mkbrain notregistry; set_marker HEAD; rm -f "$(vmreg)"
run
assert_rc 1 "$rc" "refused"
assert_has "$out" "fewer than 10 curated rows" "names the floor it failed"
if [ -e "$(vmreg)" ]; then bad "a feed-only registry was seeded"; else ok "nothing placed on the VM"; fi
if deploy_ran; then bad "deploy.sh ran"; else ok "deploy.sh never ran"; fi

start "22f a corrupted push is refused and nothing is placed"
mkfixture 2; mkbrain; set_marker HEAD; rm -f "$(vmreg)"
SSH_STUB_REGISTRY_MODE=corrupt run
SSH_STUB_REGISTRY_MODE=ok
assert_rc 1 "$rc" "refused"
assert_has "$out" "checksum mismatch" "names the checksum failure"
if [ -e "$(vmreg)" ]; then bad "a corrupt registry was placed"; else ok "nothing placed"; fi
assert_count "$(ls -a "$vmapp/packages/brain/data")" ".model-registry.json.seed." 0 "no seed temp left behind"
if deploy_ran; then bad "deploy.sh ran"; else ok "deploy.sh never ran"; fi

start "22g a registry that appears between probe and push is kept, never overwritten"
mkfixture 2; mkbrain; set_marker HEAD; rm -f "$(vmreg)"
SSH_STUB_REGISTRY_MODE=race SSH_STUB_VMREG="$(vmreg)" run
SSH_STUB_REGISTRY_MODE=ok; SSH_STUB_VMREG=""
assert_rc 0 "$rc" "deploy allowed"
assert_has "$out" "appeared on the VM between probe and push" "reports the race"
assert_has "$out" "it is a real registry" "re-probes and says the survivor is usable"
assert_has "$(cat "$(vmreg)")" '"marker":"raced"' "the raced copy survived"
assert_hasnt "$(cat "$(vmreg)")" '"marker":"PINNED"' "the seed did not overwrite it"

start "22h refused runs never reach the pre-pass"
mkfixture 4; set_marker HEAD~3
run
assert_rc 1 "$rc" "refused without an ack"
assert_hasnt "$out" "seed pre-pass" "the ack refusal comes first"
mkfixture 2; set_marker HEAD
echo "half a feature" > "$repo/wip.txt"
run
assert_rc 1 "$rc" "refused on a dirty tree"
assert_hasnt "$out" "seed pre-pass" "the dirty-tree refusal comes first"

# S1. The draft called any existing file "present" and left it alone, so a
# feed-only registry brain-api had rebuilt from nothing was preserved for ever
# and every later run agreed with it. It is now classified and REFUSED -- never
# silently replaced, because the VM's copy is the authority when it is real and
# only a human can know which of the two this is.
start "22i a DEGENERATE registry on the VM is refused, never overwritten"
mkfixture 2; mkbrain; set_marker HEAD
mkreg 3 vm-feed-only > "$(vmreg)"
before="$(cat "$(vmreg)")"
run
assert_rc 1 "$rc" "refused"
assert_has "$out" "not a usable registry" "says what is wrong"
assert_has "$out" "3 curated" "quotes the count it measured on the VM"
assert_has "$out" "pre-reseed" "prints step 1 of the re-seed runbook"
assert_has "$out" "re-run THIS wrapper" "prints step 2"
assert_has "$out" "deploy.sh did NOT run" "says nothing shipped"
if [ "$(cat "$(vmreg)")" = "$before" ]; then ok "the degenerate file is byte-identical (never overwritten)"; else bad "the pre-pass overwrote it"; fi
if deploy_ran; then bad "deploy.sh ran"; else ok "deploy.sh never ran"; fi

start "22i2 a DIRECTORY at the registry path is refused, and ln -T never links into it"
mkfixture 2; mkbrain; set_marker HEAD
rm -f "$(vmreg)"; mkdir -p "$(vmreg)"
run
assert_rc 1 "$rc" "refused"
assert_has "$out" "a DIRECTORY sits at the registry path" "names the shape"
if [ -e "$(vmreg)/model-registry.json" ]; then bad "something was linked INTO the directory"; else ok "nothing linked into the directory"; fi
if deploy_ran; then bad "deploy.sh ran"; else ok "deploy.sh never ran"; fi

# S3. The draft's push-failure text said "Nothing was placed at ...", which is
# false in exactly the case that matters: the remote side finished and only the
# answer was lost. The honest wording is "may or may not", plus the instruction
# that re-running reports which -- and re-running is safe because link(2) never
# replaces a path.
start "22j a LOST push answer never claims nothing was placed"
mkfixture 2; mkbrain; set_marker HEAD; rm -f "$(vmreg)"
SSH_STUB_REGISTRY_MODE=lostpush run
SSH_STUB_REGISTRY_MODE=ok
assert_rc 1 "$rc" "refused (no answer is not a success)"
assert_has "$out" "MAY OR MAY NOT now hold" "says the truth about the VM's state"
assert_has "$out" "the probe reports which" "tells the operator how to find out"
assert_hasnt "$out" "Nothing was placed" "never the false claim"
assert_hasnt "$out" "placed nothing" "nor its other wording"
assert_has "$out" "got no answer after 3 attempts" "says it retried"
if [ -e "$(vmreg)" ]; then ok "the push HAD in fact landed — which is why the wording matters"; else bad "fixture did not actually place the file"; fi
if deploy_ran; then bad "deploy.sh ran"; else ok "deploy.sh never ran"; fi

# S7. A push killed between `cat >` and `ln` leaves a temp beside the registry.
# Nothing else ever removes it (rsync does not delete an excluded path, and the
# live->stage copy propagates it), so the probe sweeps temps older than 10
# minutes on both trees and reports how many.
start "22k stale seed temps are swept, live and stage; a fresh one is left alone"
mkfixture 2; set_marker HEAD
mkdir -p "$vmapp.stage/packages/brain/data"
: > "$vmapp/packages/brain/data/.model-registry.json.seed.111"
: > "$vmapp.stage/packages/brain/data/.model-registry.json.seed.222"
touch -d '2 hours ago' "$vmapp/packages/brain/data/.model-registry.json.seed.111" \
                       "$vmapp.stage/packages/brain/data/.model-registry.json.seed.222"
: > "$vmapp/packages/brain/data/.model-registry.json.seed.fresh"
run
assert_rc 0 "$rc" "deploy allowed"
assert_has "$out" "swept 2 stale seed temp(s)" "reports the sweep"
if [ -e "$vmapp/packages/brain/data/.model-registry.json.seed.111" ]; then bad "the live stale temp survived"; else ok "live stale temp removed"; fi
if [ -e "$vmapp.stage/packages/brain/data/.model-registry.json.seed.222" ]; then bad "the stage stale temp survived"; else ok "stage stale temp removed"; fi
if [ -e "$vmapp/packages/brain/data/.model-registry.json.seed.fresh" ]; then ok "a fresh temp (a push in flight) is left alone"; else bad "a fresh temp was swept"; fi

# S5, and the one deliberate deviation from deploy-itsc.sh / deploy-tmnm.sh,
# which have exactly one transport each. The draft refused whenever the ssh-key
# pre-flight was not ready, and "transport is not ssh-key" is one of those
# reasons -- so it broke the legacy sshpass break-glass path, which before the
# pre-pass existed proceeded with a warning. It now SKIPS, loudly.
start "22l the sshpass transport is NOT refused: the pre-pass skips with a loud WARN"
mkfixture 2
# cfgval takes the FIRST matching line, so the transport must be replaced, not
# appended; the work dir is recoverable from the marker path.
work="$(dirname "$marker")"
cat > "$repo/deploy/site-deploy.env" <<CFG
SLUG=aiwebsite
APP_DIR=$vmapp
DEPLOY_TRANSPORT=sshpass
SSH_KEY_PATH=$work/fake-key
CFG
git -C "$repo" add -A; git -C "$repo" commit -q -m "chore: break-glass transport"
set_marker HEAD
before="$(cat "$(vmreg)")"
run "--allow-sshpass"
assert_rc 0 "$rc" "deploy allowed, not refused"
assert_has "$out" "registry seed pre-pass was SKIPPED" "says it skipped"
assert_has "$out" "deploy transport is 'sshpass'" "names the reason"
assert_has "$out" "seed it by hand" "names the manual step"
assert_has "$out" "cat-file blob" "and hands over the exact command"
assert_hasnt "$out" "DEPLOY REFUSED" "no refusal"
if deploy_ran; then ok "deploy.sh still ran"; else bad "deploy.sh did not run"; fi
if [ "$(cat "$(vmreg)")" = "$before" ]; then ok "the VM's registry was not touched"; else bad "the skip path still wrote to the VM"; fi

start "22m the ssh-key transport with a missing key still REFUSES (the distinction S5 draws)"
mkfixture 2; set_marker HEAD
rm -f "$(dirname "$marker")/fake-key"
run
assert_rc 1 "$rc" "refused"
assert_has "$out" "cannot reach the VM" "says it cannot tell"
assert_has "$out" "ssh key" "names the missing key"
if deploy_ran; then bad "deploy.sh ran"; else ok "deploy.sh never ran"; fi

printf '\n----------------------------------------------------------------\n'
printf 'deploy-safe: %s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
