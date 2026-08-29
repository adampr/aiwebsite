// Chase register: the weekly report (ARCHITECTURE.md §5.21).
//
// The owner's ask was "Report to me weekly if anyone is left that has not
// done what you asked". This report answers that question and two the ask
// implies but does not say: who claims to be done without anything
// confirming it, and who is in the register but is NOT being emailed at
// all. That second group is the one an unattended chaser quietly loses.
//
// IT SENDS EVERY WEEK, INCLUDING THE WEEK WHERE NOBODY IS OUTSTANDING.
// That is the single most important line in this file. A report that only
// arrives when there is bad news teaches the reader that no email means
// everything is fine, at which point a crashed timer, a bad DATABASE_URL, a
// revoked Resend key and a genuinely empty register are indistinguishable
// from the inbox. Sending an "all clear" every Monday makes silence mean
// exactly one thing: this is broken, go look.
//
// buildReportBody() is PURE. The send below it claims a chase_sends row
// with kind='report' FIRST, so the same unique index that stops a colleague
// being nudged twice in a day stops the owner getting two reports after a
// restart, a hand run or an overlapping timer fire. The report's claim is
// RECLAIMABLE while its outcome is not 'accepted' (claimSend's
// reclaimUnlessAccepted), because for this one message the thing that must
// not happen twice is a DELIVERY, and a claim that survived a failure would
// otherwise make a hand re-run the same day impossible and report the lost
// week as "already sent". scripts/chase-report.ts additionally exits
// NONZERO on a refusal so the unit's OnFailure alert turns a silent week
// into an email: the report is the one message with no backstop, since the
// only thing that would have reported its failure is the report.
//
// No em dashes or en dashes (site rule).

import { adminRecipient, sendGovernanceEmail } from "@/lib/governance/budget";
import {
  CHASE_CAPS,
  CHASE_REPORT_SUBJECT,
  chaseEnabled,
  clip,
  daysBetween,
  formatDay,
  normalizeEmail,
  utcDateKey,
} from "./config";
import {
  claimSend,
  recordSendOutcome,
  latestNudgeByAssignee,
  tasksForReport,
  unreachableAssignees,
  type ChaseSendFact,
  type ChaseTask,
} from "./db";

/** What the report needs from a register row. ChaseTask satisfies it
 * structurally; a narrower type keeps the pure builder testable from a
 * literal. */
export type ReportTask = Pick<
  ChaseTask,
  | "id"
  | "assigneeEmail"
  | "assigneeName"
  | "requesterEmail"
  | "title"
  | "status"
  | "blockedReason"
  | "pausedReason"
  | "openedAt"
  | "markedDoneAt"
  | "markedDoneBy"
  | "markedDoneNote"
  | "closedAt"
  | "closedBy"
  | "nudgeCount"
  | "lastNudgedOn"
  | "consecutiveSendFailures"
  | "createdAt"
>;

export interface ReportSections {
  outstanding: ReportTask[];
  claimedDone: ReportTask[];
  paused: ReportTask[];
  blocked: ReportTask[];
}

export interface ReportInput {
  now: Date;
  /** Every row in a status a person could still act on. */
  live: ReportTask[];
  /** Rows closed inside CHASE_CAPS.recentlyClosedDays. */
  recentlyClosed: ReportTask[];
  /** Last nudge per LOWERCASED assignee address. */
  lastSend: Map<string, ChaseSendFact>;
  /** WORK_CHASE_ENABLED as the job actually read it. Printed because a
   * report full of outstanding people while the sender is switched off
   * would otherwise read as "they are ignoring me". */
  nudgesEnabled: boolean;
  /** LOWERCASED assignee address -> why no email is going to them, for the
   * open rows whose assignee has left the directory or has a recorded
   * deletion. The weekday job SKIPS these, so without this line the owner
   * would read them as ordinary outstanding people who are ignoring him,
   * when in fact nothing has been sent at all. */
  unreachable?: Map<string, string>;
}

/** PURE. Split the live rows into the report's four groups. Order matters:
 * a claim of completion outranks the status, because "they say it is done"
 * is what the reader needs to see first about that row. */
export function partitionForReport(live: ReportTask[]): ReportSections {
  const sections: ReportSections = {
    outstanding: [],
    claimedDone: [],
    paused: [],
    blocked: [],
  };
  for (const t of live) {
    if (t.markedDoneAt && !t.closedAt) sections.claimedDone.push(t);
    else if (t.status === "paused") sections.paused.push(t);
    else if (t.status === "blocked") sections.blocked.push(t);
    else if (t.status === "open") sections.outstanding.push(t);
  }
  return sections;
}

function who(t: ReportTask): string {
  return `${clip(t.assigneeName, 60)} <${normalizeEmail(t.assigneeEmail)}>`;
}

/** The task id, on its own line under every item. The report's own call to
 * action is `npm run chase:admin <op> <task-id>`, and that command dies
 * without a uuid: a report that says four people need a ruling and then
 * makes the reader open psql to find out which rows they are is not a
 * report he can act on. */
