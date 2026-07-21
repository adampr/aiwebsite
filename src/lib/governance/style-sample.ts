// Sample-policy upload: text extraction + normalization (§5.12). The user
// uploads an existing company policy so drafts can mirror its formatting
// conventions. Only extracted plain text is ever stored (never the file),
// it rides the project row, and it deletes with the row.
//
// Server-side only (jszip import); the client never parses the file.
//
// Everything here runs synchronously on the request path over content an
// attacker fully controls, so every pass over the XML must be LINEAR: the
// scanners below use indexOf walks, fixed-string splits, and bounded-
// quantifier regexes only. A quadratic corner (e.g. /<[^>]+>/ over "<a<a<a")
// wedged the event loop for minutes per 0.5 KB upload in review testing.

import JSZip from "jszip";
import {
  CAPS,
  STYLE_SAMPLE_EXTENSIONS,
  STYLE_SAMPLE_TYPES_COPY,
} from "./config";
import {
  buildNumberingModel,
  createCounters,
  numberingLabel,
  resolveParagraphNumbering,
  type NumberingModel,
  type NumberingLabel,
  type NumCounters,
} from "./docx-numbering";
import {
  detectPdfFrame,
  headerFooterXmlToText,
  isFrameLine,
  parseHeaderFooterRels,
  pickFrameParts,
  sampleTitleFromText,
  shapeFrameLines,
  type SampleFrame,
} from "./letterhead";

export type ExtractResult =
  | { ok: true; text: string; frame: SampleFrame }
  | { ok: false; message: string };

const NO_FRAME: SampleFrame = { header: null, footer: null };

const UNREADABLE = `No usable text was found in that file. Check that it is a valid ${STYLE_SAMPLE_TYPES_COPY} with at least a paragraph or two, and try again.`;

const PDF_NO_TEXT =
  "That PDF has no selectable text (it may be a scan). Export a text-based copy, or save it as .docx, and try again.";

const PDF_TIMEOUT =
  "That PDF took too long to read. Export a shorter copy (a few representative pages are plenty), or save it as .docx, and try again.";

const TOO_LARGE =
  "That .docx is too large to read. Export a shorter copy; a few representative pages are plenty.";

// Hard ceiling on inflated document.xml bytes: real policy documents are far
// smaller, and a crafted deflate stream can expand ~1000x (400 KB upload ->
// ~400 MB) if inflation is unbounded.
const MAX_DOCX_XML_BYTES = 5_000_000;

// numbering.xml / styles.xml ceilings (round 15d): template-heavy docs run
// ~100-500 KB; 2 MB is generous and still bomb-proof. Overflow or absence
// only disables numbering enrichment, never the upload.
const MAX_DOCX_AUX_XML_BYTES = 2_000_000;

// Stop accumulating extracted text well past the stored cap; keeps the
// structure pass from grinding through megabytes it will never use.
const EXTRACT_STOP_CHARS = 60_000;

/** Decode the five XML entities plus numeric references. Quantifiers are
 * bounded so a hostile entity run cannot trigger quadratic rescans. */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]{1,6});/g, (_, h: string) =>
      String.fromCodePoint(parseInt(h, 16))
    )
    .replace(/&#(\d{1,7});/g, (_, d: string) => {
      const n = parseInt(d, 10);
      return n <= 0x10ffff ? String.fromCodePoint(n) : "";
    })
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Linear single-pass tag stripper: keeps text, turns w:tab/w:br into
 * whitespace structure, drops everything else. An unterminated tag drops
 * the remainder (malformed input, nothing legitimate to salvage). */
function stripRuns(chunk: string): string {
  const parts: string[] = [];
  let i = 0;
  while (i < chunk.length) {
    const lt = chunk.indexOf("<", i);
    if (lt === -1) {
      parts.push(chunk.slice(i));
      break;
    }
    parts.push(chunk.slice(i, lt));
    const gt = chunk.indexOf(">", lt + 1);
    if (gt === -1) break;
    const tag = chunk.slice(lt + 1, Math.min(gt, lt + 8));
    if (tag.startsWith("w:tab")) parts.push("\t");
    else if (tag.startsWith("w:br")) parts.push("\n");
    i = gt + 1;
  }
  return decodeXmlEntities(parts.join(""));
}

/** First w:val="..." after `marker` inside the paragraph-properties region
 * of the chunk, via bounded indexOf walks (no regex over the full chunk). */
function propVal(chunk: string, marker: string): string | null {
  const end = chunk.indexOf("</w:pPr>");
  const region = chunk.slice(0, end === -1 ? Math.min(chunk.length, 2000) : end);
  const at = region.indexOf(marker);
  if (at === -1) return null;
  const near = region.slice(at, at + 200);
  const v = near.indexOf('w:val="');
  if (v === -1) return "";
  const close = near.indexOf('"', v + 7);
  return close === -1 ? "" : near.slice(v + 7, close);
}

/** Direct numbering reference from a paragraph's OWN pPr, bounded to its
 * numPr element (never propVal: its whole-region scan could grab an
 * unrelated w:val) and CUT at any w:pPrChange marker: tracked-change
 * paragraphs nest their PREVIOUS properties inside pPr, and reading a
 * stale numPr there would advance live counters and shift every later
 * number in the document (round 15d critic amendment). */
