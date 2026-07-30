// Upload inspection for team work submissions (§5.16). Server-side only
// (jszip). Everything runs in memory with hard caps (the governance
// style-sample precedent): archives are parsed and allowlisted text is
// extracted. Upload bytes are never written to disk; the accepted original
// rides the row's archive_data column only until the owner retention email
// sends on publish (notify.ts), then is cleared.
//
// Nested archives (2026-07-30 amendment of the never-open ruling, owner
// directive: a wrapper .zip holding the .skill and its .md must work): for
// kind "skill" ONLY, when the OUTER level fails to resolve a reviewed doc
// and the archive holds EXACTLY ONE inner .skill/.zip at depth <= 1, that
// inner archive is opened one level deep with every guard rerun inside it
// (path normalization, symlink skip, inflate caps, secret scans, a COMBINED
// entry count against zipMaxEntries). Archives inside the inner archive
// stay opaque; at most two zip layers ever parse. The lazy rule (open only
// on outer failure) keeps every previously-accepted bare package accepted
// byte-for-byte. kind "program" never opens nested archives.

import { createHash } from "node:crypto";
import JSZip from "jszip";
import {
  AMBIGUOUS_SKILL_DOC_MESSAGE,
  MISSING_ARCH_DOC_MESSAGE,
  MISSING_SKILL_DOC_MESSAGE,
  SECRETS_DETECTED_MESSAGE,
  SKILL_DOC_TOO_SHORT_MESSAGE,
  WORK_CAPS,
  type WorkKind,
} from "./config";
import { fileNameLooksSecret, textLooksSecret } from "./secret-patterns";

export interface ManifestEntry {
  path: string;
  bytes: number;
}

export interface ExtractOk {
  ok: true;
  /** The reviewed doc's text (capped). Empty string when docMissing is set:
   * the skill kind returns ok-with-docMissing for doc-resolution failures so
   * the route can rescue with a standalone .md; hard failures (secrets,
   * invalid archive, too complex) are still ExtractErr and are NEVER
   * rescued. */
  docText: string;
  docPath: string; // inner-archive docs use "<innerEntry>!/<pathInside>"
  /** Untruncated inflated bytes of the winning doc (retention email must
   * carry the real file, not the 40k text slice). Absent when docMissing. */
  docRawBytes?: Buffer;
  docMissing?: "missing" | "too_short" | "ambiguous";
  candidatePaths?: string[];
  corpus: { path: string; text: string }[]; // doc first when resolved
  manifest: ManifestEntry[];
  manifestTruncated: boolean;
  archiveSha256: string;
  archiveBytes: number;
}

export interface ExtractErr {
  ok: false;
  code:
    | "invalid_archive"
    | "archive_too_complex"
    | "missing_architecture_doc"
    | "missing_skill_doc"
    | "ambiguous_skill_doc"
    | "secrets_detected"
    | "doc_too_short";
  message: string;
  paths?: string[];
}

export type ExtractResult = ExtractOk | ExtractErr;

/** Prose length after stripping fenced code blocks and YAML front matter -
 * the "at least a few paragraphs" floor for the required doc. */
export function proseLength(text: string): number {
  const stripped = text
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length;
}

/** UTF-8 sanity for an uploaded .md: no NULs, low replacement-char density. */
export function decodeUtf8Text(buf: Buffer): string | null {
  if (buf.includes(0)) return null;
  let text = buf.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const bad = (text.match(/�/g) || []).length;
  if (bad > 0 && bad / Math.max(text.length, 1) > 0.001) return null;
  return text;
}

type JsZipStream = {
  on(event: "data", cb: (chunk: Uint8Array) => void): JsZipStream;
  on(event: "error", cb: (err: unknown) => void): JsZipStream;
  on(event: "end", cb: () => void): JsZipStream;
  resume(): JsZipStream;
  pause(): JsZipStream;
};

/** Inflate one zip entry with a hard byte cap (decompression-bomb guard);
 * streams so a lying central directory cannot force an unbounded inflate. */
function inflateCapped(
  entry: JSZip.JSZipObject,
  maxBytes: number
): Promise<{ kind: "ok"; buf: Buffer } | { kind: "too_large" } | { kind: "error" }> {
  return new Promise((resolve) => {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let settled = false;
    const done = (v: { kind: "ok"; buf: Buffer } | { kind: "too_large" } | { kind: "error" }) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    let stream: JsZipStream;
    try {
      stream = (
        entry as unknown as { internalStream(type: "uint8array"): JsZipStream }
      ).internalStream("uint8array");
    } catch {
      done({ kind: "error" });
      return;
    }
    stream
      .on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          try {
            stream.pause();
          } catch {
            // best effort; we stop accumulating either way
          }
          done({ kind: "too_large" });
          return;
        }
        chunks.push(chunk);
      })
      .on("error", () => done({ kind: "error" }))
      .on("end", () => done({ kind: "ok", buf: Buffer.concat(chunks) }))
      .resume();
  });
}

