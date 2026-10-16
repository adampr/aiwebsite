// XL.net's standard proposal outline (ARCHITECTURE.md §5.17.17).
//
// Client-safe and import-free: the workspace, the read worker and the tests
// all use it.

export type OutlineNode = { label: string; title: string };

/** XL.net's standard proposal outline, used when the intake text has no
 *  section structure of its own (a brief, notes, an email). Labels are bare
 *  numbers so the kicker renders "Section 1" over the title, as it does for
 *  a numbered RFP; the outline only ever replaces an EMPTY structure, so it
 *  never shares a document with client labels, and no label starts "__". */
export const STANDARD_OUTLINE: readonly OutlineNode[] = [
  { label: "1", title: "Executive Summary" },
  { label: "2", title: "Your Environment and What You Need" },
  { label: "3", title: "Scope of Services" },
  { label: "4", title: "Security and Included Tools" },
  { label: "5", title: "Cloud and On-Site Infrastructure" },
  { label: "6", title: "Projects and Transition" },
  { label: "7", title: "Service Delivery and Support" },
  { label: "8", title: "Agreement Terms" },
  { label: "9", title: "Questions and Clarifications" },
  { label: "10", title: "About XL.net" },
];

/** Where an unmapped statement lands: Scope of Services. */
export const OUTLINE_DEFAULT_LABEL = "3";
/** Where an unmapped question lands: Questions and Clarifications. */
export const OUTLINE_QUESTIONS_LABEL = "9";

/** The outline's titles as the reader is told them, one string, so the
 *  prompt and STANDARD_OUTLINE cannot drift. */
export const OUTLINE_TITLES_FOR_PROMPT = STANDARD_OUTLINE.map((n) => n.title).join("; ");

/** About XL.net: never takes a narrative title (round 32), so the company
 *  snapshot's picker keeps finding it by its standard title. */
export const OUTLINE_ABOUT_LABEL = "10";

/** The standard title for an outline label, or null for any other label. */
export function outlineDefaultTitle(label: string): string | null {
  return STANDARD_OUTLINE.find((n) => n.label === label)?.title ?? null;
}

/**
 * May a brief-mode section ask for, and take, a narrative title (round 32)?
 * Only an outline section other than About XL.net whose title is still
 * EXACTLY its standard one: a person's retitle, or a narrative title already
 * adopted, is never replaced. The letter's reserved label is no outline
 * label, so it never qualifies.
 */
export function narrativeTitleOpen(opts: {
  intakeForm: string;
  label: string;
  currentTitle: string;
}): boolean {
  if (opts.intakeForm !== "brief" || opts.label === OUTLINE_ABOUT_LABEL) return false;
  const standard = outlineDefaultTitle(opts.label);
  return standard !== null && opts.currentTitle === standard;
}

/** The landing guard: narrativeTitleOpen, plus a proposed title that is
 *  non-empty after the drafter's sanitation and actually different. */
export function mayAdoptNarrativeTitle(opts: {
  intakeForm: string;
  label: string;
  currentTitle: string;
  proposed: string | null | undefined;
}): boolean {
  const proposed = typeof opts.proposed === "string" ? opts.proposed.trim() : "";
  return proposed !== "" && proposed !== opts.currentTitle && narrativeTitleOpen(opts);
}

/* ---- Round 33: thematic parts for brief-mode documents (§5.17.21) --------
 * A brief document's sheets render as four thematic parts. The STRUCTURE is
 * static and deterministic (this map, never model-chosen); only a part's
 * displayed TITLE and DEK may be overridden from rfp_proposals.parts_json,
 * which the letter turn (or rfp:parts) writes after brain.ts sanitation.
 * A real RFP never resolves parts (resolveParts returns null), so its layout
 * stays the legacy two-divider one. Labels never change: only the displayed
 * sheet kicker becomes part-relative. */

export type PartNumber = 1 | 2 | 3 | 4;

export type OutlinePart = {
  n: PartNumber;
  /** The static default title, rendered whenever no override is stored. */
  title: string;
  /** Member outline labels, in outline (render) order. */
  labels: readonly string[];
  /** The pricing furniture (the Investment sheets) renders in this part. */
  holdsPricing: boolean;
};

