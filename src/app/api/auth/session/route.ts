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
  try {
    const [row] = await db
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);
    displayName = row?.displayName ?? session.displayName;
  } catch { /* non-critical */ }

  return NextResponse.json({
    authenticated: true,
    user: {
      email: session.email,
      displayName,
      provider: session.provider,
      isAdmin: isAdmin(session.email),
    },
  });
}
