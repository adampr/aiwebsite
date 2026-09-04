// GET /api/internal/xlant/download — the newest XLAnt Windows installer,
// staff-gated (ARCHITECTURE.md §5.22). The .exe lives outside the web root in
// XLANT_ARTIFACTS_DIR (published to this VM by the xlant repo's own publish
// step) and is streamed from here, never linked publicly: a public URL would
// put an XL.net-signed installer in front of anyone who found the path.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { createReadStream } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  latestInstaller,
  requireXlantStaff,
  safeArtifactName,
  xlantConfig,
} from "@/lib/xlant";

function fail(error: string, status: number): Response {
  return Response.json(
    { error },
    { status, headers: { "cache-control": "no-store, private" } }
  );
}

export async function GET(req: Request): Promise<Response> {
  const cfg = xlantConfig();
  if (!cfg) return fail("XLAnt is not configured on this host", 503);

  const gate = await requireXlantStaff();
  if (!gate.ok) {
    // This is a plain <a> on a staff page, so the caller is a BROWSER, not a
    // fetch(): a session that expired while the page sat open must land on the
    // login form and come back here, not download a JSON error object named
    // "download". Every other refusal is a real refusal and answers JSON, and
    // the redirect carries no body a cache could keep.
    if (gate.reason === "unauthenticated") {
      // Resolved against the request's own URL rather than a configured base,
      // so this cannot send anyone to a different host than the one they are
      // on. The destination is a fixed internal path; nothing user-supplied
      // reaches it.
      return Response.redirect(new URL("/login?redirect=/internal/xlant", req.url), 302);
    }
    return fail(gate.reason, 403);
  }

  const installer = await latestInstaller(cfg);
  if (!installer) return fail("no installer published yet", 404);
  // The name came from readdir(), so this can only fail if the artifacts dir
  // holds something strange. Refuse rather than open a stream on it.
  if (!safeArtifactName(installer.fileName)) {
    return fail("installer name refused", 500);
  }

  const stream = Readable.toWeb(
    createReadStream(join(cfg.artifactsDir, installer.fileName))
  ) as ReadableStream;

  return new Response(stream, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(installer.size),
      "Content-Disposition": `attachment; filename="${installer.fileName}"`,
      // A gated binary must never be cached by us or by anything between us
      // and the browser.
      "Cache-Control": "private, no-store",
    },
  });
}
