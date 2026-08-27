// Gap-question vocabulary shared by server and client (ARCHITECTURE.md §5.17.2).
//
// The gap machinery merges questions by EXACT raw text downstream: the
// workspace queue dedupes on the normalized form, and the gap route looks a
// question up with g.question === question. The anti-repeat fix (2026-08-27,
// the B-O-F incident: one co-managed-IT question minted under four wordings
// across eight sections, answered three times) rests on paraphrases being
// folded back into ONE canonical raw string, so the normalizer below is the
// single definition of "same question". It moved here from an inline
// expression in workspace.tsx; if server and client ever disagree on it, a
// snapped question stops matching its queue entry.
//
// PURE module: imported by a client component (workspace.tsx). No server
// imports, no db, no node builtins. Keep it that way.

/** Byte-identical to the former workspace.tsx inline dedupe key:
 *  lowercase, fold every non-alphanumeric run to one space, trim.
 *  Treat as a PERSISTED FORMAT: changing it re-keys gaps already stored on
 *  live proposals, so do not "improve" it. */
export function normalizeGapQuestion(q: string): string {
  return q.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export type OpenGapSection = { label: string; gaps: { question: string }[] };

/**
 * Every distinct open gap question on the proposal, as raw stored text.
 *
 * Ordering is precedence: OTHER sections' questions first, in document
 * order, then the target section's own current gaps. First occurrence of a
 * normalized key wins, so when the same question is open both elsewhere and
 * on the target, the wording that will REMAIN open (another section's) is
 * canonical. The target's own gaps are included at all because a redraft
 * replaces them wholesale: seeing its own previous wording lets the redraft
 * repeat it exactly, keeping a half-answered queue entry textually stable
 * instead of splitting it. "__" labels never contribute (the letter records
 * gaps: [] by construction; this is belt and braces for future furniture).
 */
export function collectOpenQuestions(
  sections: OpenGapSection[],
  targetLabel: string
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (q: string) => {
    const n = normalizeGapQuestion(q);
    if (!n || seen.has(n)) return;
    seen.add(n);
    out.push(q);
  };
  for (const s of sections) {
    if (s.label.startsWith("__") || s.label === targetLabel) continue;
    for (const g of s.gaps) add(g.question);
  }
  if (!targetLabel.startsWith("__")) {
    const own = sections.find((s) => s.label === targetLabel);
    if (own) for (const g of own.gaps) add(g.question);
  }
  return out;
}

/** Prompt budget: bounded count AND total chars so a pathological proposal
 *  (80 sections x 2 gaps x 500 chars) cannot blow the draft prompt.
 *  Questions are NEVER truncated individually: a truncated question could
 *  not be repeated exactly, and its normalized form would be a prefix, not
 *  an equal, so both the prompt contract and the snap would break. The cap
 *  applies to the PROMPT list only; the snap always sees the full list. */
export const OPEN_QUESTIONS_PROMPT_MAX = 12;
export const OPEN_QUESTIONS_PROMPT_CHARS = 6000;

export function capOpenQuestionsForPrompt(
  qs: string[],
  // The collector places the redrafted section's OWN gaps last; a redraft
  // must see its own previous wording to repeat it, or a busy proposal
  // (12+ open questions elsewhere) would evict exactly the wording whose
  // stability keeps a merged queue entry from splitting. reserveTail
  // admits that many trailing items FIRST; output order stays collector
  // order either way. Overcounting (an own gap deduped into another
  // section's wording) just prioritizes a couple of late list entries,
  // which is harmless.
  reserveTail = 0
): string[] {
  const n = Math.max(0, Math.min(reserveTail, qs.length));
  const cut = qs.length - n;
  const admitted = new Set<number>();
  let count = 0;
  let chars = 0;
  const admit = (i: number): boolean => {
    if (count >= OPEN_QUESTIONS_PROMPT_MAX) return false;
    if (chars + qs[i].length > OPEN_QUESTIONS_PROMPT_CHARS) return false;
    admitted.add(i);
    count += 1;
    chars += qs[i].length;
    return true;
  };
  for (let i = cut; i < qs.length; i++) if (!admit(i)) break;
  for (let i = 0; i < cut; i++) if (!admit(i)) break;
  return qs.filter((_, i) => admitted.has(i));
}

/**
 * Deterministic server-side snap: a returned gap whose question NORMALIZES
 * equal to an open question is rewritten to that question's exact raw text,
 * so the exact-match machinery (client dedupe, gap-route lookup) merges it
 * into one entry with one answer woven everywhere. Also folds two returned
 * gaps that normalize equal to EACH OTHER into one. Only `question` is ever
 * rewritten; `why` and every other field pass through untouched via spread,
 * so the snap cannot corrupt a record.
 */
export function snapGapQuestions<G extends { question: string }>(
  gaps: G[],
  openQuestions: string[]
): G[] {
  const canonical = new Map<string, string>();
  for (const q of openQuestions) {
    const n = normalizeGapQuestion(q);
    if (n && !canonical.has(n)) canonical.set(n, q);
  }
  const out: G[] = [];
  const taken = new Set<string>();
  for (const g of gaps) {
    const n = normalizeGapQuestion(g.question);
    if (n && taken.has(n)) continue;
    if (n) taken.add(n);
    const snap = n ? canonical.get(n) : undefined;
    out.push(
      snap !== undefined && snap !== g.question ? { ...g, question: snap } : g
    );
  }
  return out;
}