function numPrRef(
  chunk: string
): { numId: string | null; ilvl: number | null } | null {
  const end = chunk.indexOf("</w:pPr>");
  let region = chunk.slice(0, end === -1 ? Math.min(chunk.length, 2000) : end);
  const pc = region.indexOf("<w:pPrChange");
  if (pc !== -1) region = region.slice(0, pc);
  const np = region.indexOf("<w:numPr");
  if (np === -1) return null;
  const b = region.charAt(np + 8);
  if (b !== ">" && b !== " " && b !== "/" && b !== "\t" && b !== "\n") return null;
  let npEnd = region.indexOf("</w:numPr>", np);
  if (npEnd === -1) npEnd = Math.min(region.length, np + 300);
  const npRegion = region.slice(np, npEnd);
  const read = (marker: string): string | null => {
    const at = npRegion.indexOf(marker);
    if (at === -1) return null;
    const near = npRegion.slice(at, at + 120);
    const v = near.indexOf('w:val="');
    if (v === -1) return null;
    const close = near.indexOf('"', v + 7);
    return close === -1 ? null : near.slice(v + 7, close);
  };
  const numId = read("<w:numId");
  const rawIlvl = read("<w:ilvl");
  const ilvl =
    rawIlvl !== null && /^[0-8]$/.test(rawIlvl) ? parseInt(rawIlvl, 10) : null;
  return { numId, ilvl };
}

/**
 * One OOXML paragraph -> one text line, with the structure the format
 * matcher needs made visible: heading styles (or outline levels, which are
 * locale-independent) become markdown heading prefixes, and numbered
 * paragraphs carry their RECONSTRUCTED literal numbers when a numbering
 * model is available (round 15d; Word keeps auto-numbers in numbering.xml).
 * With no model (missing/hostile numbering.xml), output is byte-identical
 * to the pre-15d extractor: bulleted/numbered paragraphs become "- " items.
 */
function paraToLine(
  p: string,
  model: NumberingModel | null,
  counters: NumCounters | null
): string {
  const text = stripRuns(p).replace(/\s+/g, " ").trim();
  if (!text) return "";
  const style = propVal(p, "<w:pStyle");
  let headingLevel = 0;
  if (style === "Title") headingLevel = 1;
  else {
    const styleLevel = /^[Hh]eading([1-6])$/.exec(style ?? "");
    if (styleLevel) headingLevel = parseInt(styleLevel[1], 10);
    else {
      const outline = propVal(p, "<w:outlineLvl");
      if (outline !== null && /^[0-5]$/.test(outline))
        headingLevel = parseInt(outline, 10) + 1;
    }
  }

  let label: NumberingLabel | null = null;
  let liveNumbering = false;
  if (model && counters) {
    const direct = numPrRef(p);
    const ref = resolveParagraphNumbering(model, direct, style || null);
    if (ref === "none") label = { kind: "none" };
    else if (ref) {
      liveNumbering = true;
      label = numberingLabel(model, counters, ref.numId, ref.ilvl);
    }
  }

  if (headingLevel > 0) {
    const prefix =
      label?.kind === "number" ? `${label.label} ` : "";
    return `${"#".repeat(headingLevel)} ${prefix}${text}`;
  }
  if (label) {
    if (label.kind === "number") return `${label.label} ${text}`;
    if (label.kind === "bullet") return `- ${text}`;
    return text; // "none": numbering explicitly removed, never a dash
  }
  if (model) {
    // The model path is authoritative: a paragraph whose numbering exists
    // but cannot render (missing definition, link cycle) degrades to the
    // dash; one with NO live numbering (incl. stale pPrChange numPr, which
    // the legacy propVal region would wrongly count) is plain text.
    return liveNumbering ? `- ${text}` : text;
  }
  // Legacy shape (no numbering.xml): exact pre-15d behavior, including
  // propVal's own quirks.
  if (propVal(p, "<w:numPr") !== null) return `- ${text}`;
  return text;
}

/** indexOf walk for "<w:tbl" followed by whitespace or ">" (skips w:tblPr
 * and friends), starting at `from`. */
function findTableStart(xml: string, from: number): number {
  let i = from;
  while (i < xml.length) {
    const at = xml.indexOf("<w:tbl", i);
    if (at === -1) return -1;
    const boundary = xml.charAt(at + 6);
    if (boundary === ">" || boundary === " " || boundary === "\t" || boundary === "\n" || boundary === "\r")
      return at;
    i = at + 6;
  }
  return -1;
}

/**
 * word/document.xml -> plain text that preserves what the format matcher
 * mirrors: heading hierarchy, list items, and table rows (cells tab-joined,
 * one row per line). Everything else flattens to paragraphs. Linear:
 * indexOf segmentation + fixed-string splits only.
 */
