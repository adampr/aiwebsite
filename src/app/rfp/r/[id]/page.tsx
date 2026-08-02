// /rfp/r/[id] — the RFP workspace (§5.17).
//
// Left: the draft. Right: coverage, the gate, and Tron. Someone else's id
// yields notFound(), never a 403, because a 403 confirms the row exists.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireRfpPage } from "@/lib/rfp/access";
import {
  genClaimActive,
  getDocument,
  getProposalForDocument,
  listRequirements,
} from "@/lib/rfp/db";
import { ownerDisplayName } from "@/lib/rfp/gate-run";
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

  const [requirements, proposal, sp, preparedBy] = await Promise.all([
    listRequirements(doc.id),
    getProposalForDocument(doc.id),
    searchParams,
    ownerDisplayName(doc.ownerEmail),
  ]);

  const structure: { label: string; title: string }[] = doc.structureJson
    ? JSON.parse(doc.structureJson)
    : [];
  const sections: DraftSectionRecord[] = proposal
    ? JSON.parse(proposal.sectionsJson || "[]")
    : [];

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
        docTitle={doc.title}
        statedStaff={
          doc.statedStaffQuote
            ? {
                count: doc.statedStaffCount,
                quote: doc.statedStaffQuote,
                basis: doc.statedStaffBasis === "users" ? "users" : "staff",
              }
            : null
        }
        preparedBy={preparedBy}
        ownerEmail={doc.ownerEmail}
      />
    </div>
  );
}
