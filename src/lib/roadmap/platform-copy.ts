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
// Type-only, and it must stay that way: this file is imported by a
// "use client" island, and platform.ts is pure but url-check.ts (which
// platform-copy already type-imports above) is not. An `import type` is
// erased at build, so neither line puts anything in the client bundle.
import type { SecureSummary } from "@/lib/roadmap/platform";

/**
 * A verification sentence, SPLIT at its one timestamp.
 *
 * These lines used to be finished strings built around a `checkDate()` that
 * pinned timeZone:"UTC" and printed no clock. Owner directive 2026-08-26:
 * every stored timestamp a person sees renders in that person's zone, with
 * a clock, deadlines included (graceLine's "still counts until X" is a
 * deadline). Neither half of that can be done with a string here:
 *
 *  - Unpinning the formatter is a HYDRATION MISMATCH, not a fix. FieldState
 *    lives in platform-islands.tsx, which carries "use client" but is
 *    seeded from server props (`useState<PublicLinkRow | null>(initial)`)
 *    by three async server pages (/roadmap/secure, /roadmap/tools,
 *    /roadmap/data). The row is present on the server pass, so the sentence
 *    IS server-rendered, and an unpinned formatter resolves to the VM's UTC
 *    there and to the reader's zone in the browser. React then throws away
 *    the server HTML for the whole route, which is exactly the defect
 *    a6b52ef fixed on /admin/roadmap.
 *  - The one helper that crosses that boundary is <LocalTime> (its useState
 *    seed is UTC-pinned unconditionally, so both sides emit identical bytes
 *    and the zone swap happens a tick after hydration), and <LocalTime> is
 *    an ELEMENT. An element cannot be interpolated into a template literal,
 *    so the sentence has to be assembled in JSX by the caller.
 *
 * `before` and `after` carry their own spacing and punctuation, so the
 * caller concatenates them with nothing of its own in between. `iso === null`
 * means this state has no usable timestamp: `before` then holds the WHOLE
 * fallback sentence and `after` is empty, so a caller that renders
 * before/after unconditionally is always correct.
 *
 * The copy rule at the top of this file is unchanged and still enforced by
 * scripts/roadmap-tests.ts: every decided state carries its date. It is now
 * carried as `iso` rather than as words inside the sentence.
 */
export interface CheckLine {
  before: string;
  iso: string | null;
  after: string;
}

/** The instant, or null if <LocalTime> could not format it.
 *
 * checkDate() swallowed an unparseable value by returning "", and the
 * sentence quietly fell back to its dateless form. <LocalTime> has no such
 * guard: Intl throws a RangeError on an Invalid Date, which would take the
 * whole step page down. So the guard has to survive the move, and it has to
 * live HERE rather than in the island, because here is where the dateless
 * fallback wording lives. */
function instant(iso: string | null): string | null {
  if (!iso) return null;
  return Number.isFinite(new Date(iso).getTime()) ? iso : null;
}

/** RUNG 1. A server answered us. That is all this says. */
export function reachedLine(
  httpStatus: number | null,
  at: string | null
): CheckLine {
  const code = httpStatus ? ` (HTTP ${httpStatus})` : "";
  const iso = instant(at);
  return iso
    ? { before: "We reached this address on ", iso, after: `${code}.` }
    : { before: `We reached this address${code}.`, iso: null, after: "" };
}

/** RUNG 2. Machine-checked and carefully bounded: a name inside the
 * company's own verified domain that points onto a private network. We did
 * NOT connect to it and could not have. */
export function internalLine(at: string | null): CheckLine {
  const tail =
    "This address is inside your domain and points to a private network, so it counts. We never connect to private addresses, so we have not tested it ourselves.";
  const iso = instant(at);
  return iso
    ? { before: "Checked ", iso, after: `. ${tail}` }
    : { before: tail, iso: null, after: "" };
}

