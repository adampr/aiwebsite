// Deterministic repair containment for panel-produced cards (§5.16).
//
// 2026-08-04 incident ("Rippling Mileage Entry"): the one-shot repair stage
// must re-emit the ENTIRE card JSON, so it paraphrases fields the lint never
// named, and the old response — hold for a human — turned inevitable model
// disobedience into owner friction (and `heldAt` permanently bars submitter
// retry). The invariant "unnamed fields stay byte-identical" is enforceable
// in code, so it is: the publish candidate is MERGED here — repaired values
// only for fields the violation list frees, the synthesis card's own
// disclosure-gated values restored verbatim everywhere else. Obedience is
// structurally irrelevant; when the repair obeys, the merge equals its
// output value for value (the literal below fixes the key order, so it is
// not a byte match of a reply that ordered the six keys differently).
//
// Pure module (no DB, no brain) so scripts/work-tests.ts can import it.

import type { WorkCard } from "./lint";

export interface RepairGrant {
  title: boolean;
  badge: boolean;
  summary: boolean;
  body: boolean;
  facets: boolean;
  footer: boolean;
}

/** The ONE violation-string → freed-field table, shared by mergeRepair and
 * the repairDrift backstop so the two can never diverge. Every string
 * lintCard emits starts with a code-owned literal (submitted text is only
 * ever interpolated mid-string), which is what makes prefix classification
 * safe; work-tests pins that property. Fail-closed: an unrecognized string
 * frees NOTHING — in particular `unknown key "x"` and `card is not an
 * object` free nothing (the old classifier's else-bucket freed all visible
 * copy on an unknown key, handing the docs-blind repair a rewrite license on
 * a schema violation; the merge drops unknown keys structurally instead).
 * The whole-card word band frees the four visible copy fields — cross-field
 * trimming is its legitimate fix — but never the title or badge. */
export function classifyViolations(violations: string[]): RepairGrant {
  const g: RepairGrant = {
    title: false,
    badge: false,
    summary: false,
    body: false,
    facets: false,
    footer: false,
  };
  for (const v of violations) {
    const s = v.toLowerCase();
    if (s.startsWith("title")) g.title = true;
    else if (s.startsWith("categorybadge")) g.badge = true;
    else if (s.startsWith("summary")) g.summary = true;
    else if (s.startsWith("body")) g.body = true;
    else if (s.startsWith("facet")) g.facets = true;
    else if (s.startsWith("footer")) g.footer = true;
    // The whole-card band counts summary + body + facet text ONLY (lint.ts),
    // so a footer edit can never satisfy it: freeing the footer here would
    // hand the docs-blind repair a rewrite license on a field the violation
    // cannot implicate, and that copy would publish without the disclosure
    // critic ever seeing it. A genuine footer defect emits its own footer
    // violation.
    else if (s.startsWith("card visible copy"))
      g.summary = g.body = g.facets = true;
  }
  return g;
}

export function grantFreesAnything(g: RepairGrant): boolean {
  return g.title || g.badge || g.summary || g.body || g.facets || g.footer;
}

/** The publish candidate, built in CODE. An object LITERAL of exactly the
 * six schema keys — no spread of either input, so no unknown or
 * proto-shaped TOP-LEVEL key can ride in (extra keys nested inside a facet
 * object are a separate, pre-existing lint gap: lintCard keeps whole facet
 * entries, and stripping them here would make every unfreed facet compare
 * unequal to synth's and re-fire the very false hold this module removes).
 * Each field is the repair's value iff the grant frees it, else the
 * synthesis card's RAW value verbatim. A freed field the repair OMITTED
 * keeps synth's value too: an absent key is not a fix, and emitting
 * `undefined` would drop the key from the stored draft's JSON and hand
 * approveHeld a card whose renderer spreads an absent array. No
 * normalization here — lintCard on the merged object is the only normalizer
 * and the only gate, so an omitted fix simply re-fails its own violation.
 * Returns null iff the grant frees at least one field and the repair is not
 * a plain object (the caller holds; a frees-nothing grant tolerates any
 * repair value because nothing is taken from it). */
export function mergeRepair(
  synth: Record<string, unknown>,
  repair: unknown,
  violations: string[]
): Record<string, unknown> | null {
  const g = classifyViolations(violations);
  const isPlain =
    typeof repair === "object" && repair !== null && !Array.isArray(repair);
  if (!isPlain && grantFreesAnything(g)) return null;
  const r = (isPlain ? repair : {}) as Record<string, unknown>;
  const take = (freed: boolean, repaired: unknown, original: unknown) =>
    freed && repaired !== undefined ? repaired : original;
  return {
    title: take(g.title, r.title, synth.title),
    categoryBadge: take(g.badge, r.categoryBadge, synth.categoryBadge),
    summary: take(g.summary, r.summary, synth.summary),
    body: take(g.body, r.body, synth.body),
    facets: take(g.facets, r.facets, synth.facets),
    footerLine: take(g.footer, r.footerLine, synth.footerLine),
  };
}