export function docxXmlToText(
  xml: string,
  model: NumberingModel | null = null
): string {
  const counters = model ? createCounters() : null;
  const out: string[] = [];
  let total = 0;
  const push = (line: string): boolean => {
    out.push(line);
    total += line.length;
    return total < EXTRACT_STOP_CHARS;
  };

  let pos = 0;
  while (pos < xml.length) {
    const tblStart = findTableStart(xml, pos);
    const plainEnd = tblStart === -1 ? xml.length : tblStart;

    // Plain segment: paragraphs. The split pattern is fixed-length (no
    // quantifiers), so it cannot backtrack; "<w:p" alone would also split
    // inside <w:pPr>/<w:pStyle> and shred the paragraph.
    const plain = xml.slice(pos, plainEnd);
    for (const p of plain.split(/<w:p[\s>]/)) {
      const line = paraToLine(p, model, counters);
      if (line && !push(line)) return out.join("\n");
    }
    if (tblStart === -1) break;

    // Table segment: rows -> lines, cells -> tabs. Nested tables degrade to
    // their first close, acceptable for a formatting sample.
    let tblEnd = xml.indexOf("</w:tbl>", tblStart);
    if (tblEnd === -1) tblEnd = xml.length;
    const tbl = xml.slice(tblStart, tblEnd);
    for (const row of tbl.split("</w:tr>")) {
      const cells = row
        .split("</w:tc>")
        .map((c) => stripRuns(c).replace(/\s+/g, " ").trim())
        .filter(Boolean);
      if (cells.length && !push(cells.join("\t"))) return out.join("\n");
    }
    pos = tblEnd + 8;
  }
  return out.join("\n");
}

/**
 * Strip control chars (keep \n and \t), normalize newlines, cap blank runs,
 * and destroy the prompt's fence tokens anywhere they appear: the sample is
 * the one fenced block whose content the user authors directly, and the
 * extractor itself can move a marker off line-start ("- SAMPLE>>>"), so
 * glyph runs are removed globally rather than by line.
 */
function normalize(text: string): string {
  return text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/<{3,}|>{3,}/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// JSZip's documented internalStream API is missing from its typings.
interface JsZipStream {
  on(event: "data", cb: (chunk: Uint8Array) => void): JsZipStream;
  on(event: "error", cb: (e: unknown) => void): JsZipStream;
  on(event: "end", cb: () => void): JsZipStream;
  pause(): JsZipStream;
  resume(): JsZipStream;
}

type InflateOutcome =
  | { kind: "ok"; xml: string }
  | { kind: "too_large" }
  | { kind: "error" };

/** Inflate one zip entry with a hard byte cap (decompression-bomb guard).
 * Streams via JSZip's documented internalStream API so a lying central
 * directory cannot force an unbounded in-memory inflate. */
function inflateCapped(
  entry: JSZip.JSZipObject,
  maxBytes: number
): Promise<InflateOutcome> {
  return new Promise((resolve) => {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let settled = false;
    const done = (v: InflateOutcome) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const stream = (
      entry as unknown as {
        internalStream(type: "uint8array"): JsZipStream;
      }
    ).internalStream("uint8array");
    stream.on("data", (chunk: Uint8Array) => {
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
    });
    stream.on("error", () => done({ kind: "error" }));
    stream.on("end", () =>
      done({ kind: "ok", xml: Buffer.concat(chunks).toString("utf8") })
    );
    stream.resume();
  });
}

/** Leading numbering marker on a heading line or outline title ("III. ",
 * "2.1 ", "Section 3: ", "A) "): stripped from BOTH sides of the outline
 * match, since PDF lines usually carry rendered numbers and bookmark titles
 * usually do not (or vice versa) : without this the match fails exactly on
 * the numbered documents the feature targets. Bounded quantifiers only. */
const LEADING_NUM_RE =
  /^(?:\d{1,3}(?:\.\d{1,3}){0,4}[.)]?|(?=[IVXivx])[IVXivx]{1,7}[.)]|[A-Za-z][.)]|Section\s{1,4}\d{1,3}\s{0,4}[:.)-]?)\s+/;

/** Canonical key for outline-title <-> text-line matching. SLICE FIRST:
 * outline titles are attacker-controlled strings decompressed from PDF
 * streams, and normalizing before bounding would be synchronous main-thread
 * work the Promise.race deadline structurally cannot preempt. */
export function normalizeOutlineKey(s: string): string {
  return s
    .slice(0, 200)
    .trim()
    .replace(LEADING_NUM_RE, "")
    .toLowerCase()
    .replace(/\s{1,20}/g, " ")
    .replace(/[.:;,]{1,10}$/, "")
    .trim();
}

interface OutlineNode {
  title?: unknown;
  items?: unknown;
}

/** Bookmark tree -> normalized-title -> depth (1-3) map. Iterative walk
 * with an explicit stack (hostile depth), caps 100 items / depth 3,
 * first-wins on duplicate titles. */
export function buildOutlineMap(
  outline: unknown
): Map<string, number> | null {
  if (!Array.isArray(outline) || !outline.length) return null;
  const map = new Map<string, number>();
  const stack: { nodes: OutlineNode[]; depth: number }[] = [
    { nodes: outline as OutlineNode[], depth: 1 },
  ];
  let seen = 0;
  while (stack.length) {
    const { nodes, depth } = stack.pop()!;
    for (const node of nodes) {
      if (++seen > 100) return map.size ? map : null;
      if (!node || typeof node !== "object") continue;
      const key =
        typeof node.title === "string" ? normalizeOutlineKey(node.title) : "";
      if (key && !map.has(key)) map.set(key, depth);
      if (depth < 3 && Array.isArray(node.items) && node.items.length)
        stack.push({ nodes: node.items as OutlineNode[], depth: depth + 1 });
    }
  }
  return map.size ? map : null;
}

/**
 * Upgrade extracted lines that match a bookmark title to that bookmark's
 * depth (overriding the font-size heuristic, including its misses). Never
 * synthesizes lines: an outline title with no matching extracted text is
 * dropped : injecting a skeleton would corrupt reading order in the stored
 * sample. Empty/absent map = identity.
 */
