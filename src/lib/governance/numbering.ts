// Host-owned document numbering (§5.12). Drafting edits one section at a
// time with the rest of the draft elided, so the model can never keep manual
// numbers consistent across sections; the host numbers instead. Both
// renderers (the React doc pane and the .docx generator) run this pass on
// parseMarkdown output, so web and Word stay identical, and normalizing at
// render time means stored documents with drifted manual numbers clean up
// without regeneration. Client-safe: no node imports; bounded quantifiers.

import type { Block, Inline, ListFormat } from "./markdown";

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
// ".7.1 Title": multipart number missing its leading component (a bad-PDF
// extraction artifact the model mirrors). >=2 numeric parts, so a wrapped
// decimal fragment (".5 GB") never matches; whitespace CONSUMED so the
// remainder starts at the title (round 19 critic fix).
const ORPHAN_DOT_PROMOTE = /^\.(\d{1,3}(?:\.\d{1,3}){1,3})\.?\s{1,10}/;
const ORPHAN_DOT_PREFIX = /^\.\d{1,3}(?:\.\d{1,3}){1,3}\.?\s{1,10}(?=\S)/;
const ORPHAN_DOT_ONLY = /^\.\d{1,3}(?:\.\d{1,3}){1,3}\.?\s{0,10}$/;
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
// Case-widened variant shared with the markdown parser's lettered-list rule
// (round 19): "b. v. Wade case" is an abbreviation chain too.
const INITIALS_CHAIN_ANY = /^[A-Za-z][.)]\s/;

/** True when the text AFTER a single-letter marker opens with another
 *  single-letter marker - an initials/abbreviation chain, never a list item
 *  or heading. Shared by classifyPromotable (uppercase context) and the
 *  markdown parser (any case). */
export function isInitialsRest(rest: string): boolean {
  return INITIALS_CHAIN_ANY.test(rest);
}

/* ------------------------------------------------------------------ *
 * Orphan number-line drop (§5.12 round 19). Badly extracted PDF samples
 * teach the model to write Word auto-number labels as their own lines
 * ("5." alone, no content); those lines are pure numbering artifacts -
 * never content - and glue into paragraphs or strand as one-line blocks.
 * Dropped at render time inside parseMarkdown (both renderers, stored
 * drafts self-heal). GUARDS: the line's sentinel-stripped trim must be
 * EXACTLY "N." / "N)" (N <= 3 digits; "2.5", "2.1.", "1995." never match);
 * the drop fires only in STRUCTURAL context - previous non-blank line
 * absent, a heading, a table row, marker-led, or ending in terminal
 * punctuation, OR next non-blank line marker-led - so a soft-wrapped
 * mid-sentence number ("capped at\n5.\nGB") keeps gluing as today, content
 * intact. Lines carrying mid-reveal sentinels (old-strike/caret) are kept
 * while typing; wash/region sentinels do NOT protect a line (a region beat
 * must not flicker a nonexistent "5." paragraph into the settled document).
 * ------------------------------------------------------------------ */

const ORPHAN_LABEL = /^\d{1,3}[.)]$/;
const ANY_MARKER_LEAD = /^(?:[-*]\s|\d{1,3}[.)]\s|[A-Za-z][.)]\s|#{1,4}\s|\|)/;

