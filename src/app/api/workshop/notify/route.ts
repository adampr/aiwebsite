// POST — join the workshop notification list; DELETE — leave it (§5.10).
// Session required (401 otherwise); the email/name/provider ALWAYS come from
// the session, never from a request body, so a request can only ever act on
// its own address (both handlers ignore the body entirely). Join is
// idempotent: unique lowercased email + ON CONFLICT DO NOTHING, so a double
// click or a re-join is a no-op, not an error. Leave deletes the row
// outright. CSRF: "/api/workshop" is in src/proxy.ts protectedPrefixes.
// A plain session (no mv/trust claim) is deliberately enough here: the harm
// ceiling is one workshop announcement email to an address the session
// already claims — the same bar as /api/checkout, far below the roadmap's
// tenancy stakes.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { eq } from "drizzle-orm";
import { readSession } from "@aicompany/core/auth/session";
import { siteConfig } from "site.config";
import { db } from "@/lib/db";
import { workshopInterest } from "@/lib/db/schema";
import { okJson, rateLimit, workError } from "@/lib/work/http";

/** Session gate + a light per-user limiter (shared work/http rateLimit —
 * both verbs are single-row writes, so 10/min absorbs any honest use). */
async function requireNotifyUser(): Promise<
  { email: string; displayName: string | null; provider: string } | Response
> {
  const session = await readSession(siteConfig);
  if (!session)
    return workError(
      "unauthenticated",
      "Sign in to manage workshop notifications.",
      401
    );
  const limited = rateLimit(`workshop-notify:${session.userId}`, 60, 10);
  if (limited) return limited;
  return {
    email: session.email.trim().toLowerCase(),
    displayName: session.displayName?.trim() || null,
    provider: session.provider,
  };
}

export async function POST(): Promise<Response> {
  const user = await requireNotifyUser();
  if (user instanceof Response) return user;
  await db
    .insert(workshopInterest)
    .values({
      email: user.email,
      displayName: user.displayName,
      provider: user.provider,
    })
    .onConflictDoNothing({ target: workshopInterest.email });
  return okJson({ joined: true });
}

export async function DELETE(): Promise<Response> {
  const user = await requireNotifyUser();
  if (user instanceof Response) return user;
  await db
    .delete(workshopInterest)
    .where(eq(workshopInterest.email, user.email));
  return okJson({ joined: false });
}
