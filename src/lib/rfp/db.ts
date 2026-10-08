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
  lt,
  ne,
  or,
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
  rfpReferences,
  rfpRequirements,
} from "@/lib/db/rfp-schema";
import type { RfpUser } from "./access";
import type {
  ReferenceCandidateWire,
  ReferenceEntry,
} from "./references-block";
import { corpusCategory } from "./knowledge-mine";
import { RFP_READ_STALE_MS } from "./intake";

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
  // LIVE corrections only: after a correct-then-correct chain the retired
  // intermediate correction also carries correctedAt, and listing it made
  // the panel read as though two competing fixes were in force.
  return db
    .select()
    .from(rfpFacts)
    .where(and(isNotNull(rfpFacts.correctedAt), isNull(rfpFacts.retiredInKb)))
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

/** The caller's own ACTIVE RFPs, newest activity first. Archived rows leave
 *  this list (that is what archiving means) but stay readable by id, and an
 *  admin sees them in the Archive subsection of /rfp/list. */
export async function listMyDocuments(user: RfpUser): Promise<DocumentRow[]> {
  return db
    .select()
    .from(rfpDocuments)
    .where(and(own(user), isNull(rfpDocuments.archivedAt)))
    .orderBy(desc(rfpDocuments.updatedAt));
}

/** EVERY RFP, archived included. Admin only — the caller must have checked,
 *  and we check again. The list page splits active from archived itself. */
export async function listAllDocuments(user: RfpUser): Promise<DocumentRow[]> {
  if (!user.admin) throw new Error("listAllDocuments: caller is not an admin");
  return db
    .select()
    .from(rfpDocuments)
    .orderBy(desc(rfpDocuments.updatedAt));
}

/**
 * Archive or restore one RFP. An owner archives their OWN (it leaves their
 * list, which is the point); an admin can archive or restore anyone's.
 *
 * RESTORING IS AN ADMIN ACTION IN PRACTICE: once archived, the row is gone
 * from the owner's list, so the owner has nowhere to click Restore. The
 * predicate still permits it so the capability is not lost if an owner-side
 * archive view is added. Never destructive — the row and its draft stay
 * readable by id, and the admin list shows archived rows in a subsection.
 */
export async function setDocumentArchived(
  user: RfpUser,
  id: string,
  archived: boolean
): Promise<boolean> {
  if (!isUuid(id)) return false;
  const res = await db
    .update(rfpDocuments)
    .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
    .where(
      user.admin
        ? eq(rfpDocuments.id, id)
        : and(eq(rfpDocuments.id, id), own(user))
    )
    .returning({ id: rfpDocuments.id });
  return res.length > 0;
}

/**
 * How many knowledge proposals point at this document. Read BEFORE a delete:
 * the cascade nulls their document_id rather than removing them (they are
 * promotable company facts), so afterwards nothing can find them again.
 */
export async function countKnowledgeForDocument(
  documentId: string
): Promise<number> {
  if (!isUuid(documentId)) return 0;
  const rows = await db
    .select({ id: rfpKnowledgeProposals.id })
    .from(rfpKnowledgeProposals)
    .where(eq(rfpKnowledgeProposals.documentId, documentId));
  return rows.length;
}

/**
 * Delete one RFP outright, ADMIN ONLY: the document row cascades to its
 * requirements and proposals (schema FKs), taking the draft with it. The
 * activity log keeps the shape-only trail; knowledge proposals that
 * referenced the document survive with document_id set null.
 */
