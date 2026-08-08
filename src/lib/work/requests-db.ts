// DB access for the Requested Work board (§5.19). Every function takes the
// lane as a REQUIRED WorkScope-style param (scope.ts compile-error-if-missed
// pattern) and every transition is a single fenced statement: the WHERE
// re-derives the eligible state and the returned-row count is the verdict,
// so a same-row race always leaves the loser with zero rows (§5.18
// approval-flow rule). The two caps are single-statement guards; two truly
// concurrent requests can overshoot by one (accepted courtesy-cap residual,
// bounded by the per-user rate limits).

import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import type { WorkScope } from "./scope";
import {
  REQ_CAP_OPEN,
  REQ_LISTED,
  REQ_OPEN,
  REQ_WORKING,
  REQUEST_CAPS,
  type WorkRequestStatus,
} from "./requests-config";

const R = schema.workRequests;

export type WorkRequestRow = typeof R.$inferSelect;

/** §5.19 tenancy predicate (drizzle side). */
function laneWhere(scope: WorkScope) {
  return scope.companyId === null
    ? isNull(R.companyId)
    : eq(R.companyId, scope.companyId);
}

/** §5.19 tenancy predicate (raw-SQL side; the qualified column name is
 * written as literal text because embedded column refs render unqualified
 * inside subqueries - the drizzle trap documented at roadmap/db.ts). */
function laneSql(scope: WorkScope, col: string) {
  return scope.companyId === null
    ? sql.raw(`${col} IS NULL`)
    : sql`${sql.raw(col)} = ${scope.companyId}::uuid`;
}

function statusList(statuses: readonly string[]) {
  return sql.join(
    statuses.map((s) => sql`${s}`),
    sql.raw(", ")
  );
}

export type TransitionFailure = {
  ok: false;
  reason: "not_found" | "not_eligible" | "quota";
  /** Set for not_eligible: the row's actual status, for honest error copy. */
  status?: WorkRequestStatus;
};
export type TransitionResult = { ok: true } | TransitionFailure;

async function disambiguate(
  scope: WorkScope,
  id: string,
  expected: {
    statuses: readonly string[];
    quotaCount?: () => Promise<number>;
    quotaMax?: number;
  }
): Promise<TransitionFailure> {
  const row = await requestById(scope, id);
  if (!row) return { ok: false, reason: "not_found" };
  const status = row.status as WorkRequestStatus;
  if (!expected.statuses.includes(status) || (status === "approved" && row.developerEmail !== null && expected.statuses.includes("approved"))) {
    return { ok: false, reason: "not_eligible", status };
  }
  if (expected.quotaCount && expected.quotaMax !== undefined) {
    const n = await expected.quotaCount();
    if (n >= expected.quotaMax) return { ok: false, reason: "quota" };
  }
  // Fence lost to a race that has since reverted (rare): report honestly.
  return { ok: false, reason: "not_eligible", status };
}

export async function requestById(
  scope: WorkScope,
  id: string
): Promise<WorkRequestRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const rows = await db
    .select()
    .from(R)
    .where(and(eq(R.id, id), laneWhere(scope)))
    .limit(1);
  return rows[0] ?? null;
}

/** CREATE with the 5-open cap as a single-statement INSERT ... SELECT guard:
 * the insert fires only while the requester's open rows (pending, approved,
 * in_progress, done_pending) in this lane number under the cap. */
export async function createRequest(
  scope: WorkScope,
  opts: {
    userId: string;
    email: string;
    name: string | null;
    title: string;
    description: string;
    valueUsd: number;
    metrics: string[];
  }
): Promise<{ ok: true; id: string } | { ok: false; reason: "cap" }> {
  const email = opts.email.toLowerCase();
  const res = (await db.execute(sql`
    INSERT INTO work_requests
      (company_id, requester_user_id, requester_email, requester_name,
       title, description, value_usd, metrics_json)
    SELECT ${scope.companyId}, ${opts.userId}, ${email}, ${opts.name},
           ${opts.title}, ${opts.description}, ${opts.valueUsd},
           ${JSON.stringify(opts.metrics)}
    WHERE (SELECT count(*) FROM work_requests
           WHERE lower(requester_email) = ${email}
             AND ${laneSql(scope, "company_id")}
             AND status IN (${statusList(REQ_CAP_OPEN)}))
          < ${REQUEST_CAPS.openPerRequester}
    RETURNING id
  `)) as unknown as { id: string }[];
  return res.length === 1
    ? { ok: true, id: res[0].id }
    : { ok: false, reason: "cap" };
}

