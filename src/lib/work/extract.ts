// Upload inspection for team work submissions (§5.16). Server-side only
// (jszip). Everything runs in memory with hard caps (the governance
// style-sample precedent): archives are parsed and allowlisted text is
// extracted. The accepted original is persisted twice at intake: on the
// row (archive_data, cleared after publish only once the second copy is
// verified) and in the on-disk archive store (archive-store.ts, the
// durable copy an admin cleans).
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
//
// Kind inference (owner directive 2026-08-28, "no longer ask if it's CoWork
// or Code program; figure out which is based on what was uploaded"): the
// `kind` argument is nullable now. Null means classify.ts decides from this
// walk; a non-null value PINS the kind and is used only by the update lane,
// where a card's kind belongs to the card. Either way the classifier runs and
// its verdict rides on the result, so a lane that pinned can still see that
// the package disagrees. The full ordering argument, including why the outer
// walk is now unconditionally collectInner and why the inner open must stay
// downstream of the decision, is on inspectArchive itself.

import { createHash } from "node:crypto";
import JSZip from "jszip";
import {
  AMBIGUOUS_SKILL_DOC_MESSAGE,
  BOILERPLATE_MD_BASENAMES,
  MISSING_ARCH_DOC_MESSAGE,
  MISSING_SKILL_DOC_MESSAGE,
  SKILL_DOC_TOO_SHORT_MESSAGE,
  SUPPORT_MD_BASENAMES,
  WORK_CAPS,
  type WorkKind,
} from "./config";
import {
  GUT_RATIO,
  REDACTION_TOKEN_RE,
  fileNameLooksSecret,
  sanitizeText,
  type RedactionClass,
} from "./sanitize";
import { rebuildWithout, type CleanPlan } from "./sanitize-archive";
import { classifyWorkKind, type KindVerdict } from "./classify";

export interface ManifestEntry {
  path: string;
  bytes: number;
}

export interface ExtractOk {
  ok: true;
  /** The kind this inspection RESOLVED ON, and the one to store: the caller's
   * pinned kind when it passed one, else `kindVerdict.kind`. */
  kind: WorkKind;
  /** What the PACKAGE looks like, always computed from the walk even when the
   * caller pinned a kind (§5.16 kind inference, 2026-08-28). The two differ
   * only on the update lane, where the card's kind is pinned and the new
   * package may not match it; every other caller has `kind === kindVerdict.kind`
   * by construction. Kept separate rather than collapsed so a lane that wants
   * to DISCLOSE a disagreement can see one. */
  kindVerdict: KindVerdict;
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
  /** sha256 and length of the bytes the SUBMITTER SENT, always, even when the
   * archive we keep is a cleaned rebuild of them. This is a provenance value:
   * work:import and work:correlate compare it against the submitter's own copy
   * of their own file, so redefining it to describe our rebuild would make the
   * original report as never submitted. What we actually stored is described
   * by `cleaning.archive` below. */
  archiveSha256: string;
  archiveBytes: number;
  /** Present only when the intake scan found something (§5.16 cleaning, owner
   * directive 2026-08-29). Absent on the overwhelming majority of uploads, and
   * absence is what tells a caller to store the submitted bytes untouched. */
  cleaning?: CleaningRecord;
}

/** What was taken out of an upload, and what we are allowed to keep. Never
 * carries a matched value, only paths and rule ids. */
export interface CleaningRecord {
  /** Display paths dropped from the stored archive entirely. */
  droppedPaths: { path: string; reason: string }[];
  /** Display paths whose text was rewritten in place. */
  redactedPaths: string[];
  /** Display paths that left the corpus whole (unterminated key material). */
  excludedPaths: { path: string; reason: string }[];
  /** Distinct rule ids that fired, for disclosure and the issue ledger. */
  rules: { ruleId: string; cls: RedactionClass }[];
  /** The cleaned artifact for this slot (the rebuilt archive, or the rewritten
   * standalone document): the ONLY bytes a caller may persist. Null when the
   * rebuild could not be trusted, which means nothing is stored at all - never
   * a fallback to the submitted bytes, which are the ones we were told to
   * clean. */
  stored: { bytes: Buffer; sha256: string; length: number } | null;
  /** Why `stored` is null. */
  failed?: string;
}

