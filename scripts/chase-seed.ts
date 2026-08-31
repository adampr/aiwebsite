#!/usr/bin/env -S npx tsx
// Seed the chase register from a task list supplied AT RUN TIME
// (ARCHITECTURE.md §5.21).
//
// THE TASK LIST NEVER LIVES IN THIS REPO. Every row names a colleague by
// address and records whether they have done what they were asked, and
// github.com/adampr/aiwebsite is PUBLIC: a checked-in seed, fixture or map
// would publish a machine-readable delinquency list of real people to the
// open internet permanently, and git history keeps it after any revert.
// Same ruling as work_static_credits (0052, dropped by 0055, back EMPTY with
// 0056 on 2026-08-31 for the staff scorecard's Published count), taken the
// same day for the same reason. So this script reads a file path or stdin,
// and the tables ship empty. Write the list on the VM, run this, delete the
// file.
//
// Usage:
//   npm run chase:seed -- tasks.json            validate and print, write nothing
//   npm run chase:seed -- tasks.json --apply    insert
//   cat tasks.json | npm run chase:seed -- -    stdin, same rules
//
// Row shape (JSON array):
//   {
//     "assigneeEmail": "person@example.com",
//     "assigneeName":  "Person Example",
//     "requesterEmail":"asker@example.com",
//     "title":         "Send the CoWork skill package",
//     "detail":        "Why this is being asked, in your words.",
//     "actionUrl":     "https://ai.xl.net/work/submit",   (required unless
//                                                          detector is manual)
//     "status":        "blocked" | "open",                (default blocked)
//     "blockedReason": "required when status is blocked",
//     "openedAt":      "2026-08-29T13:00:00Z",            (required when open)
//     "detector":      "manual" | "work_submission" | "work_update_child",
//     "detectorArg":   "package-name or parent uuid",     (required unless manual)
//     "detectorMdSha256": "optional, reserved, not read in this round"
//   }
//
// FIVE GATES, and a failure of ANY of them refuses the WHOLE batch rather
// than seeding part of it. A half-seeded register is worse than none: some
// people start getting daily email about a list the operator believes was
// rejected. (With --apply the inserts additionally run inside ONE
// transaction, so a failure after the gates cannot leave half a register
// behind either.)
//
//   1. BOTH addresses must ALREADY be in the site's own records:
//      company_people or users, case-folded. Not a domain check, which would
//      happily accept an address somebody invented at a domain we recognise.
//      The ASSIGNEE gate is what stops this script becoming a way to email
//      strangers daily. The REQUESTER gate matters just as much and is less
//      obvious: every nudge tells the reader to write to that address to
//      make the emails stop, so a typo'd or departed requester leaves a
//      cornered colleague writing to nobody while the mail keeps arriving.
//   2. status 'open' requires opened_at. It is the detector's time floor;
//      without it a package submitted months before the ask would close the
//      task on the first run. (chase_task_open_ck enforces it too, but a
//      constraint violation mid-batch is a worse error message.)
//   3. status 'blocked' requires blocked_reason. A blocked row with no
//      reason is a task nobody will ever be able to decide about.
//   4. Every non-manual detector needs its detector_arg.
//   5. Every non-manual detector needs its actionUrl. A detector that
//      watches the site for the work implies a place on the site to do it,
//      and a reminder with no link is one the reader cannot act on. `manual`
//      may omit it: the nudge then names the requester as the destination.
//
// DUPLICATES ARE THE DATABASE'S JOB, NOT THIS SCRIPT'S. The insert is
// ON CONFLICT DO NOTHING against chase_task_live_uq (lower(assignee_email),
// detector, coalesce(detector_arg,''), lower(title)) WHERE status IN
// (blocked, open, paused). This script deliberately does NOT pre-check for
// existing rows and then insert: that read-then-write is a race, and this
// is not the only writer (a second operator, a second terminal, a re-run
// after a timeout that actually committed). A "duplicate" line below means
// the index did its job.
//
// Exit 0 when every row validated (and, with --apply, was inserted or was
// already there). Exit 1 when anything was refused.

import "./lib/governance-env";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CHASE_DETECTORS,
  looksLikeEmail,
  normalizeEmail,
  oneLine,
} from "../src/lib/chase/config";
import { db } from "../src/lib/db";
import {
  insertTask,
  knownDirectoryEmails,
  personIdForEmail,
} from "../src/lib/chase/db";

const USAGE =
  "Usage: npm run chase:seed -- <tasks.json | -> [--apply]\n" +
  "       '-' reads the list from stdin. Dry run unless --apply.";

interface SeedRow {
  assigneeEmail: string;
  assigneeName: string;
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
}

