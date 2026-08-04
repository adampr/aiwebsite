// GET (download) / DELETE (remove) - one company governance doc (§5.18).
// The doc id comes from the URL but the company ALWAYS comes from the
// server-derived principal, bound into the ONE query: missing and not-owned
// are the same 404 body (no existence oracle). Downloads never trust the
// stored mime - always octet-stream + attachment + nosniff, so an uploaded
// HTML/SVG "policy" can never execute on this origin.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { requireCompanyAdmin, requireCompanyMember } from "@/lib/roadmap/access";
import {
  governanceDocForDownload,
  removeGovernanceDoc,
} from "@/lib/roadmap/db";
import { ROADMAP_CAPS } from "@/lib/roadmap/config";
import {
  okJson,
  rateLimit,
  requireRoadmapWritesEnabled,
  roadmapError,
} from "@/lib/roadmap/http";

type Ctx = { params: Promise<{ id: string }> };

const NOT_FOUND = () =>
  roadmapError("not_found", "That document does not exist.", 404);

function safeFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 120) || "document";
}

export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  const gate = await requireCompanyMember();
  if (!gate.ok) return gate.response;
  const p = gate.principal;
  const limited = rateLimit(
    `roadmap:docdl:${p.userId}`,
    3600,
    ROADMAP_CAPS.portalReadsPerUserPerHour
  );
  if (limited) return limited;
  const { id } = await ctx.params;
  const doc = await governanceDocForDownload(id, p.company.id);
  if (!doc) return NOT_FOUND();
  const body: Buffer | string | null = doc.fileData
    ? Buffer.from(doc.fileData)
    : doc.docText;
  if (!body) return NOT_FOUND();
  const filename = doc.fileData
    ? safeFilename(doc.fileName ?? `${doc.title}.bin`)
    : `${safeFilename(doc.title)}.md`;
  return new Response(body as BodyInit, {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${filename}"`,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store, private",
    },
  });
}

export async function DELETE(_req: Request, ctx: Ctx): Promise<Response> {
  const gate = await requireCompanyAdmin();
  if (!gate.ok) return gate.response;
  const p = gate.principal;
  const disabled = requireRoadmapWritesEnabled();
  if (disabled) return disabled;
  const limited = rateLimit(
    `roadmap:docs:${p.userId}`,
    3600,
    ROADMAP_CAPS.docWritesPerUserPerHour
  );
  if (limited) return limited;
  const { id } = await ctx.params;
  const removed = await removeGovernanceDoc(id, p.company.id);
  if (!removed) return NOT_FOUND();
  return okJson({ deleted: true });
}
