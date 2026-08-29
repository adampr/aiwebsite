#!/usr/bin/env -S npx tsx
// Move a BATCH of /work submissions to their real owners from a plan file
// (2026-08-29, canvas round: two dozen CoWork skills were submitted by
// adam@xl.net on colleagues' behalf and the Slack canvas says whose each one
// is). This is the scripted twin of POST /api/work/submissions/[id]/transfer
// (§5.16 "Ownership transfer"): the same gates, the same compare-and-swap,
// the same log line, just driven by a JSON list instead of a form, because
// the site's control moves one row per click and each click is a decision
// someone has to make twenty-four times.
//
// NOTHING IS RE-DERIVED. Per plan row the script does a FRESH submissionById
// read and runs decideTransfer (scripts/lib/work-transfer-ops.ts, pure and
// unit-tested), which calls the route's own transferTarget and
// transferBlockedReason against the staff lane (WORK_SUBMIT_DOMAINS, "the
// Our Work page"). --apply then calls transferSubmission pinned on the
// owner, status and panel_attempt_id that same read saw, so a row that
// changed underneath (a queue drain claiming it, someone moving it on the
// site) is reported as raced and the loop continues.
//
// Refused per row, reported and never written (exit stays 0, these are
// disclosures, not failures):
//   - no such submission;
//   - company-lane rows (company_id set): their lane is the company's own
//     domain and needs companyById + the paused/eligible checks the route
//     does; out of scope here, use Move to someone else on the site;
//   - a target the staff lane rejects (not an xl.net address, malformed);
//   - superseded rows (structural: the live descendant is the one to move)
//     and rows in a LIVE panel run (a stale heartbeat is movable).
// A row that already belongs to the plan's target is a skip, not a refusal:
// it is what a re-run after a partial apply looks like.
//
// WHAT --apply WRITES, exactly as the route: submitter_email, user_id
// (userIdForEmail, NULL when the recipient has no site account, which the
// transfer allows) and creator_email = coalesce(creator_email,
// submitter_email). Never submitter_name, card_json, slug, display_rank or
// published_at: the published credit and the card's place on the page are
// what the submitter chose to print, and the route does not touch them
// either. /work's HTML is byte-identical afterwards.
//
// EMAIL: none unless --notify. With it, ONLY the new owner's "moved to you"
// copy (notifyTransferNewOwner) is sent per moved row. The route's
// notifyTransfer also mails the previous owner and, for published rows, the
// owner mailbox; for a batch out of one mailbox that is two dozen "your
// submission was moved" mails plus two dozen owner copies into an inbox that
// already receives the OUTBOUND_BCC copy of every send. The previous owner
// is the person whose attribution is being corrected and is on the plan.
//
// Runs ON THE PROD VM (DATABASE_URL resolves only there). Refuses to run as
// root for the same reason work:reclassify does (npx tsx caches inside the
// deploy user's checkout).
//
// Usage:
//   npm run work:transfer -- <plan.json> [--apply] [--actor <email>] [--notify] [--yes]
//
//   plan.json         JSON array of {"id": "<uuid>", "to": "<email>", "note": "<text>"}
//   (no flags)        decide every row and print the table, write nothing
//   --apply           perform the moves (dry run is the default)
//   --actor <email>   who is doing this; REQUIRED with --apply, an xl.net
//                     address (the log line and the email both name it)
//   --notify          with --apply: email each new owner (nothing else)
//   --yes             skip the confirm prompt (work:rerun precedent)
//
// Exit 0 when the run completed and every planned move applied (refusals
// and skips included); 1 when a planned move raced or threw, or on a bad
// plan or bad arguments.

import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  submissionById,
  transferSubmission,
  userIdForEmail,
} from "../src/lib/work/db";
import { notifyTransferNewOwner } from "../src/lib/work/notify";
import { statusView } from "../src/lib/work/view";
import {
  decideTransfer,
  parseTransferArgs,
  parseTransferPlan,
  type TransferPlanRow,
  type TransferVerdict,
} from "./lib/work-transfer-ops";

const USAGE =
  "Usage: npm run work:transfer -- <plan.json> [--apply] [--actor <email>] [--notify] [--yes]";

