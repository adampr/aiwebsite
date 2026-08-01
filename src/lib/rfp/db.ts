// Knowledge-base reads for /rfp (ARCHITECTURE.md §5.17).
//
// Every query lives here rather than beside a route, matching src/lib/work/db.ts
// and src/lib/governance/db.ts. Selects are explicit column allowlists, not
// SELECT *, so a column added later cannot silently widen what a page renders.

import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  sql,
} from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import {
  rfpActivity,
  rfpDocuments,
  rfpFacts,
  rfpKbVersions,
  rfpKnowledgeProposals,
  rfpProposals,
  rfpQuestions,
  rfpRateCardItems,
  rfpRateCards,
  rfpRequirements,
} from "@/lib/db/rfp-schema";
import type { RfpUser } from "./access";

export type FactRow = typeof rfpFacts.$inferSelect;
export type QuestionRow = typeof rfpQuestions.$inferSelect;

export type RateCardView = {
  id: string;
  effectiveFrom: Date;
  minimumFullyManagedUsers: number;
  minimumMonthlyFeeCents: number;
  items: {
    code: string;
    label: string;
    unitPriceCents: number;
    unit: string;
    note: string | null;
  }[];
};

/** The highest knowledge-base version, or 0 when nothing has been seeded. */
export async function currentKbVersion(): Promise<number> {
  const rows = await db
    .select({ seq: rfpKbVersions.seq })
    .from(rfpKbVersions)
    .orderBy(desc(rfpKbVersions.seq))
    .limit(1);
  return rows[0]?.seq ?? 0;
}

/**
 * Live facts: everything not retired by a later knowledge-base version.
 *
 * A retired row is kept, never deleted, because a proposal that cited it must
 * stay resolvable and the correction history is what the stale-fact sweep
 * reads.
 */
export async function liveFacts(): Promise<FactRow[]> {
  return db
    .select()
    .from(rfpFacts)
    .where(isNull(rfpFacts.retiredInKb))
    .orderBy(asc(rfpFacts.key));
}

/**
 * EVERY fact row, retired included. The gate's C1 sweep must resolve a
 * superseded citation to the row that replaced it, so it needs the full
 * history, not the live view.
 */
export async function allFacts(): Promise<FactRow[]> {
  return db.select().from(rfpFacts).orderBy(asc(rfpFacts.key));
}

/**
 * Facts whose value was corrected, newest first.
 *
 * Note this reads the CORRECTING row (the one carrying correctedAt), not the
 * retired row it supersedes: a superseded fact's correctedAt is null.
 */
export async function correctedFacts(): Promise<FactRow[]> {
  return db
    .select()
    .from(rfpFacts)
    .where(isNotNull(rfpFacts.correctedAt))
    .orderBy(desc(rfpFacts.correctedAt));
}

export async function factCounts(): Promise<{
  live: number;
  negative: number;
  corrected: number;
  unconfirmed: number;
}> {
  const [row] = await db
    .select({
      live: sql<number>`count(*) filter (where ${rfpFacts.retiredInKb} is null)::int`,
      negative: sql<number>`count(*) filter (where ${rfpFacts.retiredInKb} is null and ${rfpFacts.polarity} = 'negative')::int`,
      corrected: sql<number>`count(*) filter (where ${rfpFacts.correctedAt} is not null)::int`,
      unconfirmed: sql<number>`count(*) filter (where ${rfpFacts.retiredInKb} is null and ${rfpFacts.confidence} = 'needs-adam')::int`,
    })
    .from(rfpFacts);
  return (
    row ?? { live: 0, negative: 0, corrected: 0, unconfirmed: 0 }
  );
}

/** The rate card in force, with its line items. Null when none is loaded. */
export async function currentRateCard(): Promise<RateCardView | null> {
  const cards = await db
    .select({
      id: rfpRateCards.id,
      effectiveFrom: rfpRateCards.effectiveFrom,
      minimumFullyManagedUsers: rfpRateCards.minimumFullyManagedUsers,
      minimumMonthlyFeeCents: rfpRateCards.minimumMonthlyFeeCents,
    })
    .from(rfpRateCards)
    .where(isNull(rfpRateCards.effectiveTo))
    .orderBy(desc(rfpRateCards.effectiveFrom))
    .limit(1);

  const card = cards[0];
  if (!card) return null;

  const items = await db
    .select({
      code: rfpRateCardItems.code,
      label: rfpRateCardItems.label,
      unitPriceCents: rfpRateCardItems.unitPriceCents,
      unit: rfpRateCardItems.unit,
      note: rfpRateCardItems.note,
    })
    .from(rfpRateCardItems)
    .where(eq(rfpRateCardItems.rateCardId, card.id))
    .orderBy(asc(rfpRateCardItems.code));

  return { ...card, items };
}