/** RUNG 3. A person's claim, and the copy says so in those words. */
export function attestedLine(by: string | null, at: string | null): CheckLine {
  const who = by || "an admin";
  const tail =
    " as reachable inside your network. We could not reach it from here, so this counts on their word.";
  const iso = instant(at);
  return iso
    ? { before: `Confirmed by ${who} on `, iso, after: tail }
    : {
        before: `Confirmed by ${who}${tail}`,
        iso: null,
        after: "",
      };
}

/** Failing, but still counting because the grace window has not closed.
 * Warning BEFORE the step drops is the whole point of the window. */
export function graceLine(graceUntil: string | null): CheckLine {
  const iso = instant(graceUntil);
  return iso
    ? {
        before: "Our last check could not reach this address. It still counts until ",
        iso,
        after: ", and stops counting after that unless a check succeeds.",
      }
    : {
        before:
          "Our last check could not reach this address. It stops counting shortly unless a check succeeds.",
        iso: null,
        after: "",
      };
}

/** What the admin sees when a check fails. Actionable, and deliberately
 * incurious about WHY at the network layer. */
export function failureLine(
  reason: string | null,
  httpStatus: number | null,
  at: string | null
): CheckLine {
  const body = failureBody(reason, httpStatus);
  const iso = instant(at);
  return iso
    ? { before: "Checked ", iso, after: `. ${body}` }
    : { before: body, iso: null, after: "" };
}

/** The failure sentence without its date, so failureLine can put the date
 * either in front of it or nowhere. */
function failureBody(reason: string | null, httpStatus: number | null): string {
  switch (reason as UrlCheckFailReason) {
    case "invalid":
      return "We could not read that as a web address. Check it and save again.";
    case "not_public":
      return "That address is not reachable from the public internet. If it lives on your own network, confirm it below and it will count.";
    case "http_status":
      return httpStatus
        ? `A server answered with ${httpStatus}, so the address itself is wrong or the page is broken. This one needs fixing rather than confirming.`
        : "A server answered, but not in a way we could confirm.";
    case "self_host":
      return "That address points back at this site, so there is nothing for us to confirm. Use the address your builders actually call.";
    case "redirect_loop":
      return httpStatus
        ? "That address answered with a redirect we could not follow."
        : "That address redirected too many times for us to follow.";
    case "unreachable":
    default:
      return "We could not reach that address. It may be offline, blocking us, or on a network we cannot see. You can retry, or confirm it below if it is internal.";
  }
}

/** Not yet attempted, or the attempt did not complete. */
export const UNCHECKED_LINE =
  "Saved. We have not confirmed this address yet, so it is not counting toward this step. Retry when you are ready.";

/** A sentence with no timestamp in it, in CheckLine shape, so FieldState
 * renders every one of its five states through one code path. */
export function plainLine(text: string): CheckLine {
  return { before: text, iso: null, after: "" };
}

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

/**
 * STEP 09's SUMMARY SENTENCES, and why they are here rather than in the
 * three files that render them.
 *
 * The step page, the company hub and the staff hub each told this story in
 * their own ternary, and the two hub chains were a byte-identical
 * copy-paste pair. All three said the same false thing on 2026-08-29: XL.net
 * had BOTH components on file, the API proxy address was failing its
 * reachability check (truthfully - it times out from the VM), and every
 * surface reported the component as one the owner had not added yet. The
 * hub chains were worse than wrong, they were structurally unable to be
 * right: their `savedUnverified` arm sat BELOW the two single-half arms, so
 * whenever exactly one half counted an earlier arm always matched and the
 * saved-but-not-counting case could never be reached.
 *
 * So the rule these two functions exist to enforce: a surface may call a
 * component missing only from `*Added`, never from `*Counting`. Nothing
 * about CREDIT changes here. Half is still half.
 */

