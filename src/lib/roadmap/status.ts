// Derived roadmap step status (§5.18): one query bundle, nothing stored,
// nothing to invalidate. The hub runway, the step panels, and the stat strip
// all render from the ONE RoadmapStatus object so surfaces can never
// disagree.

import { and, eq, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { apolloImportStamp, countGovernanceDocs, countPeople } from "@/lib/roadmap/db";
import { checkDkim, type DkimCheck } from "@/lib/roadmap/dkim";
import {
  requestStatusCounts,
  type RequestStatusCounts,
} from "@/lib/work/requests-db";

const W = schema.workSubmissions;

export type RoadmapStatus = {
  governance: { done: boolean; docs: number };
  directory: {
    done: boolean;
    people: number;
    /** companies.apollo_last_import_at is stamped on every COMPLETE Apollo
     * run including zero-result runs, so it doubles as the durable
     * never-auto-kick-again flag (round 3). */
    everImported: boolean;
  };
  work: { done: boolean; published: number };
  /** Step 05 (§5.19). done/listed count EVER-APPROVED requests only:
   * monotonic (finishing work never un-lights the step) and privacy-safe (a
   * lane-wide pending tally would let any member infer a colleague's
   * unapproved request at a small company; pending/rejected rows surface
   * only to their requester and the lane admin). */
  request: { done: boolean; listed: number };
  /** Step 06 (§5.19). live keys off the same listed count; open = approved +
   * in_progress + done_pending. */
  requested: { live: boolean; open: number; completed: number };
  /** Never "done": a scorecard is ongoing. live = at least one builder. */
  scorecard: { live: boolean; contributors: number };
  /** The DNS-visible DKIM state for the company's email domain (§5.18
   * round 2). No longer a step of its own: it is the prerequisite for the
   * email lane of step 04, echoed as one line on the hub's work card and
   * rendered in full by the DkimStep island on /roadmap/work, which calls
   * checkDkim itself and shares this result through the module's in-memory
   * cache (10 min for a real verdict, 60s for a dns-error). Budget-bounded
   * so the hub render never blocks on slow DNS; a timed-out check degrades
   * to verdict "unknown". */
  dkim: DkimCheck;
};

export async function roadmapStatus(
  companyId: string,
  domain: string
): Promise<RoadmapStatus> {
  // checkDkim rides the SAME Promise.all so the DNS probe overlaps the DB
  // queries instead of adding to the render's critical path.
  const [docs, people, importStamp, workRows, requests, dkim] =
    await Promise.all([
      countGovernanceDocs(companyId),
      countPeople(companyId),
      apolloImportStamp(companyId),
      db
        .select({
          published: sql<number>`count(*)::int`,
          contributors: sql<number>`count(distinct lower(${W.submitterEmail}))::int`,
        })
        .from(W)
        .where(and(eq(W.companyId, companyId), eq(W.status, "published"))),
      requestStatusCounts({ companyId }),
      checkDkim(domain, { budgetMs: 800 }),
    ]);
  const published = workRows[0]?.published ?? 0;
  const contributors = workRows[0]?.contributors ?? 0;
  return {
    governance: { done: docs >= 1, docs },
    directory: { done: people >= 1, people, everImported: importStamp !== null },
    work: { done: published >= 1, published },
    request: { done: requests.listed >= 1, listed: requests.listed },
    requested: {
      live: requests.listed >= 1,
      open: requests.open,
      completed: requests.completed,
    },
    scorecard: { live: contributors >= 1, contributors },
    dkim,
  };
}

/** The staff hub's cheap internal-lane status bundle (§5.18 unification):
 * two indexed aggregates, no DNS probe, no company row. The request counts
 * come from the SAME requestStatusCounts as the company cards so the two
 * hubs can never define "open" differently. */
export type StaffRoadmapStatus = {
  work: { published: number };
  scorecard: { contributors: number };
  requests: RequestStatusCounts;
};

export async function staffRoadmapStatus(): Promise<StaffRoadmapStatus> {
  const [workRows, requests] = await Promise.all([
    db
      .select({
        published: sql<number>`count(*)::int`,
        contributors: sql<number>`count(distinct lower(${W.submitterEmail}))::int`,
      })
      .from(W)
      .where(and(isNull(W.companyId), eq(W.status, "published"))),
    requestStatusCounts({ companyId: null }),
  ]);
  return {
    work: { published: workRows[0]?.published ?? 0 },
    scorecard: { contributors: workRows[0]?.contributors ?? 0 },
    requests,
  };
}
