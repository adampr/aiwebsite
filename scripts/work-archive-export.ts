#!/usr/bin/env -S npx tsx
// Operator retrieval for the uploads retained on a /work submission row
// (§5.16). Runs ON THE PROD VM, in its own process, because DATABASE_URL
// resolves only there: the retained bytes live in Postgres on the same
// host as the site. That is a real limit, not an oversight, and the
// retention email says so rather than implying a remote restore path.
//
// This is the path the SCREENED-COPY retention email names: when the mail
// provider refuses an entry type inside the package, the emailed copy has
// those entries removed, and this is how the complete upload comes back.
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

  const files = await archiveDataById(id);
  if (files.length === 0) {
    console.log(
      "\nNo retained bytes on this row. Rows published before the 2026-07-29 " +
        "retention change never stored them."
    );
    process.exit(0);
  }

  for (const f of files) {
    const sha = createHash("sha256").update(f.data).digest("hex");
    const stored =
      f.name === row.mdName ? row.mdSha256 : row.archiveSha256;
    const match =
      stored == null ? "no stored hash" : stored === sha ? "MATCH" : "MISMATCH";
    console.log(`\n${f.name}\n  ${f.data.length} bytes\n  sha256 ${sha} (${match} vs stored)`);
    if (listOnly) continue;
    const dir = resolve(outDir);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, f.name);
    writeFileSync(path, f.data);
    console.log(`  written ${path}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