/** How many open (5-cap) requests this person has in the lane. */
export async function requesterOpenCount(
  scope: WorkScope,
  email: string
): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(R)
    .where(
      and(
        laneWhere(scope),
        sql`lower(${R.requesterEmail}) = ${email.toLowerCase()}`,
        inArray(R.status, [...REQ_CAP_OPEN])
      )
    );
  return rows[0]?.n ?? 0;
}

/** How many active (3-cap) claims this person holds in the lane. */
export async function developerActiveCount(
  scope: WorkScope,
  email: string
): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(R)
    .where(
      and(
        laneWhere(scope),
        sql`lower(${R.developerEmail}) = ${email.toLowerCase()}`,
        inArray(R.status, [...REQ_WORKING])
      )
    );
  return rows[0]?.n ?? 0;
}

/** CLAIM: one UPDATE fenced on (id, approved, unclaimed, lane) with the
 * 3-cap as a correlated subquery. done_pending counts toward the cap: the
 * row is still the developer's until validated, and admin send-back must
 * never be refusable. */
export async function claimRequest(
  scope: WorkScope,
  opts: { id: string; userId: string; email: string; name: string | null }
): Promise<TransitionResult> {
  if (!/^[0-9a-f-]{36}$/i.test(opts.id))
    return { ok: false, reason: "not_found" };
  const email = opts.email.toLowerCase();
  const res = (await db.execute(sql`
    UPDATE work_requests SET
      developer_user_id = ${opts.userId}, developer_email = ${email},
      developer_name = ${opts.name}, claimed_at = now(),
      status = 'in_progress', updated_at = now()
    WHERE id = ${opts.id}::uuid AND status = 'approved'
      AND developer_email IS NULL
      AND ${laneSql(scope, "company_id")}
      AND (SELECT count(*) FROM work_requests w2
           WHERE lower(w2.developer_email) = ${email}
             AND ${laneSql(scope, "w2.company_id")}
             AND w2.status IN (${statusList(REQ_WORKING)}))
          < ${REQUEST_CAPS.concurrentPerDeveloper}
    RETURNING id
  `)) as unknown as unknown[];
  if (res.length === 1) return { ok: true };
  return disambiguate(scope, opts.id, {
    statuses: ["approved"],
    quotaCount: () => developerActiveCount(scope, email),
    quotaMax: REQUEST_CAPS.concurrentPerDeveloper,
  });
}

/** APPROVE (lane admin): pending -> approved. */
export async function approveRequest(
  scope: WorkScope,
  id: string,
  adminEmail: string
): Promise<TransitionResult> {
  const rows = await db
    .update(R)
    .set({
      status: "approved",
      approvedAt: new Date(),
      approvedBy: adminEmail.toLowerCase(),
      updatedAt: new Date(),
    })
    .where(and(eq(R.id, id), eq(R.status, "pending"), laneWhere(scope)))
    .returning({ id: R.id });
  if (rows.length === 1) return { ok: true };
  return disambiguate(scope, id, { statuses: ["pending"] });
}

/** REJECT (lane admin): pending -> rejected, and ALSO approved-but-unclaimed
 * -> rejected (delist). The widening closes the 5-cap dead end: without it,
 * five approved rows nobody claims would lock their requester out forever
 * with no release transition for any actor. */
export async function rejectRequest(
  scope: WorkScope,
  id: string,
  adminEmail: string,
  reason: string | null
): Promise<TransitionResult> {
  const rows = await db
    .update(R)
    .set({
      status: "rejected",
      rejectedAt: new Date(),
      rejectReason: reason,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(R.id, id),
        inArray(R.status, ["pending", "approved"]),
        isNull(R.developerEmail),
        laneWhere(scope)
      )
    )
    .returning({ id: R.id });
  if (rows.length === 1) return { ok: true };
  return disambiguate(scope, id, { statuses: ["pending", "approved"] });
}

/** UNCLAIM: in_progress -> approved, clearing the developer fields. Self
 * variant requires the developer-email match; the admin variant omits it. */
export async function unclaimRequest(
  scope: WorkScope,
  id: string,
  actor: { selfEmail: string } | { admin: true }
): Promise<TransitionResult> {
  const fences = [eq(R.id, id), eq(R.status, "in_progress"), laneWhere(scope)];
  if ("selfEmail" in actor) {
    fences.push(
      sql`lower(${R.developerEmail}) = ${actor.selfEmail.toLowerCase()}`
    );
  }
  const rows = await db
    .update(R)
    .set({
      status: "approved",
      developerUserId: null,
      developerEmail: null,
      developerName: null,
      claimedAt: null,
      updatedAt: new Date(),
    })
    .where(and(...fences))
    .returning({ id: R.id });
  if (rows.length === 1) return { ok: true };
  return disambiguate(scope, id, { statuses: ["in_progress"] });
}

