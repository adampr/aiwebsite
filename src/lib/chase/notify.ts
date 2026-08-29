// Chase register: the weekday nudge, composed and sent (ARCHITECTURE.md
// §5.21). composeNudge() is PURE and exported so scripts/chase-tests.ts can
// pin the copy and the newline-forging defence without a network.
//
// SENT THROUGH sendGovernanceEmail (src/lib/governance/budget.ts) rather
// than a fifth raw Resend caller: that seam applies the §1 oversight BCC
// (oversightBcc) and Tron's signature at the send, so the copy below can
// neither forget the overseer nor go out unsigned.
//
// REPLY-TO. Every one of these emails names a person to answer, because the
// From address is an AI persona mailbox whose inbound lane feeds a
// conversational AI that knows nothing about this register: a colleague
// replying "this is not mine, stop" must not be answered by software. So
// the reply address rides on sendGovernanceEmail's FIRST-CLASS `replyTo`
// (Resend's own `reply_to` field), not as a custom header inside `headers`:
// Resend documents `reply_to` separately, and a Reply-To smuggled through
// `headers` is a header the vendor may simply drop, which fails silently
// and in the one direction that hurts. The body ALSO names the address in a
// plain sentence, because a header cannot be read by somebody forwarding
// the mail to their manager. The sentence is the guarantee; the field is
// the convenience.
//
// WHAT THE COPY MAY PROMISE. Only what the row's detector can actually do.
// A `manual` task (the schema DEFAULT) is closable by no query in this
// system, so telling its assignee "nothing else to do, I will notice"
// guarantees them the same email every weekday forever after they have
// finished. The auto-close sentence therefore appears only when at least
// one named ask carries a real detector, and the manual case says plainly
// that a person has to be told.
//
// ONE EMAIL PER PERSON PER DAY is the cap, so a nudge is grouped by
// ASSIGNEE, not by requester: if two people asked the same colleague for
// two things, both asks ride in one email and each item names who asked.
// Grouping by (assignee, requester) instead would produce two claims for
// one day, the second would lose the chase_send_day_uq race, and that
// requester's ask would silently never be chased at all.
//
// COPY RULES, all deliberate:
//   - It says who asked and what for, in their words, not "you have an
//     outstanding item".
//   - It carries the action URL, because every notification in this repo
//     ends in a link and none of them ends in "reply and tell me".
//   - It says plainly how to make it stop, including the case where the
//     request is simply wrong.
//   - It never counts the reminders at the reader, never says "still", and
//     never implies fault. The reminder count is oversight information and
//     belongs in the owner's weekly report, not in a colleague's inbox.
//   - No em dashes or en dashes (site rule).

import { sanitizeHeaderValue } from "@/lib/governance/approval";
import { sendGovernanceEmail } from "@/lib/governance/budget";
import {
  CHASE_CAPS,
  CHASE_NUDGE_SUBJECT,
  clip,
  daysBetween,
  formatDay,
  normalizeEmail,
  oneLine,
} from "./config";

/** One ask, as the nudge prints it. */
export interface NudgeTask {
  id: string;
  title: string;
  detail: string;
  actionUrl: string | null;
  openedAt: Date | null;
  /** Who asked for THIS item. Printed per item because one email can carry
   * asks from more than one person. */
  requesterEmail: string;
  /** chase_tasks.detector. Carried into the copy, not just the detector, so
   * the email cannot promise an automatic close that no query can deliver
   * (the DEFAULT detector is 'manual'). */
  detector: string;
}

export interface NudgeInput {
  assigneeName: string;
  assigneeEmail: string;
  /** The address that goes on Reply-To: the requester of the oldest open
   * ask in this email. Deterministic, and the person most likely to know
   * the whole story. */
  requesterEmail: string;
  /** ADMIN_EMAIL, from adminRecipient(). Named in the copy because the
   * requester is not guaranteed to be able to stop anything: chase:admin
   * runs on the VM as the deploy user, and this is the person who has it.
   * Passed in rather than read here so the builder stays pure. */
  overseerEmail: string;
  tasks: NudgeTask[];
  now: Date;
}

