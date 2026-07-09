import { NextRequest, NextResponse } from "next/server";
import { Resend } from "resend";
import type { WebhookEventPayload } from "resend";
import {
  TRON_NETTER_IDENTITY,
  getTronNetterSystemPrompt,
  TRON_NETTER_EMAIL_ADDENDUM,
} from "@/lib/tron-netter/persona";
import {
  BRAIN_AUTH_HEADERS,
  getDisabledBrainTools,
} from "@/lib/brain-client";
import { sendEmail } from "@/lib/email/send";

// Resend inbound webhook: gives Tron Netter a real send/receive mailbox
// (Tron.Netter@ai.xl.net), mirroring itsupportchicago's data@ flow. Inbound
// mail to the ai.xl.net domain is answered autonomously with the SAME
// persona envelope as webchat and SMS (same system prompt + identity, all
// internal brain tools disabled, memoryMode do_not_store; threading via the
// stable per-sender sessionId). Every outbound reply is BCC'd to adam@xl.net
// by sendEmail — a standing requirement.
//
// IMPORTANT: Resend webhooks are ACCOUNT-scoped on the shared account, so
// this endpoint receives events for itsupportchicago.net traffic too. Only
// mail addressed to @ai.xl.net is handled here; everything else is ignored
// (and itsupportchicago's endpoint has the mirror-image filter).
const BRAIN_BASE_URL =
  process.env.BRAIN_BASE_URL || "http://127.0.0.1:3211";
const OWN_DOMAIN = "@ai.xl.net";
const TRON_ADDRESS = "Tron.Netter@ai.xl.net";

function getResend() {
  return new Resend(process.env.RESEND_API_KEY);
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();

  let event: WebhookEventPayload;
  try {
    const resend = getResend();
    event = resend.webhooks.verify({
      payload: rawBody,
      headers: {
        id: request.headers.get("svix-id") ?? "",
        timestamp: request.headers.get("svix-timestamp") ?? "",
        signature: request.headers.get("svix-signature") ?? "",
      },
      webhookSecret: process.env.RESEND_WEBHOOK_SECRET ?? "",
    });
  } catch (err) {
    console.error("[webhook/resend] signature verification failed:", err);
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  if (event.type === "email.received") {
    const emailId = "email_id" in event.data ? String(event.data.email_id) : "";
    if (emailId) {
      // Answer asynchronously — svix retries on slow responses, and the
      // brain can take minutes.
      handleInbound(emailId).catch((err) =>
        console.error(
          `[tron-email] inbound handling failed: ${err instanceof Error ? err.message : err}`
        )
      );
    }
  }
  // Delivery/bounce/complaint events are acknowledged but not tracked.

  return NextResponse.json({ ok: true });
}

// Strip quoted reply history and signature blocks from an inbound email body
// before it is handed to the brain: a short question buried under a long
// signature (links, phone numbers, article URLs) otherwise dominates the
// prompt and the model answers the signature instead of the sender.
// Conservative by design — cuts only at unambiguous markers. The FULL
// original body is still quoted in the outbound reply; only the model
// prompt gets the trimmed version. Keep in sync with the identical helper
// in itsupportchicago's resend webhook.
function stripQuotedAndSignature(text: string): string {
  const lines = text.split("\n");
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (
      /^On .{4,200} wrote:$/.test(trimmed) || // Gmail/Apple Mail reply header
      /^-{2,}\s*Original Message\s*-{2,}$/i.test(trimmed) || // Outlook
      /^-{4,}\s*Forwarded/i.test(trimmed) || // forward separator
      trimmed.startsWith(">") || // already-quoted lines
      /^--\s*$/.test(lines[i]) // RFC 3676 signature delimiter "-- "
    ) {
      cut = i;
      break;
    }
  }
  let kept = lines.slice(0, cut);
  // Adam's signature: "Regards," followed by "Adam Radulovic" within the
  // next 3 NON-BLANK lines (Gmail pads the closer with blank lines; same
  // rule as itsupportchicago's chiai proxy flow, blank-line tolerant).
  outer: for (let i = 0; i < kept.length; i++) {
    if (/^Regards,?\s*$/i.test(kept[i].trim())) {
      let checked = 0;
      for (let j = i + 1; j < kept.length && checked < 3; j++) {
        const next = kept[j].trim();
        if (!next) continue;
        checked++;
        if (/adam\s*radulovic/i.test(next)) {
          kept = kept.slice(0, i);
          break outer;
        }
      }
    }
  }
  const result = kept.join("\n").trim();
  return result || text.trim();
}

