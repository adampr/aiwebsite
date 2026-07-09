import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull, ne } from "drizzle-orm";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { phoneVerifications, users } from "@/lib/db/schema";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { sendSms } from "@/lib/twilio";
import { normalizeUsPhone, VERIFICATION_CODE_TTL_MIN } from "@/lib/texting";

// Step 1 of the /texting opt-in: the signed-in user submits a phone number
// plus the consent checkbox; we text a random 6-digit code to that number.
// Nothing is saved to the user's account until /api/texting/verify confirms
// the code — possession of the phone is proven before the number registers.
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Sign in to add a phone number" }, { status: 401 });
  }

  let body: { phone?: unknown; smsOptIn?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  if (body.smsOptIn !== true) {
    return NextResponse.json(
      { error: "You must agree to the SMS terms to opt in" },
      { status: 400 }
    );
  }

  const phone = normalizeUsPhone(typeof body.phone === "string" ? body.phone : "");
  if (!phone) {
    return NextResponse.json(
      { error: "Enter a valid 10-digit US mobile number" },
      { status: 400 }
    );
  }

  const userLimit = checkRateLimit(
    `texting_start:user:${session.userId}`,
    RATE_LIMITS.textingStartPerUser
  );
  const phoneLimit = checkRateLimit(
    `texting_start:phone:${phone}`,
    RATE_LIMITS.textingStartPerPhone
  );
  if (!userLimit.allowed || !phoneLimit.allowed) {
    const retryAfterSec = Math.max(userLimit.retryAfterSec, phoneLimit.retryAfterSec);
    return NextResponse.json(
      { error: `Too many codes requested. Try again in ${Math.ceil(retryAfterSec / 60)} min.` },
      { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
    );
  }

  // A number can only be registered to one account.
  const [taken] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.phone, phone), ne(users.id, session.userId)))
    .limit(1);
  if (taken) {
    return NextResponse.json(
      { error: "That number is already registered to another account" },
      { status: 409 }
    );
  }

  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
  const codeHash = crypto.createHash("sha256").update(code).digest("hex");

  try {
    await sendSms(
      phone,
      `Your XL.net AI verification code is ${code}. It expires in ${VERIFICATION_CODE_TTL_MIN} minutes. ` +
        `Msg&data rates may apply. Reply STOP to opt out, HELP for help.`
    );
  } catch (err) {
    console.error(
      `[texting/start] SMS send failed for ${phone}: ${err instanceof Error ? err.message : err}`
    );
    return NextResponse.json(
      { error: "We couldn't text that number. Check it and try again." },
      { status: 502 }
    );
  }

  const ip =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    null;

  // Retire any previous live codes so only the newest one is honored.
  await db
    .update(phoneVerifications)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(phoneVerifications.userId, session.userId),
        isNull(phoneVerifications.consumedAt)
      )
    );
  await db.insert(phoneVerifications).values({
    userId: session.userId,
    phone,
    codeHash,
    expiresAt: new Date(Date.now() + VERIFICATION_CODE_TTL_MIN * 60_000),
    ipAddress: ip,
  });

  return NextResponse.json({ ok: true, phone });
}