function str(v: unknown): string {
  return typeof v === "string" ? oneLine(v) : "";
}

/** PURE shape validation. Returns the row or the reason it is refused. */
function parseRow(
  raw: unknown,
  index: number
): { ok: true; row: SeedRow } | { ok: false; error: string } {
  const at = `row ${index + 1}`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { ok: false, error: `${at}: not a JSON object` };
  const r = raw as Record<string, unknown>;

  const assigneeEmail = normalizeEmail(str(r.assigneeEmail));
  if (!looksLikeEmail(assigneeEmail))
    return { ok: false, error: `${at}: assigneeEmail is missing or malformed` };
  const requesterEmail = normalizeEmail(str(r.requesterEmail));
  if (!looksLikeEmail(requesterEmail))
    return { ok: false, error: `${at}: requesterEmail is missing or malformed` };
  const assigneeName = str(r.assigneeName);
  if (!assigneeName) return { ok: false, error: `${at}: assigneeName is empty` };
  const title = str(r.title);
  if (!title) return { ok: false, error: `${at}: title is empty` };
  const detail = str(r.detail);
  if (!detail)
    return {
      ok: false,
      error: `${at}: detail is empty. It is printed in the reminder as "Why:", and a reminder that cannot say why is not one worth sending.`,
    };

  const actionUrlRaw = str(r.actionUrl);
  if (actionUrlRaw && !/^https?:\/\//i.test(actionUrlRaw))
    return { ok: false, error: `${at}: actionUrl must be an http(s) URL` };

  const status = str(r.status) || "blocked";
  if (status !== "blocked" && status !== "open")
    return {
      ok: false,
      error: `${at}: status must be "blocked" or "open" (a seed never creates a closed row)`,
    };

  const blockedReason = str(r.blockedReason) || null;
  if (status === "blocked" && !blockedReason)
    return {
      ok: false,
      error: `${at}: a blocked row needs blockedReason (gate 3). Say what has to happen before this person is emailed.`,
    };

  let openedAt: Date | null = null;
  const openedRaw = str(r.openedAt);
  if (openedRaw) {
    const parsed = new Date(openedRaw);
    if (Number.isNaN(parsed.getTime()))
      return { ok: false, error: `${at}: openedAt is not a date` };
    openedAt = parsed;
  }
  if (status === "open" && !openedAt)
    return {
      ok: false,
      error: `${at}: an open row needs openedAt (gate 2). It is the detector's time floor; without it work done before the ask would close the task.`,
    };

  const detector = str(r.detector) || "manual";
  if (!(CHASE_DETECTORS as readonly string[]).includes(detector))
    return {
      ok: false,
      error: `${at}: detector must be one of ${CHASE_DETECTORS.join(", ")}`,
    };
  let detectorArg = str(r.detectorArg) || null;
  if (detector !== "manual" && !detectorArg)
    return { ok: false, error: `${at}: detector ${detector} needs detectorArg (gate 4)` };
  if (detector === "work_update_child" && detectorArg) {
    // A submission uuid. Postgres renders every uuid it returns LOWERCASE,
    // and the pure matcher compares the stored arg against those rows, so a
    // pasted uppercase id would find the child in SQL and then be thrown
    // away by the string compare, which reads as "they never did it".
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        detectorArg
      )
    )
      return {
        ok: false,
        error: `${at}: detector work_update_child needs a submission uuid in detectorArg, not "${detectorArg}"`,
      };
    detectorArg = detectorArg.toLowerCase();
  }
  if (detector !== "manual" && !actionUrlRaw)
    return {
      ok: false,
      error: `${at}: detector ${detector} needs actionUrl (gate 5). The reminder has to carry the place the work is done; only a manual row may omit it, and that one names the requester instead.`,
    };

  return {
    ok: true,
    row: {
      assigneeEmail,
      assigneeName,
      requesterEmail,
      title,
      detail,
      actionUrl: actionUrlRaw || null,
      status,
      blockedReason,
      openedAt,
      detector,
      detectorArg,
      detectorMdSha256: str(r.detectorMdSha256) || null,
    },
  };
}

