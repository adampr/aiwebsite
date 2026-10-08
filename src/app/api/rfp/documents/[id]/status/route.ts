// GET /api/rfp/documents/[id]/status — the one poll target for this RFP.
//
// Serves two pollers with one shape:
//   - ingest (new/form.tsx): `status`, `requirements`, `structure`
//   - the workspace: `proposal.gen` (a drafting run in flight?) plus the
//     draft content itself, REV-GATED — pass ?rev=<n> and `sections`,
//     `pricing` are included only when the stored rev moved past n, so the
//     3s drafting poll stays a few hundred bytes until something changed.
//
// The document status column never carries a drafting state; generation
// state lives on the PROPOSAL row (gen_started_at + gen_attempt_id). The
// workspace's old poll watched doc.status for "drafting", which never
// occurs, so it gave up after one tick. This shape is the fix.

import {
  genClaimActive,
  getDocument,
  getProposalForDocument,
  listRequirements,
} from "@/lib/rfp/db";
import { notFound, requireRfpApi, rfpOk } from "@/lib/rfp/http";
import { RFP_READ_STALE_MS } from "@/lib/rfp/intake";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const gate = await requireRfpApi("GET /api/rfp/documents/[id]/status");
  if (!gate.ok) return gate.response;

  const { id } = await params;
  const doc = await getDocument(gate.user, id);
  if (!doc) return notFound();

  const reqs = await listRequirements(doc.id);
  const structure: unknown = doc.structureJson ? JSON.parse(doc.structureJson) : [];
  const proposal = await getProposalForDocument(doc.id);

  const url = new URL(req.url);
  const sinceRev = Number(url.searchParams.get("rev") ?? "-1");

  let proposalView: Record<string, unknown> | null = null;
  if (proposal) {
    proposalView = {
      id: proposal.id,
      rev: proposal.rev,
      gen: {
        // Same staleness formula as the generate route's 409 check, so the
        // poller and the claim can never disagree about "busy".
        inFlight: genClaimActive(proposal),
        progress: proposal.genProgress,
        error: proposal.genError,
      },
    };
    if (!Number.isFinite(sinceRev) || proposal.rev > sinceRev) {
      proposalView.sections = JSON.parse(proposal.sectionsJson || "[]");
      proposalView.pricing = proposal.pricingJson
        ? JSON.parse(proposal.pricingJson)
        : null;
      proposalView.pricingInputs = proposal.pricingInputsJson
        ? JSON.parse(proposal.pricingInputsJson)
        : null;
    }
  }

  return rfpOk({
    id: doc.id,
    status: doc.status,
    // "reading" with no live reader possible (a restart or deploy dropped
    // the background task): the workspace offers Read it again.
    readStale:
      doc.status === "reading" &&
      Date.now() - doc.updatedAt.getTime() > RFP_READ_STALE_MS,
    clientName: doc.clientName,
    requirements: reqs.length,
    structure,
    // Lets the workspace tell an extracted-but-empty read (offer Read it
    // again, §5.17.17) from a read with sections to draft.
    structureNodes: Array.isArray(structure) ? structure.length : 0,
    injectionFlagged: doc.injectionFlagged,
    proposal: proposalView,
  });
}
