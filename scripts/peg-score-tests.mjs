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

// --- framing-text safety vs the topic gate ----------------------------------
// The report-of-record brief text news.ts appends flows into checkTopic's
// offLimits haystack. This host runs offLimits: [] so nothing can trip — pin
// that assumption so a future offLimits addition gets a loud failure here.
t("site.config.ts still runs with empty blog offLimits (framing-text safety)", () => {
  const cfg = fsRead("site.config.ts");
  assert.match(cfg, /offLimits:\s*\[\s*\]/);
});

console.log(`\n${passed} peg-score tests passed`);
