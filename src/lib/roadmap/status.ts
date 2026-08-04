// Derived roadmap step status (§5.18): one query bundle, nothing stored,
// nothing to invalidate. The hub runway, the step panels, and the stat strip
// all render from the ONE RoadmapStatus object so surfaces can never
// disagree.

import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { apolloImportStamp, countGovernanceDocs, countPeople } from "@/lib/roadmap/db";
import { checkDkim, type DkimCheck } from "@/lib/roadmap/dkim";

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
  /** Never "done": a scorecard is ongoing. live = at least one builder. */
  scorecard: { live: boolean; contributors: number };
  /** Step 05 verdict (§5.18 round 2): the DNS-visible DKIM state for the
   * company's email domain. Budget-bounded so the hub render never blocks on
   * slow DNS; a timed-out check degrades to verdict "unknown". */
  dkim: DkimCheck;
};

export async function roadmapStatus(
  companyId: string,
  domain: string
): Promise<RoadmapStatus> {
  // checkDkim rides the SAME Promise.all so the DNS probe overlaps the DB
  // queries instead of adding to the render's critical path.
  const [docs, people, importStamp, workRows, dkim] = await Promise.all([
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
    checkDkim(domain, { budgetMs: 800 }),
  ]);
  const published = workRows[0]?.published ?? 0;
  const contributors = workRows[0]?.contributors ?? 0;
  return {
    governance: { done: docs >= 1, docs },
    directory: { done: people >= 1, people, everImported: importStamp !== null },
    work: { done: published >= 1, published },
    scorecard: { live: contributors >= 1, contributors },
    dkim,
  };
}
