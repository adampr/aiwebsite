// Email notices for team work submissions (§5.16), on the governance Resend
// pattern (sendTroyEmail). Owner is notified on every publish and every held
// card; the submitter is notified on both terminal states so closing the
// status page loses nothing.

import { isAdmin } from "@aicompany/core/auth/guard";
import { sendEmail } from "@aicompany/core/email/send";
import { siteConfig } from "site.config";
import { adminRecipient, sendTroyEmail, TROY_FROM } from "@/lib/governance/budget";
import { withTronSignature, withTroySignature } from "@/lib/tron-signature";
import { HELD_NEXT_STEPS, KIND_LABELS, type WorkKind } from "./config";
import { archiveDataById, type SubmissionRow } from "./db";
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
 * attached, so the same template is truthful for both. Worst case
 * 10 MB + 1 MB ≈ 14.7 MB base64, inside Resend's 40 MB message cap; timeout
 * is 60 s for the larger payloads.
 *
 * The return value is Resend's ACCEPT (202), and that is all it can ever be.
 * It is NOT evidence of delivery, and NOTHING may delete data on the strength
 * of it — see deliverArchiveRetention.
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
        // DELIBERATE §1 CARVE-OUT — do NOT add an oversight BCC here, and do
        // NOT "fix" this by calling oversightBcc().
        //
        // This is the one sender whose BODY IS a third party's confidential
        // material: the submitter's original uploaded archive, in full, as an
        // attachment. It is addressed to adminRecipient() (ADMIN_EMAIL), and it
        // is safe today only because ADMIN_EMAIL happens to equal
        // oversight.bccEmail — nothing in code or config pins that equality.
        // The day ADMIN_EMAIL becomes ops@xl.net, a generic BCC here would
        // start fanning every client company's source files to a second
        // mailbox that never agreed to receive them.
        //
        // The recipient IS the overseer by construction here, so there is
        // nothing for a BCC to add — only something for it to leak.
        subject: `[aiwebsite] /work submission files: ${row.title}`,
        // withTroySignature: this raw fetch bypasses sendTroyEmail (it needs
        // attachments, a 60s timeout, and the no-BCC carve-out above), so the
        // owner's always-signed ruling is applied here by hand.
        text: withTroySignature([
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
          `A copy of these files also remains on the submission row (since 2026-08-04 they are no longer deleted after this email — a bounced retention email used to destroy the only copy).`,
        ].join("\n")),
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

/**
 * Fetch the retained upload and email it to the owner. Called from every
 * publish path.
 *
 * THE STORED BYTES ARE NEVER CLEARED HERE. Until 2026-08-04 this cleared them
 * whenever `sendArchiveRetentionEmail` returned true — but that return value is
 * Resend's 202 ACCEPT, not a delivery. The old comment claimed "only on a
 * confirmed send"; there was no confirmation anywhere in the path.
 *
 * That cost real data. On 2026-08-03 two submissions ("Kickoff Agenda",
 * "Project Plan") were accepted by Resend, bounced minutes later with
 * Transient/ContentRejected — the recipient's provider refusing the .skill
 * attachments — and their archive_data/md_data had already been NULLed. The
 * email WAS the retention copy. With no backups configured, those uploads are
 * permanently gone.
 *
 * Keeping the bytes is close to free and was measured, not assumed: the 10
 * published rows hold 116,536 bytes TOTAL (max 26,756) against an 11 MB
 * per-row ceiling nothing has approached. Published rows are already exempt
 * from sweepExpiredWork, so this is stable rather than a leak into a sweeper.
 *
 * Rejected alternatives: clearing on a real delivery confirmation needs an
 * email.delivered webhook the module does not handle, a new column for the
 * Resend id (the POST response is discarded), and id→row correlation — and
 * degenerates to this behaviour for every row whose event is lost. Clearing on
 * a timer is the same silent loss, later.
 */
