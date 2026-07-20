// Sample letterhead extraction (§5.12 round 17): the page header and footer
// of the uploaded format sample, captured at upload time (the file is
// discarded after extraction) so generated .docx downloads can carry the
// user's own letterhead frame.
//
// .docx: headers/footers live in word/headerN.xml / word/footerN.xml parts,
// bound through the body sectPr's headerReference/footerReference r:ids and
// word/_rels/document.xml.rels. Page-number fields (PAGE / NUMPAGES) are
// captured as {{PAGE}} / {{PAGES}} tokens so the renderer can emit real
// Word fields instead of a frozen number.
//
// .pdf: no header/footer structure exists. Lines repeating across page
// tops/bottoms ARE the frame: adopted into downloads through the same
// shaping pipeline as .docx parts (owner parity ruling 2026-07-20,
// overriding the round-17b panel's strip-only stance; the control's
// line-by-line preview is the false-positive safety net) and stripped
// from the stored body (a 40-page sample must not repeat its letterhead
// 40 times into the text that rides prompts and feeds the verbosity
// measurement).
//
// Same iron rules as style-sample.ts: everything here runs synchronously on
// the request path over attacker-controlled input, so every pass is LINEAR
// (indexOf walks, bounded windows, bounded-quantifier regexes) and every
// failure degrades to "no letterhead", never an error.

export const PAGE_TOKEN = "{{PAGE}}";
export const PAGES_TOKEN = "{{PAGES}}";
// The sample's own document title inside its header would be wrong on every
// generated document (a set holds several, each with its own title), so a
// matched title span is stored as this token and each download substitutes
// its own title at render time.
export const TITLE_TOKEN = "{{TITLE}}";

// A letterhead is a frame, not a document: tight caps keep a hostile or
// degenerate part from becoming a second sample channel.
const MAX_FRAME_LINES = 4;
const MAX_FRAME_LINE_CHARS = 200;
const MAX_FRAME_CHARS = 480;
const REL_SCAN_CAP = 2000; // relationships in document.xml.rels (real docs: tens)
const ATTR_WINDOW = 600; // one Relationship/reference tag fits well inside

export interface SampleFrame {
  header: string | null;
  footer: string | null;
}

/** Read one XML attribute value inside `tag` (already-sliced tag text).
 * Bounded: `tag` is always a bounded window slice. */
function attrVal(tag: string, name: string): string | null {
  const at = tag.indexOf(`${name}="`);
  if (at === -1) return null;
  const start = at + name.length + 2;
  const close = tag.indexOf('"', start);
  return close === -1 ? null : tag.slice(start, close);
}

/**
 * word/_rels/document.xml.rels -> rId -> part path, header/footer rels only.
 * Targets are normalized to zip paths under word/ and anything traversing
 * upward is dropped.
 */
