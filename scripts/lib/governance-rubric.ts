// Structure-match rubric for governance policy docx output.
//
// Pure measurement library: given a template .docx and a generated .docx it
// extracts each document's outline STRUCTURE (section titles, numbering
// scheme per depth, bullet usage) straight from the docx bytes and scores
// how closely the generated structure matches the template's. It is
// deliberately independent of src/lib/governance so the implementation under
// test cannot game it: nothing here reads filenames, metadata, or any
// generator internals - only word/document.xml and word/numbering.xml.
//
// Two representational styles are handled honestly, because the two sides
// encode structure differently:
//   - Real Word multilevel numbering: word/numbering.xml (abstractNum/lvl/
//     numFmt plus the num -> abstractNum map) and per-paragraph w:numPr
//     (numId + ilvl). Depth comes from ilvl (shifted under heading styles).
//   - Literal text prefixes: Heading1..6 styles (depth = level - 1) and
//     plain paragraphs whose text starts with an outline marker such as
//     "3.", "a.", "i.", "1.1", "(a)", "3)". The marker's format is
//     classified; depth for un-styled literal markers falls back to the
//     format chain (decimal -> 0, letter -> 1, roman -> 2).
//
// CLI: npx tsx scripts/lib/governance-rubric.ts <template.docx> <generated.docx>
//
// Dependencies: jszip + node builtins only. ASCII only in this file.

import JSZip from "jszip";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface DocxStructure {
  /** Ordered top-level (depth-0) section titles, numbering prefixes stripped. */
  sections: string[];
  /** depth -> dominant numbering format at that depth. The value is the
   *  numFmt name for dot-separated schemes (Word's default separator), with
   *  a ")" suffix when the level uses a paren separator instead - e.g.
   *  "decimal" for "1." and "decimal)" for "1)" - so a render that swaps
   *  the template's separator cannot score a match. */
  levelScheme: Record<number, string>;
  /** True when any list item resolves to a bullet numFmt or a bullet glyph marker. */
  hasBullets: boolean;
  /** Total structural items observed (headings + list items + literal-marker items). */
  itemCount: number;
}

export interface RubricPart {
  name: string;
  weight: number;
  score: number;
  detail: string;
}

export interface RubricResult {
  total: number;
  parts: RubricPart[];
}

/* ------------------------------------------------------------------ */
/* XML helpers (bounded, linear scans - no whole-document regex loops) */
/* ------------------------------------------------------------------ */

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(new RegExp(String.fromCharCode(0xa0), "g"), " "); // non-breaking space
}

/** Split an XML string into the bodies of every <tag ...>...</tag> element.
 *  Index-based linear scan; OOXML never nests w:p inside w:p or w:r inside
 *  w:r, so a flat forward scan is correct for the tags we use. */
function elementChunks(xml: string, tag: string): string[] {
  const open = "<" + tag;
  const close = "</" + tag + ">";
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const a = xml.indexOf(open, i);
    if (a === -1) break;
    const afterOpen = xml.charAt(a + open.length);
    // Guard against prefix collisions (e.g. <w:pPr matching <w:p).
    if (afterOpen !== " " && afterOpen !== ">" && afterOpen !== "/") {
      i = a + open.length;
      continue;
    }
    const tagEnd = xml.indexOf(">", a);
    if (tagEnd === -1) break;
    if (xml.charAt(tagEnd - 1) === "/") {
      // self-closing, empty element
      out.push("");
      i = tagEnd + 1;
      continue;
    }
    const b = xml.indexOf(close, tagEnd);
    if (b === -1) break;
    out.push(xml.slice(tagEnd + 1, b));
    i = b + close.length;
  }
  return out;
}

function attrOf(chunk: string, elem: string, attr: string): string | null {
  const at = chunk.indexOf("<" + elem);
  if (at === -1) return null;
  const end = chunk.indexOf(">", at);
  if (end === -1) return null;
  const tagText = chunk.slice(at, end + 1);
  const m = tagText.match(new RegExp(attr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '="([^"]*)"'));
  return m ? m[1] : null;
}

/* ------------------------------------------------ */
/* numbering.xml: numId -> (ilvl -> numFmt) mapping  */
/* ------------------------------------------------ */

/** Separator a numbering level renders after its number: "." or ")".
 *  Word defaults to "." when lvlText is omitted. */
function sepFromLvlText(lvlText: string | null): string {
  if (lvlText === null) return ".";
  const m = lvlText.match(/%\d+([^%]*)$/);
  const tail = m ? m[1] : "";
  return tail.includes(")") ? ")" : ".";
}