export async function deleteDocument(
  admin: RfpUser,
  id: string
): Promise<boolean> {
  if (!admin.admin) throw new Error("deleteDocument: caller is not an admin");
  if (!isUuid(id)) return false;
  const res = await db
    .delete(rfpDocuments)
    .where(eq(rfpDocuments.id, id))
    .returning({ id: rfpDocuments.id });
  return res.length > 0;
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

/**
 * Claim a document for reading again, as ONE conditional UPDATE to
 * "reading", so a second click, tab or person gets null instead of starting
 * a parallel read. Claimable: a failed read, a "reading" row older than any
 * live reader could be, and an "extracted" row with no section structure
 * (a read that found nothing to draft, §5.17.17). Null when the row is in
 * none of those states or does not exist; the caller reports which.
 */
export async function claimReread(
  docId: string
): Promise<{
  title: string;
  rawText: string;
  sourceName: string | null;
  sourceKind: string;
} | null> {
  if (!isUuid(docId)) return null;
  const staleBefore = new Date(Date.now() - RFP_READ_STALE_MS);
  const claimed = await db
    .update(rfpDocuments)
    .set({ status: "reading", updatedAt: new Date() })
    .where(
      and(
        eq(rfpDocuments.id, docId),
        or(
          eq(rfpDocuments.status, "read_failed"),
          and(
            eq(rfpDocuments.status, "reading"),
            lt(rfpDocuments.updatedAt, staleBefore)
          ),
          and(
            eq(rfpDocuments.status, "extracted"),
            or(
              isNull(rfpDocuments.structureJson),
              eq(rfpDocuments.structureJson, "[]")
            )
          )
        )
      )
    )
    .returning({
      title: rfpDocuments.title,
      rawText: rfpDocuments.rawText,
      sourceName: rfpDocuments.sourceName,
      sourceKind: rfpDocuments.sourceKind,
    });
  return claimed[0] ?? null;
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
  kbVersion: number,
  // Seeded pricing inputs (the document's grounded stated-staff count).
  // Creation-time only, never an update: an existing proposal's inputs are
  // never overwritten, and two racing creators compute the identical seed
  // from the same immutable document row before the unique index converges
  // them.
  seedPricingInputsJson?: string | null
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
        pricingInputsJson: seedPricingInputsJson ?? null,
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
      // A content write no longer nulls the stored gate verdict (round 18,
      // §5.17.8): the result carries the rev it ran at (`atRev`), so the
      // Checks pane keeps the findings on screen and marks them stale
      // instead of wiping them; the rev bump below is what makes them stale.
      ...extra,
    })
    .where(
      and(eq(rfpProposals.id, proposalId), eq(rfpProposals.rev, expectedRev))
    )
    .returning({ id: rfpProposals.id });
  return res.length > 0;
}

/**
 * Structure-level accept (§5.17.1 Tron retitle/remove): ONE transaction
 * updates the proposal's sections (same CAS-on-rev contract as
 * writeProposalSections, including the gate stale-out), the document's
 * structure_json, and the requirements rows that key Coverage by
 * structure_label (renamed on a retitle that renames the label, deleted on
 * a remove — a removed section's asks nagging "Not yet" forever would
 * contradict the removal the owner just accepted). The CAS runs FIRST so a
 * conflict leaves document and requirements untouched.
 */
export async function writeProposalStructureOp(opts: {
  proposalId: string;
  expectedRev: number;
  sectionsJson: string;
  documentId: string;
  structureJson: string;
  renameLabel?: { from: string; to: string };
  removeLabel?: string;
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    const res = await tx
      .update(rfpProposals)
      .set({
        sectionsJson: opts.sectionsJson,
        rev: opts.expectedRev + 1,
        updatedAt: new Date(),
        // The stored gate verdict stays; the rev bump marks it stale (§5.17.8).
      })
      .where(
        and(
          eq(rfpProposals.id, opts.proposalId),
          eq(rfpProposals.rev, opts.expectedRev)
        )
      )
      .returning({ id: rfpProposals.id });
    if (res.length === 0) return false;
    await tx
      .update(rfpDocuments)
      .set({ structureJson: opts.structureJson, updatedAt: new Date() })
      .where(eq(rfpDocuments.id, opts.documentId));
    if (opts.renameLabel)
      await tx
        .update(rfpRequirements)
        .set({ structureLabel: opts.renameLabel.to })
        .where(
          and(
            eq(rfpRequirements.documentId, opts.documentId),
            eq(rfpRequirements.structureLabel, opts.renameLabel.from)
          )
        );
    if (opts.removeLabel !== undefined)
      await tx
        .delete(rfpRequirements)
        .where(
          and(
            eq(rfpRequirements.documentId, opts.documentId),
            eq(rfpRequirements.structureLabel, opts.removeLabel)
          )
        );
    return true;
  });
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
      // The stored gate verdict stays; the rev bump marks it stale (§5.17.8).
    })
    .where(
      and(eq(rfpProposals.id, proposalId), eq(rfpProposals.rev, expectedRev))
    )
    .returning({ id: rfpProposals.id });
  return res.length > 0;
}

