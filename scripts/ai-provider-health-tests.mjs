#!/usr/bin/env node
// Tests for scripts/ai-provider-health.mjs (npm run test:providerhealth).
//
// No network, no keys, no provider bill: every case runs the REAL script as a
// child process with a module preloaded by --import that replaces
// globalThis.fetch before the script's first line runs. The stub never calls
// the real fetch; it records each request and answers from the case's
// fixture. A preload that fails to load is fatal to the child, so the script
// can never run unstubbed; each case also asserts the stub's load marker.
//
// The stub answers the way the providers do where it matters: a completion
// request carrying no string model id is a 400 (OpenAI's answer to
// model:null), and an id listed in a case's `failModels` is a 404.
//
// Pinned (brain v1.166 #878): /v1/model-routing's panel_critic row can report
// model null / provider null / reason no_cross_lab_candidate. The old loop
// keyed that "null/null" and sent model:null to api.openai.com — a guaranteed
// false FAIL. Cases N1-N4 fail on the pre-fix script; C1-C3 are controls that
// pass on both and prove every other behaviour is kept.
//
// Usage: node scripts/ai-provider-health-tests.mjs [--script <path>]
//   --script runs the same cases against another copy of the script (e.g. the
//   pre-fix one) to prove the arms detect the defect.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptFlag = process.argv.indexOf("--script");
const SCRIPT = scriptFlag >= 0
  ? path.resolve(process.argv[scriptFlag + 1])
  : path.join(here, "ai-provider-health.mjs");

const STUB_SOURCE = `
import fs from "node:fs";
const logPath = process.env.PH_TEST_LOG;
const routing = JSON.parse(fs.readFileSync(process.env.PH_TEST_ROUTING, "utf8"));
const routingStatus = Number(process.env.PH_TEST_ROUTING_STATUS || 200);
const failModels = new Set(JSON.parse(process.env.PH_TEST_FAIL_MODELS || "[]"));
const log = (entry) => fs.appendFileSync(logPath, JSON.stringify(entry) + "\\n");
log({ stub: "loaded" });
const reply = (status, obj) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, init = {}) => {
  const url = String(typeof input === "string" ? input : input.url);
  const method = String(init.method || "GET").toUpperCase();
  let body = null;
  if (typeof init.body === "string") {
    try { body = JSON.parse(init.body); } catch { body = init.body; }
  }
  const gen = url.match(/\\/models\\/([^/:]*):generateContent$/);
  const completion = gen != null || /\\/v1\\/(chat\\/completions|messages)$/.test(url);
  const model = gen ? decodeURIComponent(gen[1]) : body && typeof body === "object" ? body.model : undefined;
  log({ url, method, completion, model: model === undefined ? "<absent>" : model });
  if (url.endsWith("/v1/model-routing")) return reply(routingStatus, routing);
  if (completion) {
    if (typeof model !== "string" || model === "" || model === "null" || model === "undefined") {
      return reply(400, { error: { message: "model: expected a string" } });
    }
    if (failModels.has(model)) return reply(404, { error: { message: "model_not_found" } });
  }
  return reply(200, {});
};
`;

// Dummy values only: the stub answers every request, nothing is sent anywhere.
const BASE_ENV_LINES = [
  "OPENAI_API_KEY=dummy-openai",
  "ANTHROPIC_API_KEY=dummy-anthropic",
  "XAI_API_KEY=dummy-xai",
  "DEEPGRAM_API_KEY=dummy-deepgram",
  "TAVILY_API_KEY=dummy-tavily",
  "BRAIN_BASE_URL=http://brain.test.invalid",
  "BRAIN_API_KEYS=dummy-brain",
];

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-provider-health-tests-"));
const stubPath = path.join(tmpRoot, "fetch-stub.mjs");
fs.writeFileSync(stubPath, STUB_SOURCE);

let caseNo = 0;
function runHealth({ routing, routingStatus = 200, failModels = [], envLines = [] }) {
  const dir = path.join(tmpRoot, `case-${++caseNo}`);
  fs.mkdirSync(dir);
  const envPath = path.join(dir, "test.env");
  const routingPath = path.join(dir, "routing.json");
  const logPath = path.join(dir, "requests.jsonl");
  fs.writeFileSync(envPath, [...BASE_ENV_LINES, ...envLines].join("\n") + "\n");
  fs.writeFileSync(routingPath, JSON.stringify(routing));
  fs.writeFileSync(logPath, "");
  const r = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(stubPath).href, SCRIPT, "--env", envPath],
    {
      encoding: "utf8",
      timeout: 60_000,
      // A minimal environment: the child sees no real key from this shell.
      env: {
        PATH: process.env.PATH ?? "",
        PH_TEST_LOG: logPath,
        PH_TEST_ROUTING: routingPath,
        PH_TEST_ROUTING_STATUS: String(routingStatus),
        PH_TEST_FAIL_MODELS: JSON.stringify(failModels),
      },
    }
  );
  const lines = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(lines[0], { stub: "loaded" }, "fetch stub did not load first — refusing to trust this run");
  const requests = lines.slice(1);
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    requests,
    completions: requests.filter((q) => q.completion),
  };
}

