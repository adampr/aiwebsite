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
//  - EVERY DECIDED STATE CARRIES ITS DATE. The first version of this file
//    said "Reached this address (HTTP 200)." in the present tense while the
//    timestamp sat unused in the database, so a proxy confirmed in August
//    still read as current in December. A claim about the past has to look
//    like one.
//  - The failure text never distinguishes a refused port from a DNS
//    failure. That distinction is exactly what would turn this feature into
//    a port scanner pointed at our own network, so the checker collapses
//    them and the copy follows.
//  - The three counting rungs say DIFFERENT things, because they rest on
//    different evidence. Only rung 1 may use the word "reached".

import type { UrlCheckFailReason } from "@/lib/roadmap/url-check";

/** Short absolute date. Deliberately not "3 days ago": a relative phrase
 * hides how stale a claim really is once it passes a few weeks. */
export function checkDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** RUNG 1. A server answered us. That is all this says. */
export function reachedLine(
  httpStatus: number | null,
  at: string | null
): string {
  const when = checkDate(at);
  const code = httpStatus ? ` (HTTP ${httpStatus})` : "";
  return when
    ? `We reached this address on ${when}${code}.`
    : `We reached this address${code}.`;
}

/** RUNG 2. Machine-checked and carefully bounded: a name inside the
 * company's own verified domain that points onto a private network. We did
 * NOT connect to it and could not have. */
export function internalLine(at: string | null): string {
  const when = checkDate(at);
  const tail =
    "This address is inside your domain and points to a private network, so it counts. We never connect to private addresses, so we have not tested it ourselves.";
  return when ? `Checked ${when}. ${tail}` : tail;
}

/** RUNG 3. A person's claim, and the copy says so in those words. */
export function attestedLine(by: string | null, at: string | null): string {
  const when = checkDate(at);
  const who = by || "an admin";
  return when
    ? `Confirmed by ${who} on ${when} as reachable inside your network. We could not reach it from here, so this counts on their word.`
    : `Confirmed by ${who} as reachable inside your network. We could not reach it from here, so this counts on their word.`;
}

/** Failing, but still counting because the grace window has not closed.
 * Warning BEFORE the step drops is the whole point of the window. */
export function graceLine(graceUntil: string | null): string {
  const when = checkDate(graceUntil);
  return when
    ? `Our last check could not reach this address. It still counts until ${when}, and stops counting after that unless a check succeeds.`
    : "Our last check could not reach this address. It stops counting shortly unless a check succeeds.";
}

/** What the admin sees when a check fails. Actionable, and deliberately
 * incurious about WHY at the network layer. */
export function failureLine(
  reason: string | null,
  httpStatus: number | null,
  at: string | null
): string {
  const when = checkDate(at);
  const prefix = when ? `Checked ${when}. ` : "";
  switch (reason as UrlCheckFailReason) {
    case "invalid":
      return `${prefix}We could not read that as a web address. Check it and save again.`;
    case "not_public":
      return `${prefix}That address is not reachable from the public internet. If it lives on your own network, confirm it below and it will count.`;
    case "http_status":
      return httpStatus
        ? `${prefix}A server answered with ${httpStatus}, so the address itself is wrong or the page is broken. This one needs fixing rather than confirming.`
        : `${prefix}A server answered, but not in a way we could confirm.`;
    case "self_host":
      return `${prefix}That address points back at this site, so there is nothing for us to confirm. Use the address your builders actually call.`;
    case "redirect_loop":
      return httpStatus
        ? `${prefix}That address answered with a redirect we could not follow.`
        : `${prefix}That address redirected too many times for us to follow.`;
    case "unreachable":
    default:
      return `${prefix}We could not reach that address. It may be offline, blocking us, or on a network we cannot see. You can retry, or confirm it below if it is internal.`;
  }
}

/** Not yet attempted, or the attempt did not complete. */
export const UNCHECKED_LINE =
  "Saved. We have not confirmed this address yet, so it is not counting toward this step. Retry when you are ready.";

/** The standing caveat, rendered once per page rather than per field. */
export const CHECK_SCOPE_NOTE =
  "We confirm only that the address answers us from the public internet. We do not inspect, test, or approve what is behind it.";

/** The rule the owner asked to be visible, in the words the UI uses. */
export const NOT_COUNTED_NOTE =
  "Addresses we cannot reach are saved but do not count toward your roadmap until a check passes or you confirm they are internal.";

/** The tools variant (owner directive 2026-08-20): on tool cards only the
 * LINK gates counting, and the instructions field has no check or confirm
 * lane at all, so the generic note above would promise levers that do not
 * exist there. Singleton forms keep NOT_COUNTED_NOTE. */
export const TOOL_NOT_COUNTED_NOTE =
  "A tool link we cannot reach is saved but does not count toward your roadmap until a check passes or you confirm it is internal. The instructions link is informational and never gates this step.";

/** What an admin is actually agreeing to when they confirm an internal
 * address. Shown at the point of the click, never buried: this is a named
 * claim that makes a step count, and it should read like one. */
export const ATTEST_PROMPT =
  "Confirm that this address works for your builders on your own network. Your name and the date are recorded against it, and your colleagues and XL.net can see who confirmed it.";

export const ATTEST_ACTION = "It is internal, confirm it";
export const ATTEST_WITHDRAW = "Remove my confirmation";

/** The one-word status token beside each line. "Confirmed" is reserved for
 * a rung we actually verified; a human claim says so. */
export function stateToken(state: string, counting: boolean): string {
  if (state === "ok") return "Reached";
  if (state === "internal") return "Internal";
  // NOT "Confirmed by you": every viewer sees this token, including
  // members and admins who confirmed nothing. The line beside it names the
  // actual person.
  if (state === "attested") return "Confirmed by an admin";
  if (state === "failed") return counting ? "Failing" : "Not counting";
  return "Not checked";
}
