import crypto from "node:crypto";
import { NextRequest, NextResponse, after } from "next/server";
import {
  TRON_NETTER_IDENTITY,
  getTronNetterSystemPrompt,
  TRON_NETTER_SMS_ADDENDUM,
} from "@/lib/tron-netter/persona";
import {
  BRAIN_AUTH_HEADERS,
  getDisabledBrainTools,
} from "@/lib/brain-client";
import { sendSms } from "@/lib/twilio";

// Twilio SMS webhook for Tron Netter's number, (872) 350-4325. The number's
// SMS webhook points here (instead of the brain's generic /twilio/sms
// handler) so texting Tron Netter hits the SAME persona as the webchat:
// identical system prompt + identity, all internal brain tools disabled,
// memoryMode do_not_store. Conversation threading comes from the stable
// per-sender sessionId — the brain stores and replays message history per
// session regardless of memoryMode.
const BRAIN_BASE_URL =
  process.env.BRAIN_BASE_URL || "http://127.0.0.1:3211";
const PUBLIC_BASE_URL =
  process.env.NEXT_PUBLIC_BASE_URL || "https://ai.xl.net";

const TWIML_EMPTY = '<?xml version="1.0" encoding="UTF-8"?><Response/>';

// Standard carrier opt-out/opt-in keywords. Twilio's Advanced Opt-Out
// handles the compliance replies at the platform level before the webhook
// fires; we just make sure Tron never also replies to them.
const OPTOUT_KEYWORDS = new Set([
  "stop", "stopall", "unsubscribe", "cancel", "end", "quit",
  "start", "unstop", "yes", "help", "info",
]);

function twimlResponse(status = 200) {
  return new NextResponse(TWIML_EMPTY, {
    status,
    headers: { "Content-Type": "text/xml" },
  });
}

// Twilio request validation: base64(HMAC-SHA1(url + sorted(name+value)*))
// with the account auth token. https://www.twilio.com/docs/usage/security
function isValidTwilioSignature(
  params: URLSearchParams,
  signature: string | null
): boolean {
  const authToken = process.env.TWILIO_AUTH_TOKEN || "";
  if (!authToken || !signature) return false;
  const url = `${PUBLIC_BASE_URL}/api/tron-netter/sms`;
  const data =
    url +
    [...params.keys()]
      .sort()
      .map((k) => k + params.get(k))
      .join("");
  const expected = crypto
    .createHmac("sha1", authToken)
    .update(Buffer.from(data, "utf-8"))
    .digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function askTronNetter(from: string, body: string): Promise<string> {
  const envelope = {
    sessionId: `sms-${from}`,
    promptId: `sms_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    messages: [
      {
        role: "system",
        content: getTronNetterSystemPrompt() + TRON_NETTER_SMS_ADDENDUM,
      },
      { role: "user", content: body },
    ],
    requester: { requesterId: from },
    // Tron has no tools, so the brain's think_harder / plan_execute
    // escalations can only burn 30-60s and answer from world knowledge
    // (off-persona). Phase 1 = always direct_answer: fast, and declines
    // stay declines. Also shields SMS from escalation-only failure modes
    // (a bad router model pick in the verifier pass once 500'd every
    // "best laptop"-style text as "Sorry, I hit a snag").
    invocation: { maxOrchestratorPhase: 1 },
    memoryMode: "do_not_store",
    privacyScope: "private_to_requester",
    markdownMode: "strip",
    brainIdentity: TRON_NETTER_IDENTITY,
    groupName: "aiwebsite",
    disabledTools: await getDisabledBrainTools(),
  };

  const res = await fetch(`${BRAIN_BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...BRAIN_AUTH_HEADERS },
    body: JSON.stringify(envelope),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    throw new Error(`Brain API error ${res.status}`);
  }
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || "").trim();
}

async function sendSmsReply(to: string, from: string, body: string) {
  await sendSms(to, body, from);
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const params = new URLSearchParams(rawBody);

  if (!isValidTwilioSignature(params, request.headers.get("x-twilio-signature"))) {
    console.warn("[tron-netter/sms] rejected request with bad Twilio signature");
    return new NextResponse("Forbidden", { status: 403 });
  }

  const from = params.get("From") || "";
  const to = params.get("To") || process.env.TWILIO_PHONE_NUMBER || "";
  const body = (params.get("Body") || "").trim();

  if (!from || !body) return twimlResponse();
  if (OPTOUT_KEYWORDS.has(body.toLowerCase())) return twimlResponse();

  // Twilio webhooks time out after ~15s and the brain can take longer, so
  // ACK immediately and deliver the reply via the REST API when it's ready.
  after(async () => {
    try {
      const answer = await askTronNetter(from, body);
      if (answer) {
        await sendSmsReply(from, to, answer);
        console.log(`[tron-netter/sms] replied to=${from} len=${answer.length}`);
      }
    } catch (err) {
      console.error(
        `[tron-netter/sms] failed for ${from}: ${err instanceof Error ? err.message : err}`
      );
      try {
        await sendSmsReply(
          from,
          to,
          "Sorry, I hit a snag processing your message. Please try again in a moment. — Tron Netter"
        );
      } catch {
        // best-effort error reply
      }
    }
  });

  return twimlResponse();
}
