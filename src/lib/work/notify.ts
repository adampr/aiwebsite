// Email notices for team work submissions (§5.16), on the governance Resend
// pattern (sendTroyEmail). Owner is notified on every publish and every held
// card; the submitter is notified on both terminal states so closing the
// status page loses nothing.

import { adminRecipient, sendTroyEmail, TROY_FROM } from "@/lib/governance/budget";
import { archiveDataById, clearArchiveData, type SubmissionRow } from "./db";
import type { WorkCard } from "./lint";

const SITE = "https://ai.xl.net";

/**
 * Owner retention email (§5.16): the original upload (.zip/.skill/.md) as an
 * attachment, sent when the card is successfully posted (auto-publish AND
 * admin approve). Returns true only when Resend accepted it; the caller
 * clears the stored bytes ONLY then, so a failed send keeps the artifact
 * recoverable from the row. 10 MB upload ≈ 13.4 MB base64, inside Resend's
 * 40 MB message cap; timeout is 60 s for the larger payloads.
 */
export async function sendArchiveRetentionEmail(
  row: SubmissionRow,
  archive: { name: string; data: Buffer }
): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.log(
      `[work] RETENTION EMAIL SKIPPED (no RESEND_API_KEY): ${row.title}`
    );
    return false;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: TROY_FROM,
        to: [adminRecipient()],
        subject: `[aiwebsite] /work submission artifact: ${row.title}`,
        text: [
          `Retention copy of the original upload behind a published /work card.`,
          ``,
          `Title: ${row.title}`,
          `Kind: ${row.kind}`,
          `Submitted by: ${row.submitterEmail}`,
          `File: ${archive.name} (${archive.data.length} bytes)`,
          `SHA-256: ${row.archiveSha256 ?? "n/a"}`,
          `Submitted: ${row.createdAt.toISOString()}`,
          ``,
          `The copy stored on the site row is cleared once this email sends; this attachment is the retained artifact.`,
        ].join("\n"),
        attachments: [
          {
            filename: archive.name,
            content: archive.data.toString("base64"),
          },
        ],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok)
      console.log(
        `[work] retention email failed ${res.status}: ${(await res.text()).slice(0, 150)} (bytes kept on row ${row.id})`
      );
    return res.ok;
  } catch (err) {
    console.log(
      `[work] retention email threw: ${err instanceof Error ? err.message.slice(0, 120) : "unknown"} (bytes kept on row ${row.id})`
    );
    return false;
  }
}

/** Fetch the retained upload, email it to the owner, and clear the stored
 * bytes only on a confirmed send. Called from every publish path. */
export async function deliverArchiveRetention(
  row: SubmissionRow
): Promise<void> {
  const archive = await archiveDataById(row.id);
  if (!archive) return; // already delivered, or a pre-retention row
  if (await sendArchiveRetentionEmail(row, archive))
    await clearArchiveData(row.id);
}

export async function notifyPublished(
  row: SubmissionRow,
  card: WorkCard,
  slug: string
): Promise<void> {
  const link = `${SITE}/work#${slug}`;
  const text = [
    `A team work submission passed the editorial panel and is published on /work.`,
    ``,
    `Title: ${card.title}`,
    `Kind: ${row.kind}`,
    `Submitted by: ${row.submitterEmail}`,
    `Card: ${link}`,
    ``,
    `It can take up to 5 minutes to appear (page revalidation).`,
    `To remove it: /admin/work has the delete action, or DELETE /api/work/submissions/${row.id}.`,
  ].join("\n");
  await sendTroyEmail({
    subject: `[aiwebsite] /work card published: ${card.title}`,
    text,
  });
  await sendTroyEmail({
    to: row.submitterEmail,
    subject: `Your /work submission is live: ${card.title}`,
    text: `The editorial panel reviewed your submission from the documents you provided, and the card is published.\n\n${link}\n\nIt can take up to 5 minutes to appear. Reply to this email if something on the card reads wrong.`,
  });
}

export async function notifyHeld(
  row: SubmissionRow,
  reason: string,
  draft: unknown
): Promise<void> {
  await sendTroyEmail({
    subject: `[aiwebsite] /work submission held: ${row.title}`,
    text: [
      `The editorial panel held a team work submission for a human decision.`,
      ``,
      `Title: ${row.title}`,
      `Submitted by: ${row.submitterEmail}`,
      ``,
      `Reason:`,
      reason,
      ``,
      `Draft card JSON:`,
      JSON.stringify(draft, null, 2).slice(0, 6000),
      ``,
      `Review at ${SITE}/admin/work (approve as-is or delete).`,
    ].join("\n"),
  });
  await sendTroyEmail({
    to: row.submitterEmail,
    subject: `Your /work submission needs a human look: ${row.title}`,
    text: `The editorial panel held your card instead of publishing it. Adam has the draft and the panel notes and will follow up by email.`,
  });
}
