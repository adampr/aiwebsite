// GET /api/rfp/proposals/[id]/export?format=docx|pdf — emit the response.
//
// The CURRENT STATE always downloads (owner directive), and the FILE is
// never marked: no DRAFT anywhere in it, by owner ruling 2026-08-28 (the
// old cover line / corner mark / footer prefix / -DRAFT filename are gone).
// The compliance gate still runs here on the exact content being emitted;
// what is outstanding travels ONLY in the x-rfp-* response headers, which
// the workspace turns into its export notice. Only a proposal with zero
// drafted sections refuses (there is nothing to render). The gate result is
// stored on every run, so the Checks pane stays current. Generated on
// demand and streamed, never stored — the same contract as governance
// downloads.

import { logRfpActivity } from "@/lib/rfp/activity";
import { getDocument, getOwnedProposal, writeProposalGate } from "@/lib/rfp/db";
import { buildExportView, exportFileName, renderRfpDocx, renderRfpPdf } from "@/lib/rfp/export";
import { buildGateInput } from "@/lib/rfp/gate-run";
import { buildQuote, parseQuoteInputs } from "@/lib/rfp/quote";
import { resolveDraft, runDraftGate } from "@/lib/rfp/resolve-draft";
import { notFound, requireRfpApi, rfpError } from "@/lib/rfp/http";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const gate = await requireRfpApi("GET /api/rfp/proposals/[id]/export");
  if (!gate.ok) return gate.response;
  const user = gate.user;

  const { id } = await params;
  const proposal = await getOwnedProposal(user, id);
  if (!proposal) return notFound();
  const doc = await getDocument(user, proposal.documentId);
  if (!doc) return notFound();

  const url = new URL(req.url);
  const format = url.searchParams.get("format");
  if (format !== "docx" && format !== "pdf")
    return rfpError("invalid_request", "format must be docx or pdf.", 400);

  const input = await buildGateInput(user, doc, proposal);
  if ("error" in input)
    return rfpError(
      "unavailable",
      "No rate card is loaded, so the pricing rules cannot run.",
      503
    );

  if (input.sections.length === 0)
    return rfpError(
      "not_ready",
      "Nothing has been drafted yet. Draft the response first.",
      409
    );

  const result = runDraftGate(input);
  await writeProposalGate(proposal.id, JSON.stringify(result));

  const openGaps = input.sections.reduce((n, s) => n + s.gaps.length, 0);

  // Unanswered pricing inputs are draft-markers the gate cannot see (they
  // are absent answers, not violations); the engine's own missing[] is the
  // authority, and an untouched questionnaire counts in full.
  const pricingMissing = buildQuote(
    input.rateCard,
    parseQuoteInputs(
      proposal.pricingInputsJson ? JSON.parse(proposal.pricingInputsJson) : {}
    ),
    proposal.id
  ).missing;

  // Still computed, but it never touches the FILE any more: it feeds the
  // x-rfp-* headers (the workspace's export notice) and the activity log.
  const draft = !result.passed || openGaps > 0 || pricingMissing.length > 0;

  const { resolved } = resolveDraft(input);
  const view = buildExportView(resolved, input.rateCard);

  const buffer =
    format === "docx" ? await renderRfpDocx(view) : await renderRfpPdf(view);
  const filename = exportFileName(view, format);

  await logRfpActivity({
    actorEmail: user.email,
    actorAdmin: user.admin,
    action: "proposal.export",
    subjectKind: "proposal",
    subjectId: proposal.id,
    meta: {
      format,
      sections: input.sections.length,
      bytes: buffer.length,
      draft,
      openGaps,
      pricingMissing: pricingMissing.length,
      failedRules: result.failedRules.join(","),
    },
  });

  return new Response(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "content-type":
        format === "docx"
          ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          : "application/pdf",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store, private",
      "x-rfp-draft": draft ? "1" : "0",
      "x-rfp-open-gaps": String(openGaps),
      "x-rfp-pricing-missing": String(pricingMissing.length),
      "x-rfp-gate-passed": result.passed ? "1" : "0",
    },
  });
}
