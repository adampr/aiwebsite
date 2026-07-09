import crypto from "node:crypto";
import { NextRequest, NextResponse, after } from "next/server";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { phoneVerifications, smsConsentLogs, users } from "@/lib/db/schema";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { sendSms } from "@/lib/twilio";
import { SMS_CONSENT_TEXT, VERIFICATION_MAX_ATTEMPTS } from "@/lib/texting";

// Step 2 of the /texting opt-in: the user types the 6-digit code we texted.
// Only a correct code registers the number — users.phone stays untouched
// otherwise. Consent is recorded in sms_consent_logs with the exact
// checkbox language, IP, and user agent (TCPA proof-of-consent).
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Sign in to verify a phone number" }, { status: 401 });
  }

  const limit = checkRateLimit(
    `texting_verify:user:${session.userId}`,
    RATE_LIMITS.textingVerifyPerUser
  );
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } }
    );
  }

  let body: { code?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const code = typeof body.code === "string" ? body.code.replace(/\D/g, "") : "";
  if (code.length !== 6) {
    return NextResponse.json({ error: "Enter the 6-digit code" }, { status: 400 });
  }

  const [verification] = await db
    .select()
    .from(phoneVerifications)
    .where(
      and(
        eq(phoneVerifications.userId, session.userId),
        isNull(phoneVerifications.consumedAt)
      )
    )
    .orderBy(desc(phoneVerifications.id))
    .limit(1);

  if (!verification || verification.expiresAt.getTime() < Date.now()) {
    return NextResponse.json(
      { error: "That code has expired. Request a new one." },
      { status: 400 }
    );
  }

  // Count the attempt before comparing so parallel guesses can't exceed the cap.
  const [{ attempts }] = await db
    .update(phoneVerifications)
    .set({ attempts: sql`${phoneVerifications.attempts} + 1` })
    .where(eq(phoneVerifications.id, verification.id))
    .returning({ attempts: phoneVerifications.attempts });
  if (attempts > VERIFICATION_MAX_ATTEMPTS) {
    return NextResponse.json(
      { error: "Too many incorrect codes. Request a new one." },
      { status: 400 }
    );
  }

  const givenHash = crypto.createHash("sha256").update(code).digest("hex");
  const match = crypto.timingSafeEqual(
    Buffer.from(givenHash),
    Buffer.from(verification.codeHash)
  );
  if (!match) {
    const remaining = Math.max(0, VERIFICATION_MAX_ATTEMPTS - attempts);
    return NextResponse.json(
      {
        error: remaining
          ? `Incorrect code. ${remaining} attempt${remaining === 1 ? "" : "s"} left.`
          : "Too many incorrect codes. Request a new one.",
      },
      { status: 400 }
    );
  }

  await db
    .update(phoneVerifications)
    .set({ consumedAt: new Date() })
    .where(eq(phoneVerifications.id, verification.id));

  const now = new Date();
  try {
    await db
      .update(users)
      .set({ phone: verification.phone, phoneVerifiedAt: now, smsOptInAt: now })
      .where(eq(users.id, session.userId));
  } catch {
    // unique(phone) — someone else registered this number since /start ran
    return NextResponse.json(
      { error: "That number is already registered to another account" },
      { status: 409 }
    );
  }

  await db.insert(smsConsentLogs).values({
    userId: session.userId,
    email: session.email,
    phone: verification.phone,
    smsOptIn: true,
    consentText: SMS_CONSENT_TEXT,
    ipAddress:
      request.headers.get("cf-connecting-ip") ||
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      null,
    userAgent: request.headers.get("user-agent"),
    pageUrl: `${process.env.NEXT_PUBLIC_BASE_URL || "https://ai.xl.net"}/texting`,
  });

  // CTIA opt-in confirmation, best-effort after the response.
  after(async () => {
    try {
      await sendSms(
        verification.phone,
        "You're opted in to XL.net AI texts from Tron Netter. Message frequency varies. " +
          "Msg&data rates may apply. Reply STOP to opt out, HELP for help."
      );
    } catch (err) {
      console.error(
        `[texting/verify] confirmation SMS failed: ${err instanceof Error ? err.message : err}`
      );
    }
  });

  return NextResponse.json({ ok: true, phone: verification.phone });
}