/** The step-09 hub card line, read by BOTH hubs.
 *
 * `failing` wins outright, unchanged from the original chain and for the
 * original reason: a step about to disappear is the one thing the hub must
 * say out loud. It costs nothing here because that line asserts nothing
 * about either component, it just routes the reader to the step page.
 *
 * Length discipline: the slot is one `mono text-xs` span sharing a
 * `justify-between` row with the step number, and the longest line that has
 * always fitted is the 41-character "A link stopped answering · open this
 * step". Every line below is at or under that. */
export function secureCardLine(s: SecureSummary): string {
  if (s.failing) return "A link stopped answering · open this step";
  if (s.done) return "API proxy and developer VMs counting";
  // The inner branch is the fix. "to go" is now reachable ONLY when the
  // other component genuinely holds nothing.
  if (s.apiProxyCounting)
    return s.devVmsAdded
      ? "API proxy counting · Dev VMs not counting"
      : "API proxy counting · Developer VMs to go";
  if (s.devVmsCounting)
    return s.apiProxyAdded
      ? "Dev VMs counting · API proxy not counting"
      : "Developer VMs counting · API proxy to go";
  if (s.apiProxyAdded || s.devVmsAdded)
    return "Saved, not counting yet · open this step";
  return "Nothing listed yet";
}

/** The closing line on /roadmap/secure.
 *
 * It names WHICH component is in which state, because "the other component"
 * was the exact phrase that misled the owner. It deliberately does NOT
 * point at a lever: Retry and "It is internal, confirm it" render only for
 * an admin, and a component with no instructions link renders no field line
 * at all, so any "the card above says why" promise would be false for some
 * readers. The per-field lines carry the levers for the people who have
 * them.
 *
 * A grace window APPENDS here rather than replacing the state line: unlike
 * the hub card, this page has room to say both, and which half counts is
 * still the primary fact. */
export function secureStepLine(s: SecureSummary): string {
  return s.failing ? `${secureState(s)} ${graceNote(s)}` : secureState(s);
}

/**
 * The grace sentence NAMES its component, and says "failing its check"
 * rather than "stopped answering".
 *
 * Both corrections are refuter-earned. An impersonal "one address here has
 * stopped answering" binds to whichever component the preceding sentence
 * named, and in the partial case that is the half which is NOT failing, so
 * the reader is pointed at the wrong component: the same defect as "add the
 * other component", one round later. And "stopped answering" is a rung-1
 * claim, while a rung-2 `internal` field can enter grace without our ever
 * having opened a socket to it, so that wording would describe a
 * conversation that never happened. Singular/plural is decided by the
 * count, because one component can put two fields in grace at once.
 */
function graceNote(s: SecureSummary): string {
  const both = s.apiProxyFailing && s.devVmsFailing;
  if (both)
    return "Addresses on both components have started failing their checks. Their own lines above say how long they still count.";
  const which = s.apiProxyFailing ? "the API proxy" : "Developer VMs";
  return `An address on ${which} has started failing its check. Its own line above says how long it still counts.`;
}

function secureState(s: SecureSummary): string {
  if (s.done) return "Both components are counting. This step is complete.";
  const half = "which earns half this step.";
  if (s.apiProxyCounting)
    return s.devVmsAdded
      ? `The API proxy is counting, ${half} Developer VMs are saved but not counting yet.`
      : `The API proxy is counting, ${half} Add Developer VMs to finish it.`;
  if (s.devVmsCounting)
    return s.apiProxyAdded
      ? `Developer VMs are counting, ${half} The API proxy is saved but not counting yet.`
      : `Developer VMs are counting, ${half} Add the API proxy to finish it.`;
  const nothing = "Nothing is counting toward this step yet.";
  if (s.apiProxyAdded && s.devVmsAdded)
    return `${nothing} Both components are saved but not counting.`;
  if (s.apiProxyAdded)
    return `${nothing} The API proxy is saved but not counting, and Developer VMs are not listed.`;
  if (s.devVmsAdded)
    return `${nothing} Developer VMs are saved but not counting, and the API proxy is not listed.`;
  return nothing;
}

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
