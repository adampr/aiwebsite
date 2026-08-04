// GET - one-shot SILENT re-verify for a signed-in Google session without the
// mv claim (§5.18 round 2, the re-login fix). Sessions minted before the
// hardened callbacks carry no mv; forcing those users through a visible
// sign-in screen was the reported bug. This route bounces the browser
// through Google with prompt=none (never a chooser, never a password: it
// either succeeds invisibly or fails with an error param) so the hardened
// callback can mint mv on a session the user already owns.
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
//    the session when Google returns a different account (login_hint is
//    non-binding in OIDC - without this, a browser signed into a different
//    Google account gets silently swapped into this session).
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
import { REVERIFY_COOKIE, reverifyBinding } from "@/lib/auth/reverify";

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
  if (
    !(SILENT_REVERIFY_PROVIDERS as readonly string[]).includes(provider) ||
    !process.env.GOOGLE_CLIENT_ID ||
    !process.env.GOOGLE_CLIENT_SECRET
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
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri:
      process.env.GOOGLE_REDIRECT_URI ||
      `${siteConfig.site.baseUrl}/auth/google/callback`,
    response_type: "code",
    scope: "openid email profile",
    state,
    access_type: "online",
    // The whole point: no chooser, no password. Google answers with an
    // error param (login_required / interaction_required) when it cannot
    // proceed invisibly, and the callback's contained-error branch brings
    // the user straight back here.
    prompt: "none",
    login_hint: session.email,
  });
  return Response.redirect(
    `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
    302
  );
}
