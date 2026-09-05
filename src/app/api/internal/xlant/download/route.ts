// GET /api/internal/xlant/download — the newest XLAnt build, staff-gated
// (ARCHITECTURE.md §5.22). The artifacts live outside the web root in
// XLANT_ARTIFACTS_DIR (published to this VM by the xlant repo's own publish
// step) and are streamed from here, never linked publicly: a public URL would
// put an XL.net-signed installer in front of anyone who found the path.
//
// TWO PLATFORMS SINCE CONTRACT 0.5.0. `?platform=mac&arch=arm64|x64` serves a
// macOS bundle; no query at all is the Windows installer, which is what every
// link on this host asked for before the Mac card existed and what an old
// bookmark still asks for. `arch` is REQUIRED for mac and has no default: the
// two zips are not interchangeable, and handing an Intel Mac the arm64 bundle
// produces an app that will not launch — a 400 naming the choice is a better
// answer than a guess.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { createReadStream } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  latestInstaller,
  latestMacBundle,
  requireXlantStaff,
  safeArtifactName,
  xlantArtifactContentType,
  xlantConfig,
  xlantDownloadRequest,
  type InstallerInfo,
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
      // Relative Location on purpose: behind the reverse proxy `req.url` is the
      // INTERNAL origin (http://localhost:3000), and resolving against it sent
      // signed-out staff to localhost (measured on the first deploy). The
      // browser resolves a relative Location against the public origin.
      return new Response(null, {
        status: 302,
        headers: { Location: "/login?redirect=/internal/xlant", "Cache-Control": "private, no-store" },
      });
    }
    return fail(gate.reason, 403);
  }

  // Read AFTER the gate, so a malformed query from a signed-out caller is
  // still answered by the login redirect rather than by a 400 that tells an
  // anonymous caller what parameters this route takes. The decision itself is
  // xlantDownloadRequest()'s, which is a pure function of the query string and
  // is therefore pinned branch by branch in scripts/xlant-tests.ts.
  const want = xlantDownloadRequest(new URL(req.url).searchParams);
  if (!want.ok) return fail(want.error, 400);

  const artifact: InstallerInfo | null =
    want.platform === "windows"
      ? await latestInstaller(cfg)
      : await latestMacBundle(cfg, want.arch);
  if (!artifact) {
    return fail(
      want.platform === "windows"
        ? "no installer published yet"
        : "no Mac build published yet",
      404
    );
  }
  // The name came from readdir(), so this can only fail if the artifacts dir
  // holds something strange. Refuse rather than open a stream on it.
  if (!safeArtifactName(artifact.fileName)) {
    return fail("artifact name refused", 500);
  }

  const stream = Readable.toWeb(
    createReadStream(join(cfg.artifactsDir, artifact.fileName))
  ) as ReadableStream;

  return new Response(stream, {
    headers: {
      // The same name→type table the update feed uses, so one name cannot be
      // described two ways by the two lanes that serve it. In practice that is
      // application/octet-stream for the .exe and application/zip for a Mac
      // bundle.
      "Content-Type": xlantArtifactContentType(artifact.fileName),
      "Content-Length": String(artifact.size),
      "Content-Disposition": `attachment; filename="${artifact.fileName}"`,
      // A gated binary must never be cached by us or by anything between us
      // and the browser.
      "Cache-Control": "private, no-store",
    },
  });
}
