// Section-level writes on a draft (§5.17).
//
//   PATCH  — a human edits the text of one section; under op "retitle" /
//            "remove" it applies a STRUCTURAL change instead (a Tron
//            proposal the human accepted): the header renames, or the whole
//            section leaves the document, structure and Coverage included
//   POST   — Tron proposes a revision (returns a PROPOSAL, writes nothing);
//            under the DOC_LABEL sentinel it PLANS instead, returning the
//            sections to change so the client can loop them through here
//
// PATCH op "visuals" adds or removes VISUAL BLOCKS on one section (the
// company snapshot, the service stats, the onboarding timeline; remove one
// block by id). No brain call: the blocks are rebuilt server-side from live
// shared facts. Every other PATCH path preserves the stored blocks and
// re-anchors them to the new paragraph count; `blocks` is never read from a
// request body, for the same reason cites are not. Removing the client
// references block (§5.17.10) also clears the section's `referencesAnswered`
// stamp, strips the composed intro paragraph and reopens the references
// question when the RFP still asks.
//
// THE INVARIANT BOTH PATHS PRESERVE: `cites` and `generatedBy` are carried
// over from the stored section and are never taken from the request body.
// Rule A5 only requires citations when generatedBy === "llm", and rule C1's
// staleness sweep joins on cites, so a write that could clear either field, or
// relabel an llm block as human, would launder an uncited claim past the two
// validators that exist to catch exactly that. Both fail OPEN when cites is
// empty, which is why this is enforced here rather than trusted to a form.

import {
  documentSectionForPrompt,
  planDocumentRevision,
  prepareConsolidationReview,
  reviewDocumentConsolidation,
  reviseSection,
  sectionBlocksForPrompt,
  brainHealthy,
} from "@/lib/rfp/brain";
import {
  DOC_LABEL,
  LETTER_LABEL,
  labelDisplaysWorded,
  stripReservedPrefix,
} from "@/lib/rfp/letter";
import { logRfpActivity } from "@/lib/rfp/activity";
import { stripIntakeHeaders } from "@/lib/rfp/intake";
import {
  getDocument,
  getOwnedProposal,
  knowledgeForUser,
  listRequirements,
  liveFacts,
  liveReferences,
  writeProposalSections,
  writeProposalStructureOp,
} from "@/lib/rfp/db";
import {
  applyVisualsOp,
  isVisualsAction,
  keptBlocks,
  toGroundFacts,
  withBlocks,
} from "@/lib/rfp/draft-blocks-ops";
import {
  hasMarkdownTable,
  liftMarkdownTables,
  type DraftBlock,
} from "@/lib/rfp/draft-blocks";
import { notFound, requireRfpApi, rfpError, rfpOk } from "@/lib/rfp/http";
import { referencesAsk, referencesGapWhy } from "@/lib/rfp/references-ask";
import { reopenReferencesQuestion } from "@/lib/rfp/references-answer";
import { extractStyleSampleText } from "@/lib/governance/style-sample";
import { screenInjection } from "@/lib/governance/research";
import {
  RFP_VISION_INLINE_BUDGET_MS,
  VISION_IMAGE_MEDIA,
  extractVisionTextCached,
  isPdfMagic,
  isUnsupportedImage,
  pdfNeedsVision,
  sniffVisionImage,
  visionConfigured,
  visionImageProblem,
  visionImageRefusal,
  type VisionFailure,
} from "@/lib/rfp/vision-extract";
import type { DraftSectionRecord } from "../../../documents/[id]/generate/route";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** Same ceiling as RFP ingest: well under the 12m nginx cap. */
const MAX_ATTACH_BYTES = 8_000_000;
const MAX_ATTACH_CHARS = 20_000;
const TEXT_EXTENSIONS = /\.(txt|md|csv|log|json)$/i;
const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp|heic|svg)$/i;

