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
