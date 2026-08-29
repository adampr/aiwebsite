#!/usr/bin/env -S npx tsx
// Idempotent (re-run freely) backfill of HISTORICAL /work submissions into
// the §5.16 on-disk archive store (owner directive 2026-08-19: historical
// submissions land in the SAME store so they are managed exactly like new
// files). Runs ON THE PROD VM, in its own process, because DATABASE_URL
// and the store's disk both resolve only there. Refuses to run as root:
// store files must stay owned by the user the site runs as (the deploy
// user), or the web process could never unlink them at admin cleanup.
//
// PER FILE, not per row (refutation M3): each row's package (slot 00) and
// md (slot 01) are planned independently, so a re-run after a partial
// failure completes the missing file instead of wedging the row forever.
// For every expected slot, in order:
//   - a LIVE ledger row matching name+bytes (consuming match, one ledger
//     row never satisfies two files) -> already stored, skip;
//   - the slot's minted rel_path holds an admin-DELETED ledger row ->
//     skip and disclose: ADMIN CLEANUP IS FINAL for this lane
//     (work_archive_rel_path_uq is a FULL unique index, a re-file would
//     collide at the insert; manual SQL is the only override and is
//     deliberately not offered);
//   - a live ledger row occupies the rel_path without matching -> conflict,
//     surfaced as a failure for a human;
//   - otherwise -> store through the archive store's own slot-explicit
//     seam (temp-write -> rename -> stat-verify -> ledger), same naming,
//     title snapshot from the row.
//
// DELIBERATE: the backfill NEVER clears the row's bytea. Clearing stays
// exclusively the publish-time retention transaction (the atomic
// verify-and-clear in archive-store.ts, notify.ts its only caller); this
// script does not even import either clearing primitive (test:work pins
// that). The DB copy remains, and the admin console's rowHasBytes bit
// correctly shows these store files as not-the-last-copy.
//
// Concurrency: takes the shared archive-ops advisory lock (backfill,
// import and work:retain use one key), so a second script instance
// refuses to start; and
// each row's ledger is re-read immediately before storing, shrinking the
// window against a concurrent intake write.
//
// storeArchiveFilesAt never throws, so success is judged by RE-READING
// the ledger afterwards (consuming match); a file that did not land
// counts the row as failed and is named. Per-row try/catch: one bad row
// never stops the walk. Rows with bytes in NEITHER column are classified:
// already ledgered (fine), admin-cleaned (final), or needs-recovery
// (listed with id + title + created date + archive_name; recover via
// npm run work:import).
//
// Usage:
//   npm run work:backfill -- [--dry-run]
//
//   --dry-run   scan and print the per-file plan, write nothing
//
// Idempotent: a re-run finds every previously stored file ledgered,
// stores nothing new, and exits 0. Exit 1 only when a file failed or
// conflicted.

import "dotenv/config";
import { resolve } from "node:path";
import { asc, eq, sql } from "drizzle-orm";
import { db, schema } from "../src/lib/db";
import {
  allArchiveFilesForSubmission,
  archiveFilesForSubmission,
  archiveStoreRoot,
  storeArchiveFilesAt,
} from "../src/lib/work/archive-store";
import { sanitizeStoredName } from "../src/lib/work/archive-naming";
import { parseCleaning } from "../src/lib/work/cleaning";
import {
  ARCHIVE_OPS_LOCK_KEY,
  MD_SLOT,
  PACKAGE_SLOT,
  byteLessRowClass,
  planRowBackfill,
  type ExpectedSlotFile,
  type LedgerFact,
} from "./lib/work-archive-ops";

const S = schema.workSubmissions;

function usage(msg: string): never {
  console.error(`${msg}\n\nUsage: npm run work:backfill -- [--dry-run]`);
  process.exit(1);
}

function die(msg: string): never {
  console.error(`[work-backfill] ${msg}`);
  process.exit(1);
}

async function ledgerFacts(submissionId: string): Promise<LedgerFact[]> {
  return (await allArchiveFilesForSubmission(submissionId)).map((l) => ({
    relPath: l.relPath,
    fileName: l.fileName,
    bytes: l.bytes,
    deleted: l.deletedAt !== null,
  }));
}