const lineFor = (stdout, check) =>
  stdout.split("\n").find((l) => /^(PASS|FAIL) {2}/.test(l) && l.slice(6).split("  ")[0] === check);

let passed = 0;
let failed = 0;
function t(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`not ok - ${name}\n  ${String(err?.message ?? err).split("\n").join("\n  ")}`);
  }
}

// Served rows as a v1.166 brain reports them on a host with several labs keyed.
const SERVED = [
  { task: "plan_execute_executor", model: "claude-opus-5-5", provider: "anthropic", reason: "router_v2" },
  { task: "plan_execute_planner", model: "gpt-5.6-sol", provider: "openai", reason: "router_v2" },
  { task: "plan_execute_verifier", model: "gpt-5.6-sol", provider: "openai", reason: "router_v2" },
  { task: "classifier", model: "grok-4.6", provider: "xai", reason: "router_v2" },
];
const SERVED_IDS = ["claude-opus-5-5", "gpt-5.6-sol", "grok-4.6"];

// The #878 shape: no cross-lab critic, so the panel runs without one.
const NULL_CRITIC = {
  task: "panel_critic",
  model: null,
  provider: null,
  reason: "no_cross_lab_candidate",
  pin: null,
  contrastive: {
    planExecute: { model: null, provider: null, reason: "no_cross_lab_candidate", answerers: [], excludeProviders: ["anthropic", "openai"], verdict: null },
    jsonCompletion: null,
    rowPoolProviders: [],
    degraded: { reason: "no_cross_lab_candidate", cause: "no_pool_provider", noVerdict: { count: 0, reported: [] } },
  },
};

const noBadModel = (res) =>
  res.completions.filter((q) => typeof q.model !== "string" || q.model === "" || q.model === "null" || q.model === "undefined");

// ── N: the #878 defect (these FAIL on the pre-fix script) ─────────────

t("N1 null panel_critic (no_cross_lab_candidate): exit 0, never probed, reported PASS; served ids still probed once each", () => {
  const res = runHealth({ routing: { tasks: [...SERVED, NULL_CRITIC] } });
  assert.deepEqual(noBadModel(res), [], `a completion was sent with no model id: ${JSON.stringify(noBadModel(res))}`);
  assert.doesNotMatch(res.stdout, /null\/null|undefined\/undefined/, "report keyed a null model");
  const critic = lineFor(res.stdout, "routing panel_critic");
  assert.ok(critic?.startsWith("PASS"), `no PASS line for the degraded critic:\n${res.stdout}`);
  assert.match(critic, /no_cross_lab_candidate/);
  assert.deepEqual(res.completions.map((q) => q.model).sort(), [...SERVED_IDS].sort(), "served ids not probed exactly once each");
  assert.equal(res.status, 0, `exit ${res.status}:\n${res.stdout}${res.stderr}`);
});

t("N2 a no-candidate reason beside a stray model id: that id is not probed, the row is a PASS", () => {
  const stray = { task: "panel_critic", model: "grok-4.5-stray", provider: "xai", reason: "no_cross_lab_candidate" };
  const res = runHealth({ routing: { tasks: [...SERVED, stray] } });
  assert.ok(!res.completions.some((q) => q.model === "grok-4.5-stray"), "the stray id was probed");
  const critic = lineFor(res.stdout, "routing panel_critic");
  assert.ok(critic?.startsWith("PASS"), `no PASS line:\n${res.stdout}`);
  assert.match(critic, /grok-4\.5-stray not probed/);
  assert.equal(res.status, 0, `exit ${res.status}:\n${res.stdout}`);
});

t("N3 a null model with an unexplained reason: never probed, but still a FAIL naming the task (exit 1)", () => {
  const orphan = { task: "json_completion", model: null, provider: null, reason: "router_default" };
  const res = runHealth({ routing: { tasks: [...SERVED, orphan] } });
  assert.deepEqual(noBadModel(res), [], `a completion was sent with no model id: ${JSON.stringify(noBadModel(res))}`);
  const row = lineFor(res.stdout, "routing json_completion");
  assert.ok(row?.startsWith("FAIL"), `no FAIL line for the unrouted task:\n${res.stdout}`);
  assert.match(row, /brain routed no model \(reason: router_default\)/);
  assert.doesNotMatch(res.stdout, /null\/null/);
  assert.equal(res.status, 1);
});