/** Operator-voice copy for a failed inline transcription (category only). */
function transcribeFailMessage(subject: "scan" | "image", reason: VisionFailure): string {
  return reason === "timeout"
    ? `That ${subject} could not be transcribed in time. Paste its text instead, or attach the ${subject} on the RFP intake (/rfp/new), where reading has several minutes.`
    : `That ${subject} could not be transcribed. Paste its text instead.`;
}

/**
 * Cheap precheck before a PATCH pays for the facts read the table lift needs
 * (§5.17.19): some paragraph holds a markdown table by THE detector the lift
 * itself uses (hasMarkdownTable), never a second pattern, so the lift runs
 * for exactly the tables it would find. Most edits hold none, so the common
 * PATCH stays at zero extra queries and byte-identical writes.
 */
function mayHoldMarkdownTable(paragraphs: string[]): boolean {
  return paragraphs.some((p) => hasMarkdownTable(p));
}

/**
 * The PATCH half of §5.17.19: a GitHub-markdown table in accepted or edited
 * text becomes a real table block. Runs only when the precheck says a table
 * is even possible, against live SHARED facts (never a private note) and the
 * section's STORED cites; every blocking control (currency, limits,
 * grounding, the block cap) lives in liftMarkdownTables, which hands the
 * inputs back untouched when it lifts nothing. Callers skip the letter.
 */
async function liftTablesForWrite(
  paragraphs: string[],
  blocks: DraftBlock[] | undefined,
  cites: string[]
): Promise<{
  paragraphs: string[];
  blocks: DraftBlock[] | undefined;
  lifted: number;
  refused: number;
}> {
  if (!mayHoldMarkdownTable(paragraphs))
    return { paragraphs, blocks, lifted: 0, refused: 0 };
  const facts = toGroundFacts(await liveFacts());
  return liftMarkdownTables(paragraphs, blocks, facts, Array.isArray(cites) ? cites : []);
}

