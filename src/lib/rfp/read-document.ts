// The background read of one RFP document: readRfp, then requirements, the
// composed title, stated staff, intake form and addressee, and status
// "extracted" (or "read_failed").
//
// Shared by POST /api/rfp/documents (first read) and
// POST /api/rfp/documents/[id]/read (read again), so a re-read is the same
// code path as the original, not a lookalike. Callers run it inside after().

import { readRfp } from "./brain";
import { composeDocTitle } from "./doc-title";
import { logRfpActivity } from "./activity";
import { replaceRequirements } from "./db";
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

export async function runDocumentRead(input: DocumentReadInput): Promise<void> {
  const { docId, rawText, storedTitle, autoTitle, sourceKind, actor } = input;
  try {
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
