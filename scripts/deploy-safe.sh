#!/usr/bin/env bash
# Guarded wrapper around deploy/deploy.sh.
#
# WHY THIS EXISTS
#
# deploy/deploy.sh ships the WORKING DIRECTORY, not a git archive: sync_dir()
# rsyncs the tree with only .git/node_modules/.next/.env/data excluded. So
# whatever is sitting uncommitted in this checkout goes to production, whether
# or not it is finished, whether or not it is yours.
#
# On 2026-07-31 that came within one command of shipping a half-built feature
# plus an unapplied migration, because two sessions were working in this tree
# at once. It was caught by a human noticing, which is not a control.
#
# THE SECOND HAZARD, THE ONE A CLEAN TREE HIDES
#
# A deploy ships the tree AT ITS CURRENT COMMIT, so it also carries every
# commit every OTHER session has pushed to this branch, not just yours. That
# set lives entirely inside committed, pushed history: the dirty-tree gate
# cannot see it, `git status` prints nothing, the tree is genuinely clean.
# On 2026-08-29 four sessions were pushing to master and one session's cutover
# would have shipped another session's round while that round still had two
# FATALs open, one of them a credential-leak regression. The only thing that
# stopped it was agents messaging each other, which is not a control either.
#
# So before handing over, this wrapper reads a marker off the VM recording the
# commit the last successful deploy shipped, prints EVERY commit between that
# marker and HEAD (sha, date, author, subject), and refuses to continue unless
# the operator acknowledges that exact HEAD:
#
#     bash scripts/deploy-safe.sh [--ack=<sha>] [--takeover] [--allow-sshpass]
#
# --ack takes the literal sha of the current HEAD. BE PRECISE ABOUT WHAT THAT
# BUYS, because the obvious claim is false: the sha is NOT evidence the list
# was read. It is `git rev-parse --short HEAD`, so anyone holding this
# checkout can produce it without ever running this wrapper, and the refusal
# below prints the ready-to-run command containing it. What the ack really
# buys is two things: it goes STALE the moment anyone else pushes, closing
# the window between reading the list and deploying, and it puts
# `Acknowledged: N new + M removed commit(s) at <sha>` in the deploy log, so
# shipping somebody else's round is a logged act rather than a silent one.
# It is a speed bump, not authentication and not proof of review.
#
# Escape hatch for the dirty tree, for the rare deliberate case (never for
# "it is probably fine"):
#
#     bash scripts/deploy-safe.sh --dirty-ok
#
set -euo pipefail

cd "$(dirname "$0")/.."

# Remote path of the deploy marker. Deliberately in the deploy user's HOME and
# NOT in $app_dir: deploy.sh rsyncs $app_dir with --delete, so a marker inside
# it is erased at the START of every deploy. A deploy that then failed
# post-rsync would leave no record of the commit that is still serving, which
# is exactly the moment the record is worth having.
marker_file='~/.aiwebsite-deploy-commit'

dirty_ok="no"
ack=""
passthru=()
for arg in "$@"; do
  case "$arg" in
    --dirty-ok) dirty_ok="yes" ;;
    --ack=*)    ack="${arg#--ack=}" ;;
    --ack)      ack="__no_value__" ;;
    *) passthru+=("$arg") ;;
  esac
done

fail() { echo "" >&2; echo "DEPLOY REFUSED: $1" >&2; echo "" >&2; exit 1; }

# ── 1. The tree must be clean ────────────────────────────────────
dirty="$(git status --porcelain)"
if [ -n "$dirty" ] && [ "$dirty_ok" != "yes" ]; then
  echo "Uncommitted paths in the working tree:" >&2
  echo "$dirty" | sed 's/^/    /' >&2
  fail "deploy.sh rsyncs the working directory, so every path above would ship
to production exactly as it is now. Commit them, stash them, or if you are
certain they are safe to publish, re-run with --dirty-ok.

If those paths are not yours, another session is mid-flight in this tree.
Wait for them rather than shipping their work."
fi

# ── 2. HEAD should exist on the remote ───────────────────────────
# Not fatal: deploy ships the tree, not HEAD, so an unpushed commit still
# deploys correctly. It matters for recovery — if the box dies, whatever is
# only local is the thing you cannot get back.
branch="$(git rev-parse --abbrev-ref HEAD)"
if git rev-parse --verify --quiet "origin/$branch" >/dev/null; then
  ahead="$(git rev-list --count "origin/$branch..HEAD")"
  if [ "$ahead" != "0" ]; then
    echo "WARNING: $ahead commit(s) on $branch are not pushed to origin." >&2
    echo "         Deploying anyway (the tree is what ships), but push after." >&2
    echo "" >&2
  fi