function die(msg: string): never {
  console.error(`[chase-seed] ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  if (typeof process.getuid === "function" && process.getuid() === 0)
    die(
      "Refusing to run as root: npx tsx caches inside the deploy user's checkout, and a root-owned cache file there breaks the next build for the user the site runs as. Run this as the deploy user."
    );

  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const source = args.find((a) => !a.startsWith("--"));
  if (!source) die(`no input given.\n\n${USAGE}`);

  let text: string;
  try {
    text =
      source === "-"
        ? readFileSync(0, "utf8")
        : readFileSync(resolve(source), "utf8");
  } catch (err) {
    return die(
      `cannot read ${source}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return die(
      `${source} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!Array.isArray(json)) die(`${source} must contain a JSON ARRAY of tasks`);
  if (json.length === 0) die(`${source} contains no tasks`);

  console.log(`[chase-seed] ${apply ? "APPLY" : "DRY RUN (writes nothing)"}`);
  console.log(`[chase-seed] source: ${source} (${json.length} row(s))`);

  // ── Gates 2, 3, 4: shape ─────────────────────────────────────────
  // The ORIGINAL index rides along with each accepted row. Without it the
  // gate-1 refusal below would number rows by their position in the
  // survivors list, so "row 3 is not in the directory" could point at row 5
  // of the operator's file whenever an earlier row failed on shape.
  const rows: { at: number; row: SeedRow }[] = [];
  const refusals: string[] = [];
  json.forEach((raw, i) => {
    const parsed = parseRow(raw, i);
    if (parsed.ok) rows.push({ at: i + 1, row: parsed.row });
    else refusals.push(parsed.error);
  });

  // ── Gate 1: BOTH addresses must already be in the site's own records ─
  if (rows.length > 0) {
    const known = await knownDirectoryEmails([
      ...rows.map((r) => r.row.assigneeEmail),
      ...rows.map((r) => r.row.requesterEmail),
    ]);
    for (const { at, row } of rows) {
      if (!known.has(row.assigneeEmail))
        refusals.push(
          `row ${at}: ${row.assigneeEmail} is not in company_people or users (gate 1). Add the person to the directory first; this script will not email an address the site has never seen.`
        );
      if (!known.has(row.requesterEmail))
        refusals.push(
          `row ${at}: requester ${row.requesterEmail} is not in company_people or users (gate 1). Every reminder tells the reader to write to that address to make the emails stop, so it has to be an address the site knows is real.`
        );
    }
  }

  if (refusals.length > 0) {
    console.error(
      `\n[chase-seed] REFUSED, and nothing was written. ${refusals.length} problem(s):`
    );
    for (const r of refusals) console.error(`  - ${r}`);
    console.error(
      `\n[chase-seed] The whole batch is refused rather than the bad rows alone: a half-seeded register starts emailing some people about a list you believe was rejected.`
    );
    process.exit(1);
  }

  for (const { at, row: r } of rows)
    console.log(
      `  ${String(at).padStart(3)}  ${r.status.padEnd(7)} ${r.assigneeEmail} · ${r.detector} · ${r.title}`
    );

  if (!apply) {
    console.log(
      `\n[chase-seed] ${rows.length} row(s) validated. Nothing written. Re-run with --apply to insert.`
    );
    return;
  }

  // ONE TRANSACTION for the whole batch. The gates above already refuse an
  // all-or-nothing batch before any write, but once writing starts a throw
  // on row 5 (a connection reset, a statement timeout, a CHECK a future
  // caller trips) would otherwise leave rows 1 to 4 committed and emailing
  // on the next weekday, under a "[chase-seed] FAILED" line the operator
  // reads as "nothing happened". That is the same failure the batch refusal
  // exists to prevent, one step later.
  const dupes: string[] = [];
  const { inserted, duplicate } = await db.transaction(async (tx) => {
    let ins = 0;
    let dup = 0;
    for (const { row: r } of rows) {
      const personId = await personIdForEmail(r.assigneeEmail, tx);
      const outcome = await insertTask(
        {
          assigneeEmail: r.assigneeEmail,
          assigneeName: r.assigneeName,
          assigneePersonId: personId,
          requesterEmail: r.requesterEmail,
          title: r.title,
          detail: r.detail,
          actionUrl: r.actionUrl,
          status: r.status,
          blockedReason: r.blockedReason,
          openedAt: r.openedAt,
          detector: r.detector,
          detectorArg: r.detectorArg,
          detectorMdSha256: r.detectorMdSha256,
        },
        tx
      );
      if (outcome === "inserted") ins++;
      else {
        dup++;
        dupes.push(`${r.assigneeEmail} · ${r.title}`);
      }
    }
    return { inserted: ins, duplicate: dup };
  });
  for (const d of dupes)
    console.log(`  duplicate (chase_task_live_uq already holds a live row): ${d}`);
  console.log(
    `\n[chase-seed] ${inserted} inserted, ${duplicate} already present. Blocked rows send nothing until somebody opens them: npm run chase:admin -- unblock <id> --actor <you> --apply`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(
      `[chase-seed] FAILED: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  });
