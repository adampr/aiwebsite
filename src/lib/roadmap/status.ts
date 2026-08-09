// Derived roadmap step status (§5.18): one query bundle, nothing stored,
// nothing to invalidate. The hub runway, the step panels, and the stat strip
// all render from the ONE RoadmapStatus object so surfaces can never
// disagree.

import { and, eq, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import {
  STAFF_DIRECTORY_SCOPE,
  STAFF_LINK_SCOPE,
  apolloImportStamp,
  countGovernanceDocs,
  countPeople,
  listRoadmapLinks,
} from "@/lib/roadmap/db";
import { platformView } from "@/lib/roadmap/platform";
import type { ProgressStatus } from "@/lib/roadmap/progress";
import { checkDkim, type DkimCheck } from "@/lib/roadmap/dkim";
import { requestStatusCounts } from "@/lib/work/requests-db";

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
  /** Step 09 (§5.20). The ONE partial-capable step: two independent
   * components, either alone earns half. `partial` means exactly one is
   * confirmed, so it is never true at the same time as `done`. */
  secure: {
    done: boolean;
    partial: boolean;
    apiProxy: boolean;
    devVms: boolean;
    /** Something is saved that is not counting yet, so the card can say so
     * instead of reading as untouched. */
    savedUnverified: boolean;
  };
  /** Step 10 (§5.20). */
  data: { done: boolean; savedUnverified: boolean };
  /** Step 11 (§5.20). counted = tools whose link AND instructions are
   * confirmed; total = tools listed, confirmed or not. */
  tools: { done: boolean; counted: number; total: number };
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
  const [docs, people, importStamp, workRows, requests, dkim, links] =
    await Promise.all([
      countGovernanceDocs(companyId),
      countPeople({ companyId }),
      apolloImportStamp({ companyId }),
      db
        .select({
          published: sql<number>`count(*)::int`,
          contributors: sql<number>`count(distinct lower(${W.submitterEmail}))::int`,
        })
        .from(W)
        .where(and(eq(W.companyId, companyId), eq(W.status, "published"))),
      requestStatusCounts({ companyId }),
      checkDkim(domain, { budgetMs: 800 }),
      // §5.20: ONE indexed read of the whole link set, riding the SAME
      // Promise.all. It must never trigger a reachability check: a page
      // render that awaits a stranger's server is a self-inflicted outage,
      // so checks only ever run from an explicit POST.
      listRoadmapLinks({ companyId }),
    ]);
  const published = workRows[0]?.published ?? 0;
  const contributors = workRows[0]?.contributors ?? 0;
  const platform = platformView(links);
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
    ...platformStatus(platform),
    dkim,
  };
}

/** The §5.20 slice of both status bundles, built once so the company hub
 * and the staff hub can never define these steps differently. */
function platformStatus(p: ReturnType<typeof platformView>) {
  return {
    secure: {
      done: p.secure.done,
      partial: p.secure.partial,
      apiProxy: p.secure.apiProxy.enabled,
      devVms: p.secure.devVms.enabled,
      savedUnverified:
        (p.secure.apiProxy.saved && !p.secure.apiProxy.enabled) ||
        (p.secure.devVms.saved && !p.secure.devVms.enabled),
    },
    data: {
      done: p.data.done,
      savedUnverified: p.data.lakehouse.saved && !p.data.lakehouse.enabled,
    },
    tools: {
      done: p.tools.done,
      counted: p.tools.counted,
      total: p.tools.total,
    },
  };
}

/**
 * The percentage-only bundle (§5.20), for the SITE-WIDE nav badge.
 *
 * WHY THIS EXISTS RATHER THAN CALLING roadmapStatus: the badge renders on
 * EVERY page for every signed-in company user, and roadmapStatus carries a
 * DNS probe (checkDkim) plus the Apollo stamp read, neither of which the
 * percentage uses. Reusing it would have put outbound DNS on the critical
 * path of every page view on the site to save a few lines here. Same
 * queries, minus the two the number does not need.
 *
 * The return type is structural (ProgressStatus), so it and the full
 * RoadmapStatus are interchangeable at roadmapProgress and cannot drift
 * into two different definitions of "done".
 */