/** THE part map (frozen): every STANDARD_OUTLINE label exactly once. */
export const OUTLINE_PARTS: readonly OutlinePart[] = [
  { n: 1, title: "How We Support You", labels: ["1", "2", "3", "7", "10"], holdsPricing: false },
  { n: 2, title: "Security and Infrastructure", labels: ["4", "5"], holdsPricing: false },
  // Not "Projects and Transition": that is section 6's standard title, and
  // section 6 is usually the part's only sheet (9 is dropped at read).
  { n: 3, title: "Onboarding and Transition", labels: ["6", "9"], holdsPricing: false },
  { n: 4, title: "Pricing and Agreement Terms", labels: ["8"], holdsPricing: true },
];

/** Stored override caps (refused, never cut, at both write and read). */
export const PART_TITLE_MAX = 40;
export const PART_DEK_MAX = 160;

/** The part an outline label belongs to, or null for any other label. */
export function outlinePartOf(label: string): PartNumber | null {
  return OUTLINE_PARTS.find((p) => p.labels.includes(label))?.n ?? null;
}

/** The part a brief section renders in: its map part, else part 1 (the
 *  defensive rule for a label outside the outline: never silently dropped).
 *  Reserved "__" labels (the letter) are no section and belong to none. */
export function partForLabel(label: string): PartNumber | null {
  if (label.startsWith("__")) return null;
  return outlinePartOf(label) ?? 1;
}

export type PartOverride = { n: PartNumber; title: string | null; dek: string | null };

/** An em dash, the horizontal bar, or one of their lookalikes (figure dash,
 *  two- and three-em dash, small em dash): never divider furniture. */
const PART_DASHES = /[\u2012\u2014\u2015\u2e3a\u2e3b\ufe58]/;

/** One stored override value as the read side accepts it: a string with no
 *  edge whitespace, within its cap, and none of: a control, format or line
 *  separator character (bidi overrides and zero-width characters included),
 *  stacked combining marks (after NFC), a currency sign, a numeral that is
 *  not an ASCII digit, an em dash or a lookalike, an angle bracket. Anything
 *  else reads null (the static default renders); it is never repaired. The
 *  same screens a stored row from outside the write path (a hand-written
 *  parts_json) has to pass; the write side (brain.ts) is stricter. Inline
 *  on purpose: this module stays import-free. */
function storedPartText(raw: unknown, max: number): string | null {
  if (typeof raw !== "string") return null;
  if (raw === "" || raw !== raw.trim() || raw.length > max) return null;
  if (/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(raw)) return null;
  if (/\p{Mn}{2,}/u.test(raw.normalize("NFC"))) return null;
  if (/\p{Sc}/u.test(raw) || /(?![0-9])\p{N}/u.test(raw)) return null;
  // Square brackets are the D3 placeholder shape ("[Client]"); like angle
  // brackets they are never divider furniture.
  if (PART_DASHES.test(raw) || /[<>[\]]/.test(raw)) return null;
  return raw;
}

/* ---- Part grounding text (shared by the write screens and the render) ---- */

/** Block keys that are plumbing, not content: never grounding text. */
const BLOCK_PLUMBING = new Set(["id", "after", "cites", "generatedBy", "origin", "kind"]);

/** A stored visual's content words for grounding: every string value of its
 *  body (a timeline's dated step labels count as the section stating those
 *  dates), never its id, anchor or cites. A references block gives its
 *  organizations only: its contacts are a person's, and a phone number must
 *  never ground a digit. Tolerant of any stored shape: a non-object, a
 *  references block without its array, a null entry all give "" for that
 *  piece, never a throw. */
export function partBlockText(b: unknown): string {
  if (!b || typeof b !== "object" || Array.isArray(b)) return "";
  const block = b as { kind?: unknown; references?: unknown };
  if (block.kind === "references") {
    if (!Array.isArray(block.references)) return "";
    return block.references
      .map((r) =>
        r && typeof r === "object" && typeof (r as { organization?: unknown }).organization === "string"
          ? (r as { organization: string }).organization
          : ""
      )
      .join("\n");
  }
  const out: string[] = [];
  const walk = (v: unknown, depth: number): void => {
    if (depth > 4 || out.length > 400) return;
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v)) if (!BLOCK_PLUMBING.has(k)) walk(x, depth + 1);
  };
  walk(b, 0);
  return out.join("\n");
}

/** A drafted section as the part grounding reads it. */
export type PartGroundSection = {
  label: string;
  title: string;
  paragraphs?: readonly unknown[];
  blocks?: readonly unknown[];
};