fi

# ── 3. What has this VM already got? ─────────────────────────────
# Read the marker the last successful run of THIS wrapper wrote. Only the
# ssh-key transport is spoken here: the sshpass path needs a password this
# script deliberately never handles, and gcloud-iap belongs to other hosts.
# Every failure below is NON-FATAL by design (see section 4).
head_sha="$(git rev-parse HEAD)"
head_short="$(git rev-parse --short HEAD)"

cfgval() { { grep -E "^$1=" deploy/site-deploy.env 2>/dev/null || true; } | head -1 | cut -d= -f2-; }
dotval() { { grep -E "^$1=" .env 2>/dev/null || true; } | head -1 | cut -d= -f2-; }

ssh_ready="no"
ssh_why=""
ssh_ip=""; ssh_user=""; ssh_key=""
transport="$(cfgval DEPLOY_TRANSPORT)"
transport="${transport:-ssh-key}"
if [ "$transport" != "ssh-key" ]; then
  ssh_why="deploy transport is '$transport'; this pre-flight only speaks ssh-key"
else
  ssh_ip="$(dotval AIWEBSITE_SSH_IP)"
  ssh_user="$(dotval AIWEBSITE_USER)"
  ssh_key="$(dotval AIWEBSITE_SSH_KEY)"
  ssh_key="${ssh_key:-$(cfgval SSH_KEY_PATH)}"
  ssh_key="${ssh_key:-~/.ssh/id_ed25519}"
  ssh_key="${ssh_key/#\~/$HOME}"
  if [ -z "$ssh_ip" ] || [ -z "$ssh_user" ]; then
    ssh_why="AIWEBSITE_SSH_IP / AIWEBSITE_USER are not both set in .env"
  elif [ ! -f "$ssh_key" ]; then
    ssh_why="ssh key $ssh_key not found"
  else
    ssh_ready="yes"
  fi
fi

# BatchMode: never sit at a passphrase prompt. ConnectTimeout + timeout: a dead
# box must cost seconds, not a hung pre-flight (deploy.sh's own liveness probe
# is the authority on VM health, and it runs right after this).
vm_ssh() {
  timeout 25 ssh -i "$ssh_key" \
    -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8 \
    "$ssh_user@$ssh_ip" "$1"
}

deployed_sha=""
baseline_why=""
marker_meta=""
marker_dirty="no"
if [ "$ssh_ready" != "yes" ]; then
  baseline_why="$ssh_why"
else
  probe_rc=0
  # stderr is captured SEPARATELY, never folded into the marker body with
  # `2>&1`. Merged, one ordinary line of ssh or remote-shell noise becomes
  # line 1 of the "marker", fails the sha test, and drops the run into the
  # degrade-open path with a reason that blames a file which is perfectly
  # intact -- while the deploy ships ungated. The likeliest trigger is this
  # wrapper's own `StrictHostKeyChecking=accept-new`, which prints
  # "Warning: Permanently added ..." on the first connect after a VM rebuild,
  # i.e. exactly the `--takeover` recovery the degrade path exists for. A
  # remote `perl: warning: Setting locale failed.` does it too.
  probe_err="$(mktemp)"
  marker_raw="$(vm_ssh "cat $marker_file 2>/dev/null || echo __NO_MARKER__" </dev/null 2>"$probe_err")" || probe_rc=$?
  probe_err_line="$(head -1 "$probe_err" 2>/dev/null || true)"
  rm -f "$probe_err"
  if [ "$probe_rc" -ne 0 ]; then
    baseline_why="could not read $marker_file from the VM (ssh rc=$probe_rc: ${probe_err_line:-no stderr})"
  elif [ "${marker_raw#*__NO_MARKER__}" != "$marker_raw" ]; then
    baseline_why="the VM carries no $marker_file yet (nothing has deployed through this pre-flight)"
  else
    # Take the first sha-SHAPED line, not blindly line 1, and do it with
    # parameter expansion rather than `head -1 | awk`: under `set -o pipefail`
    # a `printf | head -1` on a body larger than the 64 KiB pipe buffer gives
    # printf a SIGPIPE, pipefail promotes 141, and errexit kills the wrapper
    # at an assignment with NO banner and NO refusal text -- a hard stop in
    # the one path that is designed never to refuse (measured: rc=141, zero
    # output, at exactly 65000 bytes).
    cand=""
    while IFS= read -r mline; do
      mline="${mline%%[[:space:]]*}"
      case "$mline" in
        *[!0-9a-f]*|"") continue ;;
      esac
      if [ "${#mline}" -ge 7 ] && [ "${#mline}" -le 40 ]; then cand="$mline"; break; fi
    done <<EOF
