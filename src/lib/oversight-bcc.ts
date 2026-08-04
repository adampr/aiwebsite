/**
 * §1 oversight BCC for the host's RAW Resend senders (2026-08-04).
 *
 * `@aicompany/core`'s `sendEmail` applies the mandatory BCC itself, but this
 * host posts to the Resend API directly from four places, and those sends
 * carried NO oversight copy at all. Three lanes could reach a non-overseer with
 * no human copy: `/work` submitter notifications, the AI-composed replies
 * `email-intake` sends to arbitrary inbound correspondents, and the roadmap
 * approval-outcome mail. `ARCHITECTURE.md` claimed "every outbound email is
 * BCC'd"; for those lanes it was false.
 *
 * Routing them through the module seam is NOT possible today: `SendEmailArgs`
 * has no `attachments` field (the retention lane ships ~14.7 MB of base64) and
 * its `to` is a single string (the roadmap lane sends one thread to a list, and
 * fanning it into N would change the product). Recorded follow-up: give the
 * module seam `attachments` and `to: string | string[]`, then migrate these
 * lanes one at a time with a per-lane BCC policy.
 */
import { siteConfig } from "site.config";
import { extractAddress } from "@/lib/governance/approval";

/**
 * The BCC list for a raw send, or `undefined` when none should be applied.
 *
 * Returns `undefined` when the overseer is ALREADY a recipient — Resend is
 * documented to accept at most 50 recipients but says nothing about duplicate
 * addresses across `to`/`bcc`, and the module's claim that it rejects them
 * traces to the initial v0.1.0 commit and has never been probed against the
 * live API. So this does not rely on that behaviour: it removes the overlap
 * by construction.
 *
 * Normalisation is NOT optional. `adminRecipient()` does
 * `ADMIN_EMAIL.split(",")[0].trim()` with no lowercasing and no angle-strip, so
 * an operator writing `ADMIN_EMAIL="Adam <adam@xl.net>"` would defeat a naive
 * string compare, add a duplicate BCC, and — if Resend does reject duplicates —
 * silently drop the owner's own alert mail. Both sides go through
 * `extractAddress`, which lowercases and unwraps `Display Name <addr>`.
 */
export function oversightBcc(to: string[]): string[] | undefined {
  const bcc = extractAddress(siteConfig.oversight.bccEmail);
  if (!bcc) return undefined; // unparseable config: never guess a destination
  const recipients = new Set(to.map(extractAddress).filter(Boolean));
  return recipients.has(bcc) ? undefined : [siteConfig.oversight.bccEmail];
}
