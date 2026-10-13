// The background read of one RFP document: readRfp, then requirements, the
// composed title, stated staff, intake form and addressee, and status
// "extracted" (or "read_failed"). A document that came in with a scanned PDF
// or an image is transcribed first (§5.17.18), in this same worker, so the
// first read, "Read it again" and the rfp:reread CLI all retry it alike.
//
// Shared by POST /api/rfp/documents (first read) and
// POST /api/rfp/documents/[id]/read (read again), so a re-read is the same
// code path as the original, not a lookalike. Callers run it inside after().

import { readRfp } from "./brain";
import { composeDocTitle } from "./doc-title";
import { logRfpActivity } from "./activity";
import {
  completeIntakeTranscription,
  listIntakeParts,
  replaceRequirements,
  saveIntakePartText,
} from "./db";
import { RFP_MAX_CHARS, composeRfpParts } from "./intake";
import { extractVisionText, runVisionPhase } from "./vision-extract";
import { screenInjection } from "@/lib/governance/research";
import { db } from "@/lib/db";
import { rfpDocuments } from "@/lib/db/rfp-schema";
import { eq, sql } from "drizzle-orm";

export type DocumentReadInput = {
  docId: string;
  /** The stored, already injection-screened text. */
  rawText: string;
  /** The title stored on the row when this read was started. */
  storedTitle: string;
  /** True when no title was typed, so the read may compose one. */
  autoTitle: boolean;
  /** rfp_documents.source_kind: only "paste" can be read as a brief. */
  sourceKind: string;
  actor: { email: string; admin: boolean };
};

/**
 * The transcription pre-phase (§5.17.18). A document created with a scanned
 * PDF or an image has raw_text "" and rfp_intake_parts rows until this
 * succeeds. Returns the composed, screened raw_text, or null when the
 * transcription failed (the row is then "read_failed" with its parts KEPT,
 * so "Read it again" retries). "no_parts" when the document has none: the
 * read then proceeds on the stored text exactly as before.
 */
async function transcribeIntake(
  docId: string,
  actor: { email: string; admin: boolean }
): Promise<{ text: string } | null | "no_parts"> {
  const rows = await listIntakeParts(docId);
  if (rows.length === 0) return "no_parts";
  const phase = await runVisionPhase(rows, {
    transcribe: (row, media, budgetMs) =>
      extractVisionText({
        name: row.name ?? "attachment",
        buf: row.bytes!,
        mediaType: media,
        budgetMs,
        maxChars: RFP_MAX_CHARS,
      }),
    saveText: (row, text) => saveIntakePartText(row.id, text),
    now: () => Date.now(),
  });
  if (!phase.ok) {
    console.warn(
      `[rfp] transcription failed (doc ${docId}): ${phase.reason}, ${phase.transcribed} file(s) done before it`
    );
    await db
      .update(rfpDocuments)
      .set({ status: "read_failed", updatedAt: new Date() })
      .where(eq(rfpDocuments.id, docId));
    await logRfpActivity({
      actorEmail: actor.email,
      actorAdmin: actor.admin,
      action: "document.transcribe",
      subjectKind: "document",
      subjectId: docId,
      outcome: "error",
      // Category and counts only, never a filename or any text.
      meta: { reason: phase.reason, transcribed: phase.transcribed, parts: rows.length },
    });
    return null;
  }
  // The same posture as the inline intake: compose, then screen. Headers
  // are stripped downstream at the existing evidence sites.
  const composed = composeRfpParts(phase.parts);
  const screened = screenInjection(composed.text);
  await completeIntakeTranscription(docId, screened.clean, screened.hits.length > 0);
  const truncated = composed.truncated || phase.truncated;
  await logRfpActivity({
    actorEmail: actor.email,
    actorAdmin: actor.admin,
    action: "document.transcribe",
    subjectKind: "document",
    subjectId: docId,
    meta: {
      transcribed: phase.transcribed,
      parts: rows.length,
      chars: screened.clean.length,
      truncated,
      injectionHits: screened.hits.length,
    },
  });
  if (truncated)
    console.warn(`[rfp] transcribed intake truncated (doc ${docId}, parts ${rows.length})`);
  return { text: screened.clean };
}

