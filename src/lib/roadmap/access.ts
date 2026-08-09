// The /roadmap access gate (ARCHITECTURE.md §5.18). ONE definition of who may
// see a company workspace; every page, layout, route handler and server
// action under /roadmap calls a require* from this file. No caller
// re-implements the predicate. Modeled on src/lib/rfp/access.ts: constants in
// code (never env), the strict emailDomain() parser, exact label equality,
// typed denials.
//
// WHY "SIGNED IN" IS NOT ENOUGH HERE
//
// Membership is COMPUTED: session email domain == companies.domain. So the
// email claim IS the tenancy boundary, and both OAuth lanes can lie about it
// out of the box:
//  - Microsoft: MICROSOFT_TENANT_ID=common + Graph /me `mail` being
//    PATCH-writable is the published nOAuth forgery (full argument at the
//    head of src/lib/rfp/access.ts).
//  - Google: the module's callback discards `email_verified`. The /rfp
//    Google-trust argument is DOMAIN-SPECIFIC (xl.net is a Google Workspace
//    domain); for arbitrary client domains a Google account can carry an
//    unverified email.
// So the roadmap trusts only sessions whose email was VERIFIED at sign-in:
// the host-owned hardened callbacks (src/lib/auth/oauth-hardened.ts) stamp
// an HMAC-covered per-login `mv: true` claim when the provider proved
// mailbox/domain ownership (Google `email_verified`, Microsoft `xms_edov`),
// and magic-link sign-in proves mailbox control by construction. The claim
// is per-login, never a stored users-row flag: a stored flag would let a
// later forged login inherit an earlier genuine verification.

import { readSession, type SessionData } from "@aicompany/core/auth/session";
import { isAdmin } from "@aicompany/core/auth/guard";
import { redirect } from "next/navigation";
import { siteConfig } from "site.config";
import { emailDomain, isRfpProvider } from "@/lib/rfp/access";
import { companyAdminRole, companyForDomainRow } from "@/lib/roadmap/db";

export { emailDomain };
// Domain classification lives in domains.ts (pure, cycle-free: the roadmap
// db and the email intake need it without importing this gate).
export {
  RESERVED_DOMAINS,
  FREEMAIL_DOMAINS,
  SHARED_TENANT_SUFFIXES,
  isCompanyEligibleDomain,
} from "@/lib/roadmap/domains";
import {
  isCompanyEligibleDomain,
  RESERVED_DOMAINS as RESERVED_DOMAINS_LIST,
} from "@/lib/roadmap/domains";

/**
 * Is this session's email claim VERIFIED enough to be a tenancy key?
 *
 * - magic-link: proves mailbox control by construction.
 * - google / microsoft: only with the per-login `mv: true` claim from the
 *   hardened callbacks (strict-normalized email_verified / xms_edov; a
 *   session minted before the hardened callbacks shipped, or via an
 *   unverified account, has no claim and is untrusted here while remaining
 *   signed in for every public feature).
 * Adding a provider here is a security decision, not a convenience.
 */
export function isTrustedSession(s: SessionData): boolean {
  const p = s.provider?.trim().toLowerCase();
  if (p === "magic-link") return true;
  if (p === "google" || p === "microsoft") return s.mv === true;
  return false;
}

export type RoadmapPrincipal = {
  userId: string;
  email: string;
  emailDomain: string;
  provider: string;
  /** Untrusted sessions never reach a principal. */
  trusted: true;
  /** false = consumer/reserved domain: can browse, can never bootstrap. */
  domainEligible: boolean;
  company: {
    id: string;
    domain: string;
    name: string;
    status: string;
  } | null;
  companyRole: "admin" | "member" | null;
  globalAdmin: boolean;
};

export type RoadmapDenial =
  | { ok: false; reason: "unauthenticated" }
  | { ok: false; reason: "untrusted_provider"; email: string };

/** Providers eligible for the SILENT re-verify redirect (§5.18 round 2). A
 * constant in code, google-only: Microsoft joins ONLY after all three gates
 * hold: (1) the Entra optional claims (email + xms_edov) are configured on
 * the app registration, (2) an observed real login has minted mv=true, and
 * (3) the reverify route grows a Microsoft authorize-URL arm. */
export const SILENT_REVERIFY_PROVIDERS = ["google"] as const;

/**
 * Staff = the /rfp trust anchor: provider google AND exact-label xl.net
 * (src/lib/rfp/access.ts header for the full argument; provider rides under
 * the session HMAC and is set server-side, so it is not client-supplied).
 * mv is NOT required. INVARIANT (rewritten for the §5.18 unification): this
 * predicate grants ZERO client-tenant authority and gates no mutation. It
 * may select staff READ surfaces (the staff hub, the staff scorecard and
 * its click-through, and the read-only NULL-lane staff directory) whose
 * content is bounded above by what weaker existing staff gates already
 * expose: internal-lane published work is public on /work, internal-lane
 * request aggregates are visible to any signed-in xl.net Google session on
 * /work/requested, and the staff directory is XL's own staff shown to XL's
 * own staff - the same class as every client company's member-visible
 * directory, phones included (refuter-panel ruling, staff-parity round;
 * this predicate requires Google, the /rfp anchor that closes the nOAuth
 * Microsoft path). Anything that
 * renders a CLIENT company's data or performs ANY action must re-derive its
 * own gate (requireGlobalAdmin, requireRequestUser/verifiedWebAdmin, or a
 * trusted principal), never this predicate.
 */