/** Validates the RAW in-archive path (the "!/"-composed display form for
 * inner entries is built after validation and is exempt from these caps). */
function normalizePath(raw: string): string | null {
  const p = raw.replace(/\\/g, "/");
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return null;
  if (p.split("/").some((seg) => seg === "..")) return null;
  if (p.length > 255) return null;
  return p;
}

function isSymlink(entry: JSZip.JSZipObject): boolean {
  const perm = (entry as unknown as { unixPermissions: number | null })
    .unixPermissions;
  return typeof perm === "number" && ((perm >> 12) & 0xf) === 0xa;
}

function depthOf(path: string): number {
  return path.split("/").length - 1;
}

const ARCH_BASENAMES =
  /^(architecture|arch|design|readme-architecture)\.(md|mdx|markdown|txt)$/i;
const ARCH_HEADING = /^#{1,3}\s*(architecture|how it works|design)\b/im;

/** Program rule: a matching basename at depth 0 or 1 (one wrapper folder),
 * else a README.md at depth 0/1 whose text carries an Architecture heading. */
function matchesArchDoc(path: string, text: string): boolean {
  const base = path.split("/").pop() || "";
  if (depthOf(path) > 1) return false;
  if (ARCH_BASENAMES.test(base)) return true;
  if (/^readme\.(md|mdx|markdown)$/i.test(base) && ARCH_HEADING.test(text))
    return true;
  return false;
}

const TEXT_EXT = /\.(md|mdx|markdown|txt)$/i;
const MD_EXT = /\.(md|mdx|markdown)$/i;
const INNER_ARCHIVE_EXT = /\.(skill|zip)$/i;
/** Boilerplate basenames never become the reviewed doc by uniqueness. */
const BOILERPLATE_MD =
  /^(readme|license|licence|changelog|contributing|code_of_conduct)\./i;

interface TextFile {
  path: string; // display path ("!/"-composed for inner entries)
  text: string;
  buf: Buffer;
  size: number;
}

interface WalkState {
  manifest: ManifestEntry[];
  secretPaths: string[];
  texts: TextFile[];
  innerArchives: { path: string; entry: JSZip.JSZipObject; size: number }[];
  entryCount: number;
}

/** One archive level: manifest, secret scan, text extraction. `prefix` is
 * the display prefix for inner entries ("" for the outer level). */
async function walkLevel(
  zip: JSZip,
  prefix: string,
  collectInner: boolean,
  state: WalkState
): Promise<ExtractErr | null> {
  const entries = Object.values(zip.files).filter((e) => !e.dir);
  state.entryCount += entries.length;
  if (state.entryCount > WORK_CAPS.zipMaxEntries)
    return {
      ok: false,
      code: "archive_too_complex",
      message: `The archive must contain between 1 and ${WORK_CAPS.zipMaxEntries} files (files inside a packaged .skill count toward the limit).`,
    };
  const candidates: { path: string; entry: JSZip.JSZipObject; size: number }[] =
    [];
  for (const entry of entries) {
    const rawPath = normalizePath(entry.name);
    if (rawPath === null)
      return {
        ok: false,
        code: "invalid_archive",
        message:
          "The archive contains an unsafe path (absolute or containing '..'). Re-zip the project folder itself and resubmit.",
      };
    if (isSymlink(entry)) continue; // never followed, never listed
    const path = prefix + rawPath;
    const size =
      (entry as unknown as { _data?: { uncompressedSize?: number } })._data
        ?.uncompressedSize ?? 0;
    state.manifest.push({ path, bytes: size });
    const base = rawPath.split("/").pop() || "";
    if (fileNameLooksSecret(base)) state.secretPaths.push(path);
    else if (TEXT_EXT.test(base) && size <= WORK_CAPS.perEntryInflateMaxBytes)
      candidates.push({ path, entry, size });
    else if (
      collectInner &&
      INNER_ARCHIVE_EXT.test(base) &&
      depthOf(rawPath) <= 1
    )
      state.innerArchives.push({ path, entry, size });
  }
  // Inflate candidate text files (capped) and run the content secret scan.
  for (const f of candidates.sort((a, b) => a.size - b.size)) {
    const out = await inflateCapped(f.entry, WORK_CAPS.perEntryInflateMaxBytes);
    if (out.kind !== "ok") continue; // oversized/encrypted/corrupt: skipped
    const text = decodeUtf8Text(out.buf);
    if (text === null) continue;
    if (textLooksSecret(text)) state.secretPaths.push(f.path);
    else state.texts.push({ path: f.path, text, buf: out.buf, size: f.size });
  }
  return null;
}

