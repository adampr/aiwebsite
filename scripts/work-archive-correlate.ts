#!/usr/bin/env -S npx tsx
// Correlate a folder of EXTERNALLY RECOVERED /work material (the admin
// mailbox's retention attachments, the owner's downloads) against every
// work_submissions row and the §5.16 archive-store ledger, and print the
// work:import commands that would file the originals. The first such
// batch (2026-08-29, ~145 files) was correlated by hand with python; this
// script is that analysis made repeatable, so the next batch needs no
// hand-rolled matching. Runs ON THE PROD VM because DATABASE_URL resolves
// there; the archive store's disk is not read at all.
//
// WRITES NOTHING to the database or to the archive store. The only thing
// it writes is decoded armor copies into `<dir>/.decoded/`: every
// `<name>.b64.txt` (the retention email's base64 armor, produced by
// src/lib/work/retention-encoding.ts) is decoded to real bytes under its
// unarmored name so an import command can point at a real file
// (work:import refuses `.b64.txt` names). An identical file already there
// is left alone; a DIFFERENT file at that name is disclosed and the new
// copy lands under a sha-prefixed name instead. Because it writes nothing
// shared, it does NOT take the archive-ops advisory lock and needs no root
// refusal: it may run beside a backfill or an import.
//
// Per row, per RECORDED slot (00 package, 01 standalone md), the verdict is
// one of: row-bytes (bytea still on the row; work:backfill stores it),
// store-live (a live ledger row holds it), store-mismatch (a live ledger
// row at the slot's path hashes to something OTHER than the recorded sha:
// the store holds the wrong bytes), admin-deleted (only deleted ledger
// rows: cleanup is FINAL, nothing is proposed), missing. For every missing
// or mismatched slot the folder is searched: a local file hashing to the
// recorded sha256 is RECOVERABLE (a plain file wins over a decoded armor
// copy, then the shortest path); a row with no recorded sha can only be
// matched on sanitized name + byte count, which is disclosed as
// UNVERIFIABLE (import with eyes open; originality is not claimed); when
// the only name matches are screened copies (`<name>.screened.<ext>`, the
// Gmail-safe rewrite the retention email sends when the original would
// bounce) the slot is SCREENED-ONLY: a screened copy can never satisfy the
// recorded sha, the original is not in this folder, and no --force is ever
// proposed; otherwise UNRECOVERED. A recoverable slot is READY (rides a
// command) only when work:import would accept it as things stand: a
// store-mismatch slot is never ready (the per-slot ledger gate refuses a
// slot with a live row; the wrong store file must be deleted in the
// console first), and no slot of a row that still holds bytea anywhere is
// ready (work:import refuses byte-holding rows whole; run work:backfill
// first). Commands carry the ready slots only, never --force, never --yes:
// the operator confirms each import. Everything not ready is printed with
// its exact reason, the true original named when it is in the folder.
//
// Also lists the local files that correspond to NO submission (not a
// recorded row sha, not a ledger sha), grouped by sha so duplicates sit
// together, with a bounded best-effort `name:` sniff from SKILL.md front
// matter (first SKILL.md at depth <= 2 in a zip container, 64 KB cap, a
// bad zip never throws): candidates that were never submitted, or
// different byte-versions of something that was.
//
// The walk never lets one bad entry abort the report: symlinks are
// skipped and listed, an unreadable file or an entry that will not stat is
// listed and skipped, an armor that does not decode (or decodes to
// something that is not a zip under a .skill/.zip/.ski name) is noted.
//
// Reads existence bits only (`archive_data is not null`), never a bytea
// column. Every pure decision lives in scripts/lib/work-archive-correlate.ts
// and is unit-tested DB-free by test:correlate.
//
// Usage:
//   npm run work:correlate -- <dir>
//
// Exit 0 when every missing slot is ready to import (or no slot is missing
// or mismatched); exit 2 when any missing or mismatched slot is not ready
// (unverifiable, screened-only, unrecovered, store-mismatch, or a
// byte-holding row); exit 1 on a usage or runtime error.

import "dotenv/config";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { asc, sql } from "drizzle-orm";
import { db, schema } from "../src/lib/db";
import { sanitizeStoredName } from "../src/lib/work/archive-naming";
import {
  MD_SLOT,
  decodeArmor,
  isArmorName,
  isZipMagic,
  planRecovery,
  sniffSkillName,
  unarmoredName,
  unmatchedLocal,
  type LedgerFacts,
  type LocalEntry,
  type LocalIndex,
  type RowFacts,
} from "./lib/work-archive-correlate";

const S = schema.workSubmissions;
const A = schema.workArchiveFiles;
const DECODED_DIR = ".decoded";

function usage(msg: string): never {
  console.error(`[work-correlate] ${msg}\n\nUsage: npm run work:correlate -- <dir>`);
  process.exit(1);
}

function sha256Of(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : "unknown error";
}

/** Every regular file under root, recursively, skipping `.decoded`.
 * lstat, never stat: a symlink is skipped whole (never followed, never
 * hashed) and listed in notes, as is any entry that will not stat or any
 * directory that will not list. One bad entry never aborts the walk. */
