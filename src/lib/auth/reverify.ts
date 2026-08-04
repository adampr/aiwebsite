// Silent re-verify identity binding (§5.18 round 2). The aix_rv guard
// cookie carries this HMAC of the INITIATING session's email; the hardened
// callback recomputes it against the account the provider returns and
// refuses to replace the session on mismatch (OIDC login_hint is
// non-binding, so without this a browser signed into a different Google
// account would be silently swapped into the current session).

import crypto from "node:crypto";

export const REVERIFY_COOKIE = "aix_rv";

export function reverifyBinding(email: string): string {
  return crypto
    .createHmac("sha256", process.env.SESSION_COOKIE_SECRET ?? "")
    .update(`rv:${email.toLowerCase()}`)
    .digest("hex");
}
