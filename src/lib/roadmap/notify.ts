// Owner and participant notifications for the roadmap portal (§5.18). All
// sends are best-effort (a mail failure never blocks the action) and go out
// as Tron with his full signature (owner ruling 2026-08-03: every email Tron
// sends carries it). No em dashes in any copy.

import { oversightBcc } from "@/lib/oversight-bcc";
import { adminRecipient } from "@/lib/governance/budget";
import { tronSignature } from "@/lib/tron-signature";

const TRON_FROM = "Tron Netter <Tron.Netter@ai.xl.net>";
const SITE = "https://ai.xl.net";

async function sendRoadmapEmail(opts: {
  to: string[];
  subject: string;
  text: string;
}): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.log(`[roadmap] EMAIL SKIPPED (no RESEND_API_KEY): ${opts.subject}`);
    return false;
  }
  const bcc = oversightBcc(opts.to);
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: TRON_FROM,
        to: opts.to,
        subject: opts.subject,
        text: `${opts.text}\n\n${tronSignature()}`,
        // §1 oversight BCC (2026-08-04). No-ops on the call sites that already
        // put the owner in the visible `to` (so external company admins can
        // see he is on the thread); it only adds a copy where he was absent.
        ...(bcc && { bcc }),
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok)
      console.log(
        `[roadmap] send failed ${res.status}: ${(await res.text()).slice(0, 150)}`
      );
    return res.ok;
  } catch (err) {
    console.log(
      `[roadmap] send threw: ${err instanceof Error ? err.message.slice(0, 120) : "unknown"}`
    );
    return false;
  }
}

/** Unconditional owner notice on every workspace bootstrap: this
 * notification IS the audit control for first-signer-becomes-admin. */
export async function notifyCompanyCreated(opts: {
  domain: string;
  creatorEmail: string;
}): Promise<void> {
  await sendRoadmapEmail({
    to: [adminRecipient()],
    subject: `New roadmap company: ${opts.domain}`,
    text: [
      `A new company workspace was created on the AI Roadmap.`,
      ``,
      `Domain: ${opts.domain}`,
      `Created by: ${opts.creatorEmail} (now its company admin)`,
      ``,
      `Review it at ${SITE}/admin/roadmap`,
    ].join("\n"),
  });
}

/** The admin-access request email: adam plus every current company admin,
 * any ONE of whom may approve. The link only identifies the request; the
 * approve page requires a signed-in approver. */
export async function notifyAdminRequest(opts: {
  requestId: string;
  requesterEmail: string;
  companyName: string;
  companyDomain: string;
  adminEmails: string[];
}): Promise<void> {
  const to = Array.from(
    new Set([adminRecipient(), ...opts.adminEmails.map((e) => e.toLowerCase())])
  );
  await sendRoadmapEmail({
    to,
    subject: `Admin access request for ${opts.companyName}`,
    text: [
      `${opts.requesterEmail} is asking to become a company admin for ${opts.companyName} (${opts.companyDomain}) on the AI Roadmap.`,
      ``,
      `Any one of you can approve it here:`,
      `${SITE}/roadmap/approve-admin?req=${opts.requestId}`,
      ``,
      `The link works for 7 days and needs you to be signed in with your own account. If nobody approves, the request simply expires.`,
    ].join("\n"),
  });
}

export async function notifyRequestApproved(opts: {
  requesterEmail: string;
  companyName: string;
  approverEmail: string;
}): Promise<void> {
  await sendRoadmapEmail({
    to: [opts.requesterEmail],
    subject: `You are now a company admin for ${opts.companyName}`,
    text: [
      `Your admin access request for ${opts.companyName} on the AI Roadmap was approved by ${opts.approverEmail}.`,
      ``,
      `You can now manage the company directory, governance documents, and settings at ${SITE}/roadmap`,
    ].join("\n"),
  });
}

/** Import summary to the triggering admin plus the owner (§9.7). */
export async function notifyApolloImport(opts: {
  adminEmail: string;
  companyDomain: string;
  added: number;
  updated: number;
  keptManual: number;
  skippedSuppressed: number;
  callsUsed: number;
  partial: boolean;
}): Promise<void> {
  await sendRoadmapEmail({
    to: Array.from(new Set([opts.adminEmail.toLowerCase(), adminRecipient()])),
    subject: `Apollo import for ${opts.companyDomain}${opts.partial ? " (partial)" : ""}`,
    text: [
      `Apollo directory import for ${opts.companyDomain}:`,
      ``,
      `Added: ${opts.added}`,
      `Updated: ${opts.updated}`,
      `Kept (manually edited): ${opts.keptManual}`,
      `Skipped as previously removed: ${opts.skippedSuppressed}`,
      `Apollo calls used: ${opts.callsUsed}`,
      ...(opts.partial
        ? [
            ``,
            `The import stopped early (Apollo stopped responding or the daily call budget ran out). Rows already imported were kept; run Import again to continue.`,
          ]
        : []),
    ].join("\n"),
  });
}
