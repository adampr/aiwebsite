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
// Single letters ("A.") are deliberately NOT stripped here: "A. Smith
// Policy" is a legitimate title shape, and a lone title/heading has no peer
// context to prove the letter is a marker. Mirrored letter RUNS are handled
// by the guarded paths instead (round 18c): promoteManualHeadingLines for
// bare lines, alphaHeadingRun for real "#" headings.
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
 * Manual-heading promotion (§5.12 round 16b). Restyle/auto-reformat turns
 * mirror a format sample's literal numbers into stored markdown as bare
 * lines ("3.1 Data handling") with no "#": the paragraph parser then glues
 * them into the preceding paragraph, so the number renders inline with body
 * text. This pre-parse pass promotes such lines to real headings; it runs
 * inside parseMarkdown so both renderers inherit it and stored drifted
 * documents self-heal at render time. The manual number is removed at
 * promotion (the host label replaces it downstream), which keeps the
 * one-numbering-authority invariant even when reveal sentinels sit between
 * the line start and the number.
 *
 * Promotable shapes: multipart decimals ("3.1", "2.1.4."), uppercase romans
 * ("IV."), "Section 2:", and (round 18c) single uppercase LETTERS ("B.",
 * "C)") under the run guard below. Bare "1." / "1)" is ordered-list
 * territory and never promotes. The remainder must be title-shaped: <=100
 * chars, opening char uppercase or one of ["'( (the [ keeps "3.1 [TO
 * CONFIRM: ...]" promotable), and no terminal punctuation - so "2.5 GB of
 * logs are retained." and soft-wrapped continuations starting lowercase are
 * left exactly as written; body numbers are content, never stripped or
 * re-flowed. Single-letter romans ("V.") promote only when a multi-letter
 * roman heading ("III.") exists in the same section OR they sit in a letter
 * run ("H. I. J."), so "V. Smith reviewed the policy" stays prose. Lines
 * carrying mid-reveal sentinels (old-strike/caret) never promote: a heading
 * must not flicker into existence while the reveal is still typing.
 *
 * Alpha run guard (round 18c): letters promote only in chains of >= 2 lines
 * with strictly consecutive letters (B -> C), the SAME separator, and at
 * least one non-blank NON-marker content line between members. Each rule
 * kills a named prose class: consecutiveness kills scattered name titles
 * ("A. Smith Policy" ... "J. Edgar Hoover"); same-separator kills
 * coincidence pairs ("B. x" + "C) y"); the between-content rule kills
 * lettered ENUMERATIONS ("A. Email\nB. Chat logs\nC. Financial records" -
 * adjacent lettered lines are list-shaped content, while mirrored headings
 * always have body text between them); a per-line initials test kills
 * abbreviation chains ("U. S. obligations"). Chain membership is computed
 * on a sentinel-STRIPPED shadow of each line and tolerates members that are
 * themselves unpromotable (punctuated, mid-reveal, washed): such lines keep
 * their place as links so one suppressed member never unpromotes its
 * neighbours across reveal ticks. Accepted residual (pinned): consecutive
 * initial-led name lines separated by content ("J. Doe" / "K. Lee" rosters)
 * promote - same risk profile the roman peer rule accepted. A LONE mirrored
 * letter (one marker in the whole section) never promotes - known
 * limitation; the motivating corpus (sample-mirrored lettered sub-headings)
 * arrives in runs.
 * ------------------------------------------------------------------ */

const PROMOTE_MULTI = /^(\d{1,3}(?:\.\d{1,3}){1,4})\.?\s{1,10}/;
const PROMOTE_ROMAN = /^((?=[IVX])X{0,3}(?:IX|IV|V?I{1,3}|V|X))([.)])\s{1,10}/;
const PROMOTE_SECTION = /^Section\s{1,4}\d{1,3}\s{0,4}[:.)-]\s{1,10}/;
const PROMOTE_ALPHA = /^([A-Z])([.)])\s{1,10}/;
const MID_REVEAL_SENTINEL = /[\uE002-\uE005]/; // old-strike + carets
const WASH_SENTINELS = /^[\uE000\uE001]{1,4}/; // settled resolved wash
// Every reveal sentinel the doc pane can splice in (wash, strike, carets,
// region wash): stripped before CHAIN-link detection so a mid-animation
// member keeps its place in a letter run.
const ALL_SENTINELS = /[\uE000-\uE007]/g;
// A second single-letter marker right after the first = abbreviation chain
// ("U. S. obligations", "J. E. Hoover memo"), never a heading.
const INITIALS_CHAIN = /^[A-Z][.)]\s/;