$marker_raw
EOF
    if [ -z "$cand" ]; then
      baseline_why="$marker_file on the VM carries no line starting with a commit sha"
    elif ! git cat-file -e "${cand}^{commit}" 2>/dev/null; then
      baseline_why="the marker names $cand, which is not a commit in this checkout (git fetch, or it was deployed from a different clone)"
    else
      deployed_sha="$cand"
      marker_meta="$(printf '%s\n' "$marker_raw" | sed -n 's/^# deployed_at: //p' | head -1 || true)"
      # Parameter expansion, not `printf | grep -q`: grep -q exits on the
      # first match, which SIGPIPEs printf, which pipefail turns into 141,
      # which reads here as "no match" -- i.e. a large marker would silently
      # report a dirty deploy as clean.
      case "$marker_raw" in
        "# dirty: yes"*|*"
# dirty: yes"*) marker_dirty="yes" ;;
      esac
    fi
  fi
fi

# ── 4. Say what this deploy PUTS ON THE SITE, in full ────────────
log_fmt='    %h  %ad  %an  %s'
bar="================================================================"
echo "$bar"
echo " WHAT THIS DEPLOY PUTS ON ai.xl.net"
echo "$bar"
if [ -n "$dirty" ]; then
  echo " tree      : DIRTY at $head_short ($branch), --dirty-ok in force"
else
  echo " tree      : clean at $head_short ($branch)"
fi
echo " shipping  : $(git log -1 --pretty=%s)"

ack_needed="no"
new_count=0
gone_count=0
new_block=""
gone_block=""
if [ -n "$deployed_sha" ]; then
  new_count="$(git rev-list --count "$deployed_sha..HEAD")"
  gone_count="$(git rev-list --count "HEAD..$deployed_sha")"
  echo " live now  : $(git rev-parse --short "$deployed_sha")  $(git log -1 --pretty=%s "$deployed_sha")"
  [ -n "$marker_meta" ] && echo "             (marker written $marker_meta)"
  if [ "$marker_dirty" = "yes" ]; then
    echo "             WARNING: that deploy shipped a DIRTY tree, so the live"
    echo "             files are not exactly that commit. Treat the list below"
    echo "             as a lower bound on the difference."
  fi
  echo "$bar"
  if [ "$new_count" -eq 0 ] && [ "$gone_count" -eq 0 ]; then
    echo " NEW       : nothing. This is a re-deploy of the commit already live."
  fi
  if [ "$new_count" -gt 0 ]; then
    ack_needed="yes"
    echo " NEW       : $new_count commit(s) go live that are not live now"
    echo "             (newest first)"
    echo ""
    new_block="$(git log --pretty=format:"$log_fmt" --date=format:'%Y-%m-%d %H:%M' \
      "$deployed_sha..HEAD")"
    echo "$new_block"
    echo ""
    others="$(git log --pretty=%ae "$deployed_sha..HEAD" | sort -u | grep -vFx "$(git config user.email 2>/dev/null || echo __none__)" || true)"
    if [ -n "$others" ]; then
      echo ""
      echo "             authored under other identities: $(printf '%s' "$others" | tr '\n' ' ')"
    fi
    echo ""
    echo "             Several sessions push to this branch, usually under ONE"
    echo "             git identity, so authorship does NOT tell you which of"
    echo "             these are yours. Read the subjects."
  fi
  if [ "$gone_count" -gt 0 ]; then
    ack_needed="yes"
    echo ""
    echo " REMOVED   : $gone_count commit(s) are live now and are NOT in what you"
    echo "             are about to ship. This deploy ROLLS THEM BACK."
    echo ""
    gone_block="$(git log --pretty=format:"$log_fmt" --date=format:'%Y-%m-%d %H:%M' \
      "HEAD..$deployed_sha")"
    echo "$gone_block"
    echo ""
  fi