/** The intake questionnaire, in the order it is asked. */
export async function intakeQuestions(): Promise<QuestionRow[]> {
  return db.select().from(rfpQuestions).orderBy(asc(rfpQuestions.askOrder));
}

/** Integer cents to a display string. Money is never floated. */
export function usd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rest = String(abs % 100).padStart(2, "0");
  return `${sign}$${dollars.toLocaleString("en-US")}.${rest}`;
}

/* ==========================================================================
   RFP workspace reads and writes (§5.17 round 2).

   OWNERSHIP IS ENFORCED HERE, NOT IN ROUTES. Every accessor below takes the
   principal and applies scope itself. Admin-sees-all is a SEPARATE, clearly
   named function rather than a boolean that skips a where clause, because the
   two are different queries and a flag is one typo from leaking everything.

   Another user's object id yields null (rendered as 404), never 403: a 403
   confirms the row exists, which is the one bit an id-walking probe wants.
   ========================================================================== */


export type DocumentRow = typeof rfpDocuments.$inferSelect;
export type ProposalRow = typeof rfpProposals.$inferSelect;
export type RequirementRow = typeof rfpRequirements.$inferSelect;
export type KnowledgeProposalRow = typeof rfpKnowledgeProposals.$inferSelect;


/**
 * Resolve the users-row id for an email, or null.
 *
 * owner_email is the authoritative ownership field (it is what the visibility
 * predicate compares, and it survives a users-row deletion). owner_user_id is
 * the referential nicety, so it must never be able to fail a write: a session
 * can outlive its users row by up to the 30-day cookie TTL, and inserting an
 * id that is no longer there would 500 every create for that person.
 */
async function ownerUserIdFor(email: string): Promise<string | null> {
  try {
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email.toLowerCase()))
      .limit(1);
    return rows[0]?.id ?? null;
  } catch {
    return null;
  }
}

const own = (user: RfpUser) => eq(rfpDocuments.ownerEmail, user.email.toLowerCase());

/** The caller's own RFPs, newest activity first. */
export async function listMyDocuments(user: RfpUser): Promise<DocumentRow[]> {
  return db
    .select()
    .from(rfpDocuments)
    .where(own(user))
    .orderBy(desc(rfpDocuments.updatedAt));
}

/** EVERY RFP. Admin only — the caller must have checked, and we check again. */
export async function listAllDocuments(user: RfpUser): Promise<DocumentRow[]> {
  if (!user.admin) throw new Error("listAllDocuments: caller is not an admin");
  return db
    .select()
    .from(rfpDocuments)
    .orderBy(desc(rfpDocuments.updatedAt));
}

/**
 * One RFP the caller may see. Null when it does not exist OR belongs to
 * someone else and the caller is not an admin — the caller cannot tell which,
 * which is the point.
 */
export async function getDocument(
  user: RfpUser,
  id: string
): Promise<DocumentRow | null> {
  if (!isUuid(id)) return null;
  const rows = await db
    .select()
    .from(rfpDocuments)
    .where(
      user.admin
        ? eq(rfpDocuments.id, id)
        : and(eq(rfpDocuments.id, id), own(user))
    )
    .limit(1);
  return rows[0] ?? null;
}

/** A malformed id must not reach Postgres as a uuid cast (it throws 22P02). */
export function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