export function applyOutlineHeadings(
  marked: string[],
  raw: { text: string }[],
  outline: Map<string, number> | null
): string[] {
  if (!outline || !outline.size) return marked;
  return marked.map((line, i) => {
    const t = raw[i]?.text.trim() ?? "";
    if (!t || t.length > 120) return line;
    const depth = outline.get(normalizeOutlineKey(t));
    return depth ? `${"#".repeat(depth)} ${t}` : line;
  });
}

/**
 * PDF heading inference (§5.12 structure adoption): getTextContent has no
 * style information, so a PDF template used to reach the prompt as flat
 * paragraphs with NO structure for the model to mirror. Font height is the
 * signal PDFs do carry: lines set clearly larger than the document's median
 * (body) size, short, and not ending like a sentence become markdown
 * headings, two tiers by size. Linear; needs a minimum of lines so a
 * one-page memo does not get fake structure. Exported for tests.
 */
export function markPdfHeadings(
  lines: { text: string; h: number }[]
): string[] {
  const sized = lines
    .map((l) => ({ t: l.text.trim(), h: l.h }))
    .filter((l) => l.t.length > 0 && l.h > 0);
  if (sized.length < 8) return lines.map((l) => l.text);
  const heights = sized.map((l) => l.h).sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)];
  if (!(median > 0)) return lines.map((l) => l.text);
  return lines.map((l) => {
    const t = l.text.trim();
    const heading =
      l.h >= median * 1.2 &&
      t.length > 0 &&
      t.length <= 100 &&
      /[A-Za-z]/.test(t) &&
      !/[.;,]$/.test(t);
    if (!heading) return l.text;
    return `${l.h >= median * 1.5 ? "#" : "##"} ${t}`;
  });
}

/**
 * Round 18b (#1): Word-exported PDFs emit auto-number labels AFTER their
 * title text in the content stream, so section titles arrive as flat prose
 * with the number glued to the line END ("Purpose1.", "Policy5.") and the
 * outline machinery (SAMPLE OUTLINE digest, skeleton adoption, numbering
 * style) starves. Recover them: unmarked, short, title-shaped lines whose
 * trailing numbers form an ASCENDING chain starting at 1 become numbered
 * headings ("## 1. Purpose"). The chain (>=3 links, +1 steps) is the
 * false-positive guard: sub-item numbers restart per parent and body
 * sentences end with a period before the glued number, so neither can
 * ride the chain. Anything short of a full chain changes nothing.
 */
const TRAILING_NUM_TITLE =
  /^([A-Za-z][^\n]{1,78}?)[\s:]{0,4}(\d{1,3})\s{0,2}\.?$/;

export function recoverTrailingNumberedHeadings(lines: string[]): string[] {
  const hits: { idx: number; title: string }[] = [];
  let expected = 1;
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) continue;
    const t = lines[i].trim();
    const m = TRAILING_NUM_TITLE.exec(t);
    if (!m) continue;
    if (parseInt(m[2], 10) !== expected) continue;
    const title = m[1].trim().replace(/[\s:]{1,4}$/, "");
    // Title-shaped only: no sentence break, no terminal punctuation, short.
    if (/[.!?;]\s/.test(title) || /[.!?;,]$/.test(title)) continue;
    if (!/[A-Za-z]/.test(title) || title.split(/\s{1,10}/).length > 10)
      continue;
    hits.push({ idx: i, title });
    expected++;
  }
  if (hits.length < 3) return lines;
  const out = [...lines];
  hits.forEach((h, k) => {
    out[h.idx] = `## ${k + 1}. ${h.title}`;
  });
  return out;
}

/**
 * Round 19 companion to the trailing recovery above: once positional
 * assembly reunites labels in READING order, section titles arrive as
 * "1. Purpose" body lines (number now LEADS), which the trailing regex can
 * never match - without this the fix would starve the outline machinery it
 * was built to feed. Same ascending-chain guard (>=3 links, +1 steps from
 * 1), same title shape; tiered (indented) lines are list items and never
 * candidates, and a ":"-terminal line is a list parent.
 *
 * List-vs-heading discrimination is CHAIN-LEVEL (round 19b). The local
 * shape "N. Title over an indented marker" is undecidable line-by-line:
 * a real heading whose section OPENS with a sub-list (the flagship ISO
 * template's Definitions and Policy sections) is byte-identical to a
 * list parent, and round 19's per-link skip broke the +1 chain right
 * there, silently disarming the whole outline machinery for exactly the
 * document class it was built for. Each link now RECORDS indented-child
 * evidence instead of dying on it, and only a strict majority of that
 * evidence vetoes the whole chain; a tie promotes (evidence this weak
 * cannot outvote the ascending chain - half the sections opening with
 * definition lists is still a skeleton). Col-0 siblings are deliberately
 * NOT evidence: numbered body paragraphs ("1. This policy applies...")
 * and bare skeleton templates are col-0 runs that MUST promote. Accepted,
 * test-pinned limitation: a flat col-0 checklist of short title-shaped
 * lines in an otherwise outline-dead document still promotes (status-quo
 * parity with round 19; visible in outlineTitles, recoverable by
 * removing the sample).
 */
