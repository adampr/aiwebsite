#!/usr/bin/env -S npx tsx
// The chase register's weekly report job (ARCHITECTURE.md §5.21).
// Installed as aiwebsite-chase-report.timer (Mon 15:00 UTC) by
// deploy/post-install.sh.
//
// Usage:
//   npm run chase:report                 send this week's report
//   npm run chase:report -- --dry-run    print the exact body a real run
//                                        would send; claim nothing, send
//                                        nothing, write nothing
//
// SINCE 2026-11-02 A COMPLETELY QUIET REGISTER SENDS NOTHING (owner
// ruling, after weeks of zero-outstanding all-clears). Any row in any
// section still sends: one paused or blocked row waiting on a ruling
// arrives every Monday on purpose, because those are the rows nobody is
// being emailed about. The skip happens in sendChaseReport BEFORE the
// ledger claim, so a quiet Monday burns no row and a task seeded later
// the same day still gets a hand-run report. The old all-clear existed so
// silence meant breakage; that signal is narrowed, knowingly: a run that
// FAILS still exits 1 and fires the OnFailure CRITICAL email, but a timer
// that silently never fires during a quiet stretch now looks the same as
// a quiet register. See the header of src/lib/chase/report.ts.
//
// The send claims a chase_sends row with kind='report' before composing,
// so the same chase_send_day_uq index that stops a colleague being nudged
// twice stops the owner getting two reports after a restart or a hand run.
// That claim is RECLAIMABLE while its outcome is not 'accepted', so a
// transient failure does not burn the week: a hand re-run the same day takes
// the row back and sends for real, and only a DELIVERED report blocks a
// second one.
//
// EXIT 1 ON A REFUSAL, unlike scripts/chase-run.ts. The nudge's exit-0 rule
// is right for it (one permanently bad address must not page an operator
// nightly, and Monday's report surfaces the failed sends anyway); this
// report has NO backstop, because the only thing that would have reported
// its own failure is the report. A refused report that exited 0 would leave
// the owner with silence he is told to interpret as breakage and nothing at
// all telling him it happened, on a Mon-only Persistent=false timer whose
// next chance is seven days away. So a refusal fails the unit, and
// aiwebsite-chase-report-alert.service turns it into the CRITICAL email.
// Exit 1 also when the register could not be read or the send threw.

import "./lib/governance-env";
import {
  CHASE_CAPS,
  chaseReportEnabled,
  utcDateKey,
} from "../src/lib/chase/config";
import { deployInProgress, tasksForReport } from "../src/lib/chase/db";
import {
  buildReportBodyFromDb,
  registerHasNews,
  sendChaseReport,
} from "../src/lib/chase/report";

const DRY = process.argv.includes("--dry-run");

function log(msg: string): void {
  console.log(`[chase-report] ${msg}`);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function main(): Promise<void> {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    console.error(
      "[chase-report] Refusing to run as root: npx tsx caches inside the deploy user's checkout, and a root-owned cache file there breaks the next build for the user the site runs as. Run this as the deploy user."
    );
    process.exit(1);
  }

  const now = new Date();

  // post-install.sh starts this timer before db:migrate and the cutover, so
  // a deploy running across 15:00 on a Monday would otherwise fire against
  // the pre-migrate tree and page an operator on the deploy that shipped the
  // feature. Quiet skip, exit 0: an unsent report on a deploy Monday is a
  // known gap, and the operator can run `npm run chase:report` by hand,
  // which the reclaimable claim now allows.
  if (deployInProgress()) {
    log(
      `a deploy is in progress (the marker is fresh), so this run is skipped. Re-run npm run chase:report by hand once the deploy finishes.`
    );
    return;
  }

  if (!chaseReportEnabled(process.env)) {
    log(
      `WORK_CHASE_REPORT_ENABLED=0: no report this week. Weekday reminders are a separate switch (WORK_CHASE_ENABLED) and are unaffected.`
    );
    return;
  }

  if (DRY) {
    log(`DRY RUN for UTC day ${utcDateKey(now)}: nothing claimed, nothing sent.`);
    const { live, recentlyClosed } = await tasksForReport(now);
    if (!registerHasNews(live, recentlyClosed))
      log(
        `the register is quiet, so a LIVE run today would SKIP the send entirely (owner ruling, 2026-11-02). The body below is what a non-quiet week looks like.`
      );
    console.log("");
    console.log(await buildReportBodyFromDb(now));
    return;
  }

  const result = await sendChaseReport(now);
  switch (result.status) {
    case "sent":
      log(`sent (ledger row ${result.sendId?.slice(0, 8)})`);
      return;
    case "skipped_quiet":
      log(
        `the register is quiet (no open, said-done, paused or blocked rows, nothing closed in the last ${CHASE_CAPS.recentlyClosedDays} days): no report this week, by the owner's 2026-11-02 ruling. No ledger row was claimed, so seeding a task and re-running today still sends.`
      );
      return;
    case "already_sent_today":
      log(
        `already sent today: an ACCEPTED report row for ${utcDateKey(now)} is already on the ledger, so this would have been a second copy. Nothing was sent twice.`
      );
      return;
    case "refused":
      console.error(
        `[chase-report] FAILED: the send seam returned false (no RESEND_API_KEY, or the vendor refused). Recorded on ledger row ${result.sendId?.slice(0, 8)}. THIS WEEK'S REPORT DID NOT GO OUT; re-run npm run chase:report once the cause is fixed, which the reclaimable claim allows on the same day.`
      );
      process.exit(1);
      return;
    case "threw":
      console.error(
        `[chase-report] FAILED: the send threw; see ledger row ${result.sendId?.slice(0, 8)} for the message.`
      );
      process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`[chase-report] FAILED: ${errMessage(err)}`);
    process.exit(1);
  });
