// POST /api/rfp/documents — create an RFP from an upload or pasted text.
//
// Returns 202 immediately and reads the RFP in the background. Reading a real
// client RFP measured at 30-150s against the live brain (it grows with the
// number of requirements), and the edge closes a request at 100s, so doing it
// inline would fail on exactly the documents that matter most. The client
// polls the document row for status.
//
// Scanned PDFs (no text layer, or one under PDF_TEXT_FLOOR) and images are
// transcribed by vision (§5.17.18), never inline: a long scan takes minutes.
// Such an intake stores its parts in rfp_intake_parts and the same
// background worker transcribes them before it reads. An intake with no
// part needing vision takes exactly the path it always did.

import { after } from "next/server";
import crypto from "node:crypto";
import { extractStyleSampleText } from "@/lib/governance/style-sample";
import { screenInjection } from "@/lib/governance/research";
import { UNTITLED_RFP, humanizeFilename } from "@/lib/rfp/doc-title";
import { logRfpActivity } from "@/lib/rfp/activity";
import {
  RFP_MAX_FILES,
  composeRfpParts,
  sanitizeSourceName,
  type RfpIntakePart,
} from "@/lib/rfp/intake";
import { createDocument, createDocumentWithParts } from "@/lib/rfp/db";
import { requireRfpApi, rfpError, rfpOk } from "@/lib/rfp/http";
import { runDocumentRead } from "@/lib/rfp/read-document";
import {
  VISION_IMAGE_FORMATS_COPY,
  VISION_IMAGE_MEDIA,
  isUnsupportedImage,
  pdfNeedsVision,
  sniffVisionImage,
  visionConfigured,
  visionImageProblem,
  visionImageRefusal,
  type VisionImageKind,
} from "@/lib/rfp/vision-extract";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** Well under the 12m nginx cap so the app returns a real message, not a 413. */
const MAX_BYTES = 8_000_000;
const MAX_CHARS = 120_000;

type Sniffed = "pdf" | "docx" | "text" | VisionImageKind;

/** Magic bytes, because a filename suffix is a claim not a fact. */
function sniff(name: string, buf: Buffer): Sniffed | null {
  if (buf.length >= 4) {
    if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46)
      return "pdf";
    // .docx is a zip
    if (buf[0] === 0x50 && buf[1] === 0x4b) return "docx";
  }
  // PNG, JPEG, GIF, WebP: the four formats the vision API reads (§5.17.18).
  const image = sniffVisionImage(buf);
  if (image) return image;
  if (/\.(md|txt)$/i.test(name)) return "text";
  return null;
}

function isImageKind(kind: Sniffed): kind is VisionImageKind {
  return kind === "png" || kind === "jpeg" || kind === "gif" || kind === "webp";
}