else
  # ── Degrade, loudly, but NEVER refuse on a failed marker read ──
  # Refusing here would mean an unreachable VM, a fresh box, a missing key or
  # simply the first run after this pre-flight shipped could all block a
  # deploy, including the --takeover recovery run that exists for when the
  # site is DOWN. A gate that turns a monitoring gap into an outage is worse
  # than the hazard it polices. deploy.sh's own liveness probe still refuses a
  # dead box seconds later, so nothing here papers over a broken VM.
  echo " live now  : UNKNOWN"
  echo "             $baseline_why"
  echo "$bar"
  echo " NEW       : cannot be computed. The 15 most recent commits on $branch,"
  echo "             any of which may be newly shipping (newest first):"
  echo ""
  git log -15 --pretty=format:"$log_fmt" --date=format:'%Y-%m-%d %H:%M' HEAD
  echo ""
  echo ""
  echo "             No acknowledgement is required while the baseline is"
  echo "             unknown, so READ THE LIST. A successful deploy writes the"
  echo "             marker, and the next run compares against it."
fi
echo "$bar"
echo ""

# ── 5. Acknowledge other people's work, explicitly ───────────────
if [ "$ack_needed" = "yes" ]; then
  reissue=""
  # Re-issue every ORIGINAL argument except a previous --ack: the loop above
  # takes the last --ack wins, so echoing a stale one back would quietly
  # override the fresh sha in the suggested command.
  for arg in "$@"; do
    case "$arg" in --ack|--ack=*) continue ;; esac
    reissue+=" $(printf '%q' "$arg")"
  done
  suggest="bash scripts/deploy-safe.sh --ack=$head_short$reissue"
  # The lists are REPEATED inside the refusal, not merely referred to. The
  # banner goes to stdout and `fail` writes to stderr, so any caller that
  # keeps only stderr (or logs the two separately) would otherwise see the
  # ready-to-run bypass command with none of the evidence it is bypassing.
  evidence=""
  [ -n "$new_block" ] && evidence="$evidence
The $new_count commit(s) that go live and are not live now (newest first):

$new_block
"
  [ -n "$gone_block" ] && evidence="$evidence
The $gone_count commit(s) this deploy would ROLL BACK:

$gone_block
"
  if [ -z "$ack" ]; then
    fail "the commits listed above are not on the VM yet, and this wrapper
cannot tell which of them are yours: sessions sharing this checkout usually
commit under one git identity. Read the subjects. If any of that is somebody
else's round, ask them before you ship it.
$evidence
When you have read them, acknowledge this exact HEAD:

  $suggest

The sha goes stale the moment anyone else pushes, which is the point."
  elif [ "$ack" = "__no_value__" ]; then
    fail "--ack needs the sha, as one argument: --ack=$head_short"
  elif ! printf '%s' "$ack" | grep -qE '^[0-9a-fA-F]{7,40}$'; then
    fail "--ack takes the literal sha printed above, not a name like '$ack'.
A name (HEAD, master, a tag) would resolve to whatever the branch happens to
be at the moment you run it, which acknowledges nothing:

  $suggest"
  else
    ack_full="$(git rev-parse --verify --quiet "${ack}^{commit}" || true)"
    if [ -z "$ack_full" ]; then
      fail "--ack=$ack does not resolve to a commit in this checkout (too short
and ambiguous, or fetched away). Use the sha printed above:

  $suggest"
    elif [ "$ack_full" != "$head_sha" ]; then
      fail "--ack=$ack is $(git rev-parse --short "$ack_full"), but HEAD is now $head_short.
Someone pushed between your read and this run, or you are acknowledging a
different commit. Re-read the list above, then:

  $suggest"
    fi
    echo ">>> Acknowledged: $new_count new + $gone_count removed commit(s) at $head_short"
  fi
elif [ -n "$ack" ] && [ "$ack" != "__no_value__" ]; then
  echo "NOTE: --ack given, but nothing beyond the live commit was shipping anyway."
fi

# ── 6. Say what is about to ship ─────────────────────────────────
if [ -n "$dirty" ]; then
  echo ">>> Deploying a DIRTY tree at $head_short ($branch)"
else
  echo ">>> Deploying from a clean tree at $head_short ($branch)"
fi
echo "    $(git log -1 --pretty=%s)"
if [ "$dirty_ok" = "yes" ] && [ -n "$dirty" ]; then
  echo "    --dirty-ok: $(echo "$dirty" | wc -l) uncommitted path(s) WILL ship"
  # Carry the escape THROUGH to the module's own working-tree gate
  # (@aicompany/core v1.104.0, MIGRATIONS v1.104.1). This wrapper CONSUMES
  # --dirty-ok in its argument loop and runs deploy/deploy.sh with
  # "${passthru[@]}",
  # so the flag never reaches the lower gate. v1.104.1 also accepts the flag
  # directly, which makes this belt and braces rather than load-bearing, but
  # the env var is the form that cannot be broken by a future change to
  # either script's argument handling.
  export DEPLOY_ALLOW_DIRTY=1