export async function deliverArchiveRetention(
  row: SubmissionRow
): Promise<void> {
  const files = await archiveDataById(row.id);
  if (files.length === 0) return; // pre-retention row
  if (await sendArchiveRetentionEmail(row, files)) return;
  // A failed retention send used to be a bare console.log — invisible to the
  // operator and to the §5.15 ledger, so the ONLY signal that an archive copy
  // never went out was a bounce webhook nobody correlated. Route it through the
  // module send seam: a `WARN ` subject to oversight.alertEmail auto-mirrors
  // into reported_issues, so it shows up in the mandated build-start triage.
  // withTronSignature: the module's sendEmail never mutates content (its
  // documented contract) and sends from oversight.mailFrom, which is Tron's
  // mailbox for this site, so the caller appends Tron's block.
  await sendEmail(siteConfig, {
    to: siteConfig.oversight.alertEmail,
    subject: `[aiwebsite] WARN /work retention email failed to send`,
    text: withTronSignature(
      `The retention copy of the uploaded files behind a published /work card ` +
        `was NOT accepted by the mail vendor.\n\n` +
        `Title:  ${row.title}\n` +
        `Row id: ${row.id}\n` +
        `Files:  ${files.map((f) => `${f.name} (${f.data.length} bytes)`).join(", ")}\n\n` +
        `The bytes are STILL on the row — nothing was deleted. Re-send or ` +
        `download them before any future retention change.`
    ),
  });
}

