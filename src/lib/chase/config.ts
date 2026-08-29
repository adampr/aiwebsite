// Chase register: the PURE layer (ARCHITECTURE.md §5.21). No DB, no fetch,
// no site.config import, so scripts/chase-tests.ts can pin every decision
// this feature makes without a database or a network.
//
// Owner ask 2026-08-29: "For any work by others, I recommend Tron emails
// them every week day until they have completed your requested task. Report
// to me weekly if anyone is left that has not done what you asked."
//
// Two levers, two rules, and everything else in this file is arithmetic:
//   - a weekday nudge to each assignee with an open task;
//   - a weekly report to ADMIN_EMAIL (adminRecipient(), NOT the per-task
//     requester: a requester who is not the owner is never mailed by this
//     lane), sent WHETHER OR NOT anyone is outstanding, so silence can only
//     ever mean the job is broken.

/** Bounds every chase decision respects. Deliberately small numbers: this
 * feature emails real colleagues, so every cap here is the answer to "what
 * is the worst a bug can do". */
export const CHASE_CAPS = {
  /** THE headline cap. At most one nudge per assignee per UTC day, no matter
   * how many tasks they carry or how many times the job runs. Enforced by
   * the chase_send_day_uq unique index (migration 0053), not by this
   * number: the constant exists so the copy and the tests can state it. */
  nudgesPerAssigneePerUtcDay: 1,
  /** At most this many tasks are NAMED in one email. Past it the mail says
   * how many more there are and points the person at the requester rather
   * than printing a wall of asks, which nobody reads and which turns a
   * reminder into a scolding. Every task still counts as chased. */
  tasksPerEmail: 6,
  /** Longest task title printed in an email or the report. */
  titleMaxChars: 160,
  /** Longest per-task detail line printed in a nudge. */
  detailMaxChars: 400,
  /** chase_sends.detail column budget (the failure message). */
  sendDetailMaxChars: 200,
  /** The weekly report's "closed recently" window. */
  recentlyClosedDays: 7,
  /** chase_sends sweep horizon. chase_tasks is NEVER swept (the row is the
   * evidence of who was asked what); the mail record outlives any plausible
   * "how many times did you actually email me" question. */
  sendsRetentionDays: 400,
  /** Refuse a batch larger than this rather than mailing a whole company
   * because a seed went wrong. Nothing legitimate comes near it. */
  maxAssigneesPerRun: 200,
  /** How long a chase_sends row may sit at outcome='pending' before the
   * weekly report's reclaimable claim will take it back. Well above the send
   * seam's own 20-second fetch timeout, so a row inside this window is a
   * live in-flight send (another process, or the timer racing a hand run)
   * and must not be reclaimed; past it, it is the debris of a process that
   * died mid-send and the week's report is still owed. */
  pendingStaleMinutes: 30,
} as const;

/* ------------------------------------------------------------------ *
 * Kill switches. governanceEnabled / workQueueDrainEnabled semantics
 * EXACTLY: default ON, the single string "0" turns it off, and turning it
 * off stops SENDING only. Nothing is deleted, nothing is closed, the
 * register keeps its rows and the detectors keep running the next time the
 * job is allowed to send, so flipping the switch back on does not produce
 * a backlog burst: a day that was not sent is simply a day that was not
 * sent (the dedupe axis is a calendar date, not a counter).
 * ------------------------------------------------------------------ */

/** Weekday nudge switch. 0 = nobody is emailed. The weekly report still
 * goes out (that is WORK_CHASE_REPORT_ENABLED's job), which is the point:
 * pausing the nudges must not also blind the owner to who is outstanding. */
export function chaseEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.WORK_CHASE_ENABLED !== "0";
}

/** Weekly report switch. 0 = the owner's Monday report stops. Separate from
 * the nudge switch on purpose: the report is the oversight surface, and an
 * operator silencing the reminders should have to silence the oversight
 * deliberately and separately. */
export function chaseReportEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.WORK_CHASE_REPORT_ENABLED !== "0";
}

/* ------------------------------------------------------------------ *
 * Calendar. All UTC, always: the systemd timer fires in UTC, the
 * chase_sends dedupe key is a UTC date, and a local-time reading would
 * make the "one per day" guarantee wobble twice a year.
 * ------------------------------------------------------------------ */

/** Monday to Friday, UTC. "every week day" in the owner's ask, and the
 * only definition of it in this feature. */
export function isChaseWeekday(date: Date): boolean {
  const d = date.getUTCDay(); // Sun=0 .. Sat=6
  return d >= 1 && d <= 5;
}

/** The chase_sends.send_date value for an instant: its UTC calendar day. */
export function utcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Whole days between two instants, floored at 0. Used for "asked N days
 * ago" copy, never for a decision. */
export function daysBetween(fromMs: number, toMs: number): number {
  return Math.max(0, Math.floor((toMs - fromMs) / 86_400_000));
}

