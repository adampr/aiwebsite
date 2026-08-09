// GET - one-shot SILENT re-verify for a signed-in Google or Microsoft
// session without the mv claim (§5.18 round 2, the re-login fix; Microsoft
// arm added in the parity round 2026-08-09). Sessions minted before the
// hardened callbacks carry no mv; forcing those users through a visible
// sign-in screen was the reported bug. This route bounces the browser
// through the session's OWN authority with prompt=none (never a chooser,
// never a password: it either succeeds invisibly or fails with an error
// param) so the hardened callback can mint mv on a session the user already
// owns.
//
// Refutation-hardened:
//  - The redirect target is validated as the FIRST statement and every exit
//    uses it ("/" is validateRedirect's rejection sentinel, mapped to
//    /roadmap) - no raw-parameter redirects anywhere.
//  - OWN rate buckets (reverify:{userId} + reverify_ip:{ip}), never the
//    module's shared oauth_start:{ip} bucket: a page-render-driven redirect
//    must not be able to exhaust a NATed office's interactive login budget.
//  - IDENTITY BINDING: the aix_rv guard cookie carries an HMAC of the
//    INITIATING session's email; the hardened callback refuses to replace
//    the session when the authority returns a different account (login_hint
//    is non-binding in OIDC - without this, a browser signed into a
//    different account at the same provider gets silently swapped into this
//    session).
//  - The guard cookie is set before EVERY bounce back to the target
//    (including rate-limited and unconfigured exits): the hub redirects only
//    while the cookie is absent, so skipping the cookie on any exit would
//    loop hub -> reverify -> hub forever. Users behind a bounced attempt see
//    the verification screen, which is the safe floor.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { cookies } from "next/headers";
import { readSession } from "@aicompany/core/auth/session";
import { setOAuthCookies, validateRedirect } from "@aicompany/core/auth/helpers";
import { checkRateLimit } from "@aicompany/core/lib/rate-limit";
import { siteConfig } from "site.config";
import {
  isTrustedSession,
  SILENT_REVERIFY_PROVIDERS,
} from "@/lib/roadmap/access";
import {
  REVERIFY_COOKIE,
  REVERIFY_STATE_COOKIE,
  reverifyBinding,
} from "@/lib/auth/reverify";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const validated = validateRedirect(siteConfig, url.searchParams.get("redirect"));
  const target = validated === "/" ? "/roadmap" : validated;
  const toTarget = () =>
    Response.redirect(new URL(target, siteConfig.site.baseUrl), 302);

  const session = await readSession(siteConfig);
  if (!session) return toTarget(); // anonymous hub renders the teaser; no loop
  if (isTrustedSession(session)) return toTarget();

  const jar = await cookies();
  const arm = () =>
    jar.set(REVERIFY_COOKIE, reverifyBinding(session.email), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 600,
    });

  const provider = session.provider?.trim().toLowerCase() ?? "";
  const configured =
    provider === "google"
      ? Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)
      : provider === "microsoft"
        ? Boolean(
            process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET
          )
        : false;
  if (
    !(SILENT_REVERIFY_PROVIDERS as readonly string[]).includes(provider) ||
    !configured
  ) {
    arm();
    return toTarget();
  }
  const ip =
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown";
  const perUser = checkRateLimit(`reverify:${session.userId}`, {
    windowSec: 600,
    max: 1,
  });
  const perIp = checkRateLimit(`reverify_ip:${ip}`, { windowSec: 60, max: 10 });
  if (!perUser.allowed || !perIp.allowed) {
    arm();
    return toTarget();
  }

  arm();
  const state = await setOAuthCookies(siteConfig, target);
  // Pin the binding to THIS round-trip: the callback judges the returned
  // account against aix_rv only when the OAuth state matches this cookie,
  // so a user-initiated sign-in inside the 10-minute window is never
  // silently discarded (see src/lib/auth/reverify.ts).
  jar.set(REVERIFY_STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  // The whole point of prompt=none: no chooser, no password. Each authority
  // answers with an error param (login_required / interaction_required, and
  // for Entra also consent_required) when it cannot proceed invisibly, and
  // the callback's contained-error branch brings the user straight back
  // here. Both arms use the SAME redirect_uri fallbacks as the hardened
  // callback's token exchange, so the code is redeemed under the identical
  // URI it was minted for.
  if (provider === "google") {
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID || "",
      redirect_uri:
        process.env.GOOGLE_REDIRECT_URI ||
        `${siteConfig.site.baseUrl}/auth/google/callback`,
      response_type: "code",
      scope: "openid email profile",
      state,
      access_type: "online",
      prompt: "none",
      login_hint: session.email,
    });
    return Response.redirect(
      `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
      302
    );
  }
  // Microsoft arm (parity round): mirrors the module's own start spec
  // (packages/aicompany/src/auth/oauth-microsoft.ts) plus the silent params.
  // scope keeps User.Read (the hardened callback fetches Graph /me) and
  // email (the id_token email claim microsoftVerdict compares); no
  // access_type, which is Google-only. response_mode=query guarantees the
  // prompt=none error arrives as a query param where the contained-error
  // branch reads it.
  const tenant = process.env.MICROSOFT_TENANT_ID || "common";
  const params = new URLSearchParams({
    client_id: process.env.MICROSOFT_CLIENT_ID || "",
    redirect_uri:
      process.env.MICROSOFT_REDIRECT_URI ||
      `${siteConfig.site.baseUrl}/auth/microsoft/callback`,
    response_type: "code",
    scope: "openid email profile User.Read",
    state,
    response_mode: "query",
    prompt: "none",
    login_hint: session.email,
  });
  return Response.redirect(
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize?${params}`,
    302
  );
}