export function dropOrphanNumberLines(md: string): string {
  if (!/\d/.test(md)) return md;
  const lines = md.split("\n");
  const shadows = lines.map((l) => l.replace(ALL_SENTINELS, "").trim());
  const structural = (s: string): boolean =>
    ANY_MARKER_LEAD.test(s) || ORPHAN_LABEL.test(s) || /[.!?:;]$/.test(s);
  let changed = false;
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const s = shadows[i];
    if (ORPHAN_LABEL.test(s) && !MID_REVEAL_SENTINEL.test(lines[i])) {
      let prev = i - 1;
      while (prev >= 0 && !shadows[prev]) prev--;
      let next = i + 1;
      while (next < lines.length && !shadows[next]) next++;
      const prevOk = prev < 0 || structural(shadows[prev]);
      const nextOk =
        next < lines.length && ANY_MARKER_LEAD.test(shadows[next]);
      if (prevOk || nextOk) {
        changed = true;
        continue;
      }
    }
    out.push(lines[i]);
  }
  return changed ? out.join("\n") : md;
}

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
  } else if ((m = ORPHAN_DOT_PROMOTE.exec(core))) {
    // ".7.1 Policy": a multipart number whose leading component was lost by
    // a bad PDF extraction (round 19). The orphan dot implies one lost
    // level, so depth = numeric parts + 1.
    hashes = Math.min(m[1].split(".").length + 1, 4);
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

/* ------------------------------------------------------------------ *
 * Per-level numbering profile (§5.12 round 22). The flat NumberingStyle
 * covers level 1 only; a Word template's multilevel definition assigns a
 * scheme PER level (the flagship: decimal "1." / lowerLetter "a." /
 * lowerRoman "i.", bare markers, never composite "1.a"). The profile is
 * DERIVED from the stored sample text at every read edge exactly like the
 * flat style (never persisted, legacy rows adopt on next load), and a null
 * profile means byte-identical pre-round-22 rendering everywhere.
 * ------------------------------------------------------------------ */

export interface ProfileLevel {
  fmt:
    | "decimal"
    | "decimalZero"
    | "lowerLetter"
    | "upperLetter"
    | "lowerRoman"
    | "upperRoman";
  sep: "." | ")";
  /** "1.1"-shaped markers: this level keeps today's dot-joined paths. */
  composite: boolean;
}

export interface NumberingProfile {
  levels: ProfileLevel[];
  /** The sample numbers its body items and has no (or negligible) bullet
   * lines: drafts' bullet lists render ordered per the level's scheme. */
  bodyNumbered: boolean;
}

/** Ordinal in a profile level's format. Letters past Z and romans past the
 * table clamp fall back to decimal, mirroring ordinalLabel. */
function formatOrdinal(n: number, fmt: ProfileLevel["fmt"]): string {
  switch (fmt) {
    case "lowerLetter":
      return n >= 1 && n <= 26 ? String.fromCharCode(96 + n) : String(n);
    case "upperLetter":
      return n >= 1 && n <= 26 ? String.fromCharCode(64 + n) : String(n);
    case "upperRoman":
      return toRoman(n);
    case "lowerRoman":
      return toRoman(n).toLowerCase();
    case "decimalZero":
      return `${n}.0`;
    default:
      return String(n);
  }
}

/** Levels deeper than a THREE-level profile repeat the detected cycle: the
 * flagship template's own Word definition cycles decimal/letter/roman, so
 * cycling is faithful there. A two-level profile proves no cycle (depth 2
 * would wear the SECTION format), so depths past it fall back to bare
 * decimal instead. */
export function profileLevelAt(
  profile: NumberingProfile,
  depth: number
): ProfileLevel {
  if (depth < profile.levels.length) return profile.levels[depth];
  if (profile.levels.length >= 3)
    return profile.levels[depth % profile.levels.length];
  return { fmt: "decimal", sep: ".", composite: false };
}

/** The bare marker for one firing at `depth`: "3.", "a)", "iv.".
 * decimalZero is already "3.0"-shaped and takes no separator, matching the
 * flat decimal-zero style's rendering. */
export function profileMarker(
  profile: NumberingProfile,
  depth: number,
  n: number
): string {
  const lv = profileLevelAt(profile, depth);
  if (lv.fmt === "decimalZero") return formatOrdinal(n, lv.fmt);
  return `${formatOrdinal(n, lv.fmt)}${lv.sep}`;
}

/** Compound base for a NESTED section's inner headings and its own label
 * (§5.12 round 18b skeleton adoption): bucket 5, section 2 -> "5.2", so
 * that section's inner headings run "5.2.1", "5.2.2". sub null = the
 * top-level base, identical to the flat document's. With a profile the
 * base ordinal follows the profile's level-0 format (composite paths only;
 * bare levels never consume this label). */
export function nestedBaseLabel(
  num: number,
  sub: number | null,
  style: NumberingStyle | null = null,
  profile: NumberingProfile | null = null
): string {
  const lv0 = profile ? profileLevelAt(profile, 0) : null;
  const base = lv0
    ? lv0.fmt === "decimalZero"
      ? String(num)
      : formatOrdinal(num, lv0.fmt)
    : subPrefix(num, style ?? "decimal");
  return sub === null ? base : `${base}.${sub}`;
}

/** Title line of a section nested under a skeleton bucket: "5.2 Data
 * handling" ("V.2 ...", etc.). No trailing dot, matching the established
 * inner-heading label shape. A profile with a bare level 1 emits the bare
 * marker instead ("a. Data handling"); composite keeps the dot-joined path. */
export function nestedSectionTitleText(
  num: number,
  sub: number,
  title: string,
  style: NumberingStyle | null = null,
  profile: NumberingProfile | null = null
): string {
  const clean = stripLeadingNumber(title.trim());
  if (profile && !profileLevelAt(profile, 1).composite)
    return `${profileMarker(profile, 1, sub)} ${clean}`;
  return `${nestedBaseLabel(num, sub, style, profile)} ${clean}`;
}

/** Section title as rendered in both panes: "3. Data handling",
 *  "III. Data handling", "Section 3: Data handling". A profile overrides
 *  the flat style (its level 0 is detected from the same heading channel,
 *  so the two agree wherever both exist). */
export function sectionTitleText(
  num: number,
  title: string,
  style: NumberingStyle | null = null,
  profile: NumberingProfile | null = null
): string {
  const s = style ?? "decimal";
  const clean = stripLeadingNumber(title.trim());
  if (profile) return `${profileMarker(profile, 0, num)} ${clean}`;
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

/* ------------------------------------------------------------------ *
 * Profile detection (round 22). Reads the literal markers the round-15d
 * ingest writes into the stored sample ("## 1. Purpose" headings, "a. Keep
 * data safe." body items, "i. ..." under them) and reconstructs the
 * per-level scheme via ascending chains, like the recover* helpers: a
 * level fires only on the exact next value of its species, so prose
 * numbers and initials cannot ride a chain. All quantifiers bounded.
 * ------------------------------------------------------------------ */

const PROFILE_COMPOSITE = /^(\d{1,3})(?:\.\d{1,3}){1,4}\.?\s{1,10}(?=\S)/;
const PROFILE_DECZERO = /^(\d{1,3})\.0(?:\s|$)/;
const PROFILE_DECIMAL = /^(\d{1,3})([.)])\s{1,10}(?=\S)/;
const PROFILE_ALPHA = /^([A-Za-z]{1,7})([.)])\s{1,10}(?=\S)/;

