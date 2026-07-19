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
import { findConfirmMarkers } from "./markdown";

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

/**
 * Fill a chase question's empty suggestions from the store. The stored
 * qi_ question carries suggestions [] (pickOpenItemQuestion stays pure and
 * store-blind); the marker it quotes is recomputed here the same way the
 * picker found it: first marker of the section the question feeds. A miss
 * (reworded marker, no stored guess) keeps [] and today's chip-less card.
 */
export function hydrateChaseSuggestions(
  q: NextQuestion,
  documents: GovernanceDoc[],
  store: GuessStore
): NextQuestion {
  if (!q.id.startsWith("qi_") || q.suggestions.length > 0) return q;
  const feed = q.feeds?.[0];
  if (!feed) return q;
  const i = feed.indexOf("#");
  const sec = documents
    .find((d) => d.slug === feed.slice(0, i))
    ?.sections.find((s) => s.id === feed.slice(i + 1));
  if (!sec) return q;
  const first = findConfirmMarkers(sec.markdown)[0];
  if (!first) return q;
  const guesses = store[guessKey(first)];
  return guesses?.length ? { ...q, suggestions: guesses } : q;
}

/** Attach stored guesses to resolver items (matched by the shared key). */
export function attachItemGuesses(
  items: OpenConfirmItem[],
  store: GuessStore
): OpenConfirmItem[] {
  return items.map((it) => {
    const guesses = store[guessKey(it.excerpt)];
    return guesses?.length ? { ...it, guesses } : it;
  });
}
