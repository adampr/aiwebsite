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
repo=""; bin=""; marker=""; ranfile=""
mkfixture() { # commits
  local n="${1:-3}" i
  local work; work="$(mktemp -d "$tmp_root/caseXXXX")"
  repo="$work/repo"; bin="$work/bin"; marker="$work/vm-marker"; ranfile="$work/deploy-ran"
  mkdir -p "$repo/scripts" "$repo/deploy" "$bin"
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
  chmod +x "$bin/ssh" "$repo/deploy/deploy.sh"

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
start "ssh failure: unknown baseline, deploy still allowed"
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

printf '\n----------------------------------------------------------------\n'
printf 'deploy-safe: %s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