/** Serialize format + separator into one JSON-friendly scheme value.
 *  Dot (the Word default) stays the bare numFmt name; paren gets a ")"
 *  suffix. Bullet and none carry no separator. */
function schemeValue(fmt: string, sep: string): string {
  if (fmt === "bullet" || fmt === "none") return fmt;
  return sep === ")" ? fmt + ")" : fmt;
}

function parseNumbering(xml: string | null): Map<number, Map<number, string>> {
  const byNumId = new Map<number, Map<number, string>>();
  if (!xml) return byNumId;

  // abstractNumId -> (ilvl -> numFmt)
  const abstracts = new Map<number, Map<number, string>>();
  let i = 0;
  for (;;) {
    const a = xml.indexOf("<w:abstractNum ", i);
    if (a === -1) break;
    const b = xml.indexOf("</w:abstractNum>", a);
    if (b === -1) break;
    const block = xml.slice(a, b);
    const idM = block.match(/w:abstractNumId="(\d+)"/);
    if (idM) {
      const lvls = new Map<number, string>();
      // The ilvl attribute sits on the <w:lvl> open tag; scan open tags directly.
      const lvlRe = /<w:lvl [^>]*w:ilvl="(\d+)"[^>]*>/g;
      let m: RegExpExecArray | null;
      while ((m = lvlRe.exec(block))) {
        const start = m.index;
        const end = block.indexOf("</w:lvl>", start);
        const body = block.slice(start, end === -1 ? block.length : end);
        const fmtM = body.match(/<w:numFmt w:val="([^"]+)"/);
        const fmt = fmtM ? fmtM[1] : "none";
        const lvlTextM = body.match(/<w:lvlText w:val="([^"]*)"/);
        lvls.set(parseInt(m[1], 10), schemeValue(fmt, sepFromLvlText(lvlTextM ? lvlTextM[1] : null)));
      }
      abstracts.set(parseInt(idM[1], 10), lvls);
    }
    i = b + 16;
  }

  // num -> abstractNum
  const numRe = /<w:num [^>]*w:numId="(\d+)"[^>]*>/g;
  let nm: RegExpExecArray | null;
  while ((nm = numRe.exec(xml))) {
    const start = nm.index;
    const end = xml.indexOf("</w:num>", start);
    const body = xml.slice(start, end === -1 ? xml.length : end);
    const abs = body.match(/<w:abstractNumId w:val="(\d+)"/);
    if (abs) {
      const lvls = abstracts.get(parseInt(abs[1], 10));
      if (lvls) byNumId.set(parseInt(nm[1], 10), lvls);
    }
  }
  return byNumId;
}

/* -------------------------------- */
/* Literal outline marker detection */
/* -------------------------------- */

// Bullet glyphs by codepoint (kept ASCII-safe in source): 0x2022 bullet,
// 0x25e6 white bullet, 0x25aa black small square, 0x25cf black circle,
// 0x2043 hyphen bullet, 0x2219 bullet operator, plus plain "*" and "-".
const BULLET_GLYPHS = new Set([
  ...[0x2022, 0x25e6, 0x25aa, 0x25cf, 0x2043, 0x2219].map((c) => String.fromCharCode(c)),
  "*",
  "-",
]);

const ROMAN_CHARS = /^[ivxlcdm]+$/;

function romanValue(tok: string): number {
  const vals: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
  let total = 0;
  let prev = 0;
  for (let k = tok.length - 1; k >= 0; k--) {
    const v = vals[tok[k]];
    if (!v) return 0;
    if (v < prev) total -= v;
    else {
      total += v;
      prev = v;
    }
  }
  return total;
}

interface LiteralMarker {
  fmt: string; // decimal | decimalZero | lowerLetter | upperLetter | lowerRoman | upperRoman | bullet
  sep: string; // "." or ")" - the separator the marker renders after its number
  depth: number; // fallback depth from format chain
  rest: string; // text after the marker
  token: string;
}

interface MarkerContext {
  lastLowerLetter: string | null;
  lastLowerRomanValue: number | null;
  lastUpperLetter: string | null;
  lastUpperRomanValue: number | null;
}

