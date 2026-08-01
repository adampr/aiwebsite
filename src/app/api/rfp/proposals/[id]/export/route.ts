// GET /api/rfp/proposals/[id]/export?format=docx|pdf — emit the response.
//
// Export is the moment a draft becomes a thing a client could read, so the
// compliance gate runs HERE, on the exact content being emitted, and a
// failing gate refuses the download (409 with the violations). Open gaps
// refuse too: a proposal does not go out with declared unanswered questions
// in it. The gate result is stored either way, so the Checks pane shows the
// same verdict the export enforced. Generated on demand and streamed, never
// stored — the same contract as governance downloads.

import { logRfpActivity } from "@/lib/rfp/activity";
import { getDocument, getOwnedProposal, writeProposalGate } from "@/lib/rfp/db";
import { buildExportView, exportFileName, renderRfpDocx, renderRfpPdf } from "@/lib/rfp/export";
import { buildGateInput } from "@/lib/rfp/gate-run";
import { buildQuote, parseQuoteInputs } from "@/lib/rfp/quote";
import { resolveDraft, runDraftGate } from "@/lib/rfp/resolve-draft";
import { notFound, requireRfpApi, rfpError, rfpOk } from "@/lib/rfp/http";

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

  // The pricing questionnaire must be finished before export: the engine's
  // own missing[] says the quote is not complete enough to send, and the
  // gate cannot see unanswered questions (they are absent inputs, not
  // violations). An untouched questionnaire refuses the same way — the
  // workspace shows those questions as open, and a document that quietly
  // exported without its Investment section while the pane counts five
  // open questions would be the tool contradicting itself.
  const pricingMissing = buildQuote(
    input.rateCard,
    parseQuoteInputs(
      proposal.pricingInputsJson ? JSON.parse(proposal.pricingInputsJson) : {}
    ),
    proposal.id
  ).missing;

  if (!result.passed || openGaps > 0 || pricingMissing.length > 0) {
    await logRfpActivity({
      actorEmail: user.email,
      actorAdmin: user.admin,
      action: "proposal.export",
      subjectKind: "proposal",
      subjectId: proposal.id,
      outcome: "denied",
      meta: {
        format,
        passed: result.passed,
        openGaps,
        pricingMissing: pricingMissing.length,
        failedRules: result.failedRules.join(","),
      },
    });
    return rfpOk(
      {
        error: "not_ready",
        message:
          openGaps > 0
            ? `${openGaps} open question${openGaps === 1 ? "" : "s"} still need${openGaps === 1 ? "s" : ""} an answer before this can go out.`
            : pricingMissing.length > 0
              ? `The pricing questionnaire is not finished: ${pricingMissing.length} answer${pricingMissing.length === 1 ? "" : "s"} still missing. The Questions pane walks through them.`
              : "The compliance gate is failing. Fix the blocking findings first.",
        gate: {
          passed: result.passed,
          failedRules: result.failedRules,
          violations: result.violations.slice(0, 20).map((v) => ({
            ruleId: v.ruleId,
            severity: v.severity,
            message: v.message,
          })),
          errors: result.errors,
        },
        openGaps,
        pricingMissing,
      },
      409
    );
  }

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
    meta: { format, sections: input.sections.length, bytes: buffer.length },
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
    },
  });
}