interface ProfileToken {
  fmt: ProfileLevel["fmt"];
  value: number;
  sep: "." | ")";
  /** Single i/v/x letters carry their roman reading too; chain state
   * disambiguates ("i." after "a..h" is a letter; "i., ii." is roman). */
  romanAlt: number | null;
  /** "1.1"-shaped markers: dotted part count (0 = not composite). */
  compositeParts: number;
}

function romanTokenValue(s: string): number | null {
  const vals: Record<string, number> = { i: 1, v: 5, x: 10 };
  let total = 0;
  for (let k = 0; k < s.length && k < 8; k++) {
    const c = vals[s[k]];
    if (!c) return null;
    const next = k + 1 < s.length ? (vals[s[k + 1]] ?? 0) : 0;
    total += c < next ? -c : c;
  }
  return total >= 1 && total <= 39 ? total : null;
}

function profileToken(t: string): ProfileToken | null {
  let m = PROFILE_DECZERO.exec(t);
  if (m)
    return {
      fmt: "decimalZero",
      value: parseInt(m[1], 10),
      sep: ".",
      romanAlt: null,
      compositeParts: 0,
    };
  m = PROFILE_COMPOSITE.exec(t);
  if (m)
    return {
      fmt: "decimal",
      value: parseInt(m[1], 10),
      sep: ".",
      romanAlt: null,
      compositeParts: m[0].trimEnd().replace(/\.$/, "").split(".").length,
    };
  m = PROFILE_DECIMAL.exec(t);
  if (m)
    return {
      fmt: "decimal",
      value: parseInt(m[1], 10),
      sep: m[2] as "." | ")",
      romanAlt: null,
      compositeParts: 0,
    };
  m = PROFILE_ALPHA.exec(t);
  if (!m) return null;
  const s = m[1];
  const sep = m[2] as "." | ")";
  // "U. S. obligations": an initials chain, never a marker.
  if (INITIALS_CHAIN_ANY.test(t.slice(m[0].length))) return null;
  if (s.length === 1) {
    const lower = s >= "a";
    return {
      fmt: lower ? "lowerLetter" : "upperLetter",
      value: s.toLowerCase().charCodeAt(0) - 96,
      sep,
      romanAlt: /^[ivx]$/i.test(s) ? romanTokenValue(s.toLowerCase()) : null,
      compositeParts: 0,
    };
  }
  // Multi-letter markers are markers only when they are valid romans of one
  // case ("iii.", "IV."); anything else is prose.
  if (/^[ivx]{2,7}$/.test(s)) {
    const v = romanTokenValue(s);
    return v === null
      ? null
      : { fmt: "lowerRoman", value: v, sep, romanAlt: null, compositeParts: 0 };
  }
  if (/^[IVX]{2,7}$/.test(s)) {
    const v = romanTokenValue(s.toLowerCase());
    return v === null
      ? null
      : { fmt: "upperRoman", value: v, sep, romanAlt: null, compositeParts: 0 };
  }
  return null;
}