export function isStaffSession(s: SessionData): boolean {
  return isRfpProvider(s.provider) && emailDomain(s.email) === "xl.net";
}

/**
 * Staff page gate for the (steps) shell and the staff-servable step pages
 * (§5.18 unification), and the staff-branch SELECTOR for the directory and
 * apollo-import route handlers (staff parity round) - selection only; every
 * staff WRITE is then authorized by requireGlobalAdmin. Same predicate as
 * the hub's staff branch, so the layout and every page admit the SAME
 * population - a stricter page gate behind a looser layout admit renders a
 * blank shell (refuter finding). READ surfaces only; see the isStaffSession
 * invariant above.
 *
 * globalAdmin selects UI affordances only (edit levers, auto-init,
 * recheck); it is computed via isGlobalAdminSession, never bare isAdmin,
 * and every mutation re-derives requireGlobalAdmin server-side.
 */
export async function readStaffPage(): Promise<{
  email: string;
  globalAdmin: boolean;
} | null> {
  const session = await readSession(siteConfig);
  if (!session || !isStaffSession(session)) return null;
  return { email: session.email, globalAdmin: isGlobalAdminSession(session) };
}

export type RoadmapHubView =
  | { kind: "anonymous" }
  | { kind: "staff"; email: string; globalAdmin: boolean }
  | {
      kind: "unverified";
      email: string;
      provider: string;
      /** May the hub fire the one-shot silent re-verify redirect? */
      silentEligible: boolean;
      /** The aix_rv guard cookie is present: an attempt already ran. */
      attempted: boolean;
      /** xl.net/ai.xl.net: the email-link option is structurally dead
       * (magic links are never minted for staff domains) - render the
       * Google-only verify screen. */
      reservedDomain: boolean;
    }
  | { kind: "principal"; principal: RoadmapPrincipal };

/**
 * HUB-RENDER classification ONLY (§5.18 round 2, the re-login fix). Never
 * used by APIs, step pages, or server actions - those keep the require*
 * guards and the strict mv gate. Ordering is the fix: staff BEFORE the
 * trusted check (catches pre-hardening staff sessions) AND before the
 * principal path (xl.net is RESERVED, so a trusted staff session would
 * otherwise land in the "use your work email" explainer).
 */
export async function readRoadmapHubView(): Promise<RoadmapHubView> {
  const session = await readSession(siteConfig);
  if (!session) return { kind: "anonymous" };
  if (isStaffSession(session)) {
    // globalAdmin, not bare-admin: inside this branch isStaffSession has
    // already proven provider google + exact-label xl.net, so
    // isGlobalAdminSession carries full verifiedWebAdmin semantics. RENDER
    // decisions only; every staff write re-derives requireGlobalAdmin.
    return {
      kind: "staff",
      email: session.email,
      globalAdmin: isGlobalAdminSession(session),
    };
  }
  if (!isTrustedSession(session)) {
    const { cookies } = await import("next/headers");
    const jar = await cookies();
    const domain = emailDomain(session.email);
    return {
      kind: "unverified",
      email: session.email,
      provider: session.provider,
      silentEligible: (SILENT_REVERIFY_PROVIDERS as readonly string[]).includes(
        session.provider?.trim().toLowerCase() ?? ""
      ),
      attempted: jar.get("aix_rv") !== undefined,
      reservedDomain:
        domain !== null &&
        (RESERVED_DOMAINS_LIST as readonly string[]).includes(domain),
    };
  }
  const result = await readRoadmapPrincipal();
  if (!result.ok) {
    // isTrustedSession passed above, so the only reachable denial shapes are
    // race artifacts; render them as unverified rather than crash.
    return {
      kind: "unverified",
      email: session.email,
      provider: session.provider,
      silentEligible: false,
      attempted: true,
      reservedDomain: false,
    };
  }
  return { kind: "principal", principal: result.principal };
}

/**
 * The single decision. Returns the principal or a typed denial; callers
 * choose how to render it (a page explains, an API returns JSON). An
 * untrusted session yields NO company data, not even the company's name.
 */
export async function readRoadmapPrincipal(): Promise<
  { ok: true; principal: RoadmapPrincipal } | RoadmapDenial
