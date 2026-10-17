// GET /api/rfp/proposals/[id]/export?format=docx|pdf|zip — emit the response.
//
// format=zip (§5.17.23) is the submission package: the PDF and the Word
// file built by the SAME renderers the plain formats run, on the same
// resolved view, plus each picked attachment's bytes pulled by id at export
// time, in pick order (furniture.ts packageEntryNames). It needs at least
// one pick, and every confidential pick's per-proposal confirmation; a
// refusal names the TITLE only. The attachments together may hold at most
// 120 MB (PACKAGE_ATTACHMENTS_MAX_BYTES): over it the package is refused
// with 413 before a byte is read or a file renders. Bytes never reach a log
// or the activity row (counts only).
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
import {
  PACKAGE_ATTACHMENTS_MAX_BYTES,
  PACKAGE_ATTACHMENTS_MAX_COPY,
} from "@/lib/rfp/attachments";
import {
  getDocument,
  getLibraryDocumentFile,
  libraryDocumentsByIds,
  getOwnedProposal,
  readProposalAttachments,
  readProposalChecksIgnores,
  writeProposalGate,
} from "@/lib/rfp/db";
import {
  buildExportView,
  buildSubmissionZip,
  exportFileName,
  renderRfpDocx,
  renderRfpPdf,
  type PackageAttachment,
} from "@/lib/rfp/export";
import { applyIgnores, parseCheckIgnores } from "@/lib/rfp/check-ignores";
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
  if (format !== "docx" && format !== "pdf" && format !== "zip")
    return rfpError("invalid_request", "format must be docx, pdf or zip.", 400);

  // The picks as stored (attachments.ts readProposalAttachments, tolerant).
  const attachmentState = readProposalAttachments(proposal.attachmentsJson);
  if (format === "zip" && attachmentState.picks.length === 0)
    return rfpError(
      "not_ready",
      "No supporting documents are picked for this proposal. Pick them in the Attachments pane first.",
      409
    );
  // The package's size guard (U3), from octet_length alone: no byte is
  // read, and nothing renders, for a package that cannot be built.
  if (format === "zip") {
    let total = 0;
    try {
      total = (await libraryDocumentsByIds(attachmentState.picks.map((p) => p.docId))).reduce(
        (sum, d) => sum + d.sizeBytes,
        0
      );
    } catch (err) {
      console.error("[rfp] package size check failed:", err instanceof Error ? err.constructor.name : "error");
      return rfpError("unavailable", "The attachments could not be checked. Try again.", 503);
    }
    if (total > PACKAGE_ATTACHMENTS_MAX_BYTES)
      return rfpError(
        "too_large",
        `The attachments together are over ${PACKAGE_ATTACHMENTS_MAX_COPY}, too large for one package. Remove one in the Attachments pane, or download the response and send the largest documents separately.`,
        413
      );
  }

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

  // Persisted Checks-pane dismissals are re-applied before the store AND
  // before the draft/header computation below (§5.17.8): the same re-apply
  // gate-run.ts does, so the pane and this export can never disagree, and an
  // ignored finding no longer counts as outstanding — intended. The column
  // is re-read after the rules run, mirroring gate-run.ts, so an Ignore
  // landing mid-run still marks the stored result. atRev is stamped exactly
  // as gate-run.ts stamps it, before the re-apply.
  const raw = { ...runDraftGate(input), atRev: proposal.rev };
  const result = applyIgnores(
    raw,
    parseCheckIgnores(await readProposalChecksIgnores(proposal.id))
  );
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

  // The package's files are read BEFORE anything renders, so a missing or
  // unconfirmed document refuses without building either file.
  const packaged: PackageAttachment[] = [];
  let confidentialCount = 0;
  if (format === "zip") {
    for (const pick of attachmentState.picks) {
      const file = await getLibraryDocumentFile(pick.docId);
      if (!file)
        return rfpError(
          "not_ready",
          `The attachment "${pick.title}" is no longer in the library. Remove it in the Attachments pane.`,
          409
        );
      if (file.confidential) {
        if (!pick.confidentialConfirmed)
          return rfpError(
            "not_ready",
            `"${pick.title}" is confidential. Confirm it for this proposal in the Attachments pane first.`,
            409
          );
        confidentialCount++;
      }
      packaged.push({ n: pick.n, title: pick.title, media: file.media, bytes: file.bytes });
    }
  }

  let buffer: Buffer;
  if (format === "zip") {
    // The SAME builders the plain formats use, on the same view.
    const [pdf, docx] = [await renderRfpPdf(view), await renderRfpDocx(view)];
    buffer = await buildSubmissionZip({ clientName: doc.clientName, pdf, docx, attachments: packaged });
  } else buffer = format === "docx" ? await renderRfpDocx(view) : await renderRfpPdf(view);
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
      // Counts only, never a title or a byte (§5.17.23).
      attachments: attachmentState.picks.length,
      ...(format === "zip" ? { confidentialAttachments: confidentialCount } : {}),
    },
  });

  return new Response(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "content-type":
        format === "docx"
          ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          : format === "zip"
            ? "application/zip"
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