/**
 * Turn an attached file into fenced text for the revision turn.
 * Magic bytes decide before names, everywhere:
 *   1. PDF magic: the PDF path whatever the name says (text layer, and a
 *      scan with no usable layer transcribed by vision INLINE);
 *   2. PNG, JPEG, GIF or WebP magic: transcribed by vision INLINE;
 *   3. a plain-text name (txt, md, csv, log, json): decoded directly;
 *   4. a .docx or .pdf name: the same extractor as RFP ingest;
 *   5. any other image (BMP, TIFF, HEIC, SVG, by bytes or name): refused
 *      HONESTLY, naming the formats that work;
 *   6. anything else: the generic refusal.
 * Inline transcription runs under RFP_VISION_INLINE_BUDGET_MS through the
 * attachment cache (§5.17.18); the transcription is untrusted text exactly
 * like an extraction.
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
  const buf = Buffer.from(await file.arrayBuffer());
  if (isPdfMagic(buf)) {
    // The extractor picks its parser by suffix; the bytes say PDF.
    const pdfName = /\.pdf$/i.test(name) ? name : `${name}.pdf`;
    const extracted = await extractStyleSampleText(pdfName, buf, MAX_ATTACH_CHARS);
    // A scan (no text layer, or one under the floor) falls back to vision,
    // inline. Not configured: exactly today's ladder.
    if (visionConfigured() && pdfNeedsVision(extracted)) {
      const res = await extractVisionTextCached({
        name,
        buf,
        mediaType: "application/pdf",
        budgetMs: RFP_VISION_INLINE_BUDGET_MS,
        maxChars: MAX_ATTACH_CHARS,
      });
      if (!res.ok) return { ok: false, message: transcribeFailMessage("scan", res.reason) };
      return {
        ok: true,
        name,
        text: res.text,
        injectionHits: screenInjection(res.text).hits.length,
      };
    }
    return extractedAttachment(name, extracted);
  }
  const image = sniffVisionImage(buf);
  if (image) {
    const problem = visionImageProblem(image, buf);
    if (problem) return { ok: false, message: visionImageRefusal("That image", problem) };
    if (!visionConfigured())
      return {
        ok: false,
        message:
          "Reading images is not set up on this server. Export the content as PDF, Word, or text and attach that.",
      };
    const res = await extractVisionTextCached({
      name,
      buf,
      mediaType: VISION_IMAGE_MEDIA[image],
      budgetMs: RFP_VISION_INLINE_BUDGET_MS,
      maxChars: MAX_ATTACH_CHARS,
    });
    if (!res.ok) return { ok: false, message: transcribeFailMessage("image", res.reason) };
    return {
      ok: true,
      name,
      text: res.text,
      injectionHits: screenInjection(res.text).hits.length,
    };
  }
  if (TEXT_EXTENSIONS.test(name)) {
    const text = buf.toString("utf8").slice(0, MAX_ATTACH_CHARS).trim();
    if (!text)
      return { ok: false, message: "That file has no readable text." };
    return { ok: true, name, text, injectionHits: screenInjection(text).hits.length };
  }
  if (/\.(pdf|docx)$/i.test(name))
    return extractedAttachment(
      name,
      await extractStyleSampleText(name, buf, MAX_ATTACH_CHARS)
    );
  if (IMAGE_EXTENSIONS.test(name) || isUnsupportedImage(name, buf))
    return { ok: false, message: visionImageRefusal("That image", "unsupported") };
  return {
    ok: false,
    message: "Attach a PDF, Word .docx, or a text file (.txt, .md, .csv, .log, .json).",
  };
}

/** A text-layer extraction (PDF or .docx) as an attachment result. */
function extractedAttachment(
  name: string,
  extracted: Awaited<ReturnType<typeof extractStyleSampleText>>
):
  | { ok: true; name: string; text: string; injectionHits: number }
  | { ok: false; message: string } {
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

  let body: {
    label?: string;
    paragraphs?: string[];
    op?: string;
    heading?: string;
    action?: string;
    blockId?: string;
  };
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

  // ---- visuals op: add the company snapshot / service stats / onboarding
  // timeline to a section, or remove one block. Only label, action and
  // blockId are read from the body; the blocks themselves are built here
  // from live SHARED facts (never a private pending note), so a request can
  // choose WHICH set lands and nothing about what it says. Same CAS-on-rev
  // write as a text edit, which also stales the stored gate verdict.
  if (body.op === "visuals") {
    if (!isVisualsAction(body.action))
      return rfpError("invalid_request", "No such visual.", 400);
    const action = body.action;
    const applied = applyVisualsOp(
      sections,
      {
        label,
        action,
        blockId: typeof body.blockId === "string" ? body.blockId : undefined,
      },
      // "remove" builds nothing, so it reads no facts.
      action === "remove" ? [] : toGroundFacts(await liveFacts()),
      new Date().toISOString()
    );
    if (!applied.ok)
      return rfpError(applied.code, applied.message, applied.status);
    // Removing the client references takes the person's ANSWER away
    // (§5.17.10): the op already cleared the stamp and stripped the intro
    // paragraph; here the question goes back on the section when its
    // requirements still ask for references, with the same `why` the
    // references-gap route builds. No ask detected (or the document or the
    // requirements cannot be read): the stamp and the intro are still gone,
    // and the references-gap repair can raise the question later. Every
    // other visuals op skips this block entirely.
    let landedSections = applied.sections;
    let landedSection = applied.section;
    let referencesReopened = false;
    if (applied.removedReferences) {
      const at = applied.sections.findIndex((s) => s.label === label);
      const doc = await getDocument(user, proposal.documentId).catch(() => null);
      const requirements = doc
        ? await listRequirements(doc.id).catch(() => null)
        : null;
      const ask =
        doc && requirements && at >= 0
          ? referencesAsk(
              requirements
                .filter((r) => r.structureLabel === label)
                .map((r) => r.text),
              applied.sections[at].title || label
            )
          : null;
      if (doc && ask) {
        const held = await liveReferences().catch((err) => {
          console.error(
            "[rfp] references read failed:",
            err instanceof Error ? err.constructor.name : "error"
          );
          return null;
        });
        const reopened = reopenReferencesQuestion(
          applied.sections,
          at,
          ask,
          referencesGapWhy(
            ask,
            held,
            `${doc.clientName ?? ""} ${doc.title} ${stripIntakeHeaders(doc.rawText ?? "")}`
          )
        );
        referencesReopened = reopened !== applied.sections;
        landedSections = reopened;
        landedSection = reopened[at];
      }
    }
    const ok = await writeProposalSections(
      proposal.id,
      proposal.rev,
      JSON.stringify(landedSections)
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
      action: "proposal.section_visuals",
      subjectKind: "proposal",
      subjectId: proposal.id,
      // Shape only: which set, and how many blocks moved.
      meta: {
        section: label,
        visual: action,
        added: applied.added,
        removed: applied.removed,
        blocks: landedSection.blocks?.length ?? 0,
        ...(applied.removedReferences
          ? { removedReferences: true, referencesReopened }
          : {}),
      },
    });
    return rfpOk({
      ok: true,
      rev: proposal.rev + 1,
      section: landedSection,
      sections: landedSections,
    });
  }

  const at = sections.findIndex((s) => s.label === label);
  if (at < 0) return rfpError("not_found", "No such section.", 404);

  // ---- structural ops (§5.17.1): an accepted Tron retitle or remove ----
  if (body.op === "retitle" || body.op === "remove") {
    // The letter (and the whole reserved namespace) is furniture: it has no
    // structure node, no Coverage rows, and its header is host copy.
    if (label.startsWith("__"))
      return rfpError(
        "invalid_request",
        "The cover letter's header is fixed, and the letter itself is never removed.",
        400
      );
    const doc = await getDocument(user, proposal.documentId);
    if (!doc) return notFound();
    const structure: { label: string; title: string }[] = JSON.parse(
      doc.structureJson || "[]"
    );

    if (body.op === "remove") {
      const nextSections = sections.filter((s) => s.label !== label);
      const nextStructure = structure.filter((n) => n.label !== label);
      // Removing the LAST structure node would blank the whole document
      // behind the "no section structure was found" panel, unrecoverably
      // (structure_json has no restore path short of re-ingesting the RFP).
      if (structure.length > 0 && nextStructure.length === 0)
        return rfpError(
          "invalid_request",
          "The last section cannot be removed; a document needs at least one. Revise it instead.",
          409
        );
      const ok = await writeProposalStructureOp({
        proposalId: proposal.id,
        expectedRev: proposal.rev,
        sectionsJson: JSON.stringify(nextSections),
        documentId: doc.id,
        structureJson: JSON.stringify(nextStructure),
        removeLabel: label,
      });
      if (!ok)
        return rfpError(
          "conflict",
          "Someone else changed this draft while you were editing. Reload to see their version.",
          409
        );
      await logRfpActivity({
        actorEmail: user.email,
        actorAdmin: user.admin,
        action: "proposal.section_remove",
        subjectKind: "proposal",
        subjectId: proposal.id,
        meta: { section: label, paragraphs: sections[at].paragraphs.length },
      });
      return rfpOk({ ok: true, rev: proposal.rev + 1 });
    }

    // retitle. The heading is model-authored-then-human-accepted text: one
    // line, no fence-token runs, never a reserved prefix, bounded — the
    // same cleanup the brain applied, re-applied here because the PATCH
    // body is client-supplied either way.
    const heading = stripReservedPrefix(
      String(body.heading ?? "")
        .replace(/\s+/g, " ")
        .replace(/<{3,}|>{3,}/g, " ")
        .trim()
    ).slice(0, 120);
    if (!heading)
      return rfpError(
        "invalid_request",
        "Say what the header should become.",
        400
      );

    // Which slot the heading lands in follows what the reader SEES (the
    // secKicker display rule): a worded label is itself the visible header,
    // so the label renames — and the label is the join key everywhere
    // (sections, structure, Coverage's structure_label), so the rename must
    // stay unique and rides one transaction. A bare-numbering label stays
    // (the client's own numbering, rule C4); the title takes the heading.
    // On the worded branch the TITLE clears: the heading is contractually
    // the FULL replacement header, and both slots print (kicker + h3, and
    // the export mirrors them), so a preserved title would keep the very
    // words the request asked to strip visible on the sheet and in the
    // delivered file.
    const renamesLabel = labelDisplaysWorded(label);
    const newLabel = renamesLabel ? heading : label;
    if (
      renamesLabel &&
      newLabel !== label &&
      (sections.some((s) => s.label === newLabel) ||
        structure.some((n) => n.label === newLabel))
    )
      return rfpError(
        "conflict",
        "A section with that header already exists.",
        409
      );
    const newTitle = renamesLabel ? "" : heading;

    // Visuals stay with the section through a retitle, re-anchored when a
    // body revision changed the paragraph count. A body revision riding
    // along is lifted exactly like the plain path below (§5.17.19): a
    // markdown table in it becomes a real table block. The letter never
    // reaches this branch (refused above).
    const withBody = Array.isArray(body.paragraphs);
    const retitleKept = keptBlocks(
      sections[at],
      withBody ? paragraphs.length : sections[at].paragraphs.length
    );
    const retitleLift = withBody
      ? await liftTablesForWrite(paragraphs, retitleKept, sections[at].cites)
      : { paragraphs, blocks: retitleKept, lifted: 0, refused: 0 };
    const nextSections = sections.map((s) =>
      s.label === label
        ? withBlocks(
            {
              ...s,
              label: newLabel,
              title: newTitle,
              // Accepted alongside a body revision when present; cites and
              // generatedBy carry over per the header invariant.
              ...(withBody ? { paragraphs: retitleLift.paragraphs } : {}),
              updatedAt: new Date().toISOString(),
            },
            retitleLift.blocks
          )
        : s
    );
    const nextStructure = structure.map((n) =>
      n.label === label ? { ...n, label: newLabel, title: newTitle } : n
    );
    const ok = await writeProposalStructureOp({
      proposalId: proposal.id,
      expectedRev: proposal.rev,
      sectionsJson: JSON.stringify(nextSections),
      documentId: doc.id,
      structureJson: JSON.stringify(nextStructure),
      renameLabel:
        renamesLabel && newLabel !== label
          ? { from: label, to: newLabel }
          : undefined,
    });
    if (!ok)
      return rfpError(
        "conflict",
        "Someone else changed this draft while you were editing. Reload to see their version.",
        409
      );
    await logRfpActivity({
      actorEmail: user.email,
      actorAdmin: user.admin,
      action: "proposal.section_retitle",
      subjectKind: "proposal",
      subjectId: proposal.id,
      meta: {
        section: label,
        renamedLabel: renamesLabel,
        headingChars: heading.length,
        ...(retitleLift.lifted > 0 ? { liftedTables: retitleLift.lifted } : {}),
        // A table found but left as pipe text by a control: the activity
        // log is the only place this is signaled (§5.17.19).
        ...(retitleLift.refused > 0 ? { liftRefused: retitleLift.refused } : {}),
      },
    });
    return rfpOk({
      ok: true,
      rev: proposal.rev + 1,
      label: newLabel,
      title: newTitle,
      // Only when a table was lifted: the stored record no longer matches
      // the paragraphs the client sent, so it adopts this instead (an
      // unadopted divergence would trip Tron's staleness guard forever).
      ...(retitleLift.lifted > 0
        ? { section: nextSections.find((s) => s.label === newLabel) }
        : {}),
      // A table found but left as pipe text by a control, counted so an
      // attended path can say so (§5.17.19). A refused-only lift changes no
      // bytes, so it carries no `section`, only this count.
      ...(retitleLift.refused > 0 ? { liftRefused: retitleLift.refused } : {}),
    });
  }

  // Visuals are kept as stored and re-anchored to the new paragraph count: a
  // text edit (or an accepted Tron revision, which arrives here) never
  // removes one and the body cannot supply one.
  const kept = keptBlocks(sections[at], paragraphs.length);
  // A markdown table in the text becomes a real table block (§5.17.19).
  // The letter is EXEMPT: it never carries blocks (resolve-draft routes it
  // into furniture), so it is never lifted and keeps exactly today's write.
  const lift =
    label === LETTER_LABEL
      ? { paragraphs, blocks: kept, lifted: 0, refused: 0 }
      : await liftTablesForWrite(paragraphs, kept, sections[at].cites);
  sections[at] = withBlocks({
    ...sections[at],
    paragraphs: lift.paragraphs,
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
  }, lift.blocks);

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
    meta: {
      section: label,
      paragraphs: lift.paragraphs.length,
      ...(lift.lifted > 0 ? { liftedTables: lift.lifted } : {}),
      ...(lift.refused > 0 ? { liftRefused: lift.refused } : {}),
    },
  });

  return rfpOk({
    ok: true,
    rev: proposal.rev + 1,
    // Only when a table was lifted: the client adopts the stored record
    // instead of the paragraphs it sent (see the retitle branch).
    ...(lift.lifted > 0 ? { section: sections[at] } : {}),
    // See the retitle branch: the refused count, only when > 0.
    ...(lift.refused > 0 ? { liftRefused: lift.refused } : {}),
  });
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
  // JSON-only: "consolidate" swaps the DOC_LABEL plan turn for the
  // whole-document consolidation review (§5.17.16). The multipart branch
  // never reads it: consolidation carries no attachment.
  let mode = "";
  // Set by the client's auto-run after a clean initial draft-all, so the
  // activity log distinguishes it from a button press. Otherwise unused.
  let auto = false;
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
    let body: {
      label?: string;
      instruction?: string;
      directive?: string;
      mode?: string;
      auto?: boolean;
    };
    try {
      body = await req.json();
    } catch {
      return rfpError("invalid_request", "Send JSON.", 400);
    }
    label = String(body.label ?? "");
    instruction = String(body.instruction ?? "").trim();
    directive = String(body.directive ?? "").trim().slice(0, 600);
    mode = String(body.mode ?? "");
    auto = body.auto === true;
  }
  // Consolidation sends no instruction (the review reads the document, the
  // requirements and the scan; any provided text is ignored), so the length
  // guard applies to every OTHER request exactly as before. The multipart
  // branch keeps its own early check above.
  if (mode === "consolidate" && label !== DOC_LABEL)
    return rfpError(
      "invalid_request",
      "Consolidation reviews the whole document.",
      400
    );
  if (mode !== "consolidate" && instruction.length < 3)
    return rfpError("invalid_request", "Say what you want changed.", 400);

  const sections: DraftSectionRecord[] = JSON.parse(proposal.sectionsJson || "[]");

  // Whole-document scope: PLAN, don't revise (§5.17.1). One fast turn reads
  // every drafted section and names the ones that must change; the client
  // then loops the targets back through the per-section branch below. This
  // branch must sit BEFORE the section lookup: DOC_LABEL is a sentinel, not
  // a stored label, and the find would 404 it.
  if (label === DOC_LABEL) {
    // Whole-document consolidation review (§5.17.16): one turn reads the
    // drafted document, the RFP's extracted requirements and a deterministic
    // duplicate-passage scan, and returns plan targets the client loops
    // through the same apply path as a plan. Returns before the plan code so
    // the plain plan path below stays byte-identical in behavior.
    if (mode === "consolidate") {
      // Consolidation compares sections against each other, so one drafted
      // section has nothing to be consolidated with. Checked BEFORE the
      // brain health probe: an empty document should not pay for one.
      const drafted = sections.filter((s) => s.label !== LETTER_LABEL);
      if (drafted.length < 2)
        return rfpError(
          "not_ready",
          "Draft at least two sections first; consolidation compares sections against each other.",
          409
        );
      if (!(await brainHealthy()))
        return rfpError(
          "unavailable",
          "Tron is not responding. Nothing has been changed.",
          503
        );
      const reqs = await listRequirements(proposal.documentId);
      // One shaping for this route and the rfp:consolidate CLI: sanitized
      // visuals serialized (serializeBlockForPrompt) into the duplicate scan
      // (tables only) and the review's document text, the formatted
      // findings, and the scan-guard set. A document with no visuals shapes
      // exactly as before.
      const { shaped, clusters, findings, guard } =
        prepareConsolidationReview(sections);
      const { shared } = await knowledgeForUser(user);
      const review = await reviewDocumentConsolidation(
        proposal.id,
        shaped,
        reqs.map((r) => ({
          structureLabel: r.structureLabel,
          text: r.text,
          kind: r.kind,
          mandatory: r.mandatory,
        })),
        findings,
        shared,
        // THE SCAN GUARD: a prune-visual target survives only for a block
        // id the deterministic scan itself put in a cluster, on the section
        // that holds it, never the last copy in its cluster; the client
        // applies prune-visual unattended because of this filter, so it must
        // never be widened here.
        guard
      );
      if (!review)
        return rfpError(
          "unavailable",
          "Tron did not return a review. Nothing has been changed.",
          502
        );

      await logRfpActivity({
        actorEmail: user.email,
        actorAdmin: user.admin,
        action: "proposal.consolidate_plan",
        subjectKind: "proposal",
        subjectId: proposal.id,
        // Shape only, same discipline as tron_plan: the clusters and the
        // requirements quote the client's RFP and the drafted prose.
        meta: {
          targets: review.targets.length,
          retitles: review.targets.filter((t) => t.op === "retitle").length,
          removes: review.targets.filter((t) => t.op === "remove").length,
          pruneVisuals: review.targets.filter((t) => t.op === "prune-visual")
            .length,
          duplicateClusters: clusters.length,
          // How many visuals the scan put in a cluster (the guard set).
          clusterBlocks: guard.clusterOf.size,
          requirements: reqs.length,
          auto,
        },
      });

      // Targets pass through as filtered, a prune-visual one carrying its
      // blockId: { label, op, directive, heading? } | { label, op:
      // "prune-visual", blockId, directive }.
      return rfpOk({
        plan: { targets: review.targets, note: review.note },
        duplicateClusters: clusters.length,
      });
    }

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
      // Visuals ride as serialized text so the plan knows what they say; it
      // can direct a markdown table but never target a visual itself.
      sections.map(documentSectionForPrompt),
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
        retitles: plan.targets.filter((t) => t.op === "retitle").length,
        removes: plan.targets.filter((t) => t.op === "remove").length,
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
  // The section's sanitized visuals, shown in place (never any for the
  // letter): the revise turn must know what a table already says so it
  // neither repeats it in prose nor writes a second copy.
  const shownBlocks = sectionBlocksForPrompt(section);
  const result = await reviseSection(
    proposal.id,
    // The letter's reserved label is an internal key, not a name Tron
    // should read ("SECTION: __letter Cover Letter").
    section.label === LETTER_LABEL
      ? section.title
      : `${section.label} ${section.title}`,
    section.paragraphs,
    shownBlocks,
    instruction,
    shared,
    attachment,
    directive || undefined,
    // The letter's header and existence are furniture; only real sections
    // may be offered a retitle or a removal.
    section.label !== LETTER_LABEL
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
      // Shape only: whether Tron proposed a structural change too.
      proposedHeading: result.heading !== null,
      proposedRemove: result.remove,
      visualsShown: shownBlocks.length,
    },
  });

  return rfpOk({
    proposed: result.paragraphs,
    note: result.note,
    current: section.paragraphs,
    heading: result.heading,
    remove: result.remove,
  });
}