const LEADING_NUM_TITLE = /^(\d{1,3})[.)]\s{1,4}([A-Za-z][^\n]{0,78})$/;
const INDENTED_MARKER = /^\s{1,10}(?:[-*]\s|\d{1,3}[.)]\s|[A-Za-z][.)]\s)/;

export function recoverLeadingNumberedHeadings(lines: string[]): string[] {
  const hits: { idx: number; title: string; listChild: boolean }[] = [];
  let expected = 1;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (/^#{1,6}\s/.test(raw) || /^\s/.test(raw)) continue;
    const m = LEADING_NUM_TITLE.exec(raw.trim());
    if (!m) continue;
    if (parseInt(m[1], 10) !== expected) continue;
    const title = m[2].trim();
    if (/[.!?;]\s/.test(title) || /[:.!?;,]$/.test(title)) continue;
    if (title.split(/\s{1,10}/).length > 10) continue;
    let next = i + 1;
    while (next < lines.length && !lines[next].trim()) next++;
    hits.push({
      idx: i,
      title,
      listChild: next < lines.length && INDENTED_MARKER.test(lines[next]),
    });
    expected++;
  }
  if (hits.length < 3) return lines;
  const parents = hits.reduce((n, h) => n + (h.listChild ? 1 : 0), 0);
  if (parents * 2 > hits.length) return lines;
  const out = [...lines];
  hits.forEach((h, k) => {
    out[h.idx] = `## ${k + 1}. ${h.title}`;
  });
  return out;
}

/**
 * Read-edge heal (round 19b): stored samples keep whatever the extractor
 * of their upload day produced - the file itself is discarded, so
 * extraction fixes never retro-apply on their own. A row whose stored
 * text leaves the outline machinery disarmed (fewer than two
 * sampleOutline-shaped heading lines - the exact starved state) re-runs
 * BOTH numbered-heading recoveries in pipeline order at every read edge.
 * Never persisted: the stored text is the only copy of data derived from
 * a discarded upload, and a later-improved heal can always re-run over
 * it. Gated by the stored filename to PDF/unknown sources: the
 * recoveries only ever ran in the PDF extraction branch, so healing a
 * .docx/.md/.txt row would invent promotions no re-upload of that file
 * could produce. Pure, linear, idempotent (healed output carries >=2
 * headings, so a second call takes the early return).
 */
const NON_PDF_SAMPLE_NAME = /\.(docx|md|txt)$/i;

export function healSampleHeadings(
  text: string | null,
  name: string | null
): string | null {
  if (!text || (name !== null && NON_PDF_SAMPLE_NAME.test(name))) return text;
  let headings = 0;
  for (const line of text.split("\n"))
    if (/^#{1,6}\s.{1,300}$/.test(line) && ++headings >= 2) break;
  if (headings >= 2) return text;
  return recoverTrailingNumberedHeadings(
    recoverLeadingNumberedHeadings(text.split("\n"))
  ).join("\n");
}

/* ------------------------------------------------------------------ *
 * Positional PDF line assembly (§5.12 round 19). Word-exported PDFs emit
 * list/heading auto-number labels OUT of reading order (after their
 * paragraph's text items, at the y of the paragraph's FIRST line), which
 * the old stream-order assembly turned into orphan "1." lines and
 * "text.2." trailing glue - garbage the model then mirrors from the format
 * sample into drafts. The fix is deliberately LOCAL, not a full y-sort: a
 * positioned item may merge into one of the last K=12 lines when its y
 * matches within tolerance, spliced by x. Multi-column PDFs degrade to
 * stream order (a matching y in another column is a full column height
 * back, outside the window); rotated/sheared and transform-less items keep
 * the old append behavior; RTL lines never x-splice. Tolerance
 * 0.45*max(h, line first-member h) sits between the superscript raise
 * (<=0.45em) and single-space leading (>=1.08em); line y and the tolerance
 * anchor stay pinned to the FIRST member so one merged oversized part
 * cannot widen the funnel. All passes linear; 30k items/page truncation.
 * ------------------------------------------------------------------ */

export interface PdfRawLine {
  text: string;
  h: number;
  /** min x of positioned parts; null = fallback-assembled line. */
  startX: number | null;
  /** x where content begins after a standalone leading marker part. */
  textX: number | null;
}

const BULLET_GLYPHS = /^[•●▪■◦○·\uF0A7\uF0B7\uF076\uF0D8]$/;
const SYMBOL_PUA = /[\uF000-\uF8FF]/g;
const MARKER_PART = /^\s*(?:[-*]|\d{1,3}[.)]|[A-Za-z][.)])\s*$/;
const MAX_PAGE_ITEMS = 30_000;
const MERGE_WINDOW = 12;

interface AsmPart {
  x: number | null; // null = stream-appended (no usable position)
  wEnd: number | null; // x + width when width is usable
  str: string;
  h: number;
  spliced: boolean; // inserted out of arrival order
}

interface AsmLine {
  y: number | null; // first member's y, never updated
  hFirst: number;
  h: number;
  rtl: boolean;
  parts: AsmPart[];
}