function walk(root: string, notes: string[]): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch (err) {
      notes.push(`directory skipped (cannot list): ${dir}: ${errMsg(err)}`);
      return;
    }
    for (const name of names) {
      const p = join(dir, name);
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(p);
      } catch (err) {
        notes.push(`entry skipped (cannot stat): ${p}: ${errMsg(err)}`);
        continue;
      }
      if (st.isSymbolicLink()) {
        notes.push(`symlink skipped: ${p}`);
        continue;
      }
      if (st.isDirectory()) {
        if (name === DECODED_DIR && dir === root) continue;
        visit(p);
      } else if (st.isFile()) out.push(p);
      else notes.push(`entry skipped (not a regular file): ${p}`);
    }
  };
  visit(root);
  return out;
}

function addEntry(index: LocalIndex, entry: LocalEntry) {
  const list = index.get(entry.sha256);
  if (list) list.push(entry);
  else index.set(entry.sha256, [entry]);
}

function slotLabel(slot: number): string {
  return slot === MD_SLOT ? "01 md " : "00 pkg";
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length !== 1) usage(argv.length === 0 ? "a folder of recovered files is required" : `unexpected argument: ${argv[1]}`);
  if (argv[0].startsWith("--")) usage(`unknown flag ${argv[0]}`);
  const dir = resolve(argv[0]);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) usage(`${dir} is not a directory`);

  // 1. Index the folder: hash every regular file, decode every armor.
  const notes: string[] = [];
  const files = walk(dir, notes);
  const index: LocalIndex = new Map();
  const decodedDir = join(dir, DECODED_DIR);
  let armorCount = 0;
  let decodedWritten = 0;
  let unreadable = 0;
  for (const path of files) {
    let data: Buffer;
    try {
      data = readFileSync(path);
    } catch (err) {
      notes.push(`file skipped (unreadable): ${path}: ${errMsg(err)}`);
      unreadable++;
      continue;
    }
    addEntry(index, { path, bytes: data.length, sha256: sha256Of(data), source: "file" });
    if (!isArmorName(basename(path))) continue;
    armorCount++;
    const decoded = decodeArmor(data.toString("utf8"));
    if (decoded === null) {
      notes.push(`${relative(dir, path)}: not clean base64 armor (or empty); left as is (indexed as a plain file only)`);
      continue;
    }
    const decodedSha = sha256Of(decoded);
    const wantName = sanitizeStoredName(unarmoredName(basename(path)));
    if (/\.(skill|zip|ski)$/i.test(wantName) && !isZipMagic(decoded))
      notes.push(`${relative(dir, path)}: decoded bytes are not a zip; the armor may not be a retention attachment`);
    let target = join(decodedDir, wantName);
    if (existsSync(target)) {
      const existing = readFileSync(target);
      if (sha256Of(existing) !== decodedSha) {
        target = join(decodedDir, `${decodedSha.slice(0, 12)}-${wantName}`);
        notes.push(
          `${relative(dir, path)}: a DIFFERENT file already sits at ${relative(dir, join(decodedDir, wantName))}; this decode was written to ${relative(dir, target)} instead`
        );
      }
    }
    if (!existsSync(target)) {
      mkdirSync(decodedDir, { recursive: true });
      writeFileSync(target, decoded);
      decodedWritten++;
    }
    addEntry(index, {
      path: target,
      bytes: decoded.length,
      sha256: decodedSha,
      source: "decoded-armor",
      armorPath: path,
    });
  }
  console.log(`Folder:  ${dir}`);
  console.log(
    `Files:   ${files.length} regular files (${unreadable} unreadable), ${armorCount} armor (.b64.txt), ${decodedWritten} decoded copies written to ${DECODED_DIR}/`
  );
  for (const n of notes) console.log(`  note: ${n}`);

  // 2. Scan the table: existence bits only, never the blobs (ROW_COLS
  // discipline of work:backfill), plus the WHOLE ledger, deleted rows and
  // orphans (submission_id null) included, so an unmatched local file is
  // never a copy of something the store once held.
  const rowsRaw = await db
    .select({
      id: S.id,
      title: S.title,
      status: S.status,
      createdAt: S.createdAt,
      archiveName: S.archiveName,
      archiveSha256: S.archiveSha256,
      archiveBytes: S.archiveBytes,
      mdName: S.mdName,
      mdSha256: S.mdSha256,
      mdBytes: S.mdBytes,
      hasArchive: sql<boolean>`${S.archiveData} is not null`,
      hasMd: sql<boolean>`${S.mdData} is not null`,
    })
    .from(S)
    .orderBy(asc(S.createdAt));
  const rows: RowFacts[] = rowsRaw.map((r) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
    hasArchive: r.hasArchive === true,
    hasMd: r.hasMd === true,
  }));
  const ledgerRaw = await db
    .select({
      submissionId: A.submissionId,
      relPath: A.relPath,
      fileName: A.fileName,
      bytes: A.bytes,
      sha256: A.sha256,
      deletedAt: A.deletedAt,
    })
    .from(A)
    .orderBy(asc(A.relPath));
  const allLedger: LedgerFacts[] = [];
  const ledgerByRowId = new Map<string, LedgerFacts[]>();
  for (const l of ledgerRaw) {
    const fact: LedgerFacts = {
      relPath: l.relPath,
      fileName: l.fileName,
      bytes: l.bytes,
      sha256: l.sha256,
      deleted: l.deletedAt !== null,
    };
    allLedger.push(fact);
    if (l.submissionId) {
      const list = ledgerByRowId.get(l.submissionId);
      if (list) list.push(fact);
      else ledgerByRowId.set(l.submissionId, [fact]);
    }
  }
  console.log(`DB:      ${rows.length} work_submissions rows, ${allLedger.length} ledger rows (${allLedger.filter((l) => l.deleted).length} admin-deleted)`);

  // 3. Decide.
  const plan = planRecovery(rows, ledgerByRowId, index);
  const withOpen = plan.filter((p) => p.open.length > 0);
  const complete = plan.length - withOpen.length;

  // (a) per row with a missing or mismatched slot: every slot's verdict
  // and file.
  console.log(`\n== Rows with a missing or mismatched slot (${withOpen.length}) ==`);
  if (withOpen.length === 0) console.log("  none");
  for (const p of withOpen) {
    const created = p.row.createdAt.slice(0, 10);
    const holds = p.row.hasArchive || p.row.hasMd ? "  (still holds bytea: work:backfill first)" : "";
    console.log(`\n${p.row.id}  ${created}  [${p.row.status}]  "${p.row.title}"${holds}`);
    for (const s of p.slots) {
      const m = p.open.find((x) => x.slot === s.slot);
      const verdict = m ? `${s.verdict} / ${m.recovery}${m.ready ? " / READY" : ""}` : s.verdict;
      console.log(`  slot ${slotLabel(s.slot)}  ${verdict.padEnd(40)} ${s.name}  (${s.bytes ?? "?"} bytes, sha ${s.sha256 ? s.sha256.slice(0, 12) : "none recorded"})`);
      if (s.note) console.log(`      note: ${s.note}`);
      if (m?.file)
        console.log(`      file: ${m.file.path}${m.file.source === "decoded-armor" ? `  (decoded from ${m.file.armorPath})` : ""}`);
    }
  }

  // (b) ready-to-run commands.
  const commands = withOpen.filter((p) => p.command !== null);
  console.log(`\n== Import commands (${commands.length}; ready slots only, the operator confirms each; never --force, never --yes) ==`);
  if (commands.length === 0) console.log("  none");
  for (const p of commands) console.log(`  ${p.command}`);

  // (c) the ones that are not ready, with the exact reason.
  const notReady = withOpen.flatMap((p) => p.open.filter((m) => !m.ready).map((m) => ({ p, m })));
  console.log(`\n== Missing or mismatched slots NOT recoverable as things stand (${notReady.length}) ==`);
  if (notReady.length === 0) console.log("  none");
  for (const { p, m } of notReady) {
    console.log(`\n  ${p.row.id}  ${p.row.createdAt.slice(0, 10)}  "${p.row.title}"  slot ${slotLabel(m.slot)} ${m.name}  [${m.verdict}]`);
    console.log(`    ${m.recovery}: ${m.reason}`);
    if (m.recovery === "unverifiable-name-match" && m.flag)
      console.log(`    to import with eyes open: npm run work:import -- ${p.row.id} ${m.flag}`);
  }

  // (d) already complete.
  console.log(`\n== Already complete: ${complete} of ${plan.length} rows record no missing or mismatched slot ==`);

  // (e) local files that correspond to no submission.
  const unmatched = unmatchedLocal(index, rows, allLedger);
  console.log(`\n== Local files matching no submission (${unmatched.length} distinct byte streams) ==`);
  if (unmatched.length === 0) console.log("  none");
  for (const g of unmatched) {
    const first = g.entries[0];
    let name: string | null = null;
    try {
      name = await sniffSkillName(basename(first.path), readFileSync(first.path));
    } catch {
      name = null;
    }
    console.log(`\n  ${g.sha256.slice(0, 12)}  ${g.bytes} bytes${name ? `  name: ${name}` : ""}`);
    for (const e of g.entries)
      console.log(`    ${relative(dir, e.path)}${e.source === "decoded-armor" ? `  (decoded from ${relative(dir, e.armorPath ?? "")})` : ""}`);
  }

  const openSlots = withOpen.reduce((n, p) => n + p.open.length, 0);
  const ready = openSlots - notReady.length;
  console.log(
    `\nSummary: ${plan.length} rows, ${withOpen.length} with a missing or mismatched slot (${openSlots} slots: ${ready} ready to import, ${notReady.length} not), ${complete} complete, ${unmatched.length} unmatched local byte streams. Nothing was written to the DB or the store.`
  );
  process.exit(notReady.length > 0 ? 2 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
