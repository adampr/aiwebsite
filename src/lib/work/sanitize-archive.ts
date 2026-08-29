// Rebuilds an uploaded archive without the material the §5.16 intake scan
// found (owner directive 2026-08-29: "if someone submits a zip and it
// contains personal info or credentials, instead of erroring out just clean
// it before you save it").
//
// This module owns ONE step: given the archive the walk already parsed and a
// plan naming what to drop and what to replace, produce the bytes we are
// allowed to keep. It decides nothing about WHAT is sensitive; sanitize.ts
// owns that, and extract.ts owns turning a walk into a plan.
//
// THE PLAN IS KEYED ON RAW ZIP NAMES, never on manifest paths. extract.ts's
// normalizePath rewrites "\" to "/", so a Windows-authored "dir\.env" has the
// manifest path "dir/.env" and the zip key "dir\.env". A plan keyed on the
// display path would miss it and the credential would ride into the stored
// artifact, silently and only for archives authored on Windows. Verified
// against jszip 3.10.1: a backslash name survives load and generate as a
// backslash key.
//
// PASS-THROUGH IS BY REFERENCE, AND THAT IS THE WHOLE MEMORY ARGUMENT.
// Entries we are keeping unchanged are carried into the output JSZip as the
// loaded object itself, so jszip re-emits their ORIGINAL compressed bytes:
// zipObject._compressWorker returns the existing compressed worker whenever
// the requested compression matches the source's, and compressedObject
// passes the original compressedSize/uncompressedSize/crc32 through. Nothing
// a kept entry contains is ever inflated, which is what keeps a 100 MB
// package's rebuild from doing the decompression work the walk's inflate
// budget exists to forbid. Measured on this repo's pinned jszip: an 8.1 MB
// mixed STORE/DEFLATE archive rebuilds in 3 ms with every kept entry's crc32
// and compressed size unchanged.
//
// WHICH MEANS THE PER-ENTRY COMPRESSION PIN IS LOAD-BEARING, NOT TIDINESS.
// jszip's loader sets no per-file compression, so generateAsync's global
// option decides for every carried entry. Measured, same fixture: a global
// DEFLATE inflates and re-deflates the STORE entries (8.12 MB of real
// decompression), and a global STORE inflates every DEFLATE entry and DOUBLED
// the archive, 8.14 MB to 16.24 MB. At the 100 MB upload cap that is a
// multi-hundred-megabyte disk and mail artifact conjured out of a package we
// were only asked to clean. So each carried entry's own options.compression
// is pinned from its source magic and no global compression is passed.

import { createHash } from "node:crypto";
import JSZip from "jszip";

/** Zlib's deflate magic as jszip records it on a loaded entry. */
const DEFLATE_MAGIC = "\x08\x00";

/** Wall-clock ceiling for one rebuild. This runs inside the request that is
 * already holding the whole upload, so a pathological archive must not hold
 * the single fork open indefinitely. A breach FAILS the rebuild rather than
 * falling back to the original bytes: see the caller's containment rule. */
const REBUILD_BUDGET_MS = 20_000;

export interface CleanPlan {
  /** Raw zip keys to omit from the output entirely (the file IS the secret:
   * a .env, a private key, a bundled archive holding either). */
  drop: ReadonlySet<string>;
  /** Raw zip keys to rewrite, with the exact replacement bytes. Produced once
   * by the walk so the stored archive, the corpus and the reviewed document
   * can never disagree about what a redacted file says. */
  redact: ReadonlyMap<string, Buffer>;
}

export type RebuildResult =
  | { ok: true; zip: Buffer; sha256: string; entries: number }
  | { ok: false; reason: string };

interface LoadedInternals {
  _data?: { compression?: { magic?: string } };
  options: { compression?: string | null };
}

/** The source entry's own compression, pinned onto the object we carry so the
 * generate pass re-emits its bytes instead of transcoding them. */
function pinSourceCompression(entry: JSZip.JSZipObject): void {
  const internals = entry as unknown as LoadedInternals;
  const magic = internals._data?.compression?.magic;
  internals.options.compression = magic === DEFLATE_MAGIC ? "DEFLATE" : "STORE";
}