interface ProfileChain {
  fmt: ProfileLevel["fmt"];
  sep: "." | ")";
  expect: number;
  /** Last link came from a HEADING line: a body-line restart of the same
   * species then belongs one level DEEPER, not to this chain (an
   * all-decimal template's "1." item under "### 1. Step" is a child, and
   * flat text carries no other depth evidence). */
  fromHeading: boolean;
}

/** Does `tok` fire as the next link of `c`? Same separator always; a lone
 * i/v/x continues a roman chain via its roman reading, and continues a
 * letter chain via its letter reading ("i." after "h."). */
function chainFires(c: ProfileChain, tok: ProfileToken): boolean {
  if (tok.sep !== c.sep || tok.compositeParts > 0) return false;
  if (tok.fmt === c.fmt && tok.value === c.expect) return true;
  if (
    tok.romanAlt !== null &&
    tok.romanAlt === c.expect &&
    ((c.fmt === "lowerRoman" && tok.fmt === "lowerLetter") ||
      (c.fmt === "upperRoman" && tok.fmt === "upperLetter"))
  )
    return true;
  return false;
}

/** The chain `tok` STARTS, or null. A lone "i."/"I." starts a ROMAN chain
 * (letters start at "a"; the letter reading of i is 9, never a start). */
function chainStart(tok: ProfileToken, fromHeading: boolean): ProfileChain | null {
  if (tok.compositeParts > 0 || tok.fmt === "decimalZero") return null;
  if (tok.romanAlt === 1)
    return {
      fmt: tok.fmt === "lowerLetter" ? "lowerRoman" : "upperRoman",
      sep: tok.sep,
      expect: 2,
      fromHeading,
    };
  if (tok.value === 1)
    return { fmt: tok.fmt, sep: tok.sep, expect: 2, fromHeading };
  return null;
}

const profileKey = (fmt: ProfileLevel["fmt"], sep: "." | ")") =>
  `${fmt}|${sep}`;

function voteWin(
  votes: Map<string, number>,
  floor: number
): { fmt: ProfileLevel["fmt"]; sep: "." | ")"; count: number } | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [k, v] of votes)
    if (v > bestCount) {
      best = k;
      bestCount = v;
    }
  if (!best || bestCount < floor) return null;
  const [fmt, sep] = best.split("|");
  return {
    fmt: fmt as ProfileLevel["fmt"],
    sep: sep as "." | ")",
    count: bestCount,
  };
}

/**
 * Detect the sample's per-level numbering profile from its stored text.
 * Level 0 comes from the markered-heading channel (the same channel
 * detectNumberingStyle trusts); deeper levels from ascending body chains
 * that reset at each level-0 heading, plus deeper markered headings fed
 * through the same machine. With NO markered headings at all, the body
 * chains supply level 0 too (legacy flat extractions of the same
 * template), under a stricter 3-line floor. Null = no confident
 * multi-level signal, and null MUST mean byte-identical current rendering
 * in every consumer.
 */
