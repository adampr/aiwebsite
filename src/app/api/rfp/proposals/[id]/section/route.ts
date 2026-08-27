// Section-level writes on a draft (§5.17).
//
//   PATCH  — a human edits the text of one section
//   POST   — Tron proposes a revision (returns a PROPOSAL, writes nothing);
//            under the DOC_LABEL sentinel it PLANS instead, returning the
//            sections to change so the client can loop them through here
//
// THE INVARIANT BOTH PATHS PRESERVE: `cites` and `generatedBy` are carried
// over from the stored section and are never taken from the request body.
// Rule A5 only requires citations when generatedBy === "llm", and rule C1's
// staleness sweep joins on cites, so a write that could clear either field, or
// relabel an llm block as human, would launder an uncited claim past the two
// validators that exist to catch exactly that. Both fail OPEN when cites is
// empty, which is why this is enforced here rather than trusted to a form.

import {
  planDocumentRevision,
  reviseSection,
  brainHealthy,
} from "@/lib/rfp/brain";
import { DOC_LABEL, LETTER_LABEL } from "@/lib/rfp/letter";
import { logRfpActivity } from "@/lib/rfp/activity";
import {
  getOwnedProposal,
  knowledgeForUser,
  writeProposalSections,
} from "@/lib/rfp/db";
import { notFound, requireRfpApi, rfpError, rfpOk } from "@/lib/rfp/http";
import { extractStyleSampleText } from "@/lib/governance/style-sample";
import { screenInjection } from "@/lib/governance/research";
import type { DraftSectionRecord } from "../../../documents/[id]/generate/route";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** Same ceiling as RFP ingest: well under the 12m nginx cap. */
const MAX_ATTACH_BYTES = 8_000_000;
const MAX_ATTACH_CHARS = 20_000;
const TEXT_EXTENSIONS = /\.(txt|md|csv|log|json)$/i;
const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp|heic|svg)$/i;

/**
 * Turn an attached file into fenced text for the revision turn.
 * PDF and .docx go through the same extractor as RFP ingest; plain-text
 * formats (txt, md, csv, log, json) are decoded directly. Images are
 * refused HONESTLY: the drafting service reads text only, and pretending
 * otherwise would silently drop the content.
 */
async function extractAttachment(
  file: File
): Promise<
  | { ok: true; name: string; text: string; injectionHits: number }
  | { ok: false; message: string }
> {
  if (file.size > MAX_ATTACH_BYTES)
    return { ok: false, message: "That file is over 8 MB." };
  const name = file.name.slice(0, 200);
  if (IMAGE_EXTENSIONS.test(name))
    return {
      ok: false,
      message:
        "Images cannot be read yet; the drafting service is text-only. Export the content as PDF, Word, or text and attach that.",
    };
  const buf = Buffer.from(await file.arrayBuffer());
  if (TEXT_EXTENSIONS.test(name)) {
    const text = buf.toString("utf8").slice(0, MAX_ATTACH_CHARS).trim();
    if (!text)
      return { ok: false, message: "That file has no readable text." };
    return { ok: true, name, text, injectionHits: screenInjection(text).hits.length };
  }
  if (/\.(pdf|docx)$/i.test(name)) {
    const extracted = await extractStyleSampleText(name, buf, MAX_ATTACH_CHARS);
    if (!extracted.ok)
      return {
        ok: false,
        message:
          "Could not read that file. Scanned PDFs with no text layer are the usual cause.",
      };
    return {
      ok: true,
      name,
      text: extracted.text,
      injectionHits: screenInjection(extracted.text).hits.length,
    };
  }
  return {
    ok: false,
    message: "Attach a PDF, Word .docx, or a text file (.txt, .md, .csv, .log, .json).",
  };
}

