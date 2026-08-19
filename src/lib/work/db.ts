// DB access for team work submissions (§5.16). All writes that end a panel
// run are fenced on panel_attempt_id (turn-runner pattern): a zombie worker
// from a superseded claim can never publish.

import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { isAdmin } from "@aicompany/core/auth/guard";
import { RFP_PROVIDERS } from "@/lib/rfp/access";
import { db, schema } from "@/lib/db";
import { WORK_CAPS, type WorkKind } from "./config";
import type { WorkCard } from "./lint";
import { slugForTitle } from "./lint";
// Type-only (erased at runtime): scope.ts imports roadmap/db which imports
// this file, so a value import here would cycle.
import type { WorkScope } from "./scope";

const S = schema.workSubmissions;

/** §5.18 tenancy predicate. REQUIRED on every read that feeds a rendered
 * surface or a uniqueness gate: null = the public /work lane (company_id IS
 * NULL, all pre-roadmap rows), a companyId = that company's private lane. */
function inScope(scope: WorkScope) {
  return scope.companyId === null
    ? isNull(S.companyId)
    : eq(S.companyId, scope.companyId);
}

// Every list/poll/panel read EXCLUDES archive_data (the transient original
// upload, ≤100 MB while it lasts): only the retention-email step ever
// selects it, via archiveDataById(). The durable copy lives in the on-disk
// archive store (archive-store.ts) since 2026-08-19.
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
   * with parentId set parks as pending_approval for the admin swap, unless
   * autoApprove was stamped at intake. */
  parentId?: string | null;
  /** §5.16 admin web auto-approve: web-session verified-admin lane ONLY.
   * The email lane must NEVER pass it: a spoofed From under domain DKIM
   * would turn a forged email into a live card swap. Guarded by a throw
   * here and by the work_sub_auto_approve_parent_ck CHECK in the DB. */
  autoApprove?: boolean;
  /** §5.18 tenancy: REQUIRED (no default) so every intake path states its
   * lane. null = public /work; a company id = that company's private Your
   * Work. Company update rows are impossible (0035 CHECK + throw here). */
  companyId: string | null;
}): Promise<SubmissionRow> {
  if (opts.autoApprove && !opts.parentId)
    throw new Error(
      "autoApprove is only meaningful on an update row (parentId required)"
    );
  if (opts.companyId && opts.parentId)
    throw new Error(
      "company-lane update rows are not supported (work_sub_company_no_update_ck)"
    );
  const [row] = await db
    .insert(S)
    .values({
      companyId: opts.companyId,
      parentId: opts.parentId ?? null,
      autoApprove: opts.autoApprove ?? false,
      archiveData: opts.archiveData,
      mdName: opts.md?.name ?? null,
      mdSha256: opts.md?.sha256 ?? null,
      mdBytes: opts.md?.bytes ?? null,
      mdData: opts.md?.data ?? null,
      userId: opts.userId,
      submitterEmail: opts.email,
      // Stamped once, never rewritten by a transfer (§5.16 transfer round):
      // the daily quota belongs to whoever spent the panel run, not to
      // whoever happens to own the row afterwards.
      creatorEmail: opts.email,
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

/** Case-folded ownership predicate. Raw equality was safe only while every
 * submitter_email arrived verbatim from the session that later read it; a
 * transfer stores a TYPED address, so "Jane@xl.net" must still match a row
 * stored as "jane@xl.net" (src/lib/work/transfer.ts sameEmail is the
 * in-memory twin of this). No index is lost: work_submissions has never had
 * one on submitter_email. */
function ownedBy(email: string) {
  return sql`lower(${S.submitterEmail}) = ${email.trim().toLowerCase()}`;
}

export async function mySubmissions(email: string): Promise<SubmissionRow[]> {
  return db
    .select(ROW_COLS)
    .from(S)
    .where(ownedBy(email))
    .orderBy(desc(S.createdAt))
    .limit(25);
}

// The exact columns statusView() (view.ts) reads, and nothing else. ROW_COLS
// drops only the two blobs, so it still carries corpus_files_json (the whole
// extracted text corpus of an upload), architecture_text/skill_md_text and the
// panel transcript — payload the projection never touches.
const LIST_COLS = {
  id: S.id,
  title: S.title,
  kind: S.kind,
  status: S.status,
  slug: S.slug,
  createdAt: S.createdAt,
  parentId: S.parentId,
  autoApprove: S.autoApprove,
  heldAt: S.heldAt,
  panelError: S.panelError,
  panelProgressJson: S.panelProgressJson,
  panelHeartbeatAt: S.panelHeartbeatAt,
  // §5.16 transfer round: the owner triple. All three are small scalars, so
  // ONE projection still serves both the submitter's own list and the
  // admin's all-submissions list, and a transfer's provenance ("moved from")
  // needs no second query.
  submitterEmail: S.submitterEmail,
  creatorEmail: S.creatorEmail,
  companyId: S.companyId,
};

/** A row narrowed to what statusView() projects. Keep this in step with
 * LIST_COLS: statusView takes this type, so dropping a column here is a
 * compile error, not a runtime undefined. */
export type SubmissionListRow = Pick<
  SubmissionRow,
  | "id"
  | "title"
  | "kind"
  | "status"
  | "slug"
  | "createdAt"
  | "parentId"
  | "autoApprove"
  | "heldAt"
  | "panelError"
  | "panelProgressJson"
  | "panelHeartbeatAt"
  | "submitterEmail"
  | "creatorEmail"
  | "companyId"
>;

/** The /work/submit "your submissions" list (GET /api/work/submissions).
 * Separate from mySubmissions() for two reasons:
 *   - cost: that endpoint is polled every 10 s while any row is active, and
 *     ROW_COLS drags the corpus/doc text along on every tick. LIST_COLS is the
 *     projection's own column set, so raising the cap costs little.
 *   - truncation: mySubmissions caps at 25, which silently cut the list AND
 *     made the page's "N submissions" readout assert a wrong total. 200 is a
 *     generous ceiling over the 20/user and 200/admin daily quotas
 *     (WORK_CAPS), and keeps the response bounded.
 * mySubmissions() itself is unchanged: its other caller is §5.18 /roadmap/work. */
export async function mySubmissionsForList(
  email: string,
  limit = 200
): Promise<SubmissionListRow[]> {
  return db
    .select(LIST_COLS)
    .from(S)
    .where(ownedBy(email))
    .orderBy(desc(S.createdAt))
    .limit(limit);
}

/** The admin "All submissions" view on /work/submit (§5.16 transfer round).
 * EVERY row in EVERY lane, newest first, through the same narrow projection
 * the submitter's own list uses. Deliberately NOT a widened
 * mySubmissionsForList: the caller must ask for this by name, so no gate can
 * accidentally serve the all-list to a non-admin by passing a falsy email.
 * The caller asks for limit+1 and reports the truncation rather than letting
 * a silently-cut list assert a total (the 2026-08-07 pager lesson). */
export async function allSubmissionsForList(
  limit = 200
): Promise<SubmissionListRow[]> {
  return db.select(LIST_COLS).from(S).orderBy(desc(S.createdAt)).limit(limit);
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
        // CREATOR, not owner (§5.16 transfer round). Anchoring the quota on
        // submitter_email would let a colleague's twenty transferred rows
        // consume the recipient's whole day, and would let the sender free
        // their own quota by moving rows away. creator_email is NULL on
        // every pre-round row, hence the coalesce rather than a backfill.
        sql`lower(coalesce(${S.creatorEmail}, ${S.submitterEmail})) = ${email.trim().toLowerCase()}`,
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

/** Published cards for the public /work section, newest publish first so a
 * fresh publish surfaces at the top of the team run (pagination round,
 * 2026-08-04; previously oldest-first). Uncapped on purpose: the display
 * path paginates client-side over the full set, and the panel's uniqueness
 * consumer (publishedTitleAndFacetSets) must see EVERY published title and
 * facet label — the old .limit(50) silently blinded that gate past 50 cards.
 * Watch item: the taken-titles/facets prompt strings grow with card count
 * (~25-30 KB at ~275 cards).
 *
 * Admin curation (§5.16 reorder): display_rank ASC leads — Postgres ASC
 * defaults to NULLS LAST, which this ordering depends on — so an arranged
 * lane holds its admin-chosen spots (dense 1..k) while unranked rows,
 * including every row in a never-arranged lane, keep the newest-first
 * order via the published_at DESC tie-break. */
export async function publishedCards(scope: WorkScope): Promise<PublishedCard[]> {
  const rows = await db
    .select(ROW_COLS)
    .from(S)
    .where(and(inScope(scope), eq(S.status, "published"), isNotNull(S.cardJson)))
    .orderBy(asc(S.displayRank), desc(S.publishedAt));
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
export async function publishedTitleAndFacetSets(
  scope: WorkScope,
  excludeId?: string
): Promise<{
  publishedTitles: string[];
  publishedFacetLabels: string[];
}> {
  const cards = (await publishedCards(scope)).filter((c) => c.id !== excludeId);
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
    // The sitemap is a PUBLIC surface: company-lane publishes must never
    // move (or leak through) /work's lastmod (§5.18).
    .where(and(eq(S.status, "published"), isNull(S.companyId)));
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

/** §5.16 queue drain (2026-08-05): the rows the automatic drain may kick.
 * Two classes only: a review that never started (received; the intake kick
 * was refused) and a worker that died mid-run (running with a NULL or stale
 * heartbeat, the deploy-restart orphan). held_at IS NULL is load-bearing: an
 * admin fromHeld re-run or an ops-script rerun of a pulled published card
 * that dies (or is deliberately aborted) mid-run leaves running+heldAt, and
 * the drain must never resume a run a human chose to stop. The age floor
 * cedes every row's FIRST claim to the intake request that created it, whose
 * response copy depends on its own kick outcome. failed rows are deliberately
 * absent (unanimous design-panel ruling): a full run already happened, and a
 * deterministic failure auto-retried by a timer would spend 3 runs a day
 * until the 30-day sweep. companyId rides along because the drain's
 * stop-vs-skip table is lane-dependent (a company lane's budget or roadmap
 * kill switch must not stall the /work queue). createdAt rides along as the
 * keyset cursor: a pass whose whole page was skipped (e.g. ten company rows
 * of a paused tenant at the queue head) fetches the NEXT page with `after`
 * instead of ending blind to every younger row behind them (refutation
 * finding 2026-08-05). */
export async function queuedWorkCandidates(
  limit = 10,
  after?: Date
): Promise<
  { id: string; status: string; companyId: string | null; createdAt: Date }[]
> {
  const staleBefore = new Date(Date.now() - WORK_CAPS.panelStaleMs);
  const ageFloor = new Date(Date.now() - 30_000);
  return db
    .select({
      id: S.id,
      status: S.status,
      companyId: S.companyId,
      createdAt: S.createdAt,
    })
    .from(S)
    .where(
      and(
        isNull(S.heldAt),
        lt(S.createdAt, ageFloor),
        ...(after ? [gt(S.createdAt, after)] : []),
        or(
          eq(S.status, "received"),
          and(
            eq(S.status, "running"),
            or(
              isNull(S.panelHeartbeatAt),
              lt(S.panelHeartbeatAt, staleBefore)
            )
          )
        )
      )
    )
    .orderBy(asc(S.createdAt))
    .limit(limit);
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
  // fromHeld (admin re-run) also claims pending_approval update rows. For
  // teammate/email updates a passing re-run lands back in pending_approval,
  // so a re-run can never sneak a swap past the approval click. A NEVER-HELD
  // admin web auto-approve row re-runs with the same authority it was
  // submitted with (a passing re-run swaps); any once-held row falls back to
  // the click because finishUpdateRow requires heldAt IS NULL.
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

async function uniqueSlug(
  title: string,
  id: string,
  companyId: string | null
): Promise<string> {
  // Company-lane slugs are NON-DERIVABLE from the title (§5.18): slugs are
  // globally unique, so a title-derived company slug colliding with a public
  // one would leak (via the -2 suffix) that a card of that name exists in
  // another tenant. The row id prefix carries no such inference.
  if (companyId !== null) return `team-${id.slice(0, 8)}`;
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
  const pre = await db
    .select({ companyId: S.companyId })
    .from(S)
    .where(eq(S.id, id))
    .limit(1);
  const slug = await uniqueSlug(card.title, id, pre[0]?.companyId ?? null);
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

/** The ONE primitive that swaps an approved update live (§5.16). Exactly two
 * callers: the admin approve route (click authority is the fence there; no
 * attempt id passed) and finishUpdateRow below (the admin web auto-approve
 * lane, which MUST pass its panel attempt id: without that fence a zombie
 * run from a superseded claim could swap a card a newer run owns, the exact
 * class the panel_attempt_id fencing exists to prevent). When
 * expectedAttemptId is given, the in-transaction re-check also requires the
 * row to still carry that attempt AND to be an autoApprove row.
 * Single transaction, both rows locked in id order:
 * parent -> superseded (slug freed FIRST: work_sub_slug_uq is not
 * deferrable, so the statement order is load-bearing), child -> published
 * with the parent's slug and publishedAt (the card keeps its deep link and
 * its slot in /work's newest-first display order; updatedAt carries the
 * swap time for the sitemap). If the parent is no longer published (deleted, pulled,
 * or superseded by a rival), the child is parked held with
 * UPDATE_CONFLICT_NOTE and NOTHING publishes standalone: a standalone
 * publish is how duplicate live cards get minted (refutation FATAL,
 * 2026-08-03). */
export async function publishWithSupersede(
  childId: string,
  expectedAttemptId?: string
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
      !child.cardJson ||
      // §5.18: the update lane is staff-only. A NULL-company child pointing
      // at a COMPANY parent would swap a private card onto the public page
      // (the child publishes with company_id NULL); the update route refuses
      // company parents, and this in-transaction re-check makes sure no
      // future caller can mint a cross-scope swap.
      child.companyId !== null ||
      parent?.companyId != null ||
      // Auto-approve lane only: the swap is fenced on the claiming attempt,
      // and only a NEVER-HELD row stamped autoApprove at intake may swap
      // without the admin click (heldAt re-checked INSIDE the txn: the gate
      // read it outside, and a conflict park in that gap must not be
      // swept past). An || anywhere in this predicate would let a spoofed
      // adam@xl.net EMAIL update publish itself; keep it strictly AND.
      (expectedAttemptId !== undefined &&
        (child.panelAttemptId !== expectedAttemptId ||
          !child.autoApprove ||
          child.heldAt !== null))
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
        // Rank from the LOCKED parent row, never the pre-transaction read: a
        // reorder can rewrite the parent's rank in the gap. The update
        // replaces the card in place, spot included (same rule as slug and
        // publishedAt above).
        displayRank: parent.displayRank,
        panelError: null,
        updatedAt: new Date(),
      })
      .where(eq(S.id, childId));
    return { ok: true as const, slug, card, parent };
  });
}

export type UpdateFinishResult =
  | { outcome: "superseded_claim" }
  | { outcome: "parked"; row: SubmissionRow }
  | { outcome: "swapped"; slug: string; card: WorkCard; parent: SubmissionRow }
  | { outcome: "conflict"; row: SubmissionRow }
  | { outcome: "raced" };

/** Terminal write for an update row's PASSING panel run (§5.16), factored
 * out of panel.ts so the real-DB test suite can exercise every interleave
 * with no brain and no email. Side effects (notify, revalidate, retention)
 * stay in panel.ts, keyed off the returned outcome.
 *
 * Sequence: park first (finishPendingApproval, fenced on attemptId - a
 * superseded claim stops here and never touches the swap), then gate, then
 * swap through publishWithSupersede WITH the attempt fence.
 *
 * The auto gate is strictly AND, never ||:
 * - parentId: SET NULL can orphan a child that still carries the flag; an
 *   orphan must never reach the swap.
 * - autoApprove: stamped only by the web update route under a
 *   verified-staff admin session. isAdmin(submitterEmail) alone would make
 *   every DKIM-spoofable adam@xl.net EMAIL update publish itself.
 * - heldAt IS NULL: a row that has EVER been held (gate failure, conflict
 *   park) has passed through a human-attention state; a later passing
 *   re-run must park for the click, not retry until the critic blinks.
 * - isAdmin re-check: an admin de-listed between submit and finish falls
 *   back to the park, the safe direction.
 *
 * Outcomes: "superseded_claim" = a newer claim owns the row, that run owns
 * all side effects. "parked" = ordinary pending_approval park (notify
 * pending). "swapped" = live swap done (notify + revalidate + retention).
 * "conflict" = target card gone, row parked held with UPDATE_CONFLICT_NOTE
 * (notify held). "raced" = a concurrent actor (admin approve, reject,
 * delete, rerun claim) won between park and swap; the winner owns every
 * side effect, so the caller must do NOTHING (a notification here would
 * email a falsehood about a row that is already live, deleted, or
 * re-running). */
export async function finishUpdateRow(
  id: string,
  attemptId: string,
  card: WorkCard,
  transcriptJson: string
): Promise<UpdateFinishResult> {
  const parked = await finishPendingApproval(
    id,
    attemptId,
    card,
    transcriptJson
  );
  if (!parked) return { outcome: "superseded_claim" };
  const row = await submissionById(id);
  if (!row) return { outcome: "raced" }; // deleted between park and re-read
  if (
    !row.parentId ||
    !row.autoApprove ||
    row.heldAt !== null ||
    !isAdmin(row.submitterEmail)
  )
    // "parked" only if the row genuinely still waits under OUR attempt; a
    // concurrent actor that already moved it (e.g. a click conflict-parked
    // it held in the park->re-read gap) owns the messaging, and a pending
    // email about a row in another state would be false.
    return row.status === "pending_approval" && row.panelAttemptId === attemptId
      ? { outcome: "parked", row }
      : { outcome: "raced" };
  const res = await publishWithSupersede(id, attemptId);
  if (res.ok)
    return { outcome: "swapped", slug: res.slug, card: res.card, parent: res.parent };
  if (res.reason === "conflict") {
    const held = await submissionById(id);
    return held ? { outcome: "conflict", row: held } : { outcome: "raced" };
  }
  // not_eligible straight after our own successful park cannot come from the
  // row's intrinsic state (we just wrote pending_approval with a parseable
  // card): a concurrent actor won the interleave. Re-read and only fall back
  // to "parked" if the row genuinely still waits under our attempt.
  const now = await submissionById(id);
  if (
    now &&
    now.status === "pending_approval" &&
    now.panelAttemptId === attemptId
  )
    return { outcome: "parked", row: now };
  return { outcome: "raced" };
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
        // The CHILD's rank is the card's live spot: a reorder after the swap
        // re-ranked the published child while this superseded parent's own
        // rank went stale (publishedCards never saw it), so restoring the
        // stale value could collide with another row's rank and move the
        // card. With no reorder in between the two are equal anyway.
        displayRank: child.displayRank,
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

/** Every submitter email in a card's supersede chain, the given row
 * included, lowercased (§5.16 chain ownership, 2026-08-04). Each approved
 * swap makes the updater's row the published one, so anchoring ownership on
 * submitter_email alone hands the card to the LAST updater and locks the
 * original author out (Adam updating a colleague's card on their behalf is
 * an advertised path). parent_id is SET NULL by deletes, so a broken link
 * simply ends the walk: ownership never crosses a deleted generation. */
export async function updateChainEmails(
  row: SubmissionRow
): Promise<Set<string>> {
  const emails = new Set<string>([row.submitterEmail.toLowerCase()]);
  let parentId = row.parentId;
  // Bounded walk: chains grow one generation per approved swap; 100 is far
  // beyond any real card and keeps a cyclic-data bug from spinning forever.
  for (let hops = 0; parentId && hops < 100; hops++) {
    const rows = await db
      .select({ submitterEmail: S.submitterEmail, parentId: S.parentId })
      .from(S)
      .where(eq(S.id, parentId))
      .limit(1);
    const parent = rows[0];
    if (!parent) break;
    emails.add(parent.submitterEmail.toLowerCase());
    parentId = parent.parentId;
  }
  return emails;
}

/** May this user propose an update to this published card? Admins always;
 * otherwise anyone who submitted a version in its supersede chain. Callers
 * fold a refusal into their existing 404/reject shape. */
export async function canProposeUpdate(
  row: SubmissionRow,
  email: string,
  admin: boolean
): Promise<boolean> {
  if (admin) return true;
  if (row.submitterEmail.toLowerCase() === email.toLowerCase()) return true;
  return (await updateChainEmails(row)).has(email.toLowerCase());
}

export type TransferCandidate = { email: string; name: string | null };

/**
 * Staff addresses to offer as transfer targets (§5.16 transfer round). A
 * CONVENIENCE for the typed field, never a gate: the route's only hard rule
 * is the lane's domain, because a colleague who started last week is in
 * none of these three sources and must still be able to receive work.
 *
 * Three sources, all already visible to a staff session:
 *  - the XL.net staff directory (company_people in the NULL lane), which
 *    /roadmap/directory renders in full to any staff viewer;
 *  - anyone who has ever signed in with an xl.net account;
 *  - anyone who already owns a public-lane submission.
 * Queried here rather than through roadmap/db.ts so the staff lane's
 * directory helpers keep their DirectoryScope contract untouched.
 */
export async function staffTransferCandidates(
  domain: string,
  limit = 500
): Promise<TransferCandidate[]> {
  // The domain is a code constant at every call site (WORK_SUBMIT_DOMAINS),
  // passed in rather than imported so this file keeps no edge back to
  // http.ts, which reaches the session and the roadmap.
  const lane = domain.trim().toLowerCase();
  const domainLike = `%@${lane}`;
  const [people, accounts, submitters] = await Promise.all([
    db
      .select({
        email: schema.companyPeople.email,
        name: schema.companyPeople.name,
      })
      .from(schema.companyPeople)
      .where(
        and(
          isNull(schema.companyPeople.companyId),
          isNotNull(schema.companyPeople.email),
          sql`lower(${schema.companyPeople.email}) like ${domainLike}`
        )
      )
      .limit(limit),
    db
      .select({
        email: schema.users.email,
        name: schema.users.displayName,
      })
      .from(schema.users)
      // emailDomain is a stored column, so no LIKE is needed here. Archived
      // accounts are excluded because they cannot sign in at all, and the
      // provider filter is the load-bearing one: a users row proves only that
      // SOMETHING signed in claiming that address, and the Microsoft
      // common-tenant lane will mint one for any email a free Entra tenant
      // asserts (the nOAuth argument at the head of src/lib/rfp/access.ts).
      // Advertising such a row as a colleague would put an attacker-planted
      // address in a picker people trust.
      //
      // RFP_PROVIDERS (google) and NOT isVerifiedStaffProvider, even after
      // the 2026-08-09 Microsoft-parity round, for a reason that is a
      // property of this query rather than a policy disagreement: Microsoft
      // staff trust rides the PER-LOGIN mv claim, which is HMAC-covered and
      // deliberately never stored on the users row, so a stored-row filter
      // has no evidence to read. Microsoft staff still reach this list
      // through the two sources that carry their own evidence - the staff
      // directory and prior public-lane submissions - and a colleague who
      // appears in neither is still a valid target, because the list is a
      // convenience and the lane's domain is the only hard rule.
      .where(
        and(
          eq(schema.users.emailDomain, lane),
          isNull(schema.users.archivedAt),
          inArray(schema.users.authProvider, [...RFP_PROVIDERS])
        )
      )
      .limit(limit),
    db
      .selectDistinct({ email: sql<string>`lower(${S.submitterEmail})` })
      .from(S)
      .where(
        and(isNull(S.companyId), sql`lower(${S.submitterEmail}) like ${domainLike}`)
      )
      .limit(limit),
  ]);
  // Email-keyed merge, first non-empty name wins. Directory rows are listed
  // first on purpose: they are the maintained source of real names.
  const byEmail = new Map<string, TransferCandidate>();
  const add = (email: string | null, name: string | null) => {
    const key = (email ?? "").trim().toLowerCase();
    if (!key) return;
    const seen = byEmail.get(key);
    if (!seen) byEmail.set(key, { email: key, name: name?.trim() || null });
    else if (!seen.name && name?.trim()) seen.name = name.trim();
  };
  for (const p of people) add(p.email, p.name);
  for (const a of accounts) add(a.email, a.name);
  for (const s of submitters) add(s.email, null);
  return [...byEmail.values()]
    .sort((a, b) => a.email.localeCompare(b.email))
    .slice(0, limit);
}

export type TransferResult =
  | { ok: true; row: SubmissionRow; previousEmail: string }
  | { ok: false; reason: "raced" };

/**
 * Move a submission to a new owner (§5.16 transfer round, owner directive
 * 2026-08-09). ONE statement, and it is a COMPARE-AND-SWAP: the WHERE pins
 * the owner the caller authorized against, so two people moving the same row
 * at once cannot both win and an admin acting on a stale "All submissions"
 * render cannot move a row out from under a transfer that already happened.
 *
 * What moves: submitter_email (the ownership anchor every gate reads) and
 * user_id (repointed to the recipient's site account, or NULL when they have
 * none, exactly as the email-intake lane already writes it).
 *
 * What does NOT move, deliberately:
 *  - creator_email, which is stamped once and is what the daily quota counts;
 *  - submitter_name and card_json, i.e. the PUBLISHED CREDIT. The card prints
 *    the first name the submitter chose to publish under; rewriting it here
 *    would republish public copy with no panel run and no lint, and there is
 *    no name to rewrite it TO (the recipient never typed one).
 *  - parent_id, so the update chain (and every earlier author's right to
 *    propose the next version) is untouched;
 *  - display_rank, slug, published_at: the card does not move on the page.
 */
export async function transferSubmission(opts: {
  id: string;
  toEmail: string;
  /** The owner the caller's authorization was decided against. */
  expectOwnerEmail: string;
  /** The status the caller's STATE gate was decided against. Pinned in the
   * WHERE because otherwise that gate is advisory: the route reads the row,
   * decides "not running", and writes milliseconds later, and a queue drain
   * tick in between turns the row into a live run whose outcome email would
   * then go to the previous owner. */
  expectStatus: string;
  /** The run identity the state gate saw, or null. Status alone is NOT
   * enough: `claimPanel` re-claims a STALE running row and leaves the status
   * at "running", which is precisely the case the gate deliberately admits,
   * so a status-only pin would still let a move land inside a freshly
   * claimed run. The attempt nonce is what changes on every claim. */
  expectAttemptId: string | null;
  toUserId: string | null;
}): Promise<TransferResult> {
  const previousEmail = opts.expectOwnerEmail;
  const res = await db
    .update(S)
    .set({
      submitterEmail: opts.toEmail,
      userId: opts.toUserId,
      // First move stamps the pre-move owner as the creator; later moves keep
      // the original. COALESCE, never a plain write, or a second transfer
      // would re-anchor the quota on an intermediate owner.
      creatorEmail: sql`coalesce(${S.creatorEmail}, ${S.submitterEmail})`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(S.id, opts.id),
        sql`lower(${S.submitterEmail}) = ${previousEmail.trim().toLowerCase()}`,
        eq(S.status, opts.expectStatus),
        opts.expectAttemptId === null
          ? isNull(S.panelAttemptId)
          : eq(S.panelAttemptId, opts.expectAttemptId)
      )
    )
    .returning(ROW_COLS);
  const row = res[0];
  if (!row) return { ok: false, reason: "raced" };
  return { ok: true, row, previousEmail };
}

/** The live (published) descendant of a superseded row, walking the swap
 * chain downward (§5.16). Feeds the status list's "Submit an update" link on
 * superseded rows: without it, a submitter whose card was last updated by
 * someone else has NO surface that offers updating again. At most one
 * published-or-superseded child exists per generation (the update route only
 * targets published rows, and rollback deletes the child it undoes); failed
 * children are skipped by the status filter. */
export async function liveDescendantId(id: string): Promise<string | null> {
  let cur = id;
  for (let hops = 0; hops < 100; hops++) {
    const rows = await db
      .select({ id: S.id, status: S.status })
      .from(S)
      .where(
        and(eq(S.parentId, cur), inArray(S.status, ["published", "superseded"]))
      )
      .orderBy(desc(S.createdAt))
      .limit(1);
    const child = rows[0];
    if (!child) return null;
    if (child.status === "published") return child.id;
    cur = child.id;
  }
  return null;
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
    // status running is load-bearing, not decorative: the runner's catch
    // calls this after ANY throw, including one thrown by a post-publish
    // side effect (retention email's DB reads). Without the predicate that
    // throw demotes an already-published row to failed - for a swapped
    // update child that vaporizes the live card with the parent stranded
    // superseded, which no route can recover (refutation MAJOR,
    // 2026-08-03 auto-approve round).
    .where(
      and(eq(S.id, id), eq(S.panelAttemptId, attemptId), eq(S.status, "running"))
    );
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
  const slug = await uniqueSlug(card.title, id, row.companyId ?? null);
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
      // The one published -> held -> published round trip (via approveHeld,
      // which stamps a fresh publishedAt): a retained rank would resurrect
      // stale and jump whichever card the admin has since moved into that
      // spot, so the row re-enters unranked (§5.16 reorder).
      displayRank: null,
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
  const slug = await uniqueSlug(title, id, row.companyId ?? null);
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

export type ReorderResult =
  | { ok: true; spot: number; laneSize: number; companyId: string | null }
  | { ok: false; reason: "not_published" | "conflict" };

/** Admin reorder (§5.16): move a published card to a 1-based spot within its
 * OWN lane and rewrite the lane's display_rank dense 1..k. The lane comes
 * from the row alone (the §5.18 tenancy rule: no caller-supplied scope can
 * reach another tenant's rows). One transaction; the lane's published rows
 * are locked FOR UPDATE in ascending id order — the same acquisition order
 * as publishWithSupersede and rollbackSwappedUpdate, so a reorder racing a
 * swap (the auto-approve lane runs with no human present) or a second
 * reorder serializes instead of deadlocking. The target must still be in
 * the locked set (a swap/hold/delete can win the gap: "conflict", caller
 * 409s). An overshooting spot clamps to the lane end — the race that
 * produces it is benign and the admin's toward-the-end intent survives —
 * so only malformed input (non-integer, < 1) is a caller-side 422.
 * Rows publishedCards would drop (unparseable card_json) get no rank and
 * count toward nothing: spot numbers here must mean what the page shows. */
export async function reorderPublishedCard(
  id: string,
  spot: number
): Promise<ReorderResult> {
  const pre = await submissionById(id);
  if (!pre || pre.status !== "published")
    return { ok: false, reason: "not_published" };
  const scope: WorkScope = { companyId: pre.companyId };
  return db.transaction(async (tx) => {
    // Locking select, REPEATED until two consecutive reads return the same
    // id set (refutation finding, 2026-08-04): READ COMMITTED re-evaluation
    // drops rows that LEFT the lane while we waited on their locks, but
    // never discovers rows that ENTERED it — a swap/rollback that held its
    // locks first commits a freshly published child (or re-published
    // parent) carrying an inherited rank, and a single-read rewrite would
    // hand that same rank to a different row. The second read's fresh
    // statement snapshot sees the committed newcomer and locks it too;
    // membership only churns while lane writers commit ahead of us, so the
    // set stabilizes almost immediately (bound is a backstop, not a path).
    const lockLane = () =>
      tx
        .select(ROW_COLS)
        .from(S)
        .where(
          and(inScope(scope), eq(S.status, "published"), isNotNull(S.cardJson))
        )
        .orderBy(S.id)
        .for("update");
    let locked = await lockLane();
    for (let tries = 0; ; tries++) {
      const again = await lockLane();
      const same =
        again.length === locked.length &&
        again.every((r, i) => r.id === locked[i].id);
      locked = again;
      if (same) break;
      if (tries >= 5) return { ok: false as const, reason: "conflict" as const };
    }
    // Mirror publishedCards' skip-malformed behavior so spot n on the
    // console is spot n on the page.
    const lane = locked.filter((r) => {
      try {
        JSON.parse(r.cardJson!);
        return true;
      } catch {
        return false;
      }
    });
    // Display order, re-derived under lock: rank ASC NULLS LAST, then
    // newest publish first (the publishedCards clause), id as a
    // deterministic final tie-break.
    lane.sort((a, b) => {
      const ra = a.displayRank ?? Number.MAX_SAFE_INTEGER;
      const rb = b.displayRank ?? Number.MAX_SAFE_INTEGER;
      if (ra !== rb) return ra - rb;
      const pa = (a.publishedAt ?? a.createdAt).getTime();
      const pb = (b.publishedAt ?? b.createdAt).getTime();
      if (pa !== pb) return pb - pa;
      return a.id < b.id ? -1 : 1;
    });
    const idx = lane.findIndex((r) => r.id === id);
    if (idx < 0) return { ok: false as const, reason: "conflict" as const };
    const target = Math.min(Math.max(1, Math.floor(spot)), lane.length) - 1;
    const [row] = lane.splice(idx, 1);
    lane.splice(target, 0, row);
    for (let i = 0; i < lane.length; i++) {
      if (lane[i].displayRank === i + 1) continue;
      await tx
        .update(S)
        .set({ displayRank: i + 1, updatedAt: new Date() })
        .where(eq(S.id, lane[i].id));
    }
    return {
      ok: true as const,
      spot: target + 1,
      laneSize: lane.length,
      companyId: pre.companyId,
    };
  });
}

/** Hard delete. Callers that decided on a STALE read (reject, plain admin
 * delete) must pass the status they observed: the auto-approve lane makes
 * pending_approval -> published an unsignalled machine transition, so a
 * click racing the swap could otherwise hard-delete a just-published child
 * and strand its parent superseded with no rollback child (unrecoverable
 * in-app). A null return means the row changed state (or vanished) since
 * the caller looked; the caller should 409, not retry blindly. */
export async function deleteSubmission(
  id: string,
  opts?: { expectStatus?: string }
): Promise<SubmissionRow | null> {
  const rows = await db
    .delete(S)
    .where(
      opts?.expectStatus
        ? and(eq(S.id, id), eq(S.status, opts.expectStatus))
        : eq(S.id, id)
    )
    .returning(ROW_COLS);
  return rows[0] ?? null;
}

/** The original upload(s) still on the ROW (§5.16): the package plus, on
 * CoWork Skill rows, the standalone SKILL.md. Empty on pre-retention rows
 * AND on rows whose bytea was cleared after publish (2026-08-19: cleared
 * only once the archive-store copy verifies on disk; store-first readers
 * fall back here, never the other way around). */
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

/** Drop the retained upload bytes from the ROW, unconditionally. UNCALLED
 * by production code, kept only as an explicit ops lever: since 2026-08-19
 * the one real clearing path is archive-store.ts verifyAndClearRowBytes
 * (called only from notify.ts deliverArchiveRetention), which re-verifies
 * the store copy under FOR UPDATE locks and clears in the same transaction
 * so admin cleanup cannot race it. This function has none of those guards
 * (the 2026-08-04 loss is what they exist for); test:work scrapes that no
 * src call site exists. */
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

/** An active (received/running/held) row from ANY submitter IN THIS SCOPE
 * whose normalized title matches; each lane is one page, a duplicate is a
 * duplicate — but two tenants may both build an "Outage Checker" (the 0035
 * per-tenant unique index is the backstop). */
export async function activeTitleClash(
  title: string,
  scope: WorkScope
): Promise<{ id: string; submitterEmail: string; status: string } | null> {
  const norm = normalizeTitle(title);
  const rows = await db
    .select({ id: S.id, submitterEmail: S.submitterEmail, status: S.status })
    .from(S)
    .where(
      and(
        inScope(scope),
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
  scope: WorkScope,
  opts?: { exceptId?: string }
): Promise<boolean> {
  const norm = normalizeTitle(title);
  const rows = await db
    .select({ id: S.id })
    .from(S)
    .where(
      and(
        inScope(scope),
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
  value: string,
  scope: WorkScope
): Promise<SubmissionRow | null> {
  const norm = normalizeTitle(value);
  if (!norm) return null;
  // Scope-filtered even though company updates are rejected in v1 (belt and
  // braces): a company sender's "Update Card:" must never resolve a PUBLIC
  // card into its update path.
  const published = and(
    inScope(scope),
    eq(S.status, "published"),
    isNotNull(S.cardJson)
  );
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

// ---- Company-scoped reads (§5.18) ----

/** EXISTS probe for the "Your Work" nav island: trusted same-domain session
 * AND at least one published company card. */
export async function hasPublishedCompanyWork(
  companyId: string
): Promise<boolean> {
  const rows = await db
    .select({ id: S.id })
    .from(S)
    .where(and(eq(S.companyId, companyId), eq(S.status, "published")))
    .limit(1);
  return rows.length > 0;
}

/** Durable per-company daily quota (countCreatedToday shape; failed rows
 * excluded so a pipeline error never eats a company's quota). */
export async function countCreatedTodayForCompany(
  companyId: string
): Promise<number> {
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(S)
    .where(
      and(
        eq(S.companyId, companyId),
        gte(S.createdAt, dayStart),
        ne(S.status, "failed")
      )
    );
  return rows[0]?.n ?? 0;
}

export type CompanySubmissionMeta = {
  id: string;
  title: string;
  kind: string;
  status: string;
  submitterEmail: string;
  createdAt: Date;
  publishedAt: Date | null;
};

/** Company-admin "in review" list: METADATA ONLY (title/status/dates/
 * submitter), never held or failed content, panel errors, or card drafts.
 * The one company-scoped lister a CLIENT session may reach. Two site-wide
 * listers exist beside it and both require the same XL.net staff-admin
 * predicate: allSubmissions (the GA-gated /admin/work) and, since the
 * 2026-08-09 transfer round, allSubmissionsForList (GET
 * /api/work/submissions?scope=all behind verifiedWebAdmin, which is that
 * same predicate expressed in code). Any THIRD cross-company read belongs
 * behind one of those two gates or nowhere. */
export async function companySubmissions(
  companyId: string,
  limit = 50
): Promise<CompanySubmissionMeta[]> {
  return db
    .select({
      id: S.id,
      title: S.title,
      kind: S.kind,
      status: S.status,
      submitterEmail: S.submitterEmail,
      createdAt: S.createdAt,
      publishedAt: S.publishedAt,
    })
    .from(S)
    .where(eq(S.companyId, companyId))
    .orderBy(desc(S.createdAt))
    .limit(limit);
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
