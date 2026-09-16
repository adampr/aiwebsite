/**
 * RFC 3834 auto-response suppression for this host's RAW Resend senders
 * (2026-09-16, Panel C row 3 + refutation RC 7).
 *
 * Every raw send carries `Auto-Submitted: auto-generated` (RFC 3834 §5, which
 * tells a conforming responder not to answer) plus Microsoft's
 * `X-Auto-Response-Suppress`. The Auto-Submitted literal is written at each
 * call site, not returned from here, on purpose: the per-call-site gate
 * (`scripts/check-resend-headers.mjs`) counts that literal against the number
 * of send sites in each file, so a sender that forgets it is caught by a grep.
 *
 * What this module decides is only the SUPPRESS VALUE, because it depends on
 * who the mail is for:
 *
 * - `All` when every visible recipient is the operator (ADMIN_EMAIL's first
 *   entry). That is the value the module's rendered alert senders have used
 *   since v1.93.0.
 * - `OOF, AutoReply` for anything that can reach a person who is not the
 *   operator: submitters, company admins, arbitrary inbound correspondents.
 *   That is the host precedent in `chase/notify.ts` `nudgeHeaders()`. `All`
 *   would also suppress delivery and non-delivery reports, and for a client's
 *   Microsoft 365 mailbox those are the only sign a reply never landed.
 *
 * Deliberately NOT here: `Precedence` (non-standard, and some list software
 * treats `bulk` as a spam signal), and `Auto-Submitted: auto-replied`, a third
 * value nothing else in the fleet pins (RC 7).
 *
 * Pure: no env, no DB, so the test suite exercises every branch.
 */
import { extractAddress } from "@/lib/governance/approval";

export type AutoResponseSuppress = "All" | "OOF, AutoReply";

export function autoResponseSuppress(
  to: readonly string[],
  operator: string
): AutoResponseSuppress {
  const op = extractAddress(operator);
  if (!op || to.length === 0) return "OOF, AutoReply";
  return to.every((addr) => extractAddress(addr) === op)
    ? "All"
    : "OOF, AutoReply";
}