/** COMPLETE (developer only): in_progress -> done_pending. */
export async function completeRequest(
  scope: WorkScope,
  id: string,
  selfEmail: string
): Promise<TransitionResult> {
  const rows = await db
    .update(R)
    .set({
      status: "done_pending",
      markedCompleteAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(R.id, id),
        eq(R.status, "in_progress"),
        sql`lower(${R.developerEmail}) = ${selfEmail.toLowerCase()}`,
        laneWhere(scope)
      )
    )
    .returning({ id: R.id });
  if (rows.length === 1) return { ok: true };
  return disambiguate(scope, id, { statuses: ["in_progress"] });
}

/** VALIDATE (lane admin): done_pending -> completed. Developer fields are
 * retained for scorecard attribution. */
export async function validateRequest(
  scope: WorkScope,
  id: string,
  adminEmail: string
): Promise<TransitionResult> {
  const rows = await db
    .update(R)
    .set({
      status: "completed",
      completedAt: new Date(),
      validatedBy: adminEmail.toLowerCase(),
      updatedAt: new Date(),
    })
    .where(and(eq(R.id, id), eq(R.status, "done_pending"), laneWhere(scope)))
    .returning({ id: R.id });
  if (rows.length === 1) return { ok: true };
  return disambiguate(scope, id, { statuses: ["done_pending"] });
}

/** SEND BACK (lane admin): done_pending -> in_progress. */
export async function sendBackRequest(
  scope: WorkScope,
  id: string
): Promise<TransitionResult> {
  const rows = await db
    .update(R)
    .set({
      status: "in_progress",
      markedCompleteAt: null,
      updatedAt: new Date(),
    })
    .where(and(eq(R.id, id), eq(R.status, "done_pending"), laneWhere(scope)))
    .returning({ id: R.id });
  if (rows.length === 1) return { ok: true };
  return disambiguate(scope, id, { statuses: ["done_pending"] });
}

/** CANCEL (requester only): hard DELETE of a still-pending row. Pending rows
 * are private, so there is nothing to audit. */
export async function cancelRequest(
  scope: WorkScope,
  id: string,
  selfEmail: string
): Promise<TransitionResult> {
  const rows = await db
    .delete(R)
    .where(
      and(
        eq(R.id, id),
        eq(R.status, "pending"),
        sql`lower(${R.requesterEmail}) = ${selfEmail.toLowerCase()}`,
        laneWhere(scope)
      )
    )
    .returning({ id: R.id });
  if (rows.length === 1) return { ok: true };
  // Someone else's PENDING row must stay invisible (pending rows are
  // private), so a non-owner cancel reads as not_found, never as a status
  // readout.
  const row = await requestById(scope, id);
  if (
    !row ||
    (row.status === "pending" &&
      row.requesterEmail.toLowerCase() !== selfEmail.toLowerCase())
  ) {
    return { ok: false, reason: "not_found" };
  }
  return {
    ok: false,
    reason: "not_eligible",
    status: row.status as WorkRequestStatus,
  };
}

// ---- Lists (all narrow-purpose, all capped at REQUEST_CAPS.listMax) ----

/** The lane board every member sees: listed statuses only (pending and
 * rejected NEVER appear here), open rows before completed, newest first. */
export async function boardList(scope: WorkScope): Promise<WorkRequestRow[]> {
  return db
    .select()
    .from(R)
    .where(and(laneWhere(scope), inArray(R.status, [...REQ_LISTED])))
    .orderBy(
      sql`CASE WHEN ${R.status} = 'completed' THEN 1 ELSE 0 END`,
      desc(R.createdAt)
    )
    .limit(REQUEST_CAPS.listMax);
}

/** The requester's own rows, every status (their private surface). */
export async function mineList(
  scope: WorkScope,
  email: string
): Promise<WorkRequestRow[]> {
  return db
    .select()
    .from(R)
    .where(
      and(laneWhere(scope), sql`lower(${R.requesterEmail}) = ${email.toLowerCase()}`)
    )
    .orderBy(desc(R.createdAt))
    .limit(REQUEST_CAPS.listMax);
}

/** Admin queue: requests awaiting approval, oldest first. */
export async function pendingQueue(scope: WorkScope): Promise<WorkRequestRow[]> {
  return db
    .select()
    .from(R)
    .where(and(laneWhere(scope), eq(R.status, "pending")))
    .orderBy(R.createdAt)
    .limit(REQUEST_CAPS.listMax);
}

// (No separate validation queue: done_pending rows ride the board with the
// admin's Validate/Send back actions.)

// ---- Aggregates (hub cards, scorecard) ----

