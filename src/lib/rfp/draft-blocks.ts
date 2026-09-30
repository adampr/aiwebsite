/**
 * Visual blocks on a drafted proposal section (ARCHITECTURE.md §5.17).
 *
 * A DraftSectionRecord is paragraphs plus, optionally, `blocks`: stat tiles, a fact grid, a badge
 * strip, a table, a callout, two-up cards, a timeline. Each block is anchored by `after` (how many
 * paragraphs precede it) and carries its own cites, so the C1 staleness join works per block.
 *
 * This module is the whole contract: the stored shape, the tolerant read, the ONE ordering
 * (`interleave`) the screen, resolve-draft and both exporters share, and the grounding that keeps
 * a number out of a visual unless a fact states it.
 *
 * PURE and CLIENT-SAFE. It is imported by the "use client" workspace, so: type-only imports (the
 * one value import is references-block.ts, itself pure and client-safe by contract), no server
 * modules, and NO lookbehind regexes (Safari before 16.4 cannot parse one, and a parse error
 * takes the whole bundle down). Preceding-character checks are done by hand on the index.
 *
 * The body of every block is EXACTLY the content-model body (content-model/blocks.ts), so lifting
 * a DraftBlock into a content-model Block is adding the BlockBase fields and nothing else.
 */

import type { Block, BlockBase } from "./content-model/blocks";
import {
  readReferenceEntries,
  referencesBlockStrings,
  type ReferenceEntry,
  type ReferencesBody,
} from "./references-block";

type Body<K extends Block["kind"]> = Omit<Extract<Block, { kind: K }>, keyof BlockBase>;

export const DRAFT_BLOCK_KINDS = [
  "stat-tiles",
  "fact-grid",
  "badge-strip",
  "table",
  "callout",
  "cards",
  "timeline",
  "references",
] as const;
export type DraftBlockKind = (typeof DRAFT_BLOCK_KINDS)[number];

export type DraftBlockBody =
  | Body<"stat-tiles">
  | Body<"fact-grid">
  | Body<"badge-strip">
  | Body<"table">
  | Body<"callout">
  | Body<"cards">
  | Body<"timeline">
  // Client references (references-block.ts): stored as entries, drawn as one
  // branded table per reference. Not a content-model kind of its own: the
  // lift (resolve-draft.ts) turns it into `table` blocks.
  | ReferencesBody;

export type DraftBlock = DraftBlockBody & {
  /** "v_" + 8 hex. Never embeds the section label: labels rename. */
  id: string;
  /** How many paragraphs precede the block, 0..paragraphs.length. */
  after: number;
  /** Fact ids. Non-empty, always, except on a `references` block: the
   *  person's contacts are not facts, so it cites nothing. */
  cites: string[];
  /** Set by the server path that built the block, never taken from a request body. */
  generatedBy: "llm" | "system";
  origin?: "about" | "service-stats" | "onboarding" | "references";
};

export const LIMITS = {
  blocksPerSection: 6,
  modelVisuals: 3,
  tiles: [2, 4],
  pairs: [2, 12],
  badges: [1, 4],
  tableCols: [2, 5],
  tableRows: [1, 14],
  cell: 220,
  cards: [2, 2],
  calloutBody: 700,
  label: 60,
  tileValue: 16,
} as const;

/** The drafter's paragraph cap (brain.ts slices every draft to this); degraded prose fits inside it. */
export const PARAGRAPH_CAP = 12;

// Limits the plan's LIMITS table does not name. Private so LIMITS stays the frozen shape.
const TITLE_MAX = 120;
const CARD_BODY_MAX = 400;
const FACT_VALUE_MAX = 160;
const NOTE_MAX = 80;
const TIMELINE_STEPS = [2, 6] as const;
const STEP_BODY_MAX = 400;
const DEGRADED_MAX = 1500;
const CITES_MAX = 40;
const MODEL_SCAN_MAX = 12;

export type GroundFact = {
  id: string;
  key: string;
  statement: string;
  detail: string | null;
  polarity: string;
};

export type FlowItem =
  | { type: "p"; index: number; text: string }
  | { type: "block"; block: DraftBlock };

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function inRange(n: number, range: readonly [number, number]): boolean {
  return n >= range[0] && n <= range[1];
}

function clampAfter(v: unknown, paragraphCount: number): number {
  const max = Math.max(0, Math.floor(Number.isFinite(paragraphCount) ? paragraphCount : 0));
  if (typeof v !== "number" || !Number.isFinite(v)) return max;
  return Math.min(max, Math.max(0, Math.floor(v)));
}

export function newBlockId(): string {
  const bytes = new Uint8Array(4);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < 4; i++) bytes[i] = Math.floor(Math.random() * 256);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `v_${hex}`;
}