export interface ComposedEmail {
  subject: string;
  text: string;
  headers: Record<string, string>;
}

/** Every distinct requester in one email, oldest ask first. */
function requesters(tasks: NudgeTask[]): string[] {
  const seen: string[] = [];
  for (const t of tasks) {
    const r = normalizeEmail(t.requesterEmail);
    if (r && !seen.includes(r)) seen.push(r);
  }
  return seen;
}

/** Those addresses as a phrase. */
function requesterPhrase(tasks: NudgeTask[]): string {
  const seen = requesters(tasks);
  if (seen.length === 0) return "the person who asked";
  if (seen.length === 1) return seen[0];
  if (seen.length === 2) return `${seen[0]} or ${seen[1]}`;
  return `${seen.slice(0, -1).join(", ")} or ${seen[seen.length - 1]}`;
}

/** PURE. The whole nudge, header set included. */
export function composeNudge(input: NudgeInput): ComposedEmail {
  const name = clip(input.assigneeName, 80) || "there";
  const askers = requesterPhrase(input.tasks);
  const named = input.tasks.slice(0, CHASE_CAPS.tasksPerEmail);
  const extra = input.tasks.length - named.length;

  const lines: string[] = [
    `Hi ${name},`,
    ``,
    `This is an automatic weekday reminder from the XL.net AI site about work ${askers} asked you for. It is still open in our register, so one of these goes out each weekday until it is done. One email a day, however many items are on it.`,
    ``,
    input.tasks.length === 1
      ? `What was asked:`
      : `What was asked (${input.tasks.length} items):`,
  ];

  named.forEach((t, i) => {
    lines.push(``);
    lines.push(`${i + 1}. ${clip(t.title, CHASE_CAPS.titleMaxChars)}`);
    const detail = clip(t.detail, CHASE_CAPS.detailMaxChars);
    if (detail) lines.push(`   Why: ${detail}`);
    const days = t.openedAt
      ? daysBetween(t.openedAt.getTime(), input.now.getTime())
      : null;
    lines.push(
      `   Asked by ${normalizeEmail(t.requesterEmail)}${
        t.openedAt
          ? ` on ${formatDay(t.openedAt)} (${days} day${days === 1 ? "" : "s"} ago)`
          : ""
      }`
    );
    if (t.actionUrl) lines.push(`   Where to do it: ${oneLine(t.actionUrl)}`);
    // No link on this row: say where the work goes anyway. An ask with
    // neither a link nor a named destination is a reminder the reader
    // cannot act on, which is the one thing a daily email must never be.
    else
      lines.push(
        `   Where to do it: there is no link on this one, so send it to ${normalizeEmail(t.requesterEmail)} directly.`
      );
    // PER ITEM, because one email can mix the two kinds and a reader who is
    // told "I will notice" about a row no query can see is the person who
    // gets this email every weekday forever after finishing the work.
    lines.push(
      t.detector === "manual"
        ? `   How it closes: I cannot see this one from the site, so tell ${normalizeEmail(t.requesterEmail)} when it is done.`
        : `   How it closes: on its own, the next weekday morning after your work shows up on the site.`
    );
  });

  if (extra > 0) {
    lines.push(``);
    lines.push(
      `There ${extra === 1 ? "is 1 more item" : `are ${extra} more items`} on the same list. I name up to ${CHASE_CAPS.tasksPerEmail} here so this stays readable; ${askers} can send you the rest.`
    );
  }

  // WHAT THIS EMAIL IS ALLOWED TO PROMISE. Only the rows with a real
  // detector are closed by a query; a `manual` row is closed by a person
  // being told. Promising the automatic close for a manual row is how
  // somebody who did the work keeps getting this email every weekday.
  const auto = named.filter((t) => t.detector !== "manual");
  const manual = named.filter((t) => t.detector === "manual");
  lines.push(``, `How this stops:`);
  if (auto.length > 0 && manual.length === 0)
    lines.push(
      `- Done it? Nothing else to do. I check the site every weekday morning and close the request as soon as your work shows up, usually the next morning.`
    );
  else if (auto.length > 0)
    lines.push(
      `- Done it? Each item above says how it closes. The automatic ones close on their own the next weekday morning; for the others, tell ${askers} and they will close it.`
    );
  else
    lines.push(
      `- Done it? I cannot see this from the site, so it will not close by itself. Tell ${askers} and they will close it, and these emails stop.`
    );
  // The overseer is named because the requester alone is not guaranteed to
  // be able to stop anything: the only lever is chase:admin on the VM. When
  // the requester IS the overseer, saying "and copy yourself" would be
  // noise, so the sentence collapses.
  const overseer = normalizeEmail(input.overseerEmail);
  lines.push(
    overseer && !requesters(input.tasks).includes(overseer)
      ? `- Not yours, already handled somewhere else, or you need more time? Write to ${askers} and copy ${overseer}, who can pause or cancel the request so these emails stop.`
      : `- Not yours, already handled somewhere else, or you need more time? Write to ${askers}. They can pause or cancel the request and these emails stop.`
  );

  // Reply-To carries ONE address (the oldest ask's requester). When the
  // email mixes requesters, saying "write to A or B" without saying which
  // one the Reply button reaches sends "item 4 is not mine" to somebody who
  // has nothing to do with item 4.
  const askerList = requesters(input.tasks);
  const replyTo = normalizeEmail(input.requesterEmail);
  const others = askerList.filter((a) => a !== replyTo);
  lines.push(``);
  if (others.length === 0)
    lines.push(
      `I am software. Replying to this email reaches ${replyTo}, who is the person to talk to about any of this.`
    );
  else
    lines.push(
      `I am software. Replying to this email reaches ${replyTo}. For the items ${others.join(" and ")} asked for, write to them directly.`
    );

  return {
    subject: CHASE_NUDGE_SUBJECT,
    text: lines.join("\n"),
    headers: nudgeHeaders(),
  };
}

