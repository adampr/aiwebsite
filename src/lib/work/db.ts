// DB access for team work submissions (§5.16). All writes that end a panel
// run are fenced on panel_attempt_id (turn-runner pattern): a zombie worker
// from a superseded claim can never publish.

import {
  and,
  desc,
  eq,
  getTableColumns,
  gte,
  isNotNull,
  ne,
  sql,
} from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { WORK_CAPS, type WorkKind } from "./config";
import type { WorkCard } from "./lint";
import { slugForTitle } from "./lint";

const S = schema.workSubmissions;

// Every list/poll/panel read EXCLUDES archive_data (the transient original
// upload, ≤10 MB): only the retention-email step ever selects it, via
// archiveDataById().
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { archiveData: _archiveData, mdData: _mdData, ...ROW_COLS } =
  getTableColumns(S);

export type SubmissionRow = Omit<
  typeof S.$inferSelect,
  "archiveData" | "mdData"
>;

export function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    v
  );
}

export async function createSubmission(opts: {
  userId: string;
  email: string;
  name: string | null;
  kind: WorkKind;
  title: string;
  blurb: string;
  architectureText: string | null;
  skillMdText: string | null;
  fileManifestJson: string;
  corpusFilesJson: string;
  archiveName: string;
  archiveSha256: string;
  archiveBytes: number;
  archiveData: Buffer;
  // The standalone SKILL.md (CoWork Skill kind only).
  md?: { name: string; sha256: string; bytes: number; data: Buffer };
}): Promise<SubmissionRow> {
  const [row] = await db
    .insert(S)
    .values({
      archiveData: opts.archiveData,
      mdName: opts.md?.name ?? null,
      mdSha256: opts.md?.sha256 ?? null,
      mdBytes: opts.md?.bytes ?? null,
      mdData: opts.md?.data ?? null,
      userId: opts.userId,
      submitterEmail: opts.email,
      submitterName: opts.name,
      kind: opts.kind,
      title: opts.title,
      blurb: opts.blurb,
      architectureText: opts.architectureText,
      skillMdText: opts.skillMdText,
      fileManifestJson: opts.fileManifestJson,
      corpusFilesJson: opts.corpusFilesJson,
      archiveName: opts.archiveName,
      archiveSha256: opts.archiveSha256,
      archiveBytes: opts.archiveBytes,
    })
    .returning(ROW_COLS);
  return row;
}