type Promotion = {
  line: string; // rebuilt heading line, manual number removed
  roman: boolean; // matched via the roman shape
  loneRoman: boolean; // "I."/"V."/"X.": needs a multi-letter roman peer
  alpha: { letter: string; sep: string } | null; // needs a letter-run peer
};

function classifyPromotable(trimmed: string): Promotion | null {
  if (!trimmed || MID_REVEAL_SENTINEL.test(trimmed)) return null;
  // Structural lines are never touched: existing headings, tables, lists.
  if (/^#{1,4}\s/.test(trimmed) || trimmed.startsWith("|")) return null;
  if (/^[-*]\s/.test(trimmed)) return null;
  const lead = (WASH_SENTINELS.exec(trimmed) ?? [""])[0];
  let core = trimmed.slice(lead.length);
  const emph = (/^\*{1,2}/.exec(core) ?? [""])[0];
  core = core.slice(emph.length);
  let hashes: number;
  let roman = false;
  let loneRoman = false;
  let alpha: { letter: string; sep: string } | null = null;
  let m = PROMOTE_MULTI.exec(core);
  if (m) {
    hashes = Math.min(m[1].split(".").length, 4);
  } else if ((m = PROMOTE_ROMAN.exec(core))) {
    hashes = 2;
    roman = true;
    loneRoman = m[1].length === 1;
    // A lone I./V./X. is also a letter: it may promote as a run member
    // ("H. I. J.") even with no multi-letter roman peer.
    if (loneRoman) alpha = { letter: m[1], sep: m[2] };
  } else if ((m = PROMOTE_SECTION.exec(core))) {
    hashes = 2;
  } else if ((m = PROMOTE_ALPHA.exec(core))) {
    hashes = 2;
    alpha = { letter: m[1], sep: m[2] };
  } else return null;
  const rest = core.slice(m[0].length);
  // Title test runs on the visible text: trailing wash sentinels and one
  // emphasis closer come off first ("**2.5 GB ... retained.**" must fail on
  // its ".", not pass on its "*").
  const bare = rest
    .replace(/[\uE000\uE001]{1,4}$/, "")
    .replace(/\*{1,2}$/, "")
    .replace(/[\uE000\uE001]{1,4}$/, "");
  if (!bare || bare.length > 100) return null;
  if (!/^["'([A-Z]/.test(bare)) return null;
  if (/[.,:;!?]$/.test(bare)) return null;
  if (alpha && INITIALS_CHAIN.test(bare)) {
    if (!roman) return null; // "U. S. obligations": never a heading
    alpha = null; // "V. P. approval required": roman semantics only
  }
  return {
    line: `${"#".repeat(hashes)} ${lead}${emph}${rest}`,
    roman,
    loneRoman,
    alpha,
  };
}

/** Chain-link detection for the alpha run guard: any single-letter marker
 *  on the sentinel-STRIPPED line, regardless of title shape. Punctuated,
 *  washed, or mid-reveal member lines keep their place as LINKS in a letter
 *  chain (so one suppressed member never unpromotes its neighbours across
 *  reveal ticks); classifyPromotable alone decides what actually promotes. */
function chainLetter(rawLine: string): { letter: string; sep: string } | null {
  const shadow = rawLine.replace(ALL_SENTINELS, "").trim();
  if (!shadow || /^#{1,4}\s/.test(shadow) || shadow.startsWith("|")) return null;
  if (/^[-*]\s/.test(shadow)) return null;
  const core = shadow.slice((/^\*{1,2}/.exec(shadow) ?? [""])[0].length);
  const m = /^([A-Z])([.)])\s{1,10}(?=\S)/.exec(core);
  if (!m) return null;
  if (INITIALS_CHAIN.test(core.slice(m[0].length))) return null;
  return { letter: m[1], sep: m[2] };
}

/**
 * Promote bare manually-numbered heading lines to markdown headings.
 * Idempotent: promoted lines start with "#" and are skipped on re-entry
 * (and alpha chain links vanish with their markers, so a second pass sees
 * no runs). Insert-only per line - never merges, splits, or re-flows body
 * text.
 */
export function promoteManualHeadingLines(md: string): string {
  // Gate is width, not depth: an all-letters section ("B. Data Handling")
  // has no digit and no I/V/X, so the old /[\dIVX]/ gate silently disabled
  // alpha promotion (round 18c).
  if (!/[0-9A-Z]/.test(md)) return md;
  const lines = md.split("\n");
  const found = lines.map((l) => classifyPromotable(l.trim()));
  const multiRomanPeer = found.some((p) => p !== null && p.roman && !p.loneRoman);

  // Letter runs: indexes of chain links whose maximal chain has >= 2
  // members. Links chain when letters are strictly consecutive, separators
  // match, and at least one non-blank non-link content line sits between
  // them (adjacent lettered lines are enumeration-shaped, never headings).
  const chain = lines.map(chainLetter);
  const idxs: number[] = [];
  for (let i = 0; i < chain.length; i++) if (chain[i]) idxs.push(i);
  const linked = (aIdx: number, bIdx: number): boolean => {
    const a = chain[aIdx]!;
    const b = chain[bIdx]!;
    if (b.letter.charCodeAt(0) !== a.letter.charCodeAt(0) + 1) return false;
    if (b.sep !== a.sep) return false;
    for (let k = aIdx + 1; k < bIdx; k++)
      if (lines[k].trim() && !chain[k]) return true;
    return false;
  };
  const runMember = new Set<number>();
  let runStart = 0;
  for (let c = 1; c <= idxs.length; c++) {
    if (c === idxs.length || !linked(idxs[c - 1], idxs[c])) {
      if (c - runStart >= 2)
        for (let r = runStart; r < c; r++) runMember.add(idxs[r]);
      runStart = c;
    }
  }

  // Letters need a run peer; lone romans need a multi-letter roman peer OR
  // a run; every other shape promotes on its own.
  const promotes = (p: Promotion, i: number): boolean => {
    if (p.alpha && runMember.has(i)) return true;
    if (p.loneRoman) return multiRomanPeer;
    return !p.alpha;
  };
  let changed = false;
  const out = lines.map((line, i) => {
    const p = found[i];
    if (!p || !promotes(p, i)) return line;
    changed = true;
    return p.line;
  });
  return changed ? out.join("\n") : md;
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

/** Compound base for a NESTED section's inner headings and its own label
 * (§5.12 round 18b skeleton adoption): bucket 5, section 2 -> "5.2", so
 * that section's inner headings run "5.2.1", "5.2.2". sub null = the
 * top-level base, identical to the flat document's. */
export function nestedBaseLabel(
  num: number,
  sub: number | null,
  style: NumberingStyle | null = null
): string {
  const base = subPrefix(num, style ?? "decimal");
  return sub === null ? base : `${base}.${sub}`;
}

/** Title line of a section nested under a skeleton bucket: "5.2 Data
 * handling" ("V.2 ...", etc.). No trailing dot, matching the established
 * inner-heading label shape. */
export function nestedSectionTitleText(
  num: number,
  sub: number,
  title: string,
  style: NumberingStyle | null = null
): string {
  return `${nestedBaseLabel(num, sub, style)} ${stripLeadingNumber(title.trim())}`;
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
  ["section-word", /^Section\s{1,4}\d{1,3}\s{0,4}[:.)\u2013-]/i],
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
 * HEADING lines ("#" prefixes: real Word heading styles, Word numbering
 * reconstruction, PDF font-height inference, PDF bookmarks) are the
 * authoritative channel: when at least two heading lines carry a marker,
 * only heading votes decide. Body lines decide only when headings carry no
 * signal at all (typed numbers in flat .txt/.md samples) : otherwise a
 * document's ordinary numbered LISTS (reconstructed "1." items, round 15d)
 * would outvote its roman/section-word headings and poison the style
 * (critic counterexamples: roman self-defeat, section-word -> decimal
 * regression). Sub-numbered lines ("3.1 Scope") are skipped entirely.
 * Null = no channel produced two matching lines and a strict win; the
 * renderers keep the decimal default.
 */
export function detectNumberingStyle(text: string): NumberingStyle | null {
  const headVotes = new Map<NumberingStyle, number>();
  const headLines = new Map<NumberingStyle, number>();
  const bodyLines = new Map<NumberingStyle, number>();
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
      if (heading) {
        headVotes.set(style, (headVotes.get(style) ?? 0) + 1);
        headLines.set(style, (headLines.get(style) ?? 0) + 1);
      } else bodyLines.set(style, (bodyLines.get(style) ?? 0) + 1);
      break;
    }
  }
  // The two-LINE floor keeps one stray marker (a lone "I. Introduction"
  // heading) from restyling a document; priority breaks ties toward the
  // more deliberate marker shapes.
  const pick = (
    votes: Map<NumberingStyle, number>,
    lines: Map<NumberingStyle, number>
  ): NumberingStyle | null => {
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
  };
  return pick(headVotes, headLines) ?? pick(bodyLines, bodyLines);
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

/* Guarded alpha strip for real "#" headings (round 18c): a mirrored
 * lettered heading SET ("## B. Data" ... "## C. Access") sheds its letters
 * before host labels are prepended (no more "3.1 B. Data" doubling), while
 * a lone "## A. Smith Policy" keeps its name - same no-peer-no-strip logic
 * as promotion. Ascending letters with gaps allowed (the model may mirror
 * B and D when C had no corresponding content): heading-ness is already
 * established here, unlike bare-line promotion which demands strict +1. */

// Marker as an inline-text prefix ("B. Scope") or as a whole node
// ("**B.** Scope" parses as bold "B." + text " Scope").
const ALPHA_PREFIX = /^([A-Z])([.)])\s{1,10}(?=\S)/;
const ALPHA_NODE = /^([A-Z])([.)])\s{0,10}$/;

function headingAlphaMarker(
  b: Block
): { letter: string; sep: string } | null {
  if (b.t !== "heading") return null;
  const first = b.inline[0];
  if (!first) return null;
  let m = ALPHA_NODE.exec(first.text);
  if (m && b.inline.length > 1) return { letter: m[1], sep: m[2] };
  m = ALPHA_PREFIX.exec(first.text);
  if (!m || INITIALS_CHAIN.test(first.text.slice(m[0].length))) return null;
  return { letter: m[1], sep: m[2] };
}

/** Block indexes of headings whose leading letter sits in an ascending
 *  same-separator letter run of >= 2 headings. */
function alphaHeadingRun(blocks: Block[]): Set<number> {
  const marks: { idx: number; letter: string; sep: string }[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const m = headingAlphaMarker(blocks[i]);
    if (m) marks.push({ idx: i, ...m });
  }
  const out = new Set<number>();
  let start = 0;
  for (let c = 1; c <= marks.length; c++) {
    if (
      c === marks.length ||
      marks[c].letter.charCodeAt(0) <= marks[c - 1].letter.charCodeAt(0) ||
      marks[c].sep !== marks[c - 1].sep
    ) {
      if (c - start >= 2)
        for (let r = start; r < c; r++) out.add(marks[r].idx);
      start = c;
    }
  }
  return out;
}

function stripAlphaMarker(inline: Inline[]): Inline[] {
  const first = inline[0];
  if (!first) return inline;
  if (inline.length > 1 && ALPHA_NODE.test(first.text)) {
    // Whole-node husk: drop it and the space it owned in the next node.
    const rest = inline.slice(1);
    if (rest[0]?.t === "text")
      rest[0] = { ...rest[0], text: rest[0].text.replace(/^\s{1,10}/, "") };
    return rest;
  }
  const stripped = first.text.replace(ALPHA_PREFIX, "");
  if (stripped === first.text) return inline;
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
  style: NumberingStyle | null = null,
  // Skeleton adoption (round 18b): a nested section's inner headings hang
  // off its compound label ("5.2" -> "5.2.1") instead of its ordinal.
  baseLabel: string | null = null
): Block[] {
  let min = Infinity;
  for (const b of blocks) if (b.t === "heading" && b.level < min) min = b.level;
  let c1 = 0;
  let c2 = 0;
  // Sub-headings hang off the section's styled ordinal ("III.1", "C.2");
  // decimal styles keep today's "3.1" exactly.
  const base = baseLabel ?? subPrefix(sectionNum, style ?? "decimal");
  const alphaRun = alphaHeadingRun(blocks);
  return blocks.map((b, bi): Block => {
    if (b.t !== "heading") return b;
    const depth = b.level - min;
    let inline = stripInlineNumber(b.inline);
    if (alphaRun.has(bi)) inline = stripAlphaMarker(inline);
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
