#!/usr/bin/env -S npx tsx
// File an EXTERNALLY RECOVERED /work original into the §5.16 archive store
// (owner directive 2026-08-19: historical submissions are managed exactly
// like new files). Recovery lane for BYTE-LESS rows ONLY: rows whose bytea
// was cleared after a confirmed retention email (the 2026-07-30..08-03
// era) but whose original still exists off-box - the admin mailbox's
// retention attachments, or Resend's inbound store. Writes that copy into
// the store via the slot-explicit archive-store seam so the
// /admin/work#storage console manages it like any intake-written file.
// Runs ON THE PROD VM only (DATABASE_URL and the store's disk resolve
// there); refuses to run as root (store files must stay owned by the user
// the site runs as, or admin cleanup could never unlink them).
//
// SHA-256 verification is the core, settled over ALL files BEFORE anything
// is written (importShaRefusal in scripts/lib/work-archive-ops.ts, pure
// and unit-tested): the local package must hash to the row's recorded
// archive_sha256, a local --md to md_sha256. A mismatch refuses with both
// hashes printed; --force overrides with a loud PROVENANCE UNVERIFIED
// warning in the console output ONLY (the ledger schema is unchanged and
// carries no such flag). A row with no recorded sha proceeds, and says so.
//
// Refusals, all before any write:
//   - the row still holds archive_data or md_data: nothing was lost, the
//     store copy comes from work:backfill, not from an outside file
//     (importing outside bytes onto a bytea-holding row is exactly the
//     same-length-wrong-file hole refutation F1 closed);
//   - the row has ANY ledger rows, live or admin-deleted: live means the
//     store already manages files here (no silent double-import); deleted
//     means an admin deliberately removed that copy, and cleanup is FINAL
//     for this lane (manual SQL is the only override, not offered here).
//
// Slots come from WHICH file a thing is, never from array position:
// --file is the package (slot 00, stored under the row's archive_name),
// --md the standalone SKILL.md (slot 01, under md_name); either alone is
// fine, so a recovered md no longer gets forced into the package slot.
// Local basenames are transport junk and are never used. Touches NOTHING
// else on the row: not bytea, not status, nothing.
//
// Concurrency: takes the shared archive-ops advisory lock (one key with
// work:backfill), so overlapping store writes cannot unlink each other's
// files; the lock releases when this process exits.
//
// Usage:
//   npm run work:import -- <submission-uuid> [--file <path>] [--md <path>] [--force] [--yes]
//
//   --file    the recovered package (.zip/.skill/.md original), slot 00
//   --md      the recovered standalone SKILL.md, slot 01
//             (at least one of --file/--md is required)
//   --force   proceed past a sha256 mismatch (PROVENANCE UNVERIFIED)
//   --yes     skip the confirm prompt (work:rerun precedent)

import "dotenv/config";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "../src/lib/db";
import { submissionById } from "../src/lib/work/db";
import {
  allArchiveFilesForSubmission,
  archiveFilesForSubmission,
  archiveStoreRoot,
  storeArchiveFilesAt,
} from "../src/lib/work/archive-store";
import { sanitizeStoredName } from "../src/lib/work/archive-naming";
import {
  ARCHIVE_OPS_LOCK_KEY,
  MD_SLOT,
  PACKAGE_SLOT,
  importShaRefusal,
  parseImportArgs,
  type ImportFileCheck,
} from "./lib/work-archive-ops";

function die(msg: string, code = 1): never {
  console.error(`[work-import] ${msg}`);
  process.exit(code);
}

