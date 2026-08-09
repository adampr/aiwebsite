// The ONE copy source for phases 09/10/11 verification states (§5.20).
// Same discipline as dkim-copy.ts: the step page, the hub card and the API
// response all read these, so a link's story cannot be told two ways.
//
// COPY RULES THIS FILE EXISTS TO ENFORCE:
//  - No em dashes anywhere (site rule).
//  - We say what we DID, never what it means. Reaching a URL proves a
//    server answered at that address. It does NOT prove the thing behind
//    it is an API proxy, is configured correctly, or is secure. Step 09 is
//    called "Secure AI Builders" because it is about giving builders a
//    sanctioned path, and nothing here may imply XL.net audited anything.
//  - The failure text never distinguishes a refused port from a DNS
//    failure. That distinction is exactly what would turn this feature
//    into a port scanner pointed at our own network, so the checker
//    collapses them and the copy follows.

import type { UrlCheckFailReason } from "@/lib/roadmap/url-check";

/** What the admin sees when a check fails. Actionable, and deliberately
 * incurious about WHY at the network layer. */
export function failureLine(
  reason: string | null,
  httpStatus: number | null
): string {
  switch (reason as UrlCheckFailReason) {
    case "invalid":
      return "We could not read that as a web address. Check it and save again.";
    case "not_public":
      return "That address is not reachable from the public internet, so we cannot confirm it from here. A private or internal address will never pass this check.";
    case "http_status":
      return httpStatus
        ? `The server answered with ${httpStatus}, so we could not confirm the address. Check the link points at a page that exists.`
        : "The server answered, but not in a way we could confirm.";
    case "self_host":
      return "That address points back at this site, so there is nothing for us to confirm. Use the address your builders actually call.";
    case "redirect_loop":
      return httpStatus
        ? "That address answered with a redirect we could not follow."
        : "That address redirected too many times for us to follow.";
    case "unreachable":
    default:
      return "We could not reach that address. It may be offline, blocking us, or slow to answer. You can retry.";
  }
}

/** The confirmed line. Says exactly what was established and no more. */
export function confirmedLine(httpStatus: number | null): string {
  return httpStatus
    ? `Reached this address (HTTP ${httpStatus}).`
    : "Reached this address.";
}

/** Not yet attempted, or the attempt did not complete. */
export const UNCHECKED_LINE =
  "Saved. We have not confirmed this address yet, so it is not counting toward this step. Retry when you are ready.";

/** The standing caveat, rendered once per page rather than per field. */
export const CHECK_SCOPE_NOTE =
  "We confirm only that the address answers us from the public internet. We do not inspect, test, or approve what is behind it.";

/** The rule the owner asked to be visible, in the words the UI uses. */
export const NOT_COUNTED_NOTE =
  "Addresses we cannot reach are saved but do not count toward your roadmap until a check passes.";
