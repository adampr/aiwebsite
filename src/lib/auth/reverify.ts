// Silent re-verify identity binding (§5.18 round 2). The aix_rv guard
// cookie carries this HMAC of the INITIATING session's email; the hardened
// callback recomputes it against the account the provider returns and
// refuses to replace the session on mismatch (OIDC login_hint is
// non-binding, so without this a browser signed into a different account at
// the same provider would be silently swapped into the current session).
//
// SCOPE OF THAT REFUSAL (Microsoft parity round, 2026-08-09): the binding
// must apply ONLY to the silent round-trip it was armed for. aix_rv is a
// 10-minute path=/ cookie, so before this round any INTERACTIVE sign-in
// landing on a callback while it was set was judged by it too - and a user
// who clicked "Sign in with Google/Microsoft" and picked a DIFFERENT address
// had their perfectly good login silently discarded with no message. The
// aix_rv_state cookie below pins the OAuth `state` of the round-trip the
// reverify route started; the callback applies the binding only when the
// returned state matches, and otherwise clears both cookies and lets the
// interactive login proceed normally. A deliberate, user-initiated sign-in
// is not the threat model here - a SILENT swap with zero UI is.

import crypto from "node:crypto";

export const REVERIFY_COOKIE = "aix_rv";
/** OAuth `state` of the silent round-trip aix_rv was armed for. */
export const REVERIFY_STATE_COOKIE = "aix_rv_state";

export function reverifyBinding(email: string): string {
  return crypto
    .createHmac("sha256", process.env.SESSION_COOKIE_SECRET ?? "")
    .update(`rv:${email.toLowerCase()}`)
    .digest("hex");
}