export type RequestStatusCounts = {
  /** Ever-approved rows (listed universe). Monotonic-ish: the hub card and
   * runway light off this, so finishing work never un-lights a step. */
  listed: number;
  /** approved + in_progress + done_pending. */
  open: number;
  completed: number;
};

/** One grouped aggregate for the hub cards (both lanes). NEVER exposes
 * pending/rejected counts: a lane-wide pending tally would let any member
 * infer a colleague's unapproved request at a small company. */
export async function requestStatusCounts(
  scope: WorkScope
): Promise<RequestStatusCounts> {
  const rows = await db
    .select({
      listed: sql<number>`count(*) filter (where ${R.status} in (${statusList(REQ_LISTED)}))::int`,
      open: sql<number>`count(*) filter (where ${R.status} in (${statusList(REQ_OPEN)}))::int`,
      completed: sql<number>`count(*) filter (where ${R.status} = 'completed')::int`,
    })
    .from(R)
    .where(laneWhere(scope));
  return rows[0] ?? { listed: 0, open: 0, completed: 0 };
}

export type RequestCounts = {
  requested: number;
  working: number;
  completed: number;
};

/** Per-person counts for the scorecard columns, lane-scoped. Requested
 * counts LISTED statuses only (a colleague's pending or rejected request is
 * invisible); Working On is exactly the 3-cap predicate; Completed credits
 * the developer. */
export async function requestCountsByEmail(
  scope: WorkScope
): Promise<Map<string, RequestCounts>> {
  const requested = await db
    .select({
      email: sql<string>`lower(${R.requesterEmail})`,
      n: sql<number>`count(*)::int`,
    })
    .from(R)
    .where(and(laneWhere(scope), inArray(R.status, [...REQ_LISTED])))
    .groupBy(sql`lower(${R.requesterEmail})`);
  const developed = await db
    .select({
      email: sql<string>`lower(${R.developerEmail})`,
      working: sql<number>`count(*) filter (where ${R.status} in (${statusList(REQ_WORKING)}))::int`,
      completed: sql<number>`count(*) filter (where ${R.status} = 'completed')::int`,
    })
    .from(R)
    .where(
      and(
        laneWhere(scope),
        isNotNull(R.developerEmail),
        inArray(R.status, ["in_progress", "done_pending", "completed"])
      )
    )
    .groupBy(sql`lower(${R.developerEmail})`);
  const out = new Map<string, RequestCounts>();
  for (const r of requested)
    out.set(r.email, { requested: r.n, working: 0, completed: 0 });
  for (const d of developed) {
    const row = out.get(d.email) ?? { requested: 0, working: 0, completed: 0 };
    row.working = d.working;
    row.completed = d.completed;
    out.set(d.email, row);
  }
  return out;
}

export type ScorecardRequestListRow = {
  id: string;
  title: string;
  status: string;
  valueUsd: number;
  requesterName: string | null;
  requesterEmail: string;
  developerName: string | null;
  developerEmail: string | null;
  approvedAt: Date | null;
  claimedAt: Date | null;
  completedAt: Date | null;
};

/** Click-through list behind a scorecard cell. Shares the REQ_* status sets
 * with requestCountsByEmail so a cell count and its page can never disagree
 * (modulo the listMax cap, which the page discloses). Narrow projection:
 * description and metrics never leave the row here. */
export async function scorecardRequestList(
  scope: WorkScope,
  person: string,
  col: "requested" | "working" | "completed"
): Promise<ScorecardRequestListRow[]> {
  const email = person.toLowerCase();
  const projection = {
    id: R.id,
    title: R.title,
    status: R.status,
    valueUsd: R.valueUsd,
    requesterName: R.requesterName,
    requesterEmail: R.requesterEmail,
    developerName: R.developerName,
    developerEmail: R.developerEmail,
    approvedAt: R.approvedAt,
    claimedAt: R.claimedAt,
    completedAt: R.completedAt,
  };
  const where =
    col === "requested"
      ? and(
          laneWhere(scope),
          sql`lower(${R.requesterEmail}) = ${email}`,
          inArray(R.status, [...REQ_LISTED])
        )
      : col === "working"
        ? and(
            laneWhere(scope),
            sql`lower(${R.developerEmail}) = ${email}`,
            inArray(R.status, [...REQ_WORKING])
          )
        : and(
            laneWhere(scope),
            sql`lower(${R.developerEmail}) = ${email}`,
            eq(R.status, "completed")
          );
  const order =
    col === "requested"
      ? desc(R.approvedAt)
      : col === "working"
        ? desc(R.claimedAt)
        : desc(R.completedAt);
  return db
    .select(projection)
    .from(R)
    .where(where)
    .orderBy(order)
    .limit(REQUEST_CAPS.listMax);
}