function idLine(t: ReportTask): string {
  return `  id ${t.id}`;
}

/** The line that says nobody is being emailed about this open row. */
function unreachableLine(
  t: ReportTask,
  unreachable: Map<string, string> | undefined
): string | null {
  const why = unreachable?.get(normalizeEmail(t.assigneeEmail));
  return why
    ? `  NO EMAIL IS GOING OUT: ${clip(why, 200)}. Cancel the row, or put the person back in the directory.`
    : null;
}

function askedLine(t: ReportTask, now: Date): string {
  const when = t.openedAt ?? t.createdAt;
  const days = daysBetween(when.getTime(), now.getTime());
  return `  Asked ${formatDay(when)} (${days} day${days === 1 ? "" : "s"} ago) by ${normalizeEmail(t.requesterEmail)}`;
}

function lastSendLine(t: ReportTask, lastSend: Map<string, ChaseSendFact>): string {
  const fact = lastSend.get(normalizeEmail(t.assigneeEmail));
  const reminders = `reminders sent: ${t.nudgeCount}`;
  if (!fact)
    return `  ${reminders} · last email: none on record${t.consecutiveSendFailures > 0 ? ` · ${t.consecutiveSendFailures} send failure(s) in a row` : ""}`;
  const detail = fact.detail ? ` (${clip(fact.detail, 120)})` : "";
  const failing =
    t.consecutiveSendFailures > 0
      ? ` · ${t.consecutiveSendFailures} send failure(s) in a row, so treat this as a delivery problem before a person problem`
      : "";
  return `  ${reminders} · last email ${fact.sendDate}: ${fact.outcome ?? "unknown"}${detail}${failing}`;
}

/** PURE. The whole report body. */
export function buildReportBody(input: ReportInput): string {
  const s = partitionForReport(input.live);
  const needsRuling = s.paused.length + s.blocked.length;
  const out: string[] = [
    `Weekly chase report, ${utcDateKey(input.now)} (UTC).`,
    ``,
    `This email is sent every week whether or not anyone is outstanding. If a Monday goes by with no report, the job is broken; it does not mean everyone is up to date.`,
    ``,
    `Outstanding: ${s.outstanding.length}. Said done but not confirmed: ${s.claimedDone.length}. Needing a ruling from you: ${needsRuling}. Closed in the last ${CHASE_CAPS.recentlyClosedDays} days: ${input.recentlyClosed.length}.`,
  ];

  if (!input.nudgesEnabled)
    out.push(
      ``,
      `WEEKDAY REMINDERS ARE SWITCHED OFF (WORK_CHASE_ENABLED=0). Nobody below is being emailed, so nothing here is anyone ignoring you.`
    );

  const goneCount = s.outstanding.filter((t) =>
    input.unreachable?.has(normalizeEmail(t.assigneeEmail))
  ).length;
  if (goneCount > 0)
    out.push(
      ``,
      `${goneCount} outstanding row(s) name somebody the site no longer has in its records, or who has a recorded deletion. THE WEEKDAY JOB IS SENDING THEM NOTHING, and the rows say so below. They are not ignoring you.`
    );

  // 1. Still outstanding.
  out.push(``, `1. STILL OUTSTANDING (${s.outstanding.length})`);
  if (s.outstanding.length === 0) {
    out.push(`   Nobody. Every open request has been answered.`);
  } else {
    out.push(
      `   Asked, not answered, and being emailed each weekday.`,
      ``
    );
    for (const t of s.outstanding) {
      out.push(`- ${who(t)}`);
      out.push(`  Ask: ${clip(t.title, CHASE_CAPS.titleMaxChars)}`);
      out.push(idLine(t));
      out.push(askedLine(t, input.now));
      out.push(lastSendLine(t, input.lastSend));
      const gone = unreachableLine(t, input.unreachable);
      if (gone) out.push(gone);
    }
  }

  // 2. Said done, nothing confirms it.
  out.push(``, `2. SAID DONE BUT NOT CONFIRMED (${s.claimedDone.length})`);
  out.push(
    `   Somebody said they finished, and no detector has confirmed it. Reminders to them are stopped. Nothing writes this today: the inbound "done" lane is designed and deliberately deferred (see ARCHITECTURE §5.21), so this section stays empty until an operator or that lane fills it.`
  );
  if (s.claimedDone.length === 0) {
    out.push(`   None.`);
  } else {
    out.push(``);
    for (const t of s.claimedDone) {
      out.push(`- ${who(t)}`);
      out.push(`  Ask: ${clip(t.title, CHASE_CAPS.titleMaxChars)}`);
      out.push(idLine(t));
      out.push(
        `  Said done ${formatDay(t.markedDoneAt)} by ${clip(t.markedDoneBy ?? "unknown", 80)}${t.markedDoneNote ? `: ${clip(t.markedDoneNote, 200)}` : ""}`
      );
      out.push(askedLine(t, input.now));
    }
  }

  // 3 and 4 are the ones nobody is being emailed about.
  out.push(``, `3. PAUSED (${s.paused.length})`);
  out.push(
    `   Reminders stopped on purpose. NOBODY IS BEING EMAILED about these, so they sit here until you rule on them. To restart one: npm run chase:admin -- open <id> --actor <you> --apply, which re-dates the ask so the thing that paused it cannot immediately pause it again.`
  );
  if (s.paused.length === 0) {
    out.push(`   None.`);
  } else {
    out.push(``);
    for (const t of s.paused) {
      out.push(`- ${who(t)}`);
      out.push(`  Ask: ${clip(t.title, CHASE_CAPS.titleMaxChars)}`);
      out.push(idLine(t));
      out.push(`  Paused because: ${clip(t.pausedReason ?? "no reason recorded", 300)}`);
      out.push(askedLine(t, input.now));
    }
  }

  out.push(``, `4. BLOCKED (${s.blocked.length})`);
  out.push(
    `   Never opened, so NO EMAIL HAS EVER GONE OUT for these. They are waiting on a decision, not on the person named.`
  );
  if (s.blocked.length === 0) {
    out.push(`   None.`);
  } else {
    out.push(``);
    for (const t of s.blocked) {
      out.push(`- ${who(t)}`);
      out.push(`  Ask: ${clip(t.title, CHASE_CAPS.titleMaxChars)}`);
      out.push(idLine(t));
      out.push(
        `  Blocked because: ${clip(t.blockedReason ?? "no reason recorded", 300)}`
      );
      out.push(`  Added ${formatDay(t.createdAt)} by ${normalizeEmail(t.requesterEmail)}`);
    }
  }

  // 5. Closed recently.
  out.push(
    ``,
    `5. CLOSED IN THE LAST ${CHASE_CAPS.recentlyClosedDays} DAYS (${input.recentlyClosed.length})`
  );
  if (input.recentlyClosed.length === 0) {
    out.push(`   None.`);
  } else {
    out.push(``);
    for (const t of input.recentlyClosed) {
      out.push(
        `- ${who(t)} · ${clip(t.title, CHASE_CAPS.titleMaxChars)} · ${t.status} ${formatDay(t.closedAt)} by ${clip(t.closedBy ?? "unknown", 60)}`
      );
    }
  }

  out.push(
    ``,
    `How to act on this: npm run chase:admin -- <op> <id> --actor <you> --apply on the VM, where <id> is the id printed under each item above and <op> is one of open, pause, unblock, close, decline, cancel. There is no admin page and no reply lane in this round; that boundary is documented in ARCHITECTURE §5.21.`
  );
  return out.join("\n");
}

