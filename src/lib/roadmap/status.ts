// Derived roadmap step status (§5.18): one query bundle, nothing stored,
// nothing to invalidate. The hub runway, the step panels, and the stat strip
// all render from the ONE RoadmapStatus object so surfaces can never
// disagree.

import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { countGovernanceDocs, countPeople } from "@/lib/roadmap/db";

const W = schema.workSubmissions;

export type RoadmapStatus = {
  governance: { done: boolean; docs: number };
  directory: { done: boolean; people: number };
  work: { done: boolean; published: number };
  /** Never "done": a scorecard is ongoing. live = at least one builder. */
  scorecard: { live: boolean; contributors: number };
};

export async function roadmapStatus(companyId: string): Promise<RoadmapStatus> {
  const [docs, people, workRows] = await Promise.all([
    countGovernanceDocs(companyId),
    countPeople(companyId),
    db
      .select({
        published: sql<number>`count(*)::int`,
        contributors: sql<number>`count(distinct lower(${W.submitterEmail}))::int`,
      })
      .from(W)
      .where(and(eq(W.companyId, companyId), eq(W.status, "published"))),
  ]);
  const published = workRows[0]?.published ?? 0;
  const contributors = workRows[0]?.contributors ?? 0;
  return {
    governance: { done: docs >= 1, docs },
    directory: { done: people >= 1, people },
    work: { done: published >= 1, published },
    scorecard: { live: contributors >= 1, contributors },
  };
}
