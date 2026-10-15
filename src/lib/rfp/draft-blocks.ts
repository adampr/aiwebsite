/**
 * Visual blocks on a drafted proposal section (ARCHITECTURE.md §5.17).
 *
 * A DraftSectionRecord is paragraphs plus, optionally, `blocks`: stat tiles, a fact grid, a badge
 * strip, a table, a callout, two- or three-up cards, a timeline. Each block is anchored by `after` (how many
 * paragraphs precede it) and carries its own cites, so the C1 staleness join works per block.
 *
 * This module is the whole contract: the stored shape, the tolerant read, the ONE ordering
 * (`interleave`) the screen, resolve-draft and both exporters share, and the grounding that keeps
 * a number out of a visual unless a fact states it.
 *
 * PURE and CLIENT-SAFE. It is imported by the "use client" workspace, so: type-only imports (the
 * two value imports are references-block.ts and tile-fit.ts, each pure and client-safe by
 * contract), no server modules, and NO lookbehind regexes (Safari before 16.4 cannot parse one,
 * and a parse error takes the whole bundle down). Preceding-character checks are done by hand on
 * the index.
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
import { valueFitsTile } from "./tile-fit";

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
  // Two-up or three-up (round 32: Phone / Email / Portal).
  cards: [2, 3],
  calloutBody: 700,
  label: 60,
  tileValue: 16,
  // A model `ledger` (stored as a fact-grid): label/value rows.
  ledger: [2, 12],
  // A model timeline step's kicker: a date or date range, or "Step N".
  timelineKicker: 24,
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
  return want.every((w) => tokenGrounded(w, have));
}

/** One value token against a fact's tokens: groundValue's per-number rule. */
function tokenGrounded(w: NumToken, have: NumToken[]): boolean {
  return have.some(
    (h) =>
      h.num === w.num &&
      h.prefix === w.prefix &&
      h.suffix === w.suffix &&
      h.pct === w.pct &&
      (w.qualifier === null || w.qualifier === h.qualifier)
  );
}

function factText(f: GroundFact): string {
  return `${f.statement} ${f.detail ?? ""}`;
}

/**
 * A `pricing.*` fact never grounds or backs a table built from text (the markdown lift, the
 * parseTable salvage): its numbers are money with the sign left off ("247" grounds against "$247
 * per user per month"), and rule B7 keeps money out of every block.
 */
function isPricingFact(f: GroundFact | undefined): boolean {
  return !!f && typeof f.key === "string" && f.key.startsWith("pricing.");
}

/**
 * The cites a table built from text carries: only the candidates whose own text grounds at least
 * one of the table's numeric tokens, so an edit to an unrelated cited fact never marks it stale
 * (rule C1). A table with no number grounded nothing in particular and keeps every candidate, as
 * does one no single fact grounds on its own.
 */
