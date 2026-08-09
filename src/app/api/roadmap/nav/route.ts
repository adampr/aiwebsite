// GET - the roadmap nav-island probe (§5.18, extended §5.20).
//
// Answers two things for the viewer's OWN lane and nothing else: does this
// workspace have published work ("Your Work" link), and what is its roadmap
// completion percentage (the site-wide badge).
//
// PRIVACY SHAPE IS UNCHANGED and load-bearing: an untrusted session, a
// session with no workspace, and a signed-out visitor all receive the SAME
// empty answer, so the endpoint is no oracle for company existence. The
// percentage is a fact about the viewer's own workspace, visible to every
// member of it by design (the owner asked for exactly that), and it is
// never returned for a company the caller does not belong to: the principal
// is server-derived and there is no company parameter to tamper with.
//
// no-store always. The response is per-viewer, so it must never be cached
// by anything: one company's number landing in another's nav would be the
// worst possible bug in this feature.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { readRoadmapPrincipal, readStaffPage } from "@/lib/roadmap/access";
import { hasPublishedCompanyWork } from "@/lib/work/db";
import { okJson, rateLimit } from "@/lib/roadmap/http";
import {
  companyProgressStatus,
  staffRoadmapStatus,
} from "@/lib/roadmap/status";
import { roadmapProgress } from "@/lib/roadmap/progress";

const EMPTY = { yourWork: false, percent: null } as const;

export async function GET(req: Request): Promise<Response> {
  // The IP fence bounds UNAUTHENTICATED noise. It deliberately does NOT
  // bound signed-in users: a whole office behind one NAT address shares an
  // IP, and at 240/hour a busy company would push itself over the limit and
  // the badge would silently vanish for everyone there (the over-limit
  // branch answers EMPTY, which the badge renders as nothing). The
  // per-USER fence below is the one that applies to people who are actually
  // signed in, which is the only population that gets a real answer anyway.
  const ip =
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown";

  // Staff first, mirroring readRoadmapHubView's ordering: xl.net is a
  // RESERVED domain and can never be a companies row, so a staff session
  // would otherwise fall through to the no-workspace answer. yourWork stays
  // false for staff (they have /work), which is exactly what the nav link
  // did before this route learned about them.
  const staff = await readStaffPage();
  if (staff) {
    const limited = rateLimit(`roadmap:nav:u:${staff.email}`, 3600, 600);
    if (limited) return okJson(EMPTY);
    const status = await staffRoadmapStatus();
    return okJson({ yourWork: false, percent: roadmapProgress(status).percent });
  }

  const result = await readRoadmapPrincipal();
  if (!result.ok || !result.principal.company) {
    // Nobody with a real answer: this is where the IP fence earns its keep,
    // since an unauthenticated caller can hammer the endpoint.
    if (rateLimit(`roadmap:nav:${ip}`, 3600, 240)) return okJson(EMPTY);
    return okJson(EMPTY);
  }
  const limited = rateLimit(`roadmap:nav:u:${result.principal.userId}`, 3600, 600);
  if (limited) return okJson(EMPTY);
  const company = result.principal.company;
  const [yourWork, status] = await Promise.all([
    hasPublishedCompanyWork(company.id),
    companyProgressStatus(company.id),
  ]);
  return okJson({ yourWork, percent: roadmapProgress(status).percent });
}
