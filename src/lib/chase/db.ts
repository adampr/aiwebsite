// Chase register: every read and write against chase_tasks / chase_sends
// (ARCHITECTURE.md §5.21). Server-only (DB imports); the decisions all live
// in ./config, ./detect and ./report, which stay DB-free.
//
// House rules this file follows without exception:
//   - EXPLICIT column projections. `select()` with no argument would pull
//     close_evidence_json and every future column into memory on a path
//     that runs unattended on a timer; naming the columns also means a
//     dropped column fails the build instead of the job.
//   - isUuid() before any id reaches a query. An unparseable uuid is a
//     Postgres ERROR, not an empty result, and a script that dies mid-batch
//     because someone pasted a truncated id is a worse outcome than a
//     "no such task" line.
//   - lower() on BOTH sides of every address compare, matching the
//     lower(assignee_email) expression indexes in migration 0053 so a
//     mixed-case write can never become a second spelling of one person.
//   - updated_at via sql`now()` (the DB clock), never a JS Date: the send
//     job and a hand-run admin command must order correctly against each
//     other even when one box's clock has drifted.

import { createHash } from "node:crypto";
import fs from "node:fs";
import { and, asc, desc, eq, gte, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import {
  CHASE_CAPS,
  normalizeEmail,
  type ChaseSendKind,
  type ChaseSendOutcome,
} from "./config";

const T = schema.chaseTasks;
const S = schema.chaseSends;
const CP = schema.companyPeople;
const U = schema.users;
const DS = schema.directorySuppressions;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

/** `db`, or the transaction handle db.transaction() hands its callback. The
 * seed's insert loop runs inside one transaction (a batch that fails halfway
 * would start emailing some people about a list the operator was told was
 * refused), so the two writes it uses take this instead of closing over the
 * pool. Derived from db.transaction's own callback type rather than named,
 * so it cannot drift from the driver. */
export type ChaseDbClient =
  | typeof db
  | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The projection every task read uses. close_evidence_json is deliberately
 * absent: nothing outside an incident investigation needs it, and it is the
 * one column that can grow. */
const TASK_COLS = {
  id: T.id,
  assigneeEmail: T.assigneeEmail,
  assigneeName: T.assigneeName,
  assigneePersonId: T.assigneePersonId,
  requesterEmail: T.requesterEmail,
  title: T.title,
  detail: T.detail,
  actionUrl: T.actionUrl,
  status: T.status,
  blockedReason: T.blockedReason,
  pausedReason: T.pausedReason,
  openedAt: T.openedAt,
  detector: T.detector,
  detectorArg: T.detectorArg,
  markedDoneAt: T.markedDoneAt,
  markedDoneBy: T.markedDoneBy,
  markedDoneNote: T.markedDoneNote,
  closedAt: T.closedAt,
  closedBy: T.closedBy,
  declinedReason: T.declinedReason,
  nudgeCount: T.nudgeCount,
  firstNudgedOn: T.firstNudgedOn,
  lastNudgedOn: T.lastNudgedOn,
  lastAcceptedSendAt: T.lastAcceptedSendAt,
  consecutiveSendFailures: T.consecutiveSendFailures,
  createdAt: T.createdAt,
} as const;

/** One register row as every chase surface sees it. Dates are Date objects;
 * first_nudged_on / last_nudged_on are `date` columns and therefore
 * "YYYY-MM-DD" strings, the same shape as chase_sends.send_date. */
export interface ChaseTask {
  id: string;
  assigneeEmail: string;
  assigneeName: string;
  assigneePersonId: string | null;
  requesterEmail: string;
  title: string;
  detail: string;
  actionUrl: string | null;
  status: string;
  blockedReason: string | null;
  pausedReason: string | null;
  openedAt: Date | null;
  detector: string;
  detectorArg: string | null;
  markedDoneAt: Date | null;
  markedDoneBy: string | null;
  markedDoneNote: string | null;
  closedAt: Date | null;
  closedBy: string | null;
  declinedReason: string | null;
  nudgeCount: number;
  firstNudgedOn: string | null;
  lastNudgedOn: string | null;
  lastAcceptedSendAt: Date | null;
  consecutiveSendFailures: number;
  createdAt: Date;
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

/** THE send selector, and the same predicate as the chase_task_due_idx
 * partial index: status 'open' and nobody has claimed it done. A blocked
 * row is not "a task the sender chose to skip", it is invisible here. */
export async function openTasksForNudge(): Promise<ChaseTask[]> {
  return db
    .select(TASK_COLS)
    .from(T)
    .where(and(eq(T.status, "open"), isNull(T.markedDoneAt)))
    .orderBy(sql`lower(${T.assigneeEmail})`, asc(T.createdAt))
    .limit(2000);
}

/** The detector's input set: the same open rows, minus the manual ones,
 * which no query can ever close. Runs BEFORE the send, so a task finished
 * yesterday is closed rather than nagged this morning. */
export async function tasksForDetection(): Promise<ChaseTask[]> {
  return db
    .select(TASK_COLS)
    .from(T)
    .where(
      and(eq(T.status, "open"), isNull(T.markedDoneAt), ne(T.detector, "manual"))
    )
    .orderBy(asc(T.createdAt))
    .limit(2000);
}

/** Which of these ids are STILL open right now. The send loop materialises
 * its groups once and can then spend minutes sending; an operator who
 * pauses or cancels a row at 13:00:30 because the person just phoned must
 * not have that email go out at 13:02 anyway. Cheap (one indexed query per
 * assignee) and it is the difference between "the filter is correct" and
 * "the filter is correct at the moment it ran". */
export async function stillOpenTaskIds(ids: string[]): Promise<Set<string>> {
  const wanted = ids.filter(isUuid);
  if (wanted.length === 0) return new Set();
  const rows = await db
    .select({ id: T.id })
    .from(T)
    .where(and(inArray(T.id, wanted), eq(T.status, "open"), isNull(T.markedDoneAt)));
  return new Set(rows.map((r) => r.id));
}

export async function taskById(id: string): Promise<ChaseTask | null> {
  if (!isUuid(id)) return null;
  const rows = await db.select(TASK_COLS).from(T).where(eq(T.id, id)).limit(1);
  return rows[0] ?? null;
}

/** Everything the weekly report reads, in two queries: the live rows (every
 * status a person could still act on) and the ones closed inside the
 * window. Partitioning into the report's sections is report.ts's pure job. */
export async function tasksForReport(
  now: Date
): Promise<{ live: ChaseTask[]; recentlyClosed: ChaseTask[] }> {
  const since = new Date(
    now.getTime() - CHASE_CAPS.recentlyClosedDays * 86_400_000
  );
  const live = await db
    .select(TASK_COLS)
    .from(T)
    .where(inArray(T.status, ["blocked", "open", "paused"]))
    .orderBy(sql`lower(${T.assigneeEmail})`, asc(T.createdAt))
    .limit(2000);
  const recentlyClosed = await db
    .select(TASK_COLS)
    .from(T)
    .where(and(inArray(T.status, ["done", "declined", "cancelled"]), gte(T.closedAt, since)))
    .orderBy(desc(T.closedAt))
    .limit(500);
  return { live, recentlyClosed };
}

export interface ChaseSendFact {
  sendDate: string;
  outcome: string | null;
  detail: string | null;
  taskCount: number;
}

/** Latest nudge per assignee inside a bounded window, folded in JS rather
 * than with DISTINCT ON: the window is small, the fold is obvious, and the
 * report is the only caller. Keyed by the LOWERCASED address, because that
 * is the axis chase_send_day_uq dedupes on. */
export async function latestNudgeByAssignee(
  now: Date,
  windowDays = 45
): Promise<Map<string, ChaseSendFact>> {
  const since = new Date(now.getTime() - windowDays * 86_400_000);
  const rows = await db
    .select({
      sendDate: S.sendDate,
      assigneeEmail: S.assigneeEmail,
      outcome: S.outcome,
      detail: S.detail,
      taskCount: S.taskCount,
      claimedAt: S.claimedAt,
    })
    .from(S)
    .where(and(eq(S.kind, "nudge"), gte(S.claimedAt, since)))
    .orderBy(desc(S.claimedAt))
    .limit(5000);
  const out = new Map<string, ChaseSendFact>();
  for (const r of rows) {
    const key = normalizeEmail(r.assigneeEmail);
    // Rows arrive newest first, so the FIRST one seen per address wins.
    if (!out.has(key))
      out.set(key, {
        sendDate: r.sendDate,
        outcome: r.outcome,
        detail: r.detail,
        taskCount: r.taskCount,
      });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * The send ledger. Claim BEFORE composing, stamp the outcome after.
 * ------------------------------------------------------------------ */

/** Insert the (send_date, lower(recipient), kind) claim row. Returns the new
 * row id, or null when chase_send_day_uq already holds a row for that key,
 * which is the ENTIRE double-send guarantee: a timer fire, a hand run, a
 * reboot catch-up and two overlapping passes all collapse into one email
 * because the loser of the race gets null here and sends nothing.
 *
 * ON CONFLICT DO NOTHING with no target on purpose: chase_send_day_uq is an
 * EXPRESSION index (lower(assignee_email)), which drizzle cannot name in a
 * conflict target, and an untargeted DO NOTHING covers it.
 *
 * reclaimUnlessAccepted RE-KEYS THE DEDUPE ON A FAILED SEND rather than on
 * the row merely existing, and the weekly report passes it. Without it a
 * single transient failure loses the report for the whole week: the row is
 * claimed before the body is built, the send throws or is refused, the row
 * stays, and the operator's re-run gets null back and is told "already sent
 * today" when nothing was ever sent. The nudge deliberately does NOT pass
 * it: a colleague would rather miss one day's reminder than get two, and
 * Monday's report surfaces the failed sends anyway.
 *
 * WHAT IT WILL NOT TAKE BACK, and this is the whole safety of it: a row whose
 * outcome is 'accepted' (a delivered report; taking that back is exactly the
 * double-send the index exists to prevent) and a row that is still 'pending'
 * inside PENDING_STALE_MINUTES, which is another process mid-send. Only a
 * recorded failure, or a 'pending' row far older than any send could still be
 * in flight (the seam's own fetch timeout is 20 seconds), is reclaimable. So a
 * hand run racing the timer still collapses to one email. */
export async function claimSend(opts: {
  sendDate: string;
  recipientEmail: string;
  kind: ChaseSendKind;
  taskIds: string[];
  subject: string;
  reclaimUnlessAccepted?: boolean;
}): Promise<string | null> {
  if (opts.reclaimUnlessAccepted) {
    // Take back a row from the same day that never reached the vendor. The
    // outcome guard is the whole point: an 'accepted' row is untouchable, so
    // this can never turn into a second delivered copy.
    const reclaimed = await db
      .update(S)
      .set({
        claimedAt: sql`now()`,
        outcome: "pending",
        detail: null,
        taskIdsJson: JSON.stringify(opts.taskIds),
        taskCount: opts.taskIds.length,
        subject: opts.subject,
      })
      .where(
        and(
          eq(S.sendDate, opts.sendDate),
          sql`lower(${S.assigneeEmail}) = ${normalizeEmail(opts.recipientEmail)}`,
          eq(S.kind, opts.kind),
          sql`coalesce(${S.outcome}, '') <> 'accepted'`,
          sql`(${S.outcome} IN ('refused','threw') OR ${S.claimedAt} < now() - make_interval(mins => ${CHASE_CAPS.pendingStaleMinutes}::int))`
        )
      )
      .returning({ id: S.id });
    if (reclaimed[0]) return reclaimed[0].id;
  }
  const rows = await db
    .insert(S)
    .values({
      sendDate: opts.sendDate,
      assigneeEmail: normalizeEmail(opts.recipientEmail),
      kind: opts.kind,
      taskIdsJson: JSON.stringify(opts.taskIds),
      taskCount: opts.taskIds.length,
      subject: opts.subject,
      outcome: "pending",
    })
    .onConflictDoNothing()
    .returning({ id: S.id });
  return rows[0]?.id ?? null;
}

/** Stamp what the vendor did with the claimed row. sent_at is set ONLY on
 * "accepted", which means Resend took the message; acceptance is not
 * delivery, and nothing in this repo can tell the difference. */
export async function recordSendOutcome(
  sendId: string,
  outcome: ChaseSendOutcome,
  detail?: string | null
): Promise<void> {
  if (!isUuid(sendId)) return;
  await db
    .update(S)
    .set({
      outcome,
      detail: detail ? detail.slice(0, CHASE_CAPS.sendDetailMaxChars) : null,
      ...(outcome === "accepted" ? { sentAt: sql`now()` } : {}),
    })
    .where(eq(S.id, sendId));
}

/** Bounded opportunistic sweep of the mail record (chase_tasks is NEVER
 * swept: the row IS the evidence of who was asked what and when). */
export async function sweepOldSends(now: Date): Promise<number> {
  const cutoff = new Date(
    now.getTime() - CHASE_CAPS.sendsRetentionDays * 86_400_000
  )
    .toISOString()
    .slice(0, 10);
  const gone = await db
    .delete(S)
    .where(lt(S.sendDate, cutoff))
    .returning({ id: S.id });
  return gone.length;
}

/* ------------------------------------------------------------------ *
 * Task writes
 * ------------------------------------------------------------------ */

/** After an ACCEPTED nudge: the counters the weekly report prints. Derived
 * numbers only; chase_sends stays authoritative for what was actually sent. */
export async function markTasksNudged(
  taskIds: string[],
  sendDate: string
): Promise<void> {
  const ids = taskIds.filter(isUuid);
  if (ids.length === 0) return;
  await db
    .update(T)
    .set({
      nudgeCount: sql`${T.nudgeCount} + 1`,
      firstNudgedOn: sql`coalesce(${T.firstNudgedOn}, ${sendDate}::date)`,
      lastNudgedOn: sendDate,
      lastAcceptedSendAt: sql`now()`,
      consecutiveSendFailures: 0,
      updatedAt: sql`now()`,
    })
    .where(inArray(T.id, ids));
}

/** After a REFUSED or thrown send. The counter exists so a person whose
 * address bounces every single day shows up in the weekly report as a
 * delivery problem rather than as somebody ignoring their work. */
export async function markTasksSendFailed(taskIds: string[]): Promise<void> {
  const ids = taskIds.filter(isUuid);
  if (ids.length === 0) return;
  await db
    .update(T)
    .set({
      consecutiveSendFailures: sql`${T.consecutiveSendFailures} + 1`,
      updatedAt: sql`now()`,
    })
    .where(inArray(T.id, ids));
}

/** Serialize close evidence without ever storing a half-token. A byte slice
 * over already-serialized JSON cuts mid-string and leaves a row no reader
 * can parse, which the first incident investigation would be the one to
 * discover. Over budget, store the fact of the truncation instead. */
function clipEvidenceJson(evidence: unknown): string {
  const j = JSON.stringify(evidence) ?? "null";
  return j.length <= 4000
    ? j
    : JSON.stringify({ truncated: true, bytes: j.length });
}

/** Close a task. `closedBy` is 'detector' or 'owner:<email>'; status and
 * closed_at move together, which chase_task_closed_ck also enforces.
 * Guarded on closed_at IS NULL so a re-run cannot rewrite the history of a
 * row that closed weeks ago. */
export async function closeTask(opts: {
  id: string;
  status: "done" | "declined" | "cancelled";
  closedBy: string;
  evidence?: unknown;
  declinedReason?: string | null;
}): Promise<boolean> {
  if (!isUuid(opts.id)) return false;
  const done = await db
    .update(T)
    .set({
      status: opts.status,
      closedAt: sql`now()`,
      closedBy: opts.closedBy.slice(0, 200),
      ...(opts.evidence === undefined
        ? {}
        : { closeEvidenceJson: clipEvidenceJson(opts.evidence) }),
      ...(opts.declinedReason === undefined
        ? {}
        : { declinedReason: opts.declinedReason }),
      updatedAt: sql`now()`,
    })
    .where(and(eq(T.id, opts.id), isNull(T.closedAt)))
    .returning({ id: T.id });
  return done.length > 0;
}

/** Pause an OPEN task with a reason. The reason is required by
 * chase_task_paused_ck and printed in the weekly report: a paused row is
 * one nobody is being emailed about, so the owner has to be able to read
 * why without opening a database. */
export async function pauseTask(opts: {
  id: string;
  reason: string;
}): Promise<boolean> {
  if (!isUuid(opts.id)) return false;
  const done = await db
    .update(T)
    .set({
      status: "paused",
      pausedReason: opts.reason.slice(0, 500),
      updatedAt: sql`now()`,
    })
    .where(and(eq(T.id, opts.id), eq(T.status, "open")))
    .returning({ id: T.id });
  return done.length > 0;
}

/** Move a blocked or paused row to open, which is the ONLY gesture that
 * starts email to a person. An already-open row is a no-op, not an error.
 *
 * opened_at is the detector's TIME FLOOR (chase_task_open_ck requires it),
 * and the two cases need different answers:
 *
 *   from 'blocked'  stamp it only if it was never set. The ask has not been
 *                   re-made; work done before it still must not close it.
 *   from 'paused'   RESET it to now(), unconditionally. Both automatic
 *                   pauses in this feature (the identical-resubmission
 *                   rule, and the near-matched submission the review still
 *                   holds) rest on a submission that is still sitting
 *                   there at or after the old floor. Preserving the floor
 *                   would let the very next chase-run re-pause the row
 *                   inside the same run, making the operator's `chase:admin
 *                   open` silently inert and the automatic pause a one-way
 *                   trip nobody is ever emailed about again. Resetting says
 *                   what the gesture means: we are asking again, from now.
 */
export async function openTask(opts: {
  id: string;
  from: "blocked" | "paused";
}): Promise<boolean> {
  if (!isUuid(opts.id)) return false;
  const done = await db
    .update(T)
    .set({
      status: "open",
      openedAt:
        opts.from === "paused" ? sql`now()` : sql`coalesce(${T.openedAt}, now())`,
      // Cleared on the way out of paused so a stale reason cannot be read
      // later as the current one; blocked_reason is KEPT as history.
      ...(opts.from === "paused" ? { pausedReason: null } : {}),
      updatedAt: sql`now()`,
    })
    .where(and(eq(T.id, opts.id), eq(T.status, opts.from)))
    .returning({ id: T.id });
  return done.length > 0;
}

/** Seed insert. Returns "inserted", or "duplicate" when chase_task_live_uq
 * already holds a live row for this (assignee, detector, arg, title): the
 * anti-reseed rail, and the reason this returns a word rather than
 * throwing. Nothing else stops a second run of the seed from inserting the
 * whole register again. */
export async function insertTask(row: {
  assigneeEmail: string;
  assigneeName: string;
  assigneePersonId: string | null;
  requesterEmail: string;
  title: string;
  detail: string;
  actionUrl: string | null;
  status: "blocked" | "open";
  blockedReason: string | null;
  openedAt: Date | null;
  detector: string;
  detectorArg: string | null;
  detectorMdSha256: string | null;
}, client: ChaseDbClient = db): Promise<"inserted" | "duplicate"> {
  const inserted = await client
    .insert(T)
    .values({
      ...row,
      assigneeEmail: normalizeEmail(row.assigneeEmail),
      requesterEmail: normalizeEmail(row.requesterEmail),
    })
    .onConflictDoNothing()
    .returning({ id: T.id });
  return inserted.length > 0 ? "inserted" : "duplicate";
}

/* ------------------------------------------------------------------ *
 * The seeding gate: is this address one the site already knows?
 * ------------------------------------------------------------------ */

/** The subset of `emails` that already appears in the site's OWN records:
 * company_people (the directory) or users (anyone who has signed in). Both
 * compares are case-folded. This is the seed script's hard gate, and it is
 * a read rather than a regex on purpose: a domain check would happily let
 * somebody invent an address at a domain we recognise. */
export async function knownDirectoryEmails(
  emails: string[]
): Promise<Set<string>> {
  const wanted = [...new Set(emails.map(normalizeEmail))].filter(Boolean);
  const found = new Set<string>();
  if (wanted.length === 0) return found;
  // inArray over an EXPRESSION (lower(email)), not over the raw column: the
  // directory stores what an import gave it, so a "Name@Example.com" row must
  // still match a lowercased seed entry.
  const people = await db
    .select({ email: CP.email })
    .from(CP)
    .where(inArray(sql`lower(${CP.email})`, wanted));
  for (const p of people) if (p.email) found.add(normalizeEmail(p.email));
  const users = await db
    .select({ email: U.email })
    .from(U)
    .where(inArray(sql`lower(${U.email})`, wanted));
  for (const u of users) found.add(normalizeEmail(u.email));
  return found;
}

/** sha256 of the LOWERCASED address, which is the only form
 * directory_suppressions stores (the PII itself is deliberately not
 * retained there). Same computation as roadmap/db.ts removePeople. */
function emailSha256(email: string): string {
  return createHash("sha256").update(normalizeEmail(email)).digest("hex");
}

/** The subset of `emails` the site has recorded as DO NOT CONTACT. When an
 * admin removes an Apollo-sourced person the sha256 of their address is
 * written to directory_suppressions precisely so future imports skip them;
 * a chaser that mails them every weekday anyway would be the site quietly
 * un-exercising somebody's deletion. Case-folded through emailSha256. */
export async function suppressedDirectoryEmails(
  emails: string[]
): Promise<Set<string>> {
  const wanted = [...new Set(emails.map(normalizeEmail))].filter(Boolean);
  const out = new Set<string>();
  if (wanted.length === 0) return out;
  const byHash = new Map(wanted.map((e) => [emailSha256(e), e]));
  const rows = await db
    .select({ emailSha256: DS.emailSha256 })
    .from(DS)
    .where(inArray(DS.emailSha256, [...byHash.keys()]));
  for (const r of rows) {
    const addr = byHash.get(r.emailSha256);
    if (addr) out.add(addr);
  }
  return out;
}

/** THE LIVENESS GATE, and the reason assignee_person_id is not it. The FK is
 * ON DELETE SET NULL and company_people removal is a hard DELETE, so a
 * colleague who has left keeps their register row, their address and their
 * daily email forever unless something re-asks the directory. This does,
 * live, at send time, on the SAME evidence the seed gate used (present in
 * company_people or users, and not suppressed), so a person who was seeded
 * from `users` alone is not falsely dropped the way a NULL person_id test
 * would drop them.
 *
 * Returns the addresses that must NOT be emailed, mapped to why. Deliberately
 * a SKIP and a report line rather than an automatic pause: the row is still a
 * true record of an ask, and closing or pausing it on a directory edit would
 * be this code deciding an offboarding settled somebody's obligation. */
export async function unreachableAssignees(
  emails: string[]
): Promise<Map<string, string>> {
  const wanted = [...new Set(emails.map(normalizeEmail))].filter(Boolean);
  const out = new Map<string, string>();
  if (wanted.length === 0) return out;
  const known = await knownDirectoryEmails(wanted);
  const suppressed = await suppressedDirectoryEmails(wanted);
  for (const e of wanted) {
    if (suppressed.has(e))
      out.set(e, "removed from the directory with deletion recorded (do not contact)");
    else if (!known.has(e))
      out.set(e, "no longer in company_people or users");
  }
  return out;
}

/** Fresh deploy marker = setup-vm.sh is mid-run. Byte-for-byte the rule in
 * governance/db.ts deployInProgress(), spelled here rather than imported so
 * the chase lane does not pull the governance module in.
 *
 * WHY THE JOBS NEED IT: deploy/post-install.sh enables AND starts both chase
 * timers BEFORE setup-vm.sh runs db:migrate and the cutover. Persistent=false
 * stops a catch-up fire, but a deploy that happens to be running at 13:00 on
 * a weekday would let the genuine scheduled fire execute against the
 * pre-migrate tree, throw, and page an operator on the very deploy that
 * shipped the feature. */
export function deployInProgress(): boolean {
  try {
    const stat = fs.statSync("/var/run/aiwebsite-deploy-in-progress");
    return Date.now() - stat.mtimeMs < 1_800_000;
  } catch {
    return false;
  }
}

/** The directory row for an address, if there is one. Fills
 * assignee_person_id, which is a LIVENESS PROBE and never the identity:
 * assignee_email and assignee_name are snapshots so the register still
 * reads in people's names after an offboarding SET NULLs this. */
export async function personIdForEmail(
  email: string,
  client: ChaseDbClient = db
): Promise<string | null> {
  const rows = await client
    .select({ id: CP.id })
    .from(CP)
    .where(sql`lower(${CP.email}) = ${normalizeEmail(email)}`)
    .limit(1);
  return rows[0]?.id ?? null;
}
