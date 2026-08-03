// Route helpers for team work submissions (§5.16): the @xl.net session gate,
// uniform error bodies, and rate limiting (governance http.ts pattern).

import { readSession } from "@aicompany/core/auth/session";
import { isAdmin } from "@aicompany/core/auth/guard";
import { checkRateLimit } from "@aicompany/core/lib/rate-limit";
import { emailDomain, isRfpProvider } from "@/lib/rfp/access";
import { siteConfig } from "site.config";

/** The submitting audience is XL.net staff; a constant in code (not env) so
 * the gate cannot drift silently. */
export const WORK_SUBMIT_DOMAINS = ["xl.net"];

export interface WorkUser {
  userId: string;
  email: string;
  emailDomain: string;
  provider: string;
  admin: boolean;
}

/** §5.16 auto-approve stamp predicate: may THIS session's update swap live
 * on panel pass without the /admin/work click?
 *
 * Deliberately STRONGER than requireXlUser's domain gate. `admin` alone is
 * an ADMIN_EMAIL string compare over the session email, and with
 * MICROSOFT_TENANT_ID=common the Microsoft lane will mint a session bearing
 * any email a free Entra tenant claims (the published nOAuth forgery; the
 * full argument lives at the head of src/lib/rfp/access.ts). So the stamp
 * additionally requires the /rfp predicate: a provider that verifies its
 * email claim (Google) AND an exact-label domain parse (requireXlUser's
 * split("@")[1] idiom is ambiguous on double-@ addresses). Reuses the rfp
 * primitives rather than copying the lists, so a future hardening there
 * moves here too. Email-lane submissions never see this predicate: they
 * carry no session at all, and createSubmission + a DB CHECK refuse the
 * flag outside a parentId row. */
export function verifiedWebAdmin(user: WorkUser): boolean {
  const domain = emailDomain(user.email);
  return (
    user.admin &&
    isRfpProvider(user.provider) &&
    domain !== null &&
    WORK_SUBMIT_DOMAINS.includes(domain)
  );
}

export function workError(
  code: string,
  message: string,
  status: number,
  extra?: Record<string, unknown>
): Response {
  return Response.json(
    { error: { code, message, ...(extra ?? {}) } },
    { status, headers: { "cache-control": "no-store, private" } }
  );
}

export function okJson(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store, private" },
  });
}

/** Signed-in user of any domain (admin flag included). */
export async function requireUser(): Promise<WorkUser | Response> {
  const session = await readSession(siteConfig);
  if (!session)
    return workError(
      "unauthenticated",
      "Sign in to submit or view work submissions.",
      401
    );
  return {
    userId: session.userId,
    email: session.email,
    emailDomain: session.email.split("@")[1]?.toLowerCase() ?? "",
    provider: session.provider,
    admin: isAdmin(session.email),
  };
}

/** Signed-in AND @xl.net. Non-staff get a 403 that names the fix. */
export async function requireXlUser(): Promise<WorkUser | Response> {
  const user = await requireUser();
  if (user instanceof Response) return user;
  if (!WORK_SUBMIT_DOMAINS.includes(user.emailDomain))
    return workError(
      "wrong_domain",
      `Work submissions are open to xl.net accounts only. You are signed in as ${user.email}. Sign in with your xl.net Google or Microsoft account.`,
      403
    );
  return user;
}

export function rateLimit(
  key: string,
  windowSec: number,
  max: number
): Response | null {
  const r = checkRateLimit(key, { windowSec, max });
  if (r.allowed) return null;
  return workError("rate_limited", "Too many requests. Give it a moment.", 429);
}
