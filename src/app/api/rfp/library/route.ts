// /api/rfp/library (ARCHITECTURE.md §5.17.23, round 35): the supporting-
// documents library a proposal picks its numbered attachments from.
//
// GET  the library WITHOUT bytes: {documents: LibraryDocumentWire[]}, oldest
//      first; live rows only, or every row with ?retired=1 (the manager
//      shows retired rows struck).
// POST one upload, multipart/form-data: `file` (required), `title`, `kind`
//      (certification | report | procedure | template | sample | agreement),
//      `confidential` and `redactedSample` ("true" / "1" / "on", absent =
//      false), `asOf` (YYYY-MM-DD or empty). Magic-first (attachments.ts
//      validateLibraryUpload, the CLI's own check): a PDF or a Word .docx
//      only, at most 32 MB, media from the magic bytes, never the filename,
//      which is not stored. 201 {document: LibraryDocumentWire}.
//
// Retiring a row is POST /api/rfp/library/[id] {op: "retire"}; the download
// is GET /api/rfp/library/[id].
//
// Staff only, like all of /rfp (requireRfpApi). No byte of a file, and no
// filename, ever reaches a log line, an activity row or an error message:
// activity `library.add` carries the title, the kind and the flags only.

import { logRfpActivity } from "@/lib/rfp/activity";
import {
  LIBRARY_MAX_BYTES,
  LIBRARY_MAX_COPY,
  libraryWire,
  validateLibraryUpload,
} from "@/lib/rfp/attachments";
import { insertLibraryDocument, listLibraryDocuments } from "@/lib/rfp/db";
import { requireRfpApi, rfpError, rfpOk } from "@/lib/rfp/http";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** Multipart framing and the small fields, over the file cap. */
const FRAMING_ALLOWANCE = 1_000_000;

export async function GET(req: Request): Promise<Response> {
  const gate = await requireRfpApi("GET /api/rfp/library");
  if (!gate.ok) return gate.response;
  const includeRetired = new URL(req.url).searchParams.get("retired") === "1";
  try {
    const rows = await listLibraryDocuments({ includeRetired });
    return rfpOk({ documents: rows.map(libraryWire) });
  } catch (err) {
    console.error("[rfp] library list failed:", err instanceof Error ? err.constructor.name : "error");
    return rfpError("unavailable", "The library could not be read. Try again.", 503);
  }
}

export async function POST(req: Request): Promise<Response> {
  const gate = await requireRfpApi("POST /api/rfp/library");
  if (!gate.ok) return gate.response;
  const user = gate.user;

  const ctype = req.headers.get("content-type") ?? "";
  if (!ctype.includes("multipart/form-data"))
    return rfpError("invalid_request", "Send the document as form data.", 400);
  // Content-Length is checked BEFORE formData(), which buffers the whole body.
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > LIBRARY_MAX_BYTES + FRAMING_ALLOWANCE)
    return rfpError("too_large", `That file is over ${LIBRARY_MAX_COPY}.`, 413);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return rfpError("invalid_request", "Send the document as form data.", 400);
  }
  const file = form.get("file");
  if (!(file instanceof File)) return rfpError("invalid_request", "Attach the document.", 400);
  if (file.size > LIBRARY_MAX_BYTES)
    return rfpError("too_large", `That file is over ${LIBRARY_MAX_COPY}.`, 413);
  const bytes = Buffer.from(await file.arrayBuffer());

  const field = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v : undefined;
  };
  const checked = validateLibraryUpload({
    bytes,
    title: field("title"),
    kind: field("kind"),
    confidential: field("confidential"),
    redactedSample: field("redactedSample"),
    asOf: field("asOf"),
  });
  if (!checked.ok) return rfpError(checked.code, checked.message, checked.status);
  const v = checked.value;

  let row;
  try {
    row = await insertLibraryDocument({
      title: v.title,
      kind: v.kind,
      bytes,
      media: v.media,
      confidential: v.confidential,
      redactedSample: v.redactedSample,
      asOf: v.asOf,
      createdBy: user.email,
    });
  } catch (err) {
    // The constructor name only: a driver error can echo the parameters,
    // and one of them is the file.
    console.error("[rfp] library insert failed:", err instanceof Error ? err.constructor.name : "error");
    return rfpError("unavailable", "The document could not be saved. Nothing has been added. Try again.", 503);
  }

  await logRfpActivity({
    actorEmail: user.email,
    actorAdmin: user.admin,
    action: "library.add",
    subjectKind: "library",
    subjectId: row.id,
    meta: {
      title: row.title,
      kind: row.kind,
      ext: v.ext,
      confidential: row.confidential,
      redactedSample: row.redactedSample,
    },
  });
  return rfpOk({ document: libraryWire(row) }, 201);
}
