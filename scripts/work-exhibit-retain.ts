#!/usr/bin/env -S npx tsx
// Retain the source archive of a HAND-AUTHORED EXHIBIT card in the §5.16
// archive store (owner directive 2026-08-29: the exhibits whose
// repositories the owner owns are handed over and retained like every
// other accepted upload).
//
// Why this lane exists: /work renders TWO lanes. Lane A is
// work_submissions, whose accepted uploads the store has retained since
// 2026-08-19. Lane B is the 26 hand-authored exhibit cards written
// directly in src/app/work/page.tsx (bays 01 to 05), which have NO
// database row, no bytea, no recorded sha and no ledger trace. The store
// could therefore only ever retain lane A, and the exhibits' own packages
// were retained NOWHERE. This script files them under
// exhibits/<slug>/<NN>-<name> with a ledger row whose submission_id is
// NULL: that column is already nullable and already SET NULL on a
// submission delete, and title/file_name are already snapshots, so the
// row keeps its full meaning with NO schema change and NO migration.
//
// Runs ON THE PROD VM only (DATABASE_URL and the store's disk resolve
// there); refuses to run as root, because store files must stay owned by
// the user the site runs as or admin cleanup could never unlink them.
//
// The gates, all settled before anything is written:
//   - --exhibit must be an EXACT normalizeTitle match against the
//     exhibits snapshot in src/lib/work/static-titles.json (generated
//     from page.tsx). Case and inner spacing are forgiven, nothing else:
//     a near match is precisely how one exhibit's package would be filed
//     under another's slug with nothing downstream ever noticing. A
//     refusal names the near matches.
//   - the title must reduce to a directory slug; a title that reduces to
//     nothing refuses rather than falling back to an invented name
//     (exhibitSlug, archive-naming.ts).
//   - per SLOT (00 package, 01 document), mirroring work:import's ledger
//     gate: a live row with the SAME sha256 SKIPS (this is what makes a
//     re-run idempotent and honest), a live row with different bytes
//     REFUSES, and an admin-deleted row REFUSES permanently, because
//     work_archive_rel_path_uq is a FULL unique index covering deleted
//     rows and admin cleanup is final for the scripted lanes.
//   - a refusal on either slot refuses the whole run: an exhibit's
//     package and document are handed over together, and a half-filed
//     exhibit is the state hardest to reason about later.
//
// Unlike work:import there is no sha to verify against: lane B records
// nothing in the database, so there is no recorded hash and no
// originality claim this script could check. What it stores is what the
// owner handed over, and the ledger records that file's OWN sha256. For
// the same reason the LOCAL BASENAME is the stored name (work:import
// treats local basenames as transport junk because the ROW carries the
// real name; here the row does not exist).
//
// The store write goes through storeExhibitArchive, which THROWS on
// failure instead of logging like the intake path: an exhibit has no
// bytea copy anywhere, so a swallowed failure would tell the operator
// their only archive is retained while the store holds nothing.
//
// Concurrency: takes the SAME advisory lock as work:backfill and
// work:import, so the three can never interleave; it releases when this
// process exits.
//
// Usage:
//   npm run work:retain -- --exhibit "<exact exhibit title>" --file <package.zip>
//                          [--doc <document.md>] [--dry-run] [--yes]
//
//   --exhibit  the exhibit card's exact title as it appears on /work
//   --file     the source package, stored at slot 00
//   --doc      an accompanying document, stored at slot 01 (optional)
//   --dry-run  print the plan, write NOTHING (no file, no ledger row)
//   --yes      skip the confirm prompt (work:import precedent)

import "dotenv/config";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { sql } from "drizzle-orm";
import { db } from "../src/lib/db";
import {
  allArchiveFilesForExhibit,
  archiveStoreRoot,
  storeExhibitArchive,
} from "../src/lib/work/archive-store";
import {
  exhibitSlug,
  sanitizeStoredName,
  storedExhibitRelPath,
} from "../src/lib/work/archive-naming";
import staticTitles from "../src/lib/work/static-titles.json";
import {
  ARCHIVE_OPS_LOCK_KEY,
  extraNameRefusal,
} from "./lib/work-archive-ops";
import {
  EXHIBIT_DOC_SLOT,
  EXHIBIT_PACKAGE_SLOT,
  exhibitPlanRefusal,
  matchExhibitTitle,
  parseRetainArgs,
  planExhibitSlots,
  type ExhibitCandidate,
  type ExhibitLedgerFact,
  type PlannedExhibitFile,
} from "./lib/work-exhibit-ops";

