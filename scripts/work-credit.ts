#!/usr/bin/env -S npx tsx
// Record, remove, or list WHO BUILT each hand-written /work exhibit
// (§5.16/§5.18, owner ruling 2026-08-29). These credits feed the staff-lane
// Exhibits column on the Employee Scorecard, which exists because the 26
// exhibits on the public Our Work page are page copy rather than
// work_submissions rows: the colleagues who built them were counted by
// nothing, and two of them read "0 published" while the company publicly
// showcased their tool.
//
// RUNS ON THE PROD VM ONLY, and that is the point rather than an
// inconvenience. Every row maps a colleague's email address to an exhibit,
// and THIS REPOSITORY IS PUBLIC: a checked-in map, a seed INSERT in a
// migration, or a fixture would publish those addresses to the open internet
// permanently, and git history would keep them after any revert. So the
// mapping exists only in the production database, migration 0052 creates the
// table EMPTY, and this script is the write path. Do not add a plan file to
// the repo; type the pairs, or pipe them from a file OUTSIDE the checkout.
//
// The credit is INTERNAL: the scorecard is force-dynamic, robots-noindex and
// staff-gated, and no exhibit on the public page names its builder. It is
// also NOT the §5.16 card credit, which is opt-in, first-name-only, and
// typed by the submitter into submitter_name.
//
// Usage:
//   npm run work:credit -- list
//   npm run work:credit -- add <exhibit-id> <email> --by <your@xl.net> [--yes]
//   npm run work:credit -- remove <exhibit-id> <email> --by <your@xl.net> [--yes]
//
// `add` is an upsert on (anchor_id, lower(email)): re-running it is a no-op
// rather than a second credit, so a rerun after a partial batch is safe.
// `remove` is the retraction path the scorecard's own disclosure points a
// colleague at ("Ask an administrator to change or remove your exhibit
// credit"), so it must keep working and must record who did it.

import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "../src/lib/db";
import staticTitles from "../src/lib/work/static-titles.json";
import { WORK_SUBMIT_DOMAINS } from "../src/lib/work/http";
import { parseCreditArgs, validateCredit } from "./lib/work-credit-ops";

const USAGE =
  'Usage: npm run work:credit -- list | add <exhibit-id> <email> --by <you@xl.net> [--yes] | remove <exhibit-id> <email> --by <you@xl.net> [--yes]';

function die(msg: string, code = 1): never {
  console.error(`[work-credit] ${msg}`);
  process.exit(code);
}

const WSC = schema.workStaticCredits;

async function main() {
  const parsed = parseCreditArgs(process.argv.slice(2));
  if (!parsed.ok) die(`${parsed.error}\n\n${USAGE}`);
  const { cmd, anchorId, email, by, yes } = parsed.args;

  if (cmd === "list") {
    const rows = await db
      .select({
        anchorId: WSC.anchorId,
        email: WSC.email,
        by: WSC.updatedByEmail,
        at: WSC.updatedAt,
      })
      .from(WSC)
      .orderBy(WSC.anchorId, WSC.email);
    if (rows.length === 0) {
      console.log("No exhibit credits recorded.");
      process.exit(0);
    }
    const valid = new Set<string>(staticTitles.anchorIds);
    for (const r of rows) {
      // A credit whose section has left the page counts for nobody by
      // design; say so here rather than letting it look live.
      const gone = valid.has(r.anchorId) ? "" : "   (NOT ON THE PAGE: counts for nobody)";
      console.log(
        `${r.anchorId.padEnd(24)} ${r.email.padEnd(28)} by ${r.by} on ${r.at.toISOString().slice(0, 10)}${gone}`
      );
    }
    console.log(`\n${rows.length} credit(s).`);
    process.exit(0);
  }

  const v = validateCredit({
    anchorId,
    email,
    validAnchors: staticTitles.anchorIds,
    laneDomains: WORK_SUBMIT_DOMAINS,
  });
  if (!v.ok) die(v.error);
  const actor = validateCredit({
    anchorId,
    email: by,
    validAnchors: staticTitles.anchorIds,
    laneDomains: WORK_SUBMIT_DOMAINS,
  });
  if (!actor.ok) die(`--by: ${actor.error}`);

  const title =
    staticTitles.exhibits.find((e) => e.id === v.anchorId)?.title ?? v.anchorId;

  if (!yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(
      `[work-credit] ${cmd === "add" ? "CREDIT" : "REMOVE the credit for"} "${title}" (${v.anchorId}) ${cmd === "add" ? "to" : "from"} ${v.email}, as ${actor.email}? Type yes: `
    );
    rl.close();
    if (answer.trim().toLowerCase() !== "yes") die("aborted", 0);
  }

  if (cmd === "add") {
    // Upsert on the expression index: a rerun must not mint a second credit.
    const res = await db.execute(sql`
      insert into work_static_credits (anchor_id, email, updated_by_email)
      values (${v.anchorId}, ${v.email}, ${actor.email})
      on conflict (anchor_id, lower(email)) do update
        set updated_at = now(), updated_by_email = excluded.updated_by_email
      returning (xmax = 0) as inserted
    `);
    const inserted = (res as unknown as { inserted: boolean }[])[0]?.inserted;
    console.log(
      inserted
        ? `[work-credit] credited "${title}" to ${v.email}`
        : `[work-credit] "${title}" was already credited to ${v.email}; refreshed who recorded it`
    );
  } else {
    const res = await db
      .delete(WSC)
      .where(
        and(eq(WSC.anchorId, v.anchorId), sql`lower(${WSC.email}) = ${v.email}`)
      )
      .returning({ id: WSC.id });
    if (res.length === 0)
      die(`no credit for "${title}" (${v.anchorId}) held ${v.email}; nothing removed`, 1);
    console.log(
      `[work-credit] removed the credit for "${title}" from ${v.email} (by ${actor.email})`
    );
  }
  // The scorecard is force-dynamic, so the change is visible on the next
  // page load with no deploy and no revalidation.
  console.log("[work-credit] the staff scorecard reflects this on its next load.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
