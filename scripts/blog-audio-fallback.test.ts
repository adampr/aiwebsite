// The article-audio BACKUP voice is Deepgram (module @aicompany/core v1.176.0,
// MIGRATIONS "Host adoption" step 4; owner decision 2026-11-12, "Test and
// switch now", "Deepgram, you pick"). OpenAI shuts down gpt-4o-mini-tts, this
// host's old fallback model, on 2027-01-06.
//
// Hermetic: no network, no real key, no database. `fetch` is replaced BEFORE
// site.config.ts is imported (the Deepgram seam captures `fetch` when it is
// built), DEEPGRAM_API_KEY is a dummy set or removed for the import, and the
// module's two database/encoder peers are mocked exactly as the module's own
// tests/blog-audio-deepgram.test.ts mocks them. The PRIMARY is a fake that
// refuses one chunk, so the module's real failover (runAudioHook) decides
// whether the host's configured fallback is reached.
//
// Run: npm run test:audiofallback (vitest; vitest.config.ts includes this file only).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

vi.mock("../packages/aicompany/src/blog/queries", () => ({
  getAudioMeta: vi.fn(async () => null),
  audioCharsThisMonth: vi.fn(async () => 0),
  audioStorageStats: vi.fn(async () => ({ files: 0, bytes: 0, staleFiles: 0, staleBytes: 0 })),
  markAudioStale: vi.fn(async () => {}),
}));
vi.mock("../packages/aicompany/src/blog/audio-dsp", () => ({
  loadEncoder: vi.fn(async () => ({})),
  joinChunks: vi.fn(() => ({
    samples: new Float32Array(24_000),
    chapters: [],
    maxDcOffset: 0,
    maxDcOffsetAllChunks: 0,
    maxDcChunk: null,
  })),
  integratedLoudness: vi.fn(() => ({ lufs: -19 })),
  contentGate: vi.fn(() => ({ ok: true, problems: [] })),
  encodeMp3: vi.fn(async () => ({
    mp3: Buffer.alloc(2048),
    durationSec: 61,
    limiterReducedPct: 0,
    limiterMaxReductionDb: 0,
  })),
  buildId3: vi.fn(() => Buffer.alloc(10)),
}));

import { newAudioRunState, runAudioHook } from "@aicompany/core/blog/audio";
import { TtsSynthesisError } from "@aicompany/core/blog/audio-tts";
import type { ArticleDoc, SiteConfig } from "@aicompany/core/config/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VOICE = "aura-2-orpheus-en";
const DUMMY_KEY = "dg-host-test-dummy-key-0000";
const DEEPGRAM_SPEAK = "https://api.deepgram.com/v1/speak";
const TLDR_SPOKEN = "In short.";

type Call = { url: string; init: RequestInit };

/** Replace global fetch with a recorder answering Deepgram's measured reply
 *  shape (headerless s16le, `audio/l16;rate=24000`), or an error status. */
function stubFetch(status = 200): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (status !== 200) {
        return new Response(JSON.stringify({ err_code: "INVALID_AUTH", err_msg: "Invalid credentials." }), {
          status,
          headers: { "content-type": "application/json" },
        });
      }
      const { text } = JSON.parse(String(init?.body ?? "{}")) as { text: string };
      const bytes = new Uint8Array(Math.ceil(text.length / 14) * 24_000 * 2);
      return new Response(bytes.buffer as ArrayBuffer, {
        status: 200,
        headers: { "content-type": "audio/l16;rate=24000" },
      });
    }),
  );
  return calls;
}

/** Import site.config.ts afresh with DEEPGRAM_API_KEY set to `key` (or unset). */
async function loadSiteConfig(key: string | undefined): Promise<SiteConfig> {
  vi.resetModules();
  if (key === undefined) delete process.env.DEEPGRAM_API_KEY;
  else process.env.DEEPGRAM_API_KEY = key;
  const mod = (await import("../site.config")) as { default?: SiteConfig; siteConfig?: SiteConfig };
  const cfg = mod.default ?? mod.siteConfig;
  if (!cfg) throw new Error("site.config.ts exports no config");
  return cfg;
}

/** A primary that renders every chunk except the spoken TL;DR label, which it
 *  refuses with the non-retried 400 class — the case the failover carries. */
