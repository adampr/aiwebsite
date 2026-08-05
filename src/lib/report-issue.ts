// Failure-email mirror into the module's reported_issues ledger (§5.15;
// owner directive 2026-08-05). The work email intake and the Troy budget
// lane reply to real people when a submission or command cannot be
// processed, and until now those replies lived only in mailboxes: the owner
// had to hunt them down and paste them back to know anything went wrong.
// Every such failure email is now also recorded as an open issue, so it
// shows up in the standing open-issues review (node scripts/issues.mjs
// list) alongside the fleet's WARN/FAIL alerts.
//
// Recording is strictly subordinate to replying (the record.ts contract):
// recordIssue never throws, callers never branch on it, and a ledger outage
// costs the mirror, never the reply. Source "module" is the app-lane source
// the ledger's closed enum provides for in-process recorders (the same one
// the module's own alert-mail seam uses); the key prefix carries the real
// origin ("work-intake:...", "governance:...").
//
// KEYS ARE EPISODIC, NEVER PER MESSAGE. An early draft keyed on the inbound
// email id, which gives one row per failed email and reads well for a
// handful of failures - but nothing ever resolves those rows, and
// `scripts/issues.mjs list` reads `/api/internal/issues?limit=500` ordered
// by last_seen DESC (module api.ts GET_LIMIT_MAX = 500). One mail loop at
// the per-sender ceiling (10 attempts/hour) fills that window in about two
// days and SILENTLY EVICTS every older open issue from the triage the
// module's CLAUDE.md makes mandatory - the mirror would break the very
// review surface it exists to feed. So the identity is (reason class, lane)
// and repeats bump `count` instead of opening rows; the recorder's
// last-wins rule keeps the most recent reply body in `detail`, so the owner
// still reads the actual bounce text, with its recurrence count next to it.

import { recordIssue } from "@aicompany/core/issues/record";
import { siteConfig } from "site.config";

/**
 * A stable episode class derived from the reply copy itself, so all 34 reject
 * branches get distinct keys without threading a reason code through every
 * call site (and without a hand-maintained code list that drifts from the
 * copy it names). Interpolated content is normalized away FIRST - quoted
 * spans, digits, and URLs are exactly what varies between two occurrences of
 * the SAME failure - leaving a slug of the branch's fixed wording.
 *
 * Collisions are safe by construction: two branches that normalize alike
 * share one row, which under-counts classes but never floods the ledger. The
 * failure mode this must not have is the opposite one.
 */
export function ledgerReasonSlug(message: string): string {
  return (
    message
      .replace(/"[^"]*"/g, " ")
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/\d+/g, "#")
      .toLowerCase()
      .replace(/[^a-z#]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "unclassified"
  );
}

export function reportFailureEmailIssue(opts: {
  key: string;
  subject: string;
  detail: string;
  /** True when the failure email actually went out. */
  emailed: boolean;
}): void {
  void recordIssue(siteConfig.site.slug, {
    source: "module",
    key: opts.key,
    severity: "WARN",
    subject: opts.subject,
    detail: opts.detail,
    emailed: opts.emailed,
  });
}
