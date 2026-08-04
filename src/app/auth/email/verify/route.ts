// Magic-link VERIFY (§5.18) — host wrapper over the module factory. The
// module handler always 302s to "/" on success (its contract carries no
// return path); this wrapper substitutes the validated return-to path parked
// by the request route's cookie, so an approval-email recipient who signs in
// via email link lands back on the approval page instead of the homepage.
// Error redirects (to /login?error=...) pass through untouched.
import { createMagicLinkVerifyHandler } from "@aicompany/core/auth/magic-link";
import { validateRedirect } from "@aicompany/core/auth/helpers";
import { cookies } from "next/headers";
import { siteConfig } from "site.config";

const RETURN_COOKIE = "aix_return";
const moduleHandler = createMagicLinkVerifyHandler(siteConfig);

export async function GET(req: Request): Promise<Response> {
  const res = await moduleHandler(req);
  const location = res.headers.get("location");
  if (!location) return res;

  const success =
    res.status >= 300 &&
    res.status < 400 &&
    new URL(location, siteConfig.site.baseUrl).pathname === "/" &&
    !location.includes("/login?error=");
  if (!success) return res;

  const jar = await cookies();
  const target = jar.get(RETURN_COOKIE)?.value;
  if (!target) return res;
  jar.delete(RETURN_COOKIE);
  const safe = validateRedirect(siteConfig, target);
  if (safe === "/") return res;
  // The module handler already set the session cookie on the jar; only the
  // Location changes.
  return Response.redirect(new URL(safe, siteConfig.site.baseUrl), 302);
}