function classifyLiteralMarker(text: string, ctx: MarkerContext): LiteralMarker | null {
  const t = text.trimStart();
  if (!t) return null;

  // Bullet glyph followed by whitespace.
  if (BULLET_GLYPHS.has(t[0]) && /\s/.test(t.charAt(1))) {
    return { fmt: "bullet", sep: ".", depth: 1, rest: t.slice(2).trimStart(), token: t[0] };
  }

  // Multi-part decimal: 1.1, 2.3.4 (with or without trailing dot)
  let m = t.match(/^(\d+(?:\.\d+)+)\.?[\s]+(\S.*)$/s);
  if (m) {
    const depth = m[1].split(".").length - 1;
    return { fmt: "decimal", sep: ".", depth, rest: m[2], token: m[1] };
  }

  let token: string;
  let rest: string;
  let sep: string;
  // (a) / (3) / (iv) style
  m = t.match(/^\(([0-9]+|[A-Za-z]+)\)[\s]+(\S.*)$/s);
  if (m) {
    token = m[1];
    rest = m[2];
    sep = ")";
  } else {
    // "3." / "3)" / "a." / "a)" / "iv." style - the separator matters
    const m2 = t.match(/^([0-9]+|[A-Za-z]+)([.)])[\s]+(\S.*)$/s);
    if (!m2) return null;
    token = m2[1];
    sep = m2[2];
    rest = m2[3];
  }

  if (/^\d+$/.test(token)) {
    const fmt = /^0\d/.test(token) ? "decimalZero" : "decimal";
    return { fmt, sep, depth: 0, rest, token };
  }

  const lower = token.toLowerCase();
  const isLower = token === lower;
  const romanish = ROMAN_CHARS.test(lower);

  if (romanish) {
    // Disambiguate letter vs roman by chain context:
    // - a single-char token continuing the previous letter chain ("i." after
    //   "h.", "v." after "u.", "x." after "w.") is a LETTER;
    // - a token continuing the previous roman chain (value + 1) is ROMAN;
    // - multi-char valid roman ("ii", "iii", "iv", ...) is ROMAN;
    // - otherwise a lone roman-char token defaults to ROMAN (a fresh "i."
    //   almost always starts a roman chain).
    const prevLetter = isLower ? ctx.lastLowerLetter : ctx.lastUpperLetter;
    const prevRoman = isLower ? ctx.lastLowerRomanValue : ctx.lastUpperRomanValue;
    const letterContinues =
      token.length === 1 &&
      prevLetter !== null &&
      prevLetter.length === 1 &&
      prevLetter.charCodeAt(0) + 1 === lower.charCodeAt(0);
    const rv = romanValue(lower);
    const romanContinues = prevRoman !== null && rv === prevRoman + 1;
    let asRoman: boolean;
    if (romanContinues && !letterContinues) asRoman = true;
    else if (letterContinues && !romanContinues) asRoman = false;
    else if (token.length > 1) asRoman = true;
    else asRoman = !letterContinues;
    if (asRoman) {
      return { fmt: isLower ? "lowerRoman" : "upperRoman", sep, depth: 2, rest, token };
    }
    return { fmt: isLower ? "lowerLetter" : "upperLetter", sep, depth: 1, rest, token };
  }

  if (token.length === 1) {
    return { fmt: isLower ? "lowerLetter" : "upperLetter", sep, depth: 1, rest, token };
  }
  return null; // multi-letter non-roman tokens ("etc") are not markers
}

function updateMarkerContext(ctx: MarkerContext, mk: LiteralMarker): void {
  const lower = mk.token.toLowerCase();
  if (mk.fmt === "lowerLetter") {
    ctx.lastLowerLetter = lower;
    ctx.lastLowerRomanValue = null;
  } else if (mk.fmt === "upperLetter") {
    ctx.lastUpperLetter = lower;
    ctx.lastUpperRomanValue = null;
  } else if (mk.fmt === "lowerRoman") {
    ctx.lastLowerRomanValue = romanValue(lower);
    ctx.lastLowerLetter = null;
  } else if (mk.fmt === "upperRoman") {
    ctx.lastUpperRomanValue = romanValue(lower);
    ctx.lastUpperLetter = null;
  }
}

/* ------------------------- */
/* Paragraph model + extract */
/* ------------------------- */

interface Run {
  bold: boolean;
  text: string;
}

function parseRuns(pBody: string): Run[] {
  const runs: Run[] = [];
  for (const rBody of elementChunks(pBody, "w:r")) {
    const prEnd = rBody.indexOf("</w:rPr>");
    const rPr = prEnd === -1 ? "" : rBody.slice(0, prEnd);
    let bold = /<w:b(?:\s[^>]*)?\/>/.test(rPr) || /<w:b(?:\s[^>]*)?>/.test(rPr);
    if (bold && /<w:b w:val="(?:0|false|none)"/.test(rPr)) bold = false;
    let text = "";
    for (const tBody of elementChunks(rBody, "w:t")) text += decodeEntities(tBody);
    if (text.length) runs.push({ bold, text });
  }
  return runs;
}

