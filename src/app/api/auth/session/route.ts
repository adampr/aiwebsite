import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getSession, isAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ authenticated: false });
  }

  let displayName: string | null = session.displayName;
  let phone: string | null = null;
  let smsOptIn = false;
  // Server-computed "may show the SMS prompt card" flag. Defaults to false
  // so a failed DB read suppresses the prompt (fail toward silence) instead
  // of re-soliciting users who already registered or opted out.
  let smsPromptEligible = false;
  try {
    const [row] = await db
      .select({
        displayName: users.displayName,
        phone: users.phone,
        smsOptInAt: users.smsOptInAt,
        smsPromptDismissedAt: users.smsPromptDismissedAt,
      })
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);
    displayName = row?.displayName ?? session.displayName;
    phone = row?.phone ?? null;
    smsOptIn = Boolean(row?.smsOptInAt);
    if (row) {
      smsPromptEligible =
        !(row.phone && row.smsOptInAt) && !row.smsPromptDismissedAt;
    }
  } catch { /* non-critical; smsPromptEligible stays false */ }

  return NextResponse.json({
    authenticated: true,
    user: {
      email: session.email,
      displayName,
      provider: session.provider,
      isAdmin: isAdmin(session.email),
      phone,
      smsOptIn,
      smsPromptEligible,
    },
  });
}