/**
 * Rebuild `src` without the planned entries. Total: never throws, and returns
 * a reason instead of bytes for every failure, because the caller's rule is
 * that a rebuild it cannot trust means NO archive is stored at all. Returning
 * the original here would put the exact bytes we were told to clean into the
 * three places this round exists to keep them out of.
 *
 * The result is self-verified before it is handed back: it must re-parse, it
 * must not contain any dropped name, and it must contain every redacted name.
 * The re-parse is cheap (jszip reads the central directory over buffer views
 * and inflates nothing), which is the only reason it is unconditional.
 */
export async function rebuildWithout(
  src: JSZip,
  plan: CleanPlan,
  opts: { budgetMs?: number; now?: () => number } = {}
): Promise<RebuildResult> {
  const budgetMs = opts.budgetMs ?? REBUILD_BUDGET_MS;
  const now = opts.now ?? Date.now;
  const started = now();
  try {
    const out = new JSZip();
    // The archive-level comment rides along. jszip sets it on load and honours
    // it on generate, but does not declare it on the instance type, so this
    // reads through a cast rather than silently dropping a field the submitter
    // put there.
    const withComment = out as unknown as { comment?: string };
    withComment.comment = (src as unknown as { comment?: string }).comment;
    let kept = 0;
    for (const [name, entry] of Object.entries(src.files)) {
      if (now() - started > budgetMs)
        return { ok: false, reason: "rebuild exceeded its time budget" };
      if (plan.drop.has(name)) continue;
      const replacement = plan.redact.get(name);
      if (replacement !== undefined) {
        out.file(name, replacement, {
          date: entry.date,
          unixPermissions: entry.unixPermissions,
          comment: entry.comment,
          // A replacement has no source bytes to preserve, so it is compressed
          // on its own terms. createFolders stays off for the same reason the
          // carried entries do not need it: the source's own directory
          // entries are carried across verbatim below.
          createFolders: false,
          compression: "DEFLATE",
        });
        if (!entry.dir) kept++;
        continue;
      }
      pinSourceCompression(entry);
      // Reference carry-over. There is no public jszip API for "keep this
      // entry exactly as it came in"; file() re-encodes whatever it is given,
      // and handing it entry.async() would inflate the very bytes this path
      // exists to leave alone. The internal map is the seam, and it is the
      // same private-shape reliance extract.ts and mail-screen.ts already
      // make on _data.uncompressedSize. A test pins it.
      (out as unknown as { files: Record<string, JSZip.JSZipObject> }).files[
        name
      ] = entry;
      if (!entry.dir) kept++;
    }
    // No global `compression`: every carried entry was pinned to its source's
    // and every replacement named its own. Passing one here would override
    // exactly the entries whose bytes we are trying not to touch.
    const zip = await out.generateAsync({ type: "nodebuffer" });

    const verdict = await verifyRebuild(zip, plan, kept);
    if (!verdict.ok) return verdict;
    return {
      ok: true,
      zip,
      sha256: createHash("sha256").update(zip).digest("hex"),
      entries: kept,
    };
  } catch (err) {
    return {
      ok: false,
      reason:
        err instanceof Error ? err.message.slice(0, 200) : "rebuild threw",
    };
  }
}

/** The rebuilt archive must parse, must have lost exactly what was dropped,
 * and must still carry everything that was only rewritten. A rebuild that
 * cannot prove those three things is not storable. */
async function verifyRebuild(
  zip: Buffer,
  plan: CleanPlan,
  expectedFiles: number
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let reloaded: JSZip;
  try {
    reloaded = await JSZip.loadAsync(zip);
  } catch {
    return { ok: false, reason: "rebuilt archive did not parse" };
  }
  for (const dropped of plan.drop)
    if (reloaded.files[dropped] !== undefined)
      return { ok: false, reason: "rebuilt archive still holds a dropped entry" };
  for (const redacted of plan.redact.keys())
    if (reloaded.files[redacted] === undefined)
      return { ok: false, reason: "rebuilt archive lost a redacted entry" };
  const files = Object.values(reloaded.files).filter((e) => !e.dir).length;
  if (files !== expectedFiles)
    return { ok: false, reason: "rebuilt archive has an unexpected entry count" };
  return { ok: true };
}
