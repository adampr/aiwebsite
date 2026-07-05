import { NextRequest, NextResponse } from "next/server";
import {
  BRAIN_INTERNAL_TOOLS_FALLBACK,
  TRON_NETTER_IDENTITY,
  TRON_NETTER_SYSTEM_PROMPT,
} from "@/lib/tron-netter/persona";
import { BRAIN_AUTH_HEADERS } from "@/lib/brain-client";

// Brain runs locally from the packages/brain submodule (loopback; since brain
// v1.91 it is fail-closed and requires the BRAIN_API_KEYS Bearer token — see
// src/lib/brain-client.ts for details).
const BRAIN_BASE_URL =
  process.env.BRAIN_BASE_URL || "http://127.0.0.1:3211";

// Every internal brain tool is disabled for the public chat (see persona.ts).
// The live list from GET /v1/tools covers tools added by future brain
// upgrades; cached per process, falling back to the v1.91 snapshot.
let disabledToolsCache: string[] | null = null;
async function getDisabledBrainTools(): Promise<string[]> {
  if (disabledToolsCache) return disabledToolsCache;
  try {
    const res = await fetch(`${BRAIN_BASE_URL}/v1/tools`, {
      headers: BRAIN_AUTH_HEADERS,
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const data = await res.json();
      const names = (data.tools ?? [])
        .map((t: { name?: string }) => t.name)
        .filter((n: unknown): n is string => typeof n === "string");
      if (names.length) {
        disabledToolsCache = names;
        return names;
      }
    }
  } catch {
    // fall through to the static snapshot
  }
  return BRAIN_INTERNAL_TOOLS_FALLBACK;
}

// Tron Netter has no tools by design: his knowledge is the public content of
// xl.net / ai.xl.net baked into the system prompt, and visitors must not be
// able to use him to browse the internet or fetch live data.
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

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...BRAIN_AUTH_HEADERS,
  };

  const envelope = {
    sessionId,
    promptId: `tron_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    messages: [
      { role: "system", content: TRON_NETTER_SYSTEM_PROMPT },
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

  const data = await brainRes.json();
  return NextResponse.json({
    answer:
      data.choices?.[0]?.message?.content ||
      "Sorry, I could not generate a response.",
    sessionId,
  });
}
