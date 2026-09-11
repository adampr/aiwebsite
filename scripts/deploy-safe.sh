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
#
# The option list is shared with the registry pre-pass's own bounded call
# (section 6b) rather than repeated, so the two can never drift apart; only the
# time bound differs. 25 s is right for the marker read and write, which move
# two short lines; the pre-pass streams a ~450 KB blob and needs its own,
# larger bound (refuter S2: every remote call must be time-bounded, and a
# 25 s cap on the push would turn a slow-but-healthy link into a refusal).
vm_ssh_opts=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8)
vm_ssh() {
  timeout 25 ssh -i "$ssh_key" "${vm_ssh_opts[@]}" "$ssh_user@$ssh_ip" "$1"
}
# <seconds> <remote command>. -k 10: a remote shell that ignores SIGTERM is
# killed 10 s later rather than holding the wrapper open past its own bound.
vm_ssh_bounded() {
  timeout -k 10 "$1" ssh -i "$ssh_key" "${vm_ssh_opts[@]}" "$ssh_user@$ssh_ip" "$2"
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

# ── 6b. Registry seed pre-pass (2026-09-10 — fleet port of roleplay c864725;
#       HARDENED 2026-09-11 to the behaviour of deploy/deploy-itsc.sh and
#       deploy/deploy-tmnm.sh, which a refuting panel fixed the same day) ─────
# `packages/brain/data/model-registry.json` is EXCLUDED from every deploy copy
# since 2026-09-10 (deploy/rsync-excludes.txt carries the measurement): brain-api
# rewrites it in-process at every boot and daily, and every deploy's rsync was
# reverting it to the dev-box snapshot — which defeated the auto-promoter's only
# idempotency belt (a prior auto_promote event IN the file) and re-moved routing
# heads. An rsync --exclude also skips a path the VM LACKS, and with no file
# brain-api's first refresh starts from an EMPTY document and writes a FEED-ONLY
# registry (packages/brain/scripts/refresh-model-registry.ts:858-862, then the
# .tmp+rename at :1259-1261) — no hand-curated row survives, and a later run of
# this pre-pass would see that file as "present" and keep it. So: seed the
# committed copy ONCE, only when absent; REFUSE — never overwrite — when what
# the VM holds is not a real registry; leave a real one alone (the VM's copy is
# runtime state and leaving it alone is the whole point).
#
# Placed after every refusal above (dirty tree, --ack), so a refused run never
# touches the VM here, and before deploy.sh, whose pm2 cutover is what boots
# brain-api on the file. THE ONE VM READ IN THIS WRAPPER THAT REFUSES ON FAILURE,
# unlike the marker read in section 3, and deliberately: an unreachable box is
# refused by deploy.sh's own liveness probe seconds later anyway, while
# degrading here would let a VM with no registry boot brain-api on an empty
# document and keep the feed-only result forever — a silent, persistent routing
# fault rather than a loud, retryable refusal.
#
# WHAT THE 2026-09-11 PORT CHANGED, defect by defect (the first draft shipped on
# this host with all of these open; every one was proven on the gcloud-iap
# siblings before being fixed there):
#   B1  The seed is the host's COMMITTED PIN — the gitlink this repo records at
#       HEAD — read from the submodule's object store, never the submodule's
#       checked-out HEAD (which sits off the pin on this host right now) and
#       never the working file. It is VALIDATED as a real registry BEFORE it is
#       hashed, and the empty-input sha256 is refused by name: the draft hashed
#       whatever `git show` produced, so an unreadable or empty blob hashed to
#       sha256("") = e3b0c442…b855, an empty stream then "verified" against it,
#       and a 0-byte registry was linked into place — which brain-api rewrites
#       as a feed-only registry, the exact failure this pre-pass exists to
#       prevent.
#   S1  The probe CLASSIFIES present-valid / present-DEGENERATE / absent using
#       the same predicate on the VM, and a degenerate copy is REFUSED loudly
#       with the re-seed runbook. The draft called any existing file "present"
#       and left it, so a feed-only registry was preserved forever.
#   S2  Every remote call is time-bounded (vm_ssh_bounded) and retried up to 3
#       times; the retry is safe because `ln -T` never replaces a path.
#   S3  A lost answer says the VM MAY OR MAY NOT now hold the file and to
#       re-run, never "nothing was placed" — the draft asserted the latter, and
#       it is false exactly when the push landed and only the answer was lost.
#   S4  `ln -T`: an existing DIRECTORY at the target is never a place to link
#       INTO.
#   S5  A non-ssh-key transport SKIPS the pre-pass with a loud WARN instead of
#       refusing (see the transport branch below).
#   S7  The probe sweeps `.model-registry.json.seed.*` temps older than 10
#       minutes, live and stage, that a killed push left behind.
#
# Mechanism: one bounded probe that CLASSIFIES what the VM holds; only when
# absent, one bounded push that streams this host's COMMITTED PIN of the file
# over ssh stdin; the VM verifies its sha256 against the blob's and places it
# with `ln -T`, and link(2) refuses atomically to replace an existing path
# (roleplay's `rsync --ignore-existing` belt without its check-then-rename
# window). Positive tokens, never exit codes. Idempotent: on a VM that has a
# real registry this costs one read-only round trip. Re-seed runbook and the
# rollback story: ARCHITECTURE.md §7 "Model registry = VM-owned runtime state".
echo ">>> model-registry seed pre-pass (fresh-VM only; never overwrites)..."
_reg_rel="packages/brain/data/model-registry.json"
_reg_repo="$(pwd)"
_reg_brain="$_reg_repo/packages/brain"
_reg_app="$(cfgval APP_DIR)"
case "$_reg_app" in
  /*\'*|"") _reg_ok=0 ;;
  /*)        _reg_ok=1 ;;
  *)         _reg_ok=0 ;;
esac
[ "$_reg_ok" = "1" ] || fail "APP_DIR '$_reg_app' (deploy/site-deploy.env) is not a plain absolute path, so the
registry seed pre-pass cannot probe the VM for $_reg_rel."
# Seconds between retries. The bound on each attempt is NOT configurable; this
# only shortens the pause between them, and exists so the hermetic test suite
# (scripts/deploy-safe-tests.sh) does not spend 40 s sleeping in the two cases
# that deliberately lose every answer. Unset in production = 10 s.
# Digits only, or the default: a non-numeric value would make `sleep` fail and
# errexit kill the wrapper mid-retry, turning a recoverable blip into a bare
# non-zero exit with no refusal text (the section-3 exit-141 lesson).
_reg_retry_sleep="${DEPLOY_SAFE_REG_RETRY_SLEEP:-10}"
case "$_reg_retry_sleep" in ''|*[!0-9]*) _reg_retry_sleep=10 ;; esac
# The first line carrying <TOKEN>=, value after '='. A heredoc, not a pipe: no
# SIGPIPE under pipefail (the section-3 lesson), and stderr noise is folded in.
_reg_token() {
  local _l
  while IFS= read -r _l; do
    _l="${_l%$'\r'}"
    case "$_l" in "$1="*) printf '%s\n' "${_l#"$1="}"; return 0 ;; esac
  done <<EOF
$2
EOF
  return 1
}
# WHAT COUNTS AS A REGISTRY (one jq predicate, run on the dev box against the
# seed AND on the VM against the live file): `.models` is an array holding >= 10
# rows that are CURATED by brain's own rule (`provenance`, else "no aa_slug =
# curated" — refresh-model-registry.ts:101). Why that floor: a refresh that
# starts from nothing creates feed rows only (always with an aa_slug,
# provenance "feed") and can mint curated rows only through the auto-promoter,
# capped at 3 per run and measured to have promoted just 2 distinct models in
# the whole committed history (69 -> 71 curated, v1.150 -> v1.152); every real
# registry measured 2026-09-10/11 holds 69-71 (this host's committed pin
# 00d6c54 = 69, the submodule's own HEAD fba6b12 = 71, itsc 71, tmnm 70, this
# VM 71). So 10 sits far below every real file and above anything a
# from-nothing rebuild reaches in its first several refreshes. It is a bound,
# not a proof: a feed-only file left alone for many refresh cycles could in
# principle climb past it — which is why S1 checks the VM on EVERY deploy.
_reg_curated='[.models[]|select(type=="object")|select((.provenance // (if .aa_slug==null then "curated" else "feed" end))=="curated")]|length'
_reg_valid='(.models|type)=="array" and (('"$_reg_curated"') >= 10)'
# Remote bodies are QUOTED heredocs: nothing in them expands here. Inputs are
# injected above them as single-quoted assignments (APP_DIR was just proven to
# carry no quote; the path, the jq programs and the sha256 carry none either).
# The probe also sweeps seed temps older than 10 minutes that a killed push
# left behind, live and stage (rsync never deletes an excluded path, and
# stage-build.sh prepare copies live->stage).
_reg_probe_body=$(cat <<'REMOTE'
swept=0
for dd in "$A/${R%/*}" "$A.stage/${R%/*}"; do
  [ -d "$dd" ] || continue
  n="$(find "$dd" -maxdepth 1 -type f -name '.model-registry.json.seed.*' -mmin +10 -print -delete 2>/dev/null | wc -l)"
  swept=$((swept + n))
done
tl=" (swept $swept stale seed temp(s))"
if [ -d "$A/$R" ]; then
  echo "REGISTRY_STATE=present-degenerate a DIRECTORY sits at the registry path$tl"
elif [ -e "$A/$R" ]; then
  if ! command -v jq >/dev/null 2>&1; then
    echo "REGISTRY_STATE=present-unverifiable jq is not installed on the VM$tl"
  else
    sz="$(stat -c %s "$A/$R" 2>/dev/null || echo '?')"
    nm="$(jq -r '.models|length' "$A/$R" 2>/dev/null || echo '?')"
    nc="$(jq -r "$C" "$A/$R" 2>/dev/null || echo '?')"
    ua="$(jq -r '.updated_at // "?"' "$A/$R" 2>/dev/null || echo '?')"
    if jq -e "$V" "$A/$R" >/dev/null 2>&1; then st=present-valid; else st=present-degenerate; fi
    echo "REGISTRY_STATE=$st $sz bytes, $nm models, $nc curated, updated_at $ua$tl"
  fi
elif [ -d "$A" ]; then
  echo "REGISTRY_STATE=absent$tl"
else
  echo "REGISTRY_STATE=no-app-dir"
fi
REMOTE
)
_reg_push_body=$(cat <<'REMOTE'
d="$A/${R%/*}"
if [ ! -d "$A" ]; then
  # First deploy onto a fresh VM (/var/www is root-owned): create the app dir
  # exactly as deploy.sh does a minute later — `sudo mkdir -p; sudo chown $(whoami):`.
  { sudo -n mkdir -p "$A" && sudo -n chown "$(id -un):" "$A"; } \
    || { echo 'SEED_RESULT=failed: could not create the app dir'; exit 1; }
fi
mkdir -p "$d" || { echo 'SEED_RESULT=failed: could not create the registry directory'; exit 1; }
t="$d/.model-registry.json.seed.$$"
cat > "$t" || { rm -f "$t"; echo 'SEED_RESULT=failed: remote write'; exit 1; }
got="$(sha256sum < "$t" | cut -d' ' -f1)"
if [ "$got" != "$W" ]; then rm -f "$t"; echo "SEED_RESULT=failed: checksum mismatch (got ${got:-nothing})"; exit 1; fi
chmod 644 "$t"
# -T: an existing DIRECTORY at the target is never a place to link INTO.
if ln -T "$t" "$A/$R" 2>/dev/null; then
  rm -f "$t"; echo 'SEED_RESULT=written'
elif [ -e "$A/$R" ] || [ -L "$A/$R" ]; then
  rm -f "$t"; echo 'SEED_RESULT=exists'
else
  rm -f "$t"; echo 'SEED_RESULT=failed: link'; exit 1
fi
REMOTE
)
# One probe = up to 3 attempts, each bounded at 90 s. Only a MISSING token
# retries; any answer is final. Read-only apart from the stale-temp sweep, so a
# repeat has no side effect.
_reg_probe() {
  local _try
  _reg_line=""; _reg_rc=0
  for _try in 1 2 3; do
    _reg_rc=0
    _reg_out="$(vm_ssh_bounded 90 "A='$_reg_app'; R='$_reg_rel'; C='$_reg_curated'; V='$_reg_valid'
$_reg_probe_body" </dev/null 2>&1)" || _reg_rc=$?
    _reg_line="$(_reg_token REGISTRY_STATE "$_reg_out")" && return 0
    _reg_line=""
    if [ "$_try" -lt 3 ]; then
      echo ">>> registry probe attempt $_try got no answer (rc=$_reg_rc) — retrying in ${_reg_retry_sleep}s"
      sleep "$_reg_retry_sleep"
    fi
  done
  return 1
}
_reg_no_answer() {
  printf '%s\n' "$_reg_out" | tail -5 | sed 's/^/      /' >&2
  fail "registry seed probe got no answer after 3 attempts (last ssh rc=$_reg_rc). The VM
may or may not hold $_reg_rel, and deploys no longer ship it.
deploy.sh did NOT run — re-run this wrapper: the probe reports which."
}
_reg_degenerate() {
  printf '%s\n' \
    "!!! The VM's $_reg_rel is NOT a usable registry ($1)." \
    "!!! A real registry holds >= 10 curated rows (brain's own rule); this one does not — most likely" \
    "!!! brain-api rebuilt it from nothing (a boot refresh with the file missing writes a FEED-ONLY file)." \
    "!!! It is NEVER overwritten automatically. To re-seed it from the pinned release:" \
    "!!!   1. on the VM, as the deploy user:  mv $_reg_app/$_reg_rel{,.pre-reseed-\$(date +%F)}" \
    "!!!   2. then re-run THIS wrapper at once — the pre-pass seeds the committed copy." >&2
  fail "the VM's $_reg_rel is not a usable registry ($1), and this pre-pass never
overwrites one. The two re-seed steps are printed above; ARCHITECTURE.md §7
\"Model registry = VM-owned runtime state\" has the whole runbook, including the
rollback story. deploy.sh did NOT run."
}
# S5 — THE TRANSPORT BRANCH, and the one deliberate deviation from the
# gcloud-iap siblings, whose wrappers have exactly one transport. This host
# still advertises the legacy `sshpass` transport (DEPLOY_TRANSPORT in
# deploy/site-deploy.env + an explicit --allow-sshpass), and the first draft of
# this pre-pass hard-REFUSED on `ssh_ready != yes`, which includes "transport is
# not ssh-key" — so it broke the break-glass path outright. Speaking sshpass
# here was rejected: it needs AIWEBSITE_PW, a password this wrapper deliberately
# never handles (section 3), and adding password plumbing to the one gate that
# runs before every deploy buys a pre-pass on a path used once a year at the
# price of a credential this script has never touched. So a non-ssh-key
# transport SKIPS the pre-pass, loudly, naming the manual seed step. An ssh-key
# transport that is not READY (no .env coordinates, missing key) still REFUSES:
# there the wrapper is configured to be able to tell and cannot, which is the
# condition the refusal is for.
if [ "$transport" != "ssh-key" ]; then
  echo "WARN: the registry seed pre-pass was SKIPPED: $ssh_why."
  echo "      Deploys no longer ship $_reg_rel (it is brain-api's"
  echo "      runtime state), so on a VM that has NO copy brain-api's boot refresh will"
  echo "      write a FEED-ONLY registry and keep it. If this box may be missing the file,"
  echo "      seed it by hand before the cutover — from the dev box:"
  echo ""
  echo "        git -C packages/brain cat-file blob \"\$(git rev-parse HEAD:packages/brain):data/model-registry.json\" \\"
  echo "          | ssh <deploy user>@<vm> \"cat > $_reg_app/$_reg_rel\""
  echo ""
  echo "      then check it on the VM: jq '.models|length' $_reg_app/$_reg_rel"
  echo "      (ARCHITECTURE.md §7 \"Model registry = VM-owned runtime state\".)"
else
  [ "$ssh_ready" = "yes" ] || fail "the registry seed pre-pass cannot reach the VM ($ssh_why).
Deploys no longer ship $_reg_rel, so a VM without one must be
seeded before deploy.sh boots brain-api; this run cannot tell whether it has one."
  _reg_probe || _reg_no_answer
  case "${_reg_line%% *}" in
    present-valid)
      echo "registry seed: VM already has $_reg_rel (${_reg_line#present-valid }) — left alone (runtime state; deploys never overwrite it)" ;;
    present-degenerate)
      _reg_degenerate "${_reg_line#present-degenerate }" ;;
    absent|no-app-dir)
      # THE SEED IS THE HOST'S COMMITTED PIN (refuter B1): the gitlink this repo
      # records at HEAD, read straight from the submodule's object store — never
      # the submodule's checked-out HEAD (which can sit off the pin, and does on
      # this host today) and never the working file, so neither --dirty-ok nor an
      # un-committed submodule bump can seed a dev-box edit. It must be a real
      # registry BEFORE it is hashed: an empty or unreadable blob hashes to
      # sha256("") = e3b0c442…b855, and an empty stream would then "verify"
      # against it and link a 0-byte registry.
      _reg_pin="$(git rev-parse "HEAD:packages/brain" 2>/dev/null)" || _reg_pin=""
      case "$_reg_pin" in *[!0-9a-f]*) _reg_pin="" ;; esac
      [ "${#_reg_pin}" -eq 40 ] || _reg_pin=""
      _reg_ref="${_reg_pin:-<no-pin>}:data/model-registry.json"
      _reg_want=""
      if [ -n "$_reg_pin" ] && git -C "$_reg_brain" cat-file blob "$_reg_ref" 2>/dev/null | jq -e "$_reg_valid" >/dev/null 2>&1; then
        _reg_want="$(git -C "$_reg_brain" cat-file blob "$_reg_ref" 2>/dev/null | sha256sum | cut -d' ' -f1)" || _reg_want=""
      fi
      case "$_reg_want" in
        e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855|*[!0-9a-f]*) _reg_want="" ;;
      esac
      [ "${#_reg_want}" -eq 64 ] || _reg_want=""
      [ -n "$_reg_want" ] || fail "the VM has no $_reg_rel (${_reg_line}) and this repo's committed
brain pin $_reg_ref is missing, unreadable, or not a registry
(fewer than 10 curated rows), so it cannot be seeded. NOTHING was pushed and
deploy.sh did NOT run."
      # The push: up to 3 attempts, each bounded at 180 s. Only a MISSING token
      # retries, and a repeat is safe because link(2) never replaces a path: if
      # an earlier attempt landed and only its answer was lost, the repeat
      # answers "exists" and the re-probe below must then find a VALID registry.
      _reg_res=""
      for _reg_ptry in 1 2 3; do
        _reg_rc=0
        _reg_out="$(git -C "$_reg_brain" cat-file blob "$_reg_ref" | vm_ssh_bounded 180 "A='$_reg_app'; R='$_reg_rel'; W='$_reg_want'
$_reg_push_body" 2>&1)" || _reg_rc=$?
        _reg_res="$(_reg_token SEED_RESULT "$_reg_out")" || _reg_res=""
        [ -n "$_reg_res" ] && break
        if [ "$_reg_ptry" -lt 3 ]; then
          echo ">>> registry seed push attempt $_reg_ptry got no answer (rc=$_reg_rc) — retrying in ${_reg_retry_sleep}s (link(2) never replaces, so a repeat is safe)"
          sleep "$_reg_retry_sleep"
        fi
      done
      case "$_reg_res" in
        written)
          echo "registry seed: VM had no $_reg_rel (${_reg_line}) — pushed the committed pin $_reg_ref ($(git -C "$_reg_brain" cat-file -s "$_reg_ref") bytes, $(git -C "$_reg_brain" cat-file blob "$_reg_ref" | jq -r "$_reg_curated" 2>/dev/null || echo '?') curated, updated_at $(git -C "$_reg_brain" cat-file blob "$_reg_ref" | jq -r '.updated_at // "unknown"' 2>/dev/null || echo unknown), sha256 verified on the VM); brain-api's boot refresh at the cutover takes it from here" ;;
        exists)
          if [ "$_reg_ptry" -gt 1 ]; then _reg_why="most likely an earlier attempt landed and only its answer was lost"; else _reg_why="it appeared on the VM between probe and push"; fi
          _reg_probe || _reg_no_answer
          case "${_reg_line%% *}" in
            present-valid) echo "registry seed: VM now has $_reg_rel ($_reg_why) and it is a real registry (${_reg_line#present-valid }) — left alone" ;;
            present-degenerate) _reg_degenerate "${_reg_line#present-degenerate }; $_reg_why" ;;
            *) fail "after the push answered 'exists' ($_reg_why) the re-probe reported
'$_reg_line' — inspect $_reg_app/$_reg_rel by hand. deploy.sh did NOT run." ;;
          esac ;;
        failed*)
          printf '%s\n' "$_reg_out" | tail -5 | sed 's/^/      /' >&2
          fail "registry seed push failed ON THE VM ($_reg_res): the VM side removed its temp and
placed nothing at $_reg_rel. deploy.sh did NOT run — re-run this wrapper." ;;
        *)
          printf '%s\n' "$_reg_out" | tail -5 | sed 's/^/      /' >&2
          fail "registry seed push got no answer after 3 attempts (last ssh rc=$_reg_rc).
The VM MAY OR MAY NOT now hold $_reg_rel — an attempt can land and
lose only its answer. Re-run this wrapper: the probe reports which.
deploy.sh did NOT run." ;;
      esac ;;
    *)
      printf '%s\n' "$_reg_out" | tail -5 | sed 's/^/      /' >&2
      fail "registry seed probe answered '$_reg_line', so this run cannot tell whether the
VM's $_reg_rel is usable (install jq on the VM, or inspect it by
hand). deploy.sh did NOT run." ;;
  esac
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
