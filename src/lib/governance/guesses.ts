// Open-item best-guess store (§5.12). The model emits candidate answers for
// its own [TO CONFIRM] markers on turns it is already making (zero extra AI
// calls); the host keeps them in open_item_guesses_json, a cold column that
// never rides documentsJson (so guesses can never tip the promptable hot
// path over its byte cap) and never enters any prompt or export. Everything
// here is lenient and pure: junk input degrades to "no chips", never to an
// error, and a missing store reproduces today's chip-less behavior exactly.
// Client-safe: pure functions over types only.

import type { GovernanceDoc, NextQuestion, OpenConfirmItem } from "./types";
import { CAPS } from "./config";
import { findConfirmMarkers, scanConfirmMarkersWithPos } from "./markdown";

/** The store: marker key -> best-guess answers, best first. */
export type GuessStore = Record<string, string[]>;

/**
 * THE key normalizer, used on the write side (model-emitted excerpts) and
 * the read side (scanned marker excerpts) alike so the two can only agree
 * or both miss. Whitespace collapses because the model may read a marker
 * from the prompt's whitespace-collapsed open-items list while the draft
 * stores it wrapped. Deliberately NOT lowercased: a reworded marker should
 * miss (its guesses are stale), and case-only rewording is not a real case.
 */
export function guessKey(excerpt: string): string {
  return (
    excerpt.replace(/\s+/g, " ").trim().slice(0, 200) || "open item"
  );
}

/** Every live marker key over the applied documents, in draft order. */
function liveKeys(documents: GovernanceDoc[]): string[] {
  const out: string[] = [];
  for (const d of documents)
    for (const s of d.sections)
      for (const ex of findConfirmMarkers(s.markdown)) out.push(guessKey(ex));
  return out;
}

/** One guess list, capped. Empty result = drop the entry. */
function capGuesses(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter(
      (g): g is string =>
        typeof g === "string" &&
        g.trim().length > 0 &&
        g.length <= CAPS.openItemGuessMaxChars
    )
    .map((g) => g.trim())
    .slice(0, CAPS.openItemGuessesPerItem);
}

/**
 * Build the next store after a turn applied: for each marker still alive in
 * the applied documents, this turn's fresh guess wins, else the prior
 * store's entry carries forward, else nothing. Keys with no live marker are
 * dropped (resolved, reworded, or hallucinated excerpts prune themselves),
 * and the whole store is capped so it can never grow unboundedly. Linear
 * over markers + emissions.
 */
export function mergeOpenItemGuesses(
  prev: GuessStore,
  fresh: { excerpt: string; guesses: string[] }[],
  documents: GovernanceDoc[]
): GuessStore {
  const emitted = new Map<string, string[]>();
  for (const f of fresh) {
    const k = guessKey(f.excerpt);
    const g = capGuesses(f.guesses);
    if (g.length && !emitted.has(k)) emitted.set(k, g);
  }
  const next: GuessStore = {};
  let keys = 0;
  for (const k of liveKeys(documents)) {
    if (keys >= CAPS.openItemGuessesMaxKeys) break;
    if (k in next) continue;
    const g = emitted.get(k) ?? capGuesses(prev[k]);
    if (!g.length) continue;
    next[k] = g;
    keys++;
  }
  return next;
}

/** Defensive parse of the stored column; anything malformed -> {}. */
export function parseGuessStore(raw: string | null): GuessStore {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw) as unknown;
    if (typeof o !== "object" || o === null || Array.isArray(o)) return {};
    const out: GuessStore = {};
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      const g = capGuesses(v);
      if (g.length) out[guessKey(k)] = g;
    }
    return out;
  } catch {
    return {};
  }
}

