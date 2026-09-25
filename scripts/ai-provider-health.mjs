#!/usr/bin/env node
// AI-provider health check for ai.xl.net.
//
// Two layers:
//   1. Auth probes — is each configured provider key (OpenAI, Anthropic, xAI,
//      Google Gemini, Deepgram, Tavily) alive at all?
//   2. Routing probes — ask the brain's GET /v1/model-routing which concrete
//      model id every pipeline task would use right now, then make a
//      1-token completion against each unique id. This catches the case
//      where the model registry starts routing to an id the key cannot call
//      (e.g. gpt-5-6-luna 404'd every plan_execute turn on 2026-07-09) —
//      before a visitor does. A row that routes NO model (brain v1.166 #878:
//      panel_critic with model null, reason no_cross_lab_candidate) is
//      reported, never probed — see routedModelOf / NO_CANDIDATE_REASONS.
//
// Known false FAIL (not fixed here): a routed id whose provider is deepinfra
// or fireworks is probed at api.openai.com with the OpenAI key (this script
// has no DeepInfra/Fireworks probe), so it FAILs whether or not the model
// serves. Read `model deepinfra/…` / `model fireworks/…` FAIL lines that way.
//
// Usage: node scripts/ai-provider-health.mjs [--env /path/to/.env]
// Exit code: 0 = all checks passed, 1 = at least one failure (report on
// stdout). Operator-run: the module-rendered deploy/watchdog.sh no longer
// calls it (ARCHITECTURE.md §9.6), so nothing schedules or mails it today.
// Tests (no network, fetch stubbed): npm run test:providerhealth
//
// No SDKs on purpose: plain fetch, so it runs anywhere Node 18+ does.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const envFlagIdx = argv.indexOf("--env");
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH =
  envFlagIdx >= 0 ? argv[envFlagIdx + 1] : path.resolve(scriptDir, "../.env");

const env = {};
try {
  for (const line of fs.readFileSync(ENV_PATH, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {
  console.error(`FATAL: cannot read env file at ${ENV_PATH}`);
  process.exit(1);
}

const BRAIN_BASE_URL = env.BRAIN_BASE_URL || "http://127.0.0.1:3211";
const BRAIN_KEY = (env.BRAIN_API_KEYS || "").split(",")[0].trim();
const TIMEOUT_MS = 30_000;

const results = []; // { check, ok, detail }

function record(check, ok, detail = "") {
  results.push({ check, ok, detail });
}

async function probe(check, fn) {
  try {
    await fn();
    record(check, true);
  } catch (err) {
    record(check, false, err instanceof Error ? err.message : String(err));
  }
}

async function expectOk(url, init, describe) {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`${describe}: HTTP ${res.status} ${body}`);
  }
  return res;
}

// ── Layer 1: provider auth probes ─────────────────────────────────

async function authProbes() {
  if (env.OPENAI_API_KEY) {
    await probe("auth openai", () =>
      expectOk(
        "https://api.openai.com/v1/models",
        { headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` } },
        "GET /v1/models"
      )
    );
  } else record("auth openai", false, "OPENAI_API_KEY not set");

  if (env.ANTHROPIC_API_KEY) {
    await probe("auth anthropic", () =>
      expectOk(
        "https://api.anthropic.com/v1/models?limit=1",
        {
          headers: {
            "x-api-key": env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
          },
        },
        "GET /v1/models"
      )
    );
  } else record("auth anthropic", false, "ANTHROPIC_API_KEY not set");

  if (env.XAI_API_KEY) {
    await probe("auth xai", () =>
      expectOk(
        "https://api.x.ai/v1/models",
        { headers: { Authorization: `Bearer ${env.XAI_API_KEY}` } },
        "GET /v1/models"
      )
    );
  } else record("auth xai", false, "XAI_API_KEY not set");

  if (env.GOOGLE_GEMINI_API_KEY) {
    await probe("auth google-gemini", () =>
      expectOk(
        "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
        { headers: { "x-goog-api-key": env.GOOGLE_GEMINI_API_KEY } },
        "GET /v1beta/models"
      )
    );
  } else {
    // Informational, not a failure: the brain's planner falls back to OpenAI
    // when no Gemini key is configured. Flip to a hard failure once the key
    // is provisioned and Gemini becomes a load-bearing provider.
    record("auth google-gemini", true, "no key configured (planner uses OpenAI fallback)");
  }

  if (env.DEEPGRAM_API_KEY) {
    await probe("auth deepgram", () =>
      expectOk(
        "https://api.deepgram.com/v1/projects",
        { headers: { Authorization: `Token ${env.DEEPGRAM_API_KEY}` } },
        "GET /v1/projects"
      )
    );
  } else record("auth deepgram", false, "DEEPGRAM_API_KEY not set");

  if (env.TAVILY_API_KEY) {
    await probe("auth tavily", () =>
      expectOk(
        "https://api.tavily.com/search",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${env.TAVILY_API_KEY}`,
          },
          body: JSON.stringify({ query: "healthcheck", max_results: 1 }),
        },
        "POST /search"
      )
    );
  } else record("auth tavily", false, "TAVILY_API_KEY not set");
}

// ── Layer 2: routed-model probes ──────────────────────────────────