export type ReportSendStatus =
  | "sent"
  | "refused"
  | "already_sent_today"
  | "threw";

/** Claim, compose, send, stamp. The claim comes FIRST and the report is not
 * composed at all if the claim loses: a second process getting as far as
 * building the body would still have read the register twice for nothing. */
export async function sendChaseReport(now = new Date()): Promise<{
  status: ReportSendStatus;
  sendId: string | null;
}> {
  const to = adminRecipient();
  // reclaimUnlessAccepted: the dedupe key for the REPORT is a SUCCESSFUL
  // send, not the existence of a row. Without it one transient failure
  // (a Resend 500, the 20s fetch timeout, a momentarily absent key) burns
  // the whole week: the row is already claimed, the operator's re-run is
  // told "already sent today", and the next scheduled fire is seven days
  // away on a Persistent=false timer. An 'accepted' row is never reclaimed,
  // so this can never produce a second delivered copy.
  const sendId = await claimSend({
    sendDate: utcDateKey(now),
    recipientEmail: to,
    kind: "report",
    taskIds: [],
    subject: CHASE_REPORT_SUBJECT,
    reclaimUnlessAccepted: true,
  });
  if (!sendId) return { status: "already_sent_today", sendId: null };
  try {
    const body = await buildReportBodyFromDb(now);
    const ok = await sendGovernanceEmail({
      to,
      subject: CHASE_REPORT_SUBJECT,
      text: body,
    });
    await recordSendOutcome(sendId, ok ? "accepted" : "refused");
    return { status: ok ? "sent" : "refused", sendId };
  } catch (err) {
    await recordSendOutcome(
      sendId,
      "threw",
      err instanceof Error ? err.message : "unknown"
    );
    return { status: "threw", sendId };
  }
}

/** The three reads the report needs, then the pure builder. Exported so
 * `npm run chase:report -- --dry-run` prints the exact body a real run
 * would send, without claiming a ledger row. */
export async function buildReportBodyFromDb(now: Date): Promise<string> {
  const { live, recentlyClosed } = await tasksForReport(now);
  const lastSend = await latestNudgeByAssignee(now);
  // The same liveness read the weekday job skips on, so the report can only
  // ever say "nobody is being emailed about this row" when that is true.
  const unreachable = await unreachableAssignees(
    live.filter((t) => t.status === "open").map((t) => t.assigneeEmail)
  );
  return buildReportBody({
    now,
    live,
    recentlyClosed,
    lastSend,
    nudgesEnabled: chaseEnabled(process.env),
    unreachable,
  });
}