export interface ExtractErr {
  ok: false;
  code:
    | "invalid_archive"
    | "archive_too_complex"
    | "missing_architecture_doc"
    | "missing_skill_doc"
    | "ambiguous_skill_doc"
    | "doc_too_short";
  message: string;
  paths?: string[];
  /** Files the cleaning removed before this refusal was reached. A refusal
   * that says "attach your SKILL.md" is misleading when the package we read
   * was one .env we then dropped, so the lanes lead with what was taken out
   * before they give the instruction. */
  droppedPaths?: string[];
  /** Set on every failure raised AFTER the walk classified the package, so a
   * caller can say WHY it applied the rule that refused (§5.16 kind
   * inference): "this reads as a Code program, because it has a .claude
   * folder, and a program needs an architecture doc". Absent on the failures
   * that precede classification (unreadable zip, empty archive, secrets),
   * where there is nothing to have concluded. */
  kind?: WorkKind;
  kindVerdict?: KindVerdict;
}

export type ExtractResult = ExtractOk | ExtractErr;

/** Prose length after stripping fenced code blocks and YAML front matter -
 * the "at least a few paragraphs" floor for the required doc. */
export function proseLength(text: string): number {
  const stripped = text
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/```[\s\S]*?```/g, "")
    // A redaction is not prose (2026-08-29). Without this a document that was
    // mostly credentials would buy its way over archDocMinProseChars with the
    // placeholders we wrote, and be reviewed as though it said something.
    .replace(REDACTION_TOKEN_RE, "")
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
 * streams so a lying central directory cannot force an unbounded inflate.
 * Exported for mail-screen.ts, whose whole-entry e.async("nodebuffer") had
 * no real-byte cap (its budget counted DECLARED sizes, which a bomb lies
 * about); one streaming implementation, two consumers. */