function die(msg: string, code = 1): never {
  console.error(`[work-transfer] ${msg}`);
  process.exit(code);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type Decided = {
  plan: TransferPlanRow;
  title: string;
  status: string;
  from: string;
  verdict: TransferVerdict;
  /** Pinned from the SAME read the verdict came from. */
  expectStatus: string;
  expectAttemptId: string | null;
  outcome: string | null;
};

function verdictText(v: TransferVerdict): string {
  if (v.verdict === "move") return "move";
  return `${v.verdict}: ${v.reason}`;
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}~` : s;
}

function printTable(rows: Decided[], withOutcome: boolean): void {
  const head = ["id", "title", "status", "from", "to", "verdict"];
  if (withOutcome) head.push("outcome");
  const body = rows.map((r) => {
    const cells = [
      r.plan.id.slice(0, 8),
      clip(r.title, 40),
      r.status,
      r.from || "-",
      r.plan.to,
      verdictText(r.verdict),
    ];
    if (withOutcome) cells.push(r.outcome ?? "-");
    return cells;
  });
  // Width per column over the header and every cell, so the table reads as
  // columns in a terminal; the verdict column is last and left unclipped.
  const widths = head.map((h, i) =>
    Math.max(h.length, ...body.map((cells) => cells[i].length))
  );
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i])))
      .join(" | ");
  console.log(line(head));
  console.log(widths.map((w) => "-".repeat(w)).join("-+-"));
  for (const cells of body) console.log(line(cells));
}

async function main(): Promise<void> {
  if (typeof process.getuid === "function" && process.getuid() === 0)
    die(
      "Refusing to run as root: npx tsx caches inside the deploy user's checkout, and a root-owned cache file there breaks the next build for the user the site runs as. Run this as the deploy user."
    );

  const parsed = parseTransferArgs(process.argv.slice(2));
  if (!parsed.ok) die(`${parsed.error}\n\n${USAGE}`);
  const { plan: planPath, apply, actor, notify, yes } = parsed.args;

  let json: unknown;
  try {
    json = JSON.parse(readFileSync(resolve(planPath), "utf8"));
  } catch (err) {
    die(`cannot read plan ${planPath}: ${errMessage(err)}`);
  }
  const plan = parseTransferPlan(json);
  if (!plan.ok) die(`bad plan ${planPath}: ${plan.error}`);

  console.log(`Mode:   ${apply ? "LIVE (--apply)" : "DRY RUN (no writes)"}`);
  console.log(`Plan:   ${planPath} (${plan.rows.length} rows)`);
  console.log(`Actor:  ${actor ?? "(none; dry run)"}`);
  console.log(
    `Email:  ${notify ? "new owner only (moved to you), per moved row" : "none"}`
  );
  console.log(
    `Writes: submitter_email, user_id, creator_email (coalesced). Never submitter_name, card_json, slug, display_rank or published_at.`
  );

  // ── Decide pass: one FRESH read per row, the route's gates ───────
  const decided: Decided[] = [];
  for (const p of plan.rows) {
    const row = await submissionById(p.id);
    const verdict = decideTransfer(
      row
        ? {
            id: row.id,
            title: row.title,
            status: row.status,
            submitterEmail: row.submitterEmail,
            companyId: row.companyId,
            panelAttemptId: row.panelAttemptId,
            stale: statusView(row).stale,
          }
        : null,
      p.to
    );
    decided.push({
      plan: p,
      title: row?.title ?? "(missing)",
      status: row?.status ?? "-",
      from: row?.submitterEmail ?? "",
      verdict,
      expectStatus: row?.status ?? "",
      expectAttemptId: row?.panelAttemptId ?? null,
      outcome: null,
    });
  }

  const moves = decided.filter((d) => d.verdict.verdict === "move");
  const skips = decided.filter((d) => d.verdict.verdict === "skip");
  const refusals = decided.filter((d) => d.verdict.verdict === "refuse");

  if (!apply) {
    console.log("");
    printTable(decided, false);
    console.log(
      `\nTally: ${moves.length} would move, ${skips.length} skipped, ${refusals.length} refused. Nothing was written; pass --apply --actor <email> to move them.`
    );
    for (const d of decided)
      if (d.plan.note) console.log(`  ${d.plan.id.slice(0, 8)}: ${d.plan.note}`);
    process.exit(0);
  }

  // ── Apply pass ────────────────────────────────────────────────────
  if (moves.length === 0) {
    for (const d of decided)
      d.outcome = d.verdict.verdict === "skip" ? "skipped" : "refused";
    console.log("");
    printTable(decided, true);
    console.log(
      `\nTally: 0 moved, ${skips.length} skipped, ${refusals.length} refused. Nothing to write.`
    );
    process.exit(0);
  }
  if (!yes) {
    console.log("");
    printTable(decided, false);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(
      `\n[work-transfer] move ${moves.length} submission(s) as ${actor}${notify ? ", emailing each new owner" : ", sending no email"}? Type yes: `
    );
    rl.close();
    if (answer.trim().toLowerCase() !== "yes") die("aborted", 0);
  }

  let moved = 0,
    raced = 0,
    failed = 0;
  for (const d of decided) {
    if (d.verdict.verdict === "skip") {
      d.outcome = "skipped";
      continue;
    }
    if (d.verdict.verdict === "refuse") {
      d.outcome = "refused";
      continue;
    }
    const { from, to } = d.verdict;
    try {
      const toUserId = await userIdForEmail(to);
      const res = await transferSubmission({
        id: d.plan.id,
        toEmail: to,
        expectOwnerEmail: from,
        expectStatus: d.expectStatus,
        expectAttemptId: d.expectAttemptId,
        toUserId,
      });
      if (!res.ok) {
        raced++;
        d.outcome = "raced";
        continue;
      }
      moved++;
      d.outcome = "moved";
      // The route's line, verbatim in shape, so the two lanes grep alike.
      console.log(
        `[work] transferred sub=${d.plan.id} from=${res.previousEmail} to=${res.row.submitterEmail} by=${actor}`
      );
      if (notify) {
        // Awaited, not after(): this is a script, not a route handler, and
        // sendGovernanceEmail never throws (it logs its own failures).
        await notifyTransferNewOwner({ row: res.row, actorEmail: actor! });
        d.outcome = "moved, emailed";
      }
    } catch (err) {
      failed++;
      d.outcome = `failed: ${errMessage(err)}`;
    }
  }

  console.log("");
  printTable(decided, true);
  console.log(
    `\nTally: ${moved} moved, ${raced} raced, ${skips.length} skipped, ${refusals.length} refused, ${failed} failed.`
  );
  if (!notify)
    console.log(
      `No email was sent (pass --notify to send each new owner the "moved to you" note; the previous owner and the owner mailbox are never emailed by this script).`
    );
  if (raced > 0 || failed > 0) {
    console.log(
      `\nRe-run the same plan: moved rows come back as skipped, raced rows are re-read and decided again.`
    );
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