/** Comparison for the observability layer only: key order and surrounding
 * whitespace are not a rewrite attempt, and an ABSENT key is an omission
 * rather than a proposed change (models answer tersely with just the fixed
 * field even when asked for the whole card). Getting this wrong would make
 * the owner FYI and the drift log — the two signals this round exists to
 * provide — assert rewrites that never happened. */
function canon(x: unknown): unknown {
  if (typeof x === "string") return x.trim();
  if (Array.isArray(x)) return x.map(canon);
  if (x && typeof x === "object") {
    const o = x as Record<string, unknown>;
    return Object.keys(o)
      .sort()
      .map((k) => [k, canon(o[k])]);
  }
  return x ?? null;
}

/** Fields the merge kept from synth even though the repair proposed a
 * DIFFERENT value — what the model tried to change without a license.
 * Observability only (transcript, owner-email FYI, log line); the merge
 * itself never consults this. */
export function restoredFields(
  synth: Record<string, unknown>,
  repair: Record<string, unknown>,
  violations: string[]
): string[] {
  const g = classifyViolations(violations);
  const differs = (a: unknown, b: unknown) =>
    b !== undefined && JSON.stringify(canon(a)) !== JSON.stringify(canon(b));
  const out: string[] = [];
  if (!g.title && differs(synth.title, repair.title)) out.push("title");
  if (!g.badge && differs(synth.categoryBadge, repair.categoryBadge))
    out.push("categoryBadge");
  if (!g.summary && differs(synth.summary, repair.summary)) out.push("summary");
  if (!g.body && differs(synth.body, repair.body)) out.push("body");
  if (!g.facets && differs(synth.facets, repair.facets)) out.push("facets");
  if (!g.footer && differs(synth.footerLine, repair.footerLine))
    out.push("footerLine");
  return out;
}

/** Shape a draft for STORAGE on a hold. `approveHeld` publishes a stored
 * draft verbatim with no re-lint — that is the owner's deliberate override,
 * so the fix is not to re-gate it but to guarantee the stored shape cannot
 * crash the card renderer: an absent field vanishes from the JSON and
 * `work-card.tsx` spreads `card.footerLine`, and a junk ELEMENT inside a
 * kept array throws just as hard (`f.label` on a null facet), which takes
 * down the whole /work render because there is no error boundary above it.
 * So the containers AND their elements are typed here: absent, wrong-typed
 * and junk-element values degrade to empties, which read as visibly
 * deficient in the owner's review email (which carries this same value)
 * instead of throwing after the approve click. Extra keys nested inside a
 * facet are kept, matching what lintCard itself permits. Never used on the
 * publish path: a card that reaches publish passed lintCard, which
 * guarantees every field already. */
export function storableDraft(card: unknown): Record<string, unknown> {
  const c =
    typeof card === "object" && card !== null && !Array.isArray(card)
      ? (card as Record<string, unknown>)
      : {};
  const str = (x: unknown) => (typeof x === "string" ? x : "");
  const strs = (x: unknown) =>
    Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : [];
  const facets = (x: unknown) =>
    Array.isArray(x)
      ? x.filter(
          (v): v is { label: string; text: string } =>
            typeof v === "object" &&
            v !== null &&
            typeof (v as { label?: unknown }).label === "string" &&
            typeof (v as { text?: unknown }).text === "string"
        )
      : [];
  return {
    title: str(c.title),
    categoryBadge: str(c.categoryBadge),
    summary: str(c.summary),
    body: strs(c.body),
    facets: facets(c.facets),
    footerLine: strs(c.footerLine),
  };
}

/** Defense-in-depth backstop (2026-07-31 panel round, kept after the merge
 * landed): the repaired card never re-enters the disclosure gate, so any
 * field the violation list did not free must be unchanged. Run against the
 * MERGED, lint-normalized card; by construction it is unreachable — a fire
 * means mergeRepair or the shared grant has a bug, and a hold is exactly
 * the right response to that. Comparison semantics are unchanged from the
 * original panel.ts implementation (norm() trims top-level strings, which
 * matches lintCard's title/summary trim; arrays JSON-compare). */
export function repairDrift(
  synth: Record<string, unknown>,
  repaired: WorkCard,
  violations: string[]
): string[] {
  const g = classifyViolations(violations);
  const same = (a: unknown, b: unknown) =>
    JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const norm = (x: unknown) => (typeof x === "string" ? x.trim() : x);
  const drift: string[] = [];
  if (!g.title && norm(synth.title) !== repaired.title)
    drift.push("title changed without a title violation");
  if (!g.badge && norm(synth.categoryBadge) !== repaired.categoryBadge)
    drift.push("categoryBadge changed without a categoryBadge violation");
  if (!g.summary && norm(synth.summary) !== repaired.summary)
    drift.push("summary changed without a summary violation");
  if (!g.body && !same(synth.body, repaired.body))
    drift.push("body changed without a body violation");
  if (!g.facets && !same(synth.facets, repaired.facets))
    drift.push("facets changed without a facet violation");
  if (!g.footer && !same(synth.footerLine, repaired.footerLine))
    drift.push("footerLine changed without a footer violation");
  return drift;
}
