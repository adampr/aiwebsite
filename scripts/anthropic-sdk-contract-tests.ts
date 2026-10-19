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
 * Checked: one POST to /v1/messages?beta=true with the x-api-key header and
 * the fallback beta in anthropic-beta; the body fields the site sets
 * (stream true, model, max_tokens, output_config, fallbacks, system, the
 * document block before the text block, and no `betas` key leaking into the
 * body); an SSE stream with a fallback marker block and two text blocks maps
 * to the joined text; an unknown SSE event type does not break the stream;
 * a 413 surfaces as Anthropic.APIError and maps to "too_large" without a
 * retry. Added by the 2026-10-19 dependency round 2 (@anthropic-ai/sdk
 * 0.133.0 -> 0.135.0: 0.134.0 changed streaming event handling and added
 * OpenTelemetry tracing, 0.135.0 closes unread streams).
 */
import { isDeepStrictEqual } from "node:util";
import {
  VISION_FALLBACK_BETA,
  VISION_MAX_TOKENS,
  VISION_MODEL,
  VISION_SYSTEM_PROMPT,
  extractVisionText,
} from "../src/lib/rfp/vision-extract";

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

async function main() {
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.ANTHROPIC_API_KEY = "contract-test-not-a-key";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const h: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (h[k] = v));
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(String(init?.body ?? "{}")); } catch { body = { unparsed: true }; }
    calls.push({ url: String(input instanceof Request ? input.url : input), method: (init?.method ?? "GET").toUpperCase(), headers: h, body });
    return respond();
  }) as typeof fetch;
  const realWarn = console.warn;
  const warns: string[] = [];
  console.warn = (...a: unknown[]) => void warns.push(a.join(" "));
  try {
    const pdf = Buffer.from("%PDF-1.7\n% contract fixture\n");
    calls = [];
    respond = okStream;
    const ok = await extractVisionText({ name: "x.pdf", buf: pdf, mediaType: "application/pdf", budgetMs: 60_000, maxChars: 10_000 });
    check("success: joined text of both text blocks", ok, { ok: true, text: "Page one and page two.", truncated: false });
    check("one request", calls.length, 1);
    const c = calls[0];
    check("POST /v1/messages?beta=true", [c?.method, c?.url], ["POST", "https://api.anthropic.com/v1/messages?beta=true"]);
    check("x-api-key is the configured key", c?.headers["x-api-key"], "contract-test-not-a-key");
    check("anthropic-beta carries the fallback beta", (c?.headers["anthropic-beta"] ?? "").split(",").map((s) => s.trim()).includes(VISION_FALLBACK_BETA), true);
    check("body: stream, model, max_tokens, output_config, fallbacks", {
      stream: c?.body.stream, model: c?.body.model, max_tokens: c?.body.max_tokens, output_config: c?.body.output_config, fallbacks: c?.body.fallbacks,
    }, { stream: true, model: VISION_MODEL, max_tokens: VISION_MAX_TOKENS, output_config: { effort: "low" }, fallbacks: "default" });
    check("body: no betas key (it goes in the header)", "betas" in (c?.body ?? {}), false);
    check("body: system prompt", c?.body.system, VISION_SYSTEM_PROMPT);
    const content = ((c?.body.messages as { role: string; content: { type: string; source?: { type: string; media_type: string } }[] }[] | undefined) ?? [])[0];
    check("body: one user message, document block then text block", [content?.role, content?.content.map((b) => b.type), content?.content[0]?.source?.media_type], ["user", ["document", "text"], "application/pdf"]);

    calls = [];
    respond = () => new Response(JSON.stringify({ type: "error", error: { type: "request_too_large", message: "too big" } }), { status: 413, headers: { "content-type": "application/json", "request-id": "req_413" } });
    const big = await extractVisionText({ name: "x.pdf", buf: pdf, mediaType: "application/pdf", budgetMs: 60_000, maxChars: 10_000 });
    check("413: maps to too_large", big, { ok: false, reason: "too_large" });
    check("413: not retried", calls.length, 1);
    check("413: the log line names status and request id only", warns.at(-1), "[rfp] vision transcription failed: too_large status 413 request req_413");
  } finally {
    console.warn = realWarn;
  }
  console.log(failures === 0 ? "anthropic sdk contract: all checks passed" : `anthropic sdk contract: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
