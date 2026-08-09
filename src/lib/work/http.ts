// Route helpers for team work submissions (§5.16): the @xl.net session gate,
// uniform error bodies, and rate limiting (governance http.ts pattern).

import { readSession } from "@aicompany/core/auth/session";
import { isAdmin } from "@aicompany/core/auth/guard";
import { checkRateLimit } from "@aicompany/core/lib/rate-limit";
import { rateLimitedMessage } from "@/lib/retry-after";
import { emailDomain, isVerifiedStaffProvider } from "@/lib/rfp/access";
import { isTrustedSession } from "@/lib/roadmap/access";
import { companyForDomainRow } from "@/lib/roadmap/db";
import { roadmapEnabled } from "@/lib/roadmap/config";
import type { WorkScope } from "@/lib/work/scope";
import { siteConfig } from "site.config";

/** The submitting audience is XL.net staff; a constant in code (not env) so
 * the gate cannot drift silently. */
export const WORK_SUBMIT_DOMAINS = ["xl.net"];

export interface WorkUser {
  userId: string;
  email: string;
  emailDomain: string;
  provider: string;
  /** Per-login verified-email claim (session.mv === true). Never stored. */
  mv: boolean;
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
 * additionally requires the /rfp predicate: a verified staff provider
 * (Google, or Microsoft carrying the per-login mv claim minted from strict
 * xms_edov) AND an exact-label domain parse (requireXlUser's
 * split("@")[1] idiom is ambiguous on double-@ addresses). Reuses the rfp
 * primitives rather than copying the lists, so a future hardening there
 * moves here too. Email-lane submissions never see this predicate: they
 * carry no session at all, and createSubmission + a DB CHECK refuse the
 * flag outside a parentId row. */
export function verifiedWebAdmin(user: WorkUser): boolean {
  const domain = emailDomain(user.email);
  return (
    user.admin &&
    isVerifiedStaffProvider(user) &&
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
    mv: session.mv === true,
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

/** A refusal that NAMES the wait. src/lib/retry-after.ts records why the old
 * fixed sentence was a lie on any window longer than a minute, and
 * roadmap-tests.ts pins it out of both 429 helpers. */
export function rateLimit(
  key: string,
  windowSec: number,
  max: number
): Response | null {
  const r = checkRateLimit(key, { windowSec, max });
  if (r.allowed) return null;
  const res = workError("rate_limited", rateLimitedMessage(r.retryAfterSec), 429, {
    retryAfterSec: r.retryAfterSec,
  });
  // Standard HTTP signal alongside the body field (governance/http.ts already
  // ships the body field; the header is what a non-browser client reads).
  res.headers.set("retry-after", String(Math.max(1, r.retryAfterSec)));
  return res;
}

/**
 * §5.18: the ONE submit endpoint serves two audiences. xl.net sessions get
 * the internal scope with byte-identical behavior (no trust requirement:
 * staff sessions predate the hardened callbacks and their lane publishes to
 * XL.net's own page). Any other domain resolves against registered
 * companies; a company scope REQUIRES a trusted session (google/microsoft
 * with the mail-verified claim, or magic-link), because a common-tenant
 * Microsoft session can carry any forged domain and here that would be
 * cross-tenant read/write.
 */
export async function requireWorkUser(): Promise<
  (WorkUser & { scope: WorkScope }) | Response
> {
  const session = await readSession(siteConfig);
  if (!session)
    return workError(
      "unauthenticated",
      "Sign in to submit or view work submissions.",
      401
    );
  const user: WorkUser = {
    userId: session.userId,
    email: session.email,
    emailDomain: emailDomain(session.email) ?? "",
    provider: session.provider,
    mv: session.mv === true,
    admin: isAdmin(session.email),
  };
  if (WORK_SUBMIT_DOMAINS.includes(user.emailDomain)) {
    return { ...user, scope: { companyId: null } };
  }
  const company = user.emailDomain
    ? await companyForDomainRow(user.emailDomain)
    : null;
  if (!company)
    return workError(
      "wrong_domain",
      `Work submissions are open to xl.net staff and companies on the AI Roadmap. You are signed in as ${user.email}; if your company has a roadmap workspace, sign in with your work email, or set one up at /roadmap.`,
      403
    );
  if (!isTrustedSession(session))
    return workError(
      "untrusted_provider",
      "Confirm it is you first: your sign-in method could not verify your email address. Open /roadmap and follow the confirmation step (an email link or a Google sign-in), then try again.",
      403
    );
  if (company.status !== "active")
    return workError(
      "company_paused",
      "Submissions for your company are paused right now. Your company admin can contact XL.net.",
      403
    );
  if (!roadmapEnabled(process.env))
    return workError(
      "disabled",
      "Roadmap submissions are paused right now. Try again later.",
      503
    );
  return { ...user, scope: { companyId: company.id } };
}