export async function notifyPublished(
  row: SubmissionRow,
  card: WorkCard,
  slug: string,
  containedDriftFields: string[] = []
): Promise<void> {
  // Owner-only FYI (§5.16 2026-08-04 containment round): when the repair
  // stage tried to reword fields outside its violation grant and the merge
  // discarded those edits, say so in the publish email — silence would hide
  // the only human-visible signal that drift happens; a separate email
  // would recreate the interrupt the merge removed. Never in submitter copy.
  const containedNote =
    containedDriftFields.length > 0
      ? [
          ``,
          `Note: the automated repair step also tried to reword parts of the card outside the lint violations (${containedDriftFields.join(", ")}). Those changes were discarded and the panel's original text was kept. No action is needed.`,
        ]
      : [];
  // §5.18 company lane: different links (the private Your Work page is
  // force-dynamic, so no ISR-reload caveats), and the submitter copy never
  // names Adam, /admin/work, /work/submit, or the public page.
  if (row.companyId !== null) {
    const { scopeContext, scopeOf } = await import("./scope");
    const sctx = await scopeContext(scopeOf(row));
    const link = `${SITE}/roadmap/work#${slug}`;
    await sendTroyEmail({
      subject: `[aiwebsite] Your Work card published (${sctx.companyDomain ?? "company"}): ${card.title}`,
      text: [
        `A client company work submission passed the editorial panel and is published on that company's private Your Work page.`,
        ``,
        `Company: ${sctx.orgName} (${sctx.companyDomain ?? "unknown domain"})`,
        `Title: ${card.title}`,
        `Kind: ${kindLabel(row.kind)}`,
        `Submitted by: ${row.submitterEmail}`,
        `Card (signed-in company members and admins only): ${link}`,
        ``,
        `Published description (the card's first paragraph):`,
        card.summary,
        ...containedNote,
        ``,
        `To remove it: /admin/roadmap company detail, or DELETE /api/work/submissions/${row.id}.`,
      ].join("\n"),
    });
    await sendTroyEmail({
      to: row.submitterEmail,
      subject: `Your work submission is live: ${card.title}`,
      text: [
        `The editorial panel reviewed your submission from the documents you provided, and the card is published on your company's Your Work page.`,
        ``,
        link,
        ``,
        `Published submissions are credited to your name and counted on your company's scorecard, which everyone at ${sctx.companyDomain ?? "your company"} who signs in can see. Reply to this email if something on the card reads wrong.`,
      ].join("\n"),
    });
    return;
  }
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
    ...containedNote,
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
  // §5.18 company lane (updates are staff-only, so this is never an update
  // row): owner copy keeps the /admin/work review link; the submitter copy
  // names the team, never Adam, and points at the roadmap page.
  if (row.companyId !== null) {
    await sendTroyEmail({
      subject: `[aiwebsite] Action needed: company work submission held: ${row.title}`,
      text: [
        `Review it at ${SITE}/admin/work#sub-${row.id} (approve as-is, run the panel again, or delete).`,
        ``,
        `The editorial panel held a CLIENT COMPANY work submission for a human decision. It would publish to that company's private Your Work page.`,
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
    await sendTroyEmail({
      to: row.submitterEmail,
      subject: `Your work submission is held for review: ${row.title}`,
      text: [
        `The editorial review held your card instead of publishing it.`,
        ``,
        `Reason:`,
        reason,
        ``,
        `The XL.net team reviews held cards and will publish the draft, run the review again, or remove it. Reply to this email if you want to send a corrected version.`,
        ``,
        `Your submissions: ${SITE}/roadmap/work`,
      ].join("\n"),
    });
    return;
  }
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

/** §5.16 admin web auto-approve: a verified-admin web update passed the
 * panel and swapped itself live (nobody clicked approve). The owner copy is
 * UNCONDITIONAL: this is the one lane where no human acted at publish time,
 * so it must never be the one lane with no mail trail (notify-on-every-
 * publish invariant). Wording never says "approved": nobody approved. */
export async function notifyUpdateAutoPublished(
  row: SubmissionRow,
  card: WorkCard,
  slug: string,
  parent: SubmissionRow,
  containedDriftFields: string[] = []
): Promise<void> {
  const link = `${SITE}/work#${slug}`;
  const owner = adminRecipient().toLowerCase();
  const submitter = row.submitterEmail.toLowerCase();
  const undo = `To undo it: "Roll back to previous version" on /admin/work restores the old card. To remove the card entirely, roll back first, then delete the restored card.`;
  await sendTroyEmail({
    subject: `[aiwebsite] /work card updated: ${card.title}`,
    text: [
      submitter === owner
        ? `Your update to the published team card "${card.title}" passed the editorial panel and replaced the live card. Admin web submissions publish on pass; no approval step was needed.`
        : `${row.submitterEmail} submitted an update to the published team card "${card.title}" through the web form; it passed the editorial panel and published automatically (admin web submissions publish on pass). The new version replaces it within 5 minutes.`,
      ``,
      link,
      ...(containedDriftFields.length > 0
        ? [
            ``,
            `Note: the automated repair step also tried to reword parts of the card outside the lint violations (${containedDriftFields.join(", ")}). Those changes were discarded and the panel's original text was kept. No action is needed.`,
          ]
        : []),
      ``,
      `If /work was already open, reload the page to see it (a stale copy can survive a few minutes; reload once more if it has not appeared).`,
      ``,
      undo,
    ].join("\n"),
  });
  // A second listed admin used the auto lane: they get the submitter copy,
  // the owner keeps the audit copy above.
  if (submitter !== owner)
    await sendTroyEmail({
      to: row.submitterEmail,
      subject: `Your /work update is live: ${card.title}`,
      text: [
        `Your update to "${card.title}" passed the editorial panel and replaced the live card (admin web submissions publish on pass).`,
        ``,
        link,
        ``,
        `If /work was already open, reload the page to see it (a stale copy can survive a few minutes; reload once more if it has not appeared). Reply to this email if something on the card reads wrong.`,
      ].join("\n"),
    });
  // The original card's submitter learns their card changed, same rule as
  // the clicked-approve path.
  const parentEmail = parent.submitterEmail.toLowerCase();
  if (parentEmail !== submitter && parentEmail !== owner)
    await sendTroyEmail({
      to: parent.submitterEmail,
      subject: `Your /work card was updated: ${card.title}`,
      // "reviewed", never "approved": nobody clicked approve on this lane.
      text: `A reviewed update replaced your published card "${card.title}" with a new version under the same link: ${link}\n\nReply to this email if that is unexpected.`,
    });
}

/** §5.16 admin web auto-approve, conflict park: the update passed the panel
 * but its target card was no longer published when the swap ran, so nothing
 * was replaced and nothing new was published. notifyHeld's update copy
 * ("the live card stays up, approving publishes the draft") is false here:
 * the target is gone and /admin/work suppresses Approve on a conflict park.
 * Admin-only (the auto lane's submitter is always an admin). */
export async function notifyUpdateConflictHeld(
  row: SubmissionRow,
  card: WorkCard
): Promise<void> {
  const selfSubmitted =
    row.submitterEmail.toLowerCase() === adminRecipient().toLowerCase();
  await sendTroyEmail({
    subject: `[aiwebsite] Action needed: /work update could not publish: ${card.title}`,
    text: [
      `Review it at ${SITE}/admin/work#sub-${row.id} (delete it, or resubmit the tool as a new card).`,
      ``,
      `${selfSubmitted ? "Your update" : `An update proposed by ${row.submitterEmail}`} passed the editorial panel, but the card it targeted was no longer published when the swap ran, so nothing was replaced and nothing new was published. The draft is held with its content intact.`,
      ``,
      `This held update cannot be approved because its target is gone. If the tool should still be on /work, submit it again as a new card.`,
      ``,
      `Title: ${card.title}`,
      `Proposed by: ${row.submitterEmail}`,
    ].join("\n"),
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
