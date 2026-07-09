import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { smsPromptEvents, users } from "@/lib/db/schema";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

// Telemetry + preference sink for the SMS prompt card (a UI preference
// surface, NOT part of the consent flow — hence /api/auth/*, not
// /api/texting/*). Every action appends a funnel event; "dismissed"
// additionally sets users.sms_prompt_dismissed_at so "Don't ask again"
// holds across devices. Idempotent: re-dismissing is a no-op.
const EVENTS = new Set(["shown", "clicked", "snoozed", "dismissed"]);

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const limit = checkRateLimit(
    `sms_prompt:user:${session.userId}`,
    RATE_LIMITS.smsPromptPerUser
  );
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } }
    );
  }

  let event: string;
  try {
    const body = await request.json();
    event = typeof body.event === "string" ? body.event : "";
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  if (!EVENTS.has(event)) {
    return NextResponse.json({ error: "Unknown event" }, { status: 400 });
  }

  await db.insert(smsPromptEvents).values({ userId: session.userId, event });

  if (event === "dismissed") {
    await db
      .update(users)
      .set({ smsPromptDismissedAt: new Date() })
      .where(
        and(eq(users.id, session.userId), isNull(users.smsPromptDismissedAt))
      );
  }

  return NextResponse.json({ ok: true });
}
