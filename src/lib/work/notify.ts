// Email notices for team work submissions (§5.16), on the governance Resend
// pattern (sendGovernanceEmail). Owner is notified on every publish and every held
// card; the submitter is notified on both terminal states so closing the
// status page loses nothing.

import { isAdmin } from "@aicompany/core/auth/guard";
import { sendEmail } from "@aicompany/core/email/send";
import { siteConfig } from "site.config";
import { adminRecipient, sendGovernanceEmail } from "@/lib/governance/budget";
import { TRON_FROM, withTronSignature } from "@/lib/tron-signature";
import { reportFailureEmailIssue } from "@/lib/report-issue";
import {
  FAILED_NEXT_STEPS,
  HELD_NEXT_STEPS,
  KIND_LABELS,
  WORK_CAPS,
  type PanelFailReason,
  type WorkKind,
} from "./config";
import { archiveDataById, type SubmissionRow } from "./db";
import {
  storedFilesForSubmission,
  verifyAndClearRowBytes,
  verifyStoredCopies,
} from "./archive-store";
import {
  mailSafeName,
  oneLine,
  partitionAttachmentsBySize,
  predictArmoredLength,
  toDeliverableAttachment,
  willArmorFile,
  type AttachmentOmission,
  type RetentionAttachment,
} from "./retention-encoding";
import { screenPackageForMail, type ScreenResult } from "./mail-screen";
import { parseCleaning } from "./cleaning";
import type { WorkCard } from "./lint";

/** "Submitted by" must name who SUBMITTED it, which since the 2026-08-09
 * transfer round is creator_email whenever a move has happened;
 * submitter_email is the CURRENT OWNER. Both are printed when they differ,
 * because the owner is who the pipeline now emails and who the scorecard
 * counts, and this mail is the round's stated audit trail. */
function ownerLines(row: SubmissionRow): string {
  const creator = row.creatorEmail ?? row.submitterEmail;
  return creator.trim().toLowerCase() === row.submitterEmail.trim().toLowerCase()
    ? `Submitted by: ${row.submitterEmail}`
    : `Submitted by: ${creator}\nOwned by (moved): ${row.submitterEmail}`;
}

function kindLabel(kind: string): string {
  return KIND_LABELS[kind as WorkKind] ?? kind;
}

const SITE = "https://ai.xl.net";

/**
 * Owner retention email (§5.16): the original upload(s) as attachments in
 * ONE email, sent when the card is successfully posted (auto-publish AND
 * admin approve). CoWork Skill rows carry two files (package + SKILL.md);
 * program and legacy rows carry one; the body enumerates whatever is
 * attached, so the same template is truthful for both.
 *
 * Attachments go through toDeliverableAttachment (retention-encoding.ts):
 * text-named files attach as-is, everything else as a base64 text wrapper,
 * because Gmail bounces archives containing blocked file types (whole
 * message, ContentRejected) and did so on 2026-08-03 and 2026-08-06.
 *
 * Attach-if-fits (2026-08-19, the 100 MB round): a 100 MB package armors
 * to ~137 MB text, which no mail provider accepts, so attachments are
 * included ONLY while the PREDICTED payloads (predictArmoredLength, exact
 * to the byte against the encoder) sum under RETENTION_ATTACH_TOTAL_MAX
 * (35 MB, headroom inside Resend's 40 MB message cap). The partition is
 * smallest-first, so a small SKILL.md is never crowded out by its package.
 * Files attach whole or not at all; an omitted file gets a body line with
 * its REASON (too big alone vs the budget was spent) and where it lives -
 * lines that name the archive store only when the caller verified the
 * store copy (opts.storeVerified), hedging to the row copy otherwise.
 * The email always states exactly what is and is not attached and why.
 *
 * Only files in the attach set are ever screened or encoded: predicting
 * first is what keeps a 100 MB package from costing ~750 MB of transient
 * strings and an event-loop stall on the publish path.
 *
 * The return value is Resend's ACCEPT (202), and that is all it can ever be.
 * It is NOT evidence of delivery. Bytea clearing keys on the in-transaction
 * archive-store verification, never on this value — see
 * deliverArchiveRetention.
 */

function looksLikeArchive(data: Buffer): boolean {
  return (
    data.length >= 4 &&
    data[0] === 0x50 &&
    data[1] === 0x4b &&
    (data[2] === 0x03 || data[2] === 0x05 || data[2] === 0x07)
  );
}

/** The screened copy never carries the original's filename: the name, the
 * decode target and the in-zip README each say so independently. */
function screenedName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0
    ? `${name.slice(0, dot)}.screened${name.slice(dot)}`
    : `${name}.screened.zip`;
}

type RetentionItem =
  | {
      attached: true;
      prepared: RetentionAttachment;
      screen: ScreenResult | null;
    }
  | { attached: false; reason: AttachmentOmission };

