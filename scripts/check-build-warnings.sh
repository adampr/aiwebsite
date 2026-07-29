#!/usr/bin/env bash
# Build-warning regression gate (added 2026-07-25).
#
# `npm run build` must stay free of the warning classes below. Each of them has
# already regressed silently once (the edge-safety dynamic import in
# site.config.ts stopped being enough when Turbopack began bundling dynamic
# imports into the edge middleware graph), so this is enforced mechanically
# instead of by review.
#
# Usage:
#   scripts/check-build-warnings.sh              # runs `npm run build`, then checks
#   scripts/check-build-warnings.sh <build.log>  # checks an existing build log
#   npm run build:check                          # the first form
#
# Exit codes: 0 clean · 1 banned warning found · build's own code if it fails.
#
# Markers (substring match, case-sensitive — exactly what Next/Turbopack print):
#   "A Node.js module is loaded"               node: import reached an Edge bundle
#   "deprecated"                               deprecated convention/config (e.g.
#                                              the middleware→proxy rename)
#   "warning while optimizing"                 CSS optimizer warnings
#   "Encountered unexpected file in NFT list"  whole-project file trace
#                                              (currently suppressed via
#                                              turbopack.ignoreIssue in
#                                              next.config.ts — see the comment
#                                              there. CAVEAT: the flagged file
#                                              is always next.config.ts no
#                                              matter which module caused the
#                                              trace, so while that ignore rule
#                                              exists this marker can never
#                                              fire, even for a new host-side
#                                              offender. Remove the ignore when
#                                              the upstream blog.ts fix lands
#                                              to restore coverage.)
set -u

cd "$(dirname "$0")/.."

LOG="${1:-}"
if [ -z "$LOG" ]; then
  LOG="$(mktemp)"
  trap 'rm -f "$LOG"' EXIT
  npm run build 2>&1 | tee "$LOG"
  build_status=${PIPESTATUS[0]}
  if [ "$build_status" -ne 0 ]; then
    echo "check-build-warnings: build FAILED (exit $build_status)" >&2
    exit "$build_status"
  fi
elif [ ! -r "$LOG" ]; then
  echo "check-build-warnings: cannot read log file: $LOG" >&2
  exit 2
fi

fail=0
while IFS= read -r marker; do
  [ -z "$marker" ] && continue
  if grep -qF -- "$marker" "$LOG"; then
    echo "" >&2
    echo "check-build-warnings: banned warning marker found: \"$marker\"" >&2
    grep -nF -- "$marker" "$LOG" | head -5 >&2
    fail=1
  fi
done <<'MARKERS'
A Node.js module is loaded
deprecated
warning while optimizing
Encountered unexpected file in NFT list
MARKERS

if [ "$fail" -ne 0 ]; then
  echo "" >&2
  echo "check-build-warnings: FAILED — fix the warning(s) above; do not deploy." >&2
  exit 1
fi
echo "check-build-warnings: OK — no banned build warnings."

# JSX glued-text gate (added 2026-07-29). The pre-commit hook is the fast local
# signal, but it is skippable (--no-verify, a clone that never ran `npm install`,
# an editor that bypasses hooks, a submodule re-pin). This is the gate the deploy
# path actually runs, so a page whose copy would ship with a link glued to the
# next word cannot reach production. --module reports @aicompany/core findings
# without failing: those are fixed in that repo, not here.
if ! node "$(dirname "$0")/check-jsx-spacing.mjs" --module; then
  echo "" >&2
  echo "check-build-warnings: FAILED — glued JSX text (see above); do not deploy." >&2
  exit 1
fi

# /work static-snapshot gate (added 2026-07-29, §5.16). The team-submission
# lint checks title/facet uniqueness against a generated snapshot of the
# hand-authored /work exhibits; editing a static card without regenerating it
# (node scripts/work-static-snapshot.mjs --write) would silently stop the
# uniqueness scan, which is worse than not having one.
if ! node "$(dirname "$0")/work-static-snapshot.mjs" --check; then
  echo "" >&2
  echo "check-build-warnings: FAILED — /work static snapshot drifted (see above); do not deploy." >&2
  exit 1
fi
