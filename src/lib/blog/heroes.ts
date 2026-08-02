// Hero-image motif → descriptive-alt mapping for the AI-news blog (module
// §19.26 seam). The pattern/subject pairs are VERBATIM the entries that
// shipped inline in site.config.ts since v1.3.0 — order is load-bearing
// (first match wins) and motifFor matches the SAME string the module's
// pickSubject matches (title + " " + metaDescription), so the alt text can
// never disagree with the subject that painted the image. Deterministic by
// construction: derived from the post's title/metaDescription, no LLM call.
// Pattern borrowed from the roleplay host's src/lib/blog-heroes.ts.
//
// Import-safe by construction (data + pure functions only): site.config.ts
// sits in the middleware/client import graph, so nothing node-only (db,
// sharp, fs) may ever be imported here.
//
// No "illustration"/"image of" boilerplate in alts — screen readers already
// announce the image role.

export const HERO_MOTIFS: { pattern: RegExp; subject: string; alt: string }[] = [
  {
    pattern: /regulat|policy|law|court|antitrust|copyright/i,
    subject:
      "balanced scales and structured document forms woven into circuit traces",
    alt: "balanced scales and documents woven into circuit traces",
  },
  {
    pattern: /chip|gpu|hardware|semiconductor|datacenter|compute/i,
    subject: "isometric silicon dies and glowing interconnect lattices",
    alt: "isometric silicon dies linked by glowing lattices",
  },
  {
    pattern: /agent|robot|automat/i,
    subject:
      "orchestrated nodes passing glowing task tokens along branching paths",
    alt: "nodes passing glowing task tokens along branching paths",
  },
  {
    pattern: /funding|acquisition|valuation|ipo|invest/i,
    subject: "ascending abstract bar forms and converging light streams",
    alt: "ascending bar forms with converging light streams",
  },
  {
    pattern: /model|launch|release|benchmark|open.?source/i,
    subject:
      "an unfolding lattice of neural pathways radiating from a bright core",
    alt: "a lattice of neural pathways radiating from a bright core",
  },
];

export const HERO_FALLBACK_SUBJECT =
  "an abstract constellation of data streams converging into a single bright signal";

export const HERO_FALLBACK_ALT =
  "data streams converging into a single bright signal";

/** Same match-string as the module's pickSubject (title + metaDescription). */
export function motifFor(post: { title: string; metaDescription: string }) {
  return (
    HERO_MOTIFS.find((m) =>
      m.pattern.test(`${post.title} ${post.metaDescription}`)
    ) ?? null
  );
}

/** Descriptive alt for the hero the matched motif painted (fallback-safe). */
export function heroAlt(post: {
  title: string;
  metaDescription: string;
}): string {
  return motifFor(post)?.alt ?? HERO_FALLBACK_ALT;
}
