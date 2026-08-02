// POST /api/rfp/documents — create an RFP from an upload or pasted text.
//
// Returns 202 immediately and reads the RFP in the background. Reading a real
// client RFP measured at ~94s against the live brain, and the edge closes a
// request at 100s, so doing it inline would fail intermittently on exactly the
// documents that matter most. The client polls the document row for status.

import { after } from "next/server";
import crypto from "node:crypto";
import { extractStyleSampleText } from "@/lib/governance/style-sample";
import { screenInjection } from "@/lib/governance/research";
import { readRfp } from "@/lib/rfp/brain";
import { logRfpActivity } from "@/lib/rfp/activity";
import { createDocument, replaceRequirements } from "@/lib/rfp/db";
import { requireRfpApi, rfpError, rfpOk } from "@/lib/rfp/http";
import { db } from "@/lib/db";
import { rfpDocuments } from "@/lib/db/rfp-schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** Well under the 12m nginx cap so the app returns a real message, not a 413. */
const MAX_BYTES = 8_000_000;
const MAX_CHARS = 120_000;

/** Magic bytes, because a filename suffix is a claim not a fact. */
function sniff(name: string, buf: Buffer): "pdf" | "docx" | "text" | null {
  if (buf.length >= 4) {
    if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46)
      return "pdf";
    // .docx is a zip
    if (buf[0] === 0x50 && buf[1] === 0x4b) return "docx";
  }
  if (/\.(md|txt)$/i.test(name)) return "text";
  return null;
}

export async function POST(req: Request): Promise<Response> {
  const gate = await requireRfpApi("POST /api/rfp/documents");
  if (!gate.ok) return gate.response;
  const user = gate.user;

  const ctype = req.headers.get("content-type") ?? "";
  let rawText = "";
  let sourceKind = "paste";
  let sourceName: string | null = null;
  let sourceSha: string | null = null;
  let sourceBytes: number | null = null;
  let title = "Untitled RFP";

  if (ctype.includes("multipart/form-data")) {
    // Content-Length is checked BEFORE formData(), which buffers the whole body.
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > MAX_BYTES)
      return rfpError("too_large", "That file is over 8 MB.", 413);

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return rfpError("invalid_request", "Send the file as form data.", 400);
    }
    const file = form.get("file");
    const pasted = String(form.get("text") ?? "");
    title = String(form.get("title") ?? "").trim() || title;

    if (file instanceof File && file.size > 0) {
      if (file.size > MAX_BYTES)
        return rfpError("too_large", "That file is over 8 MB.", 413);
      const buf = Buffer.from(await file.arrayBuffer());
      if (buf.length > MAX_BYTES)
        return rfpError("too_large", "That file is over 8 MB.", 413);

      const kind = sniff(file.name, buf);
      if (!kind)
        return rfpError(
          "invalid_request",
          "Upload a PDF, a Word .docx, or a .txt file, or paste the text instead.",
          400
        );

      const extracted = await extractStyleSampleText(file.name, buf, MAX_CHARS);
      if (!extracted.ok)
        return rfpError(
          "invalid_request",
          "Could not read that file. Scanned PDFs with no text layer are the usual cause. Paste the text instead and it works the same way.",
          400
        );
      rawText = extracted.text;
      sourceKind = kind === "text" ? "txt" : kind;
      sourceName = file.name.slice(0, 300);
      sourceSha = crypto.createHash("sha256").update(buf).digest("hex");
      sourceBytes = buf.length;
      if (title === "Untitled RFP") title = file.name.replace(/\.[^.]+$/, "");
    } else if (pasted.trim().length >= 40) {
      rawText = pasted.slice(0, MAX_CHARS);
    } else {
      return rfpError(
        "invalid_request",
        "Attach a file or paste at least a few lines of the RFP.",
        400
      );
    }
  } else {
    let body: { text?: string; title?: string };
    try {
      body = await req.json();
    } catch {
      return rfpError("invalid_request", "Send JSON or form data.", 400);
    }
    if (!body.text || body.text.trim().length < 40)
      return rfpError(
        "invalid_request",
        "Paste at least a few lines of the RFP.",
        400
      );
    rawText = body.text.slice(0, MAX_CHARS);
    title = (body.title ?? "").trim() || title;
  }

  // Untrusted third-party text headed for a prompt. Dropped lines are a review
  // signal on the row, never a silent edit and never a hard block.
  const screened = screenInjection(rawText);

  const doc = await createDocument(user, {
    title,
    clientName: null,
    sourceKind,
    sourceName,
    sourceSha256: sourceSha,
    sourceBytes,
    rawText: screened.clean,
    injectionFlagged: screened.hits.length > 0,
  });

  await logRfpActivity({
    actorEmail: user.email,
    actorAdmin: user.admin,
    action: "document.create",
    subjectKind: "document",
    subjectId: doc.id,
    meta: {
      sourceKind,
      chars: screened.clean.length,
      injectionHits: screened.hits.length,
    },
  });

  // Read it in the background. after() is the host's established pattern for
  // this (governance turn-runner); the narrow "never after()" rule applies to
  // the module's inbound-email webhook, where the response has already closed.
  after(async () => {
    try {
      const result = await readRfp(doc.id, screened.clean);
      if (!result) {
        await db
          .update(rfpDocuments)
          .set({ status: "read_failed", updatedAt: new Date() })
          .where(eq(rfpDocuments.id, doc.id));
        return;
      }
      await replaceRequirements(
        doc.id,
        result.requirements.map((r, i) => ({
          structureLabel: r.structureLabel,
          text: r.text,
          ordinal: i,
          kind: r.kind,
          mandatory: r.mandatory,
        }))
      );
      // Stated staff lands in the SAME update that stamps "extracted", so a
      // proposal can never be created against an extracted document whose
      // count has not landed yet.
      await db
        .update(rfpDocuments)
        .set({
          clientName: result.clientName,
          structureJson: JSON.stringify(result.structure),
          statedStaffCount: result.statedStaff?.count ?? null,
          statedStaffQuote: result.statedStaff?.quote ?? null,
          statedStaffBasis: result.statedStaff?.basis ?? null,
          status: "extracted",
          updatedAt: new Date(),
        })
        .where(eq(rfpDocuments.id, doc.id));
      await logRfpActivity({
        actorEmail: user.email,
        actorAdmin: user.admin,
        action: "document.extract",
        subjectKind: "document",
        subjectId: doc.id,
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
        },
      });
    } catch (err) {
      console.error("[rfp] background read failed:", err);
      await db
        .update(rfpDocuments)
        .set({ status: "read_failed", updatedAt: new Date() })
        .where(eq(rfpDocuments.id, doc.id))
        .catch(() => {});
    }
  });

  return rfpOk({ id: doc.id, status: "reading" }, 202);
}
