import { NextRequest, NextResponse } from "next/server";
import { CALLER_TOOLS, executeCallerTool } from "@/lib/tron-netter/tools";
import { BRAIN_AUTH_HEADERS } from "@/lib/brain-client";

// Brain runs locally from the packages/brain submodule (loopback; since brain
// v1.91 it is fail-closed and requires the BRAIN_API_KEYS Bearer token — see
// src/lib/brain-client.ts for details).
const BRAIN_BASE_URL =
  process.env.BRAIN_BASE_URL || "http://127.0.0.1:3211";

const TRON_NETTER_IDENTITY = {
  brainName: "Tron Netter",
  personality: "Friendly, knowledgeable, and professional",
  purpose:
    "Help visitors to ai.xl.net learn about XL.net's AI capabilities, managed IT services, and how artificial intelligence transforms IT operations for SMBs. Reachable by phone and SMS at (872) 350-4325 — Tron Netter's own AI voice line, the only phone number it ever gives out.",
  goals: [
    "Answer questions about XL.net's AI capabilities and services",
    "Be transparent about being an AI assistant",
    "Guide users to the right resources and contact information",
    "Never fabricate information — use tools to get accurate data",
  ],
  originStory:
    "Tron Netter is the AI assistant for ai.xl.net, XL.net's AI showcase website. XL.net is a Chicago-based managed IT services provider that leverages AI to deliver strategic IT for small and mid-size businesses.",
};

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

  const maxRounds = 5;
  const systemMessage = {
    role: "system",
    content:
      "You are Tron Netter, the AI assistant for ai.xl.net — XL.net's AI showcase website. " +
      "You have access to tools that contain information about XL.net and its AI capabilities. " +
      "You MUST call at least one tool before answering ANY question — even questions about yourself, " +
      "your company, or how you work. NEVER answer from memory or general knowledge alone.\n\n" +
      "Tool trigger topics (non-exhaustive): XL.net, AI capabilities, services, " +
      "company info, about us, contact details, certifications, service desk, security, analytics.\n\n" +
      'If the user asks about XL.net (the company, "you," "your"), call get_site_info. ' +
      "If they ask about AI features or capabilities, call get_ai_capabilities. " +
      "When uncertain which tool to use, call get_site_info as a default.\n\n" +
      "You have your own phone line: (872) 350-4325. People can call or text " +
      "it 24/7 and reach you (Tron Netter) directly. When asked how to reach " +
      "you by phone, give exactly that number — never any other number.\n\n" +
      "Keep responses concise, friendly, and professional.",
  };
  const currentMessages = [systemMessage, ...messages];
  const toolCallsExecuted: Array<{ name: string; result: unknown }> = [];

  for (let round = 0; round < maxRounds; round++) {
    const envelope = {
      sessionId,
      promptId: `tron_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      messages: currentMessages,
      tools: CALLER_TOOLS,
      toolPolicy: "required_first",
      memoryMode: "store_persistent",
      markdownMode: "html",
      brainIdentity: TRON_NETTER_IDENTITY,
      groupName: "aiwebsite",
    };

    const brainRes = await fetch(
      `${BRAIN_BASE_URL}/v1/chat/completions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(120_000),
      }
    );

    if (!brainRes.ok) {
      const errText = await brainRes.text().catch(() => "Unknown error");
      console.error(`[tron-netter] Brain API error ${brainRes.status}: ${errText}`);
      return NextResponse.json(
        { error: "Tron Netter is temporarily unavailable" },
        { status: 502 }
      );
    }

    const data = await brainRes.json();
    const choice = data.choices?.[0];
    if (!choice) {
      return NextResponse.json(
        { answer: "Sorry, I could not generate a response.", sessionId },
        { status: 200 }
      );
    }

    if (
      choice.finish_reason !== "tool_calls" ||
      !choice.message?.tool_calls?.length
    ) {
      if (toolCallsExecuted.length === 0 && round < maxRounds - 1) {
        currentMessages.push({
          role: "assistant",
          content: choice.message?.content || "",
        });
        currentMessages.push({
          role: "user",
          content:
            "You must call a tool before answering. If the question is about " +
            "XL.net, call get_site_info. If about AI capabilities, call " +
            "get_ai_capabilities. Please try again.",
        });
        continue;
      }
      return NextResponse.json({
        answer: choice.message?.content || "",
        sessionId,
      });
    }

    currentMessages.push({
      role: "assistant",
      content: choice.message.content || "",
      tool_calls: choice.message.tool_calls,
    });

    for (const tc of choice.message.tool_calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        args = {};
      }
      const result = await executeCallerTool(tc.function.name, args);
      toolCallsExecuted.push({ name: tc.function.name, result });
      currentMessages.push({
        role: "tool",
        content: JSON.stringify(result),
        tool_call_id: tc.id,
      });
    }
  }

  const finalRes = await fetch(`${BRAIN_BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      sessionId,
      promptId: `tron_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      messages: currentMessages,
      memoryMode: "store_persistent",
      markdownMode: "html",
      brainIdentity: TRON_NETTER_IDENTITY,
      groupName: "aiwebsite",
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!finalRes.ok) {
    return NextResponse.json(
      { error: "Tron Netter is temporarily unavailable" },
      { status: 502 }
    );
  }

  const finalData = await finalRes.json();
  return NextResponse.json({
    answer: finalData.choices?.[0]?.message?.content || "",
    sessionId,
  });
}