export async function submissionById(
  id: string
): Promise<SubmissionRow | null> {
  if (!isUuid(id)) return null;
  const rows = await db.select(ROW_COLS).from(S).where(eq(S.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function mySubmissions(email: string): Promise<SubmissionRow[]> {
  return db
    .select(ROW_COLS)
    .from(S)
    .where(eq(S.submitterEmail, email))
    .orderBy(desc(S.createdAt))
    .limit(25);
}

export async function allSubmissions(limit = 100): Promise<SubmissionRow[]> {
  return db.select(ROW_COLS).from(S).orderBy(desc(S.createdAt)).limit(limit);
}

/** Durable per-user daily quota: counted from rows, survives restarts. */
export async function countCreatedToday(email: string): Promise<number> {
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(S)
    .where(and(eq(S.submitterEmail, email), gte(S.createdAt, dayStart)));
  return rows[0]?.n ?? 0;
}

export interface PublishedCard {
  id: string;
  slug: string;
  card: WorkCard;
  submitterName: string | null;
  publishedAt: Date;
  docPath: string;
}

/** Published cards for the public /work section, oldest publish first so the
 * section grows downward like the hand-authored narrative. */
export async function publishedCards(): Promise<PublishedCard[]> {
  const rows = await db
    .select(ROW_COLS)
    .from(S)
    .where(and(eq(S.status, "published"), isNotNull(S.cardJson)))
    .orderBy(S.publishedAt)
    .limit(50);
  const out: PublishedCard[] = [];
  for (const r of rows) {
    try {
      const card = JSON.parse(r.cardJson!) as WorkCard;
      let docPath = "";
      try {
        const corpus = JSON.parse(r.corpusFilesJson ?? "[]") as {
          path: string;
        }[];
        docPath = corpus[0]?.path ?? "";
      } catch {
        docPath = "";
      }
      out.push({
        id: r.id,
        slug: r.slug ?? slugForTitle(card.title),
        card,
        submitterName: r.submitterName,
        publishedAt: r.publishedAt ?? r.createdAt,
        docPath,
      });
    } catch {
      // a malformed row renders nothing rather than breaking the page
    }
  }
  return out;
}

export async function publishedTitleAndFacetSets(): Promise<{
  publishedTitles: string[];
  publishedFacetLabels: string[];
}> {
  const cards = await publishedCards();
  return {
    publishedTitles: cards.map((c) => c.card.title.toLowerCase()),
    publishedFacetLabels: cards.flatMap((c) =>
      c.card.facets.map((f) => f.label.toLowerCase())
    ),
  };
}

/** Latest publish stamp for the sitemap (caller wraps failures). */
export async function latestPublishedAt(): Promise<Date | null> {
  const rows = await db
    .select({ at: sql<Date | null>`max(published_at)` })
    .from(S)
    .where(eq(S.status, "published"));
  return rows[0]?.at ?? null;
}

// ---- Panel claim / fence ----

/** True while any OTHER row holds a live running claim (global serialization:
 * the brain is shared with latency-sensitive voice, one panel at a time). */
export async function anotherPanelRunning(exceptId: string): Promise<boolean> {
  const liveAfter = new Date(Date.now() - WORK_CAPS.panelStaleMs);
  const rows = await db
    .select({ id: S.id })
    .from(S)
    .where(
      and(
        eq(S.status, "running"),
        ne(S.id, exceptId),
        gte(S.panelHeartbeatAt, liveAfter)
      )
    )
    .limit(1);
  return rows.length > 0;
}

/** Atomic claim: only an unclaimed (or stale-claimed) non-terminal row can be
 * claimed; bumps the per-submission daily runs counter. */
export async function claimPanel(
  id: string,
  attemptId: string
): Promise<boolean> {
  const staleBefore = new Date(Date.now() - WORK_CAPS.panelStaleMs);
  const today = new Date().toISOString().slice(0, 10);
  const res = await db
    .update(S)
    .set({
      status: "running",
      panelAttemptId: attemptId,
      panelStartedAt: new Date(),
      panelHeartbeatAt: new Date(),
      panelError: null,
      panelRuns: sql`CASE WHEN ${S.panelRunsDate} = ${today} THEN ${S.panelRuns} + 1 ELSE 1 END`,
      panelRunsDate: today,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(S.id, id),
        sql`${S.status} IN ('received', 'failed', 'running')`,
        sql`(${S.panelHeartbeatAt} IS NULL OR ${S.panelHeartbeatAt} < ${staleBefore})`,
        sql`(${S.panelRunsDate} IS DISTINCT FROM ${today} OR ${S.panelRuns} < ${WORK_CAPS.panelRunsPerSubmissionPerDay})`
      )
    )
    .returning({ id: S.id });
  return res.length > 0;
}

export async function heartbeat(
  id: string,
  attemptId: string,
  progress: Record<string, unknown>
): Promise<void> {
  await db
    .update(S)
    .set({
      panelHeartbeatAt: new Date(),
      panelProgressJson: JSON.stringify(progress).slice(0, 4000),
      updatedAt: new Date(),
    })
    .where(and(eq(S.id, id), eq(S.panelAttemptId, attemptId)));
}

async function uniqueSlug(title: string, id: string): Promise<string> {
  const base = slugForTitle(title);
  for (let i = 0; i < 5; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const clash = await db
      .select({ id: S.id })
      .from(S)
      .where(and(eq(S.slug, candidate), ne(S.id, id)))
      .limit(1);
    if (clash.length === 0) return candidate;
  }
  return `${base}-${id.slice(0, 8)}`;
}

export async function finishPublished(
  id: string,
  attemptId: string,
  card: WorkCard,
  transcriptJson: string
): Promise<string | null> {
  const slug = await uniqueSlug(card.title, id);
  const res = await db
    .update(S)
    .set({
      status: "published",
      cardJson: JSON.stringify(card),
      slug,
      publishedAt: new Date(),
      panelTranscriptJson: transcriptJson.slice(
        0,
        WORK_CAPS.transcriptJsonMaxBytes
      ),
      panelError: null,
      panelStartedAt: null,
      updatedAt: new Date(),
    })
    .where(and(eq(S.id, id), eq(S.panelAttemptId, attemptId)))
    .returning({ id: S.id });
  return res.length > 0 ? slug : null;
}

export async function finishHeld(
  id: string,
  attemptId: string,
  draftCard: unknown,
  reason: string,
  transcriptJson: string
): Promise<boolean> {
  const res = await db
    .update(S)
    .set({
      status: "held",
      cardJson: draftCard ? JSON.stringify(draftCard) : null,
      panelError: reason.slice(0, 4000),
      panelTranscriptJson: transcriptJson.slice(
        0,
        WORK_CAPS.transcriptJsonMaxBytes
      ),
      panelStartedAt: null,
      updatedAt: new Date(),
    })
    .where(and(eq(S.id, id), eq(S.panelAttemptId, attemptId)))
    .returning({ id: S.id });
  return res.length > 0;
}

export async function failPanel(
  id: string,
  attemptId: string,
  reason: string
): Promise<void> {
  await db
    .update(S)
    .set({
      status: "failed",
      panelError: reason.slice(0, 4000),
      panelStartedAt: null,
      updatedAt: new Date(),
    })
    .where(and(eq(S.id, id), eq(S.panelAttemptId, attemptId)));
}

/** Admin approve of a held card: publish the stored draft as-is. */
export async function approveHeld(id: string): Promise<string | null> {
  const row = await submissionById(id);
  if (!row || row.status !== "held" || !row.cardJson) return null;
  let card: WorkCard;
  try {
    card = JSON.parse(row.cardJson) as WorkCard;
  } catch {
    return null;
  }
  const slug = await uniqueSlug(card.title, id);
  const res = await db
    .update(S)
    .set({
      status: "published",
      slug,
      publishedAt: new Date(),
      panelError: null,
      updatedAt: new Date(),
    })
    .where(and(eq(S.id, id), eq(S.status, "held")))
    .returning({ id: S.id });
  return res.length > 0 ? slug : null;
}

export async function deleteSubmission(id: string): Promise<SubmissionRow | null> {
  const rows = await db.delete(S).where(eq(S.id, id)).returning(ROW_COLS);
  return rows[0] ?? null;
}

/** The original upload(s), for the owner retention email (§5.16): the
 * package plus, on CoWork Skill rows, the standalone SKILL.md. Empty after
 * the email has sent (clearArchiveData) or on pre-retention rows. */
export async function archiveDataById(
  id: string
): Promise<{ name: string; data: Buffer }[]> {
  const rows = await db
    .select({
      name: S.archiveName,
      data: S.archiveData,
      mdName: S.mdName,
      mdData: S.mdData,
    })
    .from(S)
    .where(eq(S.id, id))
    .limit(1);
  const r = rows[0];
  if (!r) return [];
  const files: { name: string; data: Buffer }[] = [];
  if (r.data)
    files.push({ name: r.name ?? "upload.zip", data: Buffer.from(r.data) });
  if (r.mdData)
    files.push({ name: r.mdName ?? "SKILL.md", data: Buffer.from(r.mdData) });
  return files;
}

/** Drop the retained upload bytes once the retention email has sent. */
export async function clearArchiveData(id: string): Promise<void> {
  await db
    .update(S)
    .set({ archiveData: null, mdData: null, updatedAt: new Date() })
    .where(eq(S.id, id));
}

/** Bounded sweep of non-published rows past retention, run opportunistically
 * from list/create requests (the governance sweepExpiredGlobal pattern; no
 * cron, no template-managed script edits). */
export async function sweepExpiredWork(limit = 25): Promise<number> {
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const res = await db.execute(sql`
    DELETE FROM work_submissions
    WHERE id IN (
      SELECT id FROM work_submissions
      WHERE status <> 'published' AND updated_at < ${cutoff}
      LIMIT ${limit}
    )
    RETURNING id
  `);
  return (res as unknown as unknown[]).length;
}

// ---- Daily budget ledger (work_usage) ----

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function ensureToday(): Promise<void> {
  await db.execute(sql`
    INSERT INTO work_usage (day) VALUES (${today()})
    ON CONFLICT (day) DO NOTHING
  `);
}

export async function readTodayWorkUsage(): Promise<{
  brainCalls: number;
  panelRuns: number;
}> {
  await ensureToday();
  const rows = await db
    .select()
    .from(schema.workUsage)
    .where(eq(schema.workUsage.day, today()));
  return {
    brainCalls: rows[0]?.brainCalls ?? 0,
    panelRuns: rows[0]?.panelRuns ?? 0,
  };
}

export async function trySpendWork(
  counter: "brain_calls" | "panel_runs",
  n: number,
  cap: number
): Promise<boolean> {
  await ensureToday();
  const res = await db.execute(sql`
    UPDATE work_usage
    SET ${sql.raw(counter)} = ${sql.raw(counter)} + ${n}
    WHERE day = ${today()} AND ${sql.raw(counter)} + ${n} <= ${cap}
    RETURNING day
  `);
  return (res as unknown as unknown[]).length > 0;
}
