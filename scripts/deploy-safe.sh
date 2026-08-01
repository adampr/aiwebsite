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
# deploy.sh itself is template-rendered from @aicompany/core and verifies its
# own stamp, so the guard cannot live inside it. Run this instead:
#
#     bash scripts/deploy-safe.sh [--takeover] [--allow-sshpass]
#
# Escape hatch, for the rare deliberate case (never for "it is probably fine"):
#
#     bash scripts/deploy-safe.sh --dirty-ok
#
set -euo pipefail

cd "$(dirname "$0")/.."

dirty_ok="no"
passthru=()
for arg in "$@"; do
  case "$arg" in
    --dirty-ok) dirty_ok="yes" ;;
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

# ── 3. Say what is about to ship ─────────────────────────────────
echo ">>> Deploying from a clean tree at $(git rev-parse --short HEAD) ($branch)"
echo "    $(git log -1 --pretty=%s)"
if [ "$dirty_ok" = "yes" ] && [ -n "$dirty" ]; then
  echo "    --dirty-ok: $(echo "$dirty" | wc -l) uncommitted path(s) WILL ship"
fi
echo ""

exec bash deploy/deploy.sh "${passthru[@]}"