export async function sendArchiveRetentionEmail(
  row: SubmissionRow,
  files: { name: string; data: Buffer }[],
  opts?: { storeVerified?: boolean }
): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.log(
      `[work] RETENTION EMAIL SKIPPED (no RESEND_API_KEY): ${row.title}`
    );
    return false;
  }
  // Where an unattached file can be fetched. The store is asserted ONLY
  // when the caller verified the store copy before composing (refutation
  // M3: this mail must never claim residency nothing checked); otherwise
  // the row copy is the one named. npm run work:archive reads store-first
  // with a per-file bytea fallback, so the command is right either way.
  // What the intake scan took out, if anything. Read once: the subject, the
  // lead line, the hash block and the entry list all have to agree, and the
  // word "original" cannot appear in any of them for a cleaned row. That rule
  // is already written down two paragraphs below for the blocked-type screen
  // and it binds identically here.
  const cleaning = parseCleaning(row.cleaningJson);
  /** The deliberate no-copy case: the intake scan found something, the rebuild
   * could not be verified, and we chose to keep nothing rather than keep the
   * bytes we were told to clean. This mail exists to say that out loud. */
  const noCopyRetained = Boolean(cleaning?.failed) && files.length === 0;
  const storeVerified = opts?.storeVerified === true;
  const residency = storeVerified
    ? `the server archive store (data/work-archives/${row.id}/)`
    : `the submission row on the server (the archive-store copy could not be confirmed at send time)`;
  const fetchCmd = `npm run work:archive -- ${row.id}`;
  // Partition FIRST, on predicted payload lengths, smallest-first. Only
  // the attach set is screened and encoded below. Accepted edge: the
  // prediction uses the ORIGINAL size, so a package whose SCREENED copy
  // would have fit still omits; the copy stays truthful because the file
  // gets its own omission line either way.
  const { attach, omit } = partitionAttachmentsBySize(
    files.map((f) => predictArmoredLength(f.data.length, willArmorFile(f)))
  );
  const attachedSet = new Set(attach);
  const omitReason = new Map(omit.map((o) => [o.index, o.reason]));
  const items: RetentionItem[] = [];
  for (let i = 0; i < files.length; i++) {
    if (!attachedSet.has(i)) {
      // Omitted files are never screened or encoded (the whole point of
      // predicting): no strings are built for bytes that cannot ship.
      items.push({
        attached: false,
        reason: omitReason.get(i) ?? "budgetSpent",
      });
      continue;
    }
    // Screen the package against the provider's blocked-type policy before
    // armoring: the provider decodes the base64 text and refuses the whole
    // message when a blocked type is inside (2026-08-06 evidence). A screen
    // failure returns the original, so this can never reduce what is sent
    // below today's behavior, and it never throws into the publish path.
    // Text docs (the standalone SKILL.md) are never screened: they carry
    // no entries and deliver as-is.
    const f = files[i];
    let screen: ScreenResult | null = null;
    let file = f;
    if (looksLikeArchive(f.data)) {
      screen = await screenPackageForMail(
        f.name,
        f.data,
        row.archiveSha256 ?? null
      );
      if (screen.kind === "screened")
        file = { name: screenedName(f.name), data: screen.zip };
    }
    items.push({ attached: true, prepared: toDeliverableAttachment(file), screen });
  }
  const omittedCount = files.length - attachedSet.size;
  const armored = items.flatMap((it) =>
    it.attached && it.prepared.encoded ? [it.prepared] : []
  );
  const partial = items.find(
    (it) => it.attached && it.screen?.kind === "screened"
  );
  const partialScreen =
    partial?.attached && partial.screen?.kind === "screened"
      ? partial.screen
      : null;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: TRON_FROM,
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
        // The subject and the lead line are the two fields a mailbox
        // indexes, so a partial says so THERE, not only inside the
        // attachment (refutation panel, 2026-08-06).
        subject: `[aiwebsite] /work submission files${
          partialScreen && omittedCount > 0
            ? " (SCREENED COPY, NOT ALL FILES ATTACHED)"
            : partialScreen
              ? " (SCREENED COPY)"
              : omittedCount > 0
                ? " (NOT ALL FILES ATTACHED)"
                : ""
        }${noCopyRetained ? " (NO COPY RETAINED)" : cleaning ? " (CLEANED AT INTAKE)" : ""}: ${row.title}`,
        // withTronSignature: this raw fetch bypasses sendGovernanceEmail (it needs
        // attachments, a 60s timeout, and the no-BCC carve-out above), so the
        // owner's always-signed ruling is applied here by hand.
        // Body lines and the attachments array both derive from `items`
        // (one partition), so what the mail says is attached can never
        // desync from what is.
        text: withTronSignature([
          noCopyRetained
            ? `NO retention copy exists for this card. The intake scan found credential-shaped content in the upload, and the cleaned rebuild could not be verified (${cleaning?.failed ?? "unknown"}), so nothing was stored rather than storing the package as sent. The submitter's own copy is the only one, and they were told to rotate.`
            : partialScreen
            ? `SCREENED retention copy: some uploaded files are NOT attached.`
            : cleaning
              ? // NOT "the original files": the intake scan rewrote this
                // package before anything was stored, so the only copy that
                // ever existed here is the cleaned one. Saying "original"
                // would send a reader six months from now looking for
                // material that was deliberately never kept.
                `Retention copy of the files behind a published /work card. Credential-shaped content was cleaned out of this package when it arrived, so these are the CLEANED files, not the upload as it was sent.`
              : `Retention copy of the original files behind a published /work card.`,
          ...(omittedCount > 0
            ? [
                `${omittedCount} of ${files.length} files are NOT attached (each says why below). They are retained in ${residency}; ${fetchCmd} retrieves them.`,
              ]
            : []),
          ``,
          `Title: ${oneLine(row.title)}`,
          `Kind: ${kindLabel(row.kind)}`,
          ownerLines(row),
          // The word "original" never describes a screened copy: it is
          // built from the upload with entries removed, and a mailbox read
          // six months from now is the one that has to get this right.
          // Every file gets a line, attached or not, with the omission
          // REASON stated truthfully: "exceeds what mail providers accept"
          // only for a file too big alone; a file squeezed out by the
          // budget says that instead.
          ...items.map((it, i) => {
            const rawName = mailSafeName(files[i]?.name ?? "upload");
            const rawBytes = files[i]?.data.length ?? 0;
            if (!it.attached)
              return it.reason === "tooBigAlone"
                ? `Not attached: ${rawName} (${rawBytes} bytes). It exceeds what mail providers accept even on its own. It is retained in ${residency}; ${fetchCmd} retrieves it.`
                : `Not attached: ${rawName} (${rawBytes} bytes). It would fit on its own, but the files that fit already use the space this email can carry. It is retained in ${residency}; ${fetchCmd} retrieves it.`;
            const p = it.prepared;
            if (!p.encoded)
              return `Attached: ${p.attachedName} (${p.attachedBytes} bytes, exactly as uploaded)`;
            if (it.screen?.kind === "screened")
              return `Attached: ${p.attachedName} (${p.attachedBytes} bytes, base64 text encoding a SCREENED COPY of the upload ${rawName}, ${rawBytes} bytes)`;
            return `Attached: ${p.attachedName} (${p.attachedBytes} bytes, base64 text encoding the original upload ${p.originalName}, ${p.originalBytes} bytes)`;
          }),
          ...(armored.length > 0
            ? [
                ``,
                `To restore an encoded attachment on macOS or Linux:`,
                // openssl, not base64: BSD/macOS base64 rejects --decode and
                // its -d means debug there. Names are mailSafeName-sanitized
                // at the encoding seam, so quoting them is paste-safe.
                ...armored.map(
                  (p) =>
                    `  openssl base64 -d -in "${p.attachedName}" -out "${p.originalName}"`
                ),
                ``,
              ]
            : []),
          ...(partialScreen
            ? [
                ``,
                `Removed before sending, ${partialScreen.removed.length} of ${partialScreen.total} entries (${partialScreen.kept} kept):`,
                ...partialScreen.removed.map(
                  (r) =>
                    `  ${r.path} (${r.declaredBytes} bytes declared, ${r.reason})`
                ),
                ``,
                // A screened copy only exists for a file the partition
                // attached (omitted files are never screened), so
                // "attached" is true by construction here.
                `SHA-256 of the attached screened copy: ${partialScreen.sha256}`,
                `SHA-256 of the uploaded package, which is NOT attached: ${row.archiveSha256 ?? "n/a"}`,
              ]
            : cleaning
              ? [
                  // TWO hashes, both labelled, because for a cleaned row they
                  // are answers to different questions and the row's own
                  // archive_sha256 does NOT describe the attachment. It is the
                  // hash of what the submitter sent, kept so work:correlate
                  // can still recognise their copy; the attached bytes are the
                  // cleaned rebuild and hash differently by construction.
                  `SHA-256 of the attached cleaned package: ${cleaning.archive?.sha256 ?? "n/a"}`,
                  `SHA-256 of the package as submitted, which is NOT attached and was never stored: ${row.archiveSha256 ?? "n/a"}`,
                ]
              : [
                  `Package SHA-256${armored.length > 0 ? " (hash of the restored original file, not of the attached .b64.txt text)" : ""}: ${row.archiveSha256 ?? "n/a"}`,
                ]),
          ...(cleaning
            ? [
                ``,
                `Cleaned at intake, before anything was stored or reviewed:`,
                ...cleaning.dropped.map(
                  (d) => `  ${d.path} (removed: ${d.reason})`
                ),
                ...cleaning.excluded.map(
                  (e) => `  ${e.path} (removed: ${e.reason})`
                ),
                ...cleaning.redacted.map(
                  (p) => `  ${p} (kept, with the matching spans replaced)`
                ),
                ...(cleaning.rules.length > 0
                  ? [
                      `Matched: ${cleaning.rules.map((r) => r.ruleId).join(", ")}.`,
                    ]
                  : []),
                `The submitter was told to rotate anything real in them.`,
              ]
            : []),
          // Named from the stored FILENAME, not from a literal (2026-08-28).
          // This slot used to be a Skill's SKILL.md and nothing else, so the
          // label could be hard-coded. Since the kind stopped being declared,
          // the second upload field is offered to every submitter and a Code
          // program's architecture doc lands here too, which would have made
          // this line announce a SKILL.md that was never sent. md_name is
          // what the person actually attached.
          ...(row.mdSha256
            ? [`${row.mdName ?? "SKILL.md"} SHA-256: ${row.mdSha256}`]
            : []),
          `Submitted: ${row.createdAt.toISOString()}`,
          ``,
          ...(armored.length > 0
            ? [
                `Archives are attached as base64 text because mail providers block a list of file types inside archive attachments and refuse the whole message when they find one. The provider decodes the text and screens what is inside, so entries it refuses are removed before sending rather than encoded around them.`,
              ]
            : []),
          ...(partialScreen
            ? storeVerified
              ? [
                  `The complete upload, including every entry listed above, is retained on the server in the /work archive store (data/work-archives/${row.id}/). Retrieving it is an operator action there: ${fetchCmd}. The store is the durable copy; only an admin cleaning the store removes it.`,
                ]
              : [
                  `The complete upload, including every entry listed above, remains on the submission row on the server; the archive-store copy could not be confirmed at send time, so nothing was cleared. Retrieving it is an operator action there: ${fetchCmd}.`,
                ]
            : storeVerified
              ? [
                  `A copy of these files is retained on the server in the /work archive store (data/work-archives/${row.id}/), where it stays until an admin cleans it; ${fetchCmd} retrieves it there. The submission row's own transient copy is cleared only after the store copy re-verifies inside the clearing transaction; if that verification fails the row keeps the bytes (the 2026-08-04 rule: never delete the only copy).`,
                ]
              : [
                  `These files remain on the submission row on the server: the archive-store copy could not be confirmed at send time, so nothing is cleared and the row keeps the bytes (the 2026-08-04 rule: never delete the only copy). ${fetchCmd} retrieves them.`,
                ]),
        ].join("\n")),
        // Only the files the partition attached; the body's Attached/Not
        // attached lines derive from the same items, so what the mail
        // says and what it carries can never desync.
        attachments: items.flatMap((it) =>
          it.attached
            ? [
                {
                  filename: it.prepared.attachedName,
                  content: it.prepared.contentBase64,
                },
              ]
            : []
        ),
      }),
      signal: AbortSignal.timeout(60_000),
    });
    // A send failure deletes nothing by itself; whether the row's bytea
    // clears is decided separately by the in-transaction store verification
    // (deliverArchiveRetention logs that outcome for this row id).
    if (!res.ok)
      console.log(
        `[work] retention email failed ${res.status}: ${(await res.text()).slice(0, 150)} (row ${row.id}: retained copies unaffected; clearing decided by store verification)`
      );
    return res.ok;
  } catch (err) {
    console.log(
      `[work] retention email threw: ${err instanceof Error ? err.message.slice(0, 120) : "unknown"} (row ${row.id}: retained copies unaffected; clearing decided by store verification)`
    );
    return false;
  }
}

