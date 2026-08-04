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
// exchange, profile fetch, rejectEmail/classifyUser hooks, upsertUser,
// auth_logs, session cookie, redirect) with one addition: a per-login
// HMAC-covered session claim `mv: true` stamped ONLY when the provider
// proved the email. The claim is per-login, never a stored users-row flag —
// a stored flag would let a later forged login inherit an earlier genuine
// verification. Sessions minted here are byte-compatible with the module's
// (same signSession, same cookie); everything else on the site ignores `mv`.
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
  RejectedError,
  upsertUser,
  validateRedirect,
} from "@aicompany/core/auth/helpers";
import { signSession } from "@aicompany/core/auth/session";
import { logStage } from "@aicompany/core/lib/log";
import type { SiteConfig } from "@aicompany/core/config/types";

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

    try {
      const lowered = email.toLowerCase();
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
      const jar = await cookies();
      jar.set(config.auth.sessionCookieName, token, sessionCookieOptions(config));

      const requestedRaw = await consumeOAuthRedirect(config);
      const requested = requestedRaw
        ? validateRedirect(config, requestedRaw)
        : null;
      const redirect =
        config.auth.postLoginRedirect?.(user, requested) ?? requested ?? "/";
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
