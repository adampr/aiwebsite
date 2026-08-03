// Email notices for team work submissions (§5.16), on the governance Resend
// pattern (sendTroyEmail). Owner is notified on every publish and every held
// card; the submitter is notified on both terminal states so closing the
// status page loses nothing.

import { isAdmin } from "@aicompany/core/auth/guard";
import { adminRecipient, sendTroyEmail, TROY_FROM } from "@/lib/governance/budget";
import { HELD_NEXT_STEPS, KIND_LABELS, type WorkKind } from "./config";
import { archiveDataById, clearArchiveData, type SubmissionRow } from "./db";
import type { WorkCard } from "./lint";

function kindLabel(kind: string): string {
  return KIND_LABELS[kind as WorkKind] ?? kind;
}

const SITE = "https://ai.xl.net";

/**
 * Owner retention email (§5.16): the original upload(s) as attachments in
 * ONE email, sent when the card is successfully posted (auto-publish AND
 * admin approve). CoWork Skill rows carry two files (package + SKILL.md);
 * program and legacy rows carry one; the body enumerates whatever is
 * attached, so the same template is truthful for both. Returns true only
 * when Resend accepted it; the caller clears the stored bytes ONLY then, so
 * a failed send keeps the artifacts recoverable from the row. Worst case
 * 10 MB + 1 MB ≈ 14.7 MB base64, inside Resend's 40 MB message cap; timeout
 * is 60 s for the larger payloads.
 */
export async function sendArchiveRetentionEmail(
  row: SubmissionRow,
  files: { name: string; data: Buffer }[]
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
        subject: `[aiwebsite] /work submission files: ${row.title}`,
        text: [
          `Retention copy of the original files behind a published /work card.`,
          ``,
          `Title: ${row.title}`,
          `Kind: ${kindLabel(row.kind)}`,
          `Submitted by: ${row.submitterEmail}`,
          ...files.map((f) => `File: ${f.name} (${f.data.length} bytes)`),
          `Package SHA-256: ${row.archiveSha256 ?? "n/a"}`,
          ...(row.mdSha256 ? [`SKILL.md SHA-256: ${row.mdSha256}`] : []),
          `Submitted: ${row.createdAt.toISOString()}`,
          ``,
          `The stored copies on the site row are cleared once this email sends; the attachments here are the retained originals.`,
        ].join("\n"),
        attachments: files.map((f) => ({
          filename: f.name,
          content: f.data.toString("base64"),
        })),
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
  const files = await archiveDataById(row.id);
  if (files.length === 0) return; // already delivered, or a pre-retention row
  if (await sendArchiveRetentionEmail(row, files))
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
    `Kind: ${kindLabel(row.kind)}`,
    `Submitted by: ${row.submitterEmail}`,
    `Card: ${link}`,
    ``,
    `Published description (the card's first paragraph):`,
    card.summary,
    ``,
    `The page refreshes at publish time; if /work is already open in a tab, reload it. If the card is still missing, the automatic refresh failed and the page rebuilds on the first visit after its 5-minute cache window, so allow two reloads a few minutes apart.`,
    `To remove it: /admin/work has the delete action, or DELETE /api/work/submissions/${row.id}.`,
  ].join("\n");
  await sendTroyEmail({
    subject: `[aiwebsite] /work card published: ${card.title}`,
    text,
  });
  await sendTroyEmail({
    to: row.submitterEmail,
    subject: `Your /work submission is live: ${card.title}`,
    text: `The editorial panel reviewed your submission from the documents you provided, and the card is published.\n\n${link}\n\nIf /work was already open, reload the page to see it (a stale copy can survive a few minutes; reload once more if it has not appeared). Reply to this email if something on the card reads wrong.`,
  });
}

export async function notifyHeld(
  row: SubmissionRow,
  reason: string,
  draft: unknown
): Promise<void> {
  const isUpdate = !!row.parentId;
  await sendTroyEmail({
    subject: isUpdate
      ? `[aiwebsite] Action needed: /work update held: ${row.title}`
      : `[aiwebsite] Action needed: /work submission held: ${row.title}`,
    text: [
      `Review it at ${SITE}/admin/work#sub-${row.id} (approve as-is, run the panel again, or delete).`,
      ``,
      isUpdate
        ? `The editorial panel held a proposed update to a published card for a human decision. The live card stays up while it waits, and approving publishes the draft in place of the live card.`
        : `The editorial panel held a team work submission for a human decision.`,
      ``,
      `Title: ${row.title}`,
      `Submitted by: ${row.submitterEmail}`,
      ``,
      `Reason:`,
      reason,
      ``,
      `Draft card JSON:`,
      JSON.stringify(draft, null, 2).slice(0, 6000),
    ].join("\n"),
  });
  // The owner reviewing his own submission does not need the colleague-
  // voiced second email (the first real submitter WAS the owner).
  if (row.submitterEmail.toLowerCase() === adminRecipient().toLowerCase())
    return;
  await sendTroyEmail({
    to: row.submitterEmail,
    subject: isUpdate
      ? `[aiwebsite] Your /work update is held for review: ${row.title}`
      : `[aiwebsite] Your /work card is held for review: ${row.title}`,
    text: [
      isUpdate
        ? `The editorial panel held your proposed update instead of passing it on. The live card stays up while it waits.`
        : `The editorial panel held your card instead of publishing it.`,
      ``,
      `Reason:`,
      reason,
      ``,
      HELD_NEXT_STEPS,
      ``,
      `Your submissions: ${SITE}/work/submit`,
    ].join("\n"),
  });
}