export function detectNumberingProfile(text: string): NumberingProfile | null {
  interface Ev {
    hashes: number;
    token: ProfileToken | null;
  }
  const evs: Ev[] = [];
  let bodyMarkers = 0;
  let bodyBullets = 0;
  let headingLines = 0;
  let seen = 0;
  for (const raw of text.split("\n")) {
    if (++seen > 4000) break;
    if (/^#{1,6}\s/.test(raw)) headingLines++;
    const hm = /^(#{1,6})\s{1,10}(.{1,300})$/.exec(raw);
    const t = (hm ? hm[2] : raw).trim();
    if (!t) continue;
    if (!hm) {
      if (/^[-*]\s/.test(t)) {
        bodyBullets++;
        continue;
      }
      if (t.length > 200) continue;
    }
    const token = profileToken(t);
    if (!hm && token) bodyMarkers++;
    if (hm || token) evs.push({ hashes: hm ? hm[1].length : 0, token });
  }

  // Level 0: the shallowest heading level with >= 2 bare markers. Lone
  // i/v/x heading markers read as roman only beside a multi-letter roman
  // peer at the same level ("## I." next to "## II."), else as letters.
  const byHash = new Map<number, ProfileToken[]>();
  for (const e of evs) {
    if (!e.hashes || !e.token || e.token.compositeParts > 0) continue;
    const arr = byHash.get(e.hashes) ?? [];
    arr.push(e.token);
    byHash.set(e.hashes, arr);
  }
  let h0 = 0;
  for (const h of [...byHash.keys()].sort((a, b) => a - b))
    if (byHash.get(h)!.length >= 2) {
      h0 = h;
      break;
    }
  let level0: ProfileLevel | null = null;
  if (h0) {
    const toks = byHash.get(h0)!;
    const multiRoman = toks.some(
      (x) =>
        (x.fmt === "lowerRoman" || x.fmt === "upperRoman") &&
        x.romanAlt === null
    );
    const votes = new Map<string, number>();
    for (const x of toks) {
      let fmt = x.fmt;
      if (multiRoman && x.romanAlt !== null)
        fmt = x.fmt === "lowerLetter" ? "lowerRoman" : "upperRoman";
      const k = profileKey(fmt, x.sep);
      votes.set(k, (votes.get(k) ?? 0) + 1);
    }
    const w = voteWin(votes, 2);
    if (w) level0 = { fmt: w.fmt, sep: w.sep, composite: false };
  }

  // Body chains: three relative levels, resetting at level-0 headings.
  const rel: Map<string, number>[] = [new Map(), new Map(), new Map()];
  const compVotes = [0, 0, 0, 0]; // absolute level index (0..3)
  const chains: (ProfileChain | null)[] = [null, null, null];
  const vote = (d: number, c: ProfileChain) => {
    const k = profileKey(c.fmt, c.sep);
    rel[d].set(k, (rel[d].get(k) ?? 0) + 1);
  };
  for (const e of evs) {
    if (e.hashes && h0 && e.hashes <= h0) {
      chains[0] = chains[1] = chains[2] = null;
      continue;
    }
    const tok = e.token;
    if (!tok) {
      // Unmarkered deeper heading: a new sub-scope, deeper chains reset.
      if (e.hashes) chains[1] = chains[2] = null;
      continue;
    }
    if (tok.compositeParts >= 2) {
      compVotes[Math.min(tok.compositeParts - 1, 3)]++;
      continue;
    }
    if (tok.fmt === "decimalZero") continue;
    const isHeading = e.hashes > 0;
    let fired = false;
    for (let d = 0; d < 3; d++) {
      const c = chains[d];
      if (c && chainFires(c, tok)) {
        c.expect++;
        c.fromHeading = isHeading;
        vote(d, c);
        for (let r = d + 1; r < 3; r++) chains[r] = null;
        fired = true;
        break;
      }
    }
    if (fired) continue;
    const start = chainStart(tok, isHeading);
    if (!start) continue;
    // A restart of an existing level (same species, back to 1) stays that
    // level; a NEW species one level deeper opens the next chain. A BODY
    // restart of a HEADING-anchored chain goes one level deeper instead:
    // hash depth is the one depth signal an all-decimal template has.
    for (let d = 0; d < 3; d++) {
      const c = chains[d];
      if (
        c &&
        c.fmt === start.fmt &&
        c.sep === start.sep &&
        (isHeading || !c.fromHeading)
      ) {
        chains[d] = start;
        vote(d, start);
        for (let r = d + 1; r < 3; r++) chains[r] = null;
        break;
      }
      if (!c) {
        chains[d] = start;
        vote(d, start);
        break;
      }
    }
  }

  // Assemble: relative chains map to absolute levels 1.. under a heading
  // level 0, or to absolute 0.. without one (stricter top floor there).
  const levels: ProfileLevel[] = [];
  const pickLevel = (
    votes: Map<string, number>,
    absLevel: number,
    floor: number
  ): ProfileLevel | null => {
    const w = voteWin(votes, floor);
    const comp = compVotes[absLevel] ?? 0;
    if (comp >= 2 && comp > (w?.count ?? 0))
      return { fmt: "decimal", sep: ".", composite: true };
    return w ? { fmt: w.fmt, sep: w.sep, composite: false } : null;
  };
  if (level0) {
    levels.push(level0);
    for (let d = 0; d < 2; d++) {
      const lv = pickLevel(rel[d], d + 1, 2);
      if (!lv) break;
      levels.push(lv);
    }
  } else if (headingLines <= 1) {
    // Body-only fallback: allowed for at most ONE heading line (the doc
    // title of a legacy flat extraction). A sample whose headings simply
    // carry no parseable marker (unnumbered, section-word) keeps its flat
    // rendering instead of being silently restyled. The derived level 0
    // must also agree with the flat detector's verdict, so the two
    // channels can never disagree about what a top-level section wears.
    const top = pickLevel(rel[0], 0, 3);
    const flat = top && !top.composite ? detectNumberingStyle(text) : null;
    const flatAgrees =
      top !== null &&
      ((flat === "decimal" && top.fmt === "decimal" && top.sep === ".") ||
        (flat === "paren" && top.fmt === "decimal" && top.sep === ")") ||
        (flat === "decimal-zero" && top.fmt === "decimalZero") ||
        (flat === "roman" && top.fmt === "upperRoman") ||
        (flat === "alpha" && top.fmt === "upperLetter"));
    if (top && !top.composite && flatAgrees) {
      levels.push(top);
      for (let d = 1; d < 3; d++) {
        const lv = pickLevel(rel[d], d, 2);
        if (!lv) break;
        levels.push(lv);
      }
    }
  }
  // Same-species stacking (decimal under decimal) is allowed (round 23):
  // real Word templates genuinely number consecutive levels decimal, and
  // the renderers now distinguish depths the way Word does, by the indent
  // ladder and bold headings, never by rejecting the profile.
  if (levels.length < 2) return null;
  return {
    levels,
    bodyNumbered: bodyMarkers >= 2 && bodyBullets * 4 <= bodyMarkers,
  };
}

function stripInlineNumber(inline: Inline[]): Inline[] {
  const first = inline[0];
  if (!first) return inline;
  if (
    inline.length > 1 &&
    (NUM_ONLY.test(first.text) || ORPHAN_DOT_ONLY.test(first.text))
  )
    return inline.slice(1);
  const stripped = stripLeadingNumber(first.text).replace(
    ORPHAN_DOT_PREFIX,
    ""
  );
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

/** ProfileLevel format as a list-block ListFormat; decimal shapes
 * approximate to decimal (a "1.0"-markered LIST is not a real Word shape). */
function profileListFormat(lv: ProfileLevel): ListFormat {
  switch (lv.fmt) {
    case "lowerLetter":
    case "upperLetter":
    case "lowerRoman":
    case "upperRoman":
      return lv.fmt;
    default:
      return "decimal";
  }
}

/** Body-list adoption (round 22): when the sample numbers its body items
 * and has no bullets, a draft's bullet lists render ordered per the
 * profile level at their depth (list level = base depth + 1, subs one
 * deeper). Ordered lists and ordered subs keep their literal shape.
 * `baseDepth` is the section depth PLUS the inner-heading depth the list
 * sits under (round 24): a list under a "###" sub-heading wears the level
 * one past the sub-heading's, exactly as the template nests its items. */
function profileListBlock(
  b: Block & { t: "list" },
  profile: NumberingProfile,
  baseDepth: number
): Block {
  const subLv = profileLevelAt(profile, baseDepth + 2);
  let subChanged = false;
  const items = b.items.map((it) => {
    if (!it.sub || it.sub.ordered) return it;
    subChanged = true;
    return {
      ...it,
      sub: {
        ordered: true,
        start: 1,
        format: profileListFormat(subLv),
        sep: subLv.sep,
        items: it.sub.items,
      },
    };
  });
  if (b.ordered) return subChanged ? { ...b, items } : b;
  const lv = profileLevelAt(profile, baseDepth + 1);
  return {
    t: "list",
    ordered: true,
    start: 1,
    format: profileListFormat(lv),
    sep: lv.sep,
    items,
  };
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
 * With a profile (round 22), inner-heading labels follow the per-level
 * scheme at (sectionDepth + heading depth + 1): bare markers for bare
 * levels ("a. ", "i. "), the compound path for composite ones; and bullet
 * lists convert per profileListBlock when the profile says bodyNumbered.
 * Converted lists index the profile at the depth they actually SIT at
 * (round 24): section depth plus the depth of the inner heading above
 * them, so a list under a "###" sub-heading wears the next level's
 * species instead of repeating the one directly under the section title.
 */
export function normalizeSectionBlocks(
  blocks: Block[],
  sectionNum: number,
  style: NumberingStyle | null = null,
  // Skeleton adoption (round 18b): a nested section's inner headings hang
  // off its compound label ("5.2" -> "5.2.1") instead of its ordinal.
  baseLabel: string | null = null,
  profile: NumberingProfile | null = null,
  // 0 = top-level section, 1 = nested under a skeleton bucket: the depth
  // the profile's level indexes hang off.
  sectionDepth: 0 | 1 = 0
): Block[] {
  let min = Infinity;
  for (const b of blocks) if (b.t === "heading" && b.level < min) min = b.level;
  let c1 = 0;
  let c2 = 0;
  // Sub-headings hang off the section's styled ordinal ("III.1", "C.2");
  // decimal styles keep today's "3.1" exactly.
  // `||` not `??`: an empty-string baseLabel must fall back too (defensive;
  // no live caller produces "", but a "" base would mint ".7.1"-style labels).
  const base =
    baseLabel ||
    (profile
      ? nestedBaseLabel(sectionNum, null, style, profile)
      : subPrefix(sectionNum, style ?? "decimal"));
  const alphaRun = alphaHeadingRun(blocks);
  // Inner-heading depth context (round 24): 0 before any heading, then one
  // past the last heading's rebased depth. Blocks are mapped in order, so
  // the closure variable is the depth each non-heading block sits under.
  let innerDepth = 0;
  return blocks.map((b, bi): Block => {
    if (b.t === "list" && profile?.bodyNumbered)
      return profileListBlock(b, profile, sectionDepth + innerDepth);
    if (b.t !== "heading") return b;
    const depth = b.level - min;
    innerDepth = Math.min(depth, 3) + 1;
    let inline = stripInlineNumber(b.inline);
    if (alphaRun.has(bi)) inline = stripAlphaMarker(inline);
    let label = "";
    if (depth === 0) {
      c1++;
      c2 = 0;
      const lv = profile ? profileLevelAt(profile, sectionDepth + 1) : null;
      label =
        lv && !lv.composite
          ? `${profileMarker(profile!, sectionDepth + 1, c1)} `
          : `${base}.${c1} `;
    } else if (depth === 1 && c1 > 0) {
      c2++;
      const lv = profile ? profileLevelAt(profile, sectionDepth + 2) : null;
      label =
        lv && !lv.composite
          ? `${profileMarker(profile!, sectionDepth + 2, c2)} `
          : `${base}.${c1}.${c2} `;
    }
    return {
      t: "heading",
      level: (Math.min(depth, 3) + 1) as 1 | 2 | 3 | 4,
      inline: label ? [{ t: "text", text: label }, ...inline] : inline,
    };
  });
}