function groundingCites(strings: string[], ids: string[], byId: Map<string, GroundFact>): string[] {
  const want = strings.flatMap((s) => {
    const n = normGround(s);
    return FOREIGN_NUMERAL.test(n) ? [] : numTokens(n);
  });
  if (want.length === 0) return ids;
  const out = ids.filter((id) => {
    const f = byId.get(id);
    if (!f || f.polarity === "negative") return false;
    const have = numTokens(normGround(factText(f)));
    return want.some((w) => tokenGrounded(w, have));
  });
  return out.length > 0 ? out : ids;
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
      // No valueFitsTile here: that is the WRITE contract (parseStats, buildServiceStatsBlock).
      // A stored value wider than it predates the contract and still sets on one line, smaller;
      // refusing it would silently delete the block from a draft that already shows it.
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
  | { ok: DraftBlockBody; cites: string[]; tooWide?: number }
  | { degrade: string[]; cites: string[] }
  | { drop: string; tooWide?: number };

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

/** One model tile through the grounding: its cleaned value and label and the fact it names, or null. */
function groundedTile(
  t: unknown,
  byId: Map<string, GroundFact>
): { value: string; label: string; factId: string } | null {
  if (!isObj(t) || typeof t.fact !== "string") return null;
  const fact = byId.get(t.fact);
  if (!fact || fact.polarity === "negative") return null;
  const value = clean(t.value, LIMITS.tileValue);
  const label = clean(t.label, LIMITS.label);
  if (!value || !label || !/\d/.test(value)) return null;
  const text = factText(fact);
  if (!groundValue(value, text) || !valueWordsGround(value, text)) return null;
  if (!groundValue(label, text)) return null;
  return { value, label, factId: fact.id };
}

function parseStats(item: Record<string, unknown>, byId: Map<string, GroundFact>): Parsed {
  if (!Array.isArray(item.tiles)) return { drop: "malformed" };
  const tiles: { value: string; label: string }[] = [];
  const cites: string[] = [];
  let tooWide = 0;
  for (const t of item.tiles.slice(0, 12)) {
    if (tiles.length >= LIMITS.tiles[1]) break;
    const tile = groundedTile(t, byId);
    if (!tile || tiles.some((x) => x.value === tile.value && x.label === tile.label)) continue;
    // A value is the figure alone (tile-fit.ts): one too wide to set on one line of a
    // four-across tile at the floor size is skipped, grounded or not. Its words go in the label.
    if (!valueFitsTile(tile.value)) {
      tooWide++;
      continue;
    }
    tiles.push({ value: tile.value, label: tile.label });
    if (!cites.includes(tile.factId)) cites.push(tile.factId);
  }
  if (tiles.length >= LIMITS.tiles[0]) return { ok: { kind: "stat-tiles", tiles }, cites, tooWide };
  // Width gets its own reason when it is what sank the block; every skipped tile is counted
  // (visualStats.tooWide), kept block or not, so the activity log shows the contract working.
  return { drop: tiles.length + tooWide >= LIMITS.tiles[0] ? "value-too-wide" : "fewer-than-two-grounded-tiles", tooWide };
}

/**
 * A model table. `salvage` is the section's own cites (and their affirmative corpus), tried only
 * when the visual cited nothing known: models routinely leave `cites` empty on a table whose every
 * figure the section's facts state, and degrading that to " · " prose is what turned an SLA table
 * into four paragraphs. The salvage changes WHICH facts ground the cells, never whether they are
 * grounded; when it fails too, the table degrades exactly as before. A salvaged table cites only
 * the facts that ground its numbers (`narrow`, groundingCites).
 */
function parseTable(
  item: Record<string, unknown>,
  cites: string[],
  corpus: string,
  salvage: { cites: string[]; corpus: string; narrow: (strings: string[]) => string[] } | null = null
): Parsed {
  if (!Array.isArray(item.columns) || !Array.isArray(item.rows)) return { drop: "malformed" };
  // A column is a string, or the stored shape `{ header }` a model echoes back; anything else
  // cleans to null and fails the shape.
  const headers = item.columns.slice(0, 12).map((c) => clean(isObj(c) ? c.header : c, LIMITS.label));
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
  const all = [caption ?? "", ...(headers as string[]), ...rows.flat()];
  const body = (): Body<"table"> => ({
    kind: "table",
    caption: caption ? caption : null,
    columns: (headers as string[]).map((header) => ({ header, align: "left" as const })),
    rows,
    emphasizeLastRow: false,
  });
  if (shapeOk && cites.length > 0) {
    if (!all.every((s) => groundValue(s, corpus))) return { drop: "ungrounded" };
    return { ok: body(), cites };
  }
  if (shapeOk && salvage && salvage.cites.length > 0 && all.every((s) => groundValue(s, salvage.corpus)))
    return { ok: body(), cites: salvage.narrow(all) };
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
 * A model `ledger`: label/value rows, stored as the content-model fact-grid (the body the About
 * snapshot already uses, so every surface draws it). `rows` is the model's key; `pairs`, the
 * stored shape a model may echo back from a revise prompt, is read the same way. Same discipline
 * as cards: in range, within limits and citing something known is a block whose every number
 * grounds; over a limit or citing nothing known degrades to "label: value" prose; anything else
 * drops.
 */
function parseLedger(item: Record<string, unknown>, cites: string[], corpus: string): Parsed {
  const raw = Array.isArray(item.rows) ? item.rows : item.pairs;
  if (!Array.isArray(raw)) return { drop: "malformed" };
  const pairs: { label: string; value: string }[] = [];
  let withinLimits = true;
  for (const r of raw.slice(0, 40)) {
    if (!isObj(r)) return { drop: "malformed" };
    const label = clean(r.label, TITLE_MAX);
    const value = clean(r.value, DEGRADED_MAX);
    if (!label || !value) return { drop: "malformed" };
    if (label.length > LIMITS.label || value.length > FACT_VALUE_MAX) withinLimits = false;
    pairs.push({ label, value });
  }
  if (pairs.length === 0) return { drop: "malformed" };
  if (withinLimits && raw.length === pairs.length && inRange(pairs.length, LIMITS.ledger) && cites.length > 0) {
    if (!pairs.every((p) => groundValue(`${p.label} ${p.value}`, corpus))) return { drop: "ungrounded" };
    return { ok: { kind: "fact-grid", pairs }, cites };
  }
  return { degrade: pairs.map((p) => `${p.label}: ${p.value}`), cites };
}

/** "Step 3" written as the kicker of the third step: ordinal furniture, not a claim. */
function isOwnStepNumber(kicker: string, position: number): boolean {
  const m = /^step (\d{1,2})$/i.exec(kicker);
  return m !== null && Number(m[1]) === position;
}

/**
 * A kicker that IS a date or date range ("Dec 11, 2026", "Dec 11 - Jan 10", "By Nov 30, 2026"):
 * the only kicker shape allowed to ground against a brief's own text (kickerCorpus). Anything
 * else carrying a number ("Setup fee 1,200") must cite a fact, or a brief's rates would reach a
 * visual through this slot.
 */
const DATE_KICKER =
  /^(?:by |from |until )?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d{1,2}(?:, \d{4})?(?: ?(?:-|–|to) ?(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? )?\d{1,2}(?:, \d{4})?)?$/i;

/**
 * A model timeline: 2..6 steps {kicker?, title, body}, stored as the content-model timeline body,
 * whose per-step `label` IS the kicker slot. Every number in a kicker, title or body grounds
 * against the visual's cites, like a table cell. A kicker is used only when EVERY step carries a
 * real one (a date or date range); otherwise every step reads "Step N", the label the system's
 * onboarding timeline uses, so one timeline never mixes the two. A kicker that is just its own
 * "Step N" is that furniture, not a figure, and is not grounded.
 */
function parseTimeline(
  item: Record<string, unknown>,
  cites: string[],
  corpus: string,
  kickerCorpus: string | null = null
): Parsed {
  if (!Array.isArray(item.steps)) return { drop: "malformed" };
  const steps: { kicker: string; title: string; body: string }[] = [];
  let withinLimits = true;
  for (const s of item.steps.slice(0, 12)) {
    if (!isObj(s)) return { drop: "malformed" };
    const title = clean(s.title, TITLE_MAX);
    const body = clean(s.body, DEGRADED_MAX);
    const kicker = s.kicker == null || s.kicker === "" ? "" : clean(s.kicker, TITLE_MAX);
    if (!title || !body || kicker === null) return { drop: "malformed" };
    if (title.length > LIMITS.label || body.length > STEP_BODY_MAX || kicker.length > LIMITS.timelineKicker)
      withinLimits = false;
    steps.push({ kicker: isOwnStepNumber(kicker, steps.length + 1) ? "" : kicker, title, body });
  }
  if (steps.length === 0) return { drop: "malformed" };
  if (
    withinLimits &&
    item.steps.length === steps.length &&
    inRange(steps.length, TIMELINE_STEPS) &&
    cites.length > 0
  ) {
    // A brief document's kickers may also ground against the brief (kickerCorpus): "Dec 11, 2026"
    // as the brief dates the onboarding day. ONLY a date-shaped kicker earns that wider corpus;
    // any other number in a kicker ("Setup fee 1,200") still needs a cited fact, or a brief's
    // own rates would ride into a visual through this slot. Titles and bodies always ground
    // against the cites only.
    const kickerGround = (k: string) =>
      kickerCorpus && DATE_KICKER.test(k) ? `${corpus} \n ${kickerCorpus}` : corpus;
    const grounded = (s: (typeof steps)[number]) =>
      groundValue(s.kicker, kickerGround(s.kicker)) && groundValue(`${s.title} ${s.body}`, corpus);
    if (!steps.every(grounded)) return { drop: "ungrounded" };
    const dated = steps.every((s) => s.kicker !== "");
    return {
      ok: {
        kind: "timeline",
        steps: steps.map((s, i) => ({ label: dated ? s.kicker : `Step ${i + 1}`, title: s.title, body: s.body })),
      },
      cites,
    };
  }
  return {
    degrade: steps.map((s) => `${s.kicker ? `${s.kicker} · ` : ""}${s.title}: ${s.body}`),
    cites,
  };
}

/**
 * Validate the drafter's `visuals` array. Never throws and never fails a section: a visual that is
 * shape-valid and grounded becomes a block; one that is malformed (or cites nothing known) but
 * whose text is grounded becomes prose for the caller to append; everything else is dropped with a
 * reason worth logging. A shape-valid table that cites nothing known is first re-grounded against
 * the section's own cites (parseTable's salvage) and kept as a block citing them when that holds.
 *
 * Degraded prose is checked against the facts the section itself cites plus the visual's own
 * (every supplied fact when neither resolves), and only as many paragraphs as fit under
 * PARAGRAPH_CAP are handed back; a visual that does not fit whole is dropped, not half-kept.
 */
export function parseModelVisuals(
  raw: unknown,
  ctx: {
    facts: GroundFact[];
    paragraphCount: number;
    sectionCites: string[];
    /** A brief document's text (round 32): a timeline STEP KICKER's numbers may ground against it
     *  as well as the cited facts. Titles, bodies and every other kind ignore it. */
    kickerCorpus?: string;
  }
): { blocks: DraftBlock[]; degraded: string[]; dropped: Dropped[]; tooWide: number } {
  const blocks: DraftBlock[] = [];
  let tooWide = 0;
  const degraded: string[] = [];
  const dropped: Dropped[] = [];
  if (!Array.isArray(raw)) return { blocks, degraded, dropped, tooWide };

  const facts = Array.isArray(ctx?.facts) ? ctx.facts.filter((f) => isObj(f) && typeof f.id === "string") : [];
  const byId = new Map(facts.map((f) => [f.id, f]));
  const paragraphCount = Number.isFinite(ctx?.paragraphCount) ? Math.max(0, Math.floor(ctx.paragraphCount)) : 0;
  const sectionCites = Array.isArray(ctx?.sectionCites) ? ctx.sectionCites : [];
  // A `pricing.*` fact grounds NO model visual (round 32, every kind): its numbers are money with
  // the sign left off, so "Fully managed user: 247 monthly" citing the rate fact would pass the
  // currency veto and ground. It stays citable (as a [negative] fact does); it just grounds nothing.
  const textOf = (ids: string[]) =>
    ids
      .map((id) => byId.get(id))
      .filter((f): f is GroundFact => !!f && !isPricingFact(f))
      .map(factText)
      .join(" \n ");
  // Stat tiles name their own fact: the same exclusion, as a map without the pricing facts.
  const tileById = new Map([...byId].filter(([, f]) => !isPricingFact(f)));
  const kickerCorpus =
    typeof ctx?.kickerCorpus === "string" && ctx.kickerCorpus.trim() ? ctx.kickerCorpus : null;
  // The table salvage (parseTable): the section's own cites that resolve, pricing facts out, and
  // the corpus of the affirmative ones (none left: no salvage). Built once; used only by a table
  // that cited nothing known.
  const salvageCites = knownCites(sectionCites, byId).filter((id) => !isPricingFact(byId.get(id)));
  const salvageCorpusIds = salvageCites.filter((id) => byId.get(id)?.polarity !== "negative");
  const salvage = {
    cites: salvageCorpusIds.length > 0 ? salvageCites : [],
    corpus: textOf(salvageCorpusIds),
    narrow: (strings: string[]) => groundingCites(strings, salvageCites, byId),
  };

  for (const item of raw.slice(0, MODEL_SCAN_MAX)) {
    let kind = "unknown";
    try {
      if (!isObj(item)) {
        dropped.push({ kind, reason: "malformed" });
        continue;
      }
      kind = typeof item.kind === "string" ? item.kind.slice(0, 40) : "unknown";
      if (kind === "stat-tiles") kind = "stats";
      // A closed allowlist, not DRAFT_BLOCK_KINDS. Round 32 admits `timeline` and `ledger` (the
      // model's name for a label/value fact-grid), each grounded against its own cites. Still never
      // accepted from the model: `fact-grid` and `badge-strip` by those names (the company
      // snapshot is built by the server from facts) and `references` (a person's contacts).
      if (
        kind !== "stats" &&
        kind !== "table" &&
        kind !== "callout" &&
        kind !== "cards" &&
        kind !== "timeline" &&
        kind !== "ledger"
      ) {
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
          ? parseStats(item, tileById)
          : kind === "table"
            ? parseTable(item, cites, corpus, cites.length === 0 ? salvage : null)
            : kind === "callout"
              ? parseCallout(item, cites, corpus)
              : kind === "cards"
                ? parseCards(item, cites, corpus)
                : kind === "timeline"
                  ? parseTimeline(item, cites, corpus, kickerCorpus)
                  : parseLedger(item, cites, corpus);

      if ("tooWide" in parsed) tooWide += parsed.tooWide ?? 0;
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
  return { blocks, degraded, dropped, tooWide };
}

// ---------------------------------------------------------------------------
// Markdown tables written as prose
// ---------------------------------------------------------------------------

/** A GFM delimiter cell: one or more dashes, either side optionally a colon. */
const MD_SEPARATOR_CELL = /^:?-+:?$/;
const MD_EMPHASIS = ["**", "__", "`", "*"] as const;

/**
 * One markdown table row as cells: the outer pipes are optional, a `\|` is a literal pipe inside a
 * cell (checked by hand on the preceding character, never a lookbehind), every cell trimmed.
 */
function splitPipeRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (s[i] === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

/**
 * A cell without the inline emphasis that wraps ALL of it (`**x**`, `__x__`, `` `x` ``, `*x*`):
 * the markup is presentation the block draws itself. A wrapper that does not span the whole cell
 * (`**a** and **b**`) is left as written.
 */
function unwrapEmphasis(cell: string): string {
  let s = cell.trim();
  for (let pass = 0; pass < 3; pass++) {
    const w = MD_EMPHASIS.find((m) => {
      if (s.length <= 2 * m.length || !s.startsWith(m) || !s.endsWith(m)) return false;
      const inner = s.slice(m.length, -m.length);
      return inner.trim() !== "" && !inner.includes(m);
    });
    if (!w) break;
    s = s.slice(w.length, -w.length).trim();
  }
  return s;
}

/**
 * The GitHub-markdown tables in one paragraph's lines: a header line of two or more cells, a
 * separator line of exactly as many delimiter cells (`-`, `---`, `:--:`) right under it, then
 * every following line that carries a pipe. `rows` keeps each data line's own cells, ragged or
 * not; the conversion refuses a ragged table rather than padding it.
 */
function findMarkdownTables(lines: string[]): { start: number; end: number; header: string[]; rows: string[][] }[] {
  const out: { start: number; end: number; header: string[]; rows: string[][] }[] = [];
  let i = 0;
  while (i + 2 < lines.length) {
    const header = lines[i].includes("|") ? splitPipeRow(lines[i]) : [];
    const sep = header.length >= 2 ? splitPipeRow(lines[i + 1]) : [];
    if (header.length < 2 || sep.length !== header.length || !sep.every((c) => MD_SEPARATOR_CELL.test(c))) {
      i++;
      continue;
    }
    let end = i + 2;
    while (end < lines.length && lines[end].includes("|")) end++;
    if (end === i + 2) {
      i++;
      continue;
    }
    out.push({ start: i, end, header, rows: lines.slice(i + 2, end).map(splitPipeRow) });
    i = end;
  }
  return out;
}

/** One found table through every control, or null (it then stays in the text exactly as written). */
function markdownTableBody(rawHeader: string[], rawCells: string[][], corpus: string): Body<"table"> | null {
  const header = rawHeader.map(unwrapEmphasis);
  const rawRows = rawCells.map((r) => r.map(unwrapEmphasis));
  // Rule B7 first, on the raw text and again on the cleaned text (NFKC can surface a sign).
  if ([...header, ...rawRows.flat()].some(hasCurrency)) return null;
  if (!inRange(header.length, LIMITS.tableCols) || !inRange(rawRows.length, LIMITS.tableRows)) return null;
  const headers = header.map((h) => clean(h, LIMITS.label));
  // An empty header is refused: the stored read (readBody) would drop the block on its next read.
  if (headers.some((h) => !h)) return null;
  const rows: string[][] = [];
  for (const r of rawRows) {
    if (r.length !== headers.length) return null;
    const row = r.map((c) => clean(c, LIMITS.cell));
    if (row.some((c) => c === null)) return null;
    if (!row.some((c) => c !== "")) return null;
    rows.push(row as string[]);
  }
  const all = [...(headers as string[]), ...rows.flat()];
  if (all.some(hasCurrency)) return null;
  if (!all.every((s) => groundValue(s, corpus))) return null;
  return {
    kind: "table",
    caption: null,
    columns: (headers as string[]).map((header) => ({ header, align: "left" as const })),
    rows,
    emphasizeLastRow: false,
  };
}

/**
 * Tabular content is always a visual (ARCHITECTURE.md §5.17.19). A GitHub-markdown table written
 * inside a paragraph (a consolidation revise, a person's paste) becomes a real `table` block,
 * anchored where it stood, and the prose around it stays as its own paragraphs.
 *
 * Every control blocks, and a table that fails one stays in the text exactly as written, never
 * half-lifted: no currency anywhere (rule B7), headers and cells (whole-cell emphasis markup
 * removed) through `clean` and the limits, 2 to 5 columns, 1 to 14 rows, no ragged row, no empty
 * row, and every string grounded against the affirmative facts among the section's own cites,
 * `pricing.*` facts excluded (none left means nothing lifts). The block cites only those of the
 * candidates that ground one of its numbers (all of them for a table with no number). The block
 * cap counts the blocks already there, and a lift that would push the paragraph count past
 * PARAGRAPH_CAP (a table between two prose runs) is refused, because the edit route keeps only the
 * first PARAGRAPH_CAP paragraphs of whatever it is sent. `refused` counts the tables found but
 * left as text by any of those controls; the caller can only report it.
 *
 * Every block keeps its place in the flow: an existing block anchored before old paragraph a sorts
 * at a, a table lifted from inside old paragraph j at j + 0.5 (stable), and existing anchors follow
 * the paragraphs, not the count. When nothing lifts, the INPUT arrays come back as they were (===),
 * so a caller can skip the write.
 */
export function liftMarkdownTables(
  paragraphs: string[],
  existingBlocks: DraftBlock[] | undefined,
  facts: GroundFact[],
  sectionCites: string[]
): { paragraphs: string[]; blocks: DraftBlock[] | undefined; lifted: number; refused: number } {
  const unchanged = (refused: number) => ({ paragraphs, blocks: existingBlocks, lifted: 0, refused });
  if (!Array.isArray(paragraphs) || !paragraphs.some((p) => typeof p === "string" && p.includes("|"))) return unchanged(0);
  const linesOf = (p: unknown) => (typeof p === "string" && p.includes("|") ? p.split("\n") : null);
  const countFound = () =>
    paragraphs.reduce((n, p) => {
      const lines = linesOf(p);
      return n + (lines ? findMarkdownTables(lines).length : 0);
    }, 0);
  const existing = Array.isArray(existingBlocks) ? existingBlocks : [];
  let room = LIMITS.blocksPerSection - existing.length;
  if (room <= 0) return unchanged(countFound());

  const live = Array.isArray(facts) ? facts.filter((f) => isObj(f) && typeof f.id === "string") : [];
  const byId = new Map(live.map((f) => [f.id, f]));
  const cites = knownCites(sectionCites, byId).filter((id) => !isPricingFact(byId.get(id)));
  const corpusFacts = cites.map((id) => byId.get(id)!).filter((f) => f.polarity !== "negative");
  if (corpusFacts.length === 0) return unchanged(countFound());
  const corpus = corpusFacts.map(factText).join(" \n ");

  const nextParagraphs: string[] = [];
  // Each block with its place in the OLD flow (see the doc comment), sorted once at the end.
  const placed: { key: number; block: DraftBlock }[] = [];
  const lifted: DraftBlock[] = [];
  let refused = 0;
  // startOf[k] = where old paragraph k now begins; startOf[length] = the new count.
  const startOf: number[] = [];
  let spare = Math.max(PARAGRAPH_CAP, paragraphs.length) - paragraphs.length;

  paragraphs.forEach((p, j) => {
    startOf.push(nextParagraphs.length);
    const lines = linesOf(p);
    const tables = lines ? findMarkdownTables(lines) : [];
    // Segments of this paragraph: prose runs and lifted tables, in order.
    const parts: ({ prose: string } | { table: Body<"table"> })[] = [];
    let from = 0;
    let taken = 0;
    for (const t of tables) {
      const body = taken < room ? markdownTableBody(t.header, t.rows, corpus) : null;
      if (!body) {
        refused++;
        continue;
      }
      parts.push({ prose: lines!.slice(from, t.start).join("\n").trim() });
      parts.push({ table: body });
      from = t.end;
      taken++;
    }
    if (taken === 0) {
      nextParagraphs.push(p);
      return;
    }
    parts.push({ prose: lines!.slice(from).join("\n").trim() });
    const prose = parts.filter((x) => "prose" in x && x.prose !== "").length;
    if (prose - 1 > spare) {
      refused += taken;
      nextParagraphs.push(p);
      return;
    }
    spare -= prose - 1;
    room -= taken;
    for (const part of parts) {
      if ("table" in part) {
        let id = newBlockId();
        while (existing.some((b) => b.id === id) || lifted.some((b) => b.id === id)) id = newBlockId();
        const strings = [...part.table.columns.map((c) => c.header), ...part.table.rows.flat()];
        const block: DraftBlock = {
          ...part.table,
          id,
          after: nextParagraphs.length,
          cites: groundingCites(strings, cites, byId),
          generatedBy: "llm",
        };
        lifted.push(block);
        placed.push({ key: j + 0.5, block });
      } else if (part.prose !== "") nextParagraphs.push(part.prose);
    }
  });
  if (lifted.length === 0) return unchanged(refused);
  startOf.push(nextParagraphs.length);

  for (const b of existing) {
    const a = clampAfter(b.after, paragraphs.length);
    placed.push({ key: a, block: { ...b, after: startOf[a] } });
  }
  // Array.prototype.sort is stable: existing blocks sharing an anchor keep their stored order.
  placed.sort((x, y) => x.key - y.key);
  return {
    paragraphs: nextParagraphs,
    blocks: reanchorBlocks(
      placed.map((x) => x.block),
      nextParagraphs.length
    ),
    lifted: lifted.length,
    refused,
  };
}

/**
 * True when the text holds at least one GitHub-markdown table by THE detector the lift uses
 * (findMarkdownTables: a header of two or more cells, a same-width separator of delimiter cells,
 * at least one data line). The one entry point for every other reader of "is this a table": rule
 * D6 and any precheck call this, never a second pattern, so what the checks flag, what the lift
 * finds and what the preview draws cannot disagree. Says nothing about whether the lift would
 * CONVERT it (grounding, currency, limits): a refused table is still a table here.
 */
export function hasMarkdownTable(text: string): boolean {
  if (typeof text !== "string" || !text.includes("|")) return false;
  return findMarkdownTables(text.split("\n")).length > 0;
}

/** One item of a previewed paragraph, in the order written. */
export type MarkdownPreviewItem =
  | { kind: "prose"; text: string }
  | { kind: "table"; columns: string[]; rows: string[][] };

/**
 * A rendering aid for a PROPOSED paragraph (the Tron pane's preview, §5.17.19): null when the
 * paragraph holds no markdown table (the caller renders its plain paragraph, the fast path).
 * Otherwise the paragraph split exactly where the lift would split it, by the same detector: prose
 * runs between tables kept in order (trimmed, empty runs dropped, as the lift drops them), each
 * table as its header cells and row cells, trimmed and with whole-cell emphasis unwrapped by the
 * lift's own helpers.
 *
 * PARSE-ONLY. It previews what the author wrote and NEVER stores: no grounding, no currency veto,
 * no limits or caps, no cites, no NFKC clean, no block id. A ragged table (which the lift refuses)
 * is still previewed as a table with its rows as written; saying that the document may keep it as
 * text is the caller's caption. Nothing it returns may reach a write path: the lift at the write
 * (liftMarkdownTables) is the only door from pipe text to a stored table block.
 */
export function previewMarkdownTables(paragraph: string): { items: MarkdownPreviewItem[] } | null {
  if (typeof paragraph !== "string" || !paragraph.includes("|")) return null;
  const lines = paragraph.split("\n");
  const tables = findMarkdownTables(lines);
  if (tables.length === 0) return null;
  const items: MarkdownPreviewItem[] = [];
  const prose = (text: string) => {
    if (text !== "") items.push({ kind: "prose", text });
  };
  let from = 0;
  for (const t of tables) {
    prose(lines.slice(from, t.start).join("\n").trim());
    items.push({
      kind: "table",
      columns: t.header.map(unwrapEmphasis),
      rows: t.rows.map((r) => r.map(unwrapEmphasis)),
    });
    from = t.end;
  }
  prose(lines.slice(from).join("\n").trim());
  return { items };
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
 * "more than" or "above" that number, and every tile is re-checked through groundValue and the
 * one-line width check (valueFitsTile), the same gates a model tile passes. null when fewer than
 * two tiles survive.
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
    if (value.length > LIMITS.tileValue || !groundValue(value, f.statement) || !valueFitsTile(value)) continue;
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

const PROMPT_BLOCK_MAX = 2000;

/**
 * A block as model-readable text, for the revise and whole-document turns and the duplicate scan
 * (consolidate.ts reads it pre-serialized). The first line is `[visual <kind> id=<id>]`, then one
 * line per content element. A table's caption rides on that first line after the tag, so its
 * layout is fixed by position: line 2 is ALWAYS the header row and every later line a row, cells
 * joined by " | " (the duplicate scan reads rows back this way; a caption holding " | " cannot pass
 * for a header). Whole lines up to 2,000 chars, never a cut line (only a first line longer than
 * that alone is sliced). A `references` block gives its organizations only: the contacts are a
 * person's, and never enter a prompt.
 */
export function serializeBlockForPrompt(block: DraftBlock): string {
  const lines: string[] = [`[visual ${block.kind} id=${block.id}]`];
  switch (block.kind) {
    case "table":
      if (block.caption) lines[0] += ` ${block.caption}`;
      lines.push(block.columns.map((c) => c.header).join(" | "));
      for (const r of block.rows) lines.push(r.join(" | "));
      break;
    case "stat-tiles":
      for (const t of block.tiles) lines.push(`${t.value} ${t.label}`);
      break;
    case "fact-grid":
      for (const p of block.pairs) lines.push(`${p.label}: ${p.value}`);
      break;
    case "badge-strip":
      for (const x of block.badges) lines.push(x.label);
      break;
    case "callout":
      lines.push(block.title ? `${block.title}: ${block.body}` : block.body);
      break;
    case "cards":
      for (const c of block.cards) lines.push(`${c.title}: ${c.body}`);
      break;
    case "timeline":
      for (const s of block.steps) lines.push(s.title);
      break;
    case "references":
      for (const r of block.references) lines.push(r.organization);
      break;
  }
  const kept: string[] = [];
  let total = 0;
  for (const raw of lines) {
    const line = raw.replace(/\s*\n\s*/g, " ");
    const spend = line.length + (kept.length ? 1 : 0);
    if (total + spend > PROMPT_BLOCK_MAX) {
      if (kept.length === 0) kept.push(line.slice(0, PROMPT_BLOCK_MAX));
      break;
    }
    kept.push(line);
    total += spend;
  }
  return kept.join("\n");
}
