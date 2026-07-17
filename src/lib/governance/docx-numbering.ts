// Real Word numbering for the format-sample extractor (§5.12 round 15d).
// Word's AUTO-numbers live in word/numbering.xml (definitions) and
// word/styles.xml (style-inherited references), not in the body text; this
// module parses both and reconstructs the literal numbers ("III.",
// "Section 3:", "1.1") so extracted samples finally show what a human sees.
//
// Server-side only, over attacker-controlled XML, on the request path: the
// same iron rules as style-sample.ts apply. Every pass is LINEAR (indexOf
// walks, fixed-string region ends, bounded windows); every numeric
// attribute is parsed-and-clamped; letter/roman formatting is O(log n);
// every failure returns null and the caller falls back to the pre-round-15d
// output. Iteration caps make hostile files a truncation, never a hang.

const MAX_ABSTRACTS = 256;
const MAX_NUMS = 512;
const MAX_STYLES = 512;
const MAX_LEVELS = 9;
const LVL_REGION_CAP = 4000;
const ATTR_WINDOW = 300;
// Clamp window for every parsed numeric attribute (w:start, w:startOverride,
// w:ilvl): a hostile w:start="2000000000" must never size a loop or a label.
const MAX_NUM_VALUE = 9999;

export interface NumLevel {
  start: number;
  numFmt: string;
  lvlText: string;
  isLgl: boolean;
  // w:lvl/w:pStyle back-reference: THE way Word binds heading styles to
  // levels (ECMA-376 §17.9.23). A style's own numPr usually carries only
  // numId; the level comes from this reference.
  pStyle: string | null;
}

export interface AbstractNum {
  levels: (NumLevel | null)[];
  numStyleLink: string | null;
}

export interface NumDef {
  abstractNumId: string;
  startOverrides: Map<number, number>; // ilvl -> override value
}

export interface StyleDef {
  numId: string | null;
  ilvl: number | null; // explicit w:ilvl in the style's numPr (rare)
  basedOn: string | null;
}

export interface NumberingModel {
  abstracts: Map<string, AbstractNum>;
  nums: Map<string, NumDef>;
  styles: Map<string, StyleDef>;
}

interface AbstractState {
  vals: (number | null)[]; // null = has not fired since last reset
  effStart: number[]; // effective start per level (post-override)
}

export interface NumCounters {
  byAbstract: Map<string, AbstractState>;
  seenNums: Set<string>;
}

export type NumberingLabel =
  | { kind: "number"; label: string }
  | { kind: "bullet" }
  | { kind: "none" };

/* ------------------------------------------------------------------ *
 * Linear XML helpers (house style: indexOf walks, bounded windows)
 * ------------------------------------------------------------------ */

/** First occurrence of `tag` (e.g. "<w:lvl") at `from` or later whose next
 *  character is whitespace, ">", or "/", so "<w:lvl" never matches
 *  "<w:lvlText" or "<w:lvlOverride". -1 when absent. */
export function findTag(xml: string, tag: string, from: number): number {
  let i = from;
  while (i < xml.length) {
    const at = xml.indexOf(tag, i);
    if (at === -1) return -1;
    const b = xml.charAt(at + tag.length);
    if (b === ">" || b === "/" || b === " " || b === "\t" || b === "\n" || b === "\r")
      return at;
    i = at + tag.length;
  }
  return -1;
}

/** Value of `name="..."` inside a bounded window starting at `at`. */
function namedAttr(xml: string, at: number, name: string): string | null {
  const win = xml.slice(at, at + ATTR_WINDOW);
  const key = `${name}="`;
  const k = win.indexOf(key);
  if (k === -1) return null;
  const close = win.indexOf('"', k + key.length);
  return close === -1 ? null : win.slice(k + key.length, close);
}

/** First w:val after `marker` within `region` (bounded window). Returns
 *  null when the marker is absent, "" when it has no w:val. */
function markerVal(region: string, marker: string): string | null {
  const at = findTag(region, marker, 0);
  if (at === -1) return null;
  return namedAttr(region, at, "w:val") ?? "";
}

/** Parse-and-clamp a numeric attribute: NaN or out-of-window values are
 *  rejected (null), never propagated into counters or labels. */
function clampedInt(v: string | null, min: number, max: number): number | null {
  if (v === null || !/^\d{1,7}$/.test(v)) return null;
  const n = parseInt(v, 10);
  return n >= min && n <= max ? n : null;
}

/* ------------------------------------------------------------------ *
 * Model build
 * ------------------------------------------------------------------ */

