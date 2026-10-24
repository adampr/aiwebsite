// Host contract tests for the @aicompany/core climb v1.142.2 -> v1.169.0
// (2026-10-23). Each case pins ONE assumption this host makes about a release
// in that range, read off the REAL resolved site.config (and the real module
// exports), so a later bump that moves one of them goes red here instead of on
// the VM. Run: npm run test:aicompany (tsx, no DB, no network, no mail).
//
// The release each case belongs to is named in the case title; the module's
// MIGRATIONS.md entry for that release is the contract being pinned.

import assert from "node:assert";
import { readFileSync } from "node:fs";

import { siteConfig } from "../site.config";
import { brainCallLadder, deriveBrainCallCeiling, isArticleDue } from "@aicompany/core/blog/generate";
import { audioMonthDemandFor } from "@aicompany/core/config/audio-budget";
import {
  DEFAULT_GEMINI_MODEL,
  geminiTtsRequestBody,
  isGemini38OrLaterTtsModel,
} from "@aicompany/core/blog/audio-tts";

let passed = 0;
async function ok(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`  ok   ${name}`);
}

const blog = siteConfig.blog;
const read = (p: string) => readFileSync(p, "utf8");

async function main() {
  await ok("pin: the module checkout is v1.171.0 and the lockfile's link entry agrees", () => {
    const mod = JSON.parse(read("packages/aicompany/package.json"));
    const lock = JSON.parse(read("package-lock.json"));
    assert.equal(mod.version, "1.171.0");
    assert.equal(lock.packages["packages/aicompany"].version, mod.version);
    // npm ci refuses a lock whose link entry disagrees with the linked
    // package.json (the v1.158.1 roleplay deploy failure): the recorded
    // devDependency ranges must be the module's own.
    assert.deepEqual(lock.packages["packages/aicompany"].devDependencies, mod.devDependencies);
  });

  await ok("v1.158.1/v1.165.1: no second next/react nested under the module (one router context)", () => {
    const lock = JSON.parse(read("package-lock.json"));
    for (const name of ["next", "react", "react-dom", "resend"]) {
      assert.equal(
        lock.packages[`packages/aicompany/node_modules/${name}`],
        undefined,
        `${name} must dedupe to the host's copy`,
      );
    }
  });

  await ok("v1.143.0: blog and backup units carry TimeoutStartSec, never the inert RuntimeMaxSec", () => {
    const setup = read("deploy/setup-vm.sh");
    assert.match(setup, /^TimeoutStartSec=7200$/m);
    assert.match(setup, /^TimeoutStartSec=3600$/m);
    assert.doesNotMatch(setup, /^RuntimeMaxSec=/m);
  });

  await ok("v1.161.0: no root playwright-core, so the deploy's browser step is a no-op here", () => {
    const lock = JSON.parse(read("package-lock.json"));
    assert.equal(lock.packages["node_modules/playwright-core"], undefined);
    assert.match(read("deploy/stage-build.sh"), /no playwright-core in the staged app/);
  });

  await ok("v1.144.0: the magic-link request wrapper forwards {email} only, so no redirect rides the link", () => {
    const src = read("src/app/api/auth/email/request/route.ts");
    assert.match(src, /body: JSON\.stringify\(\{ email \}\)/);
    // The body object handed to the module has exactly one key.
    assert.doesNotMatch(src, /JSON\.stringify\(\{ email, /);
    // ...which keeps the verify wrapper's "the module landed on /" success test true.
    assert.match(read("src/app/auth/email/verify/route.ts"), /pathname === "\/"/);
  });

  await ok("v1.147.0/v1.151.0: no SMS host hooks; the resolved default budget is 15000 ms", () => {
    const sms = siteConfig.channels.sms as unknown as Record<string, unknown> | undefined;
    assert.ok(sms, "this host has an SMS channel");
    assert.equal(sms.hostTurn, undefined);
    assert.equal(sms.hostForget, undefined);
    assert.equal(sms.hostTurnTimeoutMs, 15000);
  });

  await ok("v1.148.0/v1.157.0: single-type rotation, so the type bench and the saturation quiet are inert", () => {
    assert.deepEqual(blog.topics.rotation, ["news"]);
  });

  await ok("v1.154.0: narration stays explicitly ON (a missing generator fails config load, not silence)", () => {
    assert.equal(blog.audio.enabled, true);
    assert.equal((blog.audio as { enabledBy?: string }).enabledBy, "explicit");
  });

  await ok("v1.145.0/v1.155.0: derived month cap is the 400,000 floor; guard defaults 25 chars/s over 40 chars", () => {
    const d = audioMonthDemandFor(siteConfig);
    assert.equal(d.derivedCap, 400_000);
    assert.equal(blog.audio.maxCharsPerMonth, 400_000);
    const a = blog.audio as { chunkMaxCharsPerSec?: number; chunkGuardMinChars?: number };
    assert.equal(a.chunkMaxCharsPerSec, 25);
    assert.equal(a.chunkGuardMinChars, 40);
  });

  await ok("v1.168.0: the primary narrates on gemini-3.8-flash-tts (no host model pin), Charon, no style", () => {
    const gen = blog.audioGenerator;
    assert.ok(gen, "audioGenerator is wired");
    assert.equal(DEFAULT_GEMINI_MODEL, "gemini-3.8-flash-tts");
    assert.equal(gen.modelId, DEFAULT_GEMINI_MODEL);
    assert.equal(gen.voiceLabel, "Charon");
    assert.ok(isGemini38OrLaterTtsModel(gen.modelId));
    // The structured body, asking for headerless l16 at 24 kHz, and no
    // speech_metadata annotation: this host passes no `style`.
    const body = geminiTtsRequestBody({ model: gen.modelId, text: "Hello.", voice: gen.voiceLabel });
    assert.deepEqual(body, {
      model: "gemini-3.8-flash-tts",
      input: [{ type: "user_input", content: [{ type: "text", text: "Hello." }] }],
      response_format: { type: "audio", mime_type: "audio/l16", sample_rate: 24000 },
      generation_config: { speech_config: [{ voice: "Charon" }] },
    });
    assert.doesNotMatch(read("site.config.ts"), /gemini-2\.5-flash-preview-tts/);
    // The fallback must stay a different (voice, model) pair.
    const fb = blog.audioFallbackGenerator;
    assert.ok(fb);
    assert.notDeepEqual([fb.voiceLabel, fb.modelId], [gen.voiceLabel, gen.modelId]);
  });

  await ok("v1.158.0/v1.164.0/v1.166.0: derived brain-call ceiling stays 12 (1+5+3+3, no refresh, no meta, no mechanics)", () => {
    const l = brainCallLadder(siteConfig);
    assert.deepEqual(
      { s: l.strategist, d: l.draft, r: l.repair, g: l.regenerates, f: l.refresh, m: l.metaRewrite, x: l.mechanics },
      { s: 1, d: 5, r: 3, g: 3, f: 0, m: 0, x: 0 },
    );
    assert.equal(deriveBrainCallCeiling(siteConfig), 12);
    assert.equal(blog.quality.maxRegenerates, 1);
    assert.equal(blog.quality.mechanics.enabled, false);
  });

  await ok("v1.155.0/v1.156.0/v1.160.0: refresh off and posture publish_indexed, so the refresh-path changes are inert", () => {
    assert.equal(blog.cadence.refreshPerWeek, 0);
    assert.equal(blog.quality.posture, "publish_indexed");
  });

  await ok("v1.165.0: the article budget counts the Chicago day", () => {
    assert.equal(siteConfig.site.timezone, "America/Chicago");
    // 2026-10-17T01:05Z is the evening of Oct 16 in Chicago. At noon Chicago
    // on Oct 17 it must NOT count against Oct 17 (maxNewPerDay 1): due.
    const evening = new Date("2026-10-17T01:05:00Z");
    const noon = new Date("2026-10-17T17:00:00Z");
    assert.equal(isArticleDue(noon, [evening], blog.cadence, siteConfig.site.timezone), true);
    // Under the old UTC keying the same pair read "budget met".
    assert.equal(isArticleDue(noon, [evening], blog.cadence, "UTC"), false);
  });

  await ok("v1.158.2: every route graph registers the tables, and the registry is process-global", () => {
    assert.match(read("site.config.ts"), /^import "@\/lib\/db";$/m);
    const st = (globalThis as Record<symbol, { registry: Map<string, unknown> } | undefined>)[
      Symbol.for("@aicompany/core/db/client:process-state")
    ];
    assert.ok(st, "importing site.config created the shared registry");
    for (const key of ["pageVisits", "blogPosts", "blogAudio", "blogHeroImages", "reportedIssues"]) {
      assert.ok(st.registry.has(key), `${key} is registered`);
    }
  });

  console.log(`\n${passed} passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