export async function createDocument(
  user: RfpUser,
  input: {
    title: string;
    clientName: string | null;
    sourceKind: string;
    sourceName: string | null;
    sourceSha256: string | null;
    sourceBytes: number | null;
    rawText: string;
    injectionFlagged: boolean;
  }
): Promise<DocumentRow> {
  const [row] = await db
    .insert(rfpDocuments)
    .values({
      ownerUserId: await ownerUserIdFor(user.email),
      ownerEmail: user.email.toLowerCase(),
      title: input.title.slice(0, 300),
      clientName: input.clientName?.slice(0, 200) ?? null,
      sourceKind: input.sourceKind,
      sourceName: input.sourceName?.slice(0, 300) ?? null,
      sourceSha256: input.sourceSha256,
      sourceBytes: input.sourceBytes,
      rawText: input.rawText,
      injectionFlagged: input.injectionFlagged,
      // "reading" until the background readRfp finishes; the after() worker
      // stamps "extracted" (or "read_failed"). Inserting "extracted" here
      // used to make the ingest poll's status check meaningless, which is
      // why it once needed a fragile requirements>0 side-channel.
      status: "reading",
    })
    .returning();
  return row!;
}

export async function listRequirements(
  documentId: string
): Promise<RequirementRow[]> {
  if (!isUuid(documentId)) return [];
  return db
    .select()
    .from(rfpRequirements)
    .where(eq(rfpRequirements.documentId, documentId))
    .orderBy(rfpRequirements.ordinal);
}

export async function replaceRequirements(
  documentId: string,
  rows: {
    structureLabel: string;
    text: string;
    ordinal: number;
    kind: string;
    mandatory: boolean;
  }[]
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(rfpRequirements)
      .where(eq(rfpRequirements.documentId, documentId));
    if (rows.length)
      await tx
        .insert(rfpRequirements)
        .values(rows.map((r) => ({ ...r, documentId })));
  });
}

/* ---- proposals (drafts) ------------------------------------------------ */

