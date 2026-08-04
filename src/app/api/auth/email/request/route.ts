// Magic-link REQUEST (§5.18) — host wrapper over the module factory with two
// host jobs the module cannot do:
//
// 1. STAFF-DOMAIN BLOCK. xl.net / ai.xl.net addresses get the module's own
//    anti-enumeration {ok:true} WITHOUT a token ever being minted: a live
//    sign-in link mailed to tron.netter@ai.xl.net would land INSIDE the
//    machine-read intake pipeline, and a magic link to ADMIN_EMAIL would
//    downgrade staff admin auth to mail interception. This must NOT be done
//    via config.auth.rejectEmail — that hook is provider-global (the module
//    consults it on every Google/Microsoft login too) and would lock all
//    staff out of every sign-in lane.
//
// 2. RETURN-TO CAPTURE. The module's verify handler always lands on "/"
//    (no redirect parameter exists in its contract). The login form sends
//    the intended return path here; we validate it against our own origin
//    and park it in a short-lived cookie that the host verify wrapper
//    consumes. auth.postLoginRedirect is NOT used for this: it also fires
//    for OAuth and would change staff login landing behavior.
import { createMagicLinkRequestHandler } from "@aicompany/core/auth/magic-link";
import { validateRedirect } from "@aicompany/core/auth/helpers";
import { cookies } from "next/headers";
import { siteConfig } from "site.config";
import { emailDomain } from "@/lib/rfp/access";
import { RESERVED_DOMAINS } from "@/lib/roadmap/domains";

const RETURN_COOKIE = "aix_return";
const moduleHandler = createMagicLinkRequestHandler(siteConfig);

export async function POST(req: Request): Promise<Response> {
  let email = "";
  let redirect: string | null = null;
  try {
    const body = (await req.json()) as { email?: unknown; redirect?: unknown };
    email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    redirect = typeof body.redirect === "string" ? body.redirect : null;
  } catch {
    email = "";
  }

  if (redirect) {
    const safe = validateRedirect(siteConfig, redirect);
    if (safe !== "/") {
      const jar = await cookies();
      jar.set(RETURN_COOKIE, safe, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: 600,
      });
    }
  }

  const domain = emailDomain(email);
  if (domain !== null && (RESERVED_DOMAINS as readonly string[]).includes(domain)) {
    // Identical shape to the module's success answer (anti-enumeration); no
    // token minted, so /auth/email/verify can never sign a staff session.
    return Response.json({ ok: true });
  }

  // The module handler re-reads the JSON body from a fresh Request (the
  // original body stream is consumed above).
  return moduleHandler(
    new Request(req.url, {
      method: "POST",
      headers: req.headers,
      body: JSON.stringify({ email }),
    })
  );
}
