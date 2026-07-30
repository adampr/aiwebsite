#!/usr/bin/env node
// Deterministic tests for scripts/lib/peg-score.mjs (node scripts/peg-score-tests.mjs).
// Pins the exact 2026-07-22 failure signature (peg-less survey headline must
// rank below any pegged headline) plus the named-release offset that keeps
// legitimate fresh surveys eligible, and the checkTopic-haystack safety of
// the report-of-record framing text.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hasNamedActor, pegScore, rankByPeg } from "./lib/peg-score.mjs";

function fsRead(rel) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  return fs.readFileSync(path.join(root, rel), "utf8");
}

const NOW = Date.parse("2026-07-22T12:00:00Z");
let passed = 0;
function t(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

// --- the reported failure signature -----------------------------------------
const SURVEY_2026_07_22 =
  "Survey of business and tech leaders reveals persistent gap between corporate AI adoption and workforce readiness";

t("2026-07-22 survey headline scores peg-less (negative)", () => {
  const { score, signals } = pegScore(SURVEY_2026_07_22, { now: NOW });
  assert.ok(score < 0, `expected negative, got ${score} [${signals}]`);
  assert.ok(signals.includes("-survey"));
});

t("sentence-initial 'Survey' is not mistaken for a named actor", () => {
  assert.equal(hasNamedActor("Survey of business and tech leaders reveals things"), false);
});

t("hard-news headline scores strongly pegged", () => {
  const { score } = pegScore("OpenAI launches GPT-6 with new enterprise controls", { now: NOW });
  assert.ok(score >= 4, `expected >=4, got ${score}`);
});

t("regulator action is pegged", () => {
  const { score } = pegScore("FTC orders Meta to halt AI training on teen data", { now: NOW });
  assert.ok(score >= 4, `expected >=4, got ${score}`);
});

t("fresh named survey release keeps a non-negative score (named-release offset)", () => {
  const { score, signals } = pegScore("Gallup publishes 2026 AI adoption survey of US workers", {
    publishedAt: "2026-07-22T08:00:00Z",
    now: NOW,
  });
  assert.ok(score >= 0, `expected >=0, got ${score} [${signals}]`);
  assert.ok(signals.includes("+named-release-offset"));
});

t("explainer/question titles are demoted", () => {
  assert.ok(pegScore("Why AI benchmarks no longer matter", { now: NOW }).score < 2);
  assert.ok(pegScore("Is your business ready for agentic AI?", { now: NOW }).score < 0);
});

t("rankByPeg puts the pegged story above a higher-Tavily-score survey", () => {
  const ranked = rankByPeg(
    [
      { title: SURVEY_2026_07_22, score: 0.95 },
      { title: "Anthropic releases Claude for Government after GSA approval", score: 0.5 },
    ],
    NOW,
  );
  assert.equal(ranked[0].title.startsWith("Anthropic"), true);
  assert.equal(ranked.length, 2); // demotion, never exclusion
  assert.equal(typeof ranked[1].pegScore, "number");
});

t("rankByPeg tiebreaks equal peg scores by Tavily score", () => {
  const ranked = rankByPeg(
    [
      { title: "Google announces Gemini 4", score: 0.4 },
      { title: "Microsoft announces Copilot 5", score: 0.8 },
    ],
    NOW,
  );
  assert.equal(ranked[0].title.startsWith("Microsoft"), true);
});

// --- the 2026-07-30 press-release failure signature --------------------------
// A PR Newswire self-announcement scored peg 5 [+actor +event-verb +fresh]
// and beat every real story that night (best real: peg 4), then failed the
// rubric (readability 2, voiceAdherence 2). Wire URL and PR-speak headline
// shape must demote it below the real stories — without touching a real
// launch merely covered by journalism.
const NOW_0730 = Date.parse("2026-07-30T05:00:00Z");
const FRESH_0730 = "2026-07-29T22:00:00Z";
const ALLOYED_2026_07_30 =
  "Alloyed Announces Strategic Partnership with SimpliSmart LLC to Deliver Accelerated, End-to-End AI-Powered Enterprise Operations";
const ALLOYED_WIRE_URL =
  "https://www.prnewswire.com/news-releases/alloyed-announces-strategic-partnership-with-simplismart-llc-302999999.html";

t("2026-07-30 wire press release drops below the night's real stories", () => {
  const { score, signals } = pegScore(ALLOYED_2026_07_30, {
    publishedAt: FRESH_0730,
    now: NOW_0730,
    url: ALLOYED_WIRE_URL,
  });
  assert.ok(signals.includes("-wire"), `expected -wire in [${signals}]`);
  assert.ok(signals.includes("-pr-speak"), `expected -pr-speak in [${signals}]`);
  // That night's real stories scored 3-4; the release must land below 3.
  assert.ok(score < 3, `expected <3, got ${score} [${signals}]`);
});

t("same release syndicated on a non-wire domain is caught by headline shape", () => {
  const { score, signals } = pegScore(ALLOYED_2026_07_30, {
    publishedAt: FRESH_0730,
    now: NOW_0730,
    url: "https://finance.yahoo.com/news/alloyed-announces-strategic-partnership-110000123.html",
  });
  assert.ok(!signals.includes("-wire"), `unexpected -wire in [${signals}]`);
  assert.ok(signals.includes("-pr-speak"), `expected -pr-speak in [${signals}]`);
  assert.ok(score < 3, `expected <3, got ${score} [${signals}]`);
});

t("rankByPeg ranks the 07-30 wire release below the peg-4 real stories", () => {
  const ranked = rankByPeg(
    [
      { title: ALLOYED_2026_07_30, url: ALLOYED_WIRE_URL, score: 0.95, published_date: FRESH_0730 },
      {
        title: "Moonshot AI Closes $3.5B Round, But Its Open Weights Come With China Data Risk",
        url: "https://techcrunch.com/2026/07/29/moonshot-ai-closes-3-5b-round/",
        score: 0.6,
        published_date: FRESH_0730,
      },
      {
        title: "Enterprise AI Adoption: 59% Spend $1M+, 29% See ROI [2026]",
        url: "https://venturebeat.com/ai/enterprise-ai-adoption-2026/",
        score: 0.7,
        published_date: FRESH_0730,
      },
    ],
    NOW_0730,
  );
  assert.equal(ranked[ranked.length - 1].title, ALLOYED_2026_07_30);
  assert.equal(ranked.length, 3); // demotion, never exclusion
});

t("a real launch covered by journalism is untouched by the PR demotion", () => {
  const withUrl = pegScore("OpenAI launches GPT-6 with new enterprise controls", {
    now: NOW,
    url: "https://techcrunch.com/2026/07/22/openai-launches-gpt-6/",
  });
  const withoutUrl = pegScore("OpenAI launches GPT-6 with new enterprise controls", { now: NOW });
  assert.equal(withUrl.score, withoutUrl.score);
  assert.ok(!withUrl.signals.includes("-wire"), `unexpected -wire in [${withUrl.signals}]`);
  assert.ok(!withUrl.signals.includes("-pr-speak"), `unexpected -pr-speak in [${withUrl.signals}]`);
  assert.ok(withUrl.score >= 4, `expected >=4, got ${withUrl.score}`);
});

// --- framing-text safety vs the topic gate ----------------------------------
// The brief texts news.ts appends (REPORT_OF_RECORD_BRIEF and, since
// 2026-07-25, RANKABILITY_BRIEF on every entry) flow into checkTopic's
// offLimits haystack. This host runs offLimits: [] so nothing can trip — pin
// that assumption so a future offLimits addition gets a loud failure here.
t("site.config.ts still runs with empty blog offLimits (framing-text safety)", () => {
  const cfg = fsRead("site.config.ts");
  assert.match(cfg, /offLimits:\s*\[\s*\]/);
});

// RANKABILITY_BRIEF rides on EVERY calendar entry (not just peg-less days) —
// pin its presence and its unconditional append so a refactor that drops it
// (or makes it conditional) fails loudly here rather than silently reverting
// the 2026-07-25 owner directive.
t("news.ts appends RANKABILITY_BRIEF to every calendar entry description", () => {
  const news = fsRead("src/lib/blog/news.ts");
  assert.match(news, /const RANKABILITY_BRIEF =/);
  assert.match(news, /news\.top\.description \+\s*\n?\s*RANKABILITY_BRIEF \+/);
});

console.log(`\n${passed} peg-score tests passed`);
