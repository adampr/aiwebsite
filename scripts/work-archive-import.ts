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
//   - a ledger row, live or admin-deleted, already occupies a SLOT this
//     run would write (importSlotRefusal, pure and unit-tested): live
//     means the store already manages that file (no silent double-import);
//     deleted means an admin deliberately removed that copy, and cleanup
//     is FINAL for this lane at slot granularity (manual SQL is the only
//     override, not offered here). Slots the run does not touch are left
//     alone. Until 2026-08-29 ANY ledger row refused the whole row; the
//     canvas recovery (below) needed a row that already held slot 00 from
//     the 08-19 backfill to accept its md, so the gate was narrowed to
//     the slots actually being written and no further;
//   - a ledger rel_path without the NN- prefix storeArchiveFilesAt mints:
//     that ledger was tampered with or hand-edited, refused loudly.
//
// Slots come from WHICH file a thing is, never from array position:
// --file is the package (slot 00, stored under the row's archive_name),
// --md the standalone SKILL.md (slot 01, under md_name); either alone is
// fine, so a recovered md no longer gets forced into the package slot.
// Local basenames are transport junk and are never used. Touches NOTHING
// else on the row: not bytea, not status, nothing.
//
// --extra <name>=<path> (repeatable, 2026-08-29) stores an ASSOCIATED file:
// something that travelled beside the submission but is NOT the recorded
// original upload (a differently-built .skill, or the right SKILL.md when
// the row recorded a mis-attached doc). It goes to the next free slot
// >= EXTRA_SLOT_MIN (02) under the given name (sanitizeStoredName), is
// compared against NOTHING on the row (it never enters importShaRefusal;
// the ledger records the file's own sha256 like every other file), and
// the console labels each one ASSOCIATED FILE (not the recorded original)
// so nobody reads a slot-02 file as provenance for the row. Names must be
// bare filenames with a real extension; .b64.txt is refused because the
// canvas carries base64-armored .skill files and the store must hold the
// decoded artifact, not its transport.
//
// Why (2026-08-29 canvas recovery): rows from the 07-30..08-03 era lost
// their bytea to retention, and their originals turned up on the
// "AI Builders Skills and Code (XLnetters)" Slack canvas. Most are clean
// sha MATCHES on --file/--md. One row (Knowledge Base Style Guide) already
// holds slot 00 from the 08-19 backfill and records kickoff-agenda.md as
// its md (mis-attached at submission): the real kb-style-guide.md is
// associated, not original. Another (License renewal tracking) records a
// "files (2).zip" package while the canvas carries a differently-built
// license-renewal-tracker.skill: associated, not original. Neither may be
// filed at slot 00/01 under an originality claim it cannot make; both
// belong in the store where the console can manage them.
//
// Concurrency: takes the shared archive-ops advisory lock (one key with
// work:backfill and work:retain), so overlapping store writes cannot
// unlink each other's
// files; the lock releases when this process exits.
//
// Usage:
//   npm run work:import -- <submission-uuid> [--file <path>] [--md <path>]
//                          [--extra <name>=<path>]... [--force] [--yes]
//
//   --file    the recovered package (.zip/.skill/.md original), slot 00,
//             sha-gated on archive_sha256
//   --md      the recovered standalone SKILL.md, slot 01, sha-gated on
//             md_sha256
//   --extra   an ASSOCIATED file (not the recorded original), stored at
//             the next free slot >= 02 under <name>; no sha claim;
//             repeatable, names unique, bare filename with an extension,
//             never .b64.txt (decode first); the byte-less-row rule
//             applies to extras as well (a row still holding its original
//             bytes takes work:backfill first)
//             (at least one of --file/--md/--extra is required)
//   --force   proceed past a sha256 mismatch on --file/--md (PROVENANCE
//             UNVERIFIED); --extra is never sha-checked so --force does
//             not apply to it
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
import { cleanedPathsOf, parseCleaning } from "../src/lib/work/cleaning";
import {
  ARCHIVE_OPS_LOCK_KEY,
  MD_SLOT,
  PACKAGE_SLOT,
  freeExtraSlots,
  importShaRefusal,
  importSlotRefusal,
  parseImportArgs,
  type ImportFileCheck,
} from "./lib/work-archive-ops";