/** A date for people: "2026-08-29". Not localized, not relative: the
 * report is read once a week by one person and an absolute UTC date is the
 * only form that stays true in a forwarded copy. */
export function formatDay(d: Date | null): string {
  return d ? utcDateKey(d) : "unknown";
}

/* ------------------------------------------------------------------ *
 * Text safety
 * ------------------------------------------------------------------ */

/** Collapse anything human-entered to ONE line before it is interpolated
 * into an email or the report. Titles, details and names are typed by a
 * person into a seed file; without this an embedded newline forges report
 * lines ("- Nobody is outstanding") that a reader cannot tell apart from
 * the lines this code wrote. Same shape as work/retention-encoding.ts
 * oneLine, spelled here so the chase lane stays importable with no /work
 * dependency. */
export function oneLine(s: string): string {
  return s
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** oneLine plus a length cap, with an explicit truncation marker so a
 * clipped ask never reads as a complete one. */
export function clip(s: string, max: number): string {
  const one = oneLine(s);
  return one.length <= max ? one : `${one.slice(0, Math.max(0, max - 3))}...`;
}

/** Case-folded address compare. Every email in this lane is lowercased at
 * the write edge and every read compares with lower(), so this is the
 * in-memory twin of the SQL. */
export function sameEmail(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** The one normalization applied before an address is written or compared.
 * Runs oneLine FIRST, not just trim: an address is as human-entered as a
 * title (an operator types both into the same seed JSON), and a stored
 * "someone@example.com\n  THIS TASK IS CANCELLED" would otherwise forge four lines in
 * the nudge and two in the report, which are the only interpolations that
 * were not already going through oneLine. */
export function normalizeEmail(a: string): string {
  return oneLine(a).toLowerCase();
}

/** Shape check only. The seed script's REAL gate is presence in the site's
 * own records (company_people or users); this just refuses obvious junk
 * before a query. */
export function looksLikeEmail(a: string): boolean {
  return /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/.test(a.trim());
}

/* ------------------------------------------------------------------ *
 * Vocabulary. These strings are load-bearing: the CHECK constraints in
 * migration 0053 pin the same sets, so a typo here fails at the database
 * rather than silently making a task invisible to the sender.
 * ------------------------------------------------------------------ */

export const CHASE_STATUSES = [
  "blocked",
  "open",
  "paused",
  "done",
  "declined",
  "cancelled",
] as const;
export type ChaseStatus = (typeof CHASE_STATUSES)[number];

export const CHASE_TERMINAL_STATUSES = [
  "done",
  "declined",
  "cancelled",
] as const;

export const CHASE_DETECTORS = [
  "manual",
  "work_submission",
  "work_update_child",
] as const;
export type ChaseDetector = (typeof CHASE_DETECTORS)[number];

export function isChaseStatus(v: string): v is ChaseStatus {
  return (CHASE_STATUSES as readonly string[]).includes(v);
}

export function isChaseDetector(v: string): v is ChaseDetector {
  return (CHASE_DETECTORS as readonly string[]).includes(v);
}

/* ------------------------------------------------------------------ *
 * Subjects. STABLE STRINGS, deliberately carrying no count, no name and no
 * date: a subject that changes every day starts a new thread every day in
 * every mail client, and the person being reminded then sees five separate
 * unread messages instead of one conversation they can scroll. The ledger
 * also stores the subject it sent, so a stable constant keeps the audit
 * readable.
 * ------------------------------------------------------------------ */

export const CHASE_NUDGE_SUBJECT = "Reminder about work XL.net asked you for";

/** Owner-facing, so it carries the [aiwebsite] prefix every operations
 * email from this host uses. */
export const CHASE_REPORT_SUBJECT =
  "[aiwebsite] Weekly chase report: outstanding requests";

/** chase_sends.kind values (chase_send_kind_ck). */
export const CHASE_SEND_KINDS = ["nudge", "report"] as const;
export type ChaseSendKind = (typeof CHASE_SEND_KINDS)[number];

/** chase_sends.outcome vocabulary. "accepted" means the vendor took the
 * message (a Resend 202). It is NOT delivery: this repo has no bounce-to-
 * application path, so the report prints the last accepted date and lets
 * the owner correlate it against his own bounce alerts. */
export const CHASE_SEND_OUTCOMES = [
  "pending",
  "accepted",
  "refused",
  "threw",
  "skipped_disabled",
  "skipped_dry_run",
  /** The claim was won, and then the re-read between the claim and the
   * compose found every task in it no longer open: an operator paused or
   * cancelled the row while the batch was in flight. Nothing was sent, and
   * the claim row stays as the evidence of that. */
  "skipped_stale",
] as const;
export type ChaseSendOutcome = (typeof CHASE_SEND_OUTCOMES)[number];