/** Decode the five XML entities in a SHORT string (lvlText); bounded. */
function decodeShort(s: string): string {
  return s
    .slice(0, 64)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function parseLevels(region: string): (NumLevel | null)[] {
  const levels: (NumLevel | null)[] = new Array(MAX_LEVELS).fill(null);
  let pos = 0;
  for (let n = 0; n < MAX_LEVELS * 2; n++) {
    const at = findTag(region, "<w:lvl", pos);
    if (at === -1) break;
    let end = region.indexOf("</w:lvl>", at);
    if (end === -1) end = Math.min(region.length, at + LVL_REGION_CAP);
    const lvl = region.slice(at, Math.min(end, at + LVL_REGION_CAP));
    pos = end + 1;
    const ilvl = clampedInt(namedAttr(region, at, "w:ilvl"), 0, MAX_LEVELS - 1);
    if (ilvl === null || levels[ilvl]) continue;
    levels[ilvl] = {
      start: clampedInt(markerVal(lvl, "<w:start"), 0, MAX_NUM_VALUE) ?? 1,
      numFmt: markerVal(lvl, "<w:numFmt") ?? "decimal",
      lvlText: decodeShort(markerVal(lvl, "<w:lvlText") ?? ""),
      isLgl: findTag(lvl, "<w:isLgl", 0) !== -1,
      pStyle: markerVal(lvl, "<w:pStyle") || null,
    };
  }
  return levels;
}

/**
 * Index word/numbering.xml (+ optionally word/styles.xml) into a model.
 * Null when numbering.xml is null or holds nothing usable; the caller
 * treats null as "no enrichment" and produces the legacy output.
 */
export function buildNumberingModel(
  numberingXml: string | null,
  stylesXml: string | null
): NumberingModel | null {
  if (!numberingXml) return null;
  try {
    const abstracts = new Map<string, AbstractNum>();
    let pos = 0;
    for (let n = 0; n < MAX_ABSTRACTS; n++) {
      const at = findTag(numberingXml, "<w:abstractNum", pos);
      if (at === -1) break;
      let end = numberingXml.indexOf("</w:abstractNum>", at);
      if (end === -1) end = numberingXml.length;
      const region = numberingXml.slice(at, end);
      pos = end + 1;
      const id = namedAttr(numberingXml, at, "w:abstractNumId");
      if (id === null || abstracts.has(id)) continue;
      abstracts.set(id, {
        levels: parseLevels(region),
        numStyleLink: markerVal(region, "<w:numStyleLink") || null,
      });
    }

    const nums = new Map<string, NumDef>();
    pos = 0;
    for (let n = 0; n < MAX_NUMS; n++) {
      const at = findTag(numberingXml, "<w:num", pos);
      if (at === -1) break;
      let end = numberingXml.indexOf("</w:num>", at);
      if (end === -1) end = Math.min(numberingXml.length, at + LVL_REGION_CAP);
      const region = numberingXml.slice(at, end);
      pos = end + 1;
      const numId = namedAttr(numberingXml, at, "w:numId");
      const abstractNumId = markerVal(region, "<w:abstractNumId");
      if (numId === null || !abstractNumId || nums.has(numId)) continue;
      const startOverrides = new Map<number, number>();
      let op = 0;
      for (let k = 0; k < MAX_LEVELS * 2; k++) {
        const oAt = findTag(region, "<w:lvlOverride", op);
        if (oAt === -1) break;
        let oEnd = region.indexOf("</w:lvlOverride>", oAt);
        if (oEnd === -1) oEnd = Math.min(region.length, oAt + LVL_REGION_CAP);
        const oRegion = region.slice(oAt, oEnd);
        op = oEnd + 1;
        const ilvl = clampedInt(namedAttr(region, oAt, "w:ilvl"), 0, MAX_LEVELS - 1);
        const val = clampedInt(markerVal(oRegion, "<w:startOverride"), 0, MAX_NUM_VALUE);
        if (ilvl !== null && val !== null) startOverrides.set(ilvl, val);
      }
      nums.set(numId, { abstractNumId, startOverrides });
    }
    if (!abstracts.size || !nums.size) return null;

    const styles = new Map<string, StyleDef>();
    if (stylesXml) {
      pos = 0;
      for (let n = 0; n < MAX_STYLES; n++) {
        const at = findTag(stylesXml, "<w:style", pos);
        if (at === -1) break;
        let end = stylesXml.indexOf("</w:style>", at);
        if (end === -1) end = Math.min(stylesXml.length, at + LVL_REGION_CAP);
        const region = stylesXml.slice(at, end);
        pos = end + 1;
        const styleId = namedAttr(stylesXml, at, "w:styleId");
        if (styleId === null || styles.has(styleId)) continue;
        // The numPr window is bounded to its own element so an unrelated
        // w:val elsewhere in the style can never be read as a numId.
        let numId: string | null = null;
        let ilvl: number | null = null;
        const np = findTag(region, "<w:numPr", 0);
        if (np !== -1) {
          let npEnd = region.indexOf("</w:numPr>", np);
          if (npEnd === -1) npEnd = Math.min(region.length, np + ATTR_WINDOW);
          const npRegion = region.slice(np, npEnd);
          numId = markerVal(npRegion, "<w:numId") || null;
          ilvl = clampedInt(markerVal(npRegion, "<w:ilvl"), 0, MAX_LEVELS - 1);
        }
        styles.set(styleId, {
          numId,
          ilvl,
          basedOn: markerVal(region, "<w:basedOn") || null,
        });
      }
    }
    return { abstracts, nums, styles };
  } catch {
    return null;
  }
}

export function createCounters(): NumCounters {
  return { byAbstract: new Map(), seenNums: new Set() };
}

/* ------------------------------------------------------------------ *
 * Resolution
 * ------------------------------------------------------------------ */

/** The paragraph's style chain (own id, then basedOn ancestors), cycle-safe. */
function styleChain(model: NumberingModel, styleId: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let cur: string | null = styleId;
  for (let d = 0; d < 8 && cur && !seen.has(cur); d++) {
    seen.add(cur);
    chain.push(cur);
    cur = model.styles.get(cur)?.basedOn ?? null;
  }
  return chain;
}

/** Follow an abstract's numStyleLink to the abstract it delegates to.
 *  Cycle-and-depth-safe; null when the chain dead-ends. */
function resolveAbstract(
  model: NumberingModel,
  numId: string
): { abstractId: string; abstract: AbstractNum } | null {
  const seen = new Set<string>();
  let cur = numId;
  for (let d = 0; d < 4; d++) {
    if (seen.has(cur)) return null;
    seen.add(cur);
    const def = model.nums.get(cur);
    if (!def) return null;
    const abstract = model.abstracts.get(def.abstractNumId);
    if (!abstract) return null;
    if (!abstract.numStyleLink)
      return { abstractId: def.abstractNumId, abstract };
    const linked = model.styles.get(abstract.numStyleLink)?.numId;
    if (!linked) return null;
    cur = linked;
  }
  return null;
}

/**
 * Resolve which numbering (numId + level) applies to a paragraph, from its
 * direct numPr and/or its paragraph style. Level resolution order (the
 * critic's amendment; ECMA-376 binds heading styles to levels via the
 * abstract's w:lvl/w:pStyle BACK-reference, not a w:ilvl in the style):
 * direct ilvl > lvl/pStyle back-reference matching the style chain >
 * style's explicit ilvl > 0.
 */
export function resolveParagraphNumbering(
  model: NumberingModel,
  direct: { numId: string | null; ilvl: number | null } | null,
  styleId: string | null
): { numId: string; ilvl: number } | "none" | null {
  if (direct?.numId === "0") return "none"; // "remove inherited numbering"
  if (direct?.numId) return { numId: direct.numId, ilvl: direct.ilvl ?? 0 };

  if (!styleId) return null;
  const chain = styleChain(model, styleId);
  let numId: string | null = null;
  let styleIlvl: number | null = null;
  for (const sid of chain) {
    const st = model.styles.get(sid);
    if (st?.numId) {
      if (st.numId === "0") return "none";
      numId = st.numId;
      styleIlvl = st.ilvl;
      break;
    }
  }
  if (!numId) return null;
  // The lvl/pStyle back-reference outranks a style's own ilvl. Walk the
  // CHAIN outermost (the paragraph's own style first, then ancestors): a
  // Heading2 based on Heading1 must bind to the level naming Heading2,
  // never its ancestor's level.
  const res = resolveAbstract(model, numId);
  if (res) {
    for (const sid of chain)
      for (let i = 0; i < res.abstract.levels.length; i++)
        if (res.abstract.levels[i]?.pStyle === sid) return { numId, ilvl: i };
  }
  return { numId, ilvl: styleIlvl ?? 0 };
}

/* ------------------------------------------------------------------ *
 * Formatting (all O(log n) or table-bounded)
 * ------------------------------------------------------------------ */

const ROMAN_TABLE: [number, string][] = [
  [1000, "M"],
  [900, "CM"],
  [500, "D"],
  [400, "CD"],
  [100, "C"],
  [90, "XC"],
  [50, "L"],
  [40, "XL"],
  [10, "X"],
  [9, "IX"],
  [5, "V"],
  [4, "IV"],
  [1, "I"],
];

function romanUpper(n: number): string {
  if (n < 1 || n > 3999) return String(n);
  let out = "";
  let left = n;
  for (const [v, s] of ROMAN_TABLE)
    while (left >= v) {
      out += s;
      left -= v;
    }
  return out;
}

/** Bijective base-26 (A..Z, AA..): O(log n), never a repeated-subtract loop. */
function letterUpper(n: number): string {
  if (n < 1) return String(n);
  let out = "";
  let left = n;
  while (left > 0) {
    left -= 1;
    out = String.fromCharCode(65 + (left % 26)) + out;
    left = Math.floor(left / 26);
  }
  return out;
}

export function formatNumber(n: number, fmt: string): string {
  switch (fmt) {
    case "decimal":
      return String(n);
    case "decimalZero":
      // OOXML decimalZero is ZERO-PADDING ("03"), not the site's "3.0"
      // style (which arrives via lvlText "%1.0" and renders naturally).
      return n >= 0 && n < 10 ? `0${n}` : String(n);
    case "upperRoman":
      return romanUpper(n);
    case "lowerRoman":
      return romanUpper(n).toLowerCase();
    case "upperLetter":
      return letterUpper(n);
    case "lowerLetter":
      return letterUpper(n).toLowerCase();
    default:
      // ordinal, cardinalText, ordinalText, and anything unknown: decimal
      // approximation (spelled-out numbers are noise for format mirroring).
      return String(n);
  }
}

/* ------------------------------------------------------------------ *
 * Label rendering
 * ------------------------------------------------------------------ */

/**
 * The literal label for one firing of (numId, ilvl), advancing counters.
 * Counter rules (the critic's composite-state amendment): a level renders
 * max(current, effective start) semantics via the null-means-unfired
 * encoding : an UNFIRED level (null) renders its EFFECTIVE start
 * (post-override), a fired level renders its counter; firing a level
 * increments-or-adopts-start and resets every deeper level to unfired.
 * Null = caller falls back to the legacy line shape.
 */
export function numberingLabel(
  model: NumberingModel,
  counters: NumCounters,
  numId: string,
  ilvl: number
): NumberingLabel | null {
  const res = resolveAbstract(model, numId);
  if (!res) return null;
  const { abstractId, abstract } = res;
  const lvl = abstract.levels[ilvl];
  if (!lvl) return null;
  if (lvl.numFmt === "bullet") return { kind: "bullet" };
  if (lvl.numFmt === "none") return { kind: "none" };

  let st = counters.byAbstract.get(abstractId);
  if (!st) {
    st = {
      vals: new Array(MAX_LEVELS).fill(null),
      effStart: abstract.levels.map((l) => l?.start ?? 1),
    };
    counters.byAbstract.set(abstractId, st);
  }
  // First fire of this numId: its startOverrides re-base the shared
  // abstract (Word's "restart numbering" mints a new numId doing exactly
  // this) and reset those levels to unfired.
  if (!counters.seenNums.has(numId)) {
    counters.seenNums.add(numId);
    const overrides = model.nums.get(numId)?.startOverrides;
    if (overrides)
      for (const [oi, ov] of overrides) {
        st.effStart[oi] = ov;
        st.vals[oi] = null;
      }
  }

  st.vals[ilvl] = st.vals[ilvl] === null ? st.effStart[ilvl] : st.vals[ilvl]! + 1;
  for (let d = ilvl + 1; d < MAX_LEVELS; d++) st.vals[d] = null;

  // Render lvlText: linear scan, %1..%9 tokens replaced with that level's
  // value (unfired = effective start) in that level's format; isLgl on the
  // FIRING level renders every other level's token as decimal.
  const text = lvl.lvlText || `%${ilvl + 1}.`;
  let out = "";
  for (let i = 0; i < text.length && out.length < 64; i++) {
    const c = text[i];
    if (c === "%" && i + 1 < text.length && text[i + 1] >= "1" && text[i + 1] <= "9") {
      const tokLvl = text.charCodeAt(i + 1) - 49; // '1' -> 0
      i++;
      const v = st.vals[tokLvl] ?? st.effStart[tokLvl] ?? 1;
      const fmt =
        lvl.isLgl && tokLvl !== ilvl
          ? "decimal"
          : (abstract.levels[tokLvl]?.numFmt ?? "decimal");
      out += formatNumber(v, fmt);
    } else out += c;
  }
  const label = out.trim();
  return label ? { kind: "number", label } : { kind: "none" };
}