function refusingPrimary(seen: string[]) {
  return {
    voiceLabel: "Charon",
    modelId: "gemini-3.8-flash-tts",
    async synthesize({ text }: { text: string }) {
      seen.push(text);
      if (text === TLDR_SPOKEN) {
        throw new TtsSynthesisError({
          ttsFailureClass: "bad-request",
          message: "Gemini TTS 400: Model tried to generate text",
          text,
          vendorModel: "gemini-3.8-flash-tts",
        });
      }
      return { pcm: Buffer.alloc(Math.ceil(text.length / 14) * 24_000 * 2), sampleRateHz: 24_000 };
    },
  };
}

const doc: ArticleDoc = {
  title: "What changed in AI this week",
  metaDescription: "What changes and what it costs.",
  tldr: { answer: "Most stalls start in the first minute.", takeaways: ["Ask first", "Then listen"] },
  sections: [{ heading: "The stall", anchor: "the-stall", body: ["Reps pitch before they ask."] }],
  faq: [{ q: "How often?", a: "Weekly." }],
  primaryKeyword: "discovery calls",
  tags: ["sales"],
};

/** The module test's minimal blog config, with THIS host's configured
 *  fallback object plugged in and a fake primary. */
function runConfig(primary: unknown, fallback: unknown): SiteConfig {
  return {
    site: { name: "XL AI", slug: "aiwebsite", baseUrl: "https://example.test", timezone: "UTC" },
    blog: {
      enabled: true,
      types: [{ key: "news", label: "AI News", urlPrefix: "/blog" }],
      copy: { tldrHeading: "TL;DR", faqHeading: "Frequently asked questions" },
      authorship: { entityName: "Example Editorial", disclosure: "Written with AI assistance." },
      audioGenerator: primary,
      audioFallbackGenerator: fallback,
      audio: {
        enabled: true,
        disclosure: "This article is narrated by an AI voice.",
        outroTemplate: "That was {{title}}, from {{site}}. Read it at {{url}}.",
        ctaLine: "",
        pronunciations: {},
        podcast: { enabled: false },
        player: {},
        maxCharsPerArticle: 100_000,
        maxCharsPerRun: 400_000,
        maxCharsPerMonth: 4_000_000,
        storageSoftCapMb: 5_000,
        bitrateKbps: 48,
        sampleRateHz: 24_000,
        targetLufs: -19,
        peakCeilingDb: -1,
        renderBudgetMs: 240_000,
        routePath: "/blog/audio",
        chunkMaxCharsPerSec: 25,
        chunkGuardMinChars: 40,
      },
    },
  } as unknown as SiteConfig;
}

async function narrate(cfg: SiteConfig, primarySeen: string[], puts: { voice: string; modelId: string }[]) {
  const lines: string[] = [];
  const state = newAudioRunState();
  const res = await runAudioHook(runConfig(refusingPrimary(primarySeen), cfg.blog.audioFallbackGenerator), {
    slug: "a",
    type: "news",
    doc,
    lines,
    state,
    phase: "A",
    targeted: false,
    deps: {
      storage: {
        put: async (f: { voice: string; modelId: string }) => {
          puts.push({ voice: f.voice, modelId: f.modelId });
          return { url: "/blog/audio/a.mp3?v=abc" };
        },
      } as never,
      sleep: async () => {},
    },
  });
  return { res, lines, state };
}

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const DUMMY_GEMINI_KEY = "gm-host-test-dummy-key-0000";

/** Replace global fetch with one stub for BOTH configured seams, routed by
 *  URL: the Gemini primary renders every chunk except the spoken TL;DR label,
 *  which it refuses with Gemini's 400 (the non-retried bad-request class);
 *  Deepgram answers as stubFetch() does. Nothing reaches the network. */
