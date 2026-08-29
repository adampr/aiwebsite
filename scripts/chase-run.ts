#!/usr/bin/env -S npx tsx
// The chase register's weekday job (ARCHITECTURE.md §5.21). Installed as
// aiwebsite-chase.timer (Mon..Fri 13:00 UTC) by deploy/post-install.sh.
//
// Usage:
//   npm run chase:run                 send today's nudges
//   npm run chase:run -- --dry-run    print exactly what would be sent and
//                                     what would be closed; write NOTHING
//
// ORDER IS THE DESIGN, and it is this:
//
//   1. Refuse if WORK_CHASE_ENABLED=0. Nothing is read, nothing is written.
//   2. DETECT COMPLETIONS FIRST. Somebody who did the work yesterday
//      afternoon must be closed this morning, not nagged this morning and
//      closed tomorrow. Getting this order wrong is the single most
//      insulting bug this feature could ship, so it is step one.
//   3. Select the open tasks and group them by assignee. One person, one
//      email, however many asks they carry. Then DROP any assignee the site
//      no longer has in its records, or who has a recorded deletion: a
//      colleague who has left must not keep getting an automated email
//      every weekday because a row outlived them.
//   4. Per assignee, INSERT the chase_sends claim row BEFORE composing or
//      sending. The unique index chase_send_day_uq (send_date,
//      lower(assignee_email), kind) is the double-send guarantee: a timer
//      fire racing a hand run, a reboot catch-up, an overlapping pass and a
//      restart mid-batch all collapse to one email, because the loser of
//      the insert gets null back and sends nothing. A code-side "have we
//      sent today" check would not survive any of those.
//   5. RE-READ the group's statuses after the claim and before composing.
//      The list was materialised once and a batch can run for minutes; an
//      operator who pauses a row mid-batch has to be obeyed.
//   6. Send, then stamp the outcome on the claimed row. Every exit from the
//      per-assignee block reconciles the row it claimed, including the
//      throw path, so no ledger row is left at 'pending' looking delivered.
//
// Every assignee is wrapped in its own try/catch: one bad row, one bad
// address or one Resend hiccup must never cost the other twenty people
// their reminder.
//
// SENDING is weekday-only; DETECTION runs any day. A weekend run (a hand
// run, or a catch-up) still closes what people finished on Saturday, which
// is free and correct, and simply sends nothing.
//
// Exit code: 0 for a completed run, INCLUDING one where the vendor refused
// a message (that is recorded on the ledger row and reported in Monday's
// report; paging an operator every night about one permanently bad address
// would train them to ignore the alert). 1 only for a real failure: the
// register could not be read, or an assignee threw an exception the
// per-assignee guard did not expect. aiwebsite-chase-alert.service turns
// that 1 into an email.

import "./lib/governance-env";
import {
  CHASE_CAPS,
  CHASE_NUDGE_SUBJECT,
  chaseEnabled,
  clip,
  isChaseWeekday,
  normalizeEmail,
  utcDateKey,
} from "../src/lib/chase/config";
import {
  claimSend,
  closeTask,
  deployInProgress,
  markTasksNudged,
  markTasksSendFailed,
  openTasksForNudge,
  pauseTask,
  recordSendOutcome,
  stillOpenTaskIds,
  sweepOldSends,
  tasksForDetection,
  unreachableAssignees,
  type ChaseTask,
} from "../src/lib/chase/db";
import { adminRecipient } from "../src/lib/governance/budget";
import { candidatesFor, matchCompletion } from "../src/lib/chase/detect";
import { sendChaseNudge } from "../src/lib/chase/notify";

const DRY = process.argv.includes("--dry-run");