export async function runDocumentRead(input: DocumentReadInput): Promise<void> {
  const { docId, storedTitle, autoTitle, sourceKind, actor } = input;
  let { rawText } = input;
  try {
    // Only a document with no text yet can be waiting on transcription; a
    // no-vision intake never has an empty raw_text, so its read never
    // touches the parts table.
    if (rawText.trim() === "") {
      const t = await transcribeIntake(docId, actor);
      if (t === null) return;
      if (t !== "no_parts") rawText = t.text;
    }
    const result = await readRfp(docId, rawText, sourceKind);
    if (!result) {
      await db
        .update(rfpDocuments)
        .set({ status: "read_failed", updatedAt: new Date() })
        .where(eq(rfpDocuments.id, docId));
      return;
    }
    await replaceRequirements(
      docId,
      result.requirements.map((r, i) => ({
        structureLabel: r.structureLabel,
        text: r.text,
        ordinal: i,
        kind: r.kind,
        mandatory: r.mandatory,
      }))
    );
    // An AUTO title becomes "<client> · <subject line>". The CASE compares
    // against the title stored when this read started, so a title changed by
    // anything else in the meantime is left alone.
    const composed = autoTitle
      ? composeDocTitle({
          clientName: result.clientName,
          subject: result.rfpTitle,
          fallback: storedTitle,
        })
      : storedTitle;
    // Stated staff and the title land in the SAME update that stamps
    // "extracted", so a proposal can never be created against an extracted
    // document whose count has not landed yet, and never copies the
    // pre-read title (proposal.title is copied once, at creation).
    await db
      .update(rfpDocuments)
      .set({
        clientName: result.clientName,
        ...(composed !== storedTitle
          ? {
              title: sql`CASE WHEN ${rfpDocuments.title} = ${storedTitle} THEN ${composed} ELSE ${rfpDocuments.title} END`,
            }
          : {}),
        structureJson: JSON.stringify(result.structure),
        statedStaffCount: result.statedStaff?.count ?? null,
        statedStaffQuote: result.statedStaff?.quote ?? null,
        statedStaffBasis: result.statedStaff?.basis ?? null,
        intakeForm: result.intakeForm,
        contactName: result.contact?.name ?? null,
        contactTitle: result.contact?.title ?? null,
        status: "extracted",
        updatedAt: new Date(),
      })
      .where(eq(rfpDocuments.id, docId));
    await logRfpActivity({
      actorEmail: actor.email,
      actorAdmin: actor.admin,
      action: "document.extract",
      subjectKind: "document",
      subjectId: docId,
      meta: {
        requirements: result.requirements.length,
        structureNodes: result.structure.length,
        // Shape only, never the client's text: "ok"/"range"/"none", or the
        // grounding check that discarded the model's claim (for tuning).
        statedStaff: result.statedStaff
          ? result.statedStaff.count === null
            ? "range"
            : "ok"
          : (result.statedStaffDiscarded ?? "none"),
        // Where the stored title came from; never the title itself.
        title: !autoTitle
          ? "typed"
          : result.rfpTitle
            ? "subject"
            : result.clientName
              ? "client"
              : "fallback",
        // Brief mode (§5.17.17) and whether an addressee grounded; shape
        // only, never the name.
        form: result.intakeForm,
        contact: result.contact ? "ok" : "none",
      },
    });
  } catch (err) {
    console.error("[rfp] background read failed:", err);
    await db
      .update(rfpDocuments)
      .set({ status: "read_failed", updatedAt: new Date() })
      .where(eq(rfpDocuments.id, docId))
      .catch(() => {});
  }
}