export function parseHeaderFooterRels(
  relsXml: string
): Map<string, { kind: "header" | "footer"; path: string }> {
  const map = new Map<string, { kind: "header" | "footer"; path: string }>();
  let i = 0;
  let seen = 0;
  while (i < relsXml.length && seen < REL_SCAN_CAP) {
    const at = relsXml.indexOf("<Relationship ", i);
    if (at === -1) break;
    seen++;
    const tag = relsXml.slice(at, at + ATTR_WINDOW);
    i = at + 14;
    const type = attrVal(tag, "Type") ?? "";
    const kind = type.endsWith("/header")
      ? ("header" as const)
      : type.endsWith("/footer")
        ? ("footer" as const)
        : null;
    if (!kind) continue;
    const id = attrVal(tag, "Id");
    let target = attrVal(tag, "Target") ?? "";
    if (!id || !target) continue;
    if (target.includes("..")) continue;
    target = target.replace(/^\//, "");
    if (!target.startsWith("word/")) target = `word/${target}`;
    // Only plain sibling parts qualify (headerN.xml lives next to
    // document.xml); external-mode or exotic targets are ignored.
    if (!/^word\/[A-Za-z0-9._-]{1,64}$/.test(target)) continue;
    map.set(id, { kind, path: target });
  }
  return map;
}

/**
 * The body sectPr's header/footer references (the LAST sectPr in
 * document.xml is the body-level one; paragraph-level sectPr for section
 * breaks come earlier). Preference order default > first > even: "default"
 * is what most pages show.
 */
export function pickFrameParts(
  documentXml: string,
  rels: Map<string, { kind: "header" | "footer"; path: string }>
): { headerPath: string | null; footerPath: string | null } {
  let last = -1;
  let i = 0;
  while (i < documentXml.length) {
    const at = documentXml.indexOf("<w:sectPr", i);
    if (at === -1) break;
    last = at;
    i = at + 9;
  }
  if (last === -1) return { headerPath: null, footerPath: null };
  const end = documentXml.indexOf("</w:sectPr>", last);
  const region = documentXml.slice(
    last,
    end === -1 ? Math.min(documentXml.length, last + 4000) : end
  );
  const pick = (refTag: string, kind: "header" | "footer"): string | null => {
    const byType = new Map<string, string>();
    let j = 0;
    while (j < region.length) {
      const at = region.indexOf(refTag, j);
      if (at === -1) break;
      const tag = region.slice(at, at + ATTR_WINDOW);
      j = at + refTag.length;
      const type = attrVal(tag, "w:type") ?? "default";
      const rid = attrVal(tag, "r:id");
      if (!rid) continue;
      const rel = rels.get(rid);
      if (!rel || rel.kind !== kind) continue;
      if (!byType.has(type)) byType.set(type, rel.path);
    }
    return byType.get("default") ?? byType.get("first") ?? byType.get("even") ?? null;
  };
  return {
    headerPath: pick("<w:headerReference", "header"),
    footerPath: pick("<w:footerReference", "footer"),
  };
}

/** Word-bounded field-code test over an instr string ("PAGE" must not match
 * "NUMPAGES" or "PAGEREF"). */
function fieldToken(instr: string): string | null {
  const code = instr.toUpperCase();
  if (/(^|[^A-Z])(NUMPAGES|SECTIONPAGES)([^A-Z]|$)/.test(code)) return PAGES_TOKEN;
  if (/(^|[^A-Z])PAGE([^A-Z]|$)/.test(code)) return PAGE_TOKEN;
  return null;
}

/**
 * One header/footer part paragraph chunk -> display text, page-number
 * fields tokenized. Linear indexOf walk with a tiny field state machine:
 * complex fields (w:fldChar begin / separate / end + w:instrText) and
 * simple fields (w:fldSimple w:instr). Non-page fields keep their cached
 * result text (dates, doc properties); page fields become tokens so the
 * renderer can emit live fields.
 */
export function frameParaText(chunk: string): string {
  const out: string[] = [];
  // Complex-field state: collecting the code between begin and separate,
  // then the cached result between separate and end.
  let fld: { phase: "code" | "cached"; code: string; cached: string } | null =
    null;
  let inInstr = false;
  // fldSimple: cached result is the element content; code is in the attr.
  let simple: { code: string; cached: string } | null = null;
  const text = (t: string) => {
    if (simple) simple.cached += t;
    else if (fld) {
      if (fld.phase === "code") {
        if (inInstr) fld.code += t;
      } else fld.cached += t;
    } else out.push(t);
  };
  let i = 0;
  while (i < chunk.length) {
    const lt = chunk.indexOf("<", i);
    if (lt === -1) {
      text(chunk.slice(i));
      break;
    }
    text(chunk.slice(i, lt));
    const gt = chunk.indexOf(">", lt + 1);
    if (gt === -1) break;
    const tag = chunk.slice(lt + 1, Math.min(gt, lt + ATTR_WINDOW));
    if (tag.startsWith("w:instrText")) inInstr = true;
    else if (tag.startsWith("/w:instrText")) inInstr = false;
    else if (tag.startsWith("w:fldChar")) {
      const kind = attrVal(tag, "w:fldCharType");
      if (kind === "begin") fld = { phase: "code", code: "", cached: "" };
      else if (kind === "separate") {
        if (fld) fld.phase = "cached";
      } else if (kind === "end") {
        if (fld) out.push(fieldToken(fld.code) ?? fld.cached);
        fld = null;
      }
    } else if (tag.startsWith("w:fldSimple")) {
      const instr = attrVal(tag, "w:instr") ?? "";
      if (tag.endsWith("/")) out.push(fieldToken(instr) ?? "");
      else simple = { code: instr, cached: "" };
    } else if (tag.startsWith("/w:fldSimple")) {
      if (simple) out.push(fieldToken(simple.code) ?? simple.cached);
      simple = null;
    } else if (tag.startsWith("w:tab")) text("\t");
    else if (tag.startsWith("w:br")) text("\n");
    i = gt + 1;
  }
  if (simple) out.push(fieldToken(simple.code) ?? simple.cached);
  return out.join("");
}

/** Decode the five XML entities plus numeric references (mirror of the
 * style-sample decoder; bounded quantifiers only). */
function decodeEntities(s: string): string {
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

/** Frame text cleanup shared by both sources: control chars out, fence
 * glyph runs destroyed (same reasoning as the sample body: this text rides
 * rendering and, in principle, prompts), whitespace tidied around tabs,
 * line/char caps applied. Null when nothing readable remains. */
export function normalizeFrameText(rawText: string): string | null {
  const lines = rawText
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/<{3,}|>{3,}/g, "")
    .split("\n")
    .map((l) =>
      l
        .replace(/[^\S\t]+/g, " ")
        .replace(/ ?\t ?/g, "\t")
        .replace(/\t{2,}/g, "\t")
        .trim()
    )
    .filter((l) => /[A-Za-z0-9{]/.test(l))
    .slice(0, MAX_FRAME_LINES)
    .map((l) => l.slice(0, MAX_FRAME_LINE_CHARS));
  const joined = lines.join("\n").slice(0, MAX_FRAME_CHARS);
  return /[A-Za-z0-9]|\{\{/.test(joined) ? joined : null;
}

/**
 * Document-control lines never carry into a generated draft: a mirrored
 * "Version 3.2, approved 2019" or "Approved by: CEO" fabricates review
 * history a fresh AI-generated draft does not have (UPL posture). The
 * denylist always wins; company names, addresses, and classification
 * labels (the user's own conventions) pass through untouched.
 */
export function isDocControlLine(line: string): boolean {
  const t = line.replace(/\s{1,20}/g, " ").trim();
  if (!t) return false;
  if (
    /^(version|ver\.?|v\d{1,3}(\.\d{1,4}){0,3}|rev\.?|revision|effective( date)?|approved( by)?|adopted( by| on)?|authori[sz]ed( by)?|issued?( date| by| on)?|last (updated|reviewed|revised)|review(ed)? (date|by|on)|next review|date of (issue|approval)|document (no|number|ref|id)\.?)\b/i.test(
      t
    )
  )
    return true;
  // Bare date lines ("March 2024", "2023-01-15", "01/02/2023").
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return true;
  if (/^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/.test(t)) return true;
  if (
    /^(january|february|march|april|may|june|july|august|september|october|november|december)\s\d{1,2}(,\s?\d{4})?$/i.test(
      t
    ) ||
    /^(january|february|march|april|may|june|july|august|september|october|november|december)\s\d{4}$/i.test(t)
  )
    return true;
  return false;
}

/** Case- and whitespace-insensitive substring replacement of the sample's
 * detected title with TITLE_TOKEN, mapped back to the original span with a
 * linear two-pointer walk. Whole remaining lines and mid-line spans both
 * match ("Acme Corp - AI Use Policy" keeps its company prefix). */
export function substituteTitle(line: string, title: string | null): string {
  if (!title) return line;
  const canon = (s: string) => s.toLowerCase().replace(/\s{1,20}/g, " ").trim();
  const needle = canon(title);
  if (needle.length < 8) return line;
  // Build the canonical form of the line with an index map to originals.
  const map: number[] = [];
  let canonLine = "";
  let lastSpace = true;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (/\s/.test(ch)) {
      if (!lastSpace) {
        canonLine += " ";
        map.push(i);
        lastSpace = true;
      }
      continue;
    }
    canonLine += ch.toLowerCase();
    map.push(i);
    lastSpace = false;
  }
  const at = canonLine.indexOf(needle);
  if (at === -1) return line;
  const startOrig = map[at];
  const endCanon = at + needle.length - 1;
  const endOrig = map[Math.min(endCanon, map.length - 1)];
  return `${line.slice(0, startOrig)}${TITLE_TOKEN}${line.slice(endOrig + 1)}`;
}

/** One header/footer part -> normalized frame text (or null): field-aware
 * paragraph walk, literal typed page numbers tokenized (fields are not the
 * only way real footers say "Page 1 of 4"), document-control lines dropped,
 * and the sample's own title swapped for TITLE_TOKEN. */
export function headerFooterXmlToText(
  xml: string,
  sampleTitle: string | null = null
): string | null {
  const lines: string[] = [];
  for (const p of xml.split(/<w:p[\s>]/)) {
    // One w:p is one line: inter-run whitespace (pretty-printed XML puts
    // newlines between every run) collapses to a space, tabs survive.
    const t = decodeEntities(frameParaText(p))
      .replace(/[^\S\t]+/g, " ")
      .trim();
    if (t.replace(/[\s\t]/g, "").length) lines.push(t);
    if (lines.length >= MAX_FRAME_LINES * 2) break;
  }
  return shapeFrameLines(lines, sampleTitle);
}

/** The one shaping pipeline every letterhead source goes through (round
 * 17c: .docx parts and PDF page-edge lines get identical treatment): page
 * numbers tokenized, document-control lines dropped, the sample's own
 * title swapped for the per-document token, then normalized and capped. */
export function shapeFrameLines(
  lines: string[],
  sampleTitle: string | null
): string | null {
  const shaped = lines
    .map((l) => tokenizePageNumbers(l))
    .filter((l) => !isDocControlLine(l))
    .map((l) => substituteTitle(l, sampleTitle));
  return normalizeFrameText(shaped.join("\n"));
}

/** The sample's own title: its first extracted heading line (any level),
 * markdown marker and leading outline number stripped. Null when too short
 * to match safely. */
export function sampleTitleFromText(text: string): string | null {
  for (const line of text.split("\n").slice(0, 200)) {
    const m = /^#{1,6}\s(.{1,300})$/.exec(line);
    if (!m) continue;
    const t = m[1]
      .replace(/^(?:\d{1,3}(?:\.\d{1,3}){0,4}[.)]?|[IVXivx]{1,7}[.)]|[A-Za-z][.)]|Section\s{1,4}\d{1,3}\s{0,4}[:.)-]?)\s+/, "")
      .trim();
    return t.length >= 8 ? t.slice(0, 200) : null;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * PDF: repeated top/bottom lines across pages
 * ------------------------------------------------------------------ */

const PDF_MIN_PAGES = 2; // 1 page has no repetition to prove a frame
const EDGE_LINES = 2; // lines per page edge considered frame candidates

/** Digit-insensitive identity key for a candidate frame line. */
export function frameLineKey(line: string): string {
  return line
    .replace(/\d{1,6}/g, "#")
    .replace(/\s{1,20}/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Candidate identity for one page-edge line, or null when the line can
 * never be letterhead. Digit-free lines match case/whitespace-insensitively.
 * Lines whose digits are PAGE NUMBERS (tokenizable, short, not
 * sentence-shaped) match digit-insensitively so "Page 3 of 12" repeats.
 * Every other digit-bearing line must repeat EXACTLY: a "Section 2" page-top
 * heading or a body sentence mentioning "page 4" varies per page and must
 * never become letterhead (both false positives were caught live by the
 * round-17c e2e before this guard existed).
 */
export function frameCandidateKey(line: string): string | null {
  const t = line.trim();
  if (t.length < 2 || t.length > MAX_FRAME_LINE_CHARS) return null;
  const tokenized = tokenizePageNumbers(t);
  if (tokenized !== t) {
    if (t.length <= 80 && !/[.;,:]$/.test(t)) return frameLineKey(t);
    return null;
  }
  if (/\d/.test(t))
    return `x:${t.toLowerCase().replace(/\s{1,20}/g, " ")}`;
  return frameLineKey(t);
}

/** Generalize page numbers in one concrete frame line to tokens. Ordered
 * from most to least specific so "Page 3 of 12" never half-matches. */
export function tokenizePageNumbers(line: string): string {
  return line
    .replace(/\bpage\s{1,4}\d{1,4}\s{1,4}of\s{1,4}\d{1,4}\b/gi, `Page ${PAGE_TOKEN} of ${PAGES_TOKEN}`)
    .replace(/\b\d{1,4}\s{1,4}of\s{1,4}\d{1,4}\b/g, `${PAGE_TOKEN} of ${PAGES_TOKEN}`)
    .replace(/\bpage\s{1,4}\d{1,4}\b/gi, `Page ${PAGE_TOKEN}`)
    .replace(/^\s{0,8}[-\u2013]?\s{0,4}\d{1,4}\s{0,4}[-\u2013]?\s{0,8}$/, PAGE_TOKEN);
}

export interface PdfFrameResult {
  /** RAW first-instance lines of the detected frame, top and bottom edge.
   * The caller shapes them (shapeFrameLines) once the sample's title is
   * known; raw is kept here so dropKeys and shaping stay independent. */
  headerLines: string[];
  footerLines: string[];
  /** Keys of detected frame lines: the extractor drops matching page-edge
   * lines from the body so a 40-page sample does not repeat its letterhead
   * 40 times into the stored text (which would also poison the verbosity
   * measurement). */
  dropKeys: Set<string>;
}

/**
 * Detect repeated page-edge lines across pages. `pages` is the per-page
 * list of raw text lines. A candidate must sit in the first/last EDGE_LINES
 * non-empty lines of its page and repeat (digit-insensitively): on EVERY
 * page for 2-3 page documents (owner parity ruling 2026-07-20: short PDFs
 * must carry their letterhead too, and unanimous repetition is the only
 * evidence a short document can offer), on at least 70 percent (minimum 3)
 * for longer ones. One-page PDFs stay empty: with no repetition there is
 * no way to tell a header from content. Order within the frame follows
 * average edge position.
 */
export function detectPdfFrame(pages: string[][]): PdfFrameResult {
  const empty: PdfFrameResult = {
    headerLines: [],
    footerLines: [],
    dropKeys: new Set(),
  };
  const usable = pages.filter((p) => p.some((l) => l.trim().length > 0));
  if (usable.length < PDF_MIN_PAGES) return empty;
  const need =
    usable.length <= 3
      ? usable.length
      : Math.max(3, Math.ceil(usable.length * 0.7));

  const collect = (edge: "top" | "bottom") => {
    const counts = new Map<
      string,
      { n: number; first: string; posSum: number }
    >();
    for (const page of usable) {
      const nonEmpty = page.filter((l) => l.trim().length > 0);
      const slice =
        edge === "top"
          ? nonEmpty.slice(0, EDGE_LINES)
          : nonEmpty.slice(-EDGE_LINES);
      slice.forEach((line, idx) => {
        const t = line.trim();
        const key = frameCandidateKey(t);
        if (!key) return;
        const rec = counts.get(key);
        if (rec) {
          rec.n++;
          rec.posSum += idx;
        } else counts.set(key, { n: 1, first: t, posSum: idx });
      });
    }
    const hits = [...counts.entries()]
      .filter(([, r]) => r.n >= need)
      .sort((a, b) => a[1].posSum / a[1].n - b[1].posSum / b[1].n)
      .slice(0, EDGE_LINES);
    return hits;
  };

  const top = collect("top");
  const bottom = collect("bottom");
  const dropKeys = new Set<string>([...top, ...bottom].map(([k]) => k));
  return {
    headerLines: top.map(([, r]) => r.first),
    footerLines: bottom.map(([, r]) => r.first),
    dropKeys,
  };
}

/** True when this page-edge line matches a detected frame line (used by the
 * extractor to drop it from the body). Must key EXACTLY like detection or
 * the strip and the adoption would disagree about what the frame is. */
export function isFrameLine(line: string, dropKeys: Set<string>): boolean {
  if (!dropKeys.size) return false;
  const key = frameCandidateKey(line);
  return key !== null && dropKeys.has(key);
}
