// Upload inspection for team work submissions (§5.16). Server-side only
// (jszip). Everything runs in memory with hard caps (the governance
// style-sample precedent): the archive is parsed and allowlisted text is
// extracted. Upload bytes are never written to disk; the accepted original
// rides the row's archive_data column only until the owner retention email
// sends on publish (notify.ts), then is cleared.

import { createHash } from "node:crypto";
import JSZip from "jszip";
import {
  MISSING_ARCH_DOC_MESSAGE,
  MISSING_SKILL_DOC_MESSAGE,
  SECRETS_DETECTED_MESSAGE,
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
  docText: string; // the architecture doc (program) or SKILL.md (skill)
  docPath: string;
  corpus: { path: string; text: string }[]; // docText first, then extras
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

function matchesSkillDoc(path: string): boolean {
  const base = path.split("/").pop() || "";
  return depthOf(path) <= 1 && /^skill\.md$/i.test(base);
}

const TEXT_EXT = /\.(md|mdx|markdown|txt)$/i;

/**
 * Inspect an uploaded archive for kind "program" (Claude Code zip, must
 * contain an architecture doc or equivalent) or kind "skill" (CoWork .skill
 * or zip package, must contain SKILL.md). Returns extracted text only.
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

  const entries = Object.values(zip.files).filter((e) => !e.dir);
  if (entries.length === 0 || entries.length > WORK_CAPS.zipMaxEntries)
    return {
      ok: false,
      code: "archive_too_complex",
      message: `The archive must contain between 1 and ${WORK_CAPS.zipMaxEntries} files.`,
    };

  const manifest: ManifestEntry[] = [];
  const secretPaths: string[] = [];
  const textFiles: { path: string; entry: JSZip.JSZipObject; size: number }[] =
    [];

  for (const entry of entries) {
    const path = normalizePath(entry.name);
    if (path === null)
      return {
        ok: false,
        code: "invalid_archive",
        message:
          "The archive contains an unsafe path (absolute or containing '..'). Re-zip the project folder itself and resubmit.",
      };
    if (isSymlink(entry)) continue; // never followed, never listed as text
    const size =
      (entry as unknown as { _data?: { uncompressedSize?: number } })._data
        ?.uncompressedSize ?? 0;
    manifest.push({ path, bytes: size });
    const base = path.split("/").pop() || "";
    if (fileNameLooksSecret(base)) secretPaths.push(path);
    else if (TEXT_EXT.test(base) && size <= WORK_CAPS.perEntryInflateMaxBytes)
      textFiles.push({ path, entry, size });
  }

  if (secretPaths.length > 0)
    return {
      ok: false,
      code: "secrets_detected",
      message: SECRETS_DETECTED_MESSAGE,
      paths: secretPaths.slice(0, 20),
    };

  // Inflate candidate text files (capped) and run the content secret scan.
  const texts: { path: string; text: string; size: number }[] = [];
  for (const f of textFiles.sort((a, b) => a.size - b.size)) {
    const out = await inflateCapped(f.entry, WORK_CAPS.perEntryInflateMaxBytes);
    if (out.kind !== "ok") continue; // oversized/encrypted/corrupt: skip, it
    // can still appear in the manifest; the required doc is re-checked below.
    const text = decodeUtf8Text(out.buf);
    if (text === null) continue;
    if (textLooksSecret(text)) secretPaths.push(f.path);
    else texts.push({ path: f.path, text, size: f.size });
  }
  if (secretPaths.length > 0)
    return {
      ok: false,
      code: "secrets_detected",
      message: SECRETS_DETECTED_MESSAGE,
      paths: secretPaths.slice(0, 20),
    };

  // Locate the required doc.
  const required =
    kind === "program"
      ? texts.find((t) => matchesArchDoc(t.path, t.text))
      : texts.find((t) => matchesSkillDoc(t.path));
  if (!required)
    return kind === "program"
      ? {
          ok: false,
          code: "missing_architecture_doc",
          message: MISSING_ARCH_DOC_MESSAGE,
        }
      : {
          ok: false,
          code: "missing_skill_doc",
          message: MISSING_SKILL_DOC_MESSAGE,
        };
  if (proseLength(required.text) < WORK_CAPS.archDocMinProseChars)
    return {
      ok: false,
      code: "doc_too_short",
      message:
        kind === "program"
          ? MISSING_ARCH_DOC_MESSAGE
          : MISSING_SKILL_DOC_MESSAGE,
    };

  // Evidence corpus: the required doc in full (capped), then remaining
  // .md/.txt ascending by size until the total cap. Source code never rides.
  const docText = required.text.slice(0, WORK_CAPS.archDocMaxChars);
  const corpus: { path: string; text: string }[] = [
    { path: required.path, text: docText },
  ];
  let total = docText.length;
  for (const t of texts) {
    if (t.path === required.path) continue;
    if (total + t.text.length > WORK_CAPS.corpusTotalMaxChars) continue;
    corpus.push({ path: t.path, text: t.text });
    total += t.text.length;
  }

  const manifestTruncated = manifest.length > WORK_CAPS.manifestMaxEntries;
  return {
    ok: true,
    docText,
    docPath: required.path,
    corpus,
    manifest: manifest.slice(0, WORK_CAPS.manifestMaxEntries),
    manifestTruncated,
    archiveSha256: createHash("sha256").update(bytes).digest("hex"),
    archiveBytes: bytes.length,
  };
}

/**
 * Corpus for a two-file CoWork Skill submission (§5.16): the standalone
 * SKILL.md is the reviewed document (slot 0, its text wins as skillMdText),
 * then the package's text files, skipping byte-identical duplicates of the
 * standalone .md, up to the total cap. Pure so scripts/work-tests.ts can
 * exercise it.
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
      message: MISSING_SKILL_DOC_MESSAGE,
    };
  const docText = text.slice(0, WORK_CAPS.archDocMaxChars);
  return {
    ok: true,
    docText,
    docPath: name,
    corpus: [{ path: name, text: docText }],
    manifest: [{ path: name, bytes: bytes.length }],
    manifestTruncated: false,
    archiveSha256: createHash("sha256").update(bytes).digest("hex"),
    archiveBytes: bytes.length,
  };
}
