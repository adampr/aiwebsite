// POST /api/rfp/documents — create an RFP from an upload or pasted text.
//
// Returns 202 immediately and reads the RFP in the background. Reading a real
// client RFP measured at 30-150s against the live brain (it grows with the
// number of requirements), and the edge closes a request at 100s, so doing it
// inline would fail on exactly the documents that matter most. The client
// polls the document row for status.

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
import { createDocument } from "@/lib/rfp/db";
import { requireRfpApi, rfpError, rfpOk } from "@/lib/rfp/http";
import { runDocumentRead } from "@/lib/rfp/read-document";

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
  // A title the user typed is theirs and is never replaced. With none typed
  // the title is AUTO: a humanized filename (or "Untitled RFP" for a paste)
  // now, and "<client> · <the RFP's own subject line>" once it has been read.
  let typedTitle = "";
  // The FIRST attached file names the auto title; never any later one.
  let firstFileName: string | null = null;
  let filesCount = 0;
  let truncated = false;

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
    const kinds: ("pdf" | "docx" | "text")[] = [];
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
      if (!kind)
        return rfpError(
          "invalid_request",
          `"${sanitizeSourceName(file.name)}": Upload a PDF, a Word .docx, or a .txt file, or paste the text instead.`,
          400
        );

      const extracted = await extractStyleSampleText(file.name, buf, MAX_CHARS);
      if (!extracted.ok)
        return rfpError(
          "invalid_request",
          `Could not read "${sanitizeSourceName(file.name)}". Scanned PDFs with no text layer are the usual cause. Paste the text instead and it works the same way.`,
          400
        );
      bufs.push(buf);
      kinds.push(kind);
      parts.push({ kind: "file", name: file.name, text: extracted.text });
    }

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
    }

    // Single part stays byte-identical to the pre-multi behavior; only a
    // multi-part intake gets the ===== headers.
    const composed = composeRfpParts(parts);
    rawText = composed.text;
    truncated = composed.truncated;
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
      // Count only, never a filename: meta is operator-visible text.
      files: filesCount,
      chars: screened.clean.length,
      // The 120k combined cap cut material. Silent whole-part loss is the
      // failure mode; this puts it on the operator record at least.
      truncated,
      injectionHits: screened.hits.length,
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

  return rfpOk({ id: doc.id, status: "reading" }, 202);
}
