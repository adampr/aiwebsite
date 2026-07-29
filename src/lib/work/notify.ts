// Email notices for team work submissions (§5.16), on the governance Resend
// pattern (sendTroyEmail). Owner is notified on every publish and every held
// card; the submitter is notified on both terminal states so closing the
// status page loses nothing.

import { sendTroyEmail } from "@/lib/governance/budget";
import type { SubmissionRow } from "./db";
import type { WorkCard } from "./lint";

const SITE = "https://ai.xl.net";

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