/**
 * The checks-ignores column alone, read FRESH. The gate assembly plus the 26
 * rules take long enough that an Ignore can land mid-run; a store site that
 * applied the dismissals from its pre-run proposal snapshot would then write
 * a gate_json missing the new mark (self-healing on the next store, but the
 * pane visibly pops the row back out of Ignored). Re-reading just before the
 * store narrows that window from the whole run to milliseconds.
 */
export async function readProposalChecksIgnores(
  proposalId: string
): Promise<string | null> {
  if (!isUuid(proposalId)) return null;
  const rows = await db
    .select({ checksIgnoresJson: rfpProposals.checksIgnoresJson })
    .from(rfpProposals)
    .where(eq(rfpProposals.id, proposalId))
    .limit(1);
  return rows[0]?.checksIgnoresJson ?? null;
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
 * Read-modify-write of the two Checks-pane columns (checks_ignores_json +
 * gate_json) in ONE transaction, under SELECT ... FOR UPDATE on the proposal
 * row: two racing ignores (or an ignore racing a gate re-run's store) must
 * compose, not drop each other, and the caller's sig validation must run
 * against the row AS LOCKED, so `mutate` receives the in-tx values and its
 * verdict decides the write.
 *
 * Deliberately NO rev bump: rev fences section CONTENT (writeProposalSections
 * et al.), and an ignore changes none — bumping it here would 409 a
 * concurrent editor's CAS for no content change. `mutate` is synchronous and
 * pure; returning null aborts with nothing written (the caller records why in
 * its own closure). Both columns land in one UPDATE.
 */
export async function writeProposalChecksState(
  proposalId: string,
  mutate: (current: {
    status: string;
    gateJson: string | null;
    checksIgnoresJson: string | null;
  }) => { ignoresJson: string; gateJson: string } | null
): Promise<boolean> {
  if (!isUuid(proposalId)) return false;
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        status: rfpProposals.status,
        gateJson: rfpProposals.gateJson,
        checksIgnoresJson: rfpProposals.checksIgnoresJson,
      })
      .from(rfpProposals)
      .where(eq(rfpProposals.id, proposalId))
      .limit(1)
      .for("update");
    const row = rows[0];
    if (!row) return false;
    const next = mutate(row);
    if (!next) return false;
    await tx
      .update(rfpProposals)
      .set({
        checksIgnoresJson: next.ignoresJson,
        gateJson: next.gateJson,
        updatedAt: new Date(),
      })
      .where(eq(rfpProposals.id, proposalId));
    return true;
  });
}

/**
 * A claim with no LIFE SIGN for this long is dead, not busy. The brain call
 * is capped at 120 s (150 s with visuals), but it sits behind a shared 2-slot semaphore whose
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
      // The stored gate verdict stays; the rev bump marks it stale (§5.17.8).
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
  // An admin may promote their OWN row straight from private/returned
  // (§5.17.9, "Add to the shared base" on /rfp/knowledge/mine). Anyone
  // else's row must have been SENT: nobody's private text goes shared
  // unasked, and the review queue only ever lists submitted rows.
  const own = prop.ownerEmail === admin.email.toLowerCase();
  if (
    prop.status !== "submitted" &&
    !(own && (prop.status === "private" || prop.status === "returned"))
  )
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
      // Steered onto the corpus list: a proposal can carry the add form's
      // legacy "general", which is not a FactCategory.
      category: corpusCategory(prop.category),
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

/* ---- your own knowledge: edit, move, delete (§5.17.9) ------------------ */