const BLOCK_ID = /^v_[0-9a-f]{8}$/;
const FORMAT_CHARS = /[\p{Cf}\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu;
const SPACE_CHARS = /\p{Zs}/gu;

/**
 * The one text normalization every block string passes, on the way in (`clean`) and on the way
 * out of storage (`str`): NFKC (fullwidth "１２" and superscript "³" become the digits they are,
 * so the grounding sees them), format characters and C0 controls out (tab and newline stay),
 * and every Unicode space a plain one. The pdf italic face crashes fontkit on a zero-width or
 * thin space, so this is also what keeps a stored note from taking a download down.
 */
function normText(s: string): string {
  return s.normalize("NFKC").replace(FORMAT_CHARS, "").replace(SPACE_CHARS, " ");
}

/**
 * Model text on its way into a block: normalized (normText), em dashes replaced (rule D1),
 * whitespace collapsed. Returns null for a non-string or anything over `max`. Over-long text is
 * REFUSED rather than cut, because cutting "20,000" at the comma mints a number no fact states.
 */
function clean(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  if (v.length > max * 4 + 200) return null;
  const s = normText(v)
    .replace(/\s*[—―]\s*/g, ", ")
    .replace(/\s+/g, " ")
    .replace(/^(?:, )+|(?:, ?)+$/g, "")
    .replace(/(?:, ){2,}/g, ", ")
    .trim();
  return s.length > max ? null : s;
}

/**
 * "$", any Unicode currency sign, a currency code, a currency word ("dollars", "euros", "cents",
 * "bucks"), or a number priced per unit ("15 per user per month": a rate with the sign left off
 * is still a rate). Rule B7: no block ever carries money. "4 sessions per year" is not a rate,
 * only a number DIRECTLY before "per <unit>" is.
 */
export function hasCurrency(text: string): boolean {
  return /\p{Sc}|\b(?:USD|EUR|GBP|CAD|AUD|CHF|JPY|INR|MXN)\b|\b(?:dollars?|euros?|cents?|pence|bucks)\b|\d\s*per\s+(?:user|seat|device|endpoint|computer|month|year)\b/iu.test(
    String(text ?? "")
  );
}

// ---------------------------------------------------------------------------
// Grounding
// ---------------------------------------------------------------------------

/**
 * A local copy of the staff-count normalization (that module has lookbehinds now and must not be
 * imported as a value here): a thousands separator inside a number removed (the narrow-space
 * kind BEFORE normText would turn it into a plain space), then normText, whitespace collapsed.
 * Lower-cased, because only tokens and qualifier words are compared.
 */
function normGround(s: string): string {
  return String(s ?? "")
    .replace(/(\d),(?=\d{3}(\D|$))/g, "$1")
    .replace(/(\d)[    ](?=\d{3}(\D|$))/g, "$1")
    .normalize("NFKC")
    .replace(FORMAT_CHARS, "")
    .replace(SPACE_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

type Qualifier = "gt" | "lt" | "approx" | null;
type NumToken = {
  /** The digits, or a number word ("three", "twelve", "first"). */
  num: string;
  /** Letters glued to the front: the "p" of "P2", the "v" of "v8". A quantity has none. */
  prefix: string;
  /** Letters glued to the back: the "k" of "24k", the "x" of "3x", the "nd" of "2nd". */
  suffix: string;
  pct: boolean;
  qualifier: Qualifier;
};

const Q_WORDS: { re: RegExp; q: Exclude<Qualifier, null> }[] = [
  { re: /(?:more than|greater than|over|above|at least|upwards of) ?$/, q: "gt" },
  { re: /(?:less than|fewer than|under|below|within|up to|at most) ?$/, q: "lt" },
  { re: /(?:roughly|about|approximately|around) ?$/, q: "approx" },
];

/**
 * Number words are numbers: "a three-year term" and "twelve months" are claims a fact must state,
 * word for word (a fact saying "3" does not ground "three", nor the reverse: simple and strict).
 */
const NUMBER_WORDS =
  "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|" +
  "sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|" +
  "hundred|thousand|million|billion|dozen|first|second|third|fourth|fifth|sixth|seventh|eighth|" +
  "ninth|tenth";
const NUM_SOURCE = `\\d+(?:\\.\\d+)?|\\b(?:${NUMBER_WORDS})\\b`;

/** After normText, a numeral that is still not an ASCII digit ("٤٧", "๓"): never grounded. */
const FOREIGN_NUMERAL = /(?![0-9])\p{N}/u;

/** Every numeric token of normalized text, maximal ("99.9" is one token, never "99" and "9"). */
function numTokens(text: string): NumToken[] {
  const out: NumToken[] = [];
  const re = new RegExp(NUM_SOURCE, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    let p = start;
    while (p > 0 && /[a-z]/.test(text[p - 1])) p--;
    const prefix = text.slice(p, start);
    let q = end;
    while (q < text.length && /[a-z]/.test(text[q])) q++;
    const suffix = text.slice(end, q);
    const tail = text.slice(q, q + 10);
    const pctMatch = /^ ?(?:%|percent\b|per cent\b)/.exec(tail);
    const head = text.slice(Math.max(0, start - 16), start);
    let qualifier: Qualifier = null;
    if (/[>≥] ?$/.test(head)) qualifier = "gt";
    else if (/[<≤] ?$/.test(head)) qualifier = "lt";
    else if (/[~≈] ?$/.test(head)) qualifier = "approx";
    else for (const w of Q_WORDS) if (w.re.test(head)) qualifier = w.q;
    // "99%+" and "10+ years": a trailing plus is the same claim as a leading ">".
    const afterPct = text.slice(q + (pctMatch ? pctMatch[0].length : 0));
    if (qualifier === null && /^ ?\+/.test(afterPct)) qualifier = "gt";
    out.push({ num: m[0], prefix, suffix, pct: pctMatch !== null, qualifier });
  }
  return out;
}

/**
 * Is every number in `value` a number the fact states?
 *
 * Each numeric token of the value (digits, or a number word: "three", "twelve", "first") must
 * appear in the fact as a standalone token (the "2" of "P2" and the "9" of "99.9" are not the
 * quantity 2 or 9), with the same letters glued to either side ("24k" and "2nd" need "24k" and
 * "2nd", not "24" and "2") and the same percent-ness ("92" does not ground against "92%", nor the
 * reverse). A qualifier on the value (">", "+", "more than", "<", "within", "~") is allowed only
 * where the fact carries the same kind of qualifier directly before that number: ">99%" grounds
 * against "More than 99% of calls", never against "is 99%". A value with no qualifier grounds
 * against any occurrence. A numeral that is not an ASCII digit after NFKC ("٤٧") never grounds.
 * A value with no number at all is vacuously grounded; callers that need a number check for one.
 */
export function groundValue(value: string, factText: string): boolean {
  const norm = normGround(value);
  if (FOREIGN_NUMERAL.test(norm)) return false;
  const want = numTokens(norm);
  if (want.length === 0) return true;
  const have = numTokens(normGround(factText));
  return want.every((w) =>
    have.some(
      (h) =>
        h.num === w.num &&
        h.prefix === w.prefix &&
        h.suffix === w.suffix &&
        h.pct === w.pct &&
        (w.qualifier === null || w.qualifier === h.qualifier)
    )
  );
}

function factText(f: GroundFact): string {
  return `${f.statement} ${f.detail ?? ""}`;
}

const UNIT_ALIASES: Record<string, string> = {
  yr: "year",
  yrs: "year",
  hr: "hour",
  hrs: "hour",
  min: "minute",
  mins: "minute",
};

/** Every word of a tile value must be a word (or the front of one) the fact uses: "15 min" yes, "15 hours" against "15-minute" no. */
function valueWordsGround(value: string, text: string): boolean {
  const words = normGround(value).match(/[a-z]{2,}/g) ?? [];
  if (words.length === 0) return true;
  const have = normGround(text).match(/[a-z]+/g) ?? [];
  return words.every((w) => {
    const stem = UNIT_ALIASES[w] ?? w;
    return have.some((h) => h.startsWith(stem));
  });
}

// ---------------------------------------------------------------------------
// Stored blocks: tolerant read, ordering, re-anchoring
// ---------------------------------------------------------------------------

/** A stored string, normalized (normText; the identity on anything `clean` wrote). null = malformed. */
function str(v: unknown, max: number, allowEmpty = false): string | null {
  if (typeof v !== "string" || v.length > max * 4 + 200) return null;
  const s = normText(v);
  if (s.length > max) return null;
  if (!allowEmpty && s.trim() === "") return null;
  return s;
}

function optStr(v: unknown, max: number): string | undefined | null {
  if (v === undefined) return undefined;
  return str(v, max);
}

/** One stored body, rebuilt field by field in canonical order. null = malformed. */
function readBody(raw: Record<string, unknown>): DraftBlockBody | null {
  switch (raw.kind) {
    case "stat-tiles": {
      if (!Array.isArray(raw.tiles) || !inRange(raw.tiles.length, LIMITS.tiles)) return null;
      const tiles: Body<"stat-tiles">["tiles"] = [];
      for (const t of raw.tiles) {
        if (!isObj(t)) return null;
        const value = str(t.value, LIMITS.tileValue);
        const label = str(t.label, LIMITS.label);
        const note = optStr(t.note, NOTE_MAX);
        if (value === null || label === null || note === null) return null;
        tiles.push(note === undefined ? { value, label } : { value, label, note });
      }
      return { kind: "stat-tiles", tiles };
    }
    case "fact-grid": {
      if (!Array.isArray(raw.pairs) || !inRange(raw.pairs.length, LIMITS.pairs)) return null;
      const pairs: Body<"fact-grid">["pairs"] = [];
      for (const p of raw.pairs) {
        if (!isObj(p)) return null;
        const label = str(p.label, LIMITS.label);
        const value = str(p.value, FACT_VALUE_MAX);
        if (label === null || value === null) return null;
        pairs.push({ label, value });
      }
      return { kind: "fact-grid", pairs };
    }
    case "badge-strip": {
      if (!Array.isArray(raw.badges) || !inRange(raw.badges.length, LIMITS.badges)) return null;
      const badges: Body<"badge-strip">["badges"] = [];
      for (const b of raw.badges) {
        if (!isObj(b)) return null;
        const label = str(b.label, LIMITS.label);
        const note = optStr(b.note, NOTE_MAX);
        if (label === null || note === null) return null;
        badges.push(note === undefined ? { label } : { label, note });
      }
      return { kind: "badge-strip", badges };
    }
    case "table": {
      if (!Array.isArray(raw.columns) || !inRange(raw.columns.length, LIMITS.tableCols)) return null;
      if (!Array.isArray(raw.rows) || !inRange(raw.rows.length, LIMITS.tableRows)) return null;
      const caption = raw.caption === null ? null : str(raw.caption, TITLE_MAX);
      if (raw.caption !== null && caption === null) return null;
      const columns: Body<"table">["columns"] = [];
      for (const c of raw.columns) {
        if (!isObj(c)) return null;
        const header = str(c.header, LIMITS.label);
        if (header === null) return null;
        if (c.align !== "left" && c.align !== "right" && c.align !== "center") return null;
        columns.push({ header, align: c.align });
      }
      const rows: string[][] = [];
      for (const r of raw.rows) {
        if (!Array.isArray(r) || r.length !== columns.length) return null;
        const row: string[] = [];
        for (const cell of r) {
          const s = str(cell, LIMITS.cell, true);
          if (s === null) return null;
          row.push(s);
        }
        rows.push(row);
      }
      if (typeof raw.emphasizeLastRow !== "boolean") return null;
      return { kind: "table", caption, columns, rows, emphasizeLastRow: raw.emphasizeLastRow };
    }
    case "callout": {
      const title = raw.title === null ? null : str(raw.title, TITLE_MAX);
      if (raw.title !== null && title === null) return null;
      const body = str(raw.body, LIMITS.calloutBody);
      if (body === null) return null;
      if (raw.tone !== "neutral" && raw.tone !== "emphasis") return null;
      return { kind: "callout", title, body, tone: raw.tone };
    }
    case "cards": {
      if (!Array.isArray(raw.cards) || !inRange(raw.cards.length, LIMITS.cards)) return null;
      const cards: Body<"cards">["cards"] = [];
      for (const c of raw.cards) {
        if (!isObj(c)) return null;
        const title = str(c.title, LIMITS.label);
        const body = str(c.body, CARD_BODY_MAX);
        const footnote = optStr(c.footnote, NOTE_MAX);
        if (title === null || body === null || footnote === null) return null;
        cards.push(footnote === undefined ? { title, body } : { title, body, footnote });
      }
      return { kind: "cards", cards };
    }
    case "timeline": {
      if (!Array.isArray(raw.steps) || !inRange(raw.steps.length, TIMELINE_STEPS)) return null;
      const steps: Body<"timeline">["steps"] = [];
      for (const s of raw.steps) {
        if (!isObj(s)) return null;
        const label = str(s.label, LIMITS.label);
        const title = str(s.title, LIMITS.label);
        const body = str(s.body, STEP_BODY_MAX);
        if (label === null || title === null || body === null) return null;
        steps.push({ label, title, body });
      }
      return { kind: "timeline", steps };
    }
    case "references": {
      // The contract module owns the entry shape and its limits; an entry it
      // cannot read (no organization, no contact, no way to reach them) drops
      // the whole block, since a card with a hole is not a reference.
      const references = readReferenceEntries(raw.references);
      return references ? { kind: "references", references } : null;
    }
    default:
      return null;
  }
}

/** Every visible string of a body. The currency screen reads this; nothing else should. */
function bodyStrings(b: DraftBlockBody): string[] {
  switch (b.kind) {
    case "stat-tiles":
      return b.tiles.flatMap((t) => [t.value, t.label, t.note ?? ""]);
    case "fact-grid":
      return b.pairs.flatMap((p) => [p.label, p.value]);
    case "badge-strip":
      return b.badges.flatMap((x) => [x.label, x.note ?? ""]);
    case "table":
      return [b.caption ?? "", ...b.columns.map((c) => c.header), ...b.rows.flat()];
    case "callout":
      return [b.title ?? "", b.body];
    case "cards":
      return b.cards.flatMap((c) => [c.title, c.body, c.footnote ?? ""]);
    case "timeline":
      return b.steps.flatMap((s) => [s.label, s.title, s.body]);
    case "references":
      return referencesBlockStrings(b.references);
  }
}

/**
 * Tolerant read of `blocks` as stored in sections_json. Never throws. Anything malformed, over a
 * limit, carrying currency (every kind but `references`, see below), without cites, or repeating an id is dropped; a valid block comes back
 * deep-equal to what was stored (with `after` clamped to the paragraphs that exist now, and every
 * string through normText, which changes nothing `clean` or the About extractors wrote).
 *
 * The one kind allowed an empty `cites` is `references` (its origin is the person, not a fact);
 * every other kind keeps the non-empty requirement the C1 join depends on.
 */
export function sanitizeStoredBlocks(raw: unknown, paragraphCount: number): DraftBlock[] {
  if (!Array.isArray(raw)) return [];
  const out: DraftBlock[] = [];
  const seen = new Set<string>();
  for (const item of raw.slice(0, 64)) {
    if (out.length >= LIMITS.blocksPerSection) break;
    try {
      if (!isObj(item)) continue;
      if (typeof item.id !== "string" || !BLOCK_ID.test(item.id) || seen.has(item.id)) continue;
      if (item.generatedBy !== "llm" && item.generatedBy !== "system") continue;
      if (!Array.isArray(item.cites) || item.cites.length > CITES_MAX) continue;
      if (item.cites.length === 0 && item.kind !== "references") continue;
      if (!item.cites.every((c) => typeof c === "string" && c !== "" && c.length <= 200)) continue;
      if (typeof item.after !== "number" || !Number.isFinite(item.after)) continue;
      const origin = item.origin;
      if (
        origin !== undefined &&
        origin !== "about" &&
        origin !== "service-stats" &&
        origin !== "onboarding" &&
        origin !== "references"
      )
        continue;
      const body = readBody(item);
      if (!body) continue;
      // The currency screen (rule B7's storage half) is for text a MODEL wrote. A `references`
      // block is never model-authored: the references route builds it from what a person typed
      // or picked, and parseModelVisuals refuses the kind by name. Its strings are proper nouns
      // ("Dollar Bank", "Bucks County Free Library", a contact named Pence, "USD 259", a
      // relevance of "Architecture, CAD workloads"), which the screen reads as money; dropping
      // the block on that would make an accepted answer vanish on every read while its intro
      // paragraph stayed. So this kind is exempt here, and the gate still scans every card cell.
      if (body.kind !== "references" && bodyStrings(body).some(hasCurrency)) continue;
      seen.add(item.id);
      out.push({
        ...body,
        id: item.id,
        after: clampAfter(item.after, paragraphCount),
        cites: [...(item.cites as string[])],
        generatedBy: item.generatedBy,
        ...(origin ? { origin } : {}),
      });
    } catch {
      // A getter that throws, a revoked proxy: a stored record must never take the page down.
    }
  }
  return out;
}

/**
 * THE one ordering source for the screen, resolve-draft and both exporters: blocks anchored at
 * `after: i` come before paragraph i (so `after: 0` opens the section and `after: length` closes
 * it), and several blocks at one anchor keep their stored order.
 */
export function interleave(paragraphs: string[], blocks: DraftBlock[] | undefined): FlowItem[] {
  const paras = Array.isArray(paragraphs) ? paragraphs : [];
  const list = Array.isArray(blocks) ? blocks : [];
  const at = new Map<number, DraftBlock[]>();
  for (const b of list) {
    const i = clampAfter(b.after, paras.length);
    const bucket = at.get(i);
    if (bucket) bucket.push(b);
    else at.set(i, [b]);
  }
  const out: FlowItem[] = [];
  for (let i = 0; i <= paras.length; i++) {
    for (const block of at.get(i) ?? []) out.push({ type: "block", block });
    if (i < paras.length) out.push({ type: "p", index: i, text: paras[i] });
  }
  return out;
}

/** Clamp every `after` to the new paragraph count. undefined when there are no blocks, so the key stays absent. */
export function reanchorBlocks(
  blocks: DraftBlock[] | undefined,
  nextParagraphCount: number
): DraftBlock[] | undefined {
  if (!Array.isArray(blocks) || blocks.length === 0) return undefined;
  return blocks.map((b) => ({ ...b, after: clampAfter(b.after, nextParagraphCount) }));
}

// ---------------------------------------------------------------------------
// Model-authored visuals
// ---------------------------------------------------------------------------

type Dropped = { kind: string; reason: string };
type Parsed =
  | { ok: DraftBlockBody; cites: string[] }
  | { degrade: string[]; cites: string[] }
  | { drop: string };

function collectStrings(v: unknown, out: string[], depth = 0): void {
  if (out.length > 400 || depth > 4) return;
  if (typeof v === "string") out.push(v.slice(0, 4000));
  else if (Array.isArray(v)) for (const x of v.slice(0, 60)) collectStrings(x, out, depth + 1);
  else if (isObj(v)) for (const k of Object.keys(v).slice(0, 30)) collectStrings(v[k], out, depth + 1);
}

function knownCites(raw: unknown, byId: Map<string, GroundFact>): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const c of raw.slice(0, 60)) {
    if (typeof c === "string" && byId.has(c) && !out.includes(c)) out.push(c);
    if (out.length >= CITES_MAX) break;
  }
  return out;
}

function parseStats(item: Record<string, unknown>, byId: Map<string, GroundFact>): Parsed {
  if (!Array.isArray(item.tiles)) return { drop: "malformed" };
  const tiles: { value: string; label: string }[] = [];
  const cites: string[] = [];
  for (const t of item.tiles.slice(0, 12)) {
    if (tiles.length >= LIMITS.tiles[1]) break;
    if (!isObj(t) || typeof t.fact !== "string") continue;
    const fact = byId.get(t.fact);
    if (!fact || fact.polarity === "negative") continue;
    const value = clean(t.value, LIMITS.tileValue);
    const label = clean(t.label, LIMITS.label);
    if (!value || !label || !/\d/.test(value)) continue;
    const text = factText(fact);
    if (!groundValue(value, text) || !valueWordsGround(value, text)) continue;
    if (!groundValue(label, text)) continue;
    if (tiles.some((x) => x.value === value && x.label === label)) continue;
    tiles.push({ value, label });
    if (!cites.includes(fact.id)) cites.push(fact.id);
  }
  if (tiles.length < LIMITS.tiles[0]) return { drop: "fewer-than-two-grounded-tiles" };
  return { ok: { kind: "stat-tiles", tiles }, cites };
}

function parseTable(
  item: Record<string, unknown>,
  cites: string[],
  corpus: string
): Parsed {
  if (!Array.isArray(item.columns) || !Array.isArray(item.rows)) return { drop: "malformed" };
  const headers = item.columns.slice(0, 12).map((c) => clean(c, LIMITS.label));
  const rows: string[][] = [];
  let cellsOk = true;
  for (const r of item.rows.slice(0, 40)) {
    if (!Array.isArray(r)) return { drop: "malformed" };
    const row = r.slice(0, 12).map((c) => clean(c, LIMITS.cell));
    if (row.some((c) => c === null)) cellsOk = false;
    rows.push(row.map((c) => c ?? ""));
  }
  const caption = item.caption == null || item.caption === "" ? "" : clean(item.caption, TITLE_MAX);
  const shapeOk =
    cellsOk &&
    caption !== null &&
    item.columns.length === headers.length &&
    item.rows.length === rows.length &&
    inRange(headers.length, LIMITS.tableCols) &&
    inRange(rows.length, LIMITS.tableRows) &&
    headers.every((h) => !!h) &&
    rows.every((r) => r.length === headers.length && r.some((c) => c !== ""));
  if (shapeOk && cites.length > 0) {
    const all = [caption ?? "", ...(headers as string[]), ...rows.flat()];
    if (!all.every((s) => groundValue(s, corpus))) return { drop: "ungrounded" };
    return {
      ok: {
        kind: "table",
        caption: caption ? caption : null,
        columns: (headers as string[]).map((header) => ({ header, align: "left" as const })),
        rows,
        emphasizeLastRow: false,
      },
      cites,
    };
  }
  if (!cellsOk) return { drop: "malformed" };
  const lines = rows.map((r) => r.filter((c) => c !== "").join(" · ")).filter((l) => l !== "");
  return { degrade: lines, cites };
}

function parseCallout(item: Record<string, unknown>, cites: string[], corpus: string): Parsed {
  const body = clean(item.body, DEGRADED_MAX);
  if (!body) return { drop: "malformed" };
  const title = item.title == null || item.title === "" ? "" : clean(item.title, TITLE_MAX);
  if (title !== null && body.length <= LIMITS.calloutBody && cites.length > 0) {
    if (!groundValue(`${title} ${body}`, corpus)) return { drop: "ungrounded" };
    return {
      ok: {
        kind: "callout",
        title: title ? title : null,
        body,
        tone: item.tone === "emphasis" ? "emphasis" : "neutral",
      },
      cites,
    };
  }
  return { degrade: [body], cites };
}

function parseCards(item: Record<string, unknown>, cites: string[], corpus: string): Parsed {
  if (!Array.isArray(item.cards)) return { drop: "malformed" };
  const cards: { title: string; body: string }[] = [];
  let withinLimits = true;
  for (const c of item.cards.slice(0, 8)) {
    if (!isObj(c)) return { drop: "malformed" };
    const title = clean(c.title, TITLE_MAX);
    const body = clean(c.body, DEGRADED_MAX);
    if (!title || !body) return { drop: "malformed" };
    if (title.length > LIMITS.label || body.length > CARD_BODY_MAX) withinLimits = false;
    cards.push({ title, body });
  }
  if (cards.length === 0) return { drop: "malformed" };
  if (
    withinLimits &&
    item.cards.length === cards.length &&
    inRange(cards.length, LIMITS.cards) &&
    cites.length > 0
  ) {
    if (!cards.every((c) => groundValue(`${c.title} ${c.body}`, corpus))) return { drop: "ungrounded" };
    return { ok: { kind: "cards", cards }, cites };
  }
  return { degrade: cards.map((c) => `${c.title}: ${c.body}`), cites };
}

/**
 * Validate the drafter's `visuals` array. Never throws and never fails a section: a visual that is
 * shape-valid and grounded becomes a block; one that is malformed (or cites nothing known) but
 * whose text is grounded becomes prose for the caller to append; everything else is dropped with a
 * reason worth logging.
 *
 * Degraded prose is checked against the facts the section itself cites plus the visual's own
 * (every supplied fact when neither resolves), and only as many paragraphs as fit under
 * PARAGRAPH_CAP are handed back; a visual that does not fit whole is dropped, not half-kept.
 */
export function parseModelVisuals(
  raw: unknown,
  ctx: { facts: GroundFact[]; paragraphCount: number; sectionCites: string[] }
): { blocks: DraftBlock[]; degraded: string[]; dropped: Dropped[] } {
  const blocks: DraftBlock[] = [];
  const degraded: string[] = [];
  const dropped: Dropped[] = [];
  if (!Array.isArray(raw)) return { blocks, degraded, dropped };

  const facts = Array.isArray(ctx?.facts) ? ctx.facts.filter((f) => isObj(f) && typeof f.id === "string") : [];
  const byId = new Map(facts.map((f) => [f.id, f]));
  const paragraphCount = Number.isFinite(ctx?.paragraphCount) ? Math.max(0, Math.floor(ctx.paragraphCount)) : 0;
  const sectionCites = Array.isArray(ctx?.sectionCites) ? ctx.sectionCites : [];
  const textOf = (ids: string[]) =>
    ids
      .map((id) => byId.get(id))
      .filter((f): f is GroundFact => !!f)
      .map(factText)
      .join(" \n ");

  for (const item of raw.slice(0, MODEL_SCAN_MAX)) {
    let kind = "unknown";
    try {
      if (!isObj(item)) {
        dropped.push({ kind, reason: "malformed" });
        continue;
      }
      kind = typeof item.kind === "string" ? item.kind.slice(0, 40) : "unknown";
      if (kind === "stat-tiles") kind = "stats";
      // A closed allowlist, not DRAFT_BLOCK_KINDS: the system kinds (fact-grid, badge-strip,
      // timeline) and `references` (a person's contacts) are never accepted from the model.
      if (kind !== "stats" && kind !== "table" && kind !== "callout" && kind !== "cards") {
        dropped.push({ kind, reason: "unknown-kind" });
        continue;
      }
      const strings: string[] = [];
      collectStrings(item, strings);
      if (strings.some(hasCurrency)) {
        dropped.push({ kind, reason: "currency" });
        continue;
      }
      const cites = knownCites(item.cites, byId);
      // A [negative] fact stays citable (it is what the visual answers) but its numbers never
      // ground a cell: "not a 3-year term" must not put "3-year" in a table.
      const corpus = textOf(cites.filter((id) => byId.get(id)?.polarity !== "negative"));
      const parsed: Parsed =
        kind === "stats"
          ? parseStats(item, byId)
          : kind === "table"
            ? parseTable(item, cites, corpus)
            : kind === "callout"
              ? parseCallout(item, cites, corpus)
              : parseCards(item, cites, corpus);

      if ("drop" in parsed) {
        dropped.push({ kind, reason: parsed.drop });
      } else if ("ok" in parsed) {
        if (blocks.length >= LIMITS.modelVisuals) {
          dropped.push({ kind, reason: "over-limit" });
          continue;
        }
        blocks.push({
          ...parsed.ok,
          id: newBlockId(),
          after: clampAfter(item.after, paragraphCount),
          cites: parsed.cites,
          generatedBy: "llm",
        });
      } else {
        const proseIds = [...new Set([...parsed.cites, ...sectionCites])].filter((id) => byId.has(id));
        const proseCorpus = proseIds.length > 0 ? textOf(proseIds) : textOf(facts.map((f) => f.id));
        const room = PARAGRAPH_CAP - paragraphCount - degraded.length;
        const lines = parsed.degrade;
        if (lines.length === 0) dropped.push({ kind, reason: "malformed" });
        else if (lines.length > room) dropped.push({ kind, reason: "no-room-for-prose" });
        else if (lines.some((l) => l.length > DEGRADED_MAX)) dropped.push({ kind, reason: "malformed" });
        else if (!lines.every((l) => groundValue(l, proseCorpus))) dropped.push({ kind, reason: "ungrounded" });
        else degraded.push(...lines);
      }
    } catch {
      dropped.push({ kind, reason: "malformed" });
    }
  }
  if (raw.length > MODEL_SCAN_MAX) dropped.push({ kind: "unknown", reason: "over-limit" });
  return { blocks, degraded, dropped };
}

// ---------------------------------------------------------------------------
// Server-built visuals: every value is text lifted out of a live fact
// ---------------------------------------------------------------------------

function normKey(k: string): string {
  return String(k ?? "")
    .toLowerCase()
    .replace(/[-_.\s]+/g, "-");
}

/** The live, affirmative fact for a key. Retired facts are simply not supplied; the last match wins, so a correction beats what it superseded. */
function factFor(facts: GroundFact[], key: string): GroundFact | null {
  const want = normKey(key);
  let hit: GroundFact | null = null;
  for (const f of Array.isArray(facts) ? facts : []) {
    if (!f || typeof f.statement !== "string" || typeof f.id !== "string") continue;
    if (normKey(f.key) === want) hit = f;
  }
  return hit && hit.polarity !== "negative" ? hit : null;
}

function capFirst(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

type RowSpec = {
  label: string;
  key: string;
  /** Capture group 1 of each is the value; several are joined with " · ". All must match. */
  parts: RegExp[];
};

/**
 * The company snapshot. The labels are ours; every VALUE is capture text from the fact statement,
 * so a corrected fact changes the grid and a fact reworded past its extractor drops its row rather
 * than showing a stale value. The insurance row names the coverage and the carrier and has no way
 * to reach the dollar figure (rule B7).
 */
const ABOUT_ROWS: RowSpec[] = [
  { label: "Founded", key: "company.founded", parts: [/founded in (\d{4})\b/i] },
  { label: "Headquarters", key: "company.founded", parts: [/headquartered in (?:the )?([^.;]+)/i] },
  { label: "Team", key: "company.headcount", parts: [/\b(\d[\d,]* full-time employees)\b/i] },
  { label: "Active clients", key: "book.active-clients", parts: [/\b(\d[\d,]*) active client accounts\b/i] },
  { label: "Client retention", key: "book.retention", parts: [/retention rate is (\d+(?:\.\d+)?%)/i] },
  { label: "Average client tenure", key: "book.tenure", parts: [/average client tenure is (\d+(?:\.\d+)? years)\b/i] },
  { label: "Organizations we serve", key: "company.client-size-range", parts: [/organizations of (\d[\d,]* to \d[\d,]* employees)\b/i] },
  { label: "Service desk", key: "operations.service-desk-hours", parts: [/\b(24\/7\/365 live service desk)\b/i] },
  {
    label: "Insurance",
    key: "compliance.cyber-insurance",
    parts: [/covers (technology errors and omissions alongside cyber liability)\b/i, /through ([A-Z][A-Za-z ]+?)\./],
  },
];

const ABOUT_BADGES: { key: string; label: RegExp; note?: RegExp }[] = [
  { key: "compliance.iso-27001", label: /holds (ISO 27001:\d{4})/ },
  { key: "compliance.soc-2", label: /holds (SOC 2 Type \d)/, note: /\b(audited annually)\b/i },
  { key: "compliance.cmmc", label: /holds (CMMC Level \d)/ },
];

function extract(statement: string, parts: RegExp[]): string | null {
  const out: string[] = [];
  for (const re of parts) {
    const m = re.exec(statement);
    const v = m?.[1]?.trim();
    if (!v) return null;
    out.push(v);
  }
  const value = capFirst(normText(out.join(" · ")).replace(/\s+/g, " ").trim());
  return hasCurrency(value) || /[—―]/.test(value) ? null : value;
}

/**
 * The About set: a fact grid and a certification badge strip, both `after: 0`, generatedBy
 * "system", origin "about". No model call. Returns [] when the facts support neither.
 */
export function buildAboutBlocks(facts: GroundFact[]): DraftBlock[] {
  const out: DraftBlock[] = [];

  const pairs: { label: string; value: string }[] = [];
  const gridCites: string[] = [];
  for (const row of ABOUT_ROWS) {
    const f = factFor(facts, row.key);
    if (!f) continue;
    const value = extract(f.statement, row.parts);
    if (!value || value.length > FACT_VALUE_MAX) continue;
    pairs.push({ label: row.label, value });
    if (!gridCites.includes(f.id)) gridCites.push(f.id);
  }
  if (pairs.length >= LIMITS.pairs[0])
    out.push({
      kind: "fact-grid",
      pairs: pairs.slice(0, LIMITS.pairs[1]),
      id: newBlockId(),
      after: 0,
      cites: gridCites,
      generatedBy: "system",
      origin: "about",
    });

  const badges: { label: string; note?: string }[] = [];
  const badgeCites: string[] = [];
  for (const spec of ABOUT_BADGES) {
    const f = factFor(facts, spec.key);
    if (!f) continue;
    const label = extract(f.statement, [spec.label]);
    if (!label) continue;
    const note = spec.note ? extract(f.statement, [spec.note]) : null;
    badges.push(note ? { label, note } : { label });
    badgeCites.push(f.id);
  }
  if (badges.length >= LIMITS.badges[0])
    out.push({
      kind: "badge-strip",
      badges: badges.slice(0, LIMITS.badges[1]),
      id: newBlockId(),
      after: 0,
      cites: badgeCites,
      generatedBy: "system",
      origin: "about",
    });

  return out;
}

const SERVICE_TILES: { key: string; label: string; re: RegExp; more?: RegExp }[] = [
  {
    key: "operations.service-desk-hours",
    label: "Calls answered live",
    re: /(\d+(?:\.\d+)?%) of calls are answered live/i,
    more: /more than \d+(?:\.\d+)?% of calls/i,
  },
  {
    key: "operations.service-desk-hours",
    label: "Issues resolved remotely",
    re: /(\d+(?:\.\d+)?%) of issues are resolved remotely/i,
  },
  {
    key: "book.first-contact-resolution",
    label: "First-contact resolution",
    re: /first-contact resolution is (?:above |over |more than )?(\d+(?:\.\d+)?%)/i,
    more: /first-contact resolution is (?:above|over|more than) \d/i,
  },
];

/**
 * Service stat tiles, origin "service-stats". A ">" is written only where the fact itself says
 * "more than" or "above" that number, and every tile is re-checked through groundValue, the same
 * gate a model tile passes. null when fewer than two tiles survive.
 */
export function buildServiceStatsBlock(facts: GroundFact[]): DraftBlock | null {
  const tiles: { value: string; label: string }[] = [];
  const cites: string[] = [];
  for (const spec of SERVICE_TILES) {
    const f = factFor(facts, spec.key);
    if (!f) continue;
    const m = spec.re.exec(f.statement);
    if (!m?.[1]) continue;
    const value = `${spec.more?.test(f.statement) ? ">" : ""}${m[1]}`;
    if (value.length > LIMITS.tileValue || !groundValue(value, f.statement)) continue;
    tiles.push({ value, label: spec.label });
    if (!cites.includes(f.id)) cites.push(f.id);
  }
  if (tiles.length < LIMITS.tiles[0]) return null;
  return {
    kind: "stat-tiles",
    tiles: tiles.slice(0, LIMITS.tiles[1]),
    id: newBlockId(),
    after: 0,
    cites,
    generatedBy: "system",
    origin: "service-stats",
  };
}

const ONBOARDING_STEPS: { key: string; title: string; re: RegExp }[] = [
  { key: "onboarding.pre-onboarding", title: "Pre-onboarding", re: /^Pre-onboarding:\s*(.+)$/i },
  { key: "onboarding.onboarding-day", title: "Onboarding day", re: /^On the onboarding day,\s*(.+)$/i },
  { key: "onboarding.first-30-days", title: "First 30 days", re: /^In the first 30 days,\s*(.+)$/i },
  { key: "onboarding.days-31-90", title: "Day 31 to 90 and beyond", re: /^From day 31 to 90 and beyond,\s*(.+)$/i },
];

/**
 * The onboarding timeline (stretch kind), origin "onboarding": each step's body is the fact's own
 * sentence after its lead-in. null unless at least two of the four phase facts are live and still
 * open the way the extractors expect.
 */
export function buildOnboardingTimeline(facts: GroundFact[]): DraftBlock | null {
  const steps: { label: string; title: string; body: string }[] = [];
  const cites: string[] = [];
  for (const spec of ONBOARDING_STEPS) {
    const f = factFor(facts, spec.key);
    if (!f) continue;
    const body = extract(f.statement.trim(), [spec.re]);
    if (!body || body.length > STEP_BODY_MAX) continue;
    steps.push({ label: `Step ${steps.length + 1}`, title: spec.title, body });
    cites.push(f.id);
  }
  if (steps.length < TIMELINE_STEPS[0]) return null;
  return {
    kind: "timeline",
    steps,
    id: newBlockId(),
    after: 0,
    cites,
    generatedBy: "system",
    origin: "onboarding",
  };
}

/**
 * The client references block (references-block.ts), origin "references", for the server route
 * that lands the answer to the references question. No cites: the entries are the person's, not
 * a fact's. `after` is the anchor the caller chose (the route closes the section with it). The
 * entries are stored as given; the caller has already read them through readReferenceEntries.
 */
export function buildReferencesBlock(entries: ReferenceEntry[], after: number): DraftBlock {
  return {
    kind: "references",
    references: entries,
    id: newBlockId(),
    after,
    cites: [],
    generatedBy: "system",
    origin: "references",
  };
}

// ---------------------------------------------------------------------------
// Which section is "About us"
// ---------------------------------------------------------------------------

const WHO = "(?:company|corporate|firm|vendor|bidder|proposer|respondent|offeror|contractor|provider|organization(?:al)?|business)";

/** Phrases that mean "tell us about the responding company". A bare "Overview" or "Background" is usually the ISSUER describing itself, so neither counts alone. */
const ABOUT_PATTERNS: RegExp[] = [
  /\babout (?:us|xl\.?net|the (?:company|firm|vendor|bidder|proposer|respondent|offeror|contractor|provider)|your (?:company|firm|organization|business))\b/,
  new RegExp(`\\b${WHO}(?:'s)? (?:information|profile|background|overview|history|description|qualifications|experience)\\b`),
  new RegExp(`\\b(?:information|profile|background|overview|history|description|qualifications|experience) of (?:the |your )?${WHO}\\b`),
  /\bdescription of your (?:business|company|firm|organization)\b/,
  /\bqualifications and experience\b|\bexperience and qualifications\b/,
  /\bwho we are\b/,
];

/** Title-only: a section CALLED "Qualifications" is about the vendor; the word in a requirement is not evidence. */
const ABOUT_TITLE_ONLY = /\bqualifications\b/;

/**
 * The section the company snapshot belongs on, or null. Label + title weigh 3 per phrase matched,
 * each of the section's requirements that matches weighs 1; a section needs 3, and a tie goes to
 * the first in structure order. Reserved "__" labels never qualify.
 */
export function pickAboutSection(
  structure: { label: string; title: string }[],
  requirements: { structureLabel: string; text: string }[]
): string | null {
  if (!Array.isArray(structure)) return null;
  const reqs = Array.isArray(requirements) ? requirements : [];
  let best: { label: string; score: number } | null = null;
  for (const s of structure) {
    if (!s || typeof s.label !== "string" || s.label.startsWith("__")) continue;
    const head = `${s.label} ${typeof s.title === "string" ? s.title : ""}`.toLowerCase();
    let hits = ABOUT_PATTERNS.filter((re) => re.test(head)).length;
    if (hits === 0 && ABOUT_TITLE_ONLY.test(head)) hits = 1;
    let score = hits * 3;
    for (const r of reqs) {
      if (!r || r.structureLabel !== s.label || typeof r.text !== "string") continue;
      const text = r.text.slice(0, 4000).toLowerCase();
      if (ABOUT_PATTERNS.some((re) => re.test(text))) score += 1;
    }
    if (score >= 3 && (!best || score > best.score)) best = { label: s.label, score };
  }
  return best ? best.label : null;
}

// ---------------------------------------------------------------------------
// Shared presentation arithmetic
// ---------------------------------------------------------------------------

/**
 * Column widths as fractions summing to 1, shared by the screen <colgroup>, the docx grid and the
 * pdf columns so a table breaks its lines the same way everywhere. A column's weight is its
 * header and its typical cell, so the long-text column gets the room; no column falls under a
 * floor that keeps a short "Priority" column readable.
 */
export function tableColumnFractions(b: Body<"table">): number[] {
  const n = b.columns.length;
  if (n === 0) return [];
  // The reference card (references-block.ts referenceCardTable): two columns, no caption, a
  // BLANK second header. Every card is pinned to the template's one-third label column, so a
  // set of cards lines up whatever each one's values are, on screen, in Word and in the PDF.
  // Nothing else has this shape: a stored table (readBody) and a model table (parseModelVisuals)
  // both refuse an empty header, and a card is never stored as a table, only derived.
  if (n === 2 && b.caption === null && b.columns[1].header === "") return [0.3333, 0.6667];
  const weights = b.columns.map((col, c) => {
    const lens = b.rows.map((r) => (r[c] ?? "").length);
    const max = lens.length ? Math.max(...lens) : 0;
    const mean = lens.length ? lens.reduce((a, x) => a + x, 0) / lens.length : 0;
    return Math.min(60, Math.max(6, col.header.length, (max + mean) / 2));
  });
  const total = weights.reduce((a, x) => a + x, 0);
  const floor = Math.min(0.12, 1 / n);
  let fr = weights.map((w) => Math.max(floor, w / total));
  const sum = fr.reduce((a, x) => a + x, 0);
  fr = fr.map((f) => Math.round((f / sum) * 10000) / 10000);
  // Rounding residue lands on the widest column, so the fractions sum to exactly 1.
  const widest = fr.indexOf(Math.max(...fr));
  const rest = fr.reduce((a, x, i) => (i === widest ? a : a + x), 0);
  fr[widest] = Math.round((1 - rest) * 10000) / 10000;
  return fr;
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/** One line naming a block, for the edit-mode "kept as they are" list and the Remove action's label. */
export function draftBlockSummary(b: DraftBlock): string {
  switch (b.kind) {
    case "stat-tiles":
      return `${b.origin === "service-stats" ? "Service stats" : "Stat tiles"} · ${b.tiles.length} figures`;
    case "fact-grid":
      return `${b.origin === "about" ? "Company snapshot" : "Fact grid"} · ${b.pairs.length} facts`;
    case "badge-strip":
      return `Certifications · ${clip(b.badges.map((x) => x.label).join(", "), 70)}`;
    case "table":
      return `Table · ${b.caption ? clip(b.caption, 70) : `${b.columns.length} columns, ${b.rows.length} ${b.rows.length === 1 ? "row" : "rows"}`}`;
    case "callout":
      return `Callout · ${clip(b.title ?? b.body, 70)}`;
    case "cards":
      return `Cards · ${clip(b.cards.map((c) => c.title).join(" / "), 70)}`;
    case "timeline":
      return `Timeline · ${b.steps.length} steps`;
    case "references": {
      const n = b.references.length;
      return `Client references · ${n} ${n === 1 ? "reference" : "references"}`;
    }
  }
}