function stripLeadingMarker(text: string): string {
  const t = text.trimStart();
  let m = t.match(/^(?:\d+(?:\.\d+)*)[.)]?\s+(\S.*)$/s);
  if (m) return m[1].trim();
  m = t.match(/^\(?(?:[0-9]+|[A-Za-z]{1,4})\)?[.)]\s+(\S.*)$/s);
  if (m) return m[1].trim();
  return t.trim();
}

export async function extractDocxStructure(buf: Buffer): Promise<DocxStructure> {
  const zip = await JSZip.loadAsync(buf);
  const docFile = zip.file("word/document.xml");
  if (!docFile) throw new Error("not a docx: word/document.xml missing");
  const docXml = await docFile.async("string");
  const numFile = zip.file("word/numbering.xml");
  const numXml = numFile ? await numFile.async("string") : null;
  const numbering = parseNumbering(numXml);

  // Only the body; ignore headers/footers (they live in separate parts anyway).
  const bodyStart = docXml.indexOf("<w:body");
  const body = bodyStart === -1 ? docXml : docXml.slice(bodyStart);

  interface Item {
    depth: number;
    fmt: string; // numbering format observed for this item ("none" when unmarked heading)
    title: string;
    isBullet: boolean;
  }
  const items: Item[] = [];
  let hasBullets = false;
  let lastHeadingDepth: number | null = null;
  // Depth-0 NUMBERED items with a bold title-shaped lead act as section
  // anchors in heading-less templates (bold ListParagraph headings): bullet
  // paragraphs that follow shift below the anchor instead of landing at
  // depth 0 and polluting the section list.
  let lastBoldNumberedAnchor: number | null = null;
  const ctx: MarkerContext = {
    lastLowerLetter: null,
    lastLowerRomanValue: null,
    lastUpperLetter: null,
    lastUpperRomanValue: null,
  };

  for (const pBody of elementChunks(body, "w:p")) {
    if (!pBody) continue;
    const pPrEnd = pBody.indexOf("</w:pPr>");
    const pPr = pPrEnd === -1 ? "" : pBody.slice(0, pPrEnd);
    const style = attrOf(pPr, "w:pStyle", "w:val");
    if (style === "Title") continue; // boilerplate

    const runs = parseRuns(pBody);
    const fullText = runs.map((r) => r.text).join("").trim();

    // Title of a candidate item: when the paragraph glues a BOLD lead run to
    // a non-bold body run, the section title is the bold lead only.
    const firstPlain = runs.findIndex((r) => !r.bold && r.text.trim().length > 0);
    const hasBoldLead = runs.length > 0 && runs[0].bold && firstPlain > 0;
    const leadText = hasBoldLead
      ? runs
          .slice(0, firstPlain)
          .map((r) => r.text)
          .join("")
          .trim()
      : fullText;

    // 1) Heading styles: depth = heading level - 1.
    const hm = style ? style.match(/^Heading([1-6])$/) : null;
    if (hm) {
      const depth = parseInt(hm[1], 10) - 1;
      const mk = classifyLiteralMarker(fullText, ctx);
      const fmt = mk ? schemeValue(mk.fmt, mk.sep) : "none";
      if (mk) updateMarkerContext(ctx, mk);
      lastHeadingDepth = depth;
      items.push({ depth, fmt, title: stripLeadingMarker(leadText), isBullet: mk ? mk.fmt === "bullet" : false });
      continue;
    }

    // 2) Real Word numbering via w:numPr in the paragraph properties.
    const numIdStr = attrOf(pPr, "w:numId", "w:val");
    const numId = numIdStr ? parseInt(numIdStr, 10) : 0;
    if (numId > 0) {
      const ilvlStr = attrOf(pPr, "w:ilvl", "w:val");
      const ilvl = ilvlStr ? parseInt(ilvlStr, 10) : 0;
      const lvls = numbering.get(numId);
      const fmt = lvls ? lvls.get(ilvl) ?? "none" : "none";
      const isBullet = fmt === "bullet";
      // Under heading styles, list items nest below the last heading. In a
      // heading-less template, BULLET items nest below the last bold
      // numbered section anchor (numbered non-bullet items keep their own
      // ilvl - they share the template's multilevel scheme).
      let depth: number;
      if (lastHeadingDepth !== null) depth = lastHeadingDepth + 1 + ilvl;
      else if (isBullet && lastBoldNumberedAnchor !== null) depth = lastBoldNumberedAnchor + 1 + ilvl;
      else depth = ilvl;
      if (isBullet) hasBullets = true;
      if (fullText.length === 0) continue; // empty numbered paragraph: not structure
      if (!isBullet && depth === 0) {
        // Anchor only on a bold title-shaped lead (glued bold heading or a
        // fully bold short title); numbered non-bold body items never anchor.
        const allBold = runs.length > 0 && runs.every((r) => r.bold || r.text.trim().length === 0);
        const titleShaped = (hasBoldLead || allBold) && leadText.length > 0 && leadText.length <= 100;
        if (titleShaped) lastBoldNumberedAnchor = depth;
      }
      items.push({ depth, fmt, title: stripLeadingMarker(leadText), isBullet });
      continue;
    }

    // 3) Un-styled paragraph with a literal outline marker.
    if (fullText.length === 0) continue;
    const mk = classifyLiteralMarker(fullText, ctx);
    if (mk) {
      updateMarkerContext(ctx, mk);
      if (mk.fmt === "bullet") hasBullets = true;
      const leadStripped = hasBoldLead ? stripLeadingMarker(leadText) : stripLeadingMarker(fullText);
      items.push({
        depth: mk.depth,
        fmt: schemeValue(mk.fmt, mk.sep),
        title: leadStripped,
        isBullet: mk.fmt === "bullet",
      });
      continue;
    }
    // Plain body / disclaimer / notice paragraph: not a structural item.
  }

  // Sections: depth-0 items, ignoring anything before the first depth-0 item.
  const firstTop = items.findIndex((it) => it.depth === 0);
  const sections =
    firstTop === -1
      ? []
      : items
          .slice(firstTop)
          .filter((it) => it.depth === 0)
          .map((it) => it.title)
          .filter((t) => t.length > 0);

  // Dominant format per depth (ties resolved by first occurrence).
  const counts = new Map<number, Map<string, number>>();
  const firstSeen = new Map<number, string[]>();
  for (const it of items) {
    if (!counts.has(it.depth)) {
      counts.set(it.depth, new Map());
      firstSeen.set(it.depth, []);
    }
    const c = counts.get(it.depth)!;
    c.set(it.fmt, (c.get(it.fmt) ?? 0) + 1);
    const order = firstSeen.get(it.depth)!;
    if (!order.includes(it.fmt)) order.push(it.fmt);
  }
  const levelScheme: Record<number, string> = {};
  for (const [depth, c] of counts) {
    let best = "none";
    let bestN = -1;
    for (const fmt of firstSeen.get(depth)!) {
      const n = c.get(fmt)!;
      if (n > bestN) {
        bestN = n;
        best = fmt;
      }
    }
    levelScheme[depth] = best;
  }

  return { sections, levelScheme, hasBullets, itemCount: items.length };
}