function secretsErr(paths: string[]): ExtractErr {
  return {
    ok: false,
    code: "secrets_detected",
    message: SECRETS_DETECTED_MESSAGE,
    paths: paths.slice(0, 20),
  };
}

/** Basename relative to its own archive level (after any "!/" prefix). */
function levelPath(path: string): string {
  const bang = path.lastIndexOf("!/");
  return bang === -1 ? path : path.slice(bang + 2);
}

function baseOf(path: string): string {
  return levelPath(path).split("/").pop() || "";
}

/**
 * Inspect an uploaded archive. kind "program": must contain an architecture
 * doc or equivalent (hard 422s, unchanged). kind "skill": resolves the
 * reviewed doc through a strict precedence chain (exact SKILL.md at depth
 * <= 1; else exactly ONE non-boilerplate .md at depth <= 1 clearing the
 * prose floor; else SKILL.md at depth <= 1 inside the single lazily-opened
 * inner archive) and returns ok-with-docMissing instead of a doc-resolution
 * 422, so the route can rescue with the optional standalone .md.
 */
export async function inspectArchive(
  bytes: Buffer,
  kind: WorkKind
): Promise<ExtractResult> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    return {
      ok: false,
      code: "invalid_archive",
      message:
        "That file could not be read as a zip archive. Export a plain .zip (or .skill package) and resubmit.",
    };
  }
  const state: WalkState = {
    manifest: [],
    secretPaths: [],
    texts: [],
    innerArchives: [],
    entryCount: 0,
  };
  const walkErr = await walkLevel(zip, "", kind === "skill", state);
  if (walkErr) return walkErr;
  if (state.entryCount === 0)
    return {
      ok: false,
      code: "archive_too_complex",
      message: `The archive must contain between 1 and ${WORK_CAPS.zipMaxEntries} files (files inside a packaged .skill count toward the limit).`,
    };
  if (state.secretPaths.length > 0) return secretsErr(state.secretPaths);

  const finish = (
    doc: TextFile | null,
    docMissing?: "missing" | "too_short" | "ambiguous",
    candidatePaths?: string[]
  ): ExtractOk => {
    const corpus: { path: string; text: string }[] = [];
    let total = 0;
    let docText = "";
    if (doc) {
      docText = doc.text.slice(0, WORK_CAPS.archDocMaxChars);
      corpus.push({ path: doc.path, text: docText });
      total = docText.length;
    }
    for (const t of state.texts.sort((a, b) => a.size - b.size)) {
      if (doc && t.path === doc.path) continue;
      if (total + t.text.length > WORK_CAPS.corpusTotalMaxChars) continue;
      corpus.push({ path: t.path, text: t.text });
      total += t.text.length;
    }
    return {
      ok: true,
      docText,
      docPath: doc?.path ?? "",
      ...(doc ? { docRawBytes: doc.buf } : {}),
      ...(docMissing ? { docMissing } : {}),
      ...(candidatePaths ? { candidatePaths } : {}),
      corpus,
      manifest: state.manifest.slice(0, WORK_CAPS.manifestMaxEntries),
      manifestTruncated: state.manifest.length > WORK_CAPS.manifestMaxEntries,
      archiveSha256: createHash("sha256").update(bytes).digest("hex"),
      archiveBytes: bytes.length,
    };
  };

  if (kind === "program") {
    const required = state.texts.find((t) => matchesArchDoc(t.path, t.text));
    if (!required)
      return {
        ok: false,
        code: "missing_architecture_doc",
        message: MISSING_ARCH_DOC_MESSAGE,
      };
    if (proseLength(required.text) < WORK_CAPS.archDocMinProseChars)
      return {
        ok: false,
        code: "doc_too_short",
        message: MISSING_ARCH_DOC_MESSAGE,
      };
    return finish(required);
  }

  // ---- kind "skill": precedence chain ----
  const isSkillMd = (t: TextFile) =>
    /^skill\.md$/i.test(baseOf(t.path)) && depthOf(levelPath(t.path)) <= 1;
  let doc: TextFile | null = null;
  let tooShort: TextFile | null = null;
  let ambiguous: string[] | null = null;

  const exact = state.texts.find(isSkillMd);
  if (exact) {
    if (proseLength(exact.text) >= WORK_CAPS.archDocMinProseChars) doc = exact;
    else tooShort = exact;
  } else {
    // Exactly one non-boilerplate .md at depth <= 1 clearing the prose floor
    // (the floor gates candidacy so a stray short NOTES.md cannot dead-end a
    // wrapper whose inner SKILL.md is fine).
    const candidates = state.texts.filter(
      (t) =>
        MD_EXT.test(baseOf(t.path)) &&
        depthOf(t.path) <= 1 &&
        !BOILERPLATE_MD.test(baseOf(t.path)) &&
        proseLength(t.text) >= WORK_CAPS.archDocMinProseChars
    );
    if (candidates.length === 1) doc = candidates[0];
    else if (candidates.length > 1) ambiguous = candidates.map((c) => c.path);
  }

  // Lazy inner-archive open: only when the outer level did not resolve, and
  // only for EXACTLY ONE inner archive (selection ambiguity is a rejection
  // of the shape, not a guess).
  if (!doc && !tooShort && state.innerArchives.length === 1) {
    const inner = state.innerArchives[0];
    if (inner.size <= WORK_CAPS.uploadMaxBytes) {
      const out = await inflateCapped(inner.entry, WORK_CAPS.uploadMaxBytes);
      if (out.kind !== "ok" || !(out.buf[0] === 0x50 && out.buf[1] === 0x4b))
        return {
          ok: false,
          code: "invalid_archive",
          message: `The packaged Skill inside your zip (${inner.path}) could not be read. Re-export it and resubmit, or attach its SKILL.md in the second upload field.`,
        };
      let innerZip: JSZip;
      try {
        innerZip = await JSZip.loadAsync(out.buf);
      } catch {
        return {
          ok: false,
          code: "invalid_archive",
          message: `The packaged Skill inside your zip (${inner.path}) could not be read. Re-export it and resubmit, or attach its SKILL.md in the second upload field.`,
        };
      }
      const innerErr = await walkLevel(
        innerZip,
        `${inner.path}!/`,
        false,
        state
      );
      if (innerErr) return innerErr;
      if (state.secretPaths.length > 0) return secretsErr(state.secretPaths);
      const innerExact = state.texts.find(
        (t) => t.path.startsWith(`${inner.path}!/`) && isSkillMd(t)
      );
      if (innerExact) {
        if (proseLength(innerExact.text) >= WORK_CAPS.archDocMinProseChars)
          doc = innerExact;
        else tooShort = innerExact;
      }
    }
  }

  if (doc) return finish(doc);
  if (tooShort) return finish(null, "too_short", [tooShort.path]);
  if (ambiguous) return finish(null, "ambiguous", ambiguous);
  return finish(null, "missing");
}

