#!/usr/bin/env -S npx tsx
// Set (or clear) the PUBLIC CREDIT on a /work submission: the "submitted by
// <name>" line src/components/work-card.tsx prints under a card (§5.16).
//
// WHY THIS EXISTS (2026-08-29, "Ticket Reply Composer"): submitter_name is
// written exactly once, by createSubmission, and no shipped route or script
// can change it afterwards. The transfer lane deliberately refuses to touch
// it (the credit is what the submitter chose to print, not a pointer to the
// current owner), and the web form only ever sends it at intake. So when a
// colleague asks for their name to be added to, or taken off, a card that
// is already live, nobody can honour it without hand-written SQL. This is
// that lane.
//
// THE DEFAULT DOES NOT CHANGE (owner ruling, standing on 2026-08-29): the
// public page names nobody. submitter_name NULL is the default, the card
// then reads "submitted by the XL.net team", and the credit stays opt-in,
// first-name-only, and the named person's own choice. The exhibits converted
// into team cards that day were filed with no public attribution on
// purpose. This script is for ADD or REMOVE AT THAT PERSON'S OWN REQUEST;
// it is not a way for an operator to decide who gets named.
//
// WHAT IT WRITES: submitter_name, on ONE row, and nothing else. Not the
// owner (that is work:transfer), not the card copy, not the title, not the
// slug, not display_rank or published_at, and NOT updated_at: on this table
// updated_at is the 30-day retention timer for non-published rows
// (sweepExpiredWork), not an audit field, and bumping it would grant a
// received or failed row another month of retained bytes because someone
// fixed a byline (the same call work:reclassify made, in writing). /work's
// HTML is byte-identical afterwards except for the byline.
//
// NOTHING IS RE-IMPLEMENTED. The name rule is parseAttribution from
// scripts/lib/work-submit-ops.ts, which is the create route's own rule and
// the one work:submit applies to --attribution: a single first name,
// letters, apostrophes and hyphens, 2 to 20 characters. The uuid shape is
// isUuid, the row read is submissionById, and the page refresh is
// revalidateWorkPage, all from the site's own modules. The pure argument and
// link decisions live in scripts/lib/work-attribute-ops.ts, unit-tested with
// no database by scripts/work-attribute-tests.ts.
//
// DELIBERATELY NOT DONE:
//   - No email. Nobody is told a byline changed; notifyPublished already
//     fired for a published row, and re-sending it would announce a publish
//     that already happened.
//   - No panel run. The card copy is untouched, so there is nothing to
//     re-review; use work:rerun when the COPY is the problem.
//   - No other column, and no batch mode. One row, one column, one operator
//     decision each time: this exists because a credit was wrong, and a
//     script that could rewrite several people's bylines in one command is a
//     bigger tool than the problem.
//   - No admin-session check. There is no session here; the gate is ssh
//     access to the prod VM, exactly as it is for work:rerun and
//     work:reclassify.
//
// The revalidate is BEST EFFORT and only for a public-lane row: it flushes
// the ISR copy of /work so the new byline shows immediately. A failure is
// printed and does not fail the run, because the database write is the real
// outcome and the page heals on its own within the ISR window. Company-lane
// rows (§5.18) render force-dynamic and need no revalidation at all.
//
// Runs ON THE PROD VM (DATABASE_URL resolves only there). Refuses to run as
// root for the same reason work:reclassify does.
//
// Usage:
//   npm run work:attribute -- <uuid> <FirstName> [--yes]
//   npm run work:attribute -- <uuid> --clear [--yes]
//
//   <FirstName>  the public credit, a single first name
//   --clear      remove the credit; the card reads "the XL.net team" again
//   --yes        skip the confirm prompt
//
// A SUPERSEDED row is refused: after an approved update swap the live card
// renders the CHILD row's byline under the parent's old slug, so crediting
// the parent would print "written" and change nothing visible. The refusal
// names the live descendant to credit instead.
//
// Exit 0 when the row was updated or the confirm was declined, 1 on any
// refusal or failure, 2 when the write raced (the row changed or vanished
// between the read and the update).

