#!/usr/bin/env bash
# Tests for the four OnFailure alert scripts deploy/post-install.sh installs
# (governance, linkcheck, chase, chase-report), 2026-09-16 refutation RC 7.
#
#   bash scripts/alert-body-tests.sh        (npm run test:alertbody)
#
# NO VM, NO NETWORK, NO MAIL. Each alert script is cut out of post-install.sh
# EXACTLY as the heredoc installs it, with only its two absolute paths (the
# shared .env and /var/log/) pointed at a temp dir. Two stubs go on PATH:
#
#   * curl   - records its argv, writes the --data-binary payload to a file,
#              and exits CURL_RC (0 = accepted, 22 = what `curl -f` returns
#              for an HTTP 4xx such as a Resend 422).
#   * logger - records its argv, standing in for the journal.
#
# The log tail is deliberately hostile: double quotes, an already-escaped
# \" pair, lone backslashes, tabs, CR and LF, an ESC byte, backticks, a
# $(command) and a UTF-8 character cut in half by `tail -c 1500`. The old
# sed-escaped body produced INVALID JSON for exactly this input; every body
# here must parse with `jq -e .`, carry the RFC 3834 pair, and round-trip the
# tail's text.
#
# What this CANNOT cover, and only the VM can: that jq and logger exist there
# (setup-vm.sh installs jq), and what Resend does with a valid body.
set -uo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
# POST_INSTALL_SRC: run the same suite against another copy (the baseline proof
# that the pre-2026-09-16 bodies FAIL it: git show <old>:deploy/post-install.sh).
src="${POST_INSTALL_SRC:-$root/deploy/post-install.sh}"
tmp_root="$(mktemp -d)"
trap 'rm -rf "$tmp_root"' EXIT

pass=0
fail=0
ok()  { pass=$((pass+1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail+1)); printf '  FAIL %s\n' "$1"; }

command -v jq >/dev/null || { echo "alert-body-tests: jq is required" >&2; exit 2; }

