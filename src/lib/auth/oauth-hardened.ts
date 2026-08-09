// Host-owned OAuth callback handlers for Google and Microsoft (§5.18).
//
// WHY THESE EXIST (and the module's createOAuthCallbackHandler is not used):
// the roadmap's tenancy boundary is the session's email DOMAIN, so the email
// claim must be VERIFIED, and the module callbacks cannot say whether it was:
//  - Google: the module reads only {email, name} from the v3 userinfo
//    endpoint and DISCARDS email_verified. A Google account can carry an
//    unverified email at an arbitrary domain (the /rfp Google-trust argument
//    is specific to xl.net being a Workspace domain and does not transfer).
//  - Microsoft: MICROSOFT_TENANT_ID=common + Graph /me `mail` being
//    PATCH-writable is the published nOAuth forgery. Microsoft's mitigation
//    is the id_token's `xms_edov` claim (email-domain-ownership-verified),
//    which the module never sees because its exchangeCode keeps only the
//    access_token.
//
// These handlers run the SAME pipeline as the module (state check, token
// exchange, profile fetch, archived refusal, rejectEmail/classifyUser hooks,
// upsertUser, auth_logs, session cookie, redirect) with one addition: a
// per-login HMAC-covered session claim `mv: true` stamped ONLY when the
// provider proved the email. The claim is per-login, never a stored users-row
// flag — a stored flag would let a later forged login inherit an earlier
// genuine verification. Sessions minted here are byte-compatible with the
// module's (same signSession, same cookie); everything else on the site
// ignores `mv`.
//
// PIPELINE-PARITY RULE (do not break): because this file REIMPLEMENTS the
// pipeline, nothing the module adds to `handleOAuthUser()` reaches the live
// site automatically. Every refusal the module gates sign-in on must be
// mirrored here by hand. Today that is `isEmailArchived()` (module §5.5
// v1.74); when the module grows another, add it below in the same place.
// Both callbacks on this site (Google and Microsoft) and the §5.18 silent
// re-verify lane all mint their session inside the single try block below,
// so a refusal placed at its head covers every session-minting path.
//
// EMAIL CONTINUITY (do not change): the upsert email stays EXACTLY what the
// module used — Google userinfo `email`, Microsoft Graph `mail ||
// userPrincipalName`. users.email is UNIQUE and keys the upsert; sourcing it
// from the id_token instead would fork existing accounts whose token email
// differs from their Graph mail (aliases are common in M365). The id_token
// is used only to JUDGE the email, never to BE it.
//
// STRICTNESS RULE: Entra serializes manifest-declared optional claims as
// JSON strings on some tenants, so `xms_edov` can arrive as the STRING
// "false" — and Boolean("false") is true. Every verification claim here goes
// through strictClaimTrue(), which accepts ONLY boolean true or the exact
// string "true". Anything else (false, "false", "False", 1, absence) is
// unverified. scripts/roadmap-tests.ts pins this.
//
// Signature verification of the id_token is deliberately skipped and
// documented: the token arrives directly from the provider's token endpoint
// over TLS in a confidential-client exchange (OIDC Core §3.1.3.7 permits TLS
// channel validation in exactly this flow), so a JWKS round-trip would add a
// failure mode without adding trust. aud/iss/exp are still validated.

import { cookies } from "next/headers";
import {
  consumeOAuthRedirect,
  consumeOAuthState,
  insertAuthLog,
  isEmailArchived,
  RejectedError,
  upsertUser,
  validateRedirect,
} from "@aicompany/core/auth/helpers";
import { archivedLoginMessage } from "@aicompany/core/auth/login-errors";
import { signSession } from "@aicompany/core/auth/session";
import { logStage } from "@aicompany/core/lib/log";
import type { SiteConfig } from "@aicompany/core/config/types";
import {
  REVERIFY_COOKIE,
  REVERIFY_STATE_COOKIE,
  reverifyBinding,
} from "@/lib/auth/reverify";

/** ONLY boolean true or the exact string "true" count as verified. */
export function strictClaimTrue(v: unknown): boolean {
  return v === true || v === "true";
}

/** Decode a JWT payload without signature verification (see header note). */
export function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const payload = JSON.parse(json);
    return typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

type TokenSet = { accessToken: string; idToken: string | null };