// Brain v1.166 (#878): /v1/model-routing's panel_critic row reports
// model null / provider null with reason `no_cross_lab_candidate` when no
// cross-lab candidate is keyed, or none in that pool holds a panel_critic
// PASS — the row's contrastive.degraded.cause says which: `no_pool_provider`,
// or the gate exit that emptied the pool (e.g. `bar_805`; the brain then also
// raises an evalChallengerAlarms entry naming the eval to run). Either way the
// panel runs without a critic. Exactly the reasons the brain emits
// for "nothing is routed, on purpose" (its row type is
// 'contrastive' | 'no_cross_lab_candidate', apps/brain-api/src/routingTruth.ts),
// matched exactly and case-sensitively: a reason the brain does not emit today
// is never read as a deliberate degrade — a null model beside it stays a FAIL
// and a real id beside it is still probed. A future brain reason is added
// here, with a test, when the pin bump that brings it lands.
const NO_CANDIDATE_REASONS = new Set(["no_cross_lab_candidate"]);

// The routed model id, or null when the row carries none (null, absent,
// non-string or blank) — a row with no id has nothing a probe could call.
function routedModelOf(t) {
  return t && typeof t.model === "string" && t.model.trim() !== "" ? t.model : null;
}

async function completionProbe(provider, model) {
  if (provider === "anthropic") {
    return expectOk(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
      },
      `anthropic ${model}`
    );
  }
  if (provider === "google") {
    return expectOk(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: {
          "x-goog-api-key": env.GOOGLE_GEMINI_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: "hi" }] }],
          generationConfig: { maxOutputTokens: 1 },
        }),
      },
      `google ${model}`
    );
  }
  // openai + xai share the OpenAI wire format
  const base = provider === "xai" ? "https://api.x.ai" : "https://api.openai.com";
  const key = provider === "xai" ? env.XAI_API_KEY : env.OPENAI_API_KEY;
  return expectOk(
    `${base}/v1/chat/completions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        // Issue #872: the calling service's unique name (brain v1.163 binds it to the key).
        "X-Brain-Service": (env.BRAIN_SERVICE_NAME || "").trim() || "aiwebsite",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "hi" }],
        max_completion_tokens: 16,
      }),
    },
    `${provider} ${model}`
  );
}

async function routingProbes() {
  if (!BRAIN_KEY) {
    record("brain model-routing", false, "BRAIN_API_KEYS not set");
    return;
  }

  let routing;
  try {
    const res = await expectOk(
      `${BRAIN_BASE_URL}/v1/model-routing`,
      { headers: { Authorization: `Bearer ${BRAIN_KEY}` } },
      "GET /v1/model-routing"
    );
    routing = await res.json();
    record("brain model-routing", true);
  } catch (err) {
    // Older brain without the endpoint, or brain down: the watchdog's
    // separate /health check covers "brain down", so only note it here.
    record(
      "brain model-routing",
      false,
      err instanceof Error ? err.message : String(err)
    );
    return;
  }

  const unique = new Map();
  // model id -> the provider its probed task row names (for plannerEffectiveModel).
  const probedProviderOf = new Map();
  for (const t of routing.tasks || []) {
    const task = String(t?.task ?? "(unnamed task)");
    const reason = typeof t?.reason === "string" ? t.reason : "";
    const model = routedModelOf(t);
    // The brain says nothing serves this task (a deliberate degrade — the
    // #878 panel runs without a critic): there is no model to probe, and the
    // row is not a failure. Checked first, so a stray id beside a
    // no-candidate reason is not probed either. The brain's cause is shown so
    // a missing key (no_pool_provider) reads apart from a missing eval (bar_805).
    if (NO_CANDIDATE_REASONS.has(reason)) {
      const cause = t?.contrastive?.degraded?.cause;
      record(
        `routing ${task}`,
        true,
        `no candidate routed (${reason}${typeof cause === "string" && cause ? `, cause ${cause}` : ""})` +
          `${model ? `; ${model} not probed` : ""}`
      );
      continue;
    }
    // No model and no reason that explains it: still never probed (the old
    // loop sent model:null to api.openai.com under the key "null/null"), but
    // a task the brain cannot route at all is exactly what this check exists
    // to surface, so it stays a failure — now with a truthful message.
    if (model === null) {
      record(
        `routing ${task}`,
        false,
        `brain routed no model${reason ? ` (reason: ${reason})` : ""} — nothing to probe`
      );
      continue;
    }
    unique.set(`${t.provider}/${model}`, t);
    if (typeof t.provider === "string" && t.provider && !probedProviderOf.has(model)) probedProviderOf.set(model, t.provider);
  }
  // The planner's effective model matters even though the task list shows
  // the gemini default when no key exists. The brain derives it from the
  // plan_execute_planner / plan_execute_executor row, so it takes that row's
  // provider (and dedupes against that row's probe); only an id no probed row
  // carries falls back to the prefix rule. Before, every non-gemini planner
  // went to api.openai.com — claude-opus-5 there was a false FAIL (404).
  if (routing.plannerEffectiveModel) {
    const m = routing.plannerEffectiveModel;
    const p = probedProviderOf.get(m) ?? (m.startsWith("gemini-") ? "google" : "openai");
    if (p !== "google" || env.GOOGLE_GEMINI_API_KEY) unique.set(`${p}/${m}`, { provider: p, model: m });
  }

  for (const { provider, model } of unique.values()) {
    if (provider === "google" && !env.GOOGLE_GEMINI_API_KEY) continue;
    await probe(`model ${provider}/${model}`, () => completionProbe(provider, model));
  }
}

// ── Run + report ──────────────────────────────────────────────────

await authProbes();
await routingProbes();

const failures = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.check}${r.detail ? `  — ${r.detail}` : ""}`);
}
console.log(
  `\n${failures.length === 0 ? "ALL CHECKS PASSED" : `${failures.length}/${results.length} CHECKS FAILED`}`
);
process.exit(failures.length === 0 ? 0 : 1);
