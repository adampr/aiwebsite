/**
 * Add ONE document to the /rfp supporting-documents library from disk
 * (ARCHITECTURE.md §5.17.23, round 35). The prod seeding lane.
 *
 *   npm run rfp:library-add -- <file> --title <t> --kind <k>
 *       [--confidential] [--redacted-sample] [--as-of YYYY-MM-DD] [--force]
 *
 * The file goes through EXACTLY the upload route's validation
 * (attachments.ts validateLibraryUpload): a PDF or a Word .docx by its magic
 * bytes only, at most 32 MB, the title screened, the kind one of
 * certification | report | procedure | template | sample | agreement. The
 * file's name is never stored and never printed. A LIVE library row with
 * exactly the same (screened) title refuses the add, so a re-run seeding
 * never doubles a document; --force adds it anyway.
 *
 * Prints the new row's id and title only, never content. Activity
 * `library.add` (actor "cli"): title, kind and flags only. Every failure
 * past argument parsing prints a fixed message: a driver error's message can
 * echo the insert's parameters, and one of them is the file.
 *
 * Exit: 2 usage, 1 refused or failed, 0 added.
 */

import "dotenv/config";
import { readFileSync, statSync } from "node:fs";
import { logRfpActivity } from "../src/lib/rfp/activity";
import { LIBRARY_KINDS, LIBRARY_MAX_BYTES, LIBRARY_MAX_COPY, validateLibraryUpload } from "../src/lib/rfp/attachments";
import { insertLibraryDocument, listLibraryDocuments } from "../src/lib/rfp/db";

const USAGE =
  "usage: npm run rfp:library-add -- <file> --title <t> --kind <" +
  LIBRARY_KINDS.join("|") +
  "> [--confidential] [--redacted-sample] [--as-of YYYY-MM-DD] [--force]";

/** The duplicate refusal, fixed copy (no title, no filename). */
const DUPLICATE_REFUSAL =
  "refused: a live library document already has exactly this title. Retire it first, or pass --force to add a second one.";

type Args = {
  file: string;
  title: string;
  kind: string;
  confidential: boolean;
  redactedSample: boolean;
  asOf: string | null;
  force: boolean;
};

/** Argument parse; null on any unknown flag, missing value or second file. */
function parseLibraryAddArgs(argv: string[]): Args | null {
  let file: string | null = null;
  let title: string | null = null;
  let kind: string | null = null;
  let asOf: string | null = null;
  let confidential = false;
  let redactedSample = false;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) return null;
      i++;
      return v;
    };
    if (a === "--title") {
      if ((title = value()) === null) return null;
    } else if (a === "--kind") {
      if ((kind = value()) === null) return null;
    } else if (a === "--as-of") {
      if ((asOf = value()) === null) return null;
    } else if (a === "--confidential") confidential = true;
    else if (a === "--redacted-sample") redactedSample = true;
    else if (a === "--force") force = true;
    else if (a.startsWith("--")) return null;
    else if (file === null) file = a;
    else return null;
  }
  if (file === null || title === null || kind === null) return null;
  return { file, title, kind, confidential, redactedSample, asOf, force };
}

async function main(): Promise<number> {
  const args = parseLibraryAddArgs(process.argv.slice(2));
  if (!args) {
    console.error(USAGE);
    return 2;
  }
  let size: number;
  try {
    size = statSync(args.file).size;
  } catch {
    console.error("refused: the file could not be read");
    return 1;
  }
  // Never read an over-cap file into memory.
  if (size > LIBRARY_MAX_BYTES) {
    console.error(`refused: that file is over ${LIBRARY_MAX_COPY}`);
    return 1;
  }
  const bytes = readFileSync(args.file);
  const checked = validateLibraryUpload({
    bytes,
    title: args.title,
    kind: args.kind,
    confidential: args.confidential,
    redactedSample: args.redactedSample,
    asOf: args.asOf ?? undefined,
  });
  if (!checked.ok) {
    console.error(`refused: ${checked.message}`);
    return 1;
  }
  const v = checked.value;
  if (!args.force && (await listLibraryDocuments()).some((d) => d.title === v.title)) {
    console.error(DUPLICATE_REFUSAL);
    return 1;
  }
  const row = await insertLibraryDocument({
    title: v.title,
    kind: v.kind,
    bytes,
    media: v.media,
    confidential: v.confidential,
    redactedSample: v.redactedSample,
    asOf: v.asOf,
    createdBy: "cli",
  });
  await logRfpActivity({
    actorEmail: "cli",
    actorAdmin: true,
    action: "library.add",
    subjectKind: "library",
    subjectId: row.id,
    meta: { title: row.title, kind: row.kind, ext: v.ext, confidential: row.confidential, redactedSample: row.redactedSample, via: "cli" },
  });
  console.log(`added ${row.id} ${row.title}`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // A fixed message on purpose: a driver error's message can echo the
    // insert's parameters, which here include the file's bytes.
    console.error(
      "rfp:library-add failed:",
      err instanceof Error ? err.constructor.name : "unknown error"
    );
    process.exit(1);
  });
