// Notifications for the Requested Work board (§5.19). Same seam rules as
// src/lib/roadmap/notify.ts: every send is best-effort (a mail failure never
// blocks a transition), goes out as Tron with his signature appended at the
// seam, and carries the oversight BCC. Links are bare page URLs, never
// tokens and never mutating GETs (§5.18 approval-flow rule). Company-lane
// copy never names Adam, /work/submit, or /admin/work. No em dashes in any
// copy.

import { oversightBcc } from "@/lib/oversight-bcc";
import { adminRecipient } from "@/lib/governance/budget";
import { TRON_FROM, withTronSignature } from "@/lib/tron-signature";
import { companyAdminEmails } from "@/lib/roadmap/db";
import { formatValueUsd } from "@/lib/work/requests-config";
import type { WorkScope } from "@/lib/work/scope";

const SITE = "https://ai.xl.net";

async function sendRequestsEmail(opts: {
  to: string[];
  subject: string;
  text: string;
}): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.log(
      `[requests] EMAIL SKIPPED (no RESEND_API_KEY): ${opts.subject}`
    );
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
        text: withTronSignature(opts.text),
        ...(bcc && { bcc }),
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok)
      console.log(
        `[requests] send failed ${res.status}: ${(await res.text()).slice(0, 150)}`
      );
    return res.ok;
  } catch (err) {
    console.log(
      `[requests] send threw: ${err instanceof Error ? err.message.slice(0, 120) : "unknown"}`
    );
    return false;
  }
}

/** Lane admin recipients: the internal lane goes to ADMIN_EMAIL; a company
 * lane goes to its company admins. An empty company admin list logs and
 * skips (company mail must never fall back to the internal address). */
async function laneAdminRecipients(scope: WorkScope): Promise<string[]> {
  if (scope.companyId === null) return [adminRecipient()];
  const admins = await companyAdminEmails(scope.companyId);
  if (admins.length === 0) {
    console.warn(
      `[requests] WARN no company admins to notify for company ${scope.companyId}`
    );
    return [];
  }
  return admins.map((e) => e.toLowerCase());
}

/** Where the lane's people manage requests. */
function boardUrl(scope: WorkScope): string {
  return scope.companyId === null
    ? `${SITE}/work/requested`
    : `${SITE}/roadmap/requested`;
}

function requesterUrl(scope: WorkScope): string {
  return scope.companyId === null
    ? `${SITE}/work/requested`
    : `${SITE}/roadmap/request`;
}

export async function notifyRequestCreated(opts: {
  scope: WorkScope;
  title: string;
  requesterEmail: string;
  valueUsd: number;
}): Promise<void> {
  const to = await laneAdminRecipients(opts.scope);
  if (to.length === 0) return;
  await sendRequestsEmail({
    to,
    subject: `New work request awaiting approval: ${opts.title}`,
    text: [
      `${opts.requesterEmail} filed a new request on the requested-work board.`,
      ``,
      `Title: ${opts.title}`,
      `Estimated annual value: ${formatValueUsd(opts.valueUsd)}`,
      ``,
      `It stays off the board until an admin approves it. Review it here:`,
      boardUrl(opts.scope),
    ].join("\n"),
  });
}

export async function notifyRequestDecision(opts: {
  scope: WorkScope;
  title: string;
  requesterEmail: string;
  approved: boolean;
  reason: string | null;
}): Promise<void> {
  await sendRequestsEmail({
    to: [opts.requesterEmail],
    subject: opts.approved
      ? `Your work request is on the board: ${opts.title}`
      : `Your work request was not approved: ${opts.title}`,
    text: opts.approved
      ? [
          `An admin approved your request "${opts.title}". It is now on the requested-work board where anyone on the team can claim it.`,
          ``,
          `Follow it here: ${requesterUrl(opts.scope)}`,
        ].join("\n")
      : [
          `An admin decided not to list your request "${opts.title}".`,
          ...(opts.reason ? [``, `Reason: ${opts.reason}`] : []),
          ``,
          `You can refine it and file it again here: ${requesterUrl(opts.scope)}`,
        ].join("\n"),
  });
}

export async function notifyRequestCompleted(opts: {
  scope: WorkScope;
  title: string;
  developerEmail: string;
}): Promise<void> {
  const to = await laneAdminRecipients(opts.scope);
  if (to.length === 0) return;
  await sendRequestsEmail({
    to,
    subject: `Completion awaiting validation: ${opts.title}`,
    text: [
      `${opts.developerEmail} marked "${opts.title}" complete on the requested-work board.`,
      ``,
      `It counts as completed only after an admin validates it. Review it here:`,
      boardUrl(opts.scope),
    ].join("\n"),
  });
}

export async function notifyRequestValidated(opts: {
  scope: WorkScope;
  title: string;
  developerEmail: string;
  validated: boolean;
}): Promise<void> {
  await sendRequestsEmail({
    to: [opts.developerEmail],
    subject: opts.validated
      ? `Completion validated: ${opts.title}`
      : `Sent back for more work: ${opts.title}`,
    text: opts.validated
      ? [
          `An admin validated your completion of "${opts.title}". It now counts as officially completed.`,
          ``,
          `See the board: ${boardUrl(opts.scope)}`,
        ].join("\n")
      : [
          `An admin sent "${opts.title}" back: it is not finished yet and is back in progress under your name.`,
          ``,
          `See the board: ${boardUrl(opts.scope)}`,
        ].join("\n"),
  });
}
