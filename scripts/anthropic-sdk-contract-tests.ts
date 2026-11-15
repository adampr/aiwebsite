/**
 * Anthropic SDK contract tests (ARCHITECTURE.md §5.17.18 vision intake).
 *
 *   npm run test:anthropicsdk
 *
 * Pure, no network, no real key: global fetch is stubbed and
 * ANTHROPIC_API_KEY is set in-process to a fake value. Unlike
 * test:rfpvision (which injects the stream boundary), this drives the REAL
 * SDK path, src/lib/rfp/vision-extract.ts sendViaSdk, through
 * extractVisionText with no `send` injected:
 *   client.beta.messages.stream({ model, max_tokens, output_config: { effort },
 *     betas: [VISION_FALLBACK_BETA], fallbacks: "default", system, messages },
 *     { timeout, signal }).finalMessage()
 * Checked: one POST to /v1/messages carrying the key as
 * `Authorization: Bearer <key>` (no x-api-key), anthropic-version 2026-10-21
 * and the fallback beta in anthropic-beta, with the explicit apiKey winning
 * over an ANTHROPIC_AUTH_TOKEN in the environment; the body fields the site sets
 * (stream true, model, max_tokens, output_config, fallbacks, system, the
 * document block before the text block, and no `betas` key leaking into the
 * body); an SSE stream with a fallback marker block and two text blocks maps
 * to the joined text; an unknown SSE event type does not break the stream;
 * a 413 surfaces as Anthropic.APIError and maps to "too_large" without a
 * retry. Added by the 2026-10-19 dependency round 2 (@anthropic-ai/sdk
 * 0.133.0 -> 0.135.0: 0.134.0 changed streaming event handling and added
 * OpenTelemetry tracing, 0.135.0 closes unread streams). Updated by the
 * 2026-10-24 round (0.135.0 -> 1.3.0, API version 2023-06-01 -> 2026-10-21):
 * 1.0.0 sends the API key as `Authorization: Bearer` instead of X-Api-Key and
 * makes a client hold one credential; 1.3.0 stops sending the hard-coded
 * `?beta=true` query (the beta route is chosen by the anthropic-beta header).
 *
 * The timeout arms (rewritten 2026-11-15 after the R2a refute, finding B1).
 * Until then this script exited 0 WITHOUT reaching its timeout checks or its
 * summary. Cause, read in @anthropic-ai/sdk 1.8.0 (client.js): the client
 * stores `this.fetch = options.fetch ?? getDefaultFetch()` (the global fetch
 * AT CONSTRUCTION), and vision-extract.ts caches one client for the process
 * (`client ??= new Anthropic(...)`). The client was built in the first arm, so
 * the timeout arm's replacement `globalThis.fetch` was never called: the first
 * stub answered with a body stream that never produces, the 10 s budget timer
 * fired and aborted, the SDK's SSE reader kept waiting on a stream that knows
 * nothing of the abort, and with no timer left Node ran out of work and exited
 * 0 with main() still pending. Now: (1) ONE dispatcher fetch is installed
 * before the first call and every arm swaps the handler behind it, so the
 * cached client always reaches the arm's own stub; (2) the timeout arms run on
 * a virtual clock (setTimeout/clearTimeout replaced for the arm only), so the
 * 10 s budget costs no wall time and the order of the budget timer and the
 * SDK's own timer is decided, not raced; (3) scripts/lib/summary-guard.ts
 * turns any exit before the summary into exit 1 naming the unfinished step.
 *
 * What the timeout arms pin, and what they do not:
 *  - Arm 1 (the budget runs out first, as in production: the budget timer is
 *    armed before the SDK's own timer, both at the same budget): the SDK call
 *    gets the budget's signal (the call settles the moment the budget fires,
 *    with ONE request and no retry), and the final reason is "timeout". It
 *    does NOT tell apart extractVisionText's `aborted` shortcut from the
 *    SDK's APIUserAbortError mapping: with the signal aborted either one
 *    alone gives "timeout".
 *  - Arm 2 (the SDK's own timeout, budget timer held back): the SDK retries
 *    twice and throws APIConnectionTimeoutError with the budget's signal NOT
 *    aborted, so only the instanceof mapping can produce "timeout". This is
 *    the SDK error-class mapping through the real SDK (the 1.5.0/1.6.0 error
 *    class changes). In production the budget timer, armed first, normally
 *    wins; this arm pins the mapping, not a production ordering.
 *  - The unit checks on visionErrorReason pin the `aborted` shortcut (an error
 *    of no SDK class after the budget's abort is still "timeout") and the
 *    APIUserAbortError branch, which the SDK path cannot isolate (the SDK
 *    raises APIUserAbortError only when the signal is aborted).
 * Not pinned: real sockets (undici aborting a live body), wall-clock timing.
 */
