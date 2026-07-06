import { NextRequest, NextResponse } from "next/server";
import {
  TRON_NETTER_IDENTITY,
  getTronNetterSystemPrompt,
} from "@/lib/tron-netter/persona";
import {
  BRAIN_AUTH_HEADERS,
  getDisabledBrainTools,
} from "@/lib/brain-client";

// Brain runs locally from the packages/brain submodule (loopback; since brain
// v1.91 it is fail-closed and requires the BRAIN_API_KEYS Bearer token — see
// src/lib/brain-client.ts for details).
const BRAIN_BASE_URL =
  process.env.BRAIN_BASE_URL || "http://127.0.0.1:3211";

const FALLBACK_ANSWER = "Sorry, I could not generate a response.";

// Brain v1.90+ streams the first-pass answer as NDJSON when asked via
// `Accept: application/x-ndjson`. We re-emit a reduced NDJSON stream to the
// widget — only `token` / `answer` / `done` / `error` — so internal events
// (phase_progress timings, model names) never reach the public site.
function makeWidgetStream(brainBody: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let sawDone = false;

  const emit = (
    controller: TransformStreamDefaultController<Uint8Array>,
    event: Record<string, unknown>
  ) => controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));

  const handleLine = (
    controller: TransformStreamDefaultController<Uint8Array>,
    line: string
  ) => {
    if (!line.trim()) return;
    let evt: { type?: string; text?: string; error?: string; choices?: Array<{ message?: { content?: string | null } }> };
    try {
      evt = JSON.parse(line);
    } catch {
      return;
    }
    if (evt.type === "token" && typeof evt.text === "string") {
      emit(controller, { type: "token", text: evt.text });
    } else if (evt.type === "answer_revised" && typeof evt.text === "string") {
      // The finalized answer diverged from the streamed draft — replace it.
      emit(controller, { type: "answer", text: evt.text });
    } else if (evt.type === "result") {
      const answer = evt.choices?.[0]?.message?.content;
      emit(controller, { type: "done", ...(typeof answer === "string" ? { answer } : {}) });
      sawDone = true;
    } else if (evt.type === "error") {
      emit(controller, { type: "error" });
      sawDone = true;
    }
  };

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) handleLine(controller, line);
    },
    flush(controller) {
      handleLine(controller, buffer);
      if (!sawDone) emit(controller, { type: "done" });
    },
  });

  return brainBody.pipeThrough(transform);
}

// Tron Netter has no tools by design: his knowledge is the public content of
// xl.net / ai.xl.net injected into the system prompt (refreshed nightly by
// scripts/refresh-tron-knowledge.mjs), and visitors must not be able to use
// him to browse the internet or fetch live data.
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { messages, sessionId } = body as {
    messages: Array<Record<string, unknown>>;
    sessionId: string;
  };

  if (!messages?.length || !sessionId) {
    return NextResponse.json(
      { error: "messages and sessionId are required" },
      { status: 400 }
    );
  }

  const wantsStream = request.headers.get("accept") === "application/x-ndjson";

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...BRAIN_AUTH_HEADERS,
    ...(wantsStream ? { Accept: "application/x-ndjson" } : {}),
  };

  const envelope = {
    sessionId,
    promptId: `tron_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    messages: [
      { role: "system", content: getTronNetterSystemPrompt() },
      ...messages,
    ],
    // do_not_store: the persona's knowledge is only the public site content
    // baked into the system prompt — visitor conversations must not teach it
    // new "facts" that get recalled over the prompt (known self-reinforcement
    // gotcha in the brain's memory extraction).
    memoryMode: "do_not_store",
    disabledTools: await getDisabledBrainTools(),
    markdownMode: "html",
    brainIdentity: TRON_NETTER_IDENTITY,
    groupName: "aiwebsite",
  };

  const brainRes = await fetch(`${BRAIN_BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(envelope),
    signal: AbortSignal.timeout(120_000),
  });

  if (!brainRes.ok) {
    const errText = await brainRes.text().catch(() => "Unknown error");
    console.error(`[tron-netter] Brain API error ${brainRes.status}: ${errText}`);
    return NextResponse.json(
      { error: "Tron Netter is temporarily unavailable" },
      { status: 502 }
    );
  }

  if (
    wantsStream &&
    brainRes.headers.get("content-type")?.includes("ndjson") &&
    brainRes.body
  ) {
    return new Response(makeWidgetStream(brainRes.body), {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-cache",
      },
    });
  }

  const data = await brainRes.json();
  return NextResponse.json({
    answer: data.choices?.[0]?.message?.content || FALLBACK_ANSWER,
    sessionId,
  });
}