export function inflateCapped(
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

/** Diagnose bytes that failed to parse as a zip (owner directive 2026-08-05:
 * "zip files should be inspected"). The old gate rejected on the first two
 * bytes not being "PK" BEFORE any parse attempt, which also rejected real
 * zips with prepended data (self-extractors, odd exporters); now the parse
 * is always attempted (JSZip finds the central directory from the END of the
 * buffer, so leading junk is fine) and this message explains what the bytes
 * actually are when it fails. Pure so tests can pin each branch. */
export function nonZipMessage(bytes: Buffer): string {
  if (bytes[0] === 0x1f && bytes[1] === 0x8b)
    return (
      "That package is gzip-compressed (a .tar.gz or .gz file), and only " +
      ".zip (or .skill) packages can be read. Re-export it as a plain .zip " +
      "and resubmit."
    );
  if (bytes.subarray(0, 4).toString("latin1") === "Rar!")
    return (
      "That package is a RAR archive, and only .zip (or .skill) packages " +
      "can be read. Re-export it as a plain .zip and resubmit."
    );
  if (bytes[0] === 0x37 && bytes[1] === 0x7a && bytes[2] === 0xbc && bytes[3] === 0xaf)
    return (
      "That package is a 7-Zip archive, and only .zip (or .skill) packages " +
      "can be read. Re-export it as a plain .zip and resubmit."
    );
  if (bytes[0] === 0x50 && bytes[1] === 0x4b)
    return (
      "That package looks like a zip archive but could not be read; it may " +
      "be truncated, or an encrypted or spanned zip. Re-export a plain " +
      ".zip and resubmit."
    );
  return "That file could not be read as a zip archive. Export a plain .zip (or .skill package) and resubmit.";
}

const TEXT_EXT = /\.(md|mdx|markdown|txt)$/i;
const MD_EXT = /\.(md|mdx|markdown)$/i;
/** Single-file HTML applications (2026-08-31, WORK_CAPS.corpusHtmlMaxFiles).
 * Admitted as corpus TEXT only, through the same TextFile pipeline as
 * TEXT_EXT, and never as a document: matchesArchDoc, the Skill ladder
 * (isSkillMd, MD_EXT) and classify.ts's text reads are all basename/.md
 * tests, so an .html can be evidence and nothing else. */
const HTML_EXT = /\.(html|htm)$/i;
const INNER_ARCHIVE_EXT = /\.(skill|zip)$/i;

/** True for a corpus entry admitted under the HTML rule. Used ONLY to order
 * the corpus (documents first, HTML last) at both assembly sites, finish()
 * and mergeSkillCorpus(); a path test, so the merge helper can apply it to
 * an already-built corpus. Exported for scripts/work-tests.ts. */
export function isCorpusHtml(path: string): boolean {
  return HTML_EXT.test(baseOf(path));
}
// Basename tiers live in config.ts (2026-08-05) so the email attachment
// picker applies the same lists: BOILERPLATE never qualifies, SUPPORT is
// demoted only when a better candidate exists.
const BOILERPLATE_MD = BOILERPLATE_MD_BASENAMES;

/** A leading YAML front-matter block declaring `name:` and `description:` at
 * column 0 is the Claude Skill document signature. Used as the LAST
 * deterministic tiebreak when several .md files could be the reviewed doc:
 * exactly one carrying the signature wins; zero or several stays ambiguous.
 * Anchored the same way as email-parse.ts docDeclaredNames (a nested
 * "author:\n  name: ..." never matches). */
export function hasSkillFrontmatter(text: string): boolean {
  if (!/^---\r?\n/.test(text)) return false;
  const rest = text.slice(text.indexOf("\n") + 1);
  const end = rest.search(/^---\s*$/m);
  const front = end === -1 ? rest.slice(0, 4000) : rest.slice(0, end);
  return /^name:[ \t]*\S/m.test(front) && /^description:[ \t]*\S/m.test(front);
}

interface TextFile {
  path: string; // display path ("!/"-composed for inner entries)
  text: string;
  /** The bytes of `text`, and they MUST follow it. This buffer becomes
   * ExtractOk.docRawBytes, which the routes write into the md_* columns and
   * the retention email attaches as its own file. A cleaner that updated
   * `text` and left `buf` alone would leave the corpus clean and mail the
   * original credential out of the building. */
  buf: Buffer;
  size: number;
  /** Characters replaced by placeholders, for the gut guard in finish(). */
  redactedChars: number;
  /** Length of the text BEFORE redaction. The gut guard is a fraction OF THE
   * ORIGINAL FILE, so it needs the original denominator: dividing by the
   * cleaned length instead compares removed characters against a string that
   * has had them removed and the placeholders added back, which is a ratio
   * that can exceed 1 and does not mean what the threshold says. */
  originalChars: number;
  /** True when this text came from INSIDE a lazily-opened inner archive.
   * Recorded at walk time rather than recovered by looking for "!/" in the
   * path: normalizePath accepts a directory segment ending in "!", so a real
   * outer entry can legitimately be "Project!/architecture.md" and a string
   * test would exclude a document the program lane must see. */
  inner: boolean;
}

interface WalkState {
  manifest: ManifestEntry[];
  /** Entries to omit from the rebuilt archive, keyed by RAW zip name.
   *
   * Raw, never the display path: normalizePath rewrites "\" to "/", so a
   * Windows-authored "dir\.env" has the manifest path "dir/.env" and the zip
   * key "dir\.env". A plan keyed on the display path would miss it, and the
   * credential would ride into the stored archive silently and only for
   * archives authored on Windows. Verified against the pinned jszip: a
   * backslash name survives load and generate as a backslash key. */
  drop: Map<string, { path: string; reason: string }>;
  /** Replacement bytes for entries whose text was rewritten, keyed the same
   * way. Produced once, at the moment of detection, so the stored archive, the
   * corpus and the reviewed document can never disagree about what a redacted
   * file says. */
  redact: Map<string, Buffer>;
  redactedPaths: string[];
  excludedPaths: { path: string; reason: string }[];
  rules: Map<string, RedactionClass>;
  texts: TextFile[];
  innerArchives: { path: string; entry: JSZip.JSZipObject; size: number }[];
  entryCount: number;
  /** Inflated text bytes so far, across levels (corpusInflateTotalMaxBytes). */
  inflatedBytes: number;
  /** HTML entries admitted as text candidates so far, in WALK order (the
   * central-directory order of the outer archive), against
   * WORK_CAPS.corpusHtmlMaxFiles. Counted at CANDIDACY so that at most N HTML
   * entries are ever inflated: an entry that later fails to decode, or falls
   * past the total inflate budget, still burns its slot. Deterministic and
   * bounded, which is the property wanted; "the first N that decode" would
   * cost an unbounded number of inflates on a hostile package. */
  htmlCandidates: number;
}

/** One archive level: manifest, secret scan, text extraction. `prefix` is
 * the display prefix for inner entries ("" for the outer level). */
async function walkLevel(
  zip: JSZip,
  prefix: string,
  collectInner: boolean,
  state: WalkState,
  /** Set only when walking INSIDE a lazily-opened inner archive: the outer
   * entry that contains this level. A hit found in here cannot be patched in
   * place, because rewriting an inner archive and re-embedding it would be the
   * first code in this pipeline to treat a nested archive as writable, and it
   * would cost a second full rebuild inside the one we are already doing. The
   * whole inner archive is dropped from the outer instead. */
  owner: { rawName: string; path: string } | null = null
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
    if (fileNameLooksSecret(base)) {
      // The file IS the secret: there is no content-minus-the-secret, so it is
      // never inflated, never decoded, never in the corpus, and since this
      // round it leaves the stored archive instead of refusing the upload.
      const target = owner ?? { rawName: entry.name, path };
      state.drop.set(target.rawName, {
        path: target.path,
        reason: owner
          ? "bundled archive held a credential file"
          : "filename marks it as key material",
      });
    } else if (TEXT_EXT.test(base) && size <= WORK_CAPS.perEntryInflateMaxBytes)
      candidates.push({ path, entry, size });
    else if (
      // Single-file HTML app rule (WORK_CAPS.corpusHtmlMaxFiles): outer level
      // only (`prefix === ""` is the same fact TextFile.inner records), display
      // depth <= 1 (identical to the display path here because the prefix is
      // empty), the per-entry inflate cap, and the per-package count. It joins
      // `candidates`, not a parallel list, so the ascending-size inflate loop
      // below, the sanitize step, the gut guard and both budgets apply to it
      // byte for byte as they do to a .md.
      HTML_EXT.test(base) &&
      prefix === "" &&
      depthOf(rawPath) <= 1 &&
      size <= WORK_CAPS.perEntryInflateMaxBytes &&
      state.htmlCandidates < WORK_CAPS.corpusHtmlMaxFiles
    ) {
      state.htmlCandidates++;
      candidates.push({ path, entry, size });
    } else if (
      collectInner &&
      INNER_ARCHIVE_EXT.test(base) &&
      depthOf(rawPath) <= 1
    )
      state.innerArchives.push({ path, entry, size });
  }
  // Inflate candidate text files (capped) and run the content secret scan.
  // The TOTAL budget (corpusInflateTotalMaxBytes) bounds the walk at 20k
  // entries: candidates go smallest-first, so the reviewed doc and the
  // corpus (both made of small files) resolve inside the budget, and text
  // past it is skipped exactly like an oversized entry is today (no corpus,
  // no content scan; the filename scan above still covered every entry).
  for (const f of candidates.sort((a, b) => a.size - b.size)) {
    if (state.inflatedBytes + f.size > WORK_CAPS.corpusInflateTotalMaxBytes)
      break; // ascending sizes: everything after is at least as large
    const out = await inflateCapped(f.entry, WORK_CAPS.perEntryInflateMaxBytes);
    if (out.kind !== "ok") continue; // oversized/encrypted/corrupt: skipped
    state.inflatedBytes += out.buf.length;
    const text = decodeUtf8Text(out.buf);
    if (text === null) continue;
    // The ONE detector, and it is the same call that does the removing.
    const clean = sanitizeText(text);
    for (const hit of clean.hits) state.rules.set(hit.ruleId, hit.cls);
    if (clean.excludeFile) {
      // Key material we could not span (a BEGIN header with no END inside the
      // block bound). Leaving it in the corpus because a marker was missing is
      // the one outcome this is all here to prevent, so the file leaves whole.
      state.excludedPaths.push({ path: f.path, reason: clean.excludeFile });
      const target = owner ?? { rawName: f.entry.name, path: f.path };
      state.drop.set(target.rawName, {
        path: target.path,
        reason: owner
          ? "bundled archive held unterminated key material"
          : "unterminated key material",
      });
      continue;
    }
    if (clean.changed) {
      if (owner) {
        // NOT redactedPaths. The containing archive is leaving whole, and the
        // retention mail prints a redacted path as "kept, with the matching
        // spans replaced" - which would be a false statement about a file that
        // was removed. The drop below is the honest record of what happened.
        state.drop.set(owner.rawName, {
          path: owner.path,
          reason: "bundled archive held credential material",
        });
      } else {
        state.redactedPaths.push(f.path);
        state.redact.set(f.entry.name, Buffer.from(clean.text, "utf8"));
      }
    }
    state.texts.push({
      path: f.path,
      text: clean.text,
      // Follows the text, always. See TextFile.buf.
      buf: clean.changed ? Buffer.from(clean.text, "utf8") : out.buf,
      // The DECLARED size: ordering and every budget must stay independent of
      // what redaction did, or two identical uploads could walk differently.
      size: f.size,
      redactedChars: clean.redactedChars,
      originalChars: text.length,
      inner: prefix !== "",
    });
  }
  return null;
}

