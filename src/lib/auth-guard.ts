import { NextResponse } from "next/server";
import { getSession, isAdmin, type SessionPayload } from "@/lib/auth";

type GuardResult =
  | { ok: true; session: SessionPayload }
  | { ok: false; response: NextResponse };

/**
 * Admin guard for /api/admin/* route handlers: 401 without a session,
 * 403 when the session email is not in the ADMIN_EMAIL allowlist.
 * Pages use getSession()+isAdmin()+redirect("/login") directly instead.
 */
export async function requireAdmin(): Promise<GuardResult> {
  const session = await getSession();
  if (!session) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  if (!isAdmin(session.email)) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }
  return { ok: true, session };
}
