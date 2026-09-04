// GET /api/xlant/update/{latest.yml | XLAnt-Setup-x.y.z.exe | *.blockmap} —
// the electron-updater generic feed (ARCHITECTURE.md §5.22). Moved here from
// roleplay.xl.net on 2026-09-04; desktop 0.2.1 is re-signed and re-published
// with `provider: generic, url: https://ai.xl.net/api/xlant/update`.
// roleplay.xl.net has carried nothing of XLAnt since 2026-09-04, so this is
// the only feed any desktop reaches and this VM's XLANT_ARTIFACTS_DIR is the
// only published copy — see §5.22 and the xlant repo's docs/SETUP.md
// "Cutover (2026-09-04)".
//
// Gated by the per-user DEVICE token, not by a session: the updater is a
// background process inside the tray app and cannot carry a browser cookie.
// It sends `Authorization: Bearer <device token>`, which is verified against
// the relay's INTERNAL `POST /v1/device/verify` through the short positives-
// only cache in `@/lib/xlant` (one upgrade fetches latest.yml, the .exe and
// the .blockmap, and must not cost three relay round-trips).
//
// NOT in `src/proxy.ts`'s `protectedPrefixes` — see the comment there. This is
// a GET, which the module's CSRF check ignores anyway, but the whole
// `/api/xlant` tree stays out for the sibling relay route's sake.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  isXlantUpdateArtifact,
  safeArtifactName,
  verifyDeviceToken,
  xlantConfig,
} from "@/lib/xlant";

function fail(error: string, status: number): Response {
  return Response.json(
    { error },
    { status, headers: { "Cache-Control": "private, no-store" } }
  );
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ path?: string[] }> }
): Promise<Response> {
  const cfg = xlantConfig();
  if (!cfg) return fail("XLAnt is not configured on this host", 503);

  const token =
    /^Bearer\s+(.+)$/.exec(req.headers.get("authorization") ?? "")?.[1]?.trim() ??
    "";
  if (!(await verifyDeviceToken(cfg, token))) {
    return fail("device token required", 401);
  }

  const { path } = await ctx.params;
  // Joined with "/" so a multi-segment request becomes a name safeArtifactName
  // refuses, rather than being resolved into a directory below the artifacts
  // dir. 400 before any filesystem call.
  const name = (path ?? []).join("/");
  if (!name || !safeArtifactName(name)) return fail("bad path", 400);
  // A safe name is not automatically a PUBLISHABLE one. The artifacts dir also
  // holds the publish step's `<name>.part` temp files and whatever else an
  // operator leaves there; serving `latest.yml.part` would hand the updater a
  // truncated manifest. Only the manifest, an installer and its blockmap are
  // releases — 404, and only after the token check above, so this can never be
  // used to enumerate the directory.
  if (!isXlantUpdateArtifact(name)) return fail("not found", 404);

  const full = join(cfg.artifactsDir, name);
  let size: number;
  try {
    size = (await stat(full)).size;
  } catch {
    return fail("not found", 404);
  }

  // Content-Length from the SAME stat the stream is opened against:
  // electron-updater checks the length of the .exe against latest.yml and
  // aborts a short read rather than installing a truncated build.
  const stream = Readable.toWeb(createReadStream(full)) as ReadableStream;
  return new Response(stream, {
    headers: {
      "Content-Type": name.endsWith(".yml")
        ? "text/yaml"
        : "application/octet-stream",
      "Content-Length": String(size),
      // A gated binary must never be cached by us or by anything between us
      // and the PC asking for it.
      "Cache-Control": "private, no-store",
    },
  });
}
