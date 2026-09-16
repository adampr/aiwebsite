#!/usr/bin/env node
// Per-call-site RFC 3834 header gate for this host's raw Resend senders.
//
// WHY. On 2026-09-14 an auto-responder condition at adam@xl.net drew a DSN on
// 6 of 7 header-less sends and on 0 of 9 sends that carried
// `Auto-Submitted`/`X-Auto-Response-Suppress` (Panel C, Resend GET /emails).
// Eight files in this repo posted to Resend with no headers at all, including
// all four CRITICAL OnFailure alert bodies in deploy/post-install.sh. The
// module's rendered senders have carried both headers since v1.93.0; the
// host-owned ones never did, and nothing would have noticed a new one.
//
// THE RULE, per file: occurrences of `Auto-Submitted` must be at least the
// number of send sites, where a send site is an occurrence of the Resend send
// URL or of an SDK `emails.send(` call. It is a COUNT, not "the file mentions
// the header": a file-level presence check passes a script that fixed three of
// its four alert bodies (refutation RC 8), which is exactly how post-install.sh
// looked half-way through the fix.
//
// It is a names-and-counts check, like the secrets gate: it stops the obvious
// omission (a new sender pasted without headers, a fourth body added beside
// three good ones), not a determined one.
//
// DISCOVERY FLOOR. The scan must find at least MIN_FILES send files. 14 exist
// on 2026-09-16; a pathspec typo, a moved directory or a broken `git grep`
// would otherwise find zero files and "pass" with nothing checked.
//
// Usage:
//   node scripts/check-resend-headers.mjs            # working tree (tracked + untracked)
//   node scripts/check-resend-headers.mjs --staged   # index blobs (pre-commit hook)
//   node scripts/check-resend-headers.mjs --self-test
//
// Exit codes: 0 clean · 1 a file has fewer headers than send sites · 2 the
// check itself could not run (never treat 2 as clean).

import { execFileSync } from "node:child_process";

export const MIN_FILES = 13;
const SCAN_PATHS = ["src", "scripts", "deploy"];
// Regex-escaped on purpose, so this file's own pattern text never matches.
const SEND_RE = "api\\.resend\\.com/emails|emails\\.send\\(";
const HEADER_RE = "Auto-Submitted";
const SELF = "scripts/check-resend-headers.mjs";

/** Per-path occurrence counts for one extended regex via `git grep -o`. */
function countOccurrences(pattern, staged) {
  const args = ["grep", "-o", "-I", "--null", "-E", "-e", pattern];
  args.push(staged ? "--cached" : "--untracked");
  args.push("--", ...SCAN_PATHS);
  let out = "";
  try {
    out = execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    // git grep exits 1 when nothing matched: an empty result, not a failure.
    if (err && typeof err === "object" && "status" in err && err.status === 1) out = "";
    else throw err;
  }
  const counts = new Map();
  for (const line of out.split("\n")) {
    if (!line) continue;
    const nul = line.indexOf("\0");
    if (nul <= 0) continue;
    const path = line.slice(0, nul);
    counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  return counts;
}

/**
 * Pure verdict over the two count maps. Exported for --self-test.
 * @returns {{ files: number, failures: {path: string, sends: number, headers: number}[], belowFloor: boolean }}
 */
export function evaluate(sendCounts, headerCounts, minFiles = MIN_FILES) {
  const failures = [];
  let files = 0;
  for (const [path, sends] of [...sendCounts.entries()].sort()) {
    if (path === SELF) continue;
    files++;
    const headers = headerCounts.get(path) ?? 0;
    if (headers < sends) failures.push({ path, sends, headers });
  }
  return { files, failures, belowFloor: files < minFiles };
}

function selfTest() {
  const m = (o) => new Map(Object.entries(o));
  // 3 of 4 bodies fixed: the exact half-fixed shape a file-level check passes.
  let r = evaluate(m({ "deploy/post-install.sh": 4 }), m({ "deploy/post-install.sh": 3 }), 1);
  if (r.failures.length !== 1) throw new Error("3 headers for 4 sends must fail");
  r = evaluate(m({ "a.ts": 1, "b.sh": 4 }), m({ "a.ts": 1, "b.sh": 4 }), 2);
  if (r.failures.length !== 0 || r.belowFloor) throw new Error("equal counts must pass");
  r = evaluate(m({ "a.ts": 1 }), m({ "a.ts": 2 }), 1);
  if (r.failures.length !== 0) throw new Error("more headers than sends must pass");
  r = evaluate(m({ "a.ts": 1 }), m({}), 1);
  if (r.failures.length !== 1) throw new Error("a header-less sender must fail");
  r = evaluate(m({ "a.ts": 1 }), m({ "a.ts": 1 }), 13);
  if (!r.belowFloor) throw new Error("discovery below the floor must not pass vacuously");
  r = evaluate(m({ [SELF]: 2 }), m({}), 0);
  if (r.failures.length !== 0 || r.files !== 0) throw new Error("the gate's own text is not a sender");
  console.log("check-resend-headers: self-test passed (6 cases).");
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) return selfTest();
  const staged = argv.includes("--staged");
  let sends;
  let headers;
  try {
    sends = countOccurrences(SEND_RE, staged);
    headers = countOccurrences(HEADER_RE, staged);
  } catch (err) {
    console.error(
      `check-resend-headers: could not run git grep (${err instanceof Error ? err.message.split("\n")[0] : err}).`
    );
    process.exit(2);
  }
  const { files, failures, belowFloor } = evaluate(sends, headers);
  if (belowFloor) {
    console.error(
      `check-resend-headers: discovered only ${files} Resend send file(s) under ${SCAN_PATHS.join(", ")}; the floor is ${MIN_FILES}.`
    );
    console.error("  A discovery this small means the scan is broken, not that the senders are gone.");
    console.error("  If senders really were removed, lower MIN_FILES in the same commit and say why.");
    process.exit(2);
  }
  if (failures.length > 0) {
    console.error(
      `check-resend-headers: ${failures.length} of ${files} Resend send file(s) carry fewer RFC 3834 headers than send sites:`
    );
    for (const f of failures)
      console.error(`  ${f.path}: ${f.sends} send site(s), ${f.headers} Auto-Submitted`);
    console.error(
      '  Every send needs "Auto-Submitted": "auto-generated" plus X-Auto-Response-Suppress'
    );
    console.error(
      '  ("All" for operator-only mail, "OOF, AutoReply" for mail that can reach a person). No Precedence header.'
    );
    process.exit(1);
  }
  console.log(`check-resend-headers: ${files} Resend send file(s), every send site carries RFC 3834 headers.`);
}

main();
