// Title → keyword/slug derivation for the blog topic steering.
//
// Extracted from scripts/fetch-ai-news.mjs on 2026-08-03 (the "models today"
// primary keyword — third keyword-seam incident after the 07-24 slug clone
// and the 07-27 "panic around chinese" straddle). The fetch script runs a
// Tavily POST at module top level, so nothing could import these functions
// for tests; every incident panel re-traced them by copy-paste. Pure ESM,
// no imports — imported by scripts/fetch-ai-news.mjs (Node) and unit-tested
// by scripts/title-keywords-tests.mjs without running any fetch (same
// pattern as scripts/lib/peg-score.mjs).

/** News APIs return "Headline - Publisher" / "Headline | Publisher" titles. */
export function cleanTitle(raw) {
  // Publisher can also be a bare lowercase domain ("… - csoonline.com").
  const t = raw.trim().replace(/^(.{20,}?)\s+[-–—|]\s+(?:[a-z0-9-]+\.)+[a-z]{2,}\s*$/i, "$1");
  const m = t.match(/^(.{20,}?)\s+[-–—|]\s+[A-Z][\w.]*(?:\s+[A-Z][\w.]*){0,3}$/);
  return (m ? m[1] : t).trim();
}

const STOPWORDS = new Set(
  ("a an and are as at be but by for from has have how in is it its new of on or say says " +
    "she he that the their this to was were what when who why will with you your " +
    // Prepositions/connectives (2026-07-27): "around" survived into a primary
    // keyword ("panic around chinese"); a preposition never belongs in an
    // entity keyword, and in keywordsFromTitle it ends a noun-phrase run.
    "about across after against along amid amidst among around before behind between beyond " +
    "despite during into near onto over per since through toward towards under until upon via within without " +
    // Temporal deictics + duration nouns (2026-08-03): an aggregator page
    // titled "New Models Today — AI & LLM Releases Last 24 Hours" produced
    // primary keyword "models today" and slug models-today-2026-08-03. A
    // when-word is never part of an entity. day/days stay OUT deliberately:
    // "zero day"/"Demo Day" are entity phrases ("Microsoft patches zero day
    // flaw" must keep "zero day" — pinned in title-keywords-tests.mjs).
    "today tonight yesterday tomorrow hour hours week weeks").split(" "),
);

// Break-type classifier for keywordsFromTitle: when a single leading token is
// separated from the next run by a PREPOSITION, the phrase after it is the
// head entity ("Panic Around Chinese AI Models" → "chinese ai models"); a
// connective break ("and", "to") instead binds the entity to what follows
// ("Microsoft to invest billions" → "microsoft invest billions").
const PREPOSITIONS = new Set(
  ("about across after against along amid amidst among around at before behind between beyond by " +
    "despite during for from in into near of on onto over per since through toward towards under " +
    "until upon via with within without").split(" "),
);

export function slugify(s, maxLen = 60) {
  const slug = s
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/, "");
  return slug || "ai-news";
}

/** keywords[0] = primary keyword (must read naturally in the title). */
export function keywordsFromTitle(title) {
  const tokenize = (s) =>
    s
      // Possessives first ("Anthropic's Claude" → "Anthropic Claude"): the
      // generic scrub below would otherwise leave an orphan "s" token that
      // pollutes the primary keyword and the slug built from it.
      .replace(/(['’])s\b/g, "")
      .replace(/[^\w\s-]/g, " ")
      .split(/\s+/)
      .filter((t) => t);
  // First clause only: text after ":" / " - " / " | " is subtitle framing
  // ("...: What the US Tech Market Says"), not the entity.
  const clause = title.split(/:|\s[-–—|]\s/)[0] || title;
  // 2026-07-27 redesign (the "panic around chinese" primary keyword): the old
  // first-3-significant-tokens cut could straddle a removed preposition and
  // truncate a noun phrase mid-way, leaving a dangling lowercase modifier.
  // Build contiguous runs of significant tokens instead: stopwords,
  // single-character tokens, and clause punctuation (commas/semicolons) all
  // end a run, so a candidate is always a whole phrase from the headline.
  const runs = [];
  let run = [];
  let breakWord = ""; // stopword preceding the current run ("" = punctuation)
  const endRun = (word) => {
    if (run.length) runs.push({ tokens: run, brokeAt: breakWord });
    run = [];
    breakWord = word;
  };
  for (const segment of clause.split(/[,;]/)) {
    for (const t of tokenize(segment)) {
      if (t.length < 2 || STOPWORDS.has(t.toLowerCase())) endRun(t.toLowerCase());
      else run.push(t);
    }
    endRun(""); // punctuation boundary: runs never merge across it
  }
  // Entity-first selection: news headlines lead with the acting entity, so
  // the FIRST run of 2+ tokens wins (longest-run-wins would drop the entity:
  // "Trump Administration and House Lawmakers Launch..." must keep "trump
  // administration"). A single-token leading run is an entity orphaned by
  // its break word: a preposition break means the phrase AFTER it is the
  // head noun phrase; a connective break rejoins the entity to its action.
  // A punctuation break ("" — e.g. "Cheaper, open and intelligent") never
  // merges; those titles fall back to the old first-3 join.
  let primaryTokens = [];
  const first = runs[0];
  const second = runs[1];
  if (first && first.tokens.length >= 2) primaryTokens = first.tokens;
  else if (first && second && second.brokeAt) {
    primaryTokens = PREPOSITIONS.has(second.brokeAt)
      ? second.tokens
      : [...first.tokens, ...second.tokens];
  }
  const allTokens = tokenize(title).filter(
    (t) => t.length > 1 && !STOPWORDS.has(t.toLowerCase()),
  );
  if (primaryTokens.length < 2) primaryTokens = allTokens.slice(0, 3);
  // Cap at 4 tokens AND 38 chars so slugify(keywords[0], 42) never truncates
  // a published slug mid-word ("...-reinventio").
  primaryTokens = primaryTokens.slice(0, 4);
  while (primaryTokens.length > 2 && primaryTokens.join(" ").length > 38)
    primaryTokens.pop();
  const primary = primaryTokens.join(" ").toLowerCase();
  const primarySet = new Set(primaryTokens.map((t) => t.toLowerCase()));
  const rest = allTokens
    .map((t) => t.toLowerCase())
    .filter((t) => !primarySet.has(t))
    .filter((t, i, a) => t.length > 2 && a.indexOf(t) === i)
    .slice(0, 4);
  return [primary, ...rest].filter(Boolean).slice(0, 5);
}
