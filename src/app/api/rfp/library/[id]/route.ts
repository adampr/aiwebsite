// /api/rfp/library/[id] (ARCHITECTURE.md §5.17.23, round 35)
//
// GET  the stored file itself, streamed with its magic-derived media type,
//      `Content-Disposition: attachment` named from the TITLE (the upload's
//      filename is never stored), `Cache-Control: no-store, private` and
//      nosniff. Retired rows download too: a proposal that picked one still
//      ships it.
// POST {op: "retire"}: retire a live row (never a delete). 200 {document:
//      LibraryDocumentWire}; 404 unknown; 409 already retired. Activity
//      `library.retire` with the title and kind only.
//
// Staff only (requireRfpApi). No byte ever reaches a log, an activity row or
// an error message.

import { logRfpActivity } from "@/lib/rfp/activity";
import { extForMedia, libraryWire } from "@/lib/rfp/attachments";
import { getLibraryDocumentFile, libraryDocumentsByIds, retireLibraryDocument } from "@/lib/rfp/db";
import { requireRfpApi, rfpError, rfpOk } from "@/lib/rfp/http";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_SUCH = "No such library document.";

/** The download name: the title with anything outside a plain filename
 *  alphabet removed (ASCII form), plus an RFC 5987 UTF-8 form. */
function disposition(title: string, ext: string): string {
  const plain =
    title
      .replace(/[^A-Za-z0-9 ._()-]+/g, "")
      .replace(/ +/g, " ")
      .trim()
      .slice(0, 120) || "document";
  const utf = encodeURIComponent(
    `${title.replace(/[\\/:*?"<>|\r\n]+/g, " ").replace(/ +/g, " ").trim().slice(0, 120)}.${ext}`
  ).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${plain}.${ext}"; filename*=UTF-8''${utf}`;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const gate = await requireRfpApi("GET /api/rfp/library/[id]");
  if (!gate.ok) return gate.response;
  const { id } = await params;
  let file;
  try {
    file = await getLibraryDocumentFile(id);
  } catch (err) {
    console.error("[rfp] library read failed:", err instanceof Error ? err.constructor.name : "error");
    return rfpError("unavailable", "The document could not be read. Try again.", 503);
  }
  if (!file) return rfpError("not_found", NO_SUCH, 404);
  const ext = extForMedia(file.media) ?? "bin";
  return new Response(new Uint8Array(file.bytes), {
    status: 200,
    headers: {
      "content-type": file.media,
      "content-length": String(file.bytes.length),
      "content-disposition": disposition(file.title, ext),
      "cache-control": "no-store, private",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const gate = await requireRfpApi("POST /api/rfp/library/[id]");
  if (!gate.ok) return gate.response;
  const user = gate.user;
  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return rfpError("invalid_request", "Send JSON.", 400);
  }
  if (!body || typeof body !== "object" || (body as { op?: unknown }).op !== "retire")
    return rfpError("invalid_request", 'Send {"op": "retire"}.', 400);

  let retired;
  try {
    retired = await retireLibraryDocument(id);
    if (!retired) {
      const [row] = await libraryDocumentsByIds([id]);
      return row
        ? rfpError("conflict", "That document is already retired.", 409)
        : rfpError("not_found", NO_SUCH, 404);
    }
  } catch (err) {
    console.error("[rfp] library retire failed:", err instanceof Error ? err.constructor.name : "error");
    return rfpError("unavailable", "The document could not be retired. Nothing has changed. Try again.", 503);
  }

  await logRfpActivity({
    actorEmail: user.email,
    actorAdmin: user.admin,
    action: "library.retire",
    subjectKind: "library",
    subjectId: retired.id,
    meta: { title: retired.title, kind: retired.kind },
  });
  return rfpOk({ document: libraryWire(retired) });
}