/** §5.16 updates: a proposed update passed the panel and waits for the admin
 * swap click. parent may be null or unpublished (CLI-held mid-run); the copy
 * degrades instead of linking nowhere. */
export async function notifyUpdatePending(
  row: SubmissionRow,
  card: WorkCard,
  parent: SubmissionRow | null
): Promise<void> {
  const liveLine =
    parent && parent.status === "published" && parent.slug
      ? `Live card: ${SITE}/work#${parent.slug}`
      : `Live card: currently held or removed; check ${SITE}/admin/work`;
  await sendTroyEmail({
    subject: `[aiwebsite] Action needed: /work update awaiting approval: ${card.title}`,
    text: [
      `Review it at ${SITE}/admin/work#sub-${row.id} (Approve update, Reject update, or delete).`,
      ``,
      `A proposed update to a published /work card passed the editorial panel. Nothing changes on the site until you approve it.`,
      ``,
      `Card: ${card.title}`,
      liveLine,
      `Proposed by: ${row.submitterEmail}`,
      ``,
      `Updated description (the proposed card's first paragraph):`,
      card.summary,
      ``,
      `Approve replaces the live card with this version within 5 minutes. Reject discards the proposal and emails the submitter. The live card stays up either way until you act.`,
    ].join("\n"),
  });
  if (isAdmin(row.submitterEmail)) return; // the approver IS the submitter
  await sendTroyEmail({
    to: row.submitterEmail,
    subject: `Your /work update passed review and is waiting for approval: ${card.title}`,
    text: [
      `The editorial panel reviewed your update to "${card.title}" and passed it. It now waits for Adam's approval; the live card does not change until he approves the swap.`,
      ``,
      `You will get another email when it goes live or if it is not approved. Track it at ${SITE}/work/submit.`,
    ].join("\n"),
  });
}

/** §5.16 updates: the swap ran; the new version is live under the old link. */
export async function notifyUpdateApproved(
  row: SubmissionRow,
  card: WorkCard,
  slug: string,
  opts: { approverEmail: string; parent: SubmissionRow }
): Promise<void> {
  const link = `${SITE}/work#${slug}`;
  if (row.submitterEmail.toLowerCase() !== opts.approverEmail.toLowerCase())
    await sendTroyEmail({
      to: row.submitterEmail,
      subject: `Your /work update is live: ${card.title}`,
      text: [
        `Your update to "${card.title}" was approved and the new version has replaced the old card.`,
        ``,
        link,
        ``,
        `If /work was already open, reload the page to see it (a stale copy can survive a few minutes; reload once more if it has not appeared). Reply to this email if something on the card reads wrong.`,
      ].join("\n"),
    });
  // Owner audit copy when another listed admin approved. Undo guidance names
  // rollback, NOT delete: DELETE on this row now performs the rollback.
  if (opts.approverEmail.toLowerCase() !== adminRecipient().toLowerCase())
    await sendTroyEmail({
      subject: `[aiwebsite] /work card updated: ${card.title}`,
      text: [
        `${opts.approverEmail} approved an update to the published team card "${card.title}". The new version replaces it within 5 minutes: ${link}`,
        ``,
        `To undo it: "Roll back to previous version" on /admin/work restores the old card. To remove the card entirely, roll back first, then delete the restored card.`,
      ].join("\n"),
    });
  // The original card's submitter learns their card changed when someone
  // else (the admin on their behalf, or a co-owner flow) proposed it.
  const parentEmail = opts.parent.submitterEmail.toLowerCase();
  if (
    parentEmail !== row.submitterEmail.toLowerCase() &&
    parentEmail !== opts.approverEmail.toLowerCase()
  )
    await sendTroyEmail({
      to: opts.parent.submitterEmail,
      subject: `Your /work card was updated: ${card.title}`,
      text: `An approved update replaced your published card "${card.title}" with a new version under the same link: ${link}\n\nReply to this email if that is unexpected.`,
    });
}

/** §5.16 updates: the admin rejected the proposal; the live card is
 * untouched and the proposal row is gone. */
export async function notifyUpdateRejected(
  row: SubmissionRow,
  actorEmail: string
): Promise<void> {
  if (row.submitterEmail.toLowerCase() === actorEmail.toLowerCase()) return;
  await sendTroyEmail({
    to: row.submitterEmail,
    subject: `Your /work update was not approved: ${row.title}`,
    text: [
      `Your proposed update to "${row.title}" was reviewed and not published. The live card stays as it is, and the proposal has been removed.`,
      ``,
      `If you want to try again, revise the files and submit a new update the same way. Reply to this email or ask Adam if you want to know what to change.`,
    ].join("\n"),
  });
}

/** §5.16 updates: an approved swap was rolled back; the previous version is
 * live again and the update row is gone. */
export async function notifyRollback(
  child: SubmissionRow,
  parent: SubmissionRow,
  slug: string,
  actorEmail: string
): Promise<void> {
  if (actorEmail.toLowerCase() !== adminRecipient().toLowerCase())
    await sendTroyEmail({
      subject: `[aiwebsite] /work card rolled back: ${parent.title}`,
      text: `${actorEmail} rolled back the update to the published team card "${parent.title}". The previous version of the card was restored: ${SITE}/work#${slug} (updates within 5 minutes).`,
    });
  if (child.submitterEmail.toLowerCase() !== actorEmail.toLowerCase())
    await sendTroyEmail({
      to: child.submitterEmail,
      subject: `Your /work update was rolled back: ${parent.title}`,
      text: `Your update to "${parent.title}" was rolled back and the previous version of the card was restored. The update row is gone from your submissions page. Reply to this email or ask Adam if you want to know why.`,
    });
}