async function exchangeGoogle(
  config: SiteConfig,
  code: string
): Promise<TokenSet | null> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID || "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
      redirect_uri:
        process.env.GOOGLE_REDIRECT_URI ||
        `${config.site.baseUrl}/auth/google/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) return null;
  const tokens = (await res.json()) as {
    access_token?: string;
    id_token?: string;
  };
  if (!tokens.access_token) return null;
  return { accessToken: tokens.access_token, idToken: tokens.id_token ?? null };
}

async function exchangeMicrosoft(
  config: SiteConfig,
  code: string
): Promise<TokenSet | null> {
  const tenant = process.env.MICROSOFT_TENANT_ID || "common";
  const res = await fetch(
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.MICROSOFT_CLIENT_ID || "",
        client_secret: process.env.MICROSOFT_CLIENT_SECRET || "",
        redirect_uri:
          process.env.MICROSOFT_REDIRECT_URI ||
          `${config.site.baseUrl}/auth/microsoft/callback`,
        grant_type: "authorization_code",
      }),
    }
  );
  if (!res.ok) return null;
  const tokens = (await res.json()) as {
    access_token?: string;
    id_token?: string;
  };
  if (!tokens.access_token) return null;
  return { accessToken: tokens.access_token, idToken: tokens.id_token ?? null };
}

/**
 * Google mail-verified verdict. The v3 userinfo response carries
 * email_verified alongside email; strict-normalized. No id_token decode is
 * needed for Google — userinfo rides the access token from the same
 * confidential exchange.
 */
function googleVerdict(profile: {
  email: string | null;
  emailVerified: unknown;
}): boolean {
  return Boolean(profile.email) && strictClaimTrue(profile.emailVerified);
}

/**
 * Microsoft mail-verified verdict from the id_token:
 *  - aud must be our client id, iss must be the v2.0 issuer for the token's
 *    own tid, exp must be in the future;
 *  - xms_edov must be STRICTLY true (Microsoft sets it only when the tenant
 *    has DNS-proven ownership of the email's domain);
 *  - the token's email claim must exist and equal the Graph profile email
 *    (case-insensitive) — the verdict must be about the address we store.
 * Missing claims (Entra app not configured with the optional claims) yield
 * false: sign-in still succeeds at exactly today's trust level; the roadmap
 * treats the session as unverified and offers the email-link lane.
 */
function microsoftVerdict(idToken: string | null, graphEmail: string): boolean {
  if (!idToken) return false;
  const claims = decodeJwtPayload(idToken);
  if (!claims) return false;
  const aud = claims.aud;
  const clientId = process.env.MICROSOFT_CLIENT_ID || "";
  if (!clientId || aud !== clientId) return false;
  const tid = claims.tid;
  if (typeof tid !== "string" || !tid) return false;
  const iss = claims.iss;
  if (iss !== `https://login.microsoftonline.com/${tid}/v2.0`) return false;
  const exp = claims.exp;
  if (typeof exp !== "number" || exp <= Math.floor(Date.now() / 1000))
    return false;
  if (!strictClaimTrue(claims.xms_edov)) return false;
  const email = claims.email;
  if (typeof email !== "string" || !email) return false;
  return email.trim().toLowerCase() === graphEmail.trim().toLowerCase();
}

function sessionCookieOptions(config: SiteConfig) {
  // Replicates the module's private cookieOptions() — the price of signing a
  // session with a per-login claim the module's setSessionCookie cannot
  // carry (its extras hook sees only the users row).
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: config.auth.sessionTtlDays * 24 * 60 * 60,
  };
}

/** Inline replica of the module's private loginErrorRedirect, reusing its
 * error-code vocabulary so the login page's error map needs no changes. */
function loginErrorRedirect(config: SiteConfig, code: string): Response {
  return Response.redirect(
    new URL(`/login?error=${code}`, config.site.baseUrl),
    302
  );
}