/** The RFC 3834 auto-response headers, and ONLY those. Auto-Submitted tells
 * a conforming responder not to answer this with a vacation message, and
 * X-Auto-Response-Suppress is Microsoft's equivalent: without them an
 * out-of-office bounces into the persona mailbox every weekday for the
 * length of somebody's holiday. Both values are constants.
 *
 * Reply-To is deliberately NOT here. RFC 5322 allows at most one Reply-To,
 * and the address now goes on sendGovernanceEmail's first-class `replyTo`
 * (Resend's `reply_to`); repeating it as a custom header would risk a
 * duplicate header on a message whose whole point is that a reply reaches a
 * human. */
export function nudgeHeaders(): Record<string, string> {
  return {
    "Auto-Submitted": "auto-generated",
    "X-Auto-Response-Suppress": "OOF, AutoReply",
  };
}

/** The one address a reply must reach, sanitized. Exported so the test suite
 * can pin that a stored value carrying a CR cannot inject a header. */
export function nudgeReplyTo(requesterEmail: string): string {
  return sanitizeHeaderValue(normalizeEmail(requesterEmail), 200);
}

/** Compose and send one person's nudge. Never throws on a vendor problem:
 * sendGovernanceEmail returns false on a refusal and swallows its own
 * exceptions, and the weekday job stamps that outcome onto the ledger row
 * it already claimed. */
export async function sendChaseNudge(input: NudgeInput): Promise<boolean> {
  const mail = composeNudge(input);
  return sendGovernanceEmail({
    to: normalizeEmail(input.assigneeEmail),
    subject: mail.subject,
    text: mail.text,
    headers: mail.headers,
    replyTo: nudgeReplyTo(input.requesterEmail),
  });
}
