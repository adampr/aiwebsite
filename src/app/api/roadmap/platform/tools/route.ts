// POST - add a Builder Tool card (§5.20 step 11). Admin-only in both
// lanes. Same save-first, check-second rule as the singleton route.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { addToolLink, countTools } from "@/lib/roadmap/db";
import { ROADMAP_CAPS } from "@/lib/roadmap/config";
import {
  limitPlatformWrite,
  limitUrlCheck,
  requirePlatformAdmin,
} from "@/lib/roadmap/platform-http";
import { publicRow, verifyRow } from "@/lib/roadmap/platform-check";
import { okJson, roadmapError } from "@/lib/roadmap/http";
import { parseToolFields } from "@/lib/roadmap/validate";

export async function POST(req: Request): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const { actor } = gate;

  const limited = limitPlatformWrite(actor);
  if (limited) return limited;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return roadmapError("invalid_request", "Send JSON.", 400);
  }

  const fields = parseToolFields(body);
  if (!fields.ok) return roadmapError("invalid_request", fields.message, 400);

  // The cap is enforced here rather than by an index because it is a
  // product limit, not an integrity rule. A race past it by one row is
  // harmless; a silently truncated list is not, which is why the page
  // reports the cap rather than hiding rows.
  const existing = await countTools(actor.scope);
  if (existing >= ROADMAP_CAPS.toolsMax)
    return roadmapError(
      "limit_reached",
      `This list holds up to ${ROADMAP_CAPS.toolsMax} tools. Remove one before adding another.`,
      409
    );

  const saved = await addToolLink({
    scope: actor.scope,
    label: fields.label,
    description: fields.description,
    url: fields.url,
    docsUrl: fields.docsUrl,
    addedByUserId: actor.userId,
    addedByEmail: actor.email,
  });

  // The limiter is spent PER FIELD inside verifyRow (a field is what costs
  // outbound requests), and a refusal is not an error here: the row is
  // already saved and simply stays unchecked until the admin retries.
  const checked = await verifyRow(actor.scope, saved, {
    spend: () => limitUrlCheck(actor),
  }).catch(() => ({ row: saved, skipped: true }));
  const row = checked.row;
  const checkSkipped = checked.skipped;

  return okJson({ row: publicRow(row), checkSkipped }, 201);
}
