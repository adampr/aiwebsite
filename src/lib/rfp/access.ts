// The /rfp access gate (ARCHITECTURE.md §5.17). ONE definition of who may see
// this section; every page, route handler and server action under /rfp calls
// requireRfpUser() or requireRfpPage(). No caller re-implements the predicate.
//
// WHY THIS IS NOT JUST AN @xl.net DOMAIN CHECK
//
// A signed session's `email` is whatever the OAuth provider handed back, and
// one of the two live providers does not verify it. MICROSOFT_TENANT_ID is
// "common", so the Microsoft authority accepts any Entra tenant on earth plus
// personal accounts, and packages/aicompany/src/auth/oauth-microsoft.ts reads
// Graph /me `mail` in preference to `userPrincipalName`. Per Microsoft's own
// Graph reference, `mail` carries NO verified-domain requirement and is
// writable via PATCH /users/{id} — that is the published nOAuth technique.
// UPN cannot be forged (it must sit on a verified domain); `mail` can. So a
// domain-only gate would admit anyone willing to create a free tenant.
//
// XL.net is a Google Workspace domain: xl.net MX points only at
// aspmx.l.google.com and SPF includes _spf.google.com, with no Microsoft mail
// records. Staff therefore sign in with Google, and Google will not issue an
// @xl.net account to anyone who cannot receive mail at that address (consumer
// signup on a Workspace-managed domain is blocked, and the fallback flow mails
// a verification code that lands in XL.net's own tenant).
//
// So the gate is (provider === "google" AND domain === "xl.net"). That closes
// the Microsoft forgery path for this section while changing NOTHING for
// members of the public who sign in with Microsoft elsewhere on the site.
// `provider` is set server-side from the users row and covered by the session
// HMAC (auth/session.ts), so it is not client-supplied.
//
// This is deliberately NOT src/lib/work/http.ts's requireXlUser(). That gate
// is domain-only and guards work submissions; sharing it would silently
// inherit the weak predicate here, and any future softening of one would move
// the other.

import { readSession } from "@aicompany/core/auth/session";
import { isAdmin } from "@aicompany/core/auth/guard";
import { redirect } from "next/navigation";
import { siteConfig } from "site.config";

/** Exact domain labels admitted. A constant in code, not env, so the gate cannot drift silently. */
export const RFP_DOMAINS = ["xl.net"] as const;

/**
 * Sign-in providers whose email claim is trustworthy for this section.
 *
 * Adding a provider here is a security decision: it asserts that the provider
 * will not issue a session bearing an @xl.net address to someone who does not
 * control that mailbox. See the header note before touching it.
 */
export const RFP_PROVIDERS = ["google"] as const;

export type RfpUser = {
  userId: string;
  email: string;
  emailDomain: string;
  provider: string;
  admin: boolean;
};

/**
 * The domain of an email address, or null when the address is not a shape we
 * will reason about.
 *
 * Stricter than the `split("@")[1]` idiom used elsewhere in the host, which
 * takes the SECOND field rather than the last: for "a@evil.com@xl.net" that
 * yields "evil.com", and for "a@xl.net@evil.com" it yields "xl.net". Requiring
 * exactly one "@" removes the ambiguity instead of picking a side.
 */
export function emailDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const trimmed = email.trim().toLowerCase();
  // Non-ASCII would let a homoglyph domain render as "xl.net" while comparing
  // unequal. It already fails the equality test below, but rejecting it here
  // makes that a decision rather than an accident.
  if (/[^\x20-\x7e]/.test(trimmed)) return null;
  const parts = trimmed.split("@");
  if (parts.length !== 2) return null;
  // A trailing root dot addresses the same host to a resolver.
  const domain = parts[1].replace(/\.$/, "");
  if (!domain || !/^[a-z0-9.-]+$/.test(domain)) return null;
  return domain;
}

/**
 * Exact label equality, never a suffix test.
 *
 * endsWith("xl.net") would admit "evilxl.net"; endsWith(".xl.net") would admit
 * "@ai.xl.net", which is this system's OWN automation identity
 * (Tron.Netter@ai.xl.net posts to the site). Subdomains do not pass.
 */
export function isRfpDomain(email: string | null | undefined): boolean {
  const domain = emailDomain(email);
  return domain !== null && (RFP_DOMAINS as readonly string[]).includes(domain);
}

export function isRfpProvider(provider: string | null | undefined): boolean {
  if (!provider) return false;
  return (RFP_PROVIDERS as readonly string[]).includes(
    provider.trim().toLowerCase()
  );
}

export type RfpDenial =
  | { ok: false; reason: "unauthenticated" }
  | { ok: false; reason: "wrong_domain"; email: string }
  | { ok: false; reason: "wrong_provider"; email: string };

/**
 * The single decision. Returns the principal or a typed denial; callers choose
 * how to render it (a page redirects or explains, an API returns JSON).
 */
export async function readRfpUser(): Promise<
  { ok: true; user: RfpUser } | RfpDenial
> {
  const session = await readSession(siteConfig);
  if (!session) return { ok: false, reason: "unauthenticated" };

  const domain = emailDomain(session.email);
  if (domain === null || !isRfpDomain(session.email)) {
    return { ok: false, reason: "wrong_domain", email: session.email };
  }
  if (!isRfpProvider(session.provider)) {
    return { ok: false, reason: "wrong_provider", email: session.email };
  }

  return {
    ok: true,
    user: {
      userId: session.userId,
      email: session.email,
      emailDomain: domain,
      provider: session.provider,
      admin: isAdmin(session.email),
    },
  };
}

/**
 * Page/layout/server-action guard. Throws Next's redirect for a signed-out
 * visitor; returns the denial for a signed-in one so the page can explain
 * itself rather than bouncing to a login form it has already satisfied.
 */
export async function requireRfpPage(
  redirectTo: string
): Promise<
  | { ok: true; user: RfpUser }
  | Exclude<RfpDenial, { reason: "unauthenticated" }>
> {
  const result = await readRfpUser();
  if (!result.ok && result.reason === "unauthenticated") {
    // redirect() throws, so the signed-out case never returns to the caller.
    redirect(`/login?redirect=${encodeURIComponent(redirectTo)}`);
  }
  return result as
    | { ok: true; user: RfpUser }
    | Exclude<RfpDenial, { reason: "unauthenticated" }>;
}

/** Route-handler guard: the principal, or a Response to return as-is. */
export async function requireRfpUser(): Promise<
  { ok: true; user: RfpUser } | { ok: false; response: Response }
> {
  const result = await readRfpUser();
  if (result.ok) return result;

  const status = result.reason === "unauthenticated" ? 401 : 403;
  return {
    ok: false,
    response: Response.json(
      { error: result.reason },
      // A gated response must never be cached, by us or by anything between us
      // and the browser.
      { status, headers: { "cache-control": "no-store, private" } }
    ),
  };
}