import { isDeepStrictEqual } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import {
  VISION_FALLBACK_BETA,
  VISION_MAX_TOKENS,
  VISION_MIN_CALL_MS,
  VISION_MODEL,
  VISION_SYSTEM_PROMPT,
  extractVisionText,
  visionErrorReason,
  type VisionResult,
} from "../src/lib/rfp/vision-extract";
import { summaryGuard } from "./lib/summary-guard";

const guard = summaryGuard("anthropic sdk contract");
let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = isDeepStrictEqual(actual, expected);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `\n     got  ${JSON.stringify(actual)}\n     want ${JSON.stringify(expected)}`}`);
}

type Call = { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> };
let calls: Call[] = [];
let respond: () => Response = () => new Response("unset", { status: 500 });

function sse(events: { event: string; data: unknown }[]): Response {
  const text = events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join("");
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req_contract" } });
}

const message = { id: "msg_1", type: "message", role: "assistant", model: VISION_MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } };
const okStream = () =>
  sse([
    { event: "message_start", data: { type: "message_start", message } },
    { event: "ping", data: { type: "ping" } },
    { event: "some_future_event", data: { type: "some_future_event", detail: 1 } },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Page one " } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { event: "content_block_start", data: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "and page two." } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 1 } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 7 } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ]);

type FetchHandler = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
// The SDK client captures the global fetch once, at construction, and
// vision-extract.ts keeps that client for the process: so the global fetch is
// installed ONCE, as a dispatcher, and each arm swaps `handler` behind it.
let handler: FetchHandler = async () => {
  throw new Error("no fetch handler set for this arm (the contract test never reaches the network)");
};
const dispatcherFetch = ((input: string | URL | Request, init?: RequestInit) => handler(input, init)) as typeof fetch;

/** A fetch that never answers and rejects when its signal aborts, as undici does. */
function hangUntilAborted(counter: { n: number }): FetchHandler {
  return (_input, init) =>
    new Promise<Response>((_, reject) => {
      counter.n++;
      const signal = init?.signal;
      if (!signal) return; // no signal: nothing can end it (a broken call shape)
      signal.addEventListener("abort", () => reject(signal.reason ?? new DOMException("aborted", "AbortError")), { once: true });
    });
}

type VTimer = { id: number; due: number; ms: number; run: () => void };
/**
 * A virtual clock for one arm: setTimeout/clearTimeout are replaced until
 * uninstall(); setImmediate (used to let promise chains run) is not. Nothing
 * fires unless the arm fires it.
 */
function installVirtualClock() {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  let now = 0;
  let seq = 0;
  const timers = new Map<number, VTimer>();
  const idOf = (h: unknown) => (typeof h === "object" && h !== null && "vid" in h ? (h as { vid: number }).vid : Number(h));
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const id = ++seq;
    const delay = Math.max(0, Number(ms ?? 0));
    timers.set(id, { id, due: now + delay, ms: delay, run: () => fn(...args) });
    const handle: Record<string | symbol, unknown> = { vid: id, ref: () => handle, unref: () => handle, hasRef: () => false, refresh: () => handle, [Symbol.toPrimitive]: () => id };
    return handle;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((h: unknown) => void timers.delete(idOf(h))) as typeof clearTimeout;
  const drain = async (turns = 10) => {
    for (let i = 0; i < turns; i++) await new Promise<void>((r) => setImmediate(r));
  };
  return {
    pending: () => [...timers.values()].sort((a, b) => a.due - b.due || a.id - b.id),
    drain,
    /** Fire the earliest timer that passes `pick`, then let promise chains run. */
    async fireNext(pick: (t: VTimer) => boolean = () => true): Promise<VTimer | null> {
      const t = [...timers.values()].filter(pick).sort((a, b) => a.due - b.due || a.id - b.id)[0];
      if (!t) return null;
      timers.delete(t.id);
      now = Math.max(now, t.due);
      t.run();
      await drain();
      return t;
    },
    /** Fire, in order, every timer due at or before `until`, including ones armed meanwhile. */
    async runUntil(until: number) {
      for (;;) {
        const t = [...timers.values()].filter((x) => x.due <= until).sort((a, b) => a.due - b.due || a.id - b.id)[0];
        if (!t) break;
        timers.delete(t.id);
        now = t.due;
        t.run();
        await drain();
      }
      now = Math.max(now, until);
    },
    uninstall() {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    },
  };
}

async function main() {
  delete process.env.ANTHROPIC_BASE_URL;
  // A token in the environment must be ignored: vision-extract passes apiKey
  // explicitly, and since 1.0.0 the credential you pass is the only one.
  process.env.ANTHROPIC_AUTH_TOKEN = "contract-test-not-a-token";
  delete process.env.ANTHROPIC_PROFILE;
  process.env.ANTHROPIC_API_KEY = "contract-test-not-a-key";
  globalThis.fetch = dispatcherFetch;
  const recording: FetchHandler = async (input, init) => {
    const h: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (h[k] = v));
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(String(init?.body ?? "{}")); } catch { body = { unparsed: true }; }
    calls.push({ url: String(input instanceof Request ? input.url : input), method: (init?.method ?? "GET").toUpperCase(), headers: h, body });
    return respond();
  };
  handler = recording;
  const realWarn = console.warn;
  const warns: string[] = [];
  console.warn = (...a: unknown[]) => void warns.push(a.join(" "));
  try {
    const pdf = Buffer.from("%PDF-1.7\n% contract fixture\n");
    guard.step("success arm (an SSE stream with two text blocks)");
    calls = [];
    respond = okStream;
    const ok = await extractVisionText({ name: "x.pdf", buf: pdf, mediaType: "application/pdf", budgetMs: 60_000, maxChars: 10_000 });
    check("success: joined text of both text blocks", ok, { ok: true, text: "Page one and page two.", truncated: false });
    check("one request", calls.length, 1);
    const c = calls[0];
    check("POST /v1/messages", [c?.method, c?.url], ["POST", "https://api.anthropic.com/v1/messages"]);
    check("authorization is Bearer <the configured key>, not the env token", c?.headers["authorization"], "Bearer contract-test-not-a-key");
    check("no x-api-key header", c?.headers["x-api-key"], undefined);
    check("anthropic-version is 2026-10-21", c?.headers["anthropic-version"], "2026-10-21");
    check("anthropic-beta carries the fallback beta", (c?.headers["anthropic-beta"] ?? "").split(",").map((s) => s.trim()).includes(VISION_FALLBACK_BETA), true);
    check("body: stream, model, max_tokens, output_config, fallbacks", {
      stream: c?.body.stream, model: c?.body.model, max_tokens: c?.body.max_tokens, output_config: c?.body.output_config, fallbacks: c?.body.fallbacks,
    }, { stream: true, model: VISION_MODEL, max_tokens: VISION_MAX_TOKENS, output_config: { effort: "low" }, fallbacks: "default" });
    check("body: no betas key (it goes in the header)", "betas" in (c?.body ?? {}), false);
    check("body: system prompt", c?.body.system, VISION_SYSTEM_PROMPT);
    const content = ((c?.body.messages as { role: string; content: { type: string; source?: { type: string; media_type: string } }[] }[] | undefined) ?? [])[0];
    check("body: one user message, document block then text block", [content?.role, content?.content.map((b) => b.type), content?.content[0]?.source?.media_type], ["user", ["document", "text"], "application/pdf"]);

    guard.step("413 arm");
    calls = [];
    respond = () => new Response(JSON.stringify({ type: "error", error: { type: "request_too_large", message: "too big" } }), { status: 413, headers: { "content-type": "application/json", "request-id": "req_413" } });
    const big = await extractVisionText({ name: "x.pdf", buf: pdf, mediaType: "application/pdf", budgetMs: 60_000, maxChars: 10_000 });
    check("413: maps to too_large", big, { ok: false, reason: "too_large" });
    check("413: not retried", calls.length, 1);
    check("413: the log line names status and request id only", warns.at(-1), "[rfp] vision transcription failed: too_large status 413 request req_413");

    // 1.5.0 (@anthropic-ai/sdk 1.3.0 -> 1.8.0 round, 2026-11-15) adds one error
    // class per HTTP status and error code, every one a subclass of APIError;
    // 1.6.0 sets each error's `name` to its class. visionErrorReason maps by
    // `instanceof` and never reads `name`: an overloaded 529 must still read as
    // api_error, after the SDK's own retries (retry-after-ms 0 keeps it fast).
    guard.step("529 arm");
    calls = [];
    respond = () => new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "busy" } }), { status: 529, headers: { "content-type": "application/json", "request-id": "req_529", "retry-after-ms": "0" } });
    const busy = await extractVisionText({ name: "x.pdf", buf: pdf, mediaType: "application/pdf", budgetMs: 60_000, maxChars: 10_000 });
    check("529: maps to api_error (an APIError subclass, read by instanceof)", busy, { ok: false, reason: "api_error" });
    check("529: the SDK's default retries ran (1 + 2 attempts)", calls.length, 3);
    check("529: the log line names status and request id only", warns.at(-1), "[rfp] vision transcription failed: api_error status 529 request req_529");

    // Timeout arm 1: the budget runs out before the first byte. The budget is
    // exactly VISION_MIN_CALL_MS (10 s): anything smaller is refused before any
    // request (extractVisionText's own floor), which would not exercise the
    // SDK's abort path at all. Virtual clock: no wall time, a decided order.
    guard.step("timeout arm 1 (the budget runs out before the first byte)");
    {
      const sent = { n: 0 };
      handler = hangUntilAborted(sent);
      const clock = installVirtualClock();
      try {
        let slow: VisionResult | undefined;
        const p = extractVisionText({ name: "x.pdf", buf: pdf, mediaType: "application/pdf", budgetMs: VISION_MIN_CALL_MS, maxChars: 10_000 }).then((r) => (slow = r));
        check("timeout 1: the budget timer is armed before the request (one timer, the budget)", clock.pending().map((t) => t.ms), [VISION_MIN_CALL_MS]);
        for (let i = 0; i < 500 && sent.n === 0; i++) await clock.drain(1); // until the request is out
        await clock.drain();
        check("timeout 1: the request was sent through this arm's fetch (the SDK's abort path, not the pre-request floor)", sent.n, 1);
        check("timeout 1: nothing settles before the budget runs out", slow, undefined);
        await clock.runUntil(VISION_MIN_CALL_MS);
        check("timeout 1: the call settles the moment the budget runs out (the SDK call is given the budget's signal)", slow !== undefined, true);
        check("timeout 1: budget exhausted before the first byte maps to timeout", slow, { ok: false, reason: "timeout" });
        check("timeout 1: the budget's abort is not retried (one request)", sent.n, 1);
        check("timeout 1: the log line names the reason and no status (an SDK abort error has none), nothing else", warns.at(-1), "[rfp] vision transcription failed: timeout status none");
        check("timeout 1: no timer left behind", clock.pending().length, 0);
        if (slow !== undefined) await p;
      } finally {
        clock.uninstall();
      }
    }

    // Timeout arm 2: the SDK's own timeout fires and the budget timer is held
    // back, so the budget's signal is NOT aborted and only the error-class
    // mapping (APIConnectionTimeoutError -> timeout) can give "timeout".
    guard.step("timeout arm 2 (the SDK's own timeout, the budget timer held back)");
    {
      const sent = { n: 0 };
      handler = hangUntilAborted(sent);
      const clock = installVirtualClock();
      try {
        let slow: VisionResult | undefined;
        const p = extractVisionText({ name: "x.pdf", buf: pdf, mediaType: "application/pdf", budgetMs: VISION_MIN_CALL_MS, maxChars: 10_000 }).then((r) => (slow = r));
        const budget = clock.pending()[0];
        check("timeout 2: the budget timer is armed before the request", budget?.ms, VISION_MIN_CALL_MS);
        for (let i = 0; i < 500 && sent.n === 0; i++) await clock.drain(1); // until the request is out
        await clock.drain();
        // Fire the SDK's timers (its request timeout, its retry sleeps) in
        // order; never the budget's. A retry arms its next timer a few turns
        // later, so an empty pick waits a turn rather than giving up.
        let fired = 0;
        let idle = 0;
        while (slow === undefined && fired < 20 && idle < 500) {
          if (await clock.fireNext((t) => t.id !== budget?.id)) {
            fired++;
            idle = 0;
          } else {
            idle++;
            await clock.drain(1);
          }
        }
        check("timeout 2: the call settles on the SDK's own timers alone", slow !== undefined, true);
        check("timeout 2: the SDK's APIConnectionTimeoutError maps to timeout (by class)", slow, { ok: false, reason: "timeout" });
        check("timeout 2: the SDK's default retries ran on its own timeout (1 + 2 attempts)", sent.n, 3);
        check("timeout 2: the log line names the reason and no status, nothing else", warns.at(-1), "[rfp] vision transcription failed: timeout status none");
        check("timeout 2: the held budget timer was cleared, never fired", clock.pending().length, 0);
        if (slow !== undefined) await p;
      } finally {
        clock.uninstall();
      }
    }
    handler = recording;

    // The two branches the SDK path cannot isolate, on the exported mapping:
    // the `aborted` shortcut (after the budget's abort, an error of no SDK
    // class is still a timeout) and the APIUserAbortError class.
    guard.step("visionErrorReason unit checks");
    check("reason: any error after the budget's abort is a timeout (the aborted shortcut)", visionErrorReason(new TypeError("terminated"), true), "timeout");
    check("reason: the same error with the budget intact is an api_error", visionErrorReason(new TypeError("terminated"), false), "api_error");
    check("reason: APIUserAbortError maps to timeout by class", visionErrorReason(new Anthropic.APIUserAbortError(), false), "timeout");
    check("reason: APIConnectionTimeoutError maps to timeout by class", visionErrorReason(new Anthropic.APIConnectionTimeoutError(), false), "timeout");
  } finally {
    console.warn = realWarn;
  }
  guard.reached();
  console.log(failures === 0 ? "anthropic sdk contract: all checks passed" : `anthropic sdk contract: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