/**
 * Corpus for a skill submission with a standalone SKILL.md (§5.16): the
 * standalone .md is the reviewed document (slot 0, its text wins as
 * skillMdText), then the package's text files, skipping byte-identical
 * duplicates of the standalone .md, up to the total cap. Works with a
 * doc-less package result (docMissing rescue). Pure so
 * scripts/work-tests.ts can exercise it.
 */
export function mergeSkillCorpus(
  mdDoc: ExtractOk,
  pkg: ExtractOk
): { path: string; text: string }[] {
  const corpus: { path: string; text: string }[] = [
    { path: mdDoc.docPath, text: mdDoc.docText },
  ];
  let total = mdDoc.docText.length;
  for (const f of pkg.corpus) {
    if (f.text === mdDoc.docText) continue;
    if (total + f.text.length > WORK_CAPS.corpusTotalMaxChars) continue;
    corpus.push(f);
    total += f.text.length;
  }
  return corpus;
}

/** A standalone .md (the Skill's SKILL.md): validated the same way, corpus of one. */
export function inspectBareMd(
  name: string,
  bytes: Buffer
): ExtractResult {
  const text = decodeUtf8Text(bytes);
  if (text === null)
    return {
      ok: false,
      code: "invalid_archive",
      message: "That .md file is not readable UTF-8 text.",
    };
  if (textLooksSecret(text))
    return {
      ok: false,
      code: "secrets_detected",
      message: SECRETS_DETECTED_MESSAGE,
      paths: [name],
    };
  if (proseLength(text) < WORK_CAPS.archDocMinProseChars)
    return {
      ok: false,
      code: "doc_too_short",
      message: SKILL_DOC_TOO_SHORT_MESSAGE,
    };
  const docText = text.slice(0, WORK_CAPS.archDocMaxChars);
  return {
    ok: true,
    docText,
    docPath: name,
    docRawBytes: bytes,
    corpus: [{ path: name, text: docText }],
    manifest: [{ path: name, bytes: bytes.length }],
    manifestTruncated: false,
    archiveSha256: createHash("sha256").update(bytes).digest("hex"),
    archiveBytes: bytes.length,
  };
}

/** The user-facing message for a skill doc-resolution failure. */
export function skillDocFailureMessage(
  docMissing: "missing" | "too_short" | "ambiguous"
): string {
  if (docMissing === "too_short") return SKILL_DOC_TOO_SHORT_MESSAGE;
  if (docMissing === "ambiguous") return AMBIGUOUS_SKILL_DOC_MESSAGE;
  return MISSING_SKILL_DOC_MESSAGE;
}