/**
 * One of the CALLER'S OWN proposals, admin or not. The Yours page and its
 * routes are owner-scoped on purpose: an admin changes other people's rows
 * only through the review queue (approve / return), never by editing their
 * text. Someone else's id is a 404, never a 403.
 */
export async function getMyKnowledgeProposal(
  user: RfpUser,
  id: string
): Promise<KnowledgeProposalRow | null> {
  if (!isUuid(id)) return null;
  const rows = await db
    .select()
    .from(rfpKnowledgeProposals)
    .where(
      and(
        eq(rfpKnowledgeProposals.id, id),
        eq(rfpKnowledgeProposals.ownerEmail, user.email.toLowerCase())
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Edit the caller's own row IN PLACE. The id, and so every `pending_<id>`
 * citation in the owner's drafts, survives the edit. Approved rows are
 * frozen (the where clause excludes them): the minted shared fact is the
 * truth now and corrections go through correctFact. Returns null when the
 * row is not the caller's, does not exist, or is approved.
 */
export async function updateKnowledgeProposal(
  user: RfpUser,
  id: string,
  fields: {
    kind: "fact" | "choice";
    factKey: string | null;
    category: string;
    statement: string;
    detail: string | null;
    polarity: "affirmative" | "negative";
  }
): Promise<KnowledgeProposalRow | null> {
  if (!isUuid(id)) return null;
  const [row] = await db
    .update(rfpKnowledgeProposals)
    .set({
      kind: fields.kind,
      factKey: fields.factKey?.slice(0, 120) ?? null,
      category: fields.category.slice(0, 60),
      statement: fields.statement.slice(0, 2000),
      detail: fields.detail?.slice(0, 2000) ?? null,
      polarity: fields.polarity,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(rfpKnowledgeProposals.id, id),
        eq(rfpKnowledgeProposals.ownerEmail, user.email.toLowerCase()),
        ne(rfpKnowledgeProposals.status, "approved")
      )
    )
    .returning();
  return row ?? null;
}

/**
 * Move the caller's own row between private and submitted. Guarded on the
 * statuses it may LEAVE from, so a row an admin approved a moment ago is
 * never written back to private or submitted by a stale click.
 */
export async function setKnowledgeStatus(
  user: RfpUser,
  id: string,
  from: string[],
  to: "private" | "submitted"
): Promise<boolean> {
  if (!isUuid(id) || from.length === 0) return false;
  const res = await db
    .update(rfpKnowledgeProposals)
    .set({ status: to, updatedAt: new Date() })
    .where(
      and(
        eq(rfpKnowledgeProposals.id, id),
        eq(rfpKnowledgeProposals.ownerEmail, user.email.toLowerCase()),
        inArray(rfpKnowledgeProposals.status, from)
      )
    )
    .returning({ id: rfpKnowledgeProposals.id });
  return res.length > 0;
}

/**
 * Delete the caller's own row. Never an approved one: its shared fact
 * lives on in rfp_facts and promotedFactId is the audit trail back to it.
 * A draft of the owner's that cites `pending_<id>` will fail rule A5 on
 * its next check and ask for the claim to be re-cited, the same outcome a
 * returned row has today.
 */
export async function deleteKnowledgeProposal(
  user: RfpUser,
  id: string
): Promise<boolean> {
  if (!isUuid(id)) return false;
  const res = await db
    .delete(rfpKnowledgeProposals)
    .where(
      and(
        eq(rfpKnowledgeProposals.id, id),
        eq(rfpKnowledgeProposals.ownerEmail, user.email.toLowerCase()),
        ne(rfpKnowledgeProposals.status, "approved")
      )
    )
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

/* ---- admin corpus editing (§5.17.2 round 5) ----------------------------- */

const factSlug = (s: string) => s.replace(/[^a-z0-9]+/gi, "_");

/** One fact row by id, live or retired. ADMIN corpus operations only. */
export async function getFactById(id: string): Promise<FactRow | null> {
  const rows = await db
    .select()
    .from(rfpFacts)
    .where(eq(rfpFacts.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Correct a live fact: INSERT the corrected row at a new KB version and
 * retire the wrong one. Never an UPDATE — the whole correction machinery
 * (rule C1's stale sweep, the corrected-facts page, resolvable citations in
 * old proposals) depends on the wrong version keeping its id and the new
 * version having never been anything else.
 */
export async function correctFact(
  admin: RfpUser,
  factId: string,
  input: {
    statement: string;
    detail: string | null;
    polarity: "affirmative" | "negative";
    category: string;
  }
): Promise<{ ok: true; factId: string } | { ok: false; reason: string }> {
  if (!admin.admin) throw new Error("correctFact: caller is not an admin");
  const old = await getFactById(factId);
  if (!old) return { ok: false, reason: "not_found" };
  if (old.retiredInKb !== null)
    return { ok: false, reason: "already_retired" };

  const nextSeq = (await currentKbVersion()) + 1;
  const newId = `fact_${factSlug(old.key)}_v${nextSeq}`;
  const now = new Date();

  await db.transaction(async (tx) => {
    await tx.insert(rfpKbVersions).values({
      id: `kb_${nextSeq}`,
      seq: nextSeq,
      createdAt: now,
      note: `Correction of ${old.key} by ${admin.email}`,
    });
    await tx.insert(rfpFacts).values({
      id: newId,
      key: old.key,
      category: input.category.slice(0, 60),
      statement: input.statement.slice(0, 2000),
      polarity: input.polarity,
      detail: input.detail?.slice(0, 2000) ?? null,
      sourceUrl: old.sourceUrl,
      verifiedAt: now,
      correctedAt: now,
      supersedes: old.id,
      introducedInKb: nextSeq,
      retiredInKb: null,
      confidence: "confirmed",
    });
    // Guarded on still-live: two admins correcting the same fact race here,
    // and the loser must fail the WHOLE transaction rather than double-retire
    // (or leave two live versions of one key).
    const retired = await tx
      .update(rfpFacts)
      .set({ retiredInKb: nextSeq })
      .where(and(eq(rfpFacts.id, old.id), isNull(rfpFacts.retiredInKb)))
      .returning({ id: rfpFacts.id });
    if (retired.length === 0)
      throw new Error("correctFact: fact was retired concurrently");
  });

  return { ok: true, factId: newId };
}

/** Retire a live fact without replacement (it stops being citable). */
export async function retireFact(
  admin: RfpUser,
  factId: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!admin.admin) throw new Error("retireFact: caller is not an admin");
  const old = await getFactById(factId);
  if (!old) return { ok: false, reason: "not_found" };
  if (old.retiredInKb !== null)
    return { ok: false, reason: "already_retired" };

  const nextSeq = (await currentKbVersion()) + 1;
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.insert(rfpKbVersions).values({
      id: `kb_${nextSeq}`,
      seq: nextSeq,
      createdAt: now,
      note: `Retired ${old.key} by ${admin.email}`,
    });
    const retired = await tx
      .update(rfpFacts)
      .set({ retiredInKb: nextSeq })
      .where(and(eq(rfpFacts.id, old.id), isNull(rfpFacts.retiredInKb)))
      .returning({ id: rfpFacts.id });
    if (retired.length === 0)
      throw new Error("retireFact: fact was retired concurrently");
  });
  return { ok: true };
}

/** Add a brand-new fact directly (admin path; users go through proposals). */
export async function addFact(
  admin: RfpUser,
  input: {
    key: string;
    category: string;
    statement: string;
    detail: string | null;
    polarity: "affirmative" | "negative";
  }
): Promise<{ ok: true; factId: string } | { ok: false; reason: string }> {
  if (!admin.admin) throw new Error("addFact: caller is not an admin");
  const key = input.key.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,119}$/.test(key))
    return { ok: false, reason: "bad_key" };
  const dupes = await db
    .select({ id: rfpFacts.id })
    .from(rfpFacts)
    .where(and(eq(rfpFacts.key, key), isNull(rfpFacts.retiredInKb)))
    .limit(1);
  if (dupes.length) return { ok: false, reason: "key_in_use" };

  const nextSeq = (await currentKbVersion()) + 1;
  const now = new Date();
  const id = `fact_${factSlug(key)}_v${nextSeq}`;
  await db.transaction(async (tx) => {
    await tx.insert(rfpKbVersions).values({
      id: `kb_${nextSeq}`,
      seq: nextSeq,
      createdAt: now,
      note: `Added ${key} by ${admin.email}`,
    });
    await tx.insert(rfpFacts).values({
      id,
      key,
      category: input.category.slice(0, 60),
      statement: input.statement.slice(0, 2000),
      polarity: input.polarity,
      detail: input.detail?.slice(0, 2000) ?? null,
      sourceUrl: null,
      verifiedAt: now,
      correctedAt: null,
      supersedes: null,
      introducedInKb: nextSeq,
      retiredInKb: null,
      confidence: "confirmed",
    });
  });
  return { ok: true, factId: id };
}

/**
 * Edit a rate-card line (any field except its CODE — the code is the
 * identity the quote engine and rule B1 look lines up by, and rewriting it
 * would orphan every reference), or the card's minimums. Safe against
 * history by design: quotes SNAPSHOT unit prices and labels at build time,
 * so a change here never rewrites a quote that has been shown.
 */
export async function updateRateCard(
  admin: RfpUser,
  input:
    | {
        kind: "item";
        code: string;
        label?: string;
        unitPriceCents?: number;
        unit?: string;
        note?: string | null;
      }
    | {
        kind: "minimums";
        minimumFullyManagedUsers: number;
        minimumMonthlyFeeCents: number;
      }
): Promise<boolean> {
  if (!admin.admin) throw new Error("updateRateCard: caller is not an admin");
  const card = await currentRateCard();
  if (!card) return false;
  if (input.kind === "item") {
    const set: Partial<{
      label: string;
      unitPriceCents: number;
      unit: string;
      note: string | null;
    }> = {};
    if (input.label !== undefined) set.label = input.label.slice(0, 300);
    if (input.unitPriceCents !== undefined)
      set.unitPriceCents = Math.max(0, Math.floor(input.unitPriceCents));
    if (input.unit !== undefined) set.unit = input.unit.slice(0, 40);
    if (input.note !== undefined)
      set.note = input.note === null ? null : input.note.slice(0, 500);
    if (Object.keys(set).length === 0) return false;
    const res = await db
      .update(rfpRateCardItems)
      .set(set)
      .where(
        and(
          eq(rfpRateCardItems.rateCardId, card.id),
          eq(rfpRateCardItems.code, input.code)
        )
      )
      .returning({ code: rfpRateCardItems.code });
    return res.length > 0;
  }
  const res = await db
    .update(rfpRateCards)
    .set({
      minimumFullyManagedUsers: Math.max(
        0,
        Math.floor(input.minimumFullyManagedUsers)
      ),
      minimumMonthlyFeeCents: Math.max(
        0,
        Math.floor(input.minimumMonthlyFeeCents)
      ),
    })
    .where(eq(rfpRateCards.id, card.id))
    .returning({ id: rfpRateCards.id });
  return res.length > 0;
}

/** Edit an intake question's text or required flag. */
export async function updateQuestion(
  admin: RfpUser,
  id: string,
  input: { text: string; required: boolean }
): Promise<boolean> {
  if (!admin.admin) throw new Error("updateQuestion: caller is not an admin");
  const res = await db
    .update(rfpQuestions)
    .set({ text: input.text.slice(0, 500), required: input.required })
    .where(eq(rfpQuestions.id, id))
    .returning({ id: rfpQuestions.id });
  return res.length > 0;
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

/* ---- client references -------------------------------------------------- */

export type LiveReference = {
  id: string;
  organization: string;
  segment: string;
  relationshipSince: string | null;
  usableWithoutAsking: boolean;
  /** Whether a phone or an email is on file. The contact_* VALUES are
   *  third-party PII and are never selected: the presence test runs in SQL. */
  hasContact: boolean;
};

/**
 * Live client references (retired rows excluded), for the references
 * question's `why` (references-ask.ts). Company knowledge, not a per-user
 * row, so there is no owner scope; every caller sits behind the /rfp gate.
 */
export async function liveReferences(): Promise<LiveReference[]> {
  return db
    .select({
      id: rfpReferences.id,
      organization: rfpReferences.organization,
      segment: rfpReferences.segment,
      relationshipSince: rfpReferences.relationshipSince,
      usableWithoutAsking: rfpReferences.usableWithoutAsking,
      hasContact: sql<boolean>`(
        nullif(btrim(${rfpReferences.contactPhone}), '') is not null
        or nullif(btrim(${rfpReferences.contactEmail}), '') is not null
      )`,
    })
    .from(rfpReferences)
    .where(isNull(rfpReferences.retiredAt))
    .orderBy(asc(rfpReferences.organization));
}

/**
 * Live client references WITH their contact columns, for the references
 * picker (GET /api/rfp/proposals/[id]/references, §5.17.10).
 *
 * This is the ONE place the contact_* values are selected. The picker
 * prefills them for a staff member behind the /rfp gate who is about to put
 * them into a proposal; every other read of this table goes through
 * liveReferences(), which only tests their presence. Nothing here reaches a
 * prompt, a log or an activity row: the route returns the rows with
 * `Cache-Control: no-store` and nothing else.
 */
export async function liveReferencesWithContacts(): Promise<
  ReferenceCandidateWire[]
> {
  return db
    .select({
      id: rfpReferences.id,
      organization: rfpReferences.organization,
      segment: rfpReferences.segment,
      relationshipSince: rfpReferences.relationshipSince,
      usableWithoutAsking: rfpReferences.usableWithoutAsking,
      contactName: rfpReferences.contactName,
      contactTitle: rfpReferences.contactTitle,
      contactPhone: rfpReferences.contactPhone,
      contactEmail: rfpReferences.contactEmail,
    })
    .from(rfpReferences)
    .where(isNull(rfpReferences.retiredAt))
    .orderBy(asc(rfpReferences.organization));
}

/**
 * The LIVE rows among `ids`, id and organization only (no contact column):
 * what the references route checks a submitted `referenceId` against. An id
 * that is unknown or retired is simply absent from the result. The route
 * overwrites the entry's organization with the row's, so a request can never
 * attach contacts to a row under another name.
 */
export async function liveReferenceOrganizations(
  ids: string[]
): Promise<{ id: string; organization: string }[]> {
  const wanted = [...new Set(ids)].slice(0, 50);
  if (wanted.length === 0) return [];
  return db
    .select({
      id: rfpReferences.id,
      organization: rfpReferences.organization,
    })
    .from(rfpReferences)
    .where(
      and(inArray(rfpReferences.id, wanted), isNull(rfpReferences.retiredAt))
    );
}

const REFERENCE_ID_MAX = 40;
const REFERENCE_NEW_SEGMENT = "comparable client";
const REFERENCE_NEW_NOTES = "Added from a proposal answer.";

/** "ref_" + the organization as [a-z0-9]+ runs joined by "_", at most 40 chars in all. */
function referenceIdFor(organization: string): string {
  const slug = organization
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, REFERENCE_ID_MAX - "ref_".length)
    .replace(/_+$/g, "");
  return `ref_${slug || "organization"}`;
}

/**
 * Write the contacts of an answered references question back to
 * rfp_references (POST .../references with `keep: true`, §5.17.10).
 *
 * Only NON-EMPTY fields are written. An empty field in the answer never
 * nulls a stored column: leaving the phone out of one proposal is not an
 * instruction to forget the phone on file (the operator lane,
 * scripts/rfp-reference-contact.mjs, is where a column is cleared).
 *
 * - An entry with a `referenceId` UPDATES that LIVE row. No live row with
 *   that id: nothing is written and the entry counts as `failed`. (The route
 *   has already turned an unknown or retired id into null, so this is a row
 *   retired in between.)
 * - An entry with no id first looks for a LIVE row whose organization matches
 *   (trimmed, case-insensitive) and updates THAT row, counted as kept, so
 *   typing a name that is already on file never makes a duplicate.
 * - Otherwise it INSERTS a new organization: `ref_<slug>` with `_2`, `_3` on
 *   collision with ANY existing id, retired rows included (the id namespace
 *   is one). An insert that loses an id race to a concurrent answer is
 *   retried once with the next suffix. The new row carries no date, person
 *   or client name: the activity row the route writes is the provenance.
 *
 * Each entry is written on its own and a failure in one never loses the
 * others. Contact values are never returned or logged: the result is ids and
 * counts, `kept + created + failed === entries.length`.
 */
export async function saveReferenceContacts(
  _user: RfpUser,
  entries: ReferenceEntry[]
): Promise<{ kept: number; created: number; failed: number; ids: string[] }> {
  let kept = 0;
  let created = 0;
  let failed = 0;
  const ids: string[] = [];
  const orNull = (s: string) => (s.trim() === "" ? null : s.trim());
  for (const e of entries) {
    try {
      const contacts = {
        contactName: orNull(e.contactName),
        contactTitle: orNull(e.contactTitle),
        contactPhone: orNull(e.phone),
        contactEmail: orNull(e.email),
      };
      // What an UPDATE may set: the fields the person actually filled.
      const filled = Object.fromEntries(
        Object.entries(contacts).filter(([, v]) => v !== null)
      ) as Partial<Record<keyof typeof contacts, string>>;
      if (Object.keys(filled).length === 0) {
        failed += 1;
        continue;
      }
      if (e.referenceId) {
        const updated = await db
          .update(rfpReferences)
          .set(filled)
          .where(
            and(
              eq(rfpReferences.id, e.referenceId),
              isNull(rfpReferences.retiredAt)
            )
          )
          .returning({ id: rfpReferences.id });
        if (updated.length > 0) {
          kept += 1;
          ids.push(updated[0].id);
        } else failed += 1;
        continue;
      }
      const organization = e.organization.trim();
      const same = await db
        .select({ id: rfpReferences.id })
        .from(rfpReferences)
        .where(
          and(
            sql`lower(btrim(${rfpReferences.organization})) = lower(btrim(${organization}))`,
            isNull(rfpReferences.retiredAt)
          )
        )
        .orderBy(asc(rfpReferences.id))
        .limit(1);
      if (same.length > 0) {
        const updated = await db
          .update(rfpReferences)
          .set(filled)
          .where(
            and(
              eq(rfpReferences.id, same[0].id),
              isNull(rfpReferences.retiredAt)
            )
          )
          .returning({ id: rfpReferences.id });
        if (updated.length > 0) {
          kept += 1;
          ids.push(updated[0].id);
        } else failed += 1;
        continue;
      }
      const base = referenceIdFor(organization);
      let insertedId: string | null = null;
      // Two tries: the second only when the first lost its id to a
      // concurrent insert (the taken set is re-read, so it picks the next
      // free suffix).
      for (let attempt = 0; attempt < 2 && insertedId === null; attempt++) {
        const taken = new Set(
          (
            await db
              .select({ id: rfpReferences.id })
              .from(rfpReferences)
              .where(sql`${rfpReferences.id} like ${`${base}%`}`)
          ).map((r) => r.id)
        );
        let id = base;
        for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
        const inserted = await db
          .insert(rfpReferences)
          .values({
            id,
            organization,
            website: null,
            segment: e.relevance.trim() || REFERENCE_NEW_SEGMENT,
            ...contacts,
            relationshipSince: null,
            usableWithoutAsking: false,
            notes: REFERENCE_NEW_NOTES,
          })
          .onConflictDoNothing({ target: rfpReferences.id })
          .returning({ id: rfpReferences.id });
        if (inserted.length > 0) insertedId = inserted[0].id;
      }
      if (insertedId !== null) {
        created += 1;
        ids.push(insertedId);
      } else failed += 1;
    } catch (err) {
      failed += 1;
      // The class name only: the error text may quote the row.
      console.error(
        "[rfp] reference contact write failed:",
        err instanceof Error ? err.constructor.name : "error"
      );
    }
  }
  return { kept, created, failed, ids };
}