/* -------- */
/* Scoring  */
/* -------- */

function canon(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function lcsLength(a: string[], b: string[]): number {
  const n = a.length;
  const m = b.length;
  if (!n || !m) return 0;
  let prev = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    const cur = new Array<number>(m + 1).fill(0);
    for (let j = 1; j <= m; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[m];
}

export function scoreStructureMatch(template: DocxStructure, generated: DocxStructure): RubricResult {
  // Degenerate structures never match: a side with zero sections AND zero
  // observed numbering levels carries no measurable structure, so nothing
  // can be scored (an empty render must not collect the bullet part for
  // free, and empty-vs-empty is measurement-invalid, not a match).
  const degenerate = (s: DocxStructure) =>
    s.sections.length === 0 && Object.keys(s.levelScheme).length === 0;
  if (degenerate(template) || degenerate(generated)) {
    const sides =
      degenerate(template) && degenerate(generated)
        ? "both documents yield"
        : degenerate(template)
          ? "the template yields"
          : "the generated document yields";
    const detail = `measurement invalid: ${sides} no observed structure (no sections, no numbered levels)`;
    return {
      total: 0,
      parts: [
        { name: "section set and order", weight: 0.4, score: 0, detail },
        { name: "numbering scheme per level", weight: 0.4, score: 0, detail },
        { name: "no foreign list styles", weight: 0.2, score: 0, detail },
      ],
    };
  }

  const parts: RubricPart[] = [];

  // Part 1: section set and order (0.40)
  const t = template.sections.map(canon);
  const g = generated.sections.map(canon);
  let sectionScore: number;
  let sectionDetail: string;
  const exact = t.length === g.length && t.every((s, i) => s === g[i]);
  if (t.length === 0 && g.length === 0) {
    sectionScore = 1;
    sectionDetail = "no sections on either side";
  } else if (exact) {
    sectionScore = 1;
    sectionDetail = `exact match on ${t.length} sections in order`;
  } else {
    const setT = new Set(t);
    const setG = new Set(g);
    let inter = 0;
    for (const s of setT) if (setG.has(s)) inter++;
    const union = new Set([...setT, ...setG]).size;
    const jaccard = union === 0 ? 0 : inter / union;
    const lcs = lcsLength(t, g);
    const lcsRatio = Math.max(t.length, g.length) === 0 ? 0 : lcs / Math.max(t.length, g.length);
    sectionScore = 0.5 * jaccard + 0.5 * lcsRatio;
    sectionDetail = `template ${t.length} vs generated ${g.length}; overlap ${inter}/${union} (jaccard ${jaccard.toFixed(3)}), lcs ${lcs} (ratio ${lcsRatio.toFixed(3)})`;
  }
  parts.push({ name: "section set and order", weight: 0.4, score: sectionScore, detail: sectionDetail });

  // Part 2: numbering scheme per level (0.40), over depths observed in the
  // template. A generated format that conflicts at a template-observed depth
  // fails that depth; generated-only deeper levels are not penalized.
  const tDepths = Object.keys(template.levelScheme)
    .map(Number)
    .sort((a, b) => a - b);
  let levelScore: number;
  let levelDetail: string;
  if (tDepths.length === 0) {
    levelScore = 1;
    levelDetail = "template observes no numbered depths";
  } else {
    let matched = 0;
    const per: string[] = [];
    for (const d of tDepths) {
      const want = template.levelScheme[d];
      const got = generated.levelScheme[d] ?? "(absent)";
      const ok = got === want;
      if (ok) matched++;
      per.push(`d${d}: ${want} vs ${got}${ok ? "" : " MISMATCH"}`);
    }
    levelScore = matched / tDepths.length;
    levelDetail = per.join("; ");
  }
  parts.push({ name: "numbering scheme per level", weight: 0.4, score: levelScore, detail: levelDetail });

  // Part 3: no foreign list styles (0.20)
  const bulletsOk = generated.hasBullets ? template.hasBullets : true;
  parts.push({
    name: "no foreign list styles",
    weight: 0.2,
    score: bulletsOk ? 1 : 0,
    detail: bulletsOk
      ? `bullets: template=${template.hasBullets} generated=${generated.hasBullets} (compatible)`
      : "generated uses bullets but the template has none",
  });

  let total = 0;
  for (const p of parts) total += p.weight * p.score;
  total = Math.min(1, Math.max(0, total));
  return { total, parts };
}

/* ---------- */
/* CLI entry  */
/* ---------- */

function isMainModule(): boolean {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    return import.meta.url === pathToFileURL(fs.realpathSync(path.resolve(argv1))).href;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const [tplPath, genPath] = process.argv.slice(2);
  if (!tplPath || !genPath) {
    console.error("usage: npx tsx scripts/lib/governance-rubric.ts <template.docx> <generated.docx>");
    process.exit(2);
  }
  const tpl = await extractDocxStructure(fs.readFileSync(tplPath));
  const gen = await extractDocxStructure(fs.readFileSync(genPath));

  const show = (label: string, s: DocxStructure) => {
    console.log(`\n${label}`);
    console.log(`  sections (${s.sections.length}): ${s.sections.map((x) => JSON.stringify(x)).join(", ")}`);
    console.log(
      `  levelScheme: ${Object.entries(s.levelScheme)
        .map(([d, f]) => `${d}=${f}`)
        .join(" ")}`
    );
    console.log(`  hasBullets: ${s.hasBullets}   itemCount: ${s.itemCount}`);
  };
  show("TEMPLATE", tpl);
  show("GENERATED", gen);

  const result = scoreStructureMatch(tpl, gen);
  console.log("\nRUBRIC");
  for (const p of result.parts) {
    console.log(`  ${p.name}  weight=${p.weight}  score=${p.score.toFixed(3)}`);
    console.log(`    ${p.detail}`);
  }
  console.log(`\nTOTAL: ${result.total.toFixed(3)}`);
}

if (isMainModule()) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