/** The paths a REFUSAL should lead with. A submission whose package was one
 * .env would otherwise be told to attach the SKILL.md it never had, with no
 * mention of the file we took out, which is an accurate mechanism attached to
 * the wrong instruction.
 *
 * REDACTED AND EXCLUDED PATHS COUNT, not only dropped ones. Reading
 * `state.drop` alone meant a package whose only finding was a credential
 * REWRITTEN inside a document, which then failed for some other reason, told
 * the submitter nothing at all: no mention that we had touched their files and
 * no instruction to rotate. The refusal is the last thing that lane says, so
 * it is the last chance to say it. */
function droppedForRefusal(state: WalkState): { droppedPaths?: string[] } {
  const paths = [
    ...[...state.drop.values()].map((d) => d.path),
    ...state.excludedPaths.map((e) => e.path),
    ...state.redactedPaths,
  ];
  if (paths.length === 0) return {};
  return { droppedPaths: [...new Set(paths)].slice(0, 20) };
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
 *
 * `kind` is now NULLABLE (§5.16 kind inference, owner directive 2026-08-28:
 * stop asking which one it is and read the package). Pass a kind to PIN one -
 * the update lane does, because a card's kind is fixed by the card, not by
 * whatever the replacement package happens to look like - and pass null to
 * have classify.ts decide from the walk. Either way the classifier runs and
 * its verdict rides on the result, so a pinned lane can still see, and
 * disclose, that the package disagrees with the pin.
 *
 * THE ORDERING CONSTRAINT, and why the walk is unconditional now:
 * `collectInner` used to be `kind === "skill"`, which cannot survive kind
 * becoming an OUTPUT of the walk. It is now always true, and that is inert
 * rather than merely acceptable: collecting an inner archive is a push of
 * {path, entry, size} with no inflate and no parse, and the classification
 * chain in walkLevel is an `else if` whose earlier arms (secret filenames,
 * then TEXT_EXT candidates, then the HTML_EXT corpus arm) are disjoint from
 * INNER_ARCHIVE_EXT, so turning the last arm on cannot take an entry away
 * from any of them. manifest,
 * entryCount, texts, secretPaths and inflatedBytes are byte-identical under
 * both flags; the only delta is a populated innerArchives, which no program
 * path reads. The archive is still walked EXACTLY ONCE, which matters
 * because WalkState's budgets (zipMaxEntries, corpusInflateTotalMaxBytes)
 * accumulate across levels and a second pass would double-count them.
 *
 * The lazy inner OPEN stays strictly downstream of the decision. It inflates
 * up to 100 MB, runs a second JSZip parse, and mutates the shared state
 * (manifest rows, entry count, inflate budget, and possibly a secret hit that
 * hard-fails). Classification may read the name, count and declared size of
 * inner archives - all free, from the central directory - and never their
 * contents, so no package pays for an inflate that the decision itself was
 * supposed to authorize.
 */
export async function inspectArchive(
  bytes: Buffer,
  kind: WorkKind | null,
  opts: { packageName?: string | null } = {}
): Promise<ExtractResult> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    return {
      ok: false,
      code: "invalid_archive",
      message: nonZipMessage(bytes),
    };
  }
  const state: WalkState = {
    manifest: [],
    drop: new Map(),
    redact: new Map(),
    redactedPaths: [],
    excludedPaths: [],
    rules: new Map(),
    texts: [],
    innerArchives: [],
    entryCount: 0,
    inflatedBytes: 0,
    htmlCandidates: 0,
  };
  const walkErr = await walkLevel(zip, "", true, state);
  if (walkErr) return walkErr;
  if (state.entryCount === 0)
    return {
      ok: false,
      code: "archive_too_complex",
      message: `The archive must contain between 1 and ${WORK_CAPS.zipMaxEntries} files (files inside a packaged .skill count toward the limit).`,
    };
  // ---- classify (§5.16 kind inference) ----
  // Runs on the OUTER level only: state holds nothing else yet, because the
  // inner open below is gated on the decision this makes. Every later return
  // carries the verdict so a refusal can explain the rule it applied.
  const kindVerdict = classifyWorkKind({
    // "" and not null: null is classify.ts's "there is no package at all",
    // the bare-.md lane, and that lane never reaches inspectArchive (it goes
    // through inspectBareMd). A caller that did not name its upload has a
    // package whose NAME is unknown, which is a different fact, and an empty
    // string is the one that falls through the extension rung instead of
    // short-circuiting the whole ladder to "skill".
    packageName: opts.packageName ?? "",
    paths: state.manifest.map((m) => m.path),
    innerArchivePaths: state.innerArchives.map((a) => a.path),
    // Any HTML texts admitted by the corpus rule ride along unfiltered and
    // are inert here: classify.ts reads a text only for MD_EXT paths at the
    // package root (its skill_document rung), and every path-based rung saw
    // .html in `paths` before this round exactly as it does now. Not filtered
    // on purpose: work:reclassify rebuilds `texts` from corpus_files_json,
    // which now carries the HTML too, and the ladder must answer the same
    // either way.
    texts: state.texts.map((t) => ({ path: t.path, text: t.text })),
  });
  const resolved: WorkKind = kind ?? kindVerdict.kind;

  const finish = async (
    doc: TextFile | null,
    docMissing?: "missing" | "too_short" | "ambiguous",
    candidatePaths?: string[]
  ): Promise<ExtractOk> => {
    const corpus: { path: string; text: string }[] = [];
    let total = 0;
    let docText = "";
    if (doc) {
      docText = doc.text.slice(0, WORK_CAPS.archDocMaxChars);
      corpus.push({ path: doc.path, text: docText });
      total = docText.length;
    }
    // A COPY, never state.texts itself: Array.prototype.sort mutates, and
    // both doc ladders resolve by `.find()` over the array in WALK order
    // (outer level before inner, ascending declared size within a level).
    // While finish() was the last thing to touch texts that was invisible;
    // now the classifier reads the array too, and a sort that reordered it
    // under a later reader would make the reviewed doc depend on which
    // caller ran first.
    //
    // ORDER: documents (.md/.txt) ascending by size, then HTML ascending by
    // size, LAST. Under corpusTotalMaxChars an HTML app can therefore never
    // displace a document; it only ever uses what the documents left. The
    // budget check below is a `continue`, not a break, so a small HTML still
    // enters after a large one was skipped. Same order in mergeSkillCorpus.
    const ordered = [...state.texts].sort(
      (a, b) =>
        Number(isCorpusHtml(a.path)) - Number(isCorpusHtml(b.path)) ||
        a.size - b.size
    );
    for (const t of ordered) {
      if (doc && t.path === doc.path) continue;
      // The gut guard: a supporting file that is now mostly placeholders is
      // not evidence, and handing the panel four kilobytes of redaction tokens
      // is worse than handing it nothing. The reviewed doc is never dropped
      // here - if IT was gutted, proseLength has already pushed it under the
      // prose floor and it refuses through doc_too_short, which is the honest
      // failure and the one that tells the submitter to expand it.
      if (t.redactedChars / Math.max(t.originalChars, 1) > GUT_RATIO) continue;
      if (total + t.text.length > WORK_CAPS.corpusTotalMaxChars) continue;
      corpus.push({ path: t.path, text: t.text });
      total += t.text.length;
    }
    // The manifest describes THE STORED ARTIFACT: it is rendered into the
    // panel's file listing and re-read by work:reclassify, so it must not name
    // a file the archive no longer holds. What was removed is recorded in the
    // cleaning record instead, which is where an audit belongs.
    const droppedDisplay = [...state.drop.values()].map((d) => d.path);
    const manifest =
      droppedDisplay.length === 0
        ? state.manifest
        : state.manifest.filter(
            (m) =>
              !droppedDisplay.some(
                (d) => m.path === d || m.path.startsWith(`${d}!/`)
              )
          );
    return {
      ok: true,
      kind: resolved,
      kindVerdict,
      docText,
      docPath: doc?.path ?? "",
      ...(doc ? { docRawBytes: doc.buf } : {}),
      ...(docMissing ? { docMissing } : {}),
      ...(candidatePaths ? { candidatePaths } : {}),
      corpus,
      manifest: manifest.slice(0, WORK_CAPS.manifestMaxEntries),
      manifestTruncated: manifest.length > WORK_CAPS.manifestMaxEntries,
      archiveSha256: createHash("sha256").update(bytes).digest("hex"),
      archiveBytes: bytes.length,
      ...(await cleaningRecord()),
    };
  };

  /** Rebuild the archive without what the walk found, or report that we could
   * not. Returns an empty object on the common path so an untouched upload's
   * result is shaped exactly as it was before this round. */
  const cleaningRecord = async (): Promise<{ cleaning?: CleaningRecord }> => {
    if (state.drop.size === 0 && state.redact.size === 0) return {};
    const plan: CleanPlan = {
      drop: new Set(state.drop.keys()),
      redact: state.redact,
    };
    const rebuilt = await rebuildWithout(zip, plan);
    const shared = {
      droppedPaths: [...state.drop.values()],
      redactedPaths: state.redactedPaths,
      excludedPaths: state.excludedPaths,
      rules: [...state.rules].map(([ruleId, cls]) => ({ ruleId, cls })),
    };
    return {
      cleaning: rebuilt.ok
        ? {
            ...shared,
            stored: {
              bytes: rebuilt.zip,
              sha256: rebuilt.sha256,
              length: rebuilt.zip.length,
            },
          }
        : { ...shared, stored: null, failed: rebuilt.reason },
    };
  };

  if (resolved === "program") {
    // Outer level only. matchesArchDoc measures depth on the DISPLAY path, so
    // "wrapper.skill!/architecture.md" splits into two segments and would
    // pass its depth <= 1 gate. That is unreachable today because the inner
    // open is skill-only and runs below this branch, but the guard states the
    // invariant rather than relying on the reader to rediscover it: a Code
    // program's required document is a file in the program, never one found
    // inside a packaged Skill it happens to carry.
    const required = state.texts.find(
      (t) => !t.inner && matchesArchDoc(t.path, t.text)
    );
    if (!required)
      return {
        ok: false,
        code: "missing_architecture_doc",
        message: MISSING_ARCH_DOC_MESSAGE,
        kind: resolved,
        kindVerdict,
        ...droppedForRefusal(state),
      };
    if (proseLength(required.text) < WORK_CAPS.archDocMinProseChars)
      return {
        ok: false,
        code: "doc_too_short",
        message: MISSING_ARCH_DOC_MESSAGE,
        kind: resolved,
        kindVerdict,
        ...droppedForRefusal(state),
      };
    return finish(required);
  }

  // ---- resolved "skill": precedence chain ----
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
    const qualifying = state.texts.filter(
      (t) =>
        MD_EXT.test(baseOf(t.path)) &&
        depthOf(t.path) <= 1 &&
        !BOILERPLATE_MD.test(baseOf(t.path)) &&
        proseLength(t.text) >= WORK_CAPS.archDocMinProseChars
    );
    // The 2026-08-05 wideners (demote supporting names, then break a tie on
    // the front-matter signature) turn outer sets that used to be AMBIGUOUS
    // into a resolved doc. They are switched off when the package holds a
    // single inner archive, because an outer ambiguity is exactly what hands
    // the decision to the inner .skill below: widening here would resolve to
    // an outer guess, skip the inner open, and leave the package's REAL
    // SKILL.md out of the reviewed doc AND out of the evidence corpus. With
    // the gate, no shape that reached the inner archive before this round
    // stops reaching it, and the wideners still cover the flat packages they
    // were added for.
    const widenable = state.innerArchives.length !== 1;
    const preferred = qualifying.filter(
      (t) => !SUPPORT_MD_BASENAMES.test(baseOf(t.path))
    );
    // Demote (never exclude): set the supporting names aside only when a
    // better candidate exists, so an architecture-doc-only package keeps
    // resolving exactly as it did before.
    const candidates =
      widenable && preferred.length > 0 ? preferred : qualifying;
    if (candidates.length === 1) doc = candidates[0];
    else if (candidates.length > 1) {
      const signed = widenable
        ? candidates.filter((c) => hasSkillFrontmatter(c.text))
        : [];
      if (signed.length === 1) doc = signed[0];
      else ambiguous = candidates.map((c) => c.path);
    }
  }

  // Lazy inner-archive open: only when the outer level did not resolve, and
  // only for EXACTLY ONE inner archive (selection ambiguity is a rejection
  // of the shape, not a guess).
  if (!doc && !tooShort && state.innerArchives.length === 1) {
    const inner = state.innerArchives[0];
    if (inner.size <= WORK_CAPS.uploadMaxBytes) {
      // No magic-byte pregate (2026-08-05, same ruling as the outer level):
      // the parse itself decides whether the inner package reads as a zip.
      const out = await inflateCapped(inner.entry, WORK_CAPS.uploadMaxBytes);
      if (out.kind !== "ok")
        return {
          ok: false,
          code: "invalid_archive",
          message: `The packaged Skill inside your zip (${inner.path}) could not be read. Re-export it and resubmit, or attach its SKILL.md in the second upload field.`,
          kind: resolved,
          kindVerdict,
        };
      let innerZip: JSZip;
      try {
        innerZip = await JSZip.loadAsync(out.buf);
      } catch {
        return {
          ok: false,
          code: "invalid_archive",
          message: `The packaged Skill inside your zip (${inner.path}) could not be read. Re-export it and resubmit, or attach its SKILL.md in the second upload field.`,
          kind: resolved,
          kindVerdict,
        };
      }
      const innerErr = await walkLevel(
        innerZip,
        `${inner.path}!/`,
        false,
        state,
        { rawName: inner.entry.name, path: inner.path }
      );
      if (innerErr) return innerErr;
      if (state.drop.has(inner.entry.name)) {
        // The bundled archive is leaving the stored package whole, so nothing
        // read out of it may be reviewed or cited: a card drafted from a
        // document that is not in the retained artifact has no evidence behind
        // it. Dropping its texts here puts the submission back on the
        // doc-missing path, which the standalone .md field already rescues.
        state.texts = state.texts.filter(
          (t) => !t.path.startsWith(`${inner.path}!/`)
        );
      }
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
  // Documents before HTML, the same order finish() produced (pkg.corpus
  // already has it; the stable sort states the rule here too rather than
  // relying on the producer), so under corpusTotalMaxChars an HTML app can
  // never displace a document at this assembly site either.
  const ordered = [...pkg.corpus].sort(
    (a, b) => Number(isCorpusHtml(a.path)) - Number(isCorpusHtml(b.path))
  );
  for (const f of ordered) {
    if (f.text === mdDoc.docText) continue;
    if (total + f.text.length > WORK_CAPS.corpusTotalMaxChars) continue;
    corpus.push(f);
    total += f.text.length;
  }
  return corpus;
}

/** The verdict every bare-.md submission carries. Computed once through the
 * real ladder, not hand-written, so it cannot drift from classify.ts. */
const BARE_DOC_VERDICT: KindVerdict = classifyWorkKind({
  packageName: null,
  paths: [],
  innerArchivePaths: [],
  texts: [],
});

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
  // Cleaned, not refused, exactly like the package (2026-08-29). One intake,
  // one policy: this file is stored and mailed on the same path the package
  // is, so refusing it would protect nothing the package lane already gives
  // up. An unterminated private key is the one case with no span to patch, so
  // that document leaves rather than being stored with key material in it.
  const clean = sanitizeText(text);
  if (clean.excludeFile)
    return {
      ok: false,
      code: "invalid_archive",
      message:
        "That document carries what looks like the start of a private key with no end marker, so I could not clean it without leaving key material behind. Remove the key block and resend, and rotate that key: it left your machine when you sent it.",
      paths: [name],
    };
  const cleanedText = clean.text;
  const cleanedBytes = clean.changed ? Buffer.from(cleanedText, "utf8") : bytes;
  // The floor now runs against the CLEANED text, and proseLength does not
  // count placeholders, so a document that was mostly credentials falls out
  // here as too short. That is the honest refusal: it was always subject to
  // this floor, and the instruction it gives ("expand it") is the right one.
  if (proseLength(cleanedText) < WORK_CAPS.archDocMinProseChars)
    return {
      ok: false,
      code: "doc_too_short",
      message: SKILL_DOC_TOO_SHORT_MESSAGE,
      ...(clean.changed ? { droppedPaths: [name] } : {}),
    };
  const docText = cleanedText.slice(0, WORK_CAPS.archDocMaxChars);
  const cleaning: CleaningRecord | null = clean.changed
    ? {
        droppedPaths: [],
        redactedPaths: [name],
        excludedPaths: [],
        rules: [...new Map(clean.hits.map((h) => [h.ruleId, h.cls]))].map(
          ([ruleId, cls]) => ({ ruleId, cls })
        ),
        stored: {
          bytes: cleanedBytes,
          sha256: createHash("sha256").update(cleanedBytes).digest("hex"),
          length: cleanedBytes.length,
        },
      }
    : null;
  return {
    ok: true,
    // A submission that is one document and no package is a Skill by
    // definition: a Code program is always a package. classify.ts owns that
    // sentence (its `bare_document` rung) rather than a literal here, so the
    // one ladder answers for every lane.
    kind: BARE_DOC_VERDICT.kind,
    kindVerdict: BARE_DOC_VERDICT,
    docText,
    docPath: name,
    // The CLEANED bytes, and this line is the whole reason TextFile.buf exists
    // in the package lane too: docRawBytes is what the routes write into
    // md_data and what the retention email attaches as its own file. Leaving
    // the submitted buffer here would keep the corpus clean and mail the
    // credential out of the building.
    docRawBytes: cleanedBytes,
    corpus: [{ path: name, text: docText }],
    manifest: [{ path: name, bytes: cleanedBytes.length }],
    manifestTruncated: false,
    // The SUBMITTED hash and length, same provenance rule as the package lane:
    // work:import gates a recovered copy of the submitter's own file on this
    // value, so it has to describe what they sent. What we stored is in
    // `cleaning.stored`.
    archiveSha256: createHash("sha256").update(bytes).digest("hex"),
    archiveBytes: bytes.length,
    ...(cleaning ? { cleaning } : {}),
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
