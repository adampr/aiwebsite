/**
 * /rfp/knowledge/mine own-row rules (ARCHITECTURE.md §5.17.9). Pure, no DB:
 *
 *   npm run test:rfpmine
 *
 * Pins: a PATCH is validated as the MERGED result (a partial body cannot
 * turn a fact keyless); keys are slugs; a choice is never submittable or
 * promotable; approved rows are frozen for edit, move and delete; only an
 * admin promotes; a legacy "general" fact category is steered to the corpus.
 */

import assert from "node:assert/strict";
import {
  canDeleteKnowledge,
  corpusCategory,
  knowledgeTransition,
  normalizeKnowledgePatch,
  type KnowledgeFields,
} from "../src/lib/rfp/knowledge-mine";

const fact: KnowledgeFields = {
  kind: "fact",
  factKey: "support.response-time",
  category: "operations",
  statement: "XL.net answers priority-one tickets within 15 minutes.",
  detail: null,
  polarity: "affirmative",
};
const choice: KnowledgeFields = {
  kind: "choice",
  factKey: null,
  category: "general",
  statement: "For this client we quote the 24x7 tier only.",
  detail: "Their RFP asks for it on page 3.",
  polarity: "affirmative",
};

let n = 0;
const t = (name: string, fn: () => void) => {
  fn();
  n++;
  console.log(`  ok  ${name}`);
};

console.log("normalizeKnowledgePatch");
t("partial body keeps every other field", () => {
  const r = normalizeKnowledgePatch({ statement: "XL.net holds a SOC 2 Type II report." }, fact);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.fields, { ...fact, statement: "XL.net holds a SOC 2 Type II report." });
});
t("short statement refused", () => {
  const r = normalizeKnowledgePatch({ statement: "too short" }, fact);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.status, 400);
});
t("flipping a choice to a fact needs a key", () => {
  const r = normalizeKnowledgePatch({ kind: "fact" }, choice);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.message, /needs a key/);
});
t("flipping a choice to a fact with a key and category passes, key lowercased", () => {
  const r = normalizeKnowledgePatch(
    { kind: "fact", factKey: " Support.Tier ", category: "commercial" },
    choice
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.fields.kind, "fact");
  assert.equal(r.fields.factKey, "support.tier");
  assert.equal(r.fields.category, "commercial");
});
t("a bad key slug is refused", () => {
  const r = normalizeKnowledgePatch({ factKey: "has space" }, fact);
  assert.equal(r.ok, false);
});
t("flipping a fact to a choice drops the key", () => {
  const r = normalizeKnowledgePatch({ kind: "choice" }, fact);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.fields.factKey, null);
});
t("legacy general category on an untouched fact is steered to capability", () => {
  const r = normalizeKnowledgePatch({ statement: fact.statement }, { ...fact, category: "general" });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.fields.category, "capability");
});
t("an explicit off-corpus category on a fact is refused", () => {
  const r = normalizeKnowledgePatch({ category: "general" }, fact);
  assert.equal(r.ok, false);
});
t("a choice keeps general", () => {
  const r = normalizeKnowledgePatch({ detail: "" }, choice);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.fields.category, "general");
  assert.equal(r.fields.detail, null);
});
t("unknown polarity falls to affirmative, negative kept", () => {
  const a = normalizeKnowledgePatch({ polarity: "maybe" }, fact);
  const b = normalizeKnowledgePatch({ polarity: "negative" }, fact);
  assert.equal(a.ok && a.fields.polarity, "affirmative");
  assert.equal(b.ok && b.fields.polarity, "negative");
});

console.log("knowledgeTransition");
const user = { admin: false };
const admin = { admin: true };
t("private fact -> submit", () => {
  const r = knowledgeTransition({ status: "private", kind: "fact", factKey: "a.b" }, "submit", user);
  assert.deepEqual(r, { ok: true, from: ["private", "returned"], to: "submitted" });
});
t("returned fact -> submit again", () => {
  const r = knowledgeTransition({ status: "returned", kind: "fact", factKey: "a.b" }, "submit", user);
  assert.equal(r.ok, true);
});
t("a choice cannot be submitted", () => {
  const r = knowledgeTransition({ status: "private", kind: "choice", factKey: null }, "submit", user);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.message, /change its kind/);
});
t("a keyless fact cannot be submitted", () => {
  const r = knowledgeTransition({ status: "private", kind: "fact", factKey: null }, "submit", user);
  assert.equal(r.ok, false);
});
t("submitted -> withdraw -> private", () => {
  const r = knowledgeTransition({ status: "submitted", kind: "fact", factKey: "a.b" }, "withdraw", user);
  assert.deepEqual(r, { ok: true, from: ["submitted"], to: "private" });
});
t("withdraw needs a submitted row", () => {
  const r = knowledgeTransition({ status: "private", kind: "fact", factKey: "a.b" }, "withdraw", user);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.status, 409);
});
t("promote is admin-only (403)", () => {
  const r = knowledgeTransition({ status: "private", kind: "fact", factKey: "a.b" }, "promote", user);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.status, 403);
});
t("admin promotes from private, submitted or returned", () => {
  for (const status of ["private", "submitted", "returned"]) {
    const r = knowledgeTransition({ status, kind: "fact", factKey: "a.b" }, "promote", admin);
    assert.equal(r.ok, true, status);
    if (!r.ok) return;
    assert.equal(r.to, "approved");
  }
});
t("admin cannot promote a choice", () => {
  const r = knowledgeTransition({ status: "private", kind: "choice", factKey: null }, "promote", admin);
  assert.equal(r.ok, false);
});
t("approved rows are frozen for every action (409)", () => {
  for (const action of ["submit", "withdraw", "promote"] as const) {
    const r = knowledgeTransition({ status: "approved", kind: "fact", factKey: "a.b" }, action, admin);
    assert.equal(r.ok, false, action);
    if (r.ok) return;
    assert.equal(r.code, "in_shared_base");
    assert.equal(r.status, 409);
  }
});
t("unknown action refused", () => {
  const r = knowledgeTransition({ status: "private", kind: "fact", factKey: "a.b" }, "zap" as never, admin);
  assert.equal(r.ok, false);
});

console.log("canDeleteKnowledge / corpusCategory");
t("private, submitted and returned rows can be deleted", () => {
  for (const status of ["private", "submitted", "returned"])
    assert.equal(canDeleteKnowledge({ status }), true, status);
});
t("an approved row cannot be deleted", () => {
  const r = canDeleteKnowledge({ status: "approved" });
  assert.notEqual(r, true);
  if (r === true) return;
  assert.equal(r.status, 409);
});
t("corpusCategory steers unknown to capability, keeps known", () => {
  assert.equal(corpusCategory("general"), "capability");
  assert.equal(corpusCategory("commercial"), "commercial");
});

console.log(`\n${n} assertions passed`);
