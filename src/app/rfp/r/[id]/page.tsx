// /rfp/r/[id] — the RFP workspace (§5.17).
//
// Left: the draft. Right: coverage, the gate, and Tron. Someone else's id
// yields notFound(), never a 403, because a 403 confirms the row exists.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireRfpPage } from "@/lib/rfp/access";
import {
  currentRateCard,
  genClaimActive,
  getDocument,
  getProposalForDocument,
  hasPendingIntakeParts,
  libraryDocumentsByIds,
  listRequirements,
} from "@/lib/rfp/db";
import { readProposalAttachments } from "@/lib/rfp/attachments";
import { ownerDisplayName } from "@/lib/rfp/gate-run";
import { signatureFor } from "@/lib/rfp/signature";
import { rateNoteCodes, rateNoteFor, toRateCard } from "@/lib/rfp/quote";
import {
  minimumAssumption,
  normGroundText,
  parseStaffRange,
  staffConflictSignals,
  staffMentions,
  type StatedStaff,
} from "@/lib/rfp/staff-count";
import {
  asksAboutReferences,
  unansweredReferencesAsks,
} from "@/lib/rfp/references-ask";
import { stripIntakeHeaders } from "@/lib/rfp/intake";
import { When } from "@/components/when";
import { Workspace } from "./workspace";
import type { DraftSectionRecord } from "@/app/api/rfp/documents/[id]/generate/route";
import type { GateResult } from "@/lib/rfp/validators/gate";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Never names the client: a tab-bar screenshot is the commonest accidental leak.
export const metadata: Metadata = {
  title: "RFP workspace",
  robots: { index: false, follow: false },
};