/** PATCH — save a human edit to one section's paragraphs. */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const gate = await requireRfpApi("PATCH /api/rfp/proposals/[id]/section");
  if (!gate.ok) return gate.response;
  const user = gate.user;

  const { id } = await params;
  const proposal = await getOwnedProposal(user, id);
  if (!proposal) return notFound();
  if (proposal.status === "sent")
    return rfpError(
      "immutable",
      "A sent proposal is never edited. A correction creates a new one.",
      409
    );

  let body: { label?: string; paragraphs?: string[] };
  try {
    body = await req.json();
  } catch {
    return rfpError("invalid_request", "Send JSON.", 400);
  }
  const label = String(body.label ?? "");
  const paragraphs = (Array.isArray(body.paragraphs) ? body.paragraphs : [])
    .filter((p) => typeof p === "string")
    .slice(0, 12)
    .map((p) => p.slice(0, 4000));

  const sections: DraftSectionRecord[] = JSON.parse(proposal.sectionsJson || "[]");
  const at = sections.findIndex((s) => s.label === label);
  if (at < 0) return rfpError("not_found", "No such section.", 404);

  sections[at] = {
    ...sections[at],
    paragraphs,
    // cites and generatedBy deliberately NOT taken from the body. See header.
    cites: sections[at].cites,
    // THE ONE carve-out from the header invariant, and it is label-scoped,
    // server-side, and safe: the letter record never becomes blocks
    // (resolve-draft routes it into furniture), so A5/C1 never read its
    // generatedBy and nothing is laundered. The stamp is what lets the
    // generate route and draft-all refuse to clobber a hand-edited letter.
    // Real sections keep the stored value exactly as before.
    generatedBy:
      label === LETTER_LABEL ? "human" : sections[at].generatedBy,
    updatedAt: new Date().toISOString(),
  };

  const ok = await writeProposalSections(
    proposal.id,
    proposal.rev,
    JSON.stringify(sections)
  );
  if (!ok)
    return rfpError(
      "conflict",
      "Someone else changed this draft while you were editing. Reload to see their version.",
      409
    );

  await logRfpActivity({
    actorEmail: user.email,
    actorAdmin: user.admin,
    action: "proposal.section_edit",
    subjectKind: "proposal",
    subjectId: proposal.id,
    meta: { section: label, paragraphs: paragraphs.length },
  });

  return rfpOk({ ok: true, rev: proposal.rev + 1 });
}

