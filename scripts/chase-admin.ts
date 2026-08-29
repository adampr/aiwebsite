#!/usr/bin/env -S npx tsx
// Operator console for the chase register (ARCHITECTURE.md §5.21). There is
// no admin web page and no inbound reply lane in this round, so this script
// is the ONLY way a human moves a row, and the weekly report ends by
// pointing here.
//
// Usage:
//   npm run chase:admin -- <op> <task-id> [--reason "..."] [--apply]
//                          [--actor you@example.com] [--attribution-confirmed]
//
//   unblock   blocked -> open. Starts the weekday email.
//   open      paused  -> open. Restarts the weekday email, and RE-DATES the
//             ask to now: the only automatic pause is the identical-
//             resubmission rule, and the submission that caused it is still
//             there, so keeping the old opened_at would let the next run
//             re-pause the row inside the same run and make this command
//             silently inert.
//   pause     open    -> paused. Stops the email; --reason required.
//   close     -> done.      "They did it and I have seen it."
//   decline   -> declined.  "They said no, or it is not theirs." --reason required.
//   cancel    -> cancelled. "We withdrew the ask." --reason required.
//
// DRY RUN BY DEFAULT. --apply writes, and --actor is required with it: every
// close is stamped closed_by = "owner:<actor>", which is the difference
// between a register that records who decided something and one that just
// says a row changed.
//
// THE ATTRIBUTION GUARD. `unblock` refuses a row whose blocked_reason
// mentions attribution unless --attribution-confirmed is also passed. A
// blocked reason of the "we are not certain this is actually their work"
// kind is the one case where opening the row starts emailing a person daily
// about something that may not be theirs, which is the most damaging thing
// this feature can do to somebody. A second flag is cheap; an apology to a
// colleague is not.
//
// Exit 0 when the op applied (or the dry run described it), 1 on a refusal.

import "./lib/governance-env";
import { looksLikeEmail, normalizeEmail } from "../src/lib/chase/config";
import {
  closeTask,
  isUuid,
  openTask,
  pauseTask,
  taskById,
} from "../src/lib/chase/db";

const OPS = ["unblock", "open", "pause", "close", "decline", "cancel"] as const;
type Op = (typeof OPS)[number];

const USAGE =
  `Usage: npm run chase:admin -- <${OPS.join("|")}> <task-id> [--reason "..."] [--apply] [--actor you@example.com] [--attribution-confirmed]`;

/** Reasons that name an attribution doubt. Matched case-insensitively
 * against blocked_reason. */
const ATTRIBUTION_RE = /attribution/i;

function die(msg: string): never {
  console.error(`[chase-admin] ${msg}`);
  process.exit(1);
}

/** One index-aware pass: the flags that take a value, and the bare words.
 * NOT a filter over the whole argv by string equality, which is the obvious
 * shortcut and is wrong: `--reason close` would remove the literal word
 * "close" everywhere, including the operator's op, and the script would
 * then read the task id as the op. */
function parseArgs(args: string[]): {
  bare: string[];
  reason: string | null;
  actor: string | null;
} {
  const VALUE_FLAGS = new Set(["--reason", "--actor"]);
  const bare: string[] = [];
  const values: Record<string, string | null> = { "--reason": null, "--actor": null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (VALUE_FLAGS.has(a)) {
      const v = args[i + 1];
      if (v !== undefined && !v.startsWith("--")) {
        values[a] = v;
        i++; // consume the value so it never lands in `bare`
      }
      continue;
    }
    if (a.startsWith("--")) continue;
    bare.push(a);
  }
  return { bare, reason: values["--reason"], actor: values["--actor"] };
}

