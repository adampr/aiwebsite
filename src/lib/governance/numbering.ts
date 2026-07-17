// Host-owned document numbering (§5.12). Drafting edits one section at a
// time with the rest of the draft elided, so the model can never keep manual
// numbers consistent across sections; the host numbers instead. Both
// renderers (the React doc pane and the .docx generator) run this pass on
// parseMarkdown output, so web and Word stay identical, and normalizing at
// render time means stored documents with drifted manual numbers clean up
// without regeneration. Client-safe: no node imports; bounded quantifiers.

import type { Block, Inline } from "./markdown";

// Unambiguous manual section-number prefixes only: "3. Title", "3) Title",
// "3.1 Title", "1.2.3. Title", plus (numbering-style adoption, round 15b)
// "IV. Title" roman runs and "Section 3:" word prefixes the model might echo
// from a styled render. A dotted multipart number, or a short number
// with a "." / ")" separator, followed by a letter or an opening quote,
// bracket, or paren ('3.1 "Quoted"', "3.1 [TO CONFIRM: ...]"). "30 days
// notice" (no separator) and "2026 Budget" (four digits, no separator)
// never match: the separator requirement guards those, not the lookahead.
// Single letters ("A.") are deliberately NOT stripped: "A. Smith Policy" is
// a legitimate title shape and the model is forbidden alpha markers anyway.
const NUM_PREFIX =
  /^(?:\d{1,3}(?:\.\d{1,3}){1,4}\.?|\d{1,3}[.)]|(?=[IVX])X{0,3}(?:IX|IV|V?I{1,3}|V|X)[.)]|Section\s{1,4}\d{1,3}\s{0,4}[:.)-])\s{1,10}(?=["'([A-Za-z])/;

// Same number shapes when they are an entire inline node ("3.1 **Scope**"
// parses as text "3.1 " + bold "Scope": the letter lookahead above can never
// see across nodes, so a whole-node number is matched separately).
const NUM_ONLY =
  /^(?:\d{1,3}(?:\.\d{1,3}){1,4}\.?|\d{1,3}[.)]|(?=[IVX])X{0,3}(?:IX|IV|V?I{1,3}|V|X)[.)]|Section\s{1,4}\d{1,3}\s{0,4}[:.)-])\s{0,10}$/;

/** Strip a manual section-number prefix from a title or heading line. */
export function stripLeadingNumber(text: string): string {
  return text.replace(NUM_PREFIX, "");
}

/* ------------------------------------------------------------------ *
 * Numbering-style adoption (§5.12 round 15b). The host stays the ONE
 * numbering authority (the model still never writes numbers); what the
 * format sample changes is the STYLE the host renders in. The style is
 * DERIVED from the stored sample text wherever it is needed (view.ts for
 * the doc pane, the download route for docx) and never persisted, so
 * existing projects with samples adopt it on their next load.
 * ------------------------------------------------------------------ */

export type NumberingStyle =
  | "decimal" // 3. Title      (the default; today's rendering)
  | "decimal-zero" // 3.0 Title
  | "paren" // 3) Title
  | "roman" // III. Title
  | "alpha" // C. Title
  | "section-word"; // Section 3: Title

const ROMAN: [number, string][] = [
  [10, "X"],
  [9, "IX"],
  [5, "V"],
  [4, "IV"],
  [1, "I"],
];

function toRoman(n: number): string {
  let out = "";
  let left = Math.max(1, Math.min(n, 39));
  for (const [v, s] of ROMAN)
    while (left >= v) {
      out += s;
      left -= v;
    }
  return out;
}

/** The section's ordinal in the given style, no title: "3" / "3.0" / "III" /
 *  "C" / "Section 3". Sub-heading labels build on subPrefix below. */
function ordinalLabel(n: number, style: NumberingStyle): string {
  switch (style) {
    case "decimal-zero":
      return `${n}.0`;
    case "roman":
      return toRoman(n);
    case "alpha":
      return n >= 1 && n <= 26 ? String.fromCharCode(64 + n) : String(n);
    case "section-word":
      return `Section ${n}`;
    default:
      return String(n);
  }
}

/** The prefix sub-headings hang off ("III" -> "III.1", "3.0" -> "3.1"):
 *  the styled ordinal, except decimal-zero whose children drop the ".0". */
function subPrefix(n: number, style: NumberingStyle): string {
  if (style === "decimal-zero" || style === "section-word") return String(n);
  return ordinalLabel(n, style);
}

/** Section title as rendered in both panes: "3. Data handling",
 *  "III. Data handling", "Section 3: Data handling". */
export function sectionTitleText(
  num: number,
  title: string,
  style: NumberingStyle | null = null
): string {
  const s = style ?? "decimal";
  const clean = stripLeadingNumber(title.trim());
  if (s === "section-word") return `Section ${num}: ${clean}`;
  if (s === "paren") return `${ordinalLabel(num, s)}) ${clean}`;
  if (s === "decimal-zero") return `${ordinalLabel(num, s)} ${clean}`;
  return `${ordinalLabel(num, s)}. ${clean}`;
}