/** Part n's drafted text: its sections' titles, paragraphs and visuals (the
 *  sections partForLabel places in part n, in the order given). ONE corpus
 *  for the write screens (brain.ts partCorpus) and the render's dek check
 *  (furniture.ts documentParts). */
export function partCorpusOf(sections: readonly PartGroundSection[], n: PartNumber): string {
  return (Array.isArray(sections) ? sections : [])
    .filter((s) => s && typeof s.label === "string" && partForLabel(s.label) === n)
    .map((s) =>
      [
        typeof s.title === "string" ? s.title : "",
        ...(Array.isArray(s.paragraphs)
          ? (s.paragraphs as readonly unknown[]).filter((p: unknown): p is string => typeof p === "string")
          : []),
        ...(Array.isArray(s.blocks) ? s.blocks.map(partBlockText) : []),
      ].join("\n")
    )
    .join("\n\n");
}

/** Grounding normal form: format characters dropped, a thousands separator
 *  inside a number folded (comma or a number space), whitespace collapsed.
 *  Lookahead only, never a lookbehind (client-reachable). */
function groundForm(s: string): string {
  return s
    .replace(/\p{Cf}/gu, "")
    .replace(/(\d),(?=\d{3}(\D|$))/g, "$1")
    .replace(/(\d)[\u00a0\u2007\u2009\u202f](?=\d{3}(\D|$))/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** `num` inside `hay` as a WHOLE number: no letter or digit glued to either
 *  end, and no decimal or thousands mark joining it to more digits. Checked
 *  by hand at each hit, never a lookbehind. */
function hasWholeNumber(hay: string, num: string): boolean {
  const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
  let at = hay.indexOf(num);
  while (at >= 0) {
    const end = at + num.length;
    const before = hay.slice(0, at);
    const after = hay.slice(end);
    const gluedBefore =
      /[\p{L}\p{N}]$/u.test(before) || (/[.,]$/.test(before) && isDigit(hay[at - 2]));
    const gluedAfter =
      /^[\p{L}\p{N}]/u.test(after) || (/^[.,]/.test(after) && isDigit(hay[end + 1]));
    if (!gluedBefore && !gluedAfter) return true;
    at = hay.indexOf(num, at + 1);
  }
  return false;
}

/** Every digit run of `text` is a number `corpus` states whole ("2026"
 *  grounds on "December 11, 2026"; "202" never does). True when `text` has
 *  no digit. */
export function partDigitsStated(text: string, corpus: string): boolean {
  const runs = groundForm(String(text ?? "")).match(/\d+(?:\.\d+)?/g) ?? [];
  if (runs.length === 0) return true;
  const hay = groundForm(String(corpus ?? ""));
  return runs.every((r) => hasWholeNumber(hay, r));
}

/**
 * Tolerant read of rfp_proposals.parts_json: always exactly four entries,
 * n 1..4 in order. Null, bad JSON, a wrong shape, an out-of-range or
 * repeated n (first wins) or a bad value all read as null for that slot, so
 * the static defaults render and nothing ever throws.
 */
export function parsePartsJson(raw: string | null | undefined): PartOverride[] {
  const out: PartOverride[] = OUTLINE_PARTS.map((p) => ({ n: p.n, title: null, dek: null }));
  if (typeof raw !== "string" || raw.trim() === "") return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  const parts =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as { parts?: unknown }).parts
      : null;
  if (!Array.isArray(parts)) return out;
  const done = new Set<number>();
  for (const e of parts.slice(0, 8)) {
    if (!e || typeof e !== "object") continue;
    const n = (e as { n?: unknown }).n;
    if (n !== 1 && n !== 2 && n !== 3 && n !== 4) continue;
    if (done.has(n)) continue;
    done.add(n);
    out[n - 1] = {
      n,
      title: storedPartText((e as { title?: unknown }).title, PART_TITLE_MAX),
      dek: storedPartText((e as { dek?: unknown }).dek, PART_DEK_MAX),
    };
  }
  return out;
}

/** The stored shape, always exactly four entries in order:
 *  {"parts":[{"n":1,"title":...,"dek":...}, ...]}. Missing entries and bad
 *  values (parsePartsJson's read rule) store null. */
export function serializePartsJson(entries: readonly Partial<PartOverride>[]): string {
  const parts = OUTLINE_PARTS.map((p) => {
    const e = entries.find((x) => x && x.n === p.n);
    return {
      n: p.n,
      title: storedPartText(e?.title, PART_TITLE_MAX),
      dek: storedPartText(e?.dek, PART_DEK_MAX),
    };
  });
  return JSON.stringify({ parts });
}

export type ResolvedPart = {
  /** The CANONICAL part (the map's n, the parts_json key). */
  n: PartNumber;
  title: string;
  dek: string | null;
  labels: string[];
  holdsPricing: boolean;
  /** The DISPLAY number: the part's 1-based position among the parts that
   *  render. The divider numeral, the ghost ornament and every kicker
   *  prefix use it, so an omitted part 3 leaves part 4 printing "03" and
   *  "Section 3.x". Additive: n stays the storage key. */
  position: number;
  /** The Investment sheet's kicker when this part holds pricing: the part's
   *  FIRST numbered sheet, "Section <position>.1". Null otherwise. */
  pricingKicker: string | null;
};

/** "Section p.m": a brief sheet's part-relative kicker. */
export function partKicker(position: number, m: number): string {
  return `Section ${position}.${m}`;
}

/**
 * THE part resolution every brief-doc surface consumes (resolve-draft,
 * buildExportView, both emitters, the workspace doc pane), so they cannot
 * disagree.
 * - briefMode false: null, the legacy layout (real RFPs untouched).
 * - structure: the rendered (drafted) sections; reserved "__" labels and
 *   repeated labels (first wins) are skipped. Map labels take their part in
 *   OUTLINE order; any other label renders last in part 1, in the order
 *   given.
 * - A part with no rendered section is omitted, except part 4 while
 *   pricingPresent: it then renders with labels [] and holdsPricing true.
 * - title: the stored override, else the static default; dek: the stored
 *   override, else null (parsePartsJson's tolerant read). A part that
 *   renders with NO section (pricing alone) ignores its stored title and
 *   dek: they were composed from a section that is no longer drafted.
 * - position: the part's place among the rendered parts (1-based); the
 *   numeral and every kicker prefix print it, n stays the storage key.
 * - kicker(label): "Section p.m", p the position and m the section's
 *   1-based place among the part's rendered sheets: when the part holds
 *   pricing the Investment sheet is its first sheet (pricingKicker
 *   "Section p.1") and its sections count from 2. "" for a label no part
 *   renders.
 */
export function resolveParts(input: {
  briefMode: boolean;
  structure: { label: string; title: string }[];
  partsJson: string | null;
  pricingPresent: boolean;
}): null | { parts: ResolvedPart[]; kicker: (label: string) => string } {
  if (!input.briefMode) return null;
  const overrides = parsePartsJson(input.partsJson);
  const present = new Set<string>();
  const unmapped: string[] = [];
  for (const node of Array.isArray(input.structure) ? input.structure : []) {
    const label = node && typeof node.label === "string" ? node.label : null;
    if (label === null || label.startsWith("__") || present.has(label)) continue;
    present.add(label);
    if (outlinePartOf(label) === null) unmapped.push(label);
  }
  const parts: ResolvedPart[] = [];
  const kickers = new Map<string, string>();
  for (const p of OUTLINE_PARTS) {
    const labels = [
      ...p.labels.filter((l) => present.has(l)),
      ...(p.n === 1 ? unmapped : []),
    ];
    const holdsPricing = p.holdsPricing && input.pricingPresent === true;
    if (labels.length === 0 && !holdsPricing) continue;
    const position = parts.length + 1;
    const first = holdsPricing ? 2 : 1;
    labels.forEach((l, i) => kickers.set(l, partKicker(position, i + first)));
    const o = labels.length ? overrides[p.n - 1] : { title: null, dek: null };
    parts.push({
      n: p.n,
      title: o.title ?? p.title,
      dek: o.dek,
      labels,
      holdsPricing,
      position,
      pricingKicker: holdsPricing ? partKicker(position, 1) : null,
    });
  }
  return { parts, kicker: (label: string) => kickers.get(label) ?? "" };
}

const fold = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

/** The outline label a requirement belongs under: its own label when that
 *  names an outline node BY TITLE (the reader is only ever told the titles;
 *  a bare "1" echoes the text's own numbering, never Executive Summary),
 *  else the kind's fallback. */
export function outlineLabelFor(raw: string, kind: string): string {
  const want = fold(raw);
  if (want) {
    const hit = STANDARD_OUTLINE.find((n) => fold(n.title) === want);
    if (hit) return hit.label;
  }
  return kind === "question" ? OUTLINE_QUESTIONS_LABEL : OUTLINE_DEFAULT_LABEL;
}
