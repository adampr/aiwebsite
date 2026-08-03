#!/usr/bin/env node
// Deterministic tests for scripts/lib/title-keywords.mjs
// (node scripts/title-keywords-tests.mjs). Pins the keyword regression corpus
// that three incidents built (07-24 slug clone, 07-27 "panic around chinese",
// 08-03 "models today") so the next STOPWORDS/run-logic change is executed
// against it instead of re-traced by hand.

import assert from "node:assert/strict";
import { cleanTitle, keywordsFromTitle, slugify } from "./lib/title-keywords.mjs";

let passed = 0;
function t(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

const primary = (title) => keywordsFromTitle(title)[0];

// --- the 2026-08-03 failure signature ----------------------------------------
const OFFENDER_2026_08_03 = "New Models Today — AI & LLM Releases Last 24 Hours";

t("2026-08-03 aggregator title yields no temporal token in any keyword", () => {
  const kws = keywordsFromTitle(OFFENDER_2026_08_03);
  const temporal = /\b(?:today|tonight|yesterday|tomorrow|hours?|weeks?)\b/;
  for (const kw of kws) assert.ok(!temporal.test(kw), `temporal token in "${kw}" [${kws}]`);
  assert.notEqual(kws[0], "models today");
});

t("temporal deictics never lead a primary keyword", () => {
  assert.equal(primary("Fines Start Today for AI Deepfakes in California"), "fines start");
  assert.equal(primary("This Week in All Things AI - Week 31-2026"), "all things ai");
});

// --- the standing regression corpus (evidence bundles 07-24 → 08-03) ---------
t("preposition break yields the head noun phrase (07-27 incident)", () => {
  assert.equal(primary("Panic Around Chinese AI Models"), "chinese ai models");
});

t("entity-first: first 2+ token run wins over longer later runs", () => {
  assert.equal(
    primary("Trump Administration and House Lawmakers Launch New AI Governance Push"),
    "trump administration",
  );
});

t("connective break rejoins the entity to its action", () => {
  assert.equal(primary("Microsoft to invest billions"), "microsoft invest billions");
});

t("shipped 08-02 behavior kept for the Anthropic disclosure headline", () => {
  assert.equal(
    primary("Anthropic discloses its AI models hacked into three organizations during testing"),
    "anthropic discloses",
  );
});

t("first clause only + 4-token/38-char caps (California Transparency Act)", () => {
  const p = primary(
    "California AI Transparency Act Operative: Midjourney Has No Watermark, Fines Start Today",
  );
  assert.equal(p, "california ai transparency act");
  assert.ok(p.length <= 38);
});

t("possessive scrub leaves no orphan s token", () => {
  assert.equal(
    primary(
      "OpenAI's Hugging Face hack confirmed months of AI cyber warnings: 'Pandora's box is open'",
    ),
    "openai hugging face hack",
  );
});

// --- deliberate non-stopwords ------------------------------------------------
t("day/days are NOT stopwords (zero day / Demo Day are entity phrases)", () => {
  assert.equal(
    primary("Microsoft patches zero day flaw exploited by AI-generated malware"),
    "microsoft patches zero day",
  );
});

t("duration stopword promotes the head phrase after a preposition", () => {
  assert.equal(primary("Two weeks after GPT-6 launch, enterprise adoption surges"), "gpt-6 launch");
});

t("USA Today as actor degrades gracefully (entity+action, no junk)", () => {
  assert.equal(primary("USA Today sues OpenAI over training data"), "usa sues openai");
});

// --- slug invariants ---------------------------------------------------------
t("slugify(primary, 42) never truncates mid-word (38-char cap)", () => {
  const p = primary(
    "Extraordinarily Comprehensive Radiological Reinvention Announcement Overview Extravaganza",
  );
  assert.ok(p.length <= 38, `primary too long: "${p}" (${p.length})`);
  assert.equal(slugify(p, 42), p.replace(/[^a-z0-9]+/g, "-"));
});

t("slugify strips apostrophes and collapses non-alphanumerics", () => {
  assert.equal(slugify("OpenAI’s GPT-6: what now?", 60), "openais-gpt-6-what-now");
  assert.equal(slugify("???", 60), "ai-news");
});

// --- cleanTitle publisher stripping -----------------------------------------
t("cleanTitle strips 'Headline - Publisher' and bare-domain suffixes", () => {
  assert.equal(
    cleanTitle("OpenAI launches GPT-6 with new controls - The Verge"),
    "OpenAI launches GPT-6 with new controls",
  );
  assert.equal(
    cleanTitle("Critical AI supply chain flaw patched after disclosure - csoonline.com"),
    "Critical AI supply chain flaw patched after disclosure",
  );
});

t("cleanTitle keeps a title with no publisher suffix verbatim", () => {
  assert.equal(cleanTitle(OFFENDER_2026_08_03), OFFENDER_2026_08_03);
});

console.log(`\n${passed} title-keywords tests passed`);