fi
echo ""

# ── 7. Run the deploy, then record what went out ─────────────────
# NOT `exec` any more, deliberately. exec was simpler and left no process
# behind, but it also made a post-deploy step impossible, and without one the
# VM has no record of the commit it is running: deploy.sh ships a tree with
# .git excluded, so nothing on the box can answer "what is live?". One idle
# shell for the length of the deploy is a cheap price for the marker every
# future pre-flight reads. Signals still reach deploy.sh (same process group),
# its exit status is propagated verbatim below, and a non-zero status skips
# the stamp, so a failed deploy never claims to have shipped anything.
# Nine distinct conditions send a deploy out completely ungated (no marker
# yet, a corrupt or empty marker, a marker naming a commit this checkout does
# not have, an unreachable VM, a non-ssh-key transport, no .env, a missing
# key, ...). Every one of them is correct: refusing would let a monitoring gap
# block the --takeover recovery run while the site is down. What was NOT
# correct is that the only record of it was one stdout line in the middle of a
# long deploy log, so a gate that had been dead for weeks looked exactly like
# a gate that was working. This mails it. It runs AFTER the deploy, cannot
# block anything, and absorbs every failure.
degrade_alert() {
  local to key safe_why body
  to="$(dotval ADMIN_EMAIL)"
  key="$(dotval RESEND_API_KEY)"
  if [ -z "$to" ] || [ -z "$key" ]; then
    echo "NOTE: no ADMIN_EMAIL / RESEND_API_KEY in .env, so the ungated-deploy"
    echo "      WARN above was printed here and mailed nowhere."
    return 0
  fi
  # Quotes, backslashes and newlines stripped rather than JSON-escaped: this
  # is a one-line alert body, and a hand-built payload must not be able to
  # break its own envelope.
  safe_why="$(printf '%s' "$1" | tr -d '"\\' | tr '\n' ' ')"
  body="scripts/deploy-safe.sh shipped $head_short ($branch) to production without being able to compute what was new, so NO acknowledgement was required and the commit-set gate did not run. Reason: $safe_why. If this repeats, the gate is dead rather than degrading: check ~/.aiwebsite-deploy-commit on the VM and the ssh-key transport."
  curl -s --max-time 20 -X POST https://api.resend.com/emails \
    -H "Authorization: Bearer $key" \
    -H "Content-Type: application/json" \
    -d "{\"from\":\"ai.xl.net Watchdog <noreply@ai.xl.net>\",\"to\":\"$to\",\"subject\":\"[aiwebsite] WARN deploy shipped with an UNKNOWN baseline\",\"text\":\"$body\",\"headers\":{\"Auto-Submitted\":\"auto-generated\",\"X-Auto-Response-Suppress\":\"All\"}}" \
    >/dev/null 2>&1 || echo "NOTE: the ungated-deploy WARN could not be mailed."
  return 0
}

rc=0
bash deploy/deploy.sh "${passthru[@]}" || rc=$?
if [ "$rc" -ne 0 ]; then
  exit "$rc"
fi

if [ -z "$deployed_sha" ]; then
  echo ""
  echo "WARN: this deploy shipped with an UNKNOWN baseline, so nothing gated"
  echo "      the commit set. Reason: $baseline_why"
  degrade_alert "$baseline_why" || true
fi

if [ "$ssh_ready" != "yes" ]; then
  echo ""
  echo "NOTE: deploy marker NOT written ($ssh_why)."
  echo "      The next pre-flight will report an unknown baseline."
  exit 0
fi

stamp="$(printf '%s\n' \
  "$head_sha" \
  "# aiwebsite deploy marker, written by scripts/deploy-safe.sh" \
  "# branch: $branch" \
  "# subject: $(git log -1 --pretty=%s | tr -d '\n')" \
  "# dirty: $([ -n "$dirty" ] && echo yes || echo no)" \
  "# deployed_at: $(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
  "# by: $(id -un)@$(hostname 2>/dev/null || echo unknown-host)")"
if printf '%s\n' "$stamp" | vm_ssh "cat > $marker_file"; then
  echo ""
  echo ">>> Deploy marker on the VM updated to $head_short."
else
  echo ""
  echo "WARN: the deploy SUCCEEDED but writing $marker_file failed."
  echo "      Nothing is wrong with the site. The next pre-flight will report"
  echo "      an unknown baseline and list recent commits instead."
fi
exit 0