function emitLine(l: AsmLine): PdfRawLine {
  let text = "";
  let prev: AsmPart | null = null;
  for (const p of l.parts) {
    if (prev && text && !/\s$/.test(text) && !/^\s/.test(p.str)) {
      const gapKnown =
        prev.wEnd !== null && p.x !== null && !l.rtl ? p.x - prev.wEnd : null;
      if (gapKnown !== null) {
        if (gapKnown > 0.3 * Math.max(prev.h, p.h)) text += " ";
      } else if (p.spliced || prev.spliced) text += " ";
    }
    text += p.str;
    prev = p;
  }
  // Bullet glyphs normalize to a markdown bullet; leftover Symbol-font PUA
  // glyphs are dropped (they were stored as garbage bytes before).
  const first = l.parts[0];
  if (first && BULLET_GLYPHS.test(first.str.trim()))
    text = `- ${text.slice(first.str.length).trimStart()}`;
  text = text.replace(SYMBOL_PUA, "");
  const positioned = l.parts.filter((p) => p.x !== null);
  const startX = positioned.length
    ? Math.min(...positioned.map((p) => p.x!))
    : null;
  let textX = startX;
  if (
    positioned.length >= 2 &&
    l.parts[0]?.x !== null &&
    MARKER_PART.test(l.parts[0].str)
  )
    textX = l.parts[1]?.x ?? startX;
  return { text, h: l.h, startX, textX };
}

/** One page's getTextContent items -> lines. Pure; exported for tests. */
export function assemblePdfLines(items: unknown[]): PdfRawLine[] {
  const lines: AsmLine[] = [];
  let current: AsmLine | null = null;
  const newLine = (part: AsmPart, y: number | null, rtl: boolean): AsmLine => {
    const l: AsmLine = { y, hFirst: part.h, h: part.h, rtl, parts: [part] };
    lines.push(l);
    return l;
  };
  const count = Math.min(items.length, MAX_PAGE_ITEMS);
  for (let idx = 0; idx < count; idx++) {
    const item = items[idx] as {
      str?: unknown;
      transform?: unknown;
      hasEOL?: unknown;
      width?: unknown;
      dir?: unknown;
    };
    if (typeof item.str !== "string") continue;
    const tf = Array.isArray(item.transform) ? item.transform : null;
    const rotated =
      !tf ||
      Math.abs(Number(tf[1]) || 0) > 0.001 ||
      Math.abs(Number(tf[2]) || 0) > 0.001;
    const h = tf
      ? Math.abs(Number(tf[3]) || 0) || Math.abs(Number(tf[0]) || 0)
      : 0;
    const rtl = item.dir === "rtl";
    if (rotated || !Number.isFinite(Number(tf?.[4])) || !Number.isFinite(Number(tf?.[5]))) {
      // Fallback: today's behavior byte-for-byte - append to the current
      // line, hasEOL closes it.
      const part: AsmPart = { x: null, wEnd: null, str: item.str, h, spliced: false };
      if (current) {
        current.parts.push(part);
        if (h > current.h) current.h = h;
        if (rtl) current.rtl = true;
      } else current = newLine(part, null, rtl);
      if (item.hasEOL) current = null;
      continue;
    }
    const x = Number(tf![4]);
    const y = Number(tf![5]);
    const w = typeof item.width === "number" && item.width > 0 ? item.width : null;
    const part: AsmPart = {
      x,
      wEnd: w !== null ? x + w : null,
      str: item.str,
      h,
      spliced: false,
    };
    // Merge-target search over the last K lines: smallest |dy| within
    // tolerance wins, ties to the most recent.
    let best: AsmLine | null = null;
    let bestDy = Infinity;
    for (let k = lines.length - 1; k >= 0 && k >= lines.length - MERGE_WINDOW; k--) {
      const l = lines[k];
      if (l.y === null) continue;
      const dy = Math.abs(y - l.y);
      if (dy <= Math.max(2, 0.45 * Math.max(h, l.hFirst)) && dy < bestDy) {
        best = l;
        bestDy = dy;
      }
    }
    if (best) {
      if (rtl) best.rtl = true;
      if (best.rtl) best.parts.push(part);
      else {
        // Insert by x (stable for equal x). Splicing before existing parts
        // marks the part so the space rule knows the seam was rebuilt.
        let at = best.parts.length;
        while (at > 0) {
          const q = best.parts[at - 1];
          if (q.x !== null && q.x > x) at--;
          else break;
        }
        part.spliced = at < best.parts.length || best !== current;
        best.parts.splice(at, 0, part);
      }
      if (h > best.h) best.h = h;
      if (best === current && item.hasEOL) current = null;
    } else {
      current = newLine(part, y, rtl);
      if (item.hasEOL) current = null;
    }
  }
  return lines.map(emitLine);
}

/* Indent tiers + continuation joins + residual orphan drop (round 19).
 * Runs AFTER frame stripping (a footer must never join a wrapped item) and
 * never across pages. Tiers: marker-led lines cluster by startX (quantized
 * 9pt - Word steps indents in 18pt units; jitter stays within a cluster);
 * a line's tier = number of distinct major clusters strictly left of its
 * own, capped at 2, emitted as 2 spaces per tier (our parser's own nesting
 * threshold). Anchoring on MARKER-line clusters, not the body margin,
 * keeps hanging-indent continuations from polluting the baseline. Joins: a
 * non-marker line whose startX matches the preceding marker line's textX
 * within 3pt joins it - gated on the marker line not already ending a
 * sentence OR the candidate starting lowercase, so a first-line-indented
 * paragraph never fuses into a list item. */
const LINE_MARKER_LEAD = /^(?:[-*]\s|\d{1,3}[.)]\s|[A-Za-z][.)]\s)/;