/** One rfp_intake_parts row, for an intake with a part that needs vision. */
type IntakePartInsert = {
  kind: "file" | "paste";
  name: string | null;
  media: string | null;
  text: string | null;
  bytes: Buffer | null;
};

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
  // A title the user typed is theirs and is never replaced. With none typed
  // the title is AUTO: a humanized filename (or "Untitled RFP" for a paste)
  // now, and "<client> · <the RFP's own subject line>" once it has been read.
  let typedTitle = "";
  // The FIRST attached file names the auto title; never any later one.
  let firstFileName: string | null = null;
  let filesCount = 0;
  let truncated = false;
  // Set only when a part needs vision transcription (§5.17.18).
  let pendingParts: IntakePartInsert[] | null = null;

  if (ctype.includes("multipart/form-data")) {
    // Content-Length is checked BEFORE formData(), which buffers the whole body.
    const declared = Number(req.headers.get("content-length") ?? "0");
    // "upload", not "file": this fires for the sum of several files plus the
    // pasted text plus multipart framing, not only for one oversized file.
    if (declared > MAX_BYTES)
      return rfpError("too_large", "That upload is over 8 MB.", 413);

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return rfpError("invalid_request", "Send the file as form data.", 400);
    }
    // The legacy single "file" field (a stale open tab) comes first, then the
    // repeated "files" entries, in received order.
    const files = [form.get("file"), ...form.getAll("files")].filter(
      (f): f is File => f instanceof File
    );
    const pasted = String(form.get("text") ?? "");
    typedTitle = String(form.get("title") ?? "").trim();

    if (files.length > RFP_MAX_FILES)
      return rfpError("invalid_request", "Attach up to 8 files.", 400);

    const parts: RfpIntakePart[] = [];
    const bufs: Buffer[] = [];
    const kinds: Sniffed[] = [];
    // Every part in compose order, kept for the vision path only: when any
    // part needs transcription these become the rfp_intake_parts rows.
    const partRows: IntakePartInsert[] = [];
    const canTranscribe = visionConfigured();
    let totalBytes = 0;
    for (const file of files) {
      // A 0-byte attachment must never be silently dropped: the sender meant
      // to attach something and would otherwise never learn it was not read.
      if (file.size === 0)
        return rfpError(
          "invalid_request",
          `"${sanitizeSourceName(file.name)}" is empty.`,
          400
        );
      if (file.size > MAX_BYTES)
        return rfpError("too_large", "That file is over 8 MB.", 413);
      const buf = Buffer.from(await file.arrayBuffer());
      if (buf.length > MAX_BYTES)
        return rfpError("too_large", "That file is over 8 MB.", 413);
      totalBytes += buf.length;
      if (totalBytes > MAX_BYTES)
        return rfpError("too_large", "Together the files are over 8 MB.", 413);

      const kind = sniff(file.name, buf);
      if (!kind) {
        // BMP, TIFF, HEIC, SVG: an image the API cannot read. Say which
        // formats it can, rather than the generic list (only when this
        // server reads images at all; otherwise the pre-vision copy).
        if (canTranscribe && isUnsupportedImage(file.name, buf))
          return rfpError(
            "invalid_request",
            visionImageRefusal(`"${sanitizeSourceName(file.name)}"`, "unsupported"),
            400
          );
        // Images are offered only when this server can read them: with no
        // key an image upload is refused, so inviting one would be a lie.
        return rfpError(
          "invalid_request",
          canTranscribe
            ? `"${sanitizeSourceName(file.name)}": Upload a PDF, a Word .docx, a .txt file, or an image (${VISION_IMAGE_FORMATS_COPY}), or paste the text instead.`
            : `"${sanitizeSourceName(file.name)}": Upload a PDF, a Word .docx, or a .txt file, or paste the text instead.`,
          400
        );
      }

      // An image is always transcribed. Everything that would make the API
      // refuse it is checked here, at request time, not minutes later.
      if (isImageKind(kind)) {
        const problem = visionImageProblem(kind, buf);
        if (problem)
          return rfpError(
            problem === "too_large" ? "too_large" : "invalid_request",
            visionImageRefusal(`"${sanitizeSourceName(file.name)}"`, problem),
            problem === "too_large" ? 413 : 400
          );
        if (!canTranscribe)
          return rfpError(
            "invalid_request",
            `"${sanitizeSourceName(file.name)}" is an image, and reading images is not set up on this server. Paste the text instead and it works the same way.`,
            400
          );
        bufs.push(buf);
        kinds.push(kind);
        // `parts` keeps counting every part (the provenance rules read its
        // length); a pending part's empty text is never composed here.
        parts.push({ kind: "file", name: file.name, text: "" });
        partRows.push({
          kind: "file",
          name: file.name,
          media: VISION_IMAGE_MEDIA[kind],
          text: null,
          bytes: buf,
        });
        continue;
      }

      const extracted = await extractStyleSampleText(file.name, buf, MAX_CHARS);
      // A PDF whose text layer failed or is too sparse to be the document
      // (a scan) is transcribed instead. With transcription not configured
      // the ladder is exactly today's: sparse text is used, a failure 400s.
      if (kind === "pdf" && canTranscribe && pdfNeedsVision(extracted)) {
        bufs.push(buf);
        kinds.push(kind);
        parts.push({ kind: "file", name: file.name, text: "" });
        partRows.push({
          kind: "file",
          name: file.name,
          media: "application/pdf",
          text: null,
          bytes: buf,
        });
        continue;
      }
      if (!extracted.ok)
        return rfpError(
          "invalid_request",
          `Could not read "${sanitizeSourceName(file.name)}". Scanned PDFs with no text layer are the usual cause. Paste the text instead and it works the same way.`,
          400
        );
      bufs.push(buf);
      kinds.push(kind);
      parts.push({ kind: "file", name: file.name, text: extracted.text });
      partRows.push({
        kind: "file",
        name: file.name,
        media: kind === "pdf" ? "application/pdf" : null,
        text: extracted.text,
        bytes: null,
      });
    }
    const pendingCount = partRows.filter((p) => p.bytes !== null).length;

    // Pasted text rides along at any length beside files; alone it must still
    // clear today's 40-character floor. The paste part is always LAST.
    if (files.length === 0) {
      if (pasted.trim().length < 40)
        return rfpError(
          "invalid_request",
          "Attach a file or paste at least a few lines of the RFP.",
          400
        );
      parts.push({ kind: "paste", text: pasted });
    } else if (pasted.trim().length > 0) {
      parts.push({ kind: "paste", text: pasted });
      partRows.push({ kind: "paste", name: null, media: null, text: pasted, bytes: null });
    }

    if (pendingCount === 0) {
      // Single part stays byte-identical to the pre-multi behavior; only a
      // multi-part intake gets the ===== headers.
      const composed = composeRfpParts(parts);
      rawText = composed.text;
      truncated = composed.truncated;
    } else {
      // raw_text stays "" until the worker has transcribed the pending
      // parts; it then composes ALL parts in this same order.
      pendingParts = partRows;
    }
    filesCount = files.length;
    firstFileName = files[0]?.name ?? null;

    if (files.length === 1 && parts.length === 1) {
      // Exactly one file, no paste: provenance columns unchanged.
      sourceKind = kinds[0] === "text" ? "txt" : kinds[0]!;
      sourceName = files[0]!.name.slice(0, 300);
      sourceSha = crypto.createHash("sha256").update(bufs[0]!).digest("hex");
      sourceBytes = bufs[0]!.length;
    } else if (files.length >= 1) {
      sourceKind = "multi";
      sourceName = files
        .map((f) => sanitizeSourceName(f.name))
        .join(" + ")
        .slice(0, 300);
      sourceSha = crypto
        .createHash("sha256")
        .update(Buffer.concat(bufs))
        .digest("hex");
      sourceBytes = totalBytes;
    }
    // Paste only: sourceKind stays "paste" with null provenance, as today.
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
    truncated = body.text.length > MAX_CHARS;
    typedTitle = String(body.title ?? "").trim();
  }

  const autoTitle = !typedTitle;
  const title =
    typedTitle ||
    (firstFileName ? humanizeFilename(firstFileName) : UNTITLED_RFP);

  // Untrusted third-party text headed for a prompt. Dropped lines are a review
  // signal on the row, never a silent edit and never a hard block.
  const screened = screenInjection(rawText);

  const docInput = {
    title,
    clientName: null,
    sourceKind,
    sourceName,
    sourceSha256: sourceSha,
    sourceBytes,
    rawText: screened.clean,
    injectionFlagged: screened.hits.length > 0,
  };
  // With a part pending transcription, the row and its parts are written in
  // one transaction; the screen then runs in the worker, over the composed
  // text, once the transcriptions exist.
  const doc = pendingParts
    ? await createDocumentWithParts(user, docInput, pendingParts)
    : await createDocument(user, docInput);
  const visionFiles = pendingParts
    ? pendingParts.filter((p) => p.bytes !== null).length
    : 0;

  await logRfpActivity({
    actorEmail: user.email,
    actorAdmin: user.admin,
    action: "document.create",
    subjectKind: "document",
    subjectId: doc.id,
    meta: {
      sourceKind,
      // Count only, never a filename: meta is operator-visible text.
      files: filesCount,
      chars: screened.clean.length,
      // The 120k combined cap cut material. Silent whole-part loss is the
      // failure mode; this puts it on the operator record at least.
      truncated,
      injectionHits: screened.hits.length,
      // Shape only, and only on the vision path, so a no-vision intake logs
      // exactly what it always did. chars is 0 there: the text arrives with
      // the transcription, logged as document.transcribe.
      ...(visionFiles > 0 ? { visionFiles } : {}),
    },
  });
  if (truncated)
    console.warn(
      `[rfp] intake truncated at ${MAX_CHARS} chars (doc ${doc.id}, files ${filesCount})`
    );

  // Read it in the background. after() is the host's established pattern for
  // this (governance turn-runner); the narrow "never after()" rule applies to
  // the module's inbound-email webhook, where the response has already closed.
  after(() =>
    runDocumentRead({
      docId: doc.id,
      rawText: screened.clean,
      storedTitle: doc.title,
      autoTitle,
      sourceKind,
      actor: { email: user.email, admin: user.admin },
    })
  );

  // `vision: true` only on the vision path (additive): the /rfp/new form
  // then polls the longer transcription-plus-read window; without it the
  // pre-vision window applies, so a stuck plain read fails as early as it did.
  return rfpOk(
    { id: doc.id, status: "reading", ...(visionFiles > 0 ? { vision: true } : {}) },
    202
  );
}
