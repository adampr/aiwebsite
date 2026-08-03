// DB access for team work submissions (§5.16). All writes that end a panel
// run are fenced on panel_attempt_id (turn-runner pattern): a zombie worker
// from a superseded claim can never publish.

import {
  and,
  desc,
  eq,
  getTableColumns,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
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
  /** Null on the email path (§5.16 email intake): there is no session; the
   * FK is a best-effort link to a site account when one exists. */
  userId: string | null;
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
  /** §5.16 updates: the published card this row proposes to replace. A row
   * with parentId set can never publish from the panel; it parks as
   * pending_approval for the admin swap. */
  parentId?: string | null;
}): Promise<SubmissionRow> {
  const [row] = await db
    .insert(S)
    .values({
      parentId: opts.parentId ?? null,
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

/** Site account for an email-path submitter, when one exists (best-effort
 * FK linkage; the email path has no session). */
export async function userIdForEmail(email: string): Promise<string | null> {
  const rows = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(sql`lower(${schema.users.email}) = ${email.toLowerCase()}`)
    .limit(1);
  return rows[0]?.id ?? null;
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

/** Durable per-user daily quota: counted from rows, survives restarts.
 * Failed submissions do NOT count (owner directive 2026-07-30): a pipeline
 * error must never eat someone's quota. */
export async function countCreatedToday(email: string): Promise<number> {
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(S)
    .where(
      and(
        eq(S.submitterEmail, email),
        gte(S.createdAt, dayStart),
        ne(S.status, "failed")
      )
    );
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

/** excludeId (§5.16 updates): an update row's pinned title and facets must
 * not self-clash against its own predecessor in the panel's taken-titles
 * prompt sets or the lint context; every other caller omits it. */
export async function publishedTitleAndFacetSets(excludeId?: string): Promise<{
  publishedTitles: string[];
  publishedFacetLabels: string[];
}> {
  const cards = (await publishedCards()).filter((c) => c.id !== excludeId);
  return {
    publishedTitles: cards.map((c) => c.card.title.toLowerCase()),
    publishedFacetLabels: cards.flatMap((c) =>
      c.card.facets.map((f) => f.label.toLowerCase())
    ),
  };
}

/** Latest content stamp for the sitemap (caller wraps failures). greatest()
 * with updated_at, not bare published_at: an approved update swap keeps the
 * card's published_at (ordering) but must still move /work's lastmod, and
 * updated_at carries the swap time by construction. */
export async function latestPublishedAt(): Promise<Date | null> {
  const rows = await db
    .select({ at: sql<Date | null>`max(greatest(published_at, updated_at))` })
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

/** Atomic claim: only an unclaimed (or stale-claimed) non-terminal row can
 * be claimed; bumps the per-submission daily runs counter. fromHeld is the
 * admin re-run path ONLY: it claims a held row directly (held -> running,
 * heartbeat staleness ignored since a held row has no live worker), so a
 * refused admission never strands the row in a submitter-retryable status. */
export async function claimPanel(
  id: string,
  attemptId: string,
  opts?: { fromHeld?: boolean }
): Promise<boolean> {
  const staleBefore = new Date(Date.now() - WORK_CAPS.panelStaleMs);
  const today = new Date().toISOString().slice(0, 10);
  // fromHeld (admin re-run) also claims pending_approval update rows: a
  // passing re-run lands back in pending_approval, so a re-run can never
  // sneak a swap past the approval click.
  const gate = opts?.fromHeld
    ? and(eq(S.id, id), inArray(S.status, ["held", "pending_approval"]))
    : and(
        eq(S.id, id),
        inArray(S.status, ["received", "failed", "running"]),
        // Typed operators, NOT raw sql fragments: a Date inside sql`` skips
        // drizzle's column mapping and crashes postgres.js (prod incident
        // 2026-07-30, the first authenticated submit 500'd here).
        or(isNull(S.panelHeartbeatAt), lt(S.panelHeartbeatAt, staleBefore))
      );
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
        gate,
        or(
          sql`${S.panelRunsDate} IS DISTINCT FROM ${today}`,
          lt(S.panelRuns, WORK_CAPS.panelRunsPerSubmissionPerDay)
        )
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

/** §5.16 updates: a passing panel run on an update row parks here, never in
 * finishPublished. No slug, no publishedAt, no revalidate, no retention:
 * nothing public changes until the admin approves the swap. heldAt is NOT
 * touched (held's one-way retry poison is for gate failures, not for the
 * approval queue). Fenced on panel_attempt_id like every terminal write. */
export async function finishPendingApproval(
  id: string,
  attemptId: string,
  card: WorkCard,
  transcriptJson: string
): Promise<boolean> {
  const res = await db
    .update(S)
    .set({
      status: "pending_approval",
      cardJson: JSON.stringify(card),
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
  return res.length > 0;
}

/** The copy a conflict-parked update carries in panel_error. Admin-facing
 * (/admin/work renders it); statusView replaces it with a canned line for
 * the submitter. Dead-end honest: once the target is gone this child can
 * never publish, so the only moves are delete or a fresh submission. */
export const UPDATE_CONFLICT_NOTE =
  "update approval conflict: the live card this update targeted is no " +
  "longer published, so nothing was replaced. Delete this update; if the " +
  "tool should still be on /work, submit it again as a new card.";

export type SupersedeResult =
  | { ok: true; slug: string; card: WorkCard; parent: SubmissionRow }
  | { ok: false; reason: "not_eligible" | "conflict" };

/** The ONE code path that swaps an approved update live (§5.16). Called only
 * from the admin approve route (a real request context, so revalidatePath
 * works). Single transaction, both rows locked in id order:
 * parent -> superseded (slug freed FIRST: work_sub_slug_uq is not
 * deferrable, so the statement order is load-bearing), child -> published
 * with the parent's slug and publishedAt (the card keeps its deep link and
 * its slot in /work's oldest-first order; updatedAt carries the swap time
 * for the sitemap). If the parent is no longer published (deleted, pulled,
 * or superseded by a rival), the child is parked held with
 * UPDATE_CONFLICT_NOTE and NOTHING publishes standalone: a standalone
 * publish is how duplicate live cards get minted (refutation FATAL,
 * 2026-08-03). */
export async function publishWithSupersede(
  childId: string
): Promise<SupersedeResult> {
  const pre = await submissionById(childId);
  if (
    !pre ||
    !pre.parentId ||
    !pre.cardJson ||
    (pre.status !== "pending_approval" && pre.status !== "held")
  )
    return { ok: false, reason: "not_eligible" };
  let card: WorkCard;
  try {
    card = JSON.parse(pre.cardJson) as WorkCard;
  } catch {
    return { ok: false, reason: "not_eligible" };
  }
  const parentId = pre.parentId;
  return db.transaction(async (tx) => {
    const locked = await tx
      .select(ROW_COLS)
      .from(S)
      .where(inArray(S.id, [childId, parentId]))
      .orderBy(S.id)
      .for("update");
    const child = locked.find((r) => r.id === childId);
    const parent = locked.find((r) => r.id === parentId);
    if (
      !child ||
      (child.status !== "pending_approval" && child.status !== "held") ||
      child.parentId !== parentId ||
      !child.cardJson
    )
      return { ok: false, reason: "not_eligible" as const };
    if (!parent || parent.status !== "published" || !parent.slug) {
      await tx
        .update(S)
        .set({
          status: "held",
          heldAt: child.heldAt ?? new Date(),
          panelError: UPDATE_CONFLICT_NOTE,
          updatedAt: new Date(),
        })
        .where(eq(S.id, childId));
      return { ok: false, reason: "conflict" as const };
    }
    const slug = parent.slug;
    await tx
      .update(S)
      .set({
        status: "superseded",
        supersededAt: new Date(),
        slug: null,
        updatedAt: new Date(),
      })
      .where(eq(S.id, parent.id));
    await tx
      .update(S)
      .set({
        status: "published",
        slug,
        publishedAt: parent.publishedAt ?? new Date(),
        panelError: null,
        updatedAt: new Date(),
      })
      .where(eq(S.id, childId));
    return { ok: true as const, slug, card, parent };
  });
}

export type RollbackResult =
  | { ok: true; parent: SubmissionRow; child: SubmissionRow; slug: string }
  | { ok: false };

/** Undo an approved swap (§5.16): DELETE on a published update child whose
 * parent is superseded restores the previous version instead of vaporizing
 * the card. Child deleted FIRST (frees the slug), then the parent takes it
 * back; same statement-order rule as the swap. */
export async function rollbackSwappedUpdate(
  childId: string
): Promise<RollbackResult> {
  const pre = await submissionById(childId);
  if (!pre || !pre.parentId || pre.status !== "published" || !pre.slug)
    return { ok: false };
  const parentId = pre.parentId;
  return db.transaction(async (tx) => {
    const locked = await tx
      .select(ROW_COLS)
      .from(S)
      .where(inArray(S.id, [childId, parentId]))
      .orderBy(S.id)
      .for("update");
    const child = locked.find((r) => r.id === childId);
    const parent = locked.find((r) => r.id === parentId);
    if (
      !child ||
      child.status !== "published" ||
      !child.slug ||
      !parent ||
      parent.status !== "superseded" ||
      !parent.cardJson
    )
      return { ok: false as const };
    const slug = child.slug;
    await tx.delete(S).where(eq(S.id, childId));
    await tx
      .update(S)
      .set({
        status: "published",
        slug,
        supersededAt: null,
        updatedAt: new Date(),
      })
      .where(eq(S.id, parent.id));
    return { ok: true as const, parent, child, slug };
  });
}

/** An unresolved update child of this row (§5.16 DELETE guard). 'failed' IS
 * in this list even though the one-in-flight index omits it: deleting a
 * parent while a failed child exists would SET NULL the child's parent_id,
 * and a later Retry would then publish the update standalone with no
 * approval stop (refutation FATAL F1, 2026-08-03). */
export async function activeUpdateChild(
  parentId: string
): Promise<{ id: string; status: string } | null> {
  const rows = await db
    .select({ id: S.id, status: S.status })
    .from(S)
    .where(
      and(
        eq(S.parentId, parentId),
        inArray(S.status, [
          "received",
          "running",
          "held",
          "pending_approval",
          "failed",
        ])
      )
    )
    .limit(1);
  return rows[0] ?? null;
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
      heldAt: new Date(), // never cleared: bars submitter retry for good
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

/** Ops lever (2026-07-31 meta-commentary incident): pull a PUBLISHED card
 * back to held so claimPanel({fromHeld}) can re-run it. Published-status
 * gated, so a double invocation is a no-op; heldAt is set and never cleared
 * (same bar as finishHeld). The card drops off /work on the next render,
 * which is intended: the bad copy comes down first. cardJson is nulled
 * DELIBERATELY: approveHeld publishes stored drafts verbatim with no
 * re-gate, so leaving the incident copy on the row would let one admin
 * click republish it; with null, approveHeld refuses until a fresh run
 * stores a new draft. The note lands in panelError but claimPanel nulls it
 * on the next claim; the durable audit trail is the operator's close-out
 * email and pre-repair dump, not this row. */
export async function holdPublishedForRerun(
  id: string,
  note: string
): Promise<boolean> {
  const res = await db
    .update(S)
    .set({
      status: "held",
      heldAt: new Date(),
      cardJson: null,
      panelError: note.slice(0, 4000),
      updatedAt: new Date(),
    })
    .where(and(eq(S.id, id), eq(S.status, "published")))
    .returning({ id: S.id });
  return res.length > 0;
}

/** Ops retitle before a re-run: the synthesis prompt pins the card title to
 * row.title, so the row must carry the intended title BEFORE the panel
 * runs. No status gate: used on held rows pre-re-run. */
export async function setSubmissionTitle(
  id: string,
  title: string
): Promise<boolean> {
  const res = await db
    .update(S)
    .set({ title, updatedAt: new Date() })
    .where(eq(S.id, id))
    .returning({ id: S.id });
  return res.length > 0;
}

/** Retitle-only repair for a published card whose COPY is good but whose
 * title is a transport artifact ("skill to our work", 2026-07-31): rewrites
 * row.title, cardJson.title, and the slug, no brain calls, body untouched.
 * The caller validates the new title (length, string bans, static and
 * published clashes) before calling. */
export async function retitlePublishedCard(
  id: string,
  title: string
): Promise<{ oldSlug: string | null; slug: string } | null> {
  const row = await submissionById(id);
  if (!row || row.status !== "published" || !row.cardJson) return null;
  let card: WorkCard;
  try {
    card = JSON.parse(row.cardJson) as WorkCard;
  } catch {
    return null;
  }
  card.title = title;
  const slug = await uniqueSlug(title, id);
  const res = await db
    .update(S)
    .set({
      title,
      cardJson: JSON.stringify(card),
      slug,
      updatedAt: new Date(),
    })
    .where(and(eq(S.id, id), eq(S.status, "published")))
    .returning({ id: S.id });
  return res.length > 0 ? { oldSlug: row.slug, slug } : null;
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

/** Bounded sweep of expired rows, run opportunistically from list/create
 * requests (the governance sweepExpiredGlobal pattern; no cron, no
 * template-managed script edits). HELD rows are exempt: a held row is the
 * admin's action queue and carries the only copy of the draft plus the
 * retained originals; sweeping it would silently destroy both. */
export async function sweepExpiredWork(limit = 25): Promise<number> {
  // ISO string, not a Date: raw sql`` params bypass drizzle's type mapping.
  // pending_approval and superseded are exempt alongside held:
  // pending_approval is the admin's approval queue and still carries the
  // retained originals; superseded is the rollback reservoir (its cardJson
  // is the only surviving copy of the replaced card).
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const res = await db.execute(sql`
    DELETE FROM work_submissions
    WHERE id IN (
      SELECT id FROM work_submissions
      WHERE status NOT IN ('published', 'held', 'pending_approval', 'superseded')
        AND updated_at < ${cutoff}
      LIMIT ${limit}
    )
    RETURNING id
  `);
  return (res as unknown as unknown[]).length;
}

/** True when err (or anything in its cause chain) is a violation of the
 * named unique index. drizzle wraps postgres errors as "Failed query: ..."
 * with the real PostgresError in err.cause, so a bare
 * err.message.includes(indexName) never matches (latent bug found
 * 2026-08-03: the double-click race mapped to the generic 500, not the
 * intended 409). Every intake catch goes through this. */
export function isUniqueViolation(err: unknown, ...indexNames: string[]): boolean {
  let e: unknown = err;
  for (let i = 0; i < 5 && e instanceof Error; i++) {
    const msg = e.message;
    if (indexNames.some((n) => msg.includes(n))) return true;
    e = e.cause;
  }
  return false;
}

// ---- Duplicate-title guard (§5.16, 2026-07-30) ----

/** Same normalization as the partial unique index in migration 0025. */
export function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ").toLowerCase();
}

/** An active (received/running/held) row from ANY submitter whose normalized
 * title matches; /work is one public page, a duplicate is a duplicate. */
export async function activeTitleClash(
  title: string
): Promise<{ id: string; submitterEmail: string; status: string } | null> {
  const norm = normalizeTitle(title);
  const rows = await db
    .select({ id: S.id, submitterEmail: S.submitterEmail, status: S.status })
    .from(S)
    .where(
      and(
        inArray(S.status, ["received", "running", "held", "pending_approval"]),
        sql`lower(btrim(regexp_replace(${S.title}, '\s+', ' ', 'g'))) = ${norm}`
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

/** A published community card already using this title. exceptId (§5.16
 * updates): an update row carries its predecessor's pinned title, which must
 * not clash against the predecessor itself; every other caller omits it. */
export async function publishedTitleClash(
  title: string,
  opts?: { exceptId?: string }
): Promise<boolean> {
  const norm = normalizeTitle(title);
  const rows = await db
    .select({ id: S.id })
    .from(S)
    .where(
      and(
        eq(S.status, "published"),
        ...(opts?.exceptId ? [ne(S.id, opts.exceptId)] : []),
        sql`lower(btrim(regexp_replace(${S.title}, '\s+', ' ', 'g'))) = ${norm}`
      )
    )
    .limit(1);
  return rows.length > 0;
}

/** Resolve an "Update Card:" value to the published community card it names.
 * Title match wins over slug match by rule (a value could title-match one
 * card and slug-match another; deterministic precedence, never ambiguity).
 * Static exhibits are the caller's problem: this only sees the DB. */
export async function resolveUpdateTarget(
  value: string
): Promise<SubmissionRow | null> {
  const norm = normalizeTitle(value);
  if (!norm) return null;
  const published = and(eq(S.status, "published"), isNotNull(S.cardJson));
  const byTitle = await db
    .select(ROW_COLS)
    .from(S)
    .where(
      and(
        published,
        sql`lower(btrim(regexp_replace(${S.title}, '\s+', ' ', 'g'))) = ${norm}`
      )
    )
    .limit(1);
  if (byTitle[0]) return byTitle[0];
  const v = value.trim().toLowerCase();
  const bySlug = await db
    .select(ROW_COLS)
    .from(S)
    .where(and(published, or(eq(S.slug, v), eq(S.slug, `team-${v}`))))
    .limit(1);
  return bySlug[0] ?? null;
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

/** Refund one panel run when admission fails after the spend (busy/claim
 * refusals must not burn global budget; floor at 0). */
export async function refundWorkRun(): Promise<void> {
  await db.execute(sql`
    UPDATE work_usage
    SET panel_runs = GREATEST(panel_runs - 1, 0)
    WHERE day = ${new Date().toISOString().slice(0, 10)}
  `);
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