t("N4 absent, blank and non-string model ids (no reason): never probed, each a FAIL", () => {
  const rows = [
    { task: "absent_model", provider: "openai" },
    { task: "blank_model", model: "  ", provider: "openai", reason: "" },
    { task: "numeric_model", model: 5, provider: "openai" },
  ];
  const res = runHealth({ routing: { tasks: [...SERVED, ...rows] } });
  assert.deepEqual(res.completions.map((q) => q.model).sort(), [...SERVED_IDS].sort(), `unexpected probes: ${JSON.stringify(res.completions)}`);
  for (const r of rows) {
    const row = lineFor(res.stdout, `routing ${r.task}`);
    assert.ok(row?.startsWith("FAIL"), `no FAIL line for ${r.task}:\n${res.stdout}`);
    assert.match(row, /brain routed no model/);
  }
  assert.equal(res.status, 1);
});

// ── C: controls (pass on both scripts — every other behaviour kept) ───

t("C1 a routed id the provider rejects is still a FAIL (exit 1); the ids beside it still PASS", () => {
  const broken = { task: "session_debrief", model: "gpt-broken", provider: "openai", reason: "router_v2" };
  const res = runHealth({ routing: { tasks: [...SERVED, broken] }, failModels: ["gpt-broken"] });
  const row = lineFor(res.stdout, "model openai/gpt-broken");
  assert.ok(row?.startsWith("FAIL"), `no FAIL for the rejected id:\n${res.stdout}`);
  assert.match(row, /HTTP 404/);
  for (const [p, m] of [["anthropic", "claude-opus-5-5"], ["openai", "gpt-5.6-sol"], ["xai", "grok-4.6"]]) {
    assert.ok(lineFor(res.stdout, `model ${p}/${m}`)?.startsWith("PASS"), `${p}/${m} not PASS:\n${res.stdout}`);
  }
  assert.equal(res.status, 1);
});

t("C2 dispatch kept: each provider's endpoint, dedupe, the served critic probed, plannerEffectiveModel, gemini skipped without a key", () => {
  const servedCritic = { task: "panel_critic", model: "grok-4.5", provider: "xai", reason: "contrastive" };
  const gemini = { task: "planner", model: "gemini-3.1-pro-preview", provider: "google", reason: "router_v2" };
  const res = runHealth({
    routing: { tasks: [...SERVED, servedCritic, gemini], plannerEffectiveModel: "gpt-5-mini" },
  });
  const byModel = Object.fromEntries(res.completions.map((q) => [q.model, q.url]));
  assert.equal(byModel["claude-opus-5-5"], "https://api.anthropic.com/v1/messages");
  assert.equal(byModel["gpt-5.6-sol"], "https://api.openai.com/v1/chat/completions");
  assert.equal(byModel["grok-4.6"], "https://api.x.ai/v1/chat/completions");
  assert.equal(byModel["grok-4.5"], "https://api.x.ai/v1/chat/completions", "the served (contrastive) critic was not probed");
  assert.equal(byModel["gpt-5-mini"], "https://api.openai.com/v1/chat/completions", "plannerEffectiveModel not probed");
  assert.equal(res.completions.filter((q) => q.model === "gpt-5.6-sol").length, 1, "duplicate provider/model probed twice");
  assert.ok(!res.completions.some((q) => String(q.model).startsWith("gemini-")), "gemini probed with no key");
  const auth = res.requests.filter((q) => !q.completion && !q.url.endsWith("/v1/model-routing")).map((q) => new URL(q.url).host).sort();
  assert.deepEqual(auth, ["api.anthropic.com", "api.deepgram.com", "api.openai.com", "api.tavily.com", "api.x.ai"]);
  assert.equal(res.status, 0, `exit ${res.status}:\n${res.stdout}`);
});

t("C3 brain model-routing unavailable: a FAIL, no completion probes, exit 1", () => {
  const res = runHealth({ routing: { error: "down" }, routingStatus: 503 });
  assert.ok(lineFor(res.stdout, "brain model-routing")?.startsWith("FAIL"), res.stdout);
  assert.equal(res.completions.length, 0);
  assert.equal(res.status, 1);
});

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed — ai-provider-health tests (${path.relative(process.cwd(), SCRIPT) || SCRIPT})`);
process.exit(failed === 0 ? 0 : 1);