// Heading-shaped line starts that vote for a style. Sub-numbers ("3.1") vote
// for nothing: every style here renders decimal sub-numbers, so they carry
// no signal. All quantifiers bounded (this runs over user-controlled text).
const DETECTORS: [NumberingStyle, RegExp][] = [
  ["section-word", /^Section\s{1,4}\d{1,3}\s{0,4}[:.)–-]/i],
  ["decimal-zero", /^\d{1,3}\.0(?:\s|$)/],
  ["decimal", /^\d{1,3}\.\s{1,10}\S/],
  ["paren", /^\d{1,3}\)\s{1,10}\S/],
  ["roman", /^(?=[IVX])X{0,3}(?:IX|IV|V?I{1,3}|V|X)[.)]\s{1,10}["'([A-Za-z]/],
  ["alpha", /^[A-Z][.)]\s{1,10}["'([A-Z]/],
];

// Ties break by specificity: a template whose headings say "Section 3" or
// "3.0" is unambiguous about intent; bare "3." is the weakest signal.
const STYLE_PRIORITY: NumberingStyle[] = [
  "section-word",
  "decimal-zero",
  "roman",
  "alpha",
  "paren",
  "decimal",
];

/**
 * Detect the sample's section-numbering style from its extracted text.
 * Heading lines (markdown "#" prefixes: real Word heading styles, or the
 * PDF font-height inference) vote with triple weight; short body lines
 * vote once (typed numbers in flat .txt/.md samples). Sub-numbered lines
 * ("3.1 Scope") are skipped entirely. Null = no style reached two votes
 * and a strict win, and the renderers keep the decimal default. Known
 * limitation: Word AUTO-numbering lives in numbering.xml, not the text,
 * so only typed numbers (and PDF/md/txt) carry a signal.
 */
export function detectNumberingStyle(text: string): NumberingStyle | null {
  const votes = new Map<NumberingStyle, number>();
  const lines = new Map<NumberingStyle, number>();
  let seen = 0;
  for (const raw of text.split("\n")) {
    if (++seen > 4000) break;
    const heading = /^#{1,6}\s/.test(raw);
    const t = raw.replace(/^#{1,6}\s{1,10}/, "").trim();
    if (!t || t.length > 120) continue;
    if (/^\d{1,3}\.\d{1,3}[.\s]/.test(t) && !/^\d{1,3}\.0(?:\s|$)/.test(t))
      continue; // sub-number: no signal
    for (const [style, re] of DETECTORS) {
      if (!re.test(t)) continue;
      // Body-line alpha matches are ignored wholesale: initials and
      // lettered inline clauses make body text too noisy for that style.
      if (!heading && style === "alpha") break;
      votes.set(style, (votes.get(style) ?? 0) + (heading ? 3 : 1));
      lines.set(style, (lines.get(style) ?? 0) + 1);
      break;
    }
  }
  // Weighted votes RANK the styles; the two-LINE floor keeps one stray
  // marker (a lone "I. Introduction" heading) from restyling a document.
  let best: NumberingStyle | null = null;
  let bestVotes = 0;
  for (const style of STYLE_PRIORITY) {
    const v = votes.get(style) ?? 0;
    if (v > bestVotes) {
      best = style;
      bestVotes = v;
    }
  }
  return best !== null && (lines.get(best) ?? 0) >= 2 ? best : null;
}

function stripInlineNumber(inline: Inline[]): Inline[] {
  const first = inline[0];
  if (!first) return inline;
  if (inline.length > 1 && NUM_ONLY.test(first.text)) return inline.slice(1);
  const stripped = stripLeadingNumber(first.text);
  if (stripped === first.text) return inline;
  if (!stripped) return inline.slice(1);
  return [{ ...first, text: stripped }, ...inline.slice(1)];
}

/**
 * Normalize one section's blocks under its host-assigned number:
 * - strip manual number prefixes from headings,
 * - number the top two inner heading levels ("3.1", "3.1.1"; deeper levels
 *   stay unnumbered),
 * - rebase heading depth to the shallowest level used in the section, so a
 *   section written entirely in "###" renders exactly like one in "#".
 * Levels in the result are relative: 1 = first level under the section
 * title. Renderers map them below the section-title style.
 */
export function normalizeSectionBlocks(
  blocks: Block[],
  sectionNum: number,
  style: NumberingStyle | null = null
): Block[] {
  let min = Infinity;
  for (const b of blocks) if (b.t === "heading" && b.level < min) min = b.level;
  let c1 = 0;
  let c2 = 0;
  // Sub-headings hang off the section's styled ordinal ("III.1", "C.2");
  // decimal styles keep today's "3.1" exactly.
  const base = subPrefix(sectionNum, style ?? "decimal");
  return blocks.map((b): Block => {
    if (b.t !== "heading") return b;
    const depth = b.level - min;
    const inline = stripInlineNumber(b.inline);
    let label = "";
    if (depth === 0) {
      c1++;
      c2 = 0;
      label = `${base}.${c1} `;
    } else if (depth === 1 && c1 > 0) {
      c2++;
      label = `${base}.${c1}.${c2} `;
    }
    return {
      t: "heading",
      level: (Math.min(depth, 3) + 1) as 1 | 2 | 3 | 4,
      inline: label ? [{ t: "text", text: label }, ...inline] : inline,
    };
  });
}