# ── stubs ──────────────────────────────────────────────────────────────────
stubs="$tmp_root/bin"
mkdir -p "$stubs"
cat > "$stubs/curl" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$STUB_DIR/curl.argv"
while [ $# -gt 0 ]; do
  if [ "$1" = "--data-binary" ] || [ "$1" = "-d" ]; then
    printf '%s' "$2" > "$STUB_DIR/body.json"; shift
  fi
  shift
done
exit "${CURL_RC:-0}"
STUB
cat > "$stubs/logger" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$STUB_DIR/logger.txt"
STUB
chmod +x "$stubs/curl" "$stubs/logger"

# ── the hostile log tail ───────────────────────────────────────────────────
# 1500 - len(suffix) must not be a multiple of 3, so the leading run of
# 3-byte "€" characters is cut mid-character by tail -c 1500.
suffix=$(printf 'job said "boom"\n\\"already escaped\\" and C:\\path\\to\\file\n\ttabbed\tcolumns\r\nesc=\033[31mred\033[0m `backticks` $(whoami) ${HOME}\nlast line\n')
while [ $(( (1500 - $(printf '%s\n' "$suffix" | wc -c)) % 3 )) -eq 0 ]; do suffix="${suffix}."; done
make_log() { # path
  {
    for _ in $(seq 1 700); do printf '\342\202\254'; done
    printf '%s\n' "$suffix"
  } > "$1"
}

# Needles that must survive into .text verbatim (jq decodes the JSON escapes).
needles=(
  'job said "boom"'
  '\"already escaped\"'
  'C:\path\to\file'
  $'\ttabbed\tcolumns'
  '`backticks` $(whoami) ${HOME}'
  'last line'
)

extract() { # script name -> heredoc body on stdout
  awk -v want="/usr/local/bin/$1 " '
    index($0, "sudo tee " want) == 1 && /<<'"'"'ALERT'"'"'$/ { grab = 1; next }
    grab && $0 == "ALERT" { exit }
    grab { print }
  ' "$src"
}

run_case() { # alert-name log-basename subject-needle
  local name="$1" log="$2" subject="$3"
  local d="$tmp_root/$name"
  mkdir -p "$d/log"
  printf '\n== %s\n' "$name"

  local body_src
  body_src="$(extract "aiwebsite-$name-alert.sh")"
  if [ -z "$body_src" ]; then bad "$name: heredoc not found in post-install.sh"; return; fi
  printf '%s\n' "$body_src" \
    | sed -e "s#/var/www/aiwebsite/.env#$d/app.env#g" -e "s#/var/log/#$d/log/#g" -e "s#/var/lib/#$d/lib/#g" \
    > "$d/alert.sh"
  if bash -n "$d/alert.sh"; then ok "$name: extracted script parses"; else bad "$name: syntax error"; return; fi
  if grep -q '/var/' "$d/alert.sh"; then bad "$name: an unrewritten /var path remains"; fi

  printf 'RESEND_API_KEY=offline-test-key\nADMIN_EMAIL=ops@example.test,second@example.test\n' > "$d/app.env"
  make_log "$d/log/$log"

  # 1. accepted send
  rm -f "$d/body.json" "$d/logger.txt" "$d/curl.argv"
  STUB_DIR="$d" CURL_RC=0 PATH="$stubs:$PATH" bash "$d/alert.sh"; local rc=$?
  [ "$rc" = 0 ] && ok "$name: exits 0 on an accepted send" || bad "$name: rc=$rc on an accepted send"
  if [ ! -s "$d/body.json" ]; then bad "$name: no body reached curl"; return; fi
  if jq -e . "$d/body.json" >/dev/null 2>&1; then ok "$name: body is valid JSON (jq -e .)"; else
    bad "$name: body is INVALID JSON"; head -c 400 "$d/body.json"; echo; return
  fi
  jq -e '.headers["Auto-Submitted"] == "auto-generated"' "$d/body.json" >/dev/null \
    && ok "$name: Auto-Submitted: auto-generated" || bad "$name: Auto-Submitted missing or wrong"
  jq -e '.headers["X-Auto-Response-Suppress"] == "All"' "$d/body.json" >/dev/null \
    && ok "$name: X-Auto-Response-Suppress: All" || bad "$name: X-Auto-Response-Suppress missing or wrong"
  jq -e '(.headers | keys) == ["Auto-Submitted", "X-Auto-Response-Suppress"]' "$d/body.json" >/dev/null \
    && ok "$name: no other headers (no Precedence)" || bad "$name: unexpected header set"
  jq -e '.to == ["ops@example.test"] and .from == "ai.xl.net Watchdog <noreply@ai.xl.net>"' "$d/body.json" >/dev/null \
    && ok "$name: from/to (first ADMIN_EMAIL entry)" || bad "$name: from/to wrong"
  jq -e --arg s "$subject" '.subject == $s' "$d/body.json" >/dev/null \
    && ok "$name: subject unchanged" || bad "$name: subject changed"
  local n
  for n in "${needles[@]}"; do
    jq -e --arg n "$n" '.text | contains($n)' "$d/body.json" >/dev/null \
      && ok "$name: tail round-trips: $(printf '%s' "$n" | tr '\t' '>' | cut -c1-40)" \
      || bad "$name: tail lost: $(printf '%q' "$n")"
  done
  jq -e '.text | contains("\u001b[31m")' "$d/body.json" >/dev/null \
    && ok "$name: ESC byte survives as \\u001b" || bad "$name: ESC byte lost"
  grep -qx -- '-sf' "$d/curl.argv" && ok "$name: curl -sf" || bad "$name: curl is not -sf"
  grep -qx -- '20' "$d/curl.argv" && grep -qx -- '-m' "$d/curl.argv" \
    && ok "$name: curl -m 20" || bad "$name: curl has no -m 20"
  [ ! -s "$d/logger.txt" ] && ok "$name: nothing logged on success" || bad "$name: logged on success"

  # 2. refused send (curl -f exit 22) is logged and fails the unit
  rm -f "$d/logger.txt"
  STUB_DIR="$d" CURL_RC=22 PATH="$stubs:$PATH" bash "$d/alert.sh"; rc=$?
  [ "$rc" != 0 ] && ok "$name: non-zero exit on a refused send (rc=$rc)" || bad "$name: exit 0 on a refused send"
  grep -qxF -- "-t aiwebsite-alert $name alert send failed" "$d/logger.txt" 2>/dev/null \
    && ok "$name: logger -t aiwebsite-alert \"$name alert send failed\"" \
    || { bad "$name: failure not logged"; cat "$d/logger.txt" 2>/dev/null; }
  jq -e --arg k "alert-unsent-$name" 'select(.key == $k and .source == "watchdog" and .severity == "CRITICAL" and .emailed == false)' "$d/lib/aiwebsite/issue-spool.d/alert-unsent.ndjson" >/dev/null 2>&1 \
    && ok "$name: a refused send spools a CRITICAL ledger row" || bad "$name: refused send left no ledger row"

  # 3. no key: NOT silent (diff refuter D1 A2) — no send, logged, non-zero, ledger row
  rm -f "$d/curl.argv" "$d/logger.txt" "$d/lib/aiwebsite/issue-spool.d/alert-unsent.ndjson"
  printf 'ADMIN_EMAIL=ops@example.test\n' > "$d/app.env"
  STUB_DIR="$d" CURL_RC=0 PATH="$stubs:$PATH" bash "$d/alert.sh"; rc=$?
  [ "$rc" != 0 ] && [ ! -e "$d/curl.argv" ] && ok "$name: no RESEND_API_KEY -> no send, non-zero exit" \
    || bad "$name: keyless run sent or exited 0 (rc=$rc)"
  grep -qxF -- "-t aiwebsite-alert $name alert NOT sent: RESEND_API_KEY missing" "$d/logger.txt" 2>/dev/null \
    && ok "$name: keyless run is logged" || bad "$name: keyless run not logged"
  jq -e --arg k "alert-unsent-$name" 'select(.key == $k)' "$d/lib/aiwebsite/issue-spool.d/alert-unsent.ndjson" >/dev/null 2>&1 \
    && ok "$name: keyless run spools a ledger row" || bad "$name: keyless run left no ledger row"
}

if bash -n "$src"; then ok "post-install.sh parses"; else bad "post-install.sh syntax error"; fi
installed=$(grep -c "^sudo tee /usr/local/bin/aiwebsite-.*-alert.sh >/dev/null <<'ALERT'$" "$src")
[ "$installed" = 4 ] && ok "post-install.sh installs exactly 4 alert scripts" \
  || bad "post-install.sh installs $installed alert scripts; this suite covers 4, extend it"

run_case governance   aiwebsite-governance.log   "[aiwebsite] CRITICAL Governance timer unit FAILED"
run_case linkcheck    aiwebsite-linkcheck.log    "[aiwebsite] CRITICAL roadmap link re-check FAILED"
run_case chase        aiwebsite-chase.log        "[aiwebsite] CRITICAL chase weekday job FAILED"
run_case chase-report aiwebsite-chase-report.log "[aiwebsite] CRITICAL chase weekly report FAILED"

printf '\n----------------------------------------------------------------\n'
printf 'alert-body: %s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