export async function companyProgressStatus(
  companyId: string
): Promise<ProgressStatus> {
  const [docs, people, workRows, requests, links] = await Promise.all([
    countGovernanceDocs(companyId),
    countPeople({ companyId }),
    db
      .select({
        published: sql<number>`count(*)::int`,
        contributors: sql<number>`count(distinct lower(${W.submitterEmail}))::int`,
      })
      .from(W)
      .where(and(eq(W.companyId, companyId), eq(W.status, "published"))),
    requestStatusCounts({ companyId }),
    listRoadmapLinks({ companyId }),
  ]);
  const published = workRows[0]?.published ?? 0;
  const contributors = workRows[0]?.contributors ?? 0;
  return {
    governance: { done: docs >= 1 },
    directory: { done: people >= 1 },
    work: { done: published >= 1 },
    request: { done: requests.listed >= 1 },
    requested: { live: requests.listed >= 1 },
    scorecard: { live: contributors >= 1 },
    ...platformStatus(platformView(links)),
  };
}

/** The staff hub/shell status bundle (§5.18 staff parity): mirrors
 * RoadmapStatus field names minus dkim, so it satisfies the runway's
 * structural RunwayStatus input and both hubs read identical booleans.
 * Cheap: indexed aggregates plus the NULL-lane directory count and the
 * one-row staff Apollo stamp; no DNS probe (the field does not exist on
 * this shape, so no surface can ever render a fake DKIM verdict). The
 * request counts come from the SAME requestStatusCounts as the company
 * cards so the two hubs can never define "open" differently. */
export type StaffRoadmapStatus = {
  /** Constant: XL.net's governance is its public offering (the Governance
   * Builder plus the published AUP); xl.net can never be a companies row,
   * so there is nothing to count and nothing to un-done. If a future round
   * files real staff governance docs, flip this to a computed count without
   * touching the runway. */
  governance: { done: true };
  directory: { done: boolean; people: number; everImported: boolean };
  work: { done: boolean; published: number };
  request: { done: boolean; listed: number };
  requested: { live: boolean; open: number; completed: number };
  scorecard: { live: boolean; contributors: number };
  /** §5.20 on the NULL-company_id staff lane: XL.net configures its own
   * builder platform through the same pages, so these are computed, never
   * constant-done like governance. */
  secure: {
    done: boolean;
    partial: boolean;
    apiProxy: boolean;
    devVms: boolean;
    savedUnverified: boolean;
  };
  data: { done: boolean; savedUnverified: boolean };
  tools: { done: boolean; counted: number; total: number };
};

export async function staffRoadmapStatus(): Promise<StaffRoadmapStatus> {
  const [people, importStamp, workRows, requests, links] = await Promise.all([
    countPeople(STAFF_DIRECTORY_SCOPE),
    apolloImportStamp(STAFF_DIRECTORY_SCOPE),
    db
      .select({
        published: sql<number>`count(*)::int`,
        contributors: sql<number>`count(distinct lower(${W.submitterEmail}))::int`,
      })
      .from(W)
      .where(and(isNull(W.companyId), eq(W.status, "published"))),
    requestStatusCounts({ companyId: null }),
    listRoadmapLinks(STAFF_LINK_SCOPE),
  ]);
  const published = workRows[0]?.published ?? 0;
  const contributors = workRows[0]?.contributors ?? 0;
  const platform = platformView(links);
  return {
    governance: { done: true },
    directory: {
      done: people >= 1,
      people,
      everImported: importStamp !== null,
    },
    work: { done: published >= 1, published },
    request: { done: requests.listed >= 1, listed: requests.listed },
    requested: {
      live: requests.listed >= 1,
      open: requests.open,
      completed: requests.completed,
    },
    scorecard: { live: contributors >= 1, contributors },
    ...platformStatus(platform),
  };
}
