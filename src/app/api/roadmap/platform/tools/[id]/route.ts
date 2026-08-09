// PATCH / DELETE one Builder Tool card (§5.20 step 11). Admin-only in both
// lanes.
//
// The id is NEVER trusted on its own: every db helper binds it together
// with the caller's lane, so a tool id belonging to another company matches
// nothing and reads as not_found. That is the same discipline as the
// governance doc routes, and it is why there is no separate ownership
// check here to forget.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { removeToolLink, updateToolLink } from "@/lib/roadmap/db";
import {
  limitPlatformWrite,
  limitUrlCheck,
  requirePlatformAdmin,
} from "@/lib/roadmap/platform-http";
import { publicRow, verifyRow } from "@/lib/roadmap/platform-check";
import { okJson, roadmapError } from "@/lib/roadmap/http";
import { isUuid, parseToolFields } from "@/lib/roadmap/validate";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const { actor } = gate;

  const limited = limitPlatformWrite(actor);
  if (limited) return limited;

  const { id } = await ctx.params;
  // company_roadmap_links.id is a uuid column, so a malformed segment
  // reaching Postgres as a uuid cast throws 22P02 and the route 500s where
  // the honest answer is 404 (the same rule the directory routes follow).
  if (!isUuid(id)) return roadmapError("not_found", "That tool is not here.", 404);
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return roadmapError("invalid_request", "Send JSON.", 400);
  }
  const fields = parseToolFields(body);
  if (!fields.ok) return roadmapError("invalid_request", fields.message, 400);

  const saved = await updateToolLink({
    scope: actor.scope,
    id,
    label: fields.label,
    description: fields.description,
    url: fields.url,
    docsUrl: fields.docsUrl,
  });
  if (!saved) return roadmapError("not_found", "That tool is not here.", 404);

  // updateToolLink resets the verification state of any field whose URL
  // actually changed, so this only re-checks what moved.
  // The limiter is spent PER FIELD inside verifyRow (a field is what costs
  // outbound requests), and a refusal is not an error here: the row is
  // already saved and simply stays unchecked until the admin retries.
  const checked = await verifyRow(actor.scope, saved, {
    spend: () => limitUrlCheck(actor),
    internalDomain: actor.internalDomain,
  }).catch(() => ({ row: saved, skipped: true }));
  const row = checked.row;
  const checkSkipped = checked.skipped;

  return okJson({ row: publicRow(row, actor.internalDomain), checkSkipped });
}

export async function DELETE(_req: Request, ctx: Ctx): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const { actor } = gate;

  const limited = limitPlatformWrite(actor);
  if (limited) return limited;

  const { id } = await ctx.params;
  if (!isUuid(id)) return roadmapError("not_found", "That tool is not here.", 404);
  const removed = await removeToolLink({ scope: actor.scope, id });
  if (!removed) return roadmapError("not_found", "That tool is not here.", 404);
  return okJson({ removed: true });
}
