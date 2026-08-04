// GET - the "Your Work" nav-island probe (§5.18): does the viewer's trusted
// session belong to a company with at least one PUBLISHED card? Boolean
// only - no counts, no names; an untrusted or foreign session gets the same
// false as a signed-out one, so the endpoint is no oracle for company
// existence. no-store always.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { readRoadmapPrincipal } from "@/lib/roadmap/access";
import { hasPublishedCompanyWork } from "@/lib/work/db";
import { okJson, rateLimit } from "@/lib/roadmap/http";

export async function GET(req: Request): Promise<Response> {
  const ip =
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown";
  const limited = rateLimit(`roadmap:nav:${ip}`, 3600, 240);
  if (limited) return okJson({ yourWork: false });
  const result = await readRoadmapPrincipal();
  if (!result.ok || !result.principal.company)
    return okJson({ yourWork: false });
  return okJson({
    yourWork: await hasPublishedCompanyWork(result.principal.company.id),
  });
}