/**
 * Fetch the retained upload and email it to the owner. Called from every
 * publish path (panel auto-publish, panel auto-approve swap, admin approve,
 * the approve route's alreadySwapped re-attempt).
 *
 * File source is store-first: the row's bytea when it still carries the
 * bytes, else the on-disk archive store (a re-publish path such as
 * approveHeld after an earlier verified clearing must still send real
 * files). A row with bytes in neither place is a pre-retention row.
 *
 * BYTEA CLEARING IS DECIDED HERE AND ONLY HERE, and it is ATOMIC. The
 * 2026-08-04 ruling ("never delete after this email; a bounced retention
 * email once destroyed the only copy") is superseded ONLY where a verified
 * second copy exists: after the send attempt, REGARDLESS of the email
 * outcome, verifyAndClearRowBytes (archive-store.ts) locks the
 * submission's ledger rows FOR UPDATE, re-checks deleted_at IS NULL,
 * re-stats every file at its recorded size AND requires each ledger
 * sha256 to equal the hash of the exact bytea being cleared (a same-size
 * wrong file - e.g. a --force work:import - must keep the bytes) INSIDE
 * that transaction, and clears the bytea in the same transaction. deleteStoredArchive's stamp
 * UPDATE serializes behind those locks, so an admin "Delete selected"
 * landing between a verification and the clear can no longer destroy both
 * copies (refutation F1). The pre-compose verifyStoredCopies below feeds
 * ONLY the email's residency copy; the clear decision rests on the in-txn
 * re-verify alone. The email was never the retention copy and its 202 is
 * still not delivery; the locked disk verification is the evidence the
 * ruling demanded. If it fails for ANY file, the row keeps its bytes and
 * the log says why. With the 100 MB cap, keeping every blob on the row is
 * no longer close to free, which is why clearing returned.
 */
