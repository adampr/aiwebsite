// POST - remove SEVERAL directory people in one request (§5.18 step 2, the
// 2026-08-09 bulk-cleanup round).
//
// WHY IT EXISTS: an Apollo import adds up to 500 rows in one click
// (apolloPagesPerImport x apolloPeoplePerPage), so the corrective action has
// to be within the same order of magnitude of effort as the action that
// caused it. Per row, the old flow cost two clicks, one HTTP round trip and
// a full router.refresh() that re-ran the whole server component; 500 of
// those is the real throughput problem, and no rate-limit number fixes it.
//
// POST, not DELETE-with-body: request bodies on DELETE are unreliable
// through proxies, and the house precedent for a multi-item mutation is POST
// (/api/work/submissions/[id]/reorder).
//
// Authority is UNCHANGED from the single-row route: the same
// directoryWriteLane (readStaffPage selects, requireGlobalAdmin authorizes
// the staff lane, requireCompanyAdmin the company lane,
// requireRoadmapWritesEnabled is the kill switch), and the lane scope goes
// into the WHERE, so a client-supplied id list can never cross lanes. The
// response carries COUNTS ONLY: per-id status would turn this into a
// cross-lane uuid existence oracle.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { removePeople } from "@/lib/roadmap/db";
import { directoryWriteLane } from "@/lib/roadmap/directory-gate";
import { okJson, roadmapError } from "@/lib/roadmap/http";
import { parseRemoveIds } from "@/lib/roadmap/validate";

export async function POST(req: Request): Promise<Response> {
  // bulk: its own limiter bucket, so one sweep cannot spend the single-write
  // budget and lock the Add form out (that is the bug this round fixes).
  const lane = await directoryWriteLane({ bulk: true });
  if (!lane.ok) return lane.response;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return roadmapError("invalid_request", "Send JSON.", 400);
  }
  const parsed = parseRemoveIds(body);
  if (!parsed.ok) return roadmapError(parsed.code, parsed.message, 400);

  const { removed, suppressed } = await removePeople({
    scope: lane.scope,
    personIds: parsed.ids,
    suppress: parsed.suppress,
  });
  // The only durable record that a sweep happened. These rows are hard
  // deleted and the suppression hashes are one-way, so an operator asking
  // "where did 200 people go" has nothing else to read. Emails are NOT
  // logged: the hashes exist precisely so addresses are not kept.
  console.warn(
    `[roadmap] bulk directory removal: user=${lane.userId} lane=${
      lane.scope.companyId ?? "staff"
    } requested=${parsed.ids.length} removed=${removed} suppressed=${suppressed}`
  );
  // requested is what the CLIENT asked for after de-duplication, so the UI
  // can say "Removed 47 of 50" without recounting its own stale selection.
  return okJson({ removed, suppressed, requested: parsed.ids.length });
}