import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "../src/lib/db";
import { liveDescendantId, submissionById } from "../src/lib/work/db";
import { revalidateWorkPage } from "../src/lib/work/panel";
import {
  ATTRIBUTE_USAGE,
  creditLink,
  laneLabel,
  parseAttributeArgs,
} from "./lib/work-attribute-ops";

const S = schema.workSubmissions;

function die(msg: string, code = 1): never {
  console.error(`[work-attribute] ${msg}`);
  process.exit(code);
}

function usage(msg: string): never {
  console.error(`[work-attribute] ${msg}\n\n${ATTRIBUTE_USAGE}`);
  process.exit(1);
}

async function main(): Promise<void> {
  if (typeof process.getuid === "function" && process.getuid() === 0)
    die(
      "Refusing to run as root: npx tsx caches inside the deploy user's checkout, and a root-owned cache file there breaks the next build for the user the site runs as. Run this as the deploy user."
    );

  const args = parseAttributeArgs(process.argv.slice(2));
  if (!args.ok) usage(args.message);

  const row = await submissionById(args.id);
  if (!row) die(`no submission ${args.id}`);
  if (row.status === "superseded") {
    const live = await liveDescendantId(row.id);
    die(
      live
        ? `this row was superseded by an approved update; the live card renders row ${live}'s credit. Credit that row instead.`
        : "this row was superseded by an approved update and the live descendant could not be found; credit the live row, not this one."
    );
  }

  const current = row.submitterName ?? "(none; the card credits the XL.net team)";
  console.log(`[work-attribute] id=${row.id}`);
  console.log(`[work-attribute] title="${row.title}"`);
  console.log(`[work-attribute] status=${row.status} lane=${laneLabel(row.companyId)}`);
  console.log(`[work-attribute] current credit: ${current}`);
  console.log(
    `[work-attribute] new credit: ${args.clear ? "(none; the card credits the XL.net team)" : args.name}`
  );

  if (!args.yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(
      `[work-attribute] ${args.clear ? "CLEAR the credit on" : `credit "${args.name}" on`} "${row.title}", at that person's own request (the page names nobody by default)? Type yes: `
    );
    rl.close();
    if (answer.trim().toLowerCase() !== "yes") die("aborted", 0);
  }

  // Compare-and-swap on the credit this read saw, so a byline someone else
  // changed in the meantime is reported instead of overwritten.
  const done = await db
    .update(S)
    .set({ submitterName: args.name })
    .where(
      and(
        eq(S.id, row.id),
        row.submitterName === null
          ? isNull(S.submitterName)
          : eq(S.submitterName, row.submitterName)
      )
    )
    .returning({ id: S.id, submitterName: S.submitterName });
  if (done.length !== 1)
    die("write raced: the credit changed under this run, or the row vanished", 2);
  console.log(
    `[work-attribute] written: submitter_name = ${done[0].submitterName ?? "NULL"}`
  );

  if (row.companyId === null) {
    try {
      await revalidateWorkPage();
      console.log("[work-attribute] /work revalidate requested (best effort).");
    } catch (err) {
      console.log(
        `[work-attribute] revalidate failed (best effort; /work heals within the ISR window): ${err instanceof Error ? err.message.slice(0, 200) : "unknown"}`
      );
    }
  } else {
    console.log(
      "[work-attribute] company-lane row: its page renders force-dynamic, so there is nothing to revalidate."
    );
  }

  const link = creditLink(row.companyId, row.slug);
  console.log(
    link
      ? `[work-attribute] card: ${link}`
      : row.status === "published"
        ? "[work-attribute] published row with no slug; check the card on the page."
        : `[work-attribute] status ${row.status}: no card is live yet; the credit rides along if and when it publishes.`
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(`[work-attribute] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