export default async function RfpWorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ draft?: string }>;
}) {
  // The login redirect carries THIS workspace's path, not the list: a
  // signed-out deep link should land back where it pointed.
  const { id } = await params;
  const gate = await requireRfpPage(`/rfp/r/${id}`);
  if (!gate.ok) return null;

  const doc = await getDocument(gate.user, id);
  if (!doc) notFound();

  const [requirements, proposal, rateCard, sp] = await Promise.all([
    listRequirements(doc.id),
    getProposalForDocument(doc.id),
    currentRateCard(),
    searchParams,
  ]);

  // The letter signs as the PROPOSAL owner — the identity the gate and the
  // export sign with (an admin drafting on another user's document creates
  // the proposal under their own email). Before any proposal exists the
  // document owner stands in.
  const signerEmail = proposal?.ownerEmail ?? doc.ownerEmail;
  const preparedBy = await ownerDisplayName(signerEmail);

  const structure: { label: string; title: string }[] = doc.structureJson
    ? JSON.parse(doc.structureJson)
    : [];
  // Seeds the read panel's copy (§5.17.18): a read that failed or stopped
  // while transcribing has no text yet, only the attached files.
  const transcribePending =
    structure.length === 0 ? await hasPendingIntakeParts(doc.id) : false;
  // Parsed once: the prop and the stale verdict read the same object. A
  // stored run stamped with an older rev describes an earlier draft
  // (§5.17.8). A row stored before atRev existed carries none: content
  // writes no longer null the stored verdict, so such a row cannot prove it
  // is current and reads as stale (the banner only says findings MAY be
  // resolved and offers a re-run, which stamps it).
  const storedGate: GateResult | null = proposal?.gateJson
    ? JSON.parse(proposal.gateJson)
    : null;
  const gateStale =
    proposal !== null &&
    storedGate !== null &&
    (typeof storedGate.atRev !== "number" ||
      storedGate.atRev !== proposal.rev);

  const sections: DraftSectionRecord[] = proposal
    ? JSON.parse(proposal.sectionsJson || "[]")
    : [];

  // Round 35 (§5.17.23): the proposal's attachment picks and mapping, each
  // pick joined with its library flags (kind, confidential, redacted sample;
  // a retired row still answers, its bytes still export). Titles and flags
  // only: no library byte or content reaches the client.
  const stored = readProposalAttachments(proposal?.attachmentsJson ?? null);
  const pickedDocs = new Map(
    (await libraryDocumentsByIds(stored.picks.map((p) => p.docId))).map((d) => [
      d.id.toLowerCase(),
      d,
    ])
  );
  const attachments = {
    picks: stored.picks.map((p) => {
      const d = pickedDocs.get(p.docId);
      return {
        ...p,
        kind: d?.kind ?? "",
        confidential: d?.confidential ?? false,
        redactedSample: d?.redactedSample ?? false,
        // The pane badges a pick whose library row has since retired.
        retired: d?.retired ?? false,
      };
    }),
    map: stored.map,
    ...(stored.pickedAt ? { pickedAt: stored.pickedAt } : {}),
  };

  // ---- staff evidence, computed HERE (ARCHITECTURE.md §5.17.3) ----
  // The scanner in staff-count.ts (lookbehind regexes, whole-document
  // passes) and the raw document both stay on the server: the client gets
  // the finished quotes and verdicts as plain props and imports only types.
  const statedStaff: StatedStaff | null = doc.statedStaffQuote
    ? {
        count: doc.statedStaffCount,
        quote: doc.statedStaffQuote,
        basis: doc.statedStaffBasis === "users" ? "users" : "staff",
      }
    : null;
  // Headers composed by the multi-file intake are stripped before any scan:
  // they embed attacker-chosen filenames and are furniture, not RFP text.
  const scanText = stripIntakeHeaders(doc.rawText);
  const mentions = staffMentions(scanText);
  // The sentences shown as evidence: the grounded statedStaff quote first,
  // then the scanned mentions, with one that repeats (or sits inside) a
  // sentence already listed dropped so nothing prints twice.
  const staffEvidence: string[] = [];
  {
    const seen: string[] = [];
    for (const quote of [
      ...(statedStaff ? [statedStaff.quote] : []),
      ...mentions.map((m) => m.quote),
    ]) {
      const norm = normGroundText(quote).toLowerCase();
      if (!norm || seen.some((s) => s.includes(norm) || norm.includes(s)))
        continue;
      seen.push(norm);
      staffEvidence.push(quote);
    }
  }
  // The floor comes from the rate card in force, never a literal in the
  // client. No card: nulls, and the question falls back to its plain wording.
  const minimumUsers = rateCard?.minimumFullyManagedUsers ?? null;
  // Each nameable rate-card code's SYSTEM note (quote.ts rateNoteFor, the
  // composer resolve-draft lifts matrix rows with, §5.17.22), so the screen's
  // matrix rows carry the notes the files print. Notes only, never the card.
  const rateNotes: Record<string, string> = {};
  if (rateCard) {
    const card = toRateCard(rateCard);
    for (const code of rateNoteCodes(card)) {
      const note = rateNoteFor([code], card);
      if (note) rateNotes[code] = note;
    }
  }
  // Non-null = the RFP's own wording places the client inside the monthly
  // minimum, so the one-tap "Use up to N users" is the PRIMARY answer on the
  // user-count question. It never seeds a count: the generate route seeds
  // only an exact grounded one. A larger population anywhere in the
  // document (the conflict scan) turns it back into the plain question.
  const staffConflict =
    minimumUsers !== null && staffConflictSignals(scanText, minimumUsers);
  const minimumEvidence =
    minimumUsers === null || staffConflict
      ? null
      : minimumAssumption(statedStaff, mentions, minimumUsers);

  // ---- references (references-ask.ts, §5.17.2), also server-side ----
  // A proposal drafted before the backstop existed can have dropped the
  // RFP's ask for references: no references in the text, no open question.
  // The workspace offers to add the question (POST .../references-gap).
  const refsMissing = unansweredReferencesAsks(requirements, sections).map(
    (a) => ({ label: a.label, count: a.count })
  );
  // Model-worded references questions open at load, by exact stored text.
  // The canonical question is recognized client-side; these are not, and
  // the answer box must not offer to keep a third party's contact details.
  const referencesQuestions = sections
    .filter((s) => !s.label.startsWith("__"))
    .flatMap((s) => s.gaps.map((g) => g.question))
    .filter((q) => asksAboutReferences(q));

  return (
    <div className="space-y-6">
      <div>
        <span className="sys-label">
          {doc.clientName ?? "Client not named"}
        </span>
        <h2 className="doc-h mt-3">{doc.title}</h2>
        <p className="mt-2 text-sm text-faint">
          {requirements.length} requirement
          {requirements.length === 1 ? "" : "s"} · {structure.length} section
          {structure.length === 1 ? "" : "s"} · updated <When iso={doc.updatedAt.toISOString()} />
          {doc.ownerEmail !== gate.user.email.toLowerCase() && (
            <> · owned by {doc.ownerEmail}</>
          )}
        </p>
        {doc.injectionFlagged && (
          <div className="panel panel--lightline-sand mt-4">
            <p className="text-sm">
              Lines in this RFP looked like instructions aimed at an AI rather
              than questions for a bidder, and were dropped before anything read
              it. Worth a look at the original.
            </p>
          </div>
        )}
      </div>

      <Workspace
        documentId={doc.id}
        proposalId={proposal?.id ?? null}
        structure={structure}
        requirements={requirements.map((r) => ({
          id: r.id,
          structureLabel: r.structureLabel,
          text: r.text,
          mandatory: r.mandatory,
          kind: r.kind,
          clientRef: r.clientRef ?? null,
          ordinal: r.ordinal,
        }))}
        sections={sections}
        rev={proposal?.rev ?? 0}
        pricing={proposal?.pricingJson ? JSON.parse(proposal.pricingJson) : null}
        pricingInputs={
          proposal?.pricingInputsJson
            ? JSON.parse(proposal.pricingInputsJson)
            : null
        }
        gateResult={storedGate}
        gateStale={gateStale}
        busy={proposal ? genClaimActive(proposal) : false}
        genError={proposal?.genError ?? null}
        autoDraft={sp.draft === "all"}
        docStatus={doc.status}
        transcribePending={transcribePending}
        intakeForm={doc.intakeForm}
        contactName={doc.contactName}
        contactTitle={doc.contactTitle}
        // Round-32 stored furniture (§5.17.20): the letterhead's postal
        // lines and a brief's narrative cover headline, as the files print.
        clientAddress={doc.clientAddress}
        proposalHeadline={doc.proposalHeadline}
        // Round 33 (§5.17.21): a brief's stored part titles and deks, read
        // by the same resolution resolve-draft hands both files.
        partsJson={proposal?.partsJson ?? null}
        // Round 35 (§5.17.23): picks (with library flags) and the
        // per-requirement mapping the Attachments pane edits.
        attachments={attachments}
        // Round 34 (§5.17.22): the grounded subject line the real-RFP cover
        // lede names, and the system rate notes the matrix rows carry.
        rfpTitle={doc.rfpTitle ?? null}
        rateNotes={rateNotes}
        archived={Boolean(doc.archivedAt)}
        clientName={doc.clientName}
        // The cover names who the EXPORT names (resolve-draft.ts `cover`):
        // the client, else the proposal title. Before a proposal exists the
        // document title stands in, because that is the title the proposal
        // is created with.
        coverClientName={
          doc.clientName?.trim() || proposal?.title || doc.title || null
        }
        statedStaff={statedStaff}
        // Every sentence of the RFP that speaks to headcount, scanned and
        // deduped above so the raw document never ships to the client.
        // Shown beside the user count as evidence, whatever its source.
        staffEvidence={staffEvidence}
        // The stated RANGE, from the same parse that grounded it.
        staffRange={
          statedStaff && statedStaff.count === null
            ? parseStaffRange(statedStaff.quote)
            : null
        }
        minimumEvidence={minimumEvidence}
        staffConflict={staffConflict}
        refsMissing={refsMissing}
        referencesQuestions={referencesQuestions}
        minimumUsers={minimumUsers}
        minimumMonthlyCents={rateCard?.minimumMonthlyFeeCents ?? null}
        preparedBy={preparedBy}
        ownerEmail={signerEmail}
        signature={signatureFor(signerEmail, preparedBy)}
      />
    </div>
  );
}
