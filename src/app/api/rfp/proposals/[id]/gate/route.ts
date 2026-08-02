// POST /api/rfp/proposals/[id]/gate — run the compliance gate on a draft.
//
// Pure read-and-check: it never edits the draft, so it does not bump `rev`.
// The result is stored on the row (gate_json/gate_ran_at) and returned for
// the Checks pane. Export runs the same assembly (src/lib/rfp/gate-run.ts),
// so what this pane shows is exactly what export will enforce.

import { logRfpActivity } from "@/lib/rfp/activity";
import { getDocument, getOwnedProposal } from "@/lib/rfp/db";
import { runAndStoreGate } from "@/lib/rfp/gate-run";
import { notFound, requireRfpApi, rfpError, rfpOk } from "@/lib/rfp/http";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const gate = await requireRfpApi("POST /api/rfp/proposals/[id]/gate");
  if (!gate.ok) return gate.response;
  const user = gate.user;

  const { id } = await params;
  const proposal = await getOwnedProposal(user, id);
  if (!proposal) return notFound();
  const doc = await getDocument(user, proposal.documentId);
  if (!doc) return notFound();

  const result = await runAndStoreGate(user, doc, proposal);
  if ("error" in result)
    return rfpError(
      "unavailable",
      "No rate card is loaded, so the pricing rules cannot run.",
      503
    );

  await logRfpActivity({
    actorEmail: user.email,
    actorAdmin: user.admin,
    action: "proposal.gate_run",
    subjectKind: "proposal",
    subjectId: proposal.id,
    // A failing gate is a SUCCESSFUL run that found violations; "error" is
    // reserved for a rule that crashed. Logging findings as errors made the
    // admin activity view look broken every time the gate did its job.
    outcome: result.errors.length > 0 ? "error" : "ok",
    meta: {
      passed: result.passed,
      violations: result.violations.length,
      failedRules: result.failedRules.join(","),
      errors: result.errors.length,
    },
  });

  return rfpOk(result);
}