async function main(): Promise<void> {
  if (typeof process.getuid === "function" && process.getuid() === 0)
    die(
      "Refusing to run as root: npx tsx caches inside the deploy user's checkout, and a root-owned cache file there breaks the next build for the user the site runs as. Run this as the deploy user."
    );

  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const attributionConfirmed = args.includes("--attribution-confirmed");
  const { bare, reason, actor } = parseArgs(args);

  const op = bare[0] as Op | undefined;
  const id = bare[1];
  if (!op || !(OPS as readonly string[]).includes(op)) die(`unknown op.\n\n${USAGE}`);
  if (!id) die(`no task id.\n\n${USAGE}`);
  if (!isUuid(id)) die(`"${id}" is not a task uuid.\n\n${USAGE}`);

  if (apply) {
    if (!actor)
      die(
        `--actor <email> is required with --apply: every close is stamped closed_by = "owner:<actor>", and a register that cannot say who decided something is not a record.`
      );
    if (!looksLikeEmail(actor)) die(`--actor "${actor}" is not an email address`);
  }

  const task = await taskById(id);
  if (!task) die(`no chase task ${id}`);

  console.log(`[chase-admin] ${apply ? "APPLY" : "DRY RUN (writes nothing)"}`);
  console.log(`[chase-admin] task    ${task.id}`);
  console.log(`[chase-admin] who     ${task.assigneeName} <${task.assigneeEmail}>`);
  console.log(`[chase-admin] ask     ${task.title}`);
  console.log(`[chase-admin] status  ${task.status}`);
  if (task.blockedReason)
    console.log(`[chase-admin] blocked ${task.blockedReason}`);
  if (task.pausedReason) console.log(`[chase-admin] paused  ${task.pausedReason}`);
  console.log(`[chase-admin] op      ${op}`);

  const stamp = `owner:${normalizeEmail(actor ?? "dry-run")}`;

  switch (op) {
    case "unblock": {
      if (task.status !== "blocked")
        die(`this row is ${task.status}, not blocked. Nothing done.`);
      if (ATTRIBUTION_RE.test(task.blockedReason ?? "") && !attributionConfirmed)
        die(
          `REFUSED: this row is blocked for an attribution reason, and opening it starts emailing ${task.assigneeEmail} every weekday about work that may not be theirs.\n` +
            `  Reason on file: ${task.blockedReason}\n` +
            `  Confirm the attribution with a person first, then re-run with --attribution-confirmed.`
        );
      if (!apply) {
        console.log(
          `[chase-admin] would open this row and start the weekday reminder. Re-run with --apply --actor <you>.`
        );
        return;
      }
      const ok = await openTask({ id, from: "blocked" });
      if (!ok) die(`the row moved underneath us; re-read it and try again.`);
      console.log(`[chase-admin] opened by ${stamp}. Reminders start on the next weekday run.`);
      return;
    }
    case "open": {
      if (task.status !== "paused")
        die(`this row is ${task.status}, not paused. Use unblock for a blocked row.`);
      if (!apply) {
        console.log(`[chase-admin] would resume reminders. Re-run with --apply --actor <you>.`);
        return;
      }
      const ok = await openTask({ id, from: "paused" });
      if (!ok) die(`the row moved underneath us; re-read it and try again.`);
      console.log(
        `[chase-admin] reopened by ${stamp}. The paused reason was cleared and the ask is re-dated to now, so what paused it cannot immediately pause it again.`
      );
      return;
    }
    case "pause": {
      if (task.status !== "open") die(`this row is ${task.status}, not open.`);
      if (!reason)
        die(
          `--reason is required to pause: a paused row is one nobody is being emailed about, and the weekly report has to be able to print why.`
        );
      if (!apply) {
        console.log(`[chase-admin] would pause with: ${reason}`);
        return;
      }
      const ok = await pauseTask({ id, reason });
      if (!ok) die(`the row moved underneath us; re-read it and try again.`);
      console.log(`[chase-admin] paused by ${stamp}. No further email about this row.`);
      return;
    }
    case "close":
    case "decline":
    case "cancel": {
      if (task.closedAt)
        die(`this row closed on ${task.closedAt.toISOString()} by ${task.closedBy}. Closed rows are latched.`);
      if (op !== "close" && !reason)
        die(`--reason is required to ${op}: the weekly report prints it.`);
      const status = op === "close" ? "done" : op === "decline" ? "declined" : "cancelled";
      if (!apply) {
        console.log(
          `[chase-admin] would set status ${status}${reason ? ` with: ${reason}` : ""}. Re-run with --apply --actor <you>.`
        );
        return;
      }
      const ok = await closeTask({
        id,
        status,
        closedBy: stamp,
        evidence: { op, actor: normalizeEmail(actor ?? ""), reason: reason ?? null },
        ...(op === "decline" ? { declinedReason: reason } : {}),
      });
      if (!ok) die(`the row moved underneath us; re-read it and try again.`);
      console.log(`[chase-admin] ${status} by ${stamp}. No further email about this row.`);
      return;
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(
      `[chase-admin] FAILED: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  });
