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
  planDocumentRevision,
  reviewDocumentConsolidation,
  reviseSection,
  brainHealthy,
} from "@/lib/rfp/brain";
import {
  findDuplicateClusters,
  formatDuplicateFindings,
} from "@/lib/rfp/consolidate";
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
import { notFound, requireRfpApi, rfpError, rfpOk } from "@/lib/rfp/http";
import { referencesAsk, referencesGapWhy } from "@/lib/rfp/references-ask";
import { reopenReferencesQuestion } from "@/lib/rfp/references-answer";
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

    const nextSections = sections.map((s) =>
      s.label === label
        ? withBlocks(
            {
              ...s,
              label: newLabel,
              title: newTitle,
              // Accepted alongside a body revision when present; cites and
              // generatedBy carry over per the header invariant.
              ...(Array.isArray(body.paragraphs) ? { paragraphs } : {}),
              updatedAt: new Date().toISOString(),
            },
            // Visuals stay with the section through a retitle, re-anchored
            // when a body revision changed the paragraph count.
            keptBlocks(
              s,
              Array.isArray(body.paragraphs)
                ? paragraphs.length
                : s.paragraphs.length
            )
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
      },
    });
    return rfpOk({
      ok: true,
      rev: proposal.rev + 1,
      label: newLabel,
      title: newTitle,
    });
  }

  // Visuals are kept as stored and re-anchored to the new paragraph count: a
  // text edit (or an accepted Tron revision, which arrives here) never
  // removes one and the body cannot supply one.
  const kept = keptBlocks(sections[at], paragraphs.length);
  sections[at] = withBlocks({
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
  }, kept);

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
      const shaped = sections.map((s) => ({
        label: s.label,
        title: s.title,
        paragraphs: s.paragraphs,
      }));
      const clusters = findDuplicateClusters(shaped);
      // Display titles for the findings lines: label + title joined (the
      // letter is excluded from clusters by contract, but its title still
      // answers a lookup honestly).
      const titleByLabel = new Map(
        sections.map((s) => [
          s.label,
          s.label === LETTER_LABEL
            ? s.title
            : `${s.label} ${s.title}`.trim(),
        ])
      );
      const findings = formatDuplicateFindings(
        clusters,
        (l) => titleByLabel.get(l) ?? l
      );
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
        shared
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
          duplicateClusters: clusters.length,
          requirements: reqs.length,
          auto,
        },
      });

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