async function main() {
  if (typeof process.getuid === "function" && process.getuid() === 0)
    die(
      "Refusing to run as root: store files must be owned by the user the site runs as (run this as the deploy user), or admin cleanup could never unlink them."
    );
  const parsed = parseImportArgs(process.argv.slice(2));
  if (!parsed.ok)
    die(
      `${parsed.error}\n\nUsage: npm run work:import -- <submission-uuid> [--file <path>] [--md <path>] [--force] [--yes]`
    );
  const { id, file, md, force, yes } = parsed.args;

  // One writer at a time across import AND backfill (shared advisory key):
  // overlapping store writes to one submission can unlink each other's
  // files through the rename + ledger-collision handler.
  const lockRows = await db.execute(
    sql`select pg_try_advisory_lock(${ARCHIVE_OPS_LOCK_KEY}) as locked`
  );
  if (lockRows[0]?.locked !== true)
    die(
      "Another work:backfill or work:import run holds the archive ops lock; wait for it to finish (the lock releases when that process exits)."
    );

  const row = await submissionById(id);
  if (!row) die(`no submission row ${id}`);

  // Recovery lane for byte-less rows only (refutation F1): a row that
  // still holds bytea lost nothing; its store copy must come from
  // work:backfill (the row's OWN bytes), never from an outside file that
  // merely claims to be the original.
  const S = schema.workSubmissions;
  const bits = await db
    .select({
      hasArchive: sql<boolean>`${S.archiveData} is not null`,
      hasMd: sql<boolean>`${S.mdData} is not null`,
    })
    .from(S)
    .where(eq(S.id, id))
    .limit(1);
  if (bits[0]?.hasArchive === true || bits[0]?.hasMd === true)
    die(
      "row still holds its original bytes (archive_data/md_data): import is a recovery lane for byte-less rows only. Use npm run work:backfill, which stores the row's own bytes."
    );

  // ANY ledger row refuses, admin-deleted included (no silent
  // double-import; admin cleanup is final for the scripted lanes).
  const ledger = await allArchiveFilesForSubmission(id);
  if (ledger.length > 0) {
    const lines = ledger.map(
      (l) =>
        `  ${l.relPath} (${l.bytes} bytes, ${l.deletedAt === null ? "live" : `ADMIN-DELETED ${l.deletedAt.toISOString().slice(0, 10)}`})`
    );
    die(
      `row already has ${ledger.length} ledger row(s); refusing to import:\n${lines.join("\n")}\n` +
        `Live rows mean the store already manages this submission's files. ` +
        `Admin-deleted rows mean that copy was deliberately removed; cleanup is final for this lane and this script will not re-file it.`
    );
  }

  console.log(`Row:    ${row.id}`);
  console.log(`Title:  ${row.title}`);
  console.log(`Status: ${row.status}`);
  console.log(`Store:  ${resolve(archiveStoreRoot())}`);

  // Read + hash every local file and settle EVERY sha verdict (pure
  // importShaRefusal, all files at once) BEFORE any write: a refusal must
  // leave zero trace in the store.
  const entries: { slot: number; label: string; name: string; data: Buffer }[] = [];
  const checks: ImportFileCheck[] = [];
  const load = (
    label: string,
    path: string,
    slot: number,
    storedName: string,
    recordedSha: string | null
  ) => {
    let data: Buffer;
    try {
      data = readFileSync(path);
    } catch (err) {
      die(
        `cannot read ${label} ${path}: ${err instanceof Error ? err.message : "unknown"}`
      );
    }
    const sha = createHash("sha256").update(data).digest("hex");
    console.log(`\n${label}: ${path}`);
    console.log(`  stores as slot ${String(slot).padStart(2, "0")} ${storedName} (${data.length} bytes)`);
    console.log(`  local sha256    ${sha}`);
    console.log(`  recorded sha256 ${recordedSha ?? "(none on the row)"}`);
    if (recordedSha === null)
      console.log(
        `  NOTE: the row records no ${label} sha256; proceeding without hash verification.`
      );
    else if (recordedSha === sha) console.log(`  sha256 MATCH`);
    entries.push({ slot, label, name: storedName, data });
    checks.push({ label, localSha256: sha, recordedSha256: recordedSha });
  };

  if (file)
    load("package", file, PACKAGE_SLOT, row.archiveName ?? "upload.zip", row.archiveSha256);
  if (md) load("md", md, MD_SLOT, row.mdName ?? "SKILL.md", row.mdSha256);
  if (!md && row.mdName)
    console.log(
      `\nNOTE: the row records a standalone md (${row.mdName}) and no --md was given; only the package will be imported.`
    );
  if (!file && row.archiveName)
    console.log(
      `\nNOTE: the row records a package (${row.archiveName}) and no --file was given; only the md will be imported.`
    );

  // ALL verdicts settled, then the one gate, then (only then) any write.
  const refusal = importShaRefusal(checks, force);
  if (refusal) die(refusal);
  for (const c of checks)
    if (c.recordedSha256 !== null && c.recordedSha256 !== c.localSha256)
      console.log(
        `\nWARNING: PROVENANCE UNVERIFIED - ${c.label} sha256 mismatch overridden by --force.` +
          ` The stored file will NOT match the row's recorded hash; the ledger` +
          ` records the file's OWN sha256 and carries no unverified flag (console note only).` +
          ` Note: publish-time bytea clearing hashes the row's own bytes, so a` +
          ` forced import can never cause a wrong-file clear.`
      );

  if (!yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(
      `\n[work-import] import ${entries.length} file(s) into the store for "${row.title}"? Type yes: `
    );
    rl.close();
    if (answer.trim().toLowerCase() !== "yes") die("aborted", 0);
  }

  await storeArchiveFilesAt(
    id,
    row.title,
    entries.map((e) => ({ slot: e.slot, name: e.name, data: e.data }))
  );

  // storeArchiveFilesAt never throws; the ledger re-read is the verdict
  // (consuming match: one ledger row never satisfies two files).
  const after = await archiveFilesForSubmission(id);
  const unclaimed = [...after];
  const unmatched: string[] = [];
  for (const e of entries) {
    const idx = unclaimed.findIndex(
      (l) =>
        l.fileName === sanitizeStoredName(e.name) && l.bytes === e.data.length
    );
    if (idx === -1) unmatched.push(e.label);
    else unclaimed.splice(idx, 1);
  }
  for (const l of after)
    console.log(
      `\nstored ${l.relPath}\n  ${l.bytes} bytes\n  ledger id ${l.id}\n  sha256 ${l.sha256}`
    );
  if (unmatched.length > 0)
    die(
      `store write failed for ${unmatched.join(", ")} (see [work] log lines above); nothing else was changed`
    );
  console.log(
    `\nDone. The console at /admin/work#storage now manages these files; the row itself was not touched.`
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