const USAGE =
  'Usage: npm run work:retain -- --exhibit "<exact exhibit title>" --file <package.zip> [--doc <document.md>] [--dry-run] [--yes]';

function die(msg: string, code = 1): never {
  console.error(`[work-retain] ${msg}`);
  process.exit(code);
}

/** Lane B as snapshotted by scripts/work-static-snapshot.mjs. The
 * `exhibits` array carries id + bay; older snapshots carry only `titles`,
 * which is still a complete authority for the exact-match gate. */
function candidates(): ExhibitCandidate[] {
  const exhibits = staticTitles.exhibits;
  if (Array.isArray(exhibits) && exhibits.length > 0)
    return exhibits.map((e) => ({ title: e.title, id: e.id, bay: e.bay }));
  const titles = staticTitles.titles;
  if (Array.isArray(titles) && titles.length > 0)
    return titles.map((t) => ({ title: t }));
  return [];
}

async function main() {
  if (typeof process.getuid === "function" && process.getuid() === 0)
    die(
      "Refusing to run as root: store files must be owned by the user the site runs as (run this as the deploy user), or admin cleanup could never unlink them."
    );
  const parsed = parseRetainArgs(process.argv.slice(2));
  if (!parsed.ok) die(`${parsed.error}\n\n${USAGE}`);
  const { exhibit: wanted, file, doc, dryRun, yes } = parsed.args;

  const cards = candidates();
  if (cards.length === 0)
    die(
      "src/lib/work/static-titles.json lists no exhibit cards. Regenerate it (node scripts/work-static-snapshot.mjs --write) before retaining anything: without it there is nothing to match --exhibit against."
    );
  const match = matchExhibitTitle(wanted, cards);
  if (!match.ok) die(match.error);
  const card = match.exhibit;
  const slugged = exhibitSlug(card.title);
  if (!slugged.ok) die(slugged.reason);
  const slug = slugged.slug;

  // Read and hash both local files BEFORE any DB work, so a typo'd path
  // costs nothing and holds no lock.
  const planned: PlannedExhibitFile[] = [];
  // Keyed by slot, deliberately a plain record and not a Map: the ops
  // scripts are source-scraped for any drizzle update call (no script in
  // this lane may UPDATE a submission row), and a Map write spells the
  // same method name, so it would read as one.
  const buffers: Record<number, Buffer> = {};
  const load = (label: string, path: string, slot: number) => {
    const name = basename(path);
    // The stored name is the local basename here (the row that would
    // carry a recorded name does not exist for lane B), so it gets the
    // same shape check work:import applies to an --extra name: a real
    // extension, and never a base64 armor copy left undecoded.
    const bad = extraNameRefusal(name);
    if (bad)
      die(
        `${label} ${path}: ${bad.replace(/^--extra name/, "the file name")}`
      );
    let data: Buffer;
    try {
      data = readFileSync(path);
    } catch (err) {
      die(
        `cannot read ${label} ${path}: ${err instanceof Error ? err.message : "unknown"}`
      );
    }
    if (data.length === 0) die(`${label} ${path} is empty; nothing to retain`);
    planned.push({
      slot,
      label,
      name,
      bytes: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
    });
    buffers[slot] = data;
  };
  load("package", file, EXHIBIT_PACKAGE_SLOT);
  if (doc) load("document", doc, EXHIBIT_DOC_SLOT);

  // One writer at a time across retain AND backfill AND import (one
  // shared advisory key): overlapping store writes can unlink each
  // other's files through the rename + ledger-collision handler.
  const lockRows = await db.execute(
    sql`select pg_try_advisory_lock(${ARCHIVE_OPS_LOCK_KEY}) as locked`
  );
  if (lockRows[0]?.locked !== true)
    die(
      "Another work:backfill, work:import or work:retain run holds the archive ops lock; wait for it to finish (the lock releases when that process exits)."
    );

  console.log(`Exhibit: "${card.title}"${card.bay ? `  (bay ${card.bay}${card.id ? `, #${card.id}` : ""})` : ""}`);
  console.log(`Slug:    ${slug}`);
  console.log(`Store:   ${resolve(archiveStoreRoot())}`);
  console.log(`Mode:    ${dryRun ? "DRY RUN (nothing is written)" : "live"}`);

  const ledgerRows = await allArchiveFilesForExhibit(slug);
  const ledger: ExhibitLedgerFact[] = ledgerRows.map((l) => ({
    relPath: l.relPath,
    fileName: l.fileName,
    bytes: l.bytes,
    sha256: l.sha256,
    deleted: l.deletedAt !== null,
    deletedAt: l.deletedAt ? l.deletedAt.toISOString() : null,
  }));
  if (ledger.length > 0) {
    console.log(`\nExisting ledger rows for this exhibit:`);
    for (const l of ledger)
      console.log(
        `  ${l.relPath} (${l.bytes} bytes, sha256 ${l.sha256.slice(0, 12)}, ${l.deleted ? `ADMIN-DELETED ${l.deletedAt?.slice(0, 10)}` : "live"})`
      );
  }

  const planned0 = planExhibitSlots(ledger, planned);
  if (!planned0.ok) die(`refusing to retain:\n${planned0.error}`);
  const plan = planned0.plan;

  console.log("");
  for (const p of plan) {
    const rel = storedExhibitRelPath(slug, p.slot, p.name);
    console.log(
      `${p.label}: ${p.slot === EXHIBIT_PACKAGE_SLOT ? file : doc}`
    );
    console.log(`  ${p.action.padEnd(14)} ${rel} (${p.bytes} bytes)`);
    console.log(`  sha256 ${p.sha256}`);
    if (p.reason) console.log(`  ${p.reason}`);
  }

  const refusal = exhibitPlanRefusal(plan);
  if (refusal)
    die(
      `\nrefusing to retain (nothing was written):\n${refusal}\n` +
        `A refusal on one slot refuses the whole run; an exhibit's files are handed over together.`
    );

  const toStore = plan.filter((p) => p.action === "store");
  if (toStore.length === 0) {
    console.log(
      `\nNothing to do: every file offered is already in the store byte for byte. (This is what a re-run looks like.)`
    );
    process.exit(0);
  }
  if (dryRun) {
    console.log(
      `\nDRY RUN: would store ${toStore.length} file(s) for "${card.title}". Nothing was written to the store or the ledger.`
    );
    process.exit(0);
  }

  if (!yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(
      `\n[work-retain] retain ${toStore.length} file(s) for the exhibit "${card.title}"? Type yes: `
    );
    rl.close();
    if (answer.trim().toLowerCase() !== "yes") die("aborted", 0);
  }

  // storeExhibitArchive THROWS on failure (deliberately, unlike the
  // intake path): an exhibit has no bytea copy anywhere, so a failure
  // must reach the operator instead of a log line. Files stored before
  // the failure keep their ledger rows and a re-run skips them.
  let written;
  try {
    written = await storeExhibitArchive(
      slug,
      card.title,
      toStore.map((p) => ({
        slot: p.slot,
        name: p.name,
        data: buffers[p.slot],
      }))
    );
  } catch (err) {
    die(
      `store write FAILED: ${err instanceof Error ? err.message.slice(0, 300) : "unknown"}\n` +
        `Nothing partial was left unledgered for the failed file. Re-run after fixing the cause; files already stored are skipped by the sha-match gate.`
    );
  }

  for (const l of written)
    console.log(
      `\nstored ${l.relPath}\n  ${l.bytes} bytes\n  ledger id ${l.id}\n  sha256 ${l.sha256}`
    );
  for (const p of plan)
    if (p.action === "skip-sha-match")
      console.log(
        `\nalready in the store (not written by this run): ${p.label}, ${sanitizeStoredName(p.name)}`
      );
  console.log(
    `\nDone. The console at /admin/work#storage now manages these files and can delete them like any other stored upload; they are labelled as exhibit archives because they carry no submission row.`
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
