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
  listRequirements,
} from "@/lib/rfp/db";
import { ownerDisplayName } from "@/lib/rfp/gate-run";
import { signatureFor } from "@/lib/rfp/signature";
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
import { When } from "@/components/when";
import { Workspace } from "./workspace";
import type { DraftSectionRecord } from "@/app/api/rfp/documents/[id]/generate/route";

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
  const sections: DraftSectionRecord[] = proposal
    ? JSON.parse(proposal.sectionsJson || "[]")
    : [];

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
  const mentions = staffMentions(doc.rawText);
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
  // Non-null = the RFP's own wording places the client inside the monthly
  // minimum, so the one-tap "Use up to N users" is the PRIMARY answer on the
  // user-count question. It never seeds a count: the generate route seeds
  // only an exact grounded one. A larger population anywhere in the
  // document (the conflict scan) turns it back into the plain question.
  const staffConflict =
    minimumUsers !== null && staffConflictSignals(doc.rawText, minimumUsers);
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
        }))}
        sections={sections}
        rev={proposal?.rev ?? 0}
        pricing={proposal?.pricingJson ? JSON.parse(proposal.pricingJson) : null}
        pricingInputs={
          proposal?.pricingInputsJson
            ? JSON.parse(proposal.pricingInputsJson)
            : null
        }
        gateResult={proposal?.gateJson ? JSON.parse(proposal.gateJson) : null}
        busy={proposal ? genClaimActive(proposal) : false}
        genError={proposal?.genError ?? null}
        autoDraft={sp.draft === "all"}
        docStatus={doc.status}
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