export function shapePdfListLines(pages: PdfRawLine[][]): PdfRawLine[][] {
  const clusterKey = (x: number) => Math.round(x / 9) * 9;
  const counts = new Map<number, number>();
  for (const page of pages)
    for (const l of page) {
      if (l.startX === null) continue;
      if (!LINE_MARKER_LEAD.test(l.text.trim())) continue;
      const k = clusterKey(l.startX);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  const major = [...counts.entries()]
    .filter(([, c]) => c >= 2)
    .map(([k]) => k)
    .sort((a, b) => a - b);
  const tierOf = (x: number): number => {
    const k = clusterKey(x);
    let t = 0;
    for (const mk of major) if (mk < k) t++;
    return Math.min(t, 2);
  };
  return pages.map((page) => {
    const out: PdfRawLine[] = [];
    let marker: PdfRawLine | null = null;
    for (const l of page) {
      const trimmed = l.text.trim();
      if (!trimmed) {
        marker = null;
        out.push(l);
        continue;
      }
      // Residual orphan auto-number label that still defeated geometry:
      // drop it here so the format sample never teaches the shape.
      if (/^\d{1,3}[.)]$/.test(trimmed)) continue;
      if (LINE_MARKER_LEAD.test(trimmed)) {
        const tier = l.startX !== null && major.length ? tierOf(l.startX) : 0;
        const shaped: PdfRawLine = {
          ...l,
          text: `${"  ".repeat(tier)}${trimmed}`,
        };
        out.push(shaped);
        marker = shaped;
        continue;
      }
      if (
        marker &&
        marker.textX !== null &&
        l.startX !== null &&
        Math.abs(l.startX - marker.textX) <= 3 &&
        (!/[.!?;]$/.test(marker.text) || /^[a-z]/.test(trimmed))
      ) {
        marker.text = `${marker.text} ${trimmed}`;
        continue;
      }
      marker = null;
      out.push(l);
    }
    return out;
  });
}

/**
 * PDF -> plain text via pdf.js getTextContent (no rendering, no canvas, no
 * embedded-JS execution; isEvalSupported off). Hostile-input posture matches
 * the docx path: page cap, char stop, and a hard wall-clock deadline that
 * destroys the loading task (pdf.js parses in yielding async chunks, so
 * destroy() genuinely cancels the work). Lines are joined per text item with
 * y-position breaks, carry their max font height, and get heading markers
 * from markPdfHeadings so structure stays visible to the format matcher.
 */
async function pdfToText(buf: Buffer): Promise<ExtractResult> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // pdfjs-dist 6.x: PostScript-function eval was removed upstream, so there
  // is no isEvalSupported switch anymore; text extraction runs no PDF JS.
  const task = getDocument({
    data: new Uint8Array(buf),
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
  });
  const deadline = new Promise<"timeout">((resolve) =>
    setTimeout(() => resolve("timeout"), CAPS.styleSamplePdfDeadlineMs)
  );
  try {
    const extracted = await Promise.race([
      (async () => {
        const doc = await task.promise;
        // Bookmark outline (round 15d): the one PDF structure channel worth
        // its cost. getStructTree/MCID correlation is deliberately NOT read
        // (includeMarkedContent multiplies text items 2-4x against the same
        // deadline, for a minority of uploads); font/bold detection is
        // impossible under a getTextContent-only workflow (fonts are never
        // resolved into commonObjs without rendering : verified against
        // pdfjs-dist 6.1.200 sources, do not re-add naively).
        let outlineMap: Map<string, number> | null = null;
        try {
          outlineMap = buildOutlineMap(await doc.getOutline());
        } catch {
          outlineMap = null;
        }
        const pageCount = Math.min(doc.numPages, CAPS.styleSamplePdfMaxPages);
        // Per-page collection: the letterhead pass needs page boundaries.
        // Round 19: positional line assembly (assemblePdfLines) reunites
        // Word's out-of-order auto-number labels with their items in
        // reading order. The char cap stops NEW pages only, so the frame
        // pass always sees complete pages (retro-merged text makes the cap
        // approximate by design).
        const pages: PdfRawLine[][] = [];
        let total = 0;
        for (let n = 1; n <= pageCount && total < EXTRACT_STOP_CHARS; n++) {
          const page = await doc.getPage(n);
          const content = await page.getTextContent();
          const pageLines = assemblePdfLines(content.items);
          for (const l of pageLines) total += l.text.length;
          pages.push(pageLines);
        }
        // Letterhead inference (round 17): lines repeating across page
        // tops/bottoms become the frame and leave the body (a 40-page
        // sample must not repeat its letterhead 40 times into the stored
        // text, which would also poison the verbosity measurement). Frame
        // stripping runs BEFORE list shaping so a footer can never
        // continuation-join into a wrapped list item.
        const frame = detectPdfFrame(pages.map((p) => p.map((l) => l.text)));
        const filtered = pages.map((p) => {
          if (!frame.dropKeys.size) return p;
          const nonEmpty = p
            .map((l, idx) => (l.text.trim() ? idx : -1))
            .filter((idx) => idx !== -1);
          const edge = new Set([...nonEmpty.slice(0, 2), ...nonEmpty.slice(-2)]);
          return p.filter(
            (l, idx) => !(edge.has(idx) && isFrameLine(l.text, frame.dropKeys))
          );
        });
        const shaped = shapePdfListLines(filtered);
        // Lines from ALL pages classify together (one document-wide median);
        // h=0 separator rows keep the page breaks and never classify.
        const allLines: PdfRawLine[] = [];
        shaped.forEach((p, idx) => {
          allLines.push(...p);
          if (idx < shaped.length - 1)
            allLines.push({ text: "", h: 0, startX: null, textX: null });
        });
        const text = recoverTrailingNumberedHeadings(
          recoverLeadingNumberedHeadings(
            applyOutlineHeadings(markPdfHeadings(allLines), allLines, outlineMap)
          )
        )
          .join("\n")
          .trim();
        // Round 17c (owner parity ruling): detected PDF frame lines are
        // ADOPTED through the same shaping pipeline as .docx parts. Empty
        // string = scanned, nothing repeating found (1-page docs can never
        // prove a frame) so the UI can say so honestly.
        const sampleTitle = sampleTitleFromText(text);
        return {
          text,
          frame: {
            header: shapeFrameLines(frame.headerLines, sampleTitle) ?? "",
            footer: shapeFrameLines(frame.footerLines, sampleTitle) ?? "",
          },
        };
      })(),
      deadline,
    ]);
    if (extracted === "timeout") {
      void task.destroy().catch(() => {});
      return { ok: false, message: PDF_TIMEOUT };
    }
    void task.destroy().catch(() => {});
    if (extracted.text.trim().length < 40)
      return { ok: false, message: PDF_NO_TEXT };
    return { ok: true, text: extracted.text, frame: extracted.frame };
  } catch {
    void task.destroy().catch(() => {});
    return { ok: false, message: UNREADABLE };
  }
}