export async function deliverArchiveRetention(
  row: SubmissionRow
): Promise<void> {
  const rowFiles = await archiveDataById(row.id);
  let files = rowFiles;
  let fromStore = false;
  if (files.length === 0) {
    const stored = await storedFilesForSubmission(row.id);
    if (stored) {
      // Display names: prefer the row's stamped original names over the
      // store's sanitized ones; the store's 00/01 slots are written as
      // [package, SKILL.md] by storeArchiveFiles, matching this order.
      const preferred = [row.archiveName, row.mdName];
      files = stored.map((f, i) => ({ ...f, name: preferred[i] ?? f.name }));
      fromStore = true;
    }
  }
  if (files.length === 0) {
    // A row with no copy is normally a pre-retention legacy row, and silence
    // is right for those. It is NOT right for a row that has no copy because
    // WE decided not to keep one: a cleaning rebuild we could not verify means
    // the owner gets no retention mail for a card that just published, and an
    // unexplained absence reads exactly like a bug in the retention lane.
    const cleaning = parseCleaning(row.cleaningJson);
    if (cleaning?.failed)
      await sendArchiveRetentionEmail(row, [], { storeVerified: false });
    return;
  }
  // Pre-compose verification feeds ONLY the email's residency lines (M3):
  // files just read whole from the store count as verified by the read.
  let preVerified = fromStore;
  if (!fromStore) {
    try {
      preVerified = (
        await verifyStoredCopies(
          row.id,
          rowFiles.map((f) => ({ name: f.name, bytes: f.data.length }))
        )
      ).ok;
    } catch {
      preVerified = false;
    }
  }
  const accepted = await sendArchiveRetentionEmail(row, files, {
    storeVerified: preVerified,
  });
  // The ONE clearing decision: atomic verify-and-clear (see header).
  let clear: { cleared: boolean; reason?: string } | null = null;
  if (rowFiles.length > 0) {
    try {
      // Buffers, not name/size pairs: the clear now requires the ledger
      // sha256 to equal the hash of the exact bytes being cleared.
      clear = await verifyAndClearRowBytes(row.id, rowFiles);
    } catch (err) {
      clear = {
        cleared: false,
        reason: `verify-and-clear threw: ${err instanceof Error ? err.message.slice(0, 120) : "unknown"}`,
      };
    }
    console.log(
      clear.cleared
        ? `[work] archive bytea cleared on ${row.id}: store copy re-verified inside the clearing transaction`
        : `[work] archive bytea KEPT on ${row.id}: ${clear.reason ?? "unverified"}`
    );
  }
  if (!accepted) {
    // A failed retention send used to be a bare console.log — invisible to the
    // operator and to the §5.15 ledger, so the ONLY signal that an archive copy
    // never went out was a bounce webhook nobody correlated. Route it through the
    // module send seam: a `WARN ` subject to oversight.alertEmail auto-mirrors
    // into reported_issues, so it shows up in the mandated build-start triage.
    // withTronSignature: the module's sendEmail never mutates content (its
    // documented contract) and sends from oversight.mailFrom, which is Tron's
    // mailbox for this site, so the caller appends Tron's block.
    // The location line states the ACTUAL outcome: on the store-first path
    // the row never held these bytes, so "still on the row" would be false
    // there (refutation M2).
    const location = fromStore
      ? `The files were read from the server archive store ` +
        `(data/work-archives/${row.id}/) and remain there; the submission ` +
        `row holds no copy of them. Retrieve them with ` +
        `npm run work:archive -- ${row.id}.`
      : clear?.cleared
        ? `The files are retained in the server archive store ` +
          `(data/work-archives/${row.id}/), which re-verified on disk inside ` +
          `the clearing transaction; the row's transient copy is cleared on ` +
          `that verification. Retrieve them with npm run work:archive -- ${row.id}.`
        : `The bytes are STILL on the row; nothing was deleted` +
          `${clear?.reason ? ` (store verification failed: ${clear.reason})` : ""}. ` +
          `Re-send or download them (npm run work:archive -- ${row.id}).`;
    await sendEmail(siteConfig, {
      to: siteConfig.oversight.alertEmail,
      subject: `[aiwebsite] WARN /work retention email failed to send`,
      text: withTronSignature(
        `The retention copy of the uploaded files behind a published /work card ` +
          `was NOT accepted by the mail vendor.\n\n` +
          `Title:  ${oneLine(row.title)}\n` +
          `Row id: ${row.id}\n` +
          `Files:  ${files.map((f) => `${mailSafeName(f.name)} (${f.data.length} bytes)`).join(", ")}\n\n` +
          location
      ),
    });
  }
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
    await sendGovernanceEmail({
      subject: `[aiwebsite] Your Work card published (${sctx.companyDomain ?? "company"}): ${card.title}`,
      text: [
        `A client company work submission passed the editorial panel and is published on that company's private Your Work page.`,
        ``,
        `Company: ${sctx.orgName} (${sctx.companyDomain ?? "unknown domain"})`,
        `Title: ${card.title}`,
        `Kind: ${kindLabel(row.kind)}`,
        ownerLines(row),
        `Card (signed-in company members and admins only): ${link}`,
        ``,
        `Published description (the card's first paragraph):`,
        card.summary,
        ...containedNote,
        ``,
        `To remove it: /admin/roadmap company detail, or DELETE /api/work/submissions/${row.id}.`,
      ].join("\n"),
    });
    // The owner publishing his own submission does not need the colleague-
    // voiced second copy (same rule notifyHeld already applies). The owner
    // email above is unconditional and sent first, so the skip can never
    // remove the only mail trail.
    if (row.submitterEmail.toLowerCase() === adminRecipient().toLowerCase())
      return;
    await sendGovernanceEmail({
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
    ownerLines(row),
    `Card: ${link}`,
    ``,
    `Published description (the card's first paragraph):`,
    card.summary,
    ...containedNote,
    ``,
    `The page refreshes at publish time; if /work is already open in a tab, reload it. If the card is still missing, the automatic refresh failed and the page rebuilds on the first visit after its 5-minute cache window, so allow two reloads a few minutes apart.`,
    `To remove it: /admin/work has the delete action, or DELETE /api/work/submissions/${row.id}.`,
  ].join("\n");
  await sendGovernanceEmail({
    subject: `[aiwebsite] /work card published: ${card.title}`,
    text,
  });
  // Same rule as the company lane and as notifyHeld: when the owner is the
  // submitter, the unconditional owner email above already told him. This is
  // the fleet's highest-volume duplicate — 29 of 34 submitter copies in the
  // 30 days to 2026-08-07 were the owner mailing himself.
  if (row.submitterEmail.toLowerCase() === adminRecipient().toLowerCase())
    return;
  await sendGovernanceEmail({
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
    await sendGovernanceEmail({
      subject: `[aiwebsite] Action needed: company work submission held: ${row.title}`,
      text: [
        `Review it at ${SITE}/admin/work#sub-${row.id} (approve as-is, run the panel again, or delete).`,
        ``,
        `The editorial panel held a CLIENT COMPANY work submission for a human decision. It would publish to that company's private Your Work page.`,
        ``,
        `Title: ${oneLine(row.title)}`,
        ownerLines(row),
        ``,
        `Reason:`,
        reason,
        ``,
        `Draft card JSON:`,
        JSON.stringify(draft, null, 2).slice(0, 6000),
      ].join("\n"),
    });
    await sendGovernanceEmail({
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
  await sendGovernanceEmail({
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
      `Title: ${oneLine(row.title)}`,
      ownerLines(row),
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
  await sendGovernanceEmail({
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
  await sendGovernanceEmail({
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
  await sendGovernanceEmail({
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
    await sendGovernanceEmail({
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
    await sendGovernanceEmail({
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
    await sendGovernanceEmail({
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
  await sendGovernanceEmail({
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
    await sendGovernanceEmail({
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
    await sendGovernanceEmail({
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
  await sendGovernanceEmail({
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
  await sendGovernanceEmail({
    to: row.submitterEmail,
    subject: `Your /work update was not approved: ${row.title}`,
    text: [
      `Your proposed update to "${row.title}" was reviewed and not published. The live card stays as it is, and the proposal has been removed.`,
      ``,
      `If you want to try again, revise the files and submit a new update the same way. Reply to this email or ask Adam if you want to know what to change.`,
    ].join("\n"),
  });
}

/** Case-folded address equality, the transfer round's one comparison. */
function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * The NEW owner's copy of a transfer notice, on its own so the bulk script
 * can send only this one. Skipped when the new owner is the actor (a person
 * who just moved a row to themselves does not need to be told). Text and
 * subject are exactly what notifyTransfer sent before the extraction.
 */
export async function notifyTransferNewOwner(opts: {
  /** The row AFTER the move. */
  row: SubmissionRow;
  actorEmail: string;
}): Promise<void> {
  const { row, actorEmail } = opts;
  const isCompanyLane = row.companyId !== null;
  const listUrl = isCompanyLane
    ? `${SITE}/roadmap/work`
    : `${SITE}/work/submit`;
  const listName = isCompanyLane
    ? "your company's Submit AI-Built Work page"
    : "your submissions page";
  if (sameAddress(actorEmail, row.submitterEmail)) return;
  await sendGovernanceEmail({
    to: row.submitterEmail,
    subject: `A work submission was moved to you: ${row.title}`,
    text: [
      `${actorEmail} moved the ${kindLabel(row.kind)} submission "${row.title}" to you, so it now sits with your own submissions and you have every option on it that its original submitter had.`,
      ``,
      `See it on ${listName}: ${listUrl}`,
      ``,
      `What changed: who the submission belongs to. What did not: the card itself. If it is already published it keeps the credit it was published under, and if it is still in review the panel writes the card from the same documents.`,
      ``,
      // Lane-dependent, because the control only exists on one of them:
      // /work/submit carries "Move to someone else", and the transfer route
      // is requireXlUser, so a company recipient can neither see it nor
      // call it. Naming it to them would be a control on another surface
      // AND a promise the code refuses.
      isCompanyLane
        ? `If this came to you by mistake, reply to this email and your XL.net contact will move it back.`
        : `If this came to you by mistake, move it back from that page, or reply to this email.`,
    ].join("\n"),
  });
}

/**
 * §5.16 transfer round (2026-08-09): a submission changed owner. Three
 * possible recipients, each skipped when they are the actor, because a
 * person who just pressed the button does not need to be told what they did:
 *  - the NEW owner, who now carries every lever on the row and would
 *    otherwise find a stranger's submission in their list with no
 *    explanation;
 *  - the PREVIOUS owner, whose row just vanished from their page. This is
 *    the one that must never be dropped: silence there reads as data loss.
 *  - the ADMIN mailbox, for PUBLISHED rows only and only when someone other
 *    than the owner-recipient did it: a live card's byline is public content,
 *    and the scorecard credit moves with the row.
 *
 * Deliberately says what did NOT change. The published card keeps the first
 * name it was published under (submitter_name is untouched), so the copy
 * must not imply the page now reads differently.
 *
 * The new-owner send lives in notifyTransferNewOwner so the bulk script
 * (scripts/work-transfer.ts, 2026-08-29) can send THAT copy alone: a
 * canvas-driven batch of two dozen moves out of one mailbox would otherwise
 * put two dozen "your submission was moved" mails plus two dozen owner-
 * mailbox copies into the inbox that already receives the OUTBOUND_BCC copy
 * of every send. This function's own behaviour is unchanged.
 */
export async function notifyTransfer(opts: {
  /** The row AFTER the move. */
  row: SubmissionRow;
  previousEmail: string;
  actorEmail: string;
}): Promise<void> {
  const { row, previousEmail, actorEmail } = opts;
  const isCompanyLane = row.companyId !== null;
  const same = sameAddress;
  const movedBySomeoneElse = !same(actorEmail, previousEmail);

  await notifyTransferNewOwner({ row, actorEmail });

  if (movedBySomeoneElse)
    await sendGovernanceEmail({
      to: previousEmail,
      subject: `Your work submission was moved: ${row.title}`,
      text: [
        `${actorEmail} moved the ${kindLabel(row.kind)} submission "${row.title}" to ${row.submitterEmail}, so it is no longer on your submissions page and the options on it are now theirs.`,
        // NOT an absolute. canProposeUpdate unions the whole supersede chain,
        // so someone who submitted an EARLIER version of this card keeps the
        // right to propose the next one even after the live row moves. Saying
        // "the options are now theirs" full stop would be false for exactly
        // the person most likely to try.
        ...(row.parentId
          ? [
              ``,
              `One thing does carry over: if you submitted an earlier version of this card, you can still propose an update to it from your submissions page.`,
            ]
          : []),
        ``,
        `Nothing about the submission itself changed and nothing was deleted: a published card keeps the printed byline it was published under. The scorecard counts published cards by owner, so that count moves with the submission.`,
        ``,
        `If this was not what you expected, reply to this email and it can be moved back.`,
      ].join("\n"),
    });

  // ...and never when the owner mailbox IS the new owner: they already have
  // the colleague-voiced copy above. Every sibling in this file carries the
  // same guard (notifyPublished, notifyHeld, notifyUpdateApproved).
  if (
    row.status === "published" &&
    !same(actorEmail, adminRecipient()) &&
    !same(row.submitterEmail, adminRecipient())
  )
    await sendGovernanceEmail({
      subject: `[aiwebsite] work card ownership moved: ${row.title}`,
      text: [
        `${actorEmail} moved the published ${isCompanyLane ? "company" : "/work"} card "${row.title}" from ${previousEmail} to ${row.submitterEmail}.`,
        ``,
        `The card's published credit is unchanged; what moves is who can update, retry and be emailed about it, plus the scorecard credit, which counts published cards by owner.`,
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
    await sendGovernanceEmail({
      subject: `[aiwebsite] /work card rolled back: ${parent.title}`,
      text: `${actorEmail} rolled back the update to the published team card "${parent.title}". The previous version of the card was restored: ${SITE}/work#${slug} (updates within 5 minutes).`,
    });
  if (child.submitterEmail.toLowerCase() !== actorEmail.toLowerCase())
    await sendGovernanceEmail({
      to: child.submitterEmail,
      subject: `Your /work update was rolled back: ${parent.title}`,
      text: `Your update to "${parent.title}" was rolled back and the previous version of the card was restored. The update row is gone from your submissions page. Reply to this email or ask Adam if you want to know why.`,
    });
}

/**
 * §5.16 terminal failure (2026-08-25 round): the THIRD terminal notification
 * alongside published and held, and what finally makes EMAIL_PROMISE true.
 *
 * Both sends are UNCONDITIONAL, including to a submitter who is the owner:
 * failRun has already proved the row flipped to failed, so there is nothing
 * left to predict, and gating the submitter copy on any prediction is what let
 * the outcome promise be false in a state the design's own risk register
 * documented. The operator subject is kept STABLE and distinct from every held
 * subject: the §5.12 bounce ledger keys on the subject, and the 2026-08-05
 * round exists because five unrelated causes shared one key.
 */
export async function notifyPanelFailed(
  row: SubmissionRow,
  opts: {
    message: string;
    reason: PanelFailReason;
    stage: string | null;
    detail?: string;
  }
): Promise<void> {
  const isCompanyLane = row.companyId !== null;
  // Whether a Retry actually EXISTS for this row, checked rather than assumed
  // (counterpart-panel finding, 2026-08-25: all three seats filed this). Two
  // separate ways the lever is already gone:
  //  - the per-row daily cap. claimPanel refuses once panel_runs reaches
  //    panelRunsPerSubmissionPerDay for the UTC day, so the button 409s.
  //  - held_at. claimPanel's fromHeld path flips held -> running WITHOUT
  //    clearing held_at and failPanel does not clear it either, so a failed
  //    admin re-run of a held row keeps a non-null held_at. The retry route
  //    refuses that shape (`row.heldAt`), and the admin rerun route refuses it
  //    too (it takes only held or pending_approval), so on that path NOBODY
  //    has a lever. Telling the submitter to press Retry and the owner to
  //    stand down would be the same class of false sentence as the
  //    "or over budget" literal this round deletes.
  const capped =
    row.panelRunsDate === new Date().toISOString().slice(0, 10) &&
    row.panelRuns >= WORK_CAPS.panelRunsPerSubmissionPerDay;
  const noRetry = row.heldAt !== null || capped;
  // Only a dispatch that actually reached the recovery seam made an attempt.
  // no_document fails before the first dispatch, crash comes from the runner's
  // catch, and budget never attempts (panelRecoveryPlan declines it).
  const triedRecovery =
    opts.reason === "timeout" ||
    opts.reason === "transport" ||
    opts.reason === "parse";
  const operatorBody = [
    `A /work review run ended in failed and nothing published.`,
    ``,
    `Title: ${oneLine(row.title)}`,
    ownerLines(row),
    `Lane: ${isCompanyLane ? "a client company page" : "Our Work"}`,
    `Row: ${row.id}`,
    `Cause: ${opts.reason}`,
    `Stopped at: ${opts.stage ?? "before the first step"}`,
    ``,
    opts.message,
    ...(opts.detail ? [``, `Detail: ${opts.detail}`] : []),
    ``,
    triedRecovery
      ? `The panel already made its one automatic recovery attempt on this step and could not get through. Nothing will run this row again on its own.`
      : `This one failed before any recovery attempt applied. Nothing will run this row again on its own.`,
    `Admin view: ${SITE}/admin/work#sub-${row.id}`,
    row.heldAt !== null
      ? `This row was held before, so neither the submitter's Retry nor the admin re-run will take it; clear or resubmit it.`
      : capped
        ? `The submitter has used all ${WORK_CAPS.panelRunsPerSubmissionPerDay} runs for this row today; nothing can re-run it until UTC midnight.`
        : `The submitter still has runs left today and can press Retry.`,
  ].join("\n");
  const emailed = await sendGovernanceEmail({
    subject: `[aiwebsite] WARN /work review could not finish: ${row.title}`,
    text: operatorBody,
  });
  // EPISODIC key, bounded at 6 reasons x 2 lanes = 12 rows ever. A per-row or
  // per-stage key would fill the 500-row window scripts/issues.mjs reads and
  // evict every older open issue, which is the exact failure report-issue.ts
  // was written to avoid.
  reportFailureEmailIssue({
    key: `work-panel:fail:${opts.reason}:${isCompanyLane ? "company" : "internal"}`,
    subject: `/work review could not finish (${opts.reason})`,
    detail: operatorBody,
    emailed,
  });
  // Lane-branched exactly like notifyHeld: company copy never names Adam,
  // /admin, or /work/submit.
  await sendGovernanceEmail({
    to: row.submitterEmail,
    subject: `Your work submission could not be reviewed: ${row.title}`,
    text: (isCompanyLane
      ? [
          `The review of your submission stopped before it finished, so nothing published and nothing was lost.`,
          ``,
          opts.message,
          ``,
          // A Retry the row cannot accept must not be named. "will take it
          // from here" stays true whether the fix is a re-run or a resubmit.
          noRetry
            ? `Retry is not available on this one. The XL.net team will take it from here.`
            : FAILED_NEXT_STEPS.company,
          ``,
          noRetry
            ? `The XL.net team has been notified.`
            : `The XL.net team has been notified and can run it again.`,
          ``,
          `Your submissions: ${SITE}/roadmap/work`,
        ]
      : [
          `The review of your submission stopped before it finished, so nothing published and nothing was lost.`,
          ``,
          opts.message,
          ``,
          noRetry
            ? `Retry is not available on this one. Adam will take it from here.`
            : FAILED_NEXT_STEPS.internal,
          ``,
          noRetry
            ? `Adam has been notified.`
            : `Adam has been notified and can run it again.`,
          ``,
          `Your submissions: ${SITE}/work/submit`,
        ]
    ).join("\n"),
  });
}