/** POST — ask Tron for a revision. Returns a proposal; writes nothing. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const gate = await requireRfpApi("POST /api/rfp/proposals/[id]/section");
  if (!gate.ok) return gate.response;
  const user = gate.user;

  const { id } = await params;
  const proposal = await getOwnedProposal(user, id);
  if (!proposal) return notFound();

  // JSON for a plain instruction; multipart when a document rides along.
  let label = "";
  let instruction = "";
  // The whole-document loop round-trips each planner directive back through
  // this route. It is client-supplied text either way; it is fenced in the
  // prompt, so tampering with it buys nothing `instruction` could not.
  let directive = "";
  let attachment: { name: string; text: string } | undefined;
  let attachInjectionHits = 0;
  const ctype = req.headers.get("content-type") ?? "";
  if (ctype.includes("multipart/form-data")) {
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > 8_500_000)
      return rfpError("too_large", "That file is over 8 MB.", 413);
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return rfpError("invalid_request", "Send the file as form data.", 400);
    }
    label = String(form.get("label") ?? "");
    instruction = String(form.get("instruction") ?? "").trim().slice(0, 8000);
    directive = String(form.get("directive") ?? "").trim().slice(0, 600);
    // Checked BEFORE extraction: an instructionless request should not pay
    // for parsing an 8 MB pdf, and it should fail with the same message the
    // JSON branch gives rather than an attachment-shaped one.
    if (instruction.length < 3)
      return rfpError("invalid_request", "Say what you want changed.", 400);
    const file = form.get("file");
    // No size floor: a 0-byte file is a FAILED upload, and letting it fall
    // through would answer as if nothing were attached while the UI said
    // the document was read. extractAttachment refuses it honestly.
    if (file instanceof File) {
      const extracted = await extractAttachment(file);
      if (!extracted.ok)
        return rfpError("invalid_request", extracted.message, 400);
      attachment = { name: extracted.name, text: extracted.text };
      attachInjectionHits = extracted.injectionHits;
    }
  } else {
    let body: { label?: string; instruction?: string; directive?: string };
    try {
      body = await req.json();
    } catch {
      return rfpError("invalid_request", "Send JSON.", 400);
    }
    label = String(body.label ?? "");
    instruction = String(body.instruction ?? "").trim();
    directive = String(body.directive ?? "").trim().slice(0, 600);
  }
  if (instruction.length < 3)
    return rfpError("invalid_request", "Say what you want changed.", 400);

  const sections: DraftSectionRecord[] = JSON.parse(proposal.sectionsJson || "[]");

  // Whole-document scope: PLAN, don't revise (§5.17.1). One fast turn reads
  // every drafted section and names the ones that must change; the client
  // then loops the targets back through the per-section branch below. This
  // branch must sit BEFORE the section lookup: DOC_LABEL is a sentinel, not
  // a stored label, and the find would 404 it.
  if (label === DOC_LABEL) {
    if (sections.length === 0)
      return rfpError(
        "not_ready",
        "Nothing is drafted yet. Tron plans changes across drafted text; draft a section first.",
        409
      );
    if (!(await brainHealthy()))
      return rfpError(
        "unavailable",
        "Tron is not responding. Nothing has been changed.",
        503
      );
    const { shared } = await knowledgeForUser(user);
    const plan = await planDocumentRevision(
      proposal.id,
      sections.map((s) => ({
        label: s.label,
        title: s.title,
        paragraphs: s.paragraphs,
      })),
      instruction,
      shared,
      attachment
    );
    if (!plan)
      return rfpError(
        "unavailable",
        "Tron did not return a plan. Nothing has been changed.",
        502
      );

    await logRfpActivity({
      actorEmail: user.email,
      actorAdmin: user.admin,
      action: "proposal.tron_plan",
      subjectKind: "proposal",
      subjectId: proposal.id,
      // Shape only, same discipline as tron_revise below: the instruction
      // and the attachment may quote the client's RFP.
      meta: {
        targets: plan.targets.length,
        instructionChars: instruction.length,
        attachedChars: attachment?.text.length ?? 0,
        attachedInjectionHits: attachInjectionHits,
      },
    });

    return rfpOk({ plan: { targets: plan.targets, note: plan.note } });
  }

  const section = sections.find((s) => s.label === label);
  if (!section) return rfpError("not_found", "No such section.", 404);

  if (!(await brainHealthy()))
    return rfpError(
      "unavailable",
      "Tron is not responding. Nothing has been changed.",
      503
    );

  const { shared } = await knowledgeForUser(user);
  const result = await reviseSection(
    proposal.id,
    // The letter's reserved label is an internal key, not a name Tron
    // should read ("SECTION: __letter Cover Letter").
    section.label === LETTER_LABEL
      ? section.title
      : `${section.label} ${section.title}`,
    section.paragraphs,
    instruction,
    shared,
    attachment,
    directive || undefined
  );
  if (!result)
    return rfpError(
      "unavailable",
      "Tron did not return a revision. Nothing has been changed.",
      502
    );

  await logRfpActivity({
    actorEmail: user.email,
    actorAdmin: user.admin,
    action: "proposal.tron_revise",
    subjectKind: "proposal",
    subjectId: proposal.id,
    // The instruction itself is user text and may quote the client's RFP, so
    // only its length is recorded. Same for the attachment: shape, not text.
    // Shape only. The hit COUNT is the same review signal ingest keeps on
    // rfp_documents.injection_flagged: a stripped attempt should not vanish
    // without trace, and a count is not content.
    meta: {
      section: label,
      instructionChars: instruction.length,
      directiveChars: directive.length,
      attachedChars: attachment?.text.length ?? 0,
      attachedInjectionHits: attachInjectionHits,
    },
  });

  return rfpOk({
    proposed: result.paragraphs,
    note: result.note,
    current: section.paragraphs,
  });
}