function log(msg: string): void {
  console.log(`[chase-run] ${msg}`);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Step 2. Close what has been done, pause the identical resubmissions.
 * Returns how many rows changed, AND the ids it acted on: a dry run writes
 * nothing, so without that set the very next read would hand those same
 * tasks to the send phase and print "WOULD SEND" for people a live run
 * would have closed. The one pre-flight an operator has before turning this
 * loose on colleagues has to name the right people. */
async function detectCompletions(now: Date): Promise<{
  closed: number;
  paused: number;
  errors: number;
  handledIds: Set<string>;
}> {
  let closed = 0;
  let paused = 0;
  let errors = 0;
  const handledIds = new Set<string>();
  const tasks = await tasksForDetection();
  log(`detect: ${tasks.length} open task(s) with an automatic detector`);
  for (const t of tasks) {
    try {
      // One facts object for both calls: the candidate query and the
      // decision must be looking at the same task, and building it twice is
      // how they would quietly stop doing so.
      const facts = {
        id: t.id,
        assigneeEmail: t.assigneeEmail,
        openedAt: t.openedAt,
        detector: t.detector,
        detectorArg: t.detectorArg,
      };
      const verdict = matchCompletion(facts, await candidatesFor(facts));
      if (verdict.kind === "none") continue;
      if (verdict.kind === "close") {
        log(
          `  CLOSE ${t.id.slice(0, 8)} ${normalizeEmail(t.assigneeEmail)} "${clip(t.title, 60)}" (${verdict.matchedOn}, submission ${verdict.submissionId.slice(0, 8)})`
        );
        handledIds.add(t.id);
        if (!DRY) {
          const ok = await closeTask({
            id: t.id,
            status: "done",
            closedBy: "detector",
            evidence: { ...verdict.evidence, detectedAt: now.toISOString() },
          });
          if (ok) closed++;
        } else closed++;
      } else {
        log(
          `  PAUSE ${t.id.slice(0, 8)} ${normalizeEmail(t.assigneeEmail)} "${clip(t.title, 60)}" (identical resubmission ${verdict.submissionId.slice(0, 8)})`
        );
        handledIds.add(t.id);
        if (!DRY) {
          const ok = await pauseTask({ id: t.id, reason: verdict.reason });
          if (ok) paused++;
        } else paused++;
      }
    } catch (err) {
      errors++;
      log(`  ERROR detecting ${t.id.slice(0, 8)}: ${errMessage(err)}`);
    }
  }
  return { closed, paused, errors, handledIds };
}

/** Step 3. One bucket per assignee, keyed on the LOWERCASED address so a
 * mixed-case row cannot become a second person with a second email. */
function groupByAssignee(tasks: ChaseTask[]): Map<string, ChaseTask[]> {
  const groups = new Map<string, ChaseTask[]>();
  for (const t of tasks) {
    const key = normalizeEmail(t.assigneeEmail);
    const bucket = groups.get(key);
    if (bucket) bucket.push(t);
    else groups.set(key, [t]);
  }
  return groups;
}

async function main(): Promise<void> {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    console.error(
      "[chase-run] Refusing to run as root: npx tsx caches inside the deploy user's checkout, and a root-owned cache file there breaks the next build for the user the site runs as. Run this as the deploy user."
    );
    process.exit(1);
  }

  const now = new Date();
  const day = utcDateKey(now);

  // deploy/post-install.sh enables AND starts this timer BEFORE setup-vm.sh
  // runs db:migrate and the cutover. Persistent=false stops a catch-up fire,
  // but a deploy running across 13:00 on a weekday would let the genuine
  // scheduled fire execute against the pre-migrate tree, throw, and page an
  // operator on the very deploy that shipped the feature. Same guard the
  // governance daily job uses, and quiet on purpose: exit 0, no alert, and
  // tomorrow's fire does the work.
  if (deployInProgress()) {
    log(
      `a deploy is in progress (the marker is fresh), so this run is skipped. Nothing was read and nothing was written; the next weekday fire will catch up.`
    );
    return;
  }

  if (!chaseEnabled(process.env)) {
    log(
      `WORK_CHASE_ENABLED=0: no detection, no email, nothing written. The weekly report is a separate switch (WORK_CHASE_REPORT_ENABLED).`
    );
    return;
  }

  log(`${DRY ? "DRY RUN (writes nothing)" : "LIVE"} · UTC day ${day}`);

  // ── Step 2: completions before reminders, always ─────────────────
  const detected = await detectCompletions(now);
  log(
    `detect: ${detected.closed} closed, ${detected.paused} paused, ${detected.errors} error(s)`
  );

  // ── Step 3: who is left ──────────────────────────────────────────
  // A DRY run wrote nothing, so the rows detection just decided to close or
  // pause are still status='open' in the database and would be re-selected
  // here. Filtering them out is what makes the dry run's "WOULD SEND" list
  // the same list a live run would actually email.
  const open = (await openTasksForNudge()).filter(
    (t) => !(DRY && detected.handledIds.has(t.id))
  );
  const groups = groupByAssignee(open);
  log(`${open.length} open task(s) across ${groups.size} assignee(s)`);

  if (!isChaseWeekday(now)) {
    log(
      `${day} is a weekend in UTC, so no reminders go out. Completions were still detected above.`
    );
    return;
  }

  if (groups.size > CHASE_CAPS.maxAssigneesPerRun) {
    console.error(
      `[chase-run] Refusing to email ${groups.size} people in one run (cap ${CHASE_CAPS.maxAssigneesPerRun}). That is not a normal register; check what seeded it before raising the cap.`
    );
    process.exit(1);
  }

  // ── Liveness: never chase somebody the site no longer has ────────
  // assignee_person_id is a probe, not a gate: the FK is SET NULL and a
  // person seeded from `users` alone never had one, so the gate is a LIVE
  // read of the same records the seed gate used, plus the site's own
  // do-not-contact record. A colleague who has left, or who exercised
  // deletion, must not keep receiving an automated email every weekday.
  // Skipped and logged rather than closed or paused: the row is still a true
  // record of an ask, and Monday's report prints the same reason under it.
  const gone = await unreachableAssignees([...groups.keys()]);
  for (const [addr, why] of gone) {
    log(`  SKIP ${addr}: ${why}. Nothing sent; the weekly report says so too.`);
    groups.delete(addr);
  }

  // ── Steps 4 and 5: claim, compose, send, stamp ───────────────────
  const overseerEmail = adminRecipient();
  let sent = 0;
  let refused = 0;
  let alreadyClaimed = 0;
  let stale = 0;
  let threw = 0;
  for (const [assigneeEmail, tasks] of groups) {
    // Hoisted OUT of the try: a throw between the claim and the outcome
    // stamp would otherwise leave the ledger row at outcome='pending'
    // forever, which the weekly report renders as "last email <date>:
    // pending", indistinguishable from a delivered nudge, with
    // consecutive_send_failures still 0 so the delivery-problem hint never
    // fires. Nothing else in the system reconciles a pending row.
    let sendId: string | null = null;
    let claimedIds: string[] = [];
    try {
      // Oldest ask first: it decides the Reply-To address and reads as the
      // most reasonable order for the person receiving it.
      tasks.sort(
        (a, b) =>
          (a.openedAt ?? a.createdAt).getTime() -
          (b.openedAt ?? b.createdAt).getTime()
      );
      const taskIds = tasks.map((t) => t.id);

      if (DRY) {
        log(
          `  WOULD SEND to ${assigneeEmail} (${tasks.length} item(s), reply-to ${normalizeEmail(tasks[0].requesterEmail)}): ${tasks.map((t) => clip(t.title, 40)).join(" | ")}`
        );
        sent++;
        continue;
      }

      // THE CLAIM, before a single character of the email is composed.
      sendId = await claimSend({
        sendDate: day,
        recipientEmail: assigneeEmail,
        kind: "nudge",
        taskIds,
        subject: CHASE_NUDGE_SUBJECT,
      });
      if (!sendId) {
        alreadyClaimed++;
        log(`  skip ${assigneeEmail}: already claimed for ${day}`);
        continue;
      }
      claimedIds = taskIds;

      // RE-READ between the claim and the compose. The group list was
      // materialised before this loop began and a batch can be minutes long;
      // an operator who pauses or cancels a row at 13:00:30 because the
      // person just phoned must not have that email go out at 13:02 anyway.
      const stillOpen = await stillOpenTaskIds(taskIds);
      const live = tasks.filter((t) => stillOpen.has(t.id));
      if (live.length === 0) {
        await recordSendOutcome(
          sendId,
          "skipped_stale",
          "every task in this claim stopped being open between the claim and the compose"
        );
        stale++;
        log(
          `  skip ${assigneeEmail}: every task moved out of 'open' after the claim; nothing sent`
        );
        continue;
      }
      if (live.length !== tasks.length)
        log(
          `  note ${assigneeEmail}: ${tasks.length - live.length} item(s) moved out of 'open' after the claim and are not in this email`
        );
      const liveIds = live.map((t) => t.id);
      claimedIds = liveIds;

      const ok = await sendChaseNudge({
        assigneeName: live[0].assigneeName,
        assigneeEmail,
        requesterEmail: live[0].requesterEmail,
        overseerEmail,
        now,
        tasks: live.map((t) => ({
          id: t.id,
          title: t.title,
          detail: t.detail,
          actionUrl: t.actionUrl,
          openedAt: t.openedAt,
          requesterEmail: t.requesterEmail,
          detector: t.detector,
        })),
      });
      if (ok) {
        await recordSendOutcome(sendId, "accepted");
        await markTasksNudged(liveIds, day);
        sent++;
        log(`  sent ${assigneeEmail} (${live.length} item(s))`);
      } else {
        await recordSendOutcome(
          sendId,
          "refused",
          "sendGovernanceEmail returned false (no key, or the vendor refused)"
        );
        await markTasksSendFailed(liveIds);
        refused++;
        log(`  REFUSED ${assigneeEmail}: the send seam returned false`);
      }
    } catch (err) {
      threw++;
      log(`  ERROR ${assigneeEmail}: ${errMessage(err)}`);
      // Reconcile the claim we may already hold, so the row never sits at
      // 'pending' pretending to be a delivered nudge.
      if (sendId) {
        try {
          await recordSendOutcome(sendId, "threw", errMessage(err));
          await markTasksSendFailed(claimedIds);
        } catch (inner) {
          log(`  ERROR stamping the ledger row for ${assigneeEmail}: ${errMessage(inner)}`);
        }
      }
    }
  }

  if (!DRY) {
    try {
      const swept = await sweepOldSends(now);
      if (swept > 0) log(`swept ${swept} chase_sends row(s) past retention`);
    } catch (err) {
      // A failed sweep is housekeeping, never a reason to fail the run.
      log(`sweep skipped: ${errMessage(err)}`);
    }
  }

  log(
    `done: ${sent} sent, ${refused} refused, ${alreadyClaimed} already claimed today, ${stale} stale, ${gone.size} skipped as no longer in the directory, ${threw} threw`
  );
  if (threw > 0 || detected.errors > 0) process.exit(1);
}

// process.exit on both paths: the postgres pool keeps the event loop alive,
// so a job that merely returns would sit there until the unit's timeout.
main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`[chase-run] FAILED: ${errMessage(err)}`);
    process.exit(1);
  });