function configuredPrimaryFetch(): { gemini: Call[]; deepgram: Call[]; other: Call[] } {
  const seen = { gemini: [] as Call[], deepgram: [] as Call[], other: [] as Call[] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u === GEMINI_ENDPOINT) {
        seen.gemini.push({ url: u, init: init ?? {} });
        const body = JSON.parse(String(init?.body ?? "{}")) as { input?: { content?: { text?: string }[] }[] | string };
        const text = typeof body.input === "string" ? body.input : (body.input?.[0]?.content?.[0]?.text ?? "");
        if (text === TLDR_SPOKEN) {
          return new Response(
            JSON.stringify({ error: { code: 400, message: "Model tried to generate text", status: "INVALID_ARGUMENT" } }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }
        const pcm = Buffer.alloc(Math.ceil(text.length / 14) * 24_000 * 2);
        return new Response(
          JSON.stringify({ output_audio: { type: "audio", mime_type: "audio/l16", sample_rate: 24_000, data: pcm.toString("base64") } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (u.startsWith(DEEPGRAM_SPEAK)) {
        seen.deepgram.push({ url: u, init: init ?? {} });
        const { text } = JSON.parse(String(init?.body ?? "{}")) as { text: string };
        const bytes = new Uint8Array(Math.ceil(text.length / 14) * 24_000 * 2);
        return new Response(bytes.buffer as ArrayBuffer, { status: 200, headers: { "content-type": "audio/l16;rate=24000" } });
      }
      seen.other.push({ url: u, init: init ?? {} });
      return new Response("unexpected request in a hermetic test", { status: 599 });
    }),
  );
  return seen;
}

let savedKey: string | undefined;
let savedGeminiKey: string | undefined;
let logged: string[];
beforeEach(() => {
  savedKey = process.env.DEEPGRAM_API_KEY;
  savedGeminiKey = process.env.GOOGLE_GEMINI_API_KEY;
  logged = [];
  for (const m of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      logged.push(a.map(String).join(" "));
    });
  }
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.DEEPGRAM_API_KEY;
  else process.env.DEEPGRAM_API_KEY = savedKey;
  if (savedGeminiKey === undefined) delete process.env.GOOGLE_GEMINI_API_KEY;
  else process.env.GOOGLE_GEMINI_API_KEY = savedGeminiKey;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("site.config.ts wires Deepgram as the article-audio fallback (module v1.176.0 step 4)", () => {
  it("the fallback is the Deepgram seam with this host's voice; the primary is unchanged", async () => {
    stubFetch();
    const cfg = await loadSiteConfig(DUMMY_KEY);
    const fb = cfg.blog.audioFallbackGenerator!;
    expect(fb.voiceLabel).toBe(VOICE);
    expect(fb.modelId).toBe(VOICE);
    const primary = cfg.blog.audioGenerator!;
    expect(primary.voiceLabel).toBe("Charon");
    expect(primary.modelId).toBe("gemini-3.8-flash-tts");
  });

  it("the source names the module factory, the voice and the key from the environment", () => {
    const src = readFileSync(path.join(ROOT, "site.config.ts"), "utf8");
    const at = src.indexOf("audioFallbackGenerator:");
    expect(at).toBeGreaterThan(0);
    const block = src.slice(at, src.indexOf("})", at) + 2);
    expect(block).toMatch(/createDeepgramTtsSynthesizer\(\{/);
    expect(block).toMatch(/apiKey:\s*process\.env\.DEEPGRAM_API_KEY\b/);
    expect(block).toContain(`voice: "${VOICE}"`);
    expect(src).not.toMatch(/createOpenAiTtsSynthesizer/);
  });

  it("a primary refusal fails the article over to Deepgram: every chunk goes there, the row names orpheus", async () => {
    const calls = stubFetch();
    const cfg = await loadSiteConfig(DUMMY_KEY);
    const seen: string[] = [];
    const puts: { voice: string; modelId: string }[] = [];
    const { res, lines, state } = await narrate(cfg, seen, puts);

    expect(seen).toContain(TLDR_SPOKEN);
    expect(state.fallbackRenders).toHaveLength(1);
    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls) {
      const u = new URL(c.url);
      expect(`${u.origin}${u.pathname}`).toBe(DEEPGRAM_SPEAK);
      expect(u.searchParams.get("model")).toBe(VOICE);
      // The key reaches the vendor from the environment, in the header only.
      expect((c.init.headers as Record<string, string>).Authorization).toBe(`Token ${DUMMY_KEY}`);
    }
    const sent = calls.map((c) => (JSON.parse(String(c.init.body)) as { text: string }).text);
    expect(sent).toContain(TLDR_SPOKEN);
    expect(puts).toEqual([{ voice: VOICE, modelId: VOICE }]);
    expect(lines.join("\n")).toContain("fallback seam");
    expect(res.warn).toBe(false);
    // The key appears in no report line and no console line.
    expect(lines.join("\n")).not.toContain(DUMMY_KEY);
    expect(logged.join("\n")).not.toContain(DUMMY_KEY);
  });

  it("no DEEPGRAM_API_KEY: the fallback declines without a request and the article publishes silent (warns)", async () => {
    const calls = stubFetch();
    const cfg = await loadSiteConfig(undefined);
    const seen: string[] = [];
    const puts: { voice: string; modelId: string }[] = [];
    const { res, lines } = await narrate(cfg, seen, puts);

    expect(seen).toContain(TLDR_SPOKEN);
    expect(calls).toHaveLength(0);
    expect(puts).toHaveLength(0);
    expect(res.warn).toBe(true);
    const out = lines.join("\n");
    expect(out).toContain("The fallback seam returned null");
    expect(logged.join("\n")).toContain("no Deepgram API key");
  });

  it("a Deepgram refusal (401) carries no key into any line, log or error", async () => {
    const calls = stubFetch(401);
    const cfg = await loadSiteConfig(DUMMY_KEY);
    const fb = cfg.blog.audioFallbackGenerator!;
    const err = await fb.synthesize({ text: "Ask first.", index: 0, total: 1, slug: "a" }).then(
      () => null,
      (e: unknown) => e,
    );
    // site.config.ts was imported after vi.resetModules(), so its seam throws
    // the class from a FRESH module instance: compare by name and class field.
    expect((err as Error | null)?.name).toBe("TtsSynthesisError");
    expect((err as TtsSynthesisError).ttsFailureClass).toBe("auth");
    for (const field of [(err as Error).message, (err as Error).stack ?? "", JSON.stringify(err)]) {
      expect(field).not.toContain(DUMMY_KEY);
    }
    expect(calls).toHaveLength(1);

    const seen: string[] = [];
    const puts: { voice: string; modelId: string }[] = [];
    const { lines, res } = await narrate(cfg, seen, puts);
    expect(res.warn).toBe(true);
    expect(puts).toHaveLength(0);
    expect(lines.join("\n")).not.toContain(DUMMY_KEY);
    expect(logged.join("\n")).not.toContain(DUMMY_KEY);
  });

  // R2a finding I1: the arms above inject their OWN refusing primary, so a
  // wrapper in site.config.ts around the CONFIGURED primary that swallowed
  // its refusals would pass them. This arm runs both generators exactly as
  // site.config.ts exports them; only fetch is stubbed (dummy keys, no network).
  it("the CONFIGURED primary's refusal reaches the Deepgram fallback (no host wrapper swallows it)", async () => {
    const seen = configuredPrimaryFetch();
    process.env.GOOGLE_GEMINI_API_KEY = DUMMY_GEMINI_KEY;
    const cfg = await loadSiteConfig(DUMMY_KEY);
    const lines: string[] = [];
    const state = newAudioRunState();
    const puts: { voice: string; modelId: string }[] = [];
    const res = await runAudioHook(runConfig(cfg.blog.audioGenerator, cfg.blog.audioFallbackGenerator), {
      slug: "a",
      type: "news",
      doc,
      lines,
      state,
      phase: "A",
      targeted: false,
      deps: {
        storage: {
          put: async (f: { voice: string; modelId: string }) => {
            puts.push({ voice: f.voice, modelId: f.modelId });
            return { url: "/blog/audio/a.mp3?v=abc" };
          },
        } as never,
        sleep: async () => {},
      },
    });

    const geminiTexts = seen.gemini.map((c) => {
      const b = JSON.parse(String(c.init.body)) as { input?: { content?: { text?: string }[] }[] | string };
      return typeof b.input === "string" ? b.input : (b.input?.[0]?.content?.[0]?.text ?? "");
    });
    expect(seen.other).toEqual([]);
    expect(geminiTexts).toContain(TLDR_SPOKEN);
    expect(state.fallbackRenders).toHaveLength(1);
    expect(seen.deepgram.length).toBeGreaterThan(1);
    const sent = seen.deepgram.map((c) => (JSON.parse(String(c.init.body)) as { text: string }).text);
    expect(sent).toContain(TLDR_SPOKEN);
    expect(puts).toEqual([{ voice: VOICE, modelId: VOICE }]);
    expect(res.warn).toBe(false);
    for (const k of [DUMMY_KEY, DUMMY_GEMINI_KEY]) {
      expect(lines.join("\n")).not.toContain(k);
      expect(logged.join("\n")).not.toContain(k);
    }
  });
});