async function main() {
  if (typeof process.getuid === "function" && process.getuid() === 0)
    die(
      "Refusing to run as root: store files must be owned by the user the site runs as (run this as the deploy user), or admin cleanup could never unlink them."
    );
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const unknown = argv.filter((a) => a !== "--dry-run");
  if (unknown.length > 0) usage(`Unknown argument: ${unknown[0]}`);

  // One writer at a time across backfill, import AND retain: overlapping store
  // writes to the same submission can unlink each other's files through
  // the rename + ledger-collision handler while both exit 0.
  const lockRows = await db.execute(
    sql`select pg_try_advisory_lock(${ARCHIVE_OPS_LOCK_KEY}) as locked`
  );
  if (lockRows[0]?.locked !== true)
    die(
      "Another work:backfill, work:import or work:retain run holds the archive ops lock; wait for it to finish (the lock releases when that process exits)."
    );

  console.log(`Store:  ${resolve(archiveStoreRoot())}`);
  console.log(`Mode:   ${dryRun ? "DRY RUN (no writes)" : "live"}`);

  // Facts scan: existence bits only, never the blobs themselves (ROW_COLS
  // discipline). Ledger state is deliberately NOT prefetched: it is read
  // fresh per row, immediately before the store decision.
  const rows = await db
    .select({
      id: S.id,
      title: S.title,
      status: S.status,
      createdAt: S.createdAt,
      archiveName: S.archiveName,
      mdName: S.mdName,
      archiveSha256: S.archiveSha256,
      mdSha256: S.mdSha256,
      archiveBytes: S.archiveBytes,
      mdBytes: S.mdBytes,
      hasArchive: sql<boolean>`${S.archiveData} is not null`,
      hasMd: sql<boolean>`${S.mdData} is not null`,
      cleaningJson: S.cleaningJson,
    })
    .from(S)
    .orderBy(asc(S.createdAt));

  let rowsStored = 0;
  let rowsSkipped = 0;
  let filesStored = 0;
  let filesSkippedLive = 0;
  let filesSkippedDeleted = 0;
  const failed: string[] = [];
  const needsRecovery: string[] = [];
  const adminCleaned: string[] = [];

  for (const row of rows) {
    const created = row.createdAt.toISOString().slice(0, 10);
    const label = `${row.id} ${created} [${row.status}] "${row.title}"`;
    try {
      // Fresh ledger read per row, right before the decision: the shared
      // advisory lock excludes the other script, and this shrinks the
      // window against a concurrent intake write.
      const ledger = await ledgerFacts(row.id);
      const expected: ExpectedSlotFile[] = [];
      if (row.hasArchive === true)
        expected.push({
          slot: PACKAGE_SLOT,
          name: row.archiveName ?? "upload.zip",
          bytes: row.archiveBytes,
        });
      if (row.hasMd === true)
        expected.push({
          slot: MD_SLOT,
          name: row.mdName ?? "SKILL.md",
          bytes: row.mdBytes,
        });

      if (expected.length === 0) {
        const cls = byteLessRowClass(ledger);
        console.log(`[plan] ${cls.padEnd(14)} ${label}`);
        if (cls === "ledgered") rowsSkipped++;
        else if (cls === "admin-cleaned")
          adminCleaned.push(`${row.id}  ${created}  ${row.archiveName ?? "-"}  "${row.title}"`);
        else
          needsRecovery.push(`${row.id}  ${created}  ${row.archiveName ?? "-"}  "${row.title}"`);
        continue;
      }

      const plan = planRowBackfill(row.id, expected, ledger);
      for (const p of plan)
        console.log(
          `[plan] ${p.action.padEnd(14)} ${label} slot ${p.slot === PACKAGE_SLOT ? "00 pkg" : "01 md"} ${p.name}`
        );
      filesSkippedLive += plan.filter((p) => p.action === "skip-live").length;
      const deletedSkips = plan.filter((p) => p.action === "skip-deleted");
      filesSkippedDeleted += deletedSkips.length;
      for (const p of deletedSkips)
        console.log(
          `  skipped slot ${p.slot}: an admin deleted this stored file; cleanup is final for this lane and it will not be re-filed.`
        );
      const conflicts = plan.filter((p) => p.action === "conflict");
      if (conflicts.length > 0) {
        failed.push(
          `${label}: live ledger row already occupies slot ${conflicts.map((p) => p.slot).join(", ")} with a different size; not overwriting (needs a human)`
        );
        continue;
      }
      const toStore = plan.filter((p) => p.action === "store");
      if (toStore.length === 0) {
        rowsSkipped++;
        continue;
      }
      if (dryRun) {
        rowsStored++;
        filesStored += toStore.length; // "would store"
        continue;
      }

      // Load the blobs slot-certain (which COLUMN a buffer came from is
      // the slot; archiveDataById flattens that identity away, which is
      // exactly the md-only misattribution this round fixed). Ops-script
      // read of the byte columns, one row at a time.
      const blobRows = await db
        .select({ pkg: S.archiveData, md: S.mdData })
        .from(S)
        .where(eq(S.id, row.id))
        .limit(1);
      const blob = blobRows[0];
      const entries: { slot: number; name: string; data: Buffer }[] = [];
      let vanished = false;
      for (const p of toStore) {
        const raw = p.slot === PACKAGE_SLOT ? blob?.pkg : blob?.md;
        if (!raw) {
          failed.push(`${label}: slot ${p.slot} bytea vanished between scan and store`);
          vanished = true;
          break;
        }
        entries.push({ slot: p.slot, name: p.name, data: Buffer.from(raw) });
      }
      if (vanished) continue;

      await storeArchiveFilesAt(row.id, row.title, entries);
      // storeArchiveFilesAt never throws (per-file failures only log), so
      // the ledger re-read is the verdict: consuming match, every stored
      // entry must claim its OWN live row at sanitized name + exact bytes.
      const after = await archiveFilesForSubmission(row.id);
      const unclaimed = [...after];
      const unmatched: string[] = [];
      for (const e of entries) {
        const idx = unclaimed.findIndex(
          (l) =>
            l.fileName === sanitizeStoredName(e.name) &&
            l.bytes === e.data.length
        );
        if (idx === -1) {
          unmatched.push(e.name);
          continue;
        }
        const l = unclaimed.splice(idx, 1)[0];
        // A CLEANED row's stamped hash describes the package as SUBMITTED,
        // not the cleaned bytes on disk, so comparing against it would print
        // this note on every cleaned row and train the operator to ignore it.
        const rowCleaning = parseCleaning(row.cleaningJson);
        const stamped =
          e.slot === MD_SLOT
            ? (rowCleaning?.md?.sha256 ?? row.mdSha256)
            : (rowCleaning?.archive?.sha256 ?? row.archiveSha256);
        const note =
          stamped && stamped !== l.sha256
            ? " (NOTE: sha256 differs from the row's recorded hash)"
            : "";
        console.log(`  stored ${l.relPath} (${l.bytes} bytes, ledger ${l.id})${note}`);
      }
      if (unmatched.length > 0) {
        failed.push(
          `${label}: store write failed for ${unmatched.join(", ")} (see [work] log lines above); a re-run stores only the still-missing files`
        );
        continue;
      }
      rowsStored++;
      filesStored += entries.length;
    } catch (err) {
      failed.push(
        `${label}: ${err instanceof Error ? err.message.slice(0, 200) : "unknown error"}`
      );
    }
  }

  console.log(
    `\nSummary (${rows.length} rows): ${rowsStored} rows ${dryRun ? "would get" : "got"} files stored (${filesStored} file${filesStored === 1 ? "" : "s"}), ` +
      `${rowsSkipped} rows already fully ledgered, ${adminCleaned.length} admin-cleaned, ${needsRecovery.length} need external recovery, ${failed.length} failed.`
  );
  console.log(
    `Per-file: ${filesStored} ${dryRun ? "would be " : ""}stored, ${filesSkippedLive} skipped (already live in the store), ${filesSkippedDeleted} skipped (admin-deleted, cleanup is final).`
  );
  if (needsRecovery.length > 0) {
    console.log(
      `\nNo bytes in EITHER column and no ledger trace (recover the original externally, then npm run work:import -- <uuid> --file <path> [--md <path>]):`
    );
    for (const n of needsRecovery) console.log(`  ${n}`);
  }
  if (adminCleaned.length > 0) {
    console.log(
      `\nNo bytes and only admin-deleted ledger rows (deliberate cleanup; final, nothing to backfill):`
    );
    for (const n of adminCleaned) console.log(`  ${n}`);
  }
  if (failed.length > 0) {
    console.log(
      `\nFAILED (fix the named cause, then re-run; completed files are skipped and only the missing ones are stored):`
    );
    for (const f of failed) console.log(`  ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
