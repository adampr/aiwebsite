// Governance DB layer (§5.12). Every mutation binds the owner into its WHERE
// clause (no read-then-write authz), every read folds in the 30-day retention
// filter (a dead timer must never surface expired data to its owner), and the
// research claim is one conditional UPDATE whose concurrency check is atomic.

import fs from "node:fs";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import type {
  GovernanceDoc,
  GovernanceKind,
  NextQuestion,
  ProjectStatus,
  ResearchBrief,
  ResearchProgress,
  TranscriptEntry,
} from "./types";
import { CAPS, RETENTION_DAYS } from "./config";
import { normalizeBrief } from "./research";

const P = schema.governanceProjects;
const U = schema.governanceUsage;
const M = schema.governanceMeta;

export type ProjectRow = typeof P.$inferSelect;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

export function retentionCutoff(): Date {
  return new Date(Date.now() - RETENTION_DAYS * 86_400_000);
}

export function deletesAt(lastActivityAt: Date): string {
  return new Date(
    lastActivityAt.getTime() + RETENTION_DAYS * 86_400_000
  ).toISOString();
}

/** Fresh deploy marker = setup-vm.sh is running; defer spawns/claims. */
export function deployInProgress(): boolean {
  try {
    const stat = fs.statSync("/var/run/aiwebsite-deploy-in-progress");
    return Date.now() - stat.mtimeMs < 1_800_000;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Reads (owner + retention folded in)
 * ------------------------------------------------------------------ */

export async function fetchOwnedProject(
  userId: string,
  id: string
): Promise<ProjectRow | null> {
  if (!isUuid(id)) return null;
  const rows = await db
    .select()
    .from(P)
    .where(
      and(eq(P.id, id), eq(P.userId, userId), gte(P.lastActivityAt, retentionCutoff()))
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function listOwnedProjects(userId: string): Promise<ProjectRow[]> {
  return db
    .select()
    .from(P)
    .where(and(eq(P.userId, userId), gte(P.lastActivityAt, retentionCutoff())))
    .orderBy(desc(P.lastActivityAt));
}

export async function countActiveProjects(userId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(P)
    .where(
      and(
        eq(P.userId, userId),
        gte(P.lastActivityAt, retentionCutoff()),
        sql`${P.status} <> 'done'`
      )
    );
  return rows[0]?.n ?? 0;
}

export async function countCreatedToday(userId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(P)
    .where(
      and(eq(P.userId, userId), sql`${P.createdAt} >= date_trunc('day', now())`)
    );
  return rows[0]?.n ?? 0;
}

/* ------------------------------------------------------------------ *
 * Create / delete / touch
 * ------------------------------------------------------------------ */

export async function createProject(opts: {
  userId: string;
  kind: GovernanceKind;
  domain: string;
  documents: GovernanceDoc[];
}): Promise<string> {
  const rows = await db
    .insert(P)
    .values({
      userId: opts.userId,
      kind: opts.kind,
      domain: opts.domain,
      status: "created",
      documentsJson: JSON.stringify(opts.documents),
    })
    .returning({ id: P.id });
  return rows[0].id;
}

export async function deleteOwnedProject(
  userId: string,
  id: string
): Promise<boolean> {
  if (!isUuid(id)) return false;
  const rows = await db
    .delete(P)
    .where(and(eq(P.id, id), eq(P.userId, userId)))
    .returning({ id: P.id });
  return rows.length > 0;
}

export async function touchActivity(id: string): Promise<void> {
  await db
    .update(P)
    .set({ lastActivityAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(P.id, id));
}

/** Set (or replace) the uploaded sample policy. Owner + retention bound into
 * the WHERE; final projects are locked. An upload is user activity. */
export async function setStyleSample(opts: {
  userId: string;
  id: string;
  name: string;
  text: string;
  flagged: boolean;
}): Promise<boolean> {
  if (!isUuid(opts.id)) return false;
  const rows = await db
    .update(P)
    .set({
      styleSampleName: opts.name,
      styleSampleText: opts.text,
      researchFlagged: sql`research_flagged OR ${opts.flagged}`,
      lastActivityAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(P.id, opts.id),
        eq(P.userId, opts.userId),
        gte(P.lastActivityAt, retentionCutoff()),
        sql`${P.status} <> 'done'`
      )
    )
    .returning({ id: P.id });
  return rows.length > 0;
}

/** Remove the sample. Works in any status, and (like project DELETE, unlike
 * every read) without the retention filter: removing user data always works,
 * even from an expired-but-unswept row. */
export async function clearStyleSample(
  userId: string,
  id: string
): Promise<boolean> {
  if (!isUuid(id)) return false;
  const rows = await db
    .update(P)
    .set({
      styleSampleName: null,
      styleSampleText: null,
      updatedAt: sql`now()`,
    })
    .where(and(eq(P.id, id), eq(P.userId, userId)))
    .returning({ id: P.id });
  return rows.length > 0;
}

/** Bounded global sweep, run opportunistically from list/create (§10):
 * expired rows of ANY user are removed even if the daily timer is dead. */
export async function sweepExpiredGlobal(limit = 25): Promise<number> {
  const rows = await db
    .delete(P)
    .where(
      sql`${P.id} IN (SELECT id FROM ${P} WHERE ${P.lastActivityAt} < ${retentionCutoff().toISOString()} LIMIT ${limit})`
    )
    .returning({ id: P.id });
  return rows.length;
}

/* ------------------------------------------------------------------ *
 * Research claim / progress / handoff
 * ------------------------------------------------------------------ */

/**
 * Atomic research claim. Enforces, in ONE statement: ownership (when a user
 * claims), claimable status (fresh rows, failed rows, queued rows, or stale
 * researching rows whose heartbeat is >5 min old), the per-day run cap, and
 * the global concurrency cap (subquery count — no TOCTOU window). Touches
 * last_activity_at (a claim is user activity; the sweeper must not race it).
 */
export async function claimResearch(
  id: string,
  userId: string | null
): Promise<boolean> {
  if (!isUuid(id)) return false;
  const owner = userId ? sql` AND user_id = ${userId}` : sql``;
  const res = await db.execute(sql`
    UPDATE governance_projects SET
      status = 'researching',
      research_started_at = now(),
      research_heartbeat_at = now(),
      research_runs = CASE WHEN research_runs_date = CURRENT_DATE THEN research_runs + 1 ELSE 1 END,
      research_runs_date = CURRENT_DATE,
      last_activity_at = now(),
      updated_at = now()
    WHERE id = ${id}${owner}
      AND last_activity_at >= ${retentionCutoff().toISOString()}
      AND (
        status IN ('created','queued','research_failed')
        OR (status = 'researching' AND research_heartbeat_at < now() - interval '5 minutes')
      )
      AND (CASE WHEN research_runs_date = CURRENT_DATE THEN research_runs ELSE 0 END)
          < ${CAPS.researchRunsPerProjectPerDay}
      AND (SELECT count(*) FROM governance_projects
            WHERE status = 'researching'
              AND research_heartbeat_at > now() - interval '5 minutes'
              AND id <> ${id})
          < ${CAPS.concurrentResearchJobs}
    RETURNING id
  `);
  return (res as unknown as unknown[]).length > 0;
}

export async function heartbeatResearch(
  id: string,
  progress: ResearchProgress
): Promise<boolean> {
  const rows = await db
    .update(P)
    .set({
      researchHeartbeatAt: sql`now()`,
      researchProgressJson: JSON.stringify(progress),
      updatedAt: sql`now()`,
    })
    .where(and(eq(P.id, id), eq(P.status, "researching")))
    .returning({ id: P.id });
  return rows.length > 0;
}

export async function setResearchOutcome(
  id: string,
  outcome:
    | { status: "research_failed"; progress: ResearchProgress }
    | { status: "queued" }
): Promise<void> {
  if (outcome.status === "research_failed") {
    await db
      .update(P)
      .set({
        status: "research_failed",
        researchProgressJson: JSON.stringify(outcome.progress),
        updatedAt: sql`now()`,
      })
      .where(and(eq(P.id, id), eq(P.status, "researching")));
  } else {
    await db
      .update(P)
      .set({ status: "queued", updatedAt: sql`now()` })
      .where(and(eq(P.id, id), eq(P.status, "researching")));
  }
}

/** The research job's single final write (no answer-path race afterwards). */
export async function handoffToDrafting(opts: {
  id: string;
  brief: ResearchBrief;
  flagged: boolean;
  documents: GovernanceDoc[];
  nextQuestion: NextQuestion;
  changedSections: Record<string, string[]>;
}): Promise<void> {
  await db
    .update(P)
    .set({
      status: "drafting",
      researchJson: JSON.stringify(opts.brief),
      // OR, never overwrite: a sample upload during research may already
      // have set the flag (same pattern as applyTurnWrite/setStyleSample).
      researchFlagged: sql`research_flagged OR ${opts.flagged}`,
      documentsJson: JSON.stringify(opts.documents),
      nextQuestionJson: JSON.stringify(opts.nextQuestion),
      changedSectionsJson: JSON.stringify(opts.changedSections),
      researchProgressJson: null,
      rev: sql`rev + 1`,
      lastActivityAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(P.id, opts.id), eq(P.status, "researching")));
}

/** Script-context row fetch (no owner filter — the id came from a claim). */
export async function fetchProjectForScript(
  id: string
): Promise<ProjectRow | null> {
  if (!isUuid(id)) return null;
  const rows = await db.select().from(P).where(eq(P.id, id)).limit(1);
  return rows[0] ?? null;
}

/** Project owner's sign-in email (admin budget exemption); null if gone. */
export async function ownerEmailForProject(id: string): Promise<string | null> {
  if (!isUuid(id)) return null;
  const rows = await db
    .select({ email: schema.users.email })
    .from(P)
    .innerJoin(schema.users, eq(P.userId, schema.users.id))
    .where(eq(P.id, id))
    .limit(1);
  return rows[0]?.email ?? null;
}

/** 30-day research-brief reuse: newest same-user+domain distilled brief. */
export async function latestBriefForDomain(
  userId: string,
  domain: string,
  excludeId: string,
  kind?: GovernanceKind
): Promise<ResearchBrief | null> {
  const rows = await db
    .select({ researchJson: P.researchJson })
    .from(P)
    .where(
      and(
        eq(P.userId, userId),
        eq(P.domain, domain),
        sql`${P.id} <> ${excludeId}`,
        sql`${P.researchJson} IS NOT NULL`
      )
    )
    .orderBy(desc(P.updatedAt))
    .limit(3);
  const valid: ResearchBrief[] = [];
  for (const r of rows) {
    try {
      const brief = normalizeBrief(JSON.parse(r.researchJson!));
      if (
        brief &&
        Date.now() - Date.parse(brief.distilledAt) < 30 * 86_400_000 &&
        !brief.gaps.includes("research_failed")
      )
        valid.push(brief);
    } catch {
      // skip corrupt
    }
  }
  // Prefer a brief already probed for this kind (saves the probe top-up);
  // otherwise the freshest valid brief wins, exactly as before.
  if (kind) {
    const probed = valid.find((b) => b.probedKind === kind);
    if (probed) return probed;
  }
  if (valid.length) return valid[0];
  return null;
}

/** Queued rows eligible for a kick (used by the daily timer). */
export async function listQueuedProjects(limit = 2): Promise<string[]> {
  const rows = await db
    .select({ id: P.id })
    .from(P)
    .where(
      and(eq(P.status, "queued"), gte(P.lastActivityAt, retentionCutoff()))
    )
    .orderBy(P.updatedAt)
    .limit(limit);
  return rows.map((r) => r.id);
}

/* ------------------------------------------------------------------ *
 * Answer-turn claim / apply / fail (§5.12 async turn)
 * ------------------------------------------------------------------ */

/**
 * Atomic answer-turn claim, ONE conditional UPDATE (the claimResearch
 * pattern): ownership, retention, turn-taking status, the expected rev, and
 * claimability. Claimable = no turn record, a failed record (started_at
 * NULL), or a running claim past the staleness horizon (orphaned by a
 * restart) — the reap is this overwrite. attemptId is the per-claim fence
 * nonce for every later worker write; promptId is stored so polls and
 * duplicate POSTs can recognize the turn (it is NOT a fence — user retries
 * reuse it by design).
 */
export async function claimTurn(opts: {
  id: string;
  userId: string;
  expectedRev: number;
  promptId: string;
  attemptId: string;
  questionId: string;
}): Promise<boolean> {
  if (!isUuid(opts.id)) return false;
  const runningJson = JSON.stringify({ questionId: opts.questionId });
  const res = await db.execute(sql`
    UPDATE governance_projects SET
      turn_prompt_id = ${opts.promptId},
      turn_attempt_id = ${opts.attemptId},
      turn_started_at = now(),
      turn_json = ${runningJson},
      last_activity_at = now(),
      updated_at = now()
    WHERE id = ${opts.id} AND user_id = ${opts.userId}
      AND last_activity_at >= ${retentionCutoff().toISOString()}
      AND status IN ('drafting','review')
      AND rev = ${opts.expectedRev}
      AND (turn_prompt_id IS NULL
           OR turn_started_at IS NULL
           OR turn_started_at < now() - make_interval(secs => ${CAPS.turnStaleMs / 1000}))
    RETURNING id
  `);
  return (res as unknown as unknown[]).length > 0;
}

/**
 * Record a turn failure and release the claim (started_at NULL = claimable
 * immediately; the error rides turn_json for the poll). Fenced on the
 * attempt nonce: a reaped zombie cannot stomp a successor's claim.
 */
export async function failTurn(
  id: string,
  attemptId: string,
  error: { code: string; message: string; retriable?: boolean }
): Promise<void> {
  if (!isUuid(id)) return;
  const rows = await db
    .select({ turnJson: P.turnJson })
    .from(P)
    .where(and(eq(P.id, id), eq(P.turnAttemptId, attemptId)))
    .limit(1);
  if (!rows.length) return;
  let questionId = "";
  try {
    const parsed = JSON.parse(rows[0].turnJson ?? "{}") as {
      questionId?: unknown;
    };
    if (typeof parsed.questionId === "string") questionId = parsed.questionId;
  } catch {
    // corrupt running record: fail with an empty questionId
  }
  await db
    .update(P)
    .set({
      turnStartedAt: null,
      turnJson: JSON.stringify({
        questionId,
        error,
        failedAt: new Date().toISOString(),
      }),
      updatedAt: sql`now()`,
    })
    .where(and(eq(P.id, id), eq(P.turnAttemptId, attemptId)));
}

/* ------------------------------------------------------------------ *
 * Turn apply (single transactional write per turn)
 * ------------------------------------------------------------------ */

export async function applyTurnWrite(opts: {
  id: string;
  userId: string;
  expectedRev: number;
  attemptId: string; // claim fence: a superseded worker must write nothing
  status: ProjectStatus;
  documents: GovernanceDoc[];
  transcript: TranscriptEntry[];
  coveredBankIds: string[];
  nextQuestion: NextQuestion | null;
  reviewSummary: string | null;
  changedSections: Record<string, string[]>;
  flagged: boolean;
  answersIncrement: number;
}): Promise<boolean> {
  const documentsJson = JSON.stringify(opts.documents);
  const transcriptJson = JSON.stringify(opts.transcript);
  if (
    Buffer.byteLength(documentsJson) > CAPS.documentsJsonMaxBytes ||
    Buffer.byteLength(transcriptJson) > CAPS.transcriptJsonMaxBytes
  )
    return false;
  const rows = await db
    .update(P)
    .set({
      status: opts.status,
      rev: sql`rev + 1`,
      documentsJson,
      transcriptJson,
      coveredBankIdsJson: JSON.stringify(opts.coveredBankIds),
      nextQuestionJson: opts.nextQuestion
        ? JSON.stringify(opts.nextQuestion)
        : null,
      reviewSummary: opts.reviewSummary,
      changedSectionsJson: JSON.stringify(opts.changedSections),
      answersCount: sql`answers_count + ${opts.answersIncrement}`,
      researchFlagged: sql`research_flagged OR ${opts.flagged}`,
      // Success clears the whole turn record in the same write.
      turnPromptId: null,
      turnAttemptId: null,
      turnStartedAt: null,
      turnJson: null,
      lastActivityAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(P.id, opts.id),
        eq(P.userId, opts.userId),
        eq(P.rev, opts.expectedRev),
        eq(P.turnAttemptId, opts.attemptId)
      )
    )
    .returning({ id: P.id });
  return rows.length > 0;
}

/**
 * Open-item keep-as-drafted write (§5.12): rev-fenced like a turn but
 * claimless, so it must ALSO refuse while a fresh turn claim is running —
 * a strip that bumped rev under the worker would void that worker's final
 * write and waste its brain call. Stale claims (orphans) don't block, same
 * horizon as confirmProject.
 */
export async function applyResolveWrite(opts: {
  id: string;
  userId: string;
  expectedRev: number;
  documents: GovernanceDoc[];
  transcript: TranscriptEntry[];
  changedSections: Record<string, string[]>;
}): Promise<boolean> {
  const documentsJson = JSON.stringify(opts.documents);
  const transcriptJson = JSON.stringify(opts.transcript);
  if (
    Buffer.byteLength(documentsJson) > CAPS.documentsJsonMaxBytes ||
    Buffer.byteLength(transcriptJson) > CAPS.transcriptJsonMaxBytes
  )
    return false;
  const rows = await db
    .update(P)
    .set({
      documentsJson,
      transcriptJson,
      changedSectionsJson: JSON.stringify(opts.changedSections),
      rev: sql`rev + 1`,
      lastActivityAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(P.id, opts.id),
        eq(P.userId, opts.userId),
        eq(P.rev, opts.expectedRev),
        eq(P.status, "review"),
        sql`(turn_started_at IS NULL OR turn_started_at < now() - make_interval(secs => ${CAPS.turnStaleMs / 1000}))`
      )
    )
    .returning({ id: P.id });
  return rows.length > 0;
}

export async function confirmProject(
  userId: string,
  id: string
): Promise<boolean> {
  if (!isUuid(id)) return false;
  const rows = await db
    .update(P)
    .set({ status: "done", lastActivityAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        eq(P.id, id),
        eq(P.userId, userId),
        eq(P.status, "review"),
        gte(P.lastActivityAt, retentionCutoff()),
        // No confirm while a revise turn is running: the worker's apply
        // would race the done flip. Stale claims (orphans) don't block.
        sql`(turn_started_at IS NULL OR turn_started_at < now() - make_interval(secs => ${CAPS.turnStaleMs / 1000}))`
      )
    )
    .returning({ id: P.id });
  return rows.length > 0;
}

/* ------------------------------------------------------------------ *
 * Daily budget ledger (out-of-process: survives restarts, covers scripts)
 * ------------------------------------------------------------------ */

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function ensureToday(): Promise<void> {
  await db.insert(U).values({ day: today() }).onConflictDoNothing();
}

/** Atomically spend n units if the day's total stays within cap. */
export async function trySpendBudget(
  counter: "tavily_calls" | "brain_calls" | "research_runs",
  n: number,
  cap: number
): Promise<boolean> {
  await ensureToday();
  const res = await db.execute(sql`
    UPDATE governance_usage
    SET ${sql.raw(counter)} = ${sql.raw(counter)} + ${n}
    WHERE day = ${today()} AND ${sql.raw(counter)} + ${n} <= ${cap}
    RETURNING day
  `);
  return (res as unknown as unknown[]).length > 0;
}

/** Uncapped usage accounting (quarterly standards research: bounded by its
 * own query banks, but still counted so report emails show true spend). */
export async function recordUsage(
  counter: "tavily_calls" | "brain_calls",
  n: number
): Promise<void> {
  await ensureToday();
  await db.execute(
    sql`UPDATE governance_usage SET ${sql.raw(counter)} = ${sql.raw(counter)} + ${n} WHERE day = ${today()}`
  );
}

/** Month-to-date Tavily calls (report email + 80% quota WARN). */
export async function monthTavilyCalls(): Promise<number> {
  const res = (await db.execute(
    sql`SELECT COALESCE(sum(tavily_calls),0)::int AS n FROM governance_usage WHERE day >= date_trunc('month', now())::date`
  )) as unknown as { n: number }[];
  return res[0]?.n ?? 0;
}

export async function readTodayUsage(): Promise<{
  tavilyCalls: number;
  brainCalls: number;
  researchRuns: number;
}> {
  const rows = await db.select().from(U).where(eq(U.day, today())).limit(1);
  const r = rows[0];
  return {
    tavilyCalls: r?.tavilyCalls ?? 0,
    brainCalls: r?.brainCalls ?? 0,
    researchRuns: r?.researchRuns ?? 0,
  };
}

export async function pruneUsage(days = 90): Promise<void> {
  await db
    .delete(U)
    .where(lt(U.day, new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)));
}

/* ------------------------------------------------------------------ *
 * Meta (request-path throttles, sweep stamps — single-writer vs state.json)
 * ------------------------------------------------------------------ */

export async function getMeta(key: string): Promise<string | null> {
  const rows = await db.select().from(M).where(eq(M.key, key)).limit(1);
  return rows[0]?.value ?? null;
}

export async function setMeta(key: string, value: string): Promise<void> {
  await db
    .insert(M)
    .values({ key, value })
    .onConflictDoUpdate({
      target: M.key,
      set: { value, updatedAt: sql`now()` },
    });
}

export async function deleteMeta(key: string): Promise<boolean> {
  const rows = await db.delete(M).where(eq(M.key, key)).returning({ key: M.key });
  return rows.length > 0;
}

/** Atomic once-only claim (replay dedupe): true = this call won the key. */
export async function claimMetaOnce(key: string, value: string): Promise<boolean> {
  const rows = await db
    .insert(M)
    .values({ key, value })
    .onConflictDoNothing()
    .returning({ key: M.key });
  return rows.length > 0;
}

export async function listMetaByPrefix(
  prefix: string
): Promise<{ key: string; value: string; updatedAt: Date }[]> {
  return db
    .select()
    .from(M)
    .where(sql`${M.key} LIKE ${prefix + "%"}`)
    .orderBy(M.key);
}

/** Prune prefixed meta rows older than `days` (dedupe keys, audit rows). */
export async function deleteMetaByPrefixOlderThan(
  prefix: string,
  days: number
): Promise<number> {
  const rows = await db
    .delete(M)
    .where(
      sql`${M.key} LIKE ${prefix + "%"} AND ${M.updatedAt} < now() - make_interval(days => ${days})`
    )
    .returning({ key: M.key });
  return rows.length;
}