export async function getProposalForDocument(
  documentId: string
): Promise<ProposalRow | null> {
  if (!isUuid(documentId)) return null;
  const rows = await db
    .select()
    .from(rfpProposals)
    .where(
      and(
        eq(rfpProposals.documentId, documentId),
        ne(rfpProposals.status, "superseded")
      )
    )
    .orderBy(desc(rfpProposals.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * By id, UNSCOPED — for re-reads AFTER an ownership check has passed on the
 * same id (the gap route's post-brain-call refresh). Never call this with an
 * id from a request that has not been through getOwnedProposal.
 */
export async function getProposalById(id: string): Promise<ProposalRow | null> {
  if (!isUuid(id)) return null;
  const rows = await db
    .select()
    .from(rfpProposals)
    .where(eq(rfpProposals.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Create-or-converge: one ACTIVE proposal per document. A partial unique
 * index (rfp_proposals_doc_active_uq, status <> 'superseded', migration
 * 0030) backs this — two racing first-generate calls (the ?draft=all
 * handoff in two tabs is the realistic trigger) previously BOTH inserted,
 * and every later read bound to the newest row while the loser's worker
 * drafted onto an invisible orphan. Now the loser's insert violates the
 * index and converges on the winner's row.
 */
export async function createProposal(
  user: RfpUser,
  documentId: string,
  title: string,
  kbVersion: number
): Promise<ProposalRow> {
  try {
    const [row] = await db
      .insert(rfpProposals)
      .values({
        documentId,
        ownerUserId: await ownerUserIdFor(user.email),
        ownerEmail: user.email.toLowerCase(),
        title: title.slice(0, 300),
        draftedAgainstKbVersion: kbVersion,
      })
      .returning();
    return row!;
  } catch (err) {
    const existing = await getProposalForDocument(documentId);
    if (existing) return existing;
    throw err;
  }
}

/**
 * Fenced write. Succeeds only if `rev` is still what the caller read, so two
 * people editing the same draft cannot silently overwrite each other and a
 * stale generation worker cannot land on a document that moved underneath it.
 */
export async function writeProposalSections(
  proposalId: string,
  expectedRev: number,
  sectionsJson: string,
  extra: Partial<{
    gateJson: string | null;
    gateRanAt: Date | null;
    genProgress: string | null;
    genError: string | null;
    genStartedAt: Date | null;
    genAttemptId: string | null;
    genHeartbeatAt: Date | null;
  }> = {}
): Promise<boolean> {
  const res = await db
    .update(rfpProposals)
    .set({
      sectionsJson,
      rev: expectedRev + 1,
      updatedAt: new Date(),
      // A content write stales any stored gate verdict; a Checks pane
      // showing "passing" for a draft that has since changed would lie.
      gateJson: null,
      gateRanAt: null,
      ...extra,
    })
    .where(
      and(eq(rfpProposals.id, proposalId), eq(rfpProposals.rev, expectedRev))
    )
    .returning({ id: rfpProposals.id });
  return res.length > 0;
}

/**
 * One proposal the caller may see. Same null-means-404 contract as
 * getDocument. Ownership lives here, not in routes.
 */
export async function getOwnedProposal(
  user: RfpUser,
  id: string
): Promise<ProposalRow | null> {
  if (!isUuid(id)) return null;
  const rows = await db
    .select()
    .from(rfpProposals)
    .where(
      user.admin
        ? eq(rfpProposals.id, id)
        : and(
            eq(rfpProposals.id, id),
            eq(rfpProposals.ownerEmail, user.email.toLowerCase())
          )
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Fenced write of the pricing inputs + computed quote. Same CAS as
 * writeProposalSections: pricing changes bump `rev`, so a generation worker
 * or a second editor cannot silently interleave with a quote rebuild.
 */
export async function writeProposalPricing(
  proposalId: string,
  expectedRev: number,
  pricingInputsJson: string,
  pricingJson: string | null
): Promise<boolean> {
  const res = await db
    .update(rfpProposals)
    .set({
      pricingInputsJson,
      pricingJson,
      rev: expectedRev + 1,
      updatedAt: new Date(),
      gateJson: null,
      gateRanAt: null,
    })
    .where(
      and(eq(rfpProposals.id, proposalId), eq(rfpProposals.rev, expectedRev))
    )
    .returning({ id: rfpProposals.id });
  return res.length > 0;
}

/** Store a gate run. Does NOT bump rev: the gate reads, it never edits. */
export async function writeProposalGate(
  proposalId: string,
  gateJson: string
): Promise<void> {
  await db
    .update(rfpProposals)
    .set({ gateJson, gateRanAt: new Date(), updatedAt: new Date() })
    .where(eq(rfpProposals.id, proposalId));
}

/**
 * A claim with no LIFE SIGN for this long is dead, not busy. The brain call
 * is capped at 120s, but it sits behind a shared 2-slot semaphore whose
 * queue wait is unbounded, so staleness is measured against the newer of
 * genStartedAt and genHeartbeatAt (the worker heartbeats every 60s while it
 * queues and drafts) — wall-clock-since-claim alone would reclaim a healthy
 * queued worker and drop its finished draft. Before the horizon existed at
 * all, one crashed `after()` made a proposal undraftable forever: every
 * later generate saw genStartedAt set and returned 409. The attempt id
 * fences the other side: a reclaimed worker that wakes up writes nothing.
 */
const STALE_CLAIM_MS = 4 * 60 * 1000;

export function genClaimActive(
  p: Pick<ProposalRow, "genStartedAt" | "genHeartbeatAt">,
  now = Date.now()
): boolean {
  if (!p.genStartedAt) return false;
  const lastSign = Math.max(
    p.genStartedAt.getTime(),
    p.genHeartbeatAt?.getTime() ?? 0
  );
  return now - lastSign < STALE_CLAIM_MS;
}

/**
 * Heartbeat for a live generation attempt, fenced on the attempt id. The
 * brain call sits behind a shared 2-slot semaphore whose queue wait is
 * unbounded, so wall-clock-since-claim alone would reclaim a HEALTHY queued
 * worker; staleness is measured against the newer of started/heartbeat.
 */
export async function heartbeatGeneration(
  proposalId: string,
  attemptId: string
): Promise<void> {
  await db
    .update(rfpProposals)
    .set({ genHeartbeatAt: new Date() })
    .where(
      and(
        eq(rfpProposals.id, proposalId),
        eq(rfpProposals.genAttemptId, attemptId)
      )
    );
}

/**
 * Clear a generation claim WITHOUT touching sections. Fenced on the attempt
 * id only (no rev CAS): no other writer touches the gen columns without
 * first changing the attempt id, so this cannot race, and it is the escape
 * hatch when the completion write loses its rev CAS repeatedly — otherwise
 * the claim would sit until the stale horizon with no error recorded.
 */
export async function clearGenClaim(
  proposalId: string,
  attemptId: string,
  genError: string | null
): Promise<void> {
  await db
    .update(rfpProposals)
    .set({
      genStartedAt: null,
      genAttemptId: null,
      genHeartbeatAt: null,
      genProgress: null,
      genError,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(rfpProposals.id, proposalId),
        eq(rfpProposals.genAttemptId, attemptId)
      )
    );
}

/**
 * Completion write for a generation attempt. Lands ONLY while the claim
 * still belongs to this attempt: a worker that hung past the stale-claim
 * horizon and was reclaimed writes nothing, rather than clobbering the
 * reclaiming attempt's sections or clearing its in-flight marker.
 */
export async function completeGeneration(
  proposalId: string,
  expectedRev: number,
  attemptId: string,
  sectionsJson: string,
  extra: Partial<{ genError: string | null }> = {}
): Promise<boolean> {
  const res = await db
    .update(rfpProposals)
    .set({
      sectionsJson,
      rev: expectedRev + 1,
      genStartedAt: null,
      genAttemptId: null,
      genHeartbeatAt: null,
      genProgress: null,
      genError: null,
      gateJson: null,
      gateRanAt: null,
      updatedAt: new Date(),
      ...extra,
    })
    .where(
      and(
        eq(rfpProposals.id, proposalId),
        eq(rfpProposals.rev, expectedRev),
        eq(rfpProposals.genAttemptId, attemptId)
      )
    )
    .returning({ id: rfpProposals.id });
  return res.length > 0;
}

/* ---- knowledge proposals ------------------------------------------------ */

/** The caller's own proposed knowledge, any status. */
export async function listMyKnowledge(
  user: RfpUser
): Promise<KnowledgeProposalRow[]> {
  return db
    .select()
    .from(rfpKnowledgeProposals)
    .where(eq(rfpKnowledgeProposals.ownerEmail, user.email.toLowerCase()))
    .orderBy(desc(rfpKnowledgeProposals.createdAt));
}

/** Everything awaiting an admin decision. Admin only. */
export async function listPendingKnowledge(
  user: RfpUser
): Promise<KnowledgeProposalRow[]> {
  if (!user.admin) throw new Error("listPendingKnowledge: caller is not an admin");
  return db
    .select()
    .from(rfpKnowledgeProposals)
    .where(eq(rfpKnowledgeProposals.status, "submitted"))
    .orderBy(rfpKnowledgeProposals.createdAt);
}

export async function createKnowledgeProposal(
  user: RfpUser,
  input: {
    kind: "fact" | "choice";
    factKey: string | null;
    category: string;
    statement: string;
    detail: string | null;
    polarity: "affirmative" | "negative";
    documentId: string | null;
    submit: boolean;
  }
): Promise<KnowledgeProposalRow> {
  const [row] = await db
    .insert(rfpKnowledgeProposals)
    .values({
      ownerUserId: await ownerUserIdFor(user.email),
      ownerEmail: user.email.toLowerCase(),
      kind: input.kind,
      factKey: input.factKey?.slice(0, 120) ?? null,
      category: input.category.slice(0, 60),
      statement: input.statement.slice(0, 2000),
      detail: input.detail?.slice(0, 2000) ?? null,
      polarity: input.polarity,
      documentId: input.documentId,
      status: input.submit ? "submitted" : "private",
    })
    .returning();
  return row!;
}

export async function getKnowledgeProposal(
  user: RfpUser,
  id: string
): Promise<KnowledgeProposalRow | null> {
  if (!isUuid(id)) return null;
  const rows = await db
    .select()
    .from(rfpKnowledgeProposals)
    .where(
      user.admin
        ? eq(rfpKnowledgeProposals.id, id)
        : and(
            eq(rfpKnowledgeProposals.id, id),
            eq(rfpKnowledgeProposals.ownerEmail, user.email.toLowerCase())
          )
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Approve proposed knowledge into the shared base.
 *
 * INSERTS a brand new rfp_facts row at a new KB version. It never flips a
 * flag on an existing row and never mutates the proposal into a fact,
 * because an approved fact's id must never have been anything else: rule C1's
 * staleness sweep and every stored citation key off that id.
 *
 * Only `kind === "fact"` is promotable. A choice is a decision about one
 * proposal; promoting it would assert it about the company forever.
 */
export async function approveKnowledge(
  admin: RfpUser,
  id: string,
  confidence: "confirmed" | "needs-adam"
): Promise<{ ok: true; factId: string } | { ok: false; reason: string }> {
  if (!admin.admin) throw new Error("approveKnowledge: caller is not an admin");
  const prop = await getKnowledgeProposal(admin, id);
  if (!prop) return { ok: false, reason: "not_found" };
  if (prop.status !== "submitted")
    return { ok: false, reason: "not_awaiting_review" };
  if (prop.kind !== "fact")
    return { ok: false, reason: "a choice is never promotable to a fact" };
  if (!prop.factKey) return { ok: false, reason: "missing fact key" };

  const nextSeq = (await currentKbVersion()) + 1;
  const factId = `fact_${prop.factKey.replace(/[^a-z0-9]+/gi, "_")}_v${nextSeq}`;
  const now = new Date();

  await db.transaction(async (tx) => {
    await tx.insert(rfpKbVersions).values({
      id: `kb_${nextSeq}`,
      seq: nextSeq,
      createdAt: now,
      note: `Approved knowledge from ${prop.ownerEmail}`,
    });
    await tx.insert(rfpFacts).values({
      id: factId,
      key: prop.factKey!,
      category: prop.category,
      statement: prop.statement,
      polarity: prop.polarity,
      detail: prop.detail,
      sourceUrl: null,
      verifiedAt: null,
      correctedAt: null,
      supersedes: null,
      introducedInKb: nextSeq,
      retiredInKb: null,
      confidence,
    });
    await tx
      .update(rfpKnowledgeProposals)
      .set({
        status: "approved",
        promotedFactId: factId,
        reviewedBy: admin.email,
        reviewedAt: now,
        updatedAt: now,
      })
      .where(eq(rfpKnowledgeProposals.id, id));
  });

  return { ok: true, factId };
}

export async function returnKnowledge(
  admin: RfpUser,
  id: string,
  note: string
): Promise<boolean> {
  if (!admin.admin) throw new Error("returnKnowledge: caller is not an admin");
  if (!isUuid(id)) return false;
  const res = await db
    .update(rfpKnowledgeProposals)
    .set({
      status: "returned",
      reviewedBy: admin.email,
      reviewedAt: new Date(),
      reviewNote: note.slice(0, 1000),
      updatedAt: new Date(),
    })
    .where(eq(rfpKnowledgeProposals.id, id))
    .returning({ id: rfpKnowledgeProposals.id });
  return res.length > 0;
}

/**
 * Private knowledge rows for a specific OWNER (by email), for resolving a
 * draft's `pending_*` citations no matter who runs the gate. An admin
 * gating another user's draft must see the DRAFTER's private rows — using
 * the caller's would hard-block rule A5 on citations that are perfectly
 * resolvable, and persist that wrong verdict onto the owner's proposal.
 * Read-only fact resolution: nothing here widens whose drafts see the rows.
 */
export async function knowledgeProposalsForOwner(
  ownerEmail: string
): Promise<KnowledgeProposalRow[]> {
  return db
    .select()
    .from(rfpKnowledgeProposals)
    .where(
      and(
        eq(rfpKnowledgeProposals.ownerEmail, ownerEmail.toLowerCase()),
        eq(rfpKnowledgeProposals.kind, "fact"),
        inArray(rfpKnowledgeProposals.status, ["private", "submitted"])
      )
    );
}

/**
 * The drafting snapshot for ONE user: the shared corpus plus that user's own
 * private knowledge. Never another user's. Private rows arrive as
 * confidence "needs-adam" so the drafter treats them as provisional.
 */
export async function knowledgeForUser(user: RfpUser): Promise<{
  shared: FactRow[];
  mine: KnowledgeProposalRow[];
}> {
  const [shared, mine] = await Promise.all([
    liveFacts(),
    db
      .select()
      .from(rfpKnowledgeProposals)
      .where(
        and(
          eq(rfpKnowledgeProposals.ownerEmail, user.email.toLowerCase()),
          eq(rfpKnowledgeProposals.kind, "fact"),
          inArray(rfpKnowledgeProposals.status, ["private", "submitted"])
        )
      ),
  ]);
  return { shared, mine };
}

/* ---- activity ----------------------------------------------------------- */

export async function recentActivity(
  user: RfpUser,
  limit = 200
): Promise<(typeof rfpActivity.$inferSelect)[]> {
  if (!user.admin) throw new Error("recentActivity: caller is not an admin");
  return db
    .select()
    .from(rfpActivity)
    .orderBy(desc(rfpActivity.at))
    .limit(Math.min(limit, 500));
}
