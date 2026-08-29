#!/usr/bin/env -S npx tsx
// Operator retrieval for the uploads retained behind a /work submission
// (§5.16). Runs ON THE PROD VM, in its own process, because DATABASE_URL
// and the archive store's disk both resolve only there. That is a real
// limit, not an oversight, and the retention email says so rather than
// implying a remote restore path.
//
// This is the path the retention email names for anything it could not
// carry: SCREENED-COPY sends (blocked entry types removed) and, since the
// 100 MB round (2026-08-19), files too large to attach at all.
//
// Recovery is PER FILE, never all-or-nothing: every live ledger file that
// reads back is exported; one that does not falls back to the row's bytea
// copy of the same file; a file recoverable from neither is LISTED as
// missing instead of silently shrinking the output. Bytea files with no
// ledger row (store write failed at intake) still export. The resolved
// store root is printed so a wrong-cwd run (default root is relative to
// cwd) diagnoses itself.
//
// Usage:
//   npm run work:archive -- <uuid> [--out <dir>] [--list]
//
//   --list   print the file names, sizes and SHA-256s, write nothing
//   --out    directory to write into (default: the current directory)

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import "dotenv/config";
import { archiveDataById, submissionById } from "../src/lib/work/db";
import {
  archiveFilesForSubmission,
  archiveStoreRoot,
  readStoredArchive,
} from "../src/lib/work/archive-store";
import { sanitizeStoredName } from "../src/lib/work/archive-naming";
import { parseCleaning } from "../src/lib/work/cleaning";

function usage(msg: string): never {
  console.error(`${msg}\n\nUsage: npm run work:archive -- <uuid> [--out <dir>] [--list]`);
  process.exit(1);
}

async function main() {
  const argv = process.argv.slice(2);
  const id = argv.find((a) => !a.startsWith("--"));
  if (!id) usage("A submission id is required.");
  const listOnly = argv.includes("--list");
  const outIdx = argv.indexOf("--out");
  const outDir = outIdx >= 0 ? argv[outIdx + 1] : ".";
  if (outIdx >= 0 && !outDir) usage("--out needs a directory.");

  const row = await submissionById(id);
  if (!row) usage(`No submission row ${id}.`);
  console.log(`Row:    ${row.id}`);
  console.log(`Title:  ${row.title}`);
  console.log(`Status: ${row.status}`);
  console.log(`Store:  ${resolve(archiveStoreRoot())}`);

  const ledger = await archiveFilesForSubmission(id);
  const rowFiles = await archiveDataById(id);
  // Display names prefer the row's stamped originals over the store's
  // sanitized ones; the store's 00/01 slots were written [package, md].
  const displayName = (fileName: string, relPath: string): string => {
    const slot = /\/(\d{2})-/.exec(relPath)?.[1];
    if (slot === "00" && row.archiveName) return row.archiveName;
    if (slot === "01" && row.mdName) return row.mdName;
    return fileName;
  };
  // For a CLEANED row (§5.16, 2026-08-29) the row's stamped sha describes the
  // package as SUBMITTED, while the bytes on disk are the cleaned rebuild, so
  // comparing them would print a MISMATCH on every cleaned row and teach the
  // operator to ignore the one alarm that matters. The cleaned hashes are
  // recorded on the row for exactly this.
  const rowCleaning = parseCleaning(row.cleaningJson);
  const stampedSha = (name: string): string | null =>
    name === row.mdName
      ? (rowCleaning?.md?.sha256 ?? row.mdSha256)
      : (rowCleaning?.archive?.sha256 ?? row.archiveSha256);

  const recovered: {
    name: string;
    data: Buffer;
    source: "store" | "row";
    knownSha: string | null;
  }[] = [];
  const missing: string[] = [];
  const usedRowFiles = new Set<number>();

  for (const l of ledger) {
    let data: Buffer | null = null;
    try {
      const buf = await readStoredArchive(l.relPath);
      if (buf.length === l.bytes) data = buf;
    } catch {
      data = null;
    }
    if (data) {
      recovered.push({
        name: displayName(l.fileName, l.relPath),
        data,
        source: "store",
        knownSha: l.sha256,
      });
      continue;
    }
    // Per-file bytea fallback for a store miss.
    const fbIdx = rowFiles.findIndex(
      (f, i) =>
        !usedRowFiles.has(i) &&
        sanitizeStoredName(f.name) === l.fileName &&
        f.data.length === l.bytes
    );
    if (fbIdx >= 0) {
      usedRowFiles.add(fbIdx);
      const f = rowFiles[fbIdx];
      recovered.push({
        name: f.name,
        data: f.data,
        source: "row",
        knownSha: stampedSha(f.name),
      });
      console.log(
        `\nNOTE: ${l.relPath} unreadable in the store; recovered this file from the row's bytea instead.`
      );
    } else {
      missing.push(`${l.relPath} (${l.bytes} bytes, sha256 ${l.sha256})`);
    }
  }
  // Bytea files the ledger never covered (store write failed at intake,
  // or a pre-store row with no ledger at all).
  rowFiles.forEach((f, i) => {
    if (usedRowFiles.has(i)) return;
    const covered = recovered.some(
      (r) =>
        sanitizeStoredName(r.name) === sanitizeStoredName(f.name) &&
        r.data.length === f.data.length
    );
    if (covered) return;
    recovered.push({
      name: f.name,
      data: f.data,
      source: "row",
      knownSha: stampedSha(f.name),
    });
  });

  if (recovered.length === 0 && missing.length === 0) {
    console.log(
      "\nNo retained bytes for this row in the archive store or on the row. " +
        "Rows published before the 2026-07-29 retention change never stored " +
        "them; otherwise check work_archive_files for an admin cleanup stamp."
    );
    process.exit(0);
  }

  for (const f of recovered) {
    const sha = createHash("sha256").update(f.data).digest("hex");
    const match =
      f.knownSha == null
        ? "no stored hash"
        : f.knownSha === sha
          ? "MATCH"
          : "MISMATCH";
    console.log(
      `\n${f.name} [${f.source}]\n  ${f.data.length} bytes\n  sha256 ${sha} (${match} vs stored)`
    );
    if (listOnly) continue;
    const dir = resolve(outDir);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, sanitizeStoredName(f.name));
    writeFileSync(path, f.data);
    console.log(`  written ${path}`);
  }

  if (missing.length > 0) {
    console.log(
      `\nMISSING, recovered from NEITHER the store nor the row (${missing.length}):`
    );
    for (const m of missing) console.log(`  ${m}`);
    process.exitCode = 2;
  }
  if (process.exitCode !== 2) process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