> {
  const session = await readSession(siteConfig);
  if (!session) return { ok: false, reason: "unauthenticated" };
  if (!isTrustedSession(session)) {
    return { ok: false, reason: "untrusted_provider", email: session.email };
  }

  const domain = emailDomain(session.email);
  if (domain === null) {
    // A trusted session with an unparseable address gets the consumer-domain
    // treatment: signed in, trusted, no workspace possible.
    return {
      ok: true,
      principal: {
        userId: session.userId,
        email: session.email,
        emailDomain: "",
        provider: session.provider,
        trusted: true,
        domainEligible: false,
        company: null,
        companyRole: null,
        globalAdmin: isGlobalAdminSession(session),
      },
    };
  }

  const eligible = isCompanyEligibleDomain(domain);
  const company = eligible ? await companyForDomainRow(domain) : null;
  // The role predicate is ALWAYS (company_id AND user_id); a grant for some
  // other company must never follow this user here.
  const role = company
    ? (await companyAdminRole(company.id, session.userId))
      ? ("admin" as const)
      : ("member" as const)
    : null;

  return {
    ok: true,
    principal: {
      userId: session.userId,
      email: session.email,
      emailDomain: domain,
      provider: session.provider,
      trusted: true,
      domainEligible: eligible,
      company,
      companyRole: role,
      globalAdmin: isGlobalAdminSession(session),
    },
  };
}

/** verifiedWebAdmin semantics (src/lib/work/http.ts): ADMIN_EMAIL membership
 * alone is forgeable via the Microsoft common-tenant lane, so global-admin
 * power additionally requires the Google provider and an exact-label xl.net
 * domain. Bare isAdmin appears nowhere in this feature. */
function isGlobalAdminSession(s: SessionData): boolean {
  return (
    isAdmin(s.email) &&
    isRfpProvider(s.provider) &&
    emailDomain(s.email) === "xl.net"
  );
}

/**
 * Page/layout/server-action guard. Redirects a signed-out visitor to login;
 * returns the principal or denial otherwise so pages explain themselves
 * rather than bouncing a session they have already satisfied (rfp doctrine).
 */
export async function requireRoadmapPage(
  redirectTo: string
): Promise<
  | { ok: true; principal: RoadmapPrincipal }
  | Exclude<RoadmapDenial, { reason: "unauthenticated" }>
> {
  const result = await readRoadmapPrincipal();
  if (!result.ok && result.reason === "unauthenticated") {
    redirect(`/login?redirect=${encodeURIComponent(redirectTo)}`);
  }
  return result as
    | { ok: true; principal: RoadmapPrincipal }
    | Exclude<RoadmapDenial, { reason: "unauthenticated" }>;
}

function denialResponse(reason: string, status: number): Response {
  return Response.json(
    { error: { code: reason } },
    { status, headers: { "cache-control": "no-store, private" } }
  );
}

/** Route-handler guard: the principal, or a Response to return as-is. */
export async function requireRoadmapUser(): Promise<
  { ok: true; principal: RoadmapPrincipal } | { ok: false; response: Response }
> {
  const result = await readRoadmapPrincipal();
  if (result.ok) return result;
  return {
    ok: false,
    response: denialResponse(
      result.reason,
      result.reason === "unauthenticated" ? 401 : 403
    ),
  };
}

/** Member of an active company (or a global admin acting on any company via
 * /admin/roadmap, which passes companyId explicitly and never through here).
 * companyId ALWAYS comes from the server-derived principal, never a request
 * param. */
export async function requireCompanyMember(): Promise<
  | { ok: true; principal: RoadmapPrincipal & { company: NonNullable<RoadmapPrincipal["company"]> } }
  | { ok: false; response: Response }
> {
  const result = await requireRoadmapUser();
  if (!result.ok) return result;
  const p = result.principal;
  if (!p.company) {
    return { ok: false, response: denialResponse("no_company", 403) };
  }
  return {
    ok: true,
    principal: p as RoadmapPrincipal & {
      company: NonNullable<RoadmapPrincipal["company"]>;
    },
  };
}

export async function requireCompanyAdmin(): Promise<
  | { ok: true; principal: RoadmapPrincipal & { company: NonNullable<RoadmapPrincipal["company"]> } }
  | { ok: false; response: Response }
> {
  const result = await requireCompanyMember();
  if (!result.ok) return result;
  if (result.principal.companyRole !== "admin") {
    return { ok: false, response: denialResponse("not_company_admin", 403) };
  }
  return result;
}

/** Global-admin guard for /admin/roadmap surfaces and cross-company request
 * params. Reads the session directly (a global admin needs no roadmap trust
 * claim: the provider requirement IS the anti-forgery control, and staff
 * sessions predate the hardened callbacks). */
export async function requireGlobalAdmin(): Promise<
  | { ok: true; email: string; userId: string }
  | { ok: false; response: Response }
> {
  const session = await readSession(siteConfig);
  if (!session) {
    return { ok: false, response: denialResponse("unauthenticated", 401) };
  }
  if (!isGlobalAdminSession(session)) {
    return { ok: false, response: denialResponse("forbidden", 403) };
  }
  return { ok: true, email: session.email, userId: session.userId };
}

/** Page variant: redirect signed-out, boolean for signed-in. */
export async function readGlobalAdminPage(): Promise<{
  email: string;
} | null> {
  const session = await readSession(siteConfig);
  if (!session || !isGlobalAdminSession(session)) return null;
  return { email: session.email };
}