const USAGE =
  "Usage: npm run work:import -- <submission-uuid> [--file <path>] [--md <path>] [--extra <name>=<path>]... [--force] [--yes]";

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
  if (!parsed.ok) die(`${parsed.error}\n\n${USAGE}`);
  const { id, file, md, extra, force, yes } = parsed.args;

  // One writer at a time across import, backfill AND retain (shared key):
  // overlapping store writes to one submission can unlink each other's
  // files through the rename + ledger-collision handler.
  const lockRows = await db.execute(
    sql`select pg_try_advisory_lock(${ARCHIVE_OPS_LOCK_KEY}) as locked`
  );
  if (lockRows[0]?.locked !== true)
    die(
      "Another work:backfill, work:import or work:retain run holds the archive ops lock; wait for it to finish (the lock releases when that process exits)."
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
      cleaningJson: S.cleaningJson,
    })
    .from(S)
    .where(eq(S.id, id))
    .limit(1);
  if (bits[0]?.hasArchive === true || bits[0]?.hasMd === true)
    die(
      "row still holds its original bytes (archive_data/md_data): import is a recovery lane for byte-less rows only. Use npm run work:backfill, which stores the row's own bytes."
    );
  // A CLEANED ROW REFUSES (§5.16 cleaning, 2026-08-29), and this is the
  // sharpest edge the two-hash ruling opens. archive_sha256 describes what the
  // SUBMITTER SENT, deliberately, so work:correlate can still recognise their
  // copy of their own file. That means a recovered original PASSES the sha
  // gate here, and filing it would put the credential material we removed back
  // on disk, hash-verified and looking authoritative. --force still works, for
  // the operator who has read this and means it.
  const rowCleaning = parseCleaning(bits[0]?.cleaningJson ?? null);
  if (rowCleaning && force) {
    // ONE FLAG, TWO OVERRIDES, AND THE QUIET ONE IS THE DANGEROUS ONE. Forcing
    // past a sha MISMATCH is already loud (importShaRefusal prints PROVENANCE
    // UNVERIFIED). Forcing past a CLEANED row is the opposite shape: the sha
    // MATCHES, so load() prints "sha256 MATCH" and the whole run reads as a
    // clean, hash-verified recovery, while what is actually being filed is the
    // uncleaned original. Say so where the operator is looking.
    console.log(
      `\n!! FORCING ONTO A CLEANED ROW. This row's upload was cleaned at intake ` +
        `and its recorded sha256 is the hash of the package AS SUBMITTED, so a ` +
        `matching local file is the UNCLEANED original. Filing it RESTORES ` +
        `material that was deliberately removed:`
    );
    for (const removed of cleanedPathsOf(rowCleaning))
      console.log(`     ${removed}`);
    console.log(
      `   Any "sha256 MATCH" printed below is confirming the ORIGINAL, not the ` +
        `cleaned copy.\n`
    );
  }
  if (rowCleaning && !force) {
    const removed = cleanedPathsOf(rowCleaning);
    die(
      [
        "row was CLEANED at intake: its recorded sha256 is the hash of the package as SUBMITTED, not of what was stored.",
        "A local file matching that hash is the uncleaned original, and importing it would restore material that was deliberately removed:",
        ...removed.map((r) => `  ${r}`),
        "If you have the cleaned copy and mean to file it, re-run with --force.",
      ].join("\n")
    );
  }

  // Per-SLOT ledger gate (admin-deleted included): a ledger row at a slot
  // this run would write refuses (live = no silent double-import;
  // deleted = admin cleanup is final for the scripted lanes). Slots not
  // being written are left alone. Extras take the lowest free slots
  // >= 02, free meaning no ledger row live OR deleted.
  const ledger = await allArchiveFilesForSubmission(id);
  const extraSlots = freeExtraSlots(ledger, extra.length);
  const slotsToWrite = [
    ...(file ? [PACKAGE_SLOT] : []),
    ...(md ? [MD_SLOT] : []),
    ...extraSlots,
  ];
  const slotRefusal = importSlotRefusal(ledger, slotsToWrite);
  if (slotRefusal)
    die(
      `refusing to import:\n${slotRefusal}\n` +
        `Live rows mean the store already manages that file. ` +
        `Admin-deleted rows mean that copy was deliberately removed; cleanup is final for this lane and this script will not re-file that slot.`
    );

  console.log(`Row:    ${row.id}`);
  console.log(`Title:  ${row.title}`);
  console.log(`Status: ${row.status}`);
  console.log(`Store:  ${resolve(archiveStoreRoot())}`);
  if (ledger.length > 0) {
    console.log(`Existing ledger rows (none of these slots is written by this run):`);
    for (const l of ledger)
      console.log(
        `  ${l.relPath} (${l.bytes} bytes, ${l.deletedAt === null ? "live" : `ADMIN-DELETED ${l.deletedAt.toISOString().slice(0, 10)}`})`
      );
  }

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
  // Associated files: no originality claim, so no sha claim. They are
  // read + hashed for the console and the ledger only, and never enter
  // importShaRefusal (nothing on the row is theirs to match).
  extra.forEach((x, i) => {
    let data: Buffer;
    try {
      data = readFileSync(x.path);
    } catch (err) {
      die(
        `cannot read extra ${x.path}: ${err instanceof Error ? err.message : "unknown"}`
      );
    }
    const slot = extraSlots[i];
    const storedName = sanitizeStoredName(x.name);
    const sha = createHash("sha256").update(data).digest("hex");
    console.log(`\nextra: ${x.path}`);
    console.log(`  ASSOCIATED FILE (not the recorded original): compared against nothing on the row; the ledger records this file's own sha256.`);
    console.log(`  stores as slot ${String(slot).padStart(2, "0")} ${storedName} (${data.length} bytes)`);
    console.log(`  local sha256    ${sha}`);
    entries.push({ slot, label: `extra ${storedName}`, name: x.name, data });
  });
  if (!md && row.mdName)
    console.log(
      `\nNOTE: the row records a standalone md (${row.mdName}) and no --md was given; slot 01 is not written by this run.`
    );
  if (!file && row.archiveName)
    console.log(
      `\nNOTE: the row records a package (${row.archiveName}) and no --file was given; slot 00 is not written by this run.`
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
  // (consuming match: one ledger row never satisfies two files). Only rows
  // that did not exist before this run count: since the per-slot gate
  // (2026-08-29) admits rows that already hold a live slot, a pre-existing
  // row with the same sanitized name and byte length (a re-import of the
  // very file at slot 00, say) would otherwise satisfy an entry whose own
  // write failed, and the "stored" listing would claim files this run never
  // touched.
  const before = new Set(ledger.map((l) => l.id));
  const after = (await archiveFilesForSubmission(id)).filter(
    (l) => !before.has(l.id)
  );
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
  for (const l of ledger)
    if (l.deletedAt === null)
      console.log(`\nalready in the store (not written by this run): ${l.relPath}`);
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