/* ------------------------------------------------------------------ *
 * Deterministic repeated-label guesses (§5.12 round 2). When the SAME
 * labeled field is resolved to a concrete value elsewhere in the draft
 * ("Owned by Department: Security" in one section, "Owned by Department:
 * [TO CONFIRM: owning department]" in another), that value IS the best
 * guess, with zero AI. Derived at READ edges from the full stored
 * documents (never the elided prompt serialization, never persisted), so
 * it is always fresh after keeps and amends and can never go stale in the
 * column. Prod drafts carry these as plain "Label: value" lines and
 * two-cell table rows, sometimes bold; emphasis is stripped for matching.
 * ------------------------------------------------------------------ */

const LABEL_MAX_WORDS = 6;

/** Strip asterisk emphasis ("**Label:** value" -> "Label: value"). */
function stripStars(s: string): string {
  return s.replace(/\*{1,3}/g, "");
}

/** Normalized index key for a label; null = not a plausible field label. */
function normLabel(label: string): string | null {
  const l = stripStars(label).replace(/\s+/g, " ").trim();
  if (!l || !/[a-z]/i.test(l)) return null;
  if (l.split(" ").length > LABEL_MAX_WORDS) return null;
  return l.toLowerCase();
}

/** A value worth offering as a chip; null = reject the pair. */
function plausibleValue(v: string): string | null {
  const t = stripStars(v).replace(/\s+/g, " ").trim();
  if (!t || !/[a-z0-9]/i.test(t)) return null;
  if (/\[TO\s*CONFIRM/i.test(t)) return null;
  if (t.length > CAPS.openItemGuessMaxChars) return null;
  return t;
}

/** (label, value) from one resolved line: a two-cell table row or a
 *  "Label: value" line (last colon wins, mirroring the marker-side
 *  extraction, so "Note: Effective Date: 8/1/2026" labels as
 *  "effective date"). Null = the line teaches nothing. */
export function lineLabelValue(
  line: string
): { label: string; value: string } | null {
  const t = line.replace(/^\s*(?:#{1,6}|[-*+]|\d{1,3}[.)])\s+/, "").trim();
  if (t.startsWith("|")) {
    const cells = t
      .split("|")
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    if (cells.length !== 2) return null;
    if (/^[-: ]+$/.test(cells[0]) || /^[-: ]+$/.test(cells[1])) return null;
    const label = normLabel(cells[0]);
    const value = plausibleValue(cells[1]);
    return label && value ? { label, value } : null;
  }
  const t2 = stripStars(t);
  const i = t2.lastIndexOf(": ");
  if (i <= 0) return null;
  const labelTail = /([^:|]{1,60})$/.exec(t2.slice(0, i))?.[1] ?? "";
  const label = normLabel(labelTail);
  const value = plausibleValue(t2.slice(i + 2));
  return label && value ? { label, value } : null;
}

/** The label a marker sits under on its own line: the colon-terminated
 *  text right before it, or the preceding table cell. Null = unlabeled
 *  (mid-sentence markers correctly yield no deterministic guess). */
function markerLineLabel(linePrefix: string): string | null {
  if (linePrefix.trimStart().startsWith("|")) {
    const cells = linePrefix.split("|");
    const cell = cells.length >= 2 ? cells[cells.length - 2] : "";
    return normLabel(cell);
  }
  const m = /([^:|]{1,60}):\s*$/.exec(stripStars(linePrefix));
  return m ? normLabel(m[1]) : null;
}

/**
 * Marker key -> values the draft itself establishes for that field. A
 * value only surfaces when the SAME label carries a concrete, marker-free
 * value on another line (one-off prose colons have no sibling and yield
 * nothing). A key whose occurrences disagree (same excerpt under
 * different labels resolving to different values) is DROPPED whole: a
 * wrong chip is worse than no chip. Linear over lines + markers.
 */
export function deriveDeterministicGuesses(
  documents: GovernanceDoc[]
): GuessStore {
  const index = new Map<string, string[]>();
  for (const d of documents)
    for (const s of d.sections)
      for (const line of s.markdown.split("\n")) {
        const lv = lineLabelValue(line);
        if (!lv) continue;
        const vals = index.get(lv.label) ?? [];
        if (
          vals.length < 5 &&
          !vals.some((v) => v.toLowerCase() === lv.value.toLowerCase())
        ) {
          vals.push(lv.value);
          index.set(lv.label, vals);
        }
      }
  const det: GuessStore = {};
  const poisoned = new Set<string>();
  for (const d of documents)
    for (const s of d.sections) {
      const md = s.markdown;
      for (const m of scanConfirmMarkersWithPos(md)) {
        const key = guessKey(m.excerpt);
        if (poisoned.has(key)) continue;
        const ls = md.lastIndexOf("\n", m.start - 1) + 1;
        const label = markerLineLabel(md.slice(ls, m.start));
        if (!label) continue;
        const vals = (index.get(label) ?? []).slice(
          0,
          CAPS.openItemGuessesPerItem
        );
        if (!vals.length) continue;
        const existing = det[key];
        if (existing && existing.join(" ") !== vals.join(" ")) {
          delete det[key];
          poisoned.add(key);
          continue;
        }
        det[key] = vals;
      }
    }
  return det;
}

/** Deterministic guesses first (the user's own draft fact outranks any
 *  model guess), then the rest, case-insensitive dedupe keeping the first
 *  casing, capped at the per-item chip limit. */
export function combineGuesses(
  det: string[] | undefined,
  rest: (string[] | undefined)[]
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const g of [...(det ?? []), ...rest.flatMap((r) => r ?? [])]) {
    const k = g.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(g.trim());
    if (out.length >= CAPS.openItemGuessesPerItem) break;
  }
  return out;
}

/** Open markers with NEITHER a deterministic nor a stored guess: the AI
 *  backfill call's work list, deduped by key, capped. */
export function guessGapMarkers(
  documents: GovernanceDoc[],
  det: GuessStore,
  store: GuessStore
): { ref: string; excerpt: string }[] {
  const out: { ref: string; excerpt: string }[] = [];
  const seen = new Set<string>();
  for (const d of documents)
    for (const s of d.sections)
      for (const ex of findConfirmMarkers(s.markdown)) {
        const k = guessKey(ex);
        if (seen.has(k)) continue;
        seen.add(k);
        if (det[k]?.length || store[k]?.length) continue;
        out.push({ ref: `${d.slug}#${s.id}`, excerpt: k });
      }
  return out.slice(0, CAPS.backfillMaxMarkers);
}

/**
 * Fill a chase question's suggestions: deterministic draft facts first,
 * then whatever the question already carries (a stored hydration), then
 * the store. The marker is recomputed the same way the picker found it:
 * first marker of the section the question feeds. A total miss keeps the
 * question untouched (today's chip-less card).
 */
export function hydrateChaseSuggestions(
  q: NextQuestion,
  documents: GovernanceDoc[],
  store: GuessStore
): NextQuestion {
  if (!q.id.startsWith("qi_")) return q;
  const feed = q.feeds?.[0];
  if (!feed) return q;
  const i = feed.indexOf("#");
  const sec = documents
    .find((d) => d.slug === feed.slice(0, i))
    ?.sections.find((s) => s.id === feed.slice(i + 1));
  if (!sec) return q;
  const first = findConfirmMarkers(sec.markdown)[0];
  if (!first) return q;
  const key = guessKey(first);
  const det = deriveDeterministicGuesses(documents)[key];
  const stored = store[key];
  if (!det?.length && !stored?.length) return q;
  const combined = combineGuesses(det, [q.suggestions, stored]);
  return combined.length ? { ...q, suggestions: combined } : q;
}

/** Attach deterministic + stored guesses to resolver items (shared key). */
export function attachItemGuesses(
  items: OpenConfirmItem[],
  documents: GovernanceDoc[],
  store: GuessStore
): OpenConfirmItem[] {
  const det = deriveDeterministicGuesses(documents);
  return items.map((it) => {
    const key = guessKey(it.excerpt);
    const guesses = combineGuesses(det[key], [store[key]]);
    return guesses.length ? { ...it, guesses } : it;
  });
}