async function handleInbound(emailId: string) {
  const resend = getResend();
  const { data: email, error } = await resend.emails.receiving.get(emailId);
  if (error || !email) {
    console.error("[tron-email] failed to fetch inbound email:", error);
    return;
  }

  const recipients = [...(email.to ?? []), ...(email.cc ?? [])].map((a) =>
    a.toLowerCase()
  );
  // Shared-account webhook: ignore mail that isn't for our domain.
  if (!recipients.some((a) => a.includes(OWN_DOMAIN))) return;

  // roleplay@ai.xl.net belongs to the roleplay coach (handled by
  // roleplay.xl.net's own webhook) — Tron Netter must not answer it, or the
  // sender would get two replies from two different personas.
  if (recipients.some((a) => a.includes("roleplay@"))) return;

  const from = email.from ?? "";
  const fromLower = from.toLowerCase();
  const senderAddress = (fromLower.match(/[\w.+-]+@[\w.-]+\.\w+/) || [""])[0];

  // Loop guards: never answer our own domain, bounce daemons, no-reply
  // senders, or the sibling AI mailboxes on itsupportchicago (Chi AI
  // auto-replies from there — answering it would ping-pong forever).
  if (
    !senderAddress ||
    senderAddress.endsWith(OWN_DOMAIN) ||
    senderAddress.includes("@itsupportchicago") ||
    /mailer-daemon|postmaster|no-?reply|donotreply/i.test(senderAddress)
  ) {
    console.log(`[tron-email] skipping auto-reply to ${senderAddress || "(unparseable sender)"}`);
    return;
  }

  const subject = email.subject ?? "";
  const bodyText = (email.text ?? email.html ?? "").trim();
  if (!bodyText) return;
  const promptBody = stripQuotedAndSignature(bodyText);

  // The user turn carries ONLY the sender's own words, exactly like webchat;
  // sender/subject metadata lives in the system prompt. Wrapping the body in
  // an "[Email from ...]" envelope made the model treat the turn as a
  // document to describe ("This looks like a signature block from...")
  // instead of a message to answer.
  //
  // Session/requester ids are v2 on purpose: the brain stores conversation
  // turns unconditionally (memoryMode only gates fact extraction) and
  // replays them — by sessionId, then cross-session by requesterId — so the
  // original per-sender sessions that contain those describe-mode replies
  // would keep re-teaching the behavior. The new ids orphan that history.
  // Sessions are scoped per thread (sender + normalized subject), matching
  // itsupportchicago's per-thread email sessions.
  const threadKey =
    subject.replace(/^((re|fwd?|fw):\s*)+/i, "").trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) ||
    "no-subject";

  const envelope = {
    sessionId: `email2-${senderAddress}-${threadKey}`,
    promptId: `email_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    messages: [
      {
        role: "system",
        content:
          getTronNetterSystemPrompt() +
          TRON_NETTER_EMAIL_ADDENDUM +
          `\n\nYou are replying to an email from ${from}` +
          (subject ? ` with the subject "${subject}".` : "."),
      },
      {
        role: "user",
        content: promptBody,
      },
    ],
    requester: { requesterId: `email:${senderAddress}`, email: senderAddress },
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
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) {
    throw new Error(`Brain API error ${res.status}`);
  }
  const data = await res.json();
  const answer = (data.choices?.[0]?.message?.content || "").trim();
  if (!answer) {
    console.warn("[tron-email] brain returned empty reply, skipping");
    return;
  }

  const replySubject = /^re:/i.test(subject) ? subject : `Re: ${subject || "your email"}`;
  const dateStr = new Date().toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const quoted = bodyText.replace(/\n/g, "\n> ");

  const sent = await sendEmail({
    to: senderAddress,
    subject: replySubject,
    replyTo: TRON_ADDRESS,
    text:
      `${answer}\n\n` +
      `Tron Netter\nAI Agent, XL.net\n${TRON_ADDRESS}\n(872) 350-4325 — call or text\nhttps://ai.xl.net\n\n` +
      `---\nOn ${dateStr}, ${from} wrote:\n\n> ${quoted}`,
  });
  if (sent) {
    console.log(`[tron-email] auto-replied to ${senderAddress}`);
  }
}