export function createHardenedCallbackHandler(
  config: SiteConfig,
  provider: "google" | "microsoft"
): (req: Request) => Promise<Response> {
  const slug = config.site.slug;
  return async (req: Request): Promise<Response> => {
    const fail = (code: string): Response => {
      logStage({
        slug,
        channel: "auth",
        stage: "dropped",
        ok: false,
        detail: `${provider} hardened callback: ${code}`,
      });
      return loginErrorRedirect(config, code);
    };

    logStage({
      slug,
      channel: "auth",
      stage: "inbound",
      ok: true,
      detail: `${provider} callback`,
    });

    const params = new URL(req.url).searchParams;
    // §5.18 silent re-verify (aix_rv present = a silent round-trip is in
    // flight for an EXISTING session). aix_rv_state pins WHICH round-trip:
    // the cookie is path=/ for 10 minutes, so without it an interactive
    // sign-in landing here while it is set would be judged by the binding
    // below too (parity round 2026-08-09; see src/lib/auth/reverify.ts).
    const jar = await cookies();
    const rvCookie = jar.get(REVERIFY_COOKIE)?.value ?? null;
    const rvState = jar.get(REVERIFY_STATE_COOKIE)?.value ?? null;
    const containedTarget = async (): Promise<string> => {
      const raw = await consumeOAuthRedirect(config);
      const validated = raw ? validateRedirect(config, raw) : "/roadmap";
      // "/" is validateRedirect's rejection sentinel, not a destination in
      // this lane: the whole point is landing back where verification began.
      return validated === "/" ? "/roadmap" : validated;
    };
    // CONTAINED ERROR BRANCH - scoped to exactly the prompt=none failure
    // shape (an error param while the guard cookie is set). Both authorities
    // answer login_required / interaction_required (Entra also
    // consent_required) when they cannot proceed invisibly; bouncing that to /login?error would strand a SIGNED-IN
    // user on the login page, which is the reported bug. Every OTHER
    // failure (invalid_state, exchange, userinfo) keeps today's
    // /login?error path: invalid_state is the CSRF control's signal and
    // must stay user-visible.
    if (rvCookie !== null && params.get("error")) {
      logStage({
        slug,
        channel: "auth",
        stage: "dropped",
        ok: false,
        detail: `${provider} silent reverify declined: ${params.get("error")?.slice(0, 40)}`,
      });
      // Keep aix_rv: it is the loop guard; the hub now renders the
      // verification screen instead of redirecting again.
      return Response.redirect(
        new URL(await containedTarget(), config.site.baseUrl),
        302
      );
    }
    const code = params.get("code");
    const state = params.get("state");
    if (!code || !state) return fail("missing_params");
    if (!(await consumeOAuthState(config, state))) return fail("invalid_state");

    const configured =
      provider === "google"
        ? Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)
        : Boolean(
            process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET
          );
    if (!configured) return fail("provider_unconfigured");

    const tokens = await (provider === "google"
      ? exchangeGoogle(config, code)
      : exchangeMicrosoft(config, code)
    ).catch(() => null);
    if (!tokens) return fail("token_exchange");

    // Profile fetch: SAME source and precedence as the module (email
    // continuity; see header).
    let email: string | null = null;
    let displayName: string | null = null;
    let mv = false;
    if (provider === "google") {
      const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      }).catch(() => null);
      if (!res || !res.ok) return fail("userinfo");
      const info = (await res.json()) as {
        email?: string;
        email_verified?: unknown;
        name?: string;
      };
      email = info.email || null;
      displayName = info.name || null;
      mv = googleVerdict({ email, emailVerified: info.email_verified });
    } else {
      const res = await fetch("https://graph.microsoft.com/v1.0/me", {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      }).catch(() => null);
      if (!res || !res.ok) return fail("userinfo");
      const info = (await res.json()) as {
        mail?: string | null;
        userPrincipalName?: string | null;
        displayName?: string | null;
      };
      email = info.mail || info.userPrincipalName || null;
      displayName = info.displayName || null;
      mv = email ? microsoftVerdict(tokens.idToken, email) : false;
    }
    if (!email) return fail("no_email");

    // §5.18 IDENTITY BINDING: a silent-reverify round-trip may only refresh
    // the session it was started for. login_hint is non-binding in OIDC, so
    // a browser signed into a DIFFERENT account at the same provider would
    // otherwise get that account silently swapped into this session with
    // zero UI. On
    // mismatch: no upsert, no cookie write - the existing session stays -
    // and the user lands on the verification screen (aix_rv retained stops
    // the redirect loop).
    // Applies ONLY to the silent round-trip aix_rv_state names. A
    // user-initiated sign-in (different state, or no state cookie) proceeds
    // normally: it is deliberate, has full UI, and discarding it silently
    // was the reported dead end.
    const isSilentRoundTrip = rvCookie !== null && rvState === state;
    if (isSilentRoundTrip && reverifyBinding(email) !== rvCookie) {
      logStage({
        slug,
        channel: "auth",
        stage: "dropped",
        ok: false,
        detail: `${provider} silent reverify account mismatch; session untouched`,
      });
      await insertAuthLog(config, {
        userId: null,
        email,
        provider,
        req,
        success: false,
        failureReason: "silent reverify account mismatch",
      });
      return Response.redirect(
        new URL(await containedTarget(), config.site.baseUrl),
        302
      );
    }

    try {
      const lowered = email.toLowerCase();
      // §5.5 v1.74 ARCHIVED ACCOUNTS — the module's handleOAuthUser() refusal
      // never runs on this site (see PIPELINE-PARITY RULE in the header), so
      // without this an archived operator-blocked account would get a SUCCESS
      // auth_log, a refreshed last_login_at, and a signed session cookie.
      // Placed before rejectEmail and before any write, and returned rather
      // than thrown so it keeps its own error code instead of collapsing into
      // the catch's generic "rejected". FAILS CLOSED: a throwing query lands
      // in the catch below (auth_logs failure + /login?error=rejected) — a
      // revocation control must not open on a DB blip.
      if (await isEmailArchived(lowered)) {
        await insertAuthLog(config, {
          userId: null,
          email: lowered,
          provider,
          req,
          success: false,
          failureReason: "archived",
        });
        logStage({
          slug,
          channel: "auth",
          stage: "dropped",
          ok: false,
          detail: `${provider} hardened callback: account_archived`,
        });
        return Response.redirect(
          new URL(
            `/login?error=account_archived&message=${encodeURIComponent(
              archivedLoginMessage(config)
            )}`,
            config.site.baseUrl
          ),
          302
        );
      }
      const reason = await config.auth.rejectEmail?.(lowered);
      if (reason) throw new RejectedError(reason);
      const profile = { email: lowered, displayName, provider };
      const extra = (await config.auth.classifyUser?.(profile)) ?? {};
      const user = await upsertUser(config, profile, extra);
      await insertAuthLog(config, {
        userId: user.id,
        email: lowered,
        provider,
        req,
        success: true,
      });

      // The one deviation from the module pipeline: sign the session
      // ourselves so the per-login `mv` claim rides under the HMAC.
      const extras = (await config.auth.sessionExtras?.(user)) ?? {};
      const token = signSession(config, {
        ...extras,
        userId: user.id,
        email: user.email,
        displayName: user.displayName ?? null,
        provider: user.authProvider,
        ...(mv ? { mv: true } : {}),
      });
      jar.set(config.auth.sessionCookieName, token, sessionCookieOptions(config));

      const requestedRaw = await consumeOAuthRedirect(config);
      const requested = requestedRaw
        ? validateRedirect(config, requestedRaw)
        : null;
      let redirect =
        config.auth.postLoginRedirect?.(user, requested) ?? requested ?? "/";
      // §5.18 reverify lifecycle: delete the guard ONLY when mv was actually
      // minted (success-without-mv must not re-arm the auto-redirect - that
      // would loop full OAuth rounds); on success-without-mv, flag the
      // return so the verification screen can say what happened instead of
      // silently re-rendering itself after a manual attempt.
      if (rvCookie !== null && !isSilentRoundTrip) {
        // An interactive login superseded the pending silent round-trip:
        // drop the guard entirely so the hub can arm a fresh one later.
        jar.delete(REVERIFY_COOKIE);
        jar.delete(REVERIFY_STATE_COOKIE);
      } else if (rvCookie !== null) {
        if (mv) {
          jar.delete(REVERIFY_COOKIE);
          jar.delete(REVERIFY_STATE_COOKIE);
        } else if (redirect.startsWith("/") && !redirect.includes("verify=")) {
          redirect += `${redirect.includes("?") ? "&" : "?"}verify=${provider}_unverified`;
        }
      }
      logStage({
        slug,
        channel: "auth",
        stage: "reply_sent",
        ok: true,
        detail: `${provider} sign-in (mv=${mv})`,
      });
      return Response.redirect(new URL(redirect, config.site.baseUrl), 302);
    } catch (err) {
      const reason =
        err instanceof RejectedError ? err.reason : "sign-in completion failed";
      await insertAuthLog(config, {
        userId: null,
        email,
        provider,
        req,
        success: false,
        failureReason: reason,
      });
      return fail("rejected");
    }
  };
}