/**
 * Extract plain text from an uploaded sample policy. `.docx` is unzipped and
 * `word/document.xml` converted (headings, lists, and table rows kept
 * visible); `.pdf` goes through pdf.js text extraction (deadline + page
 * capped); `.md`/`.txt` are read as UTF-8. The result is normalized and
 * capped at CAPS.styleSampleMaxChars.
 */
export async function extractStyleSampleText(
  filename: string,
  buf: Buffer
): Promise<ExtractResult> {
  const lower = filename.toLowerCase();
  if (!STYLE_SAMPLE_EXTENSIONS.some((ext) => lower.endsWith(ext)))
    return {
      ok: false,
      message: `Upload a ${STYLE_SAMPLE_TYPES_COPY} file.`,
    };

  let text: string;
  let frame: SampleFrame = NO_FRAME;
  if (lower.endsWith(".pdf")) {
    const pdf = await pdfToText(buf);
    if (!pdf.ok) return pdf;
    text = pdf.text;
    frame = pdf.frame;
  } else if (lower.endsWith(".docx")) {
    try {
      const zip = await JSZip.loadAsync(buf);
      const entry = zip.file("word/document.xml");
      if (!entry) return { ok: false, message: UNREADABLE };
      const inflated = await inflateCapped(entry, MAX_DOCX_XML_BYTES);
      if (inflated.kind === "too_large")
        return { ok: false, message: TOO_LARGE };
      if (inflated.kind === "error") return { ok: false, message: UNREADABLE };
      // Numbering enrichment (round 15d): every failure here : entry
      // missing, over the aux cap, malformed : yields model null and the
      // pre-15d output, never a user-facing error the file would not have
      // hit before.
      const aux = async (name: string): Promise<string | null> => {
        const e = zip.file(name);
        if (!e) return null;
        const r = await inflateCapped(e, MAX_DOCX_AUX_XML_BYTES);
        return r.kind === "ok" ? r.xml : null;
      };
      const model = buildNumberingModel(
        await aux("word/numbering.xml"),
        await aux("word/styles.xml")
      );
      text = docxXmlToText(inflated.xml, model);
      // Letterhead (round 17): resolve the body sectPr's default header and
      // footer parts through the rels and capture their text. Every failure
      // here (missing rels, oversized part, malformed XML) is just "no
      // frame", never a user-facing error. Empty string (not null) means
      // "this .docx was scanned and nothing usable was found": the UI needs
      // that to stay honest about image-only letterheads, and null stays
      // the marker for samples stored before this round existed.
      const sampleTitle = sampleTitleFromText(text);
      const rels = await aux("word/_rels/document.xml.rels");
      let header: string | null = null;
      let footer: string | null = null;
      if (rels) {
        const parts = pickFrameParts(inflated.xml, parseHeaderFooterRels(rels));
        const readPart = async (
          path: string | null
        ): Promise<string | null> => {
          if (!path) return null;
          const xml = await aux(path);
          return xml ? headerFooterXmlToText(xml, sampleTitle) : null;
        };
        header = await readPart(parts.headerPath);
        footer = await readPart(parts.footerPath);
      }
      frame = { header: header ?? "", footer: footer ?? "" };
    } catch {
      return { ok: false, message: UNREADABLE };
    }
  } else {
    text = buf.toString("utf8");
  }

  const clean = normalize(text);
  if (clean.length < 40) return { ok: false, message: UNREADABLE };
  return { ok: true, text: clean.slice(0, CAPS.styleSampleMaxChars), frame };
}

/** Display-safe file name: basename only, control chars out, length-capped. */
export function sanitizeSampleName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "sample";
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (clean || "sample").slice(0, 120);
}
