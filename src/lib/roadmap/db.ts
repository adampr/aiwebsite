// DB access for the Your AI Roadmap portal (§5.18). Every company-scoped
// function takes companyId from the caller's SERVER-DERIVED principal (or a
// requireGlobalAdmin-guarded request param on /admin/roadmap only) and binds
// it into its WHERE clause — no function trusts a row id alone to imply a
// tenant (governance db.ts fetchOwnedProject discipline).

import crypto from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
// §5.19 scorecard merge. requests-db imports nothing from this file
// (WorkScope is a type-only import there), so no cycle.
import { requestCountsByEmail } from "@/lib/work/requests-db";
import { personLabel } from "@/lib/person-label";
import { isCompanyEligibleDomain } from "@/lib/roadmap/domains";
import {
  ROADMAP_CAPS,
  apolloDailyCallCap,
  roadmapBrainDailyCap,
  roadmapPanelRunsDailyCap,
} from "@/lib/roadmap/config";
import {
  isUniqueViolation,
  readTodayWorkUsage,
  refundWorkRun,
  trySpendWork,
} from "@/lib/work/db";
import {
  WORK_CAPS,
  workBrainDailyCap,
  workPanelRunsDailyCap,
} from "@/lib/work/config";

const C = schema.companies;
const CA = schema.companyAdmins;
const CR = schema.companyAdminRequests;
const CP = schema.companyPeople;
const DS = schema.directorySuppressions;
const CGD = schema.companyGovernanceDocs;
const SRS = schema.staffRoadmapState;
const W = schema.workSubmissions;
const U = schema.users;

/** Directory lane axis (§5.18 staff parity): companyId null = the XL.net
 * STAFF lane (company_people/directory_suppressions rows with NULL
 * company_id; the work_submissions/work_requests internal-lane pattern). A
 * REQUIRED param on every people/suppression/stamp function so a missed
 * lane filter is a compile error (WorkScope precedent). Defined here, not
 * imported from work/scope.ts: scope.ts imports from this file, so a value
 * import back would be a cycle. */
export type DirectoryScope = { companyId: string | null };
export const STAFF_DIRECTORY_SCOPE: DirectoryScope = { companyId: null };

/** The ONE lane predicate: never eq() with a null (drizzle renders
 * "= NULL", which matches nothing). */
function dirLaneWhere(scope: DirectoryScope) {
  return scope.companyId === null
    ? isNull(CP.companyId)
    : eq(CP.companyId, scope.companyId);
}

function dirSupprLaneWhere(scope: DirectoryScope) {
  return scope.companyId === null
    ? isNull(DS.companyId)
    : eq(DS.companyId, scope.companyId);
}

export type CompanyRow = {
  id: string;
  domain: string;
  name: string;
  status: string;
};

export function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/**
 * The company for an exact domain label, or null. Re-checks eligibility even
 * though bootstrap already did: a companies row that somehow exists for a
 * freemail/shared-tenant domain (regression, manual SQL) must never resolve
 * — resolving one would make a public mailbox population a "company" for
 * both the portal and the DKIM email lane.
 */
export async function companyForDomainRow(
  domain: string
): Promise<CompanyRow | null> {
  if (!isCompanyEligibleDomain(domain)) return null;
  const rows = await db
    .select({ id: C.id, domain: C.domain, name: C.name, status: C.status })
    .from(C)
    .where(eq(C.domain, domain))
    .limit(1);
  return rows[0] ?? null;
}

export async function companyById(id: string): Promise<CompanyRow | null> {
  const rows = await db
    .select({ id: C.id, domain: C.domain, name: C.name, status: C.status })
    .from(C)
    .where(eq(C.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/** True iff this user administers THIS company. The predicate is always
 * (company_id AND user_id): a grant for another company must never follow a
 * user here. */
export async function companyAdminRole(
  companyId: string,
  userId: string
): Promise<boolean> {
  const rows = await db
    .select({ id: CA.id })
    .from(CA)
    .where(and(eq(CA.companyId, companyId), eq(CA.userId, userId)))
    .limit(1);
  return rows.length > 0;
}

/** All current admins of a company, joined to live user rows (the approval
 * email recipient list; no denormalized emails on authorization rows). */
export async function companyAdminEmails(companyId: string): Promise<string[]> {
  const rows = await db
    .select({ email: U.email })
    .from(CA)
    .innerJoin(U, eq(U.id, CA.userId))
    .where(eq(CA.companyId, companyId));
  return rows.map((r) => r.email.toLowerCase());
}

/**
 * Explicit workspace bootstrap (§5.18): never a sign-in side effect. The
 * companies_domain_uq index is the race arbiter — exactly one bootstrap
 * admin per company; the loser resolves the existing row and joins as a
 * member. A subdomain (or superdomain) of an existing company is refused
 * until alias machinery exists: mail and sign-ins must obey one rule.
 */
export async function bootstrapCompany(opts: {
  domain: string;
  userId: string;
  email: string;
}): Promise<
  | { outcome: "created"; company: CompanyRow }
  | { outcome: "exists"; company: CompanyRow }
  | { outcome: "related_domain"; existingDomain: string }
> {
  const related = await db
    .select({ domain: C.domain })
    .from(C)
    .where(
      sql`${C.domain} <> ${opts.domain} AND (
        ${C.domain} LIKE '%.' || ${opts.domain}
        OR ${opts.domain} LIKE '%.' || ${C.domain}
      )`
    )
    .limit(1);
  if (related[0]) {
    return { outcome: "related_domain", existingDomain: related[0].domain };
  }
  const inserted = await db
    .insert(C)
    .values({
      domain: opts.domain,
      name: opts.domain,
      createdByUserId: opts.userId,
      createdByEmail: opts.email.toLowerCase(),
    })
    .onConflictDoNothing({ target: C.domain })
    .returning({ id: C.id, domain: C.domain, name: C.name, status: C.status });
  if (inserted[0]) {
    await db
      .insert(CA)
      .values({
        companyId: inserted[0].id,
        userId: opts.userId,
        grantedVia: "bootstrap",
        grantedByEmail: "system",
      })
      .onConflictDoNothing();
    return { outcome: "created", company: inserted[0] };
  }
  const existing = await companyForDomainRow(opts.domain);
  if (!existing) {
    // Raced with a delete, or the domain failed the eligibility re-check.
    return { outcome: "related_domain", existingDomain: opts.domain };
  }
  return { outcome: "exists", company: existing };
}

// ---- Admin-access requests (§5.18) ----

export type AdminRequestRow = typeof CR.$inferSelect;

/** The viewer's live pending request, if any (drives the standing "requested
 * on {date}" panel instead of the button). */
export async function openAdminRequest(
  companyId: string,
  userId: string
): Promise<AdminRequestRow | null> {
  const rows = await db
    .select()
    .from(CR)
    .where(
      and(
        eq(CR.companyId, companyId),
        eq(CR.requesterUserId, userId),
        eq(CR.status, "pending"),
        gt(CR.expiresAt, new Date())
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

/** A denied request suppresses new ones until ITS expiry passes, so the
 * observable behavior of a denial matches the "reads as expiry" ruling
 * instead of re-arming the button the same minute. */
export async function deniedAdminRequestInWindow(
  companyId: string,
  userId: string
): Promise<AdminRequestRow | null> {
  const rows = await db
    .select()
    .from(CR)
    .where(
      and(
        eq(CR.companyId, companyId),
        eq(CR.requesterUserId, userId),
        eq(CR.status, "denied"),
        gt(CR.expiresAt, new Date())
      )
    )
    .orderBy(desc(CR.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function createAdminRequest(opts: {
  companyId: string;
  userId: string;
  email: string;
  notifiedEmails: string[];
}): Promise<AdminRequestRow> {
  const [row] = await db
    .insert(CR)
    .values({
      companyId: opts.companyId,
      requesterUserId: opts.userId,
      requesterEmail: opts.email.toLowerCase(),
      notifiedEmailsJson: JSON.stringify(opts.notifiedEmails),
      expiresAt: new Date(
        Date.now() + ROADMAP_CAPS.adminRequestTtlDays * 24 * 3600 * 1000
      ),
    })
    .returning();
  return row;
}

export async function adminRequestById(
  id: string
): Promise<AdminRequestRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const rows = await db.select().from(CR).where(eq(CR.id, id)).limit(1);
  return rows[0] ?? null;
}

/** Atomic approval: the WHERE status='pending' rowCount is the fence (any
 * ONE recipient may approve; the second click finds zero rows). The role
 * insert is ON CONFLICT DO NOTHING so approve-after-bootstrap-race is
 * idempotent. */
export async function approveAdminRequest(opts: {
  requestId: string;
  deciderUserId: string;
  deciderEmail: string;
}): Promise<AdminRequestRow | null> {
  const rows = await db
    .update(CR)
    .set({
      status: "approved",
      decidedByUserId: opts.deciderUserId,
      decidedByEmail: opts.deciderEmail.toLowerCase(),
      decidedAt: new Date(),
    })
    .where(
      and(
        eq(CR.id, opts.requestId),
        eq(CR.status, "pending"),
        gt(CR.expiresAt, new Date())
      )
    )
    .returning();
  const req = rows[0];
  if (!req) return null;
  await db
    .insert(CA)
    .values({
      companyId: req.companyId,
      userId: req.requesterUserId,
      grantedVia: `request:${req.id}`,
      grantedByEmail: opts.deciderEmail.toLowerCase(),
    })
    .onConflictDoNothing();
  return req;
}

export async function denyAdminRequest(opts: {
  requestId: string;
  deciderUserId: string;
  deciderEmail: string;
}): Promise<AdminRequestRow | null> {
  const rows = await db
    .update(CR)
    .set({
      status: "denied",
      decidedByUserId: opts.deciderUserId,
      decidedByEmail: opts.deciderEmail.toLowerCase(),
      decidedAt: new Date(),
    })
    .where(and(eq(CR.id, opts.requestId), eq(CR.status, "pending")))
    .returning();
  return rows[0] ?? null;
}

/** All live pending requests, joined to their company (console queue). */
export async function allPendingRequests(): Promise<
  (AdminRequestRow & { companyDomain: string; companyName: string })[]
> {
  const rows = await db
    .select({
      req: CR,
      companyDomain: C.domain,
      companyName: C.name,
    })
    .from(CR)
    .innerJoin(C, eq(C.id, CR.companyId))
    .where(and(eq(CR.status, "pending"), gt(CR.expiresAt, new Date())))
    .orderBy(asc(CR.createdAt));
  return rows.map((r) => ({
    ...r.req,
    companyDomain: r.companyDomain,
    companyName: r.companyName,
  }));
}

export async function pendingRequestsForCompany(
  companyId: string
): Promise<AdminRequestRow[]> {
  return db
    .select()
    .from(CR)
    .where(
      and(
        eq(CR.companyId, companyId),
        eq(CR.status, "pending"),
        gt(CR.expiresAt, new Date())
      )
    )
    .orderBy(asc(CR.createdAt));
}

// ---- Directory (§5.18 step 2) ----

export type PersonRow = typeof CP.$inferSelect;

export async function listPeople(scope: DirectoryScope): Promise<PersonRow[]> {
  return db
    .select()
    .from(CP)
    .where(dirLaneWhere(scope))
    .orderBy(asc(CP.name))
    .limit(ROADMAP_CAPS.directoryRenderMax);
}

/** The identity join for the scorecard: narrow and UNCAPPED on purpose.
 *
 * listPeople's limit is a RENDER cap (every row it returns is serialized
 * into the island's props), and the scorecard has no rendering reason to
 * inherit it. It used to: a person past the cap dropped out of this join,
 * came back through the stray-row path with name: null, and the person-label
 * rule then rendered their EMAIL where their name belongs. One limit()
 * silently corrupted a second surface. Three columns, no limit, so the
 * scorecard is correct at any directory size. */
export async function directoryIdentities(
  scope: DirectoryScope
): Promise<{ id: string; name: string; email: string | null }[]> {
  return db
    .select({ id: CP.id, name: CP.name, email: CP.email })
    .from(CP)
    .where(dirLaneWhere(scope))
    .orderBy(asc(CP.name));
}

export async function countPeople(scope: DirectoryScope): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(CP)
    .where(dirLaneWhere(scope));
  return rows[0]?.n ?? 0;
}

export async function addPerson(opts: {
  scope: DirectoryScope;
  name: string;
  email: string | null;
  phone: string | null;
}): Promise<PersonRow> {
  const [row] = await db
    .insert(CP)
    .values({
      companyId: opts.scope.companyId,
      name: opts.name,
      email: opts.email ? opts.email.toLowerCase() : null,
      phone: opts.phone,
      source: "manual",
    })
    .returning();
  return row;
}

/** Any human edit flips source to 'manual' so a later Apollo re-import never
 * clobbers the correction. */
export async function updatePerson(opts: {
  scope: DirectoryScope;
  personId: string;
  name: string;
  email: string | null;
  phone: string | null;
}): Promise<PersonRow | null> {
  const rows = await db
    .update(CP)
    .set({
      name: opts.name,
      email: opts.email ? opts.email.toLowerCase() : null,
      phone: opts.phone,
      source: "manual",
      updatedAt: new Date(),
    })
    .where(and(eq(CP.id, opts.personId), dirLaneWhere(opts.scope)))
    .returning();
  return rows[0] ?? null;
}

/** Hard delete; when suppress is set (default for Apollo rows in the UI) the
 * email's sha256 is recorded so re-imports skip this person for good. */
export async function removePerson(opts: {
  scope: DirectoryScope;
  personId: string;
  suppress: boolean;
}): Promise<PersonRow | null> {
  const rows = await db
    .delete(CP)
    .where(and(eq(CP.id, opts.personId), dirLaneWhere(opts.scope)))
    .returning();
  const row = rows[0];
  if (row && opts.suppress && row.email) {
    await db
      .insert(DS)
      .values({
        companyId: opts.scope.companyId,
        emailSha256: sha256Hex(row.email.toLowerCase()),
      })
      .onConflictDoNothing();
  }
  return row ?? null;
}

/** Bulk remove (the 2026-08-09 directory round). Two statements regardless
 * of N, in ONE transaction, so the client never has to reconcile a
 * half-applied batch: either every matched row is gone with its suppression
 * recorded, or nothing is.
 *
 * Ids that do not exist, or belong to the OTHER lane, simply do not match
 * the lane-filtered WHERE and are silently skipped: `removed < personIds
 * .length` is a SUCCESS, not a 404. A stale page or a second admin working
 * the same list would otherwise turn a 100-row sweep into a total failure.
 * The caller returns counts only, never per-id status, which would make the
 * endpoint a cross-lane uuid existence oracle.
 *
 * Suppression policy is deliberately identical to removePerson above: rows
 * with an email get sha256(lower(email)) recorded when suppress is set.
 * Change one and change the other. */
export async function removePeople(opts: {
  scope: DirectoryScope;
  personIds: string[];
  suppress: boolean;
}): Promise<{ removed: number; suppressed: number }> {
  if (opts.personIds.length === 0) return { removed: 0, suppressed: 0 };
  return db.transaction(async (tx) => {
    const rows = await tx
      .delete(CP)
      .where(and(inArray(CP.id, opts.personIds), dirLaneWhere(opts.scope)))
      .returning({ email: CP.email });
    if (rows.length === 0) return { removed: 0, suppressed: 0 };
    if (!opts.suppress) return { removed: rows.length, suppressed: 0 };
    // De-duplicated: two directory rows may legally share no email, but a
    // repeated hash in one multi-row insert is an avoidable conflict.
    const hashes = [
      ...new Set(
        rows
          .map((r) => r.email)
          .filter((e): e is string => !!e)
          .map((e) => sha256Hex(e.toLowerCase()))
      ),
    ];
    if (hashes.length === 0) return { removed: rows.length, suppressed: 0 };
    await tx
      .insert(DS)
      .values(
        hashes.map((emailSha256) => ({
          companyId: opts.scope.companyId,
          emailSha256,
        }))
      )
      .onConflictDoNothing();
    return { removed: rows.length, suppressed: hashes.length };
  });
}

export async function suppressedHashes(
  scope: DirectoryScope
): Promise<Set<string>> {
  const rows = await db
    .select({ h: DS.emailSha256 })
    .from(DS)
    .where(dirSupprLaneWhere(scope));
  return new Set(rows.map((r) => r.h));
}

/** Apollo import upsert: keyed on (lane, apollo_id); rows a human has
 * edited (source 'manual') are never clobbered. Returns what happened for
 * the admin-facing result line. */
export async function upsertApolloPerson(opts: {
  scope: DirectoryScope;
  apolloId: string;
  name: string;
  email: string | null;
  phone: string | null;
}): Promise<"added" | "updated" | "kept_manual"> {
  const existing = await db
    .select({ id: CP.id, source: CP.source })
    .from(CP)
    .where(and(dirLaneWhere(opts.scope), eq(CP.apolloId, opts.apolloId)))
    .limit(1);
  if (existing[0]) {
    if (existing[0].source === "manual") return "kept_manual";
    await db
      .update(CP)
      .set({
        name: opts.name,
        email: opts.email ? opts.email.toLowerCase() : null,
        phone: opts.phone,
        updatedAt: new Date(),
      })
      .where(eq(CP.id, existing[0].id));
    return "updated";
  }
  await db
    .insert(CP)
    .values({
      companyId: opts.scope.companyId,
      apolloId: opts.apolloId,
      name: opts.name,
      email: opts.email ? opts.email.toLowerCase() : null,
      phone: opts.phone,
      source: "apollo",
    })
    .onConflictDoNothing();
  return "added";
}

/** The durable auto-kick once-flag (round 3): non-null after any COMPLETE
 * import run, including complete zero-result runs. Staff lane reads the
 * one-row staff_roadmap_state table (no companies row exists by invariant). */
export async function apolloImportStamp(
  scope: DirectoryScope
): Promise<Date | null> {
  if (scope.companyId === null) {
    const rows = await db
      .select({ at: SRS.apolloLastImportAt })
      .from(SRS)
      .where(eq(SRS.id, 1))
      .limit(1);
    return rows[0]?.at ?? null;
  }
  const rows = await db
    .select({ at: C.apolloLastImportAt })
    .from(C)
    .where(eq(C.id, scope.companyId))
    .limit(1);
  return rows[0]?.at ?? null;
}

export async function stampApolloImport(
  scope: DirectoryScope,
  count: number
): Promise<void> {
  if (scope.companyId === null) {
    // UPSERT, not UPDATE: 0039 seeds the id=1 row, but a missing row must
    // degrade to self-heal, never to a silent no-op that re-arms the
    // auto-kick forever.
    await db
      .insert(SRS)
      .values({ id: 1, apolloLastImportAt: new Date(), apolloLastImportCount: count })
      .onConflictDoUpdate({
        target: SRS.id,
        set: { apolloLastImportAt: new Date(), apolloLastImportCount: count },
      });
    return;
  }
  await db
    .update(C)
    .set({
      apolloLastImportAt: new Date(),
      apolloLastImportCount: count,
      updatedAt: new Date(),
    })
    .where(eq(C.id, scope.companyId));
}

// ---- Governance docs (§5.18 step 1) ----

/** List/read shape excludes file_data (the stored original, ≤10 MB): only
 * governanceDocForDownload ever selects the bytes. */
export type GovDocRow = Omit<typeof CGD.$inferSelect, "fileData">;

export async function listGovernanceDocs(
  companyId: string
): Promise<GovDocRow[]> {
  return db
    .select({
      id: CGD.id,
      companyId: CGD.companyId,
      source: CGD.source,
      title: CGD.title,
      fileName: CGD.fileName,
      fileMime: CGD.fileMime,
      fileSha256: CGD.fileSha256,
      fileBytes: CGD.fileBytes,
      docText: CGD.docText,
      governanceProjectId: CGD.governanceProjectId,
      governanceKind: CGD.governanceKind,
      addedByUserId: CGD.addedByUserId,
      addedByEmail: CGD.addedByEmail,
      createdAt: CGD.createdAt,
    })
    .from(CGD)
    .where(eq(CGD.companyId, companyId))
    .orderBy(desc(CGD.createdAt));
}

export async function countGovernanceDocs(companyId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(CGD)
    .where(eq(CGD.companyId, companyId));
  return rows[0]?.n ?? 0;
}

export async function addGovernanceDoc(opts: {
  companyId: string;
  source: "upload" | "governance_project";
  title: string;
  file?: {
    name: string;
    mime: string;
    sha256: string;
    bytes: number;
    data: Buffer;
  };
  docText: string | null;
  governanceProjectId?: string;
  governanceKind?: string;
  addedByUserId: string;
  addedByEmail: string;
}): Promise<string> {
  const [row] = await db
    .insert(CGD)
    .values({
      companyId: opts.companyId,
      source: opts.source,
      title: opts.title,
      fileName: opts.file?.name ?? null,
      fileMime: opts.file?.mime ?? null,
      fileSha256: opts.file?.sha256 ?? null,
      fileBytes: opts.file?.bytes ?? null,
      fileData: opts.file?.data ?? null,
      docText: opts.docText,
      governanceProjectId: opts.governanceProjectId ?? null,
      governanceKind: opts.governanceKind ?? null,
      addedByUserId: opts.addedByUserId,
      addedByEmail: opts.addedByEmail.toLowerCase(),
    })
    .returning({ id: CGD.id });
  return row.id;
}

/** Download read, scoped in the ONE query (missing and not-owned are the
 * same null; the route returns an identical 404 body for both). */
export async function governanceDocForDownload(
  docId: string,
  companyId: string
): Promise<{
  id: string;
  title: string;
  fileName: string | null;
  fileData: Buffer | null;
  docText: string | null;
} | null> {
  if (!/^[0-9a-f-]{36}$/i.test(docId)) return null;
  const rows = await db
    .select({
      id: CGD.id,
      title: CGD.title,
      fileName: CGD.fileName,
      fileData: CGD.fileData,
      docText: CGD.docText,
    })
    .from(CGD)
    .where(and(eq(CGD.id, docId), eq(CGD.companyId, companyId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function removeGovernanceDoc(
  docId: string,
  companyId: string
): Promise<boolean> {
  const rows = await db
    .delete(CGD)
    .where(and(eq(CGD.id, docId), eq(CGD.companyId, companyId)))
    .returning({ id: CGD.id });
  return rows.length > 0;
}

// ---- Scorecard (§5.18 step 4; derived, no table) ----

export type ScorecardRow = {
  personId: string | null;
  name: string | null;
  email: string | null;
  published: number;
  lastPublishedAt: Date | null;
  inDirectory: boolean;
  /** §5.19 requested-work columns. Requested counts LISTED statuses only
   * (never pending/rejected - same doctrine as published-only above);
   * working is exactly the 3-cap predicate; completed credits the
   * developer. */
  requested: number;
  working: number;
  completed: number;
};

const NO_REQUESTS = { requested: 0, working: 0, completed: 0 } as const;

function scorecardSort(rows: ScorecardRow[]): ScorecardRow[] {
  // Tiebreak on the DISPLAYED label (person-label rule), not the stored
  // name: a row rendering its email must not alphabetize by a hidden
  // single-token first name.
  rows.sort(
    (a, b) =>
      b.published - a.published ||
      b.completed - a.completed ||
      personLabel(a.name, a.email).localeCompare(personLabel(b.name, b.email))
  );
  return rows;
}

/** The ONE scorecard implementation for BOTH lanes (§5.18 staff parity;
 * previously companyScorecard + a parallel internalScorecard whose invented
 * max(submitter_name) source was the bare-first-name bug). Directory rows
 * first (real personId/inDirectory in both lanes - the staff directory is
 * the NULL lane), then published submitters missing from the directory,
 * then requested-work-only participants (listed statuses only; a
 * pending/rejected row existing at all is information, so those people
 * never appear). Counts PUBLISHED cards only: held, failed, and in-review
 * rows never appear anywhere in the scorecard, so it can never reveal that
 * a colleague tried and failed. Stray rows carry name: null by design -
 * work_submissions.submitter_name is a validated single first name and can
 * never satisfy the person-label rule. */
export async function scorecardRows(
  scope: DirectoryScope
): Promise<ScorecardRow[]> {
  const laneWhere =
    scope.companyId === null
      ? isNull(W.companyId)
      : eq(W.companyId, scope.companyId);
  const [people, counts, requests] = await Promise.all([
    // directoryIdentities, not listPeople: the render cap must not decide
    // who has a name on the scorecard (see that function's comment).
    directoryIdentities(scope),
    db
      .select({
        email: sql<string>`lower(${W.submitterEmail})`,
        n: sql<number>`count(*)::int`,
        last: sql<Date | null>`max(${W.publishedAt})`,
      })
      .from(W)
      .where(and(laneWhere, eq(W.status, "published")))
      .groupBy(sql`lower(${W.submitterEmail})`),
    requestCountsByEmail({ companyId: scope.companyId }),
  ]);
  const byEmail = new Map(counts.map((c) => [c.email, c]));
  const rows: ScorecardRow[] = people.map((p) => {
    const key = p.email?.toLowerCase();
    const hit = key ? byEmail.get(key) : undefined;
    if (key) byEmail.delete(key);
    const req = key ? requests.get(key) : undefined;
    if (key) requests.delete(key);
    return {
      personId: p.id,
      name: p.name,
      email: p.email,
      published: hit?.n ?? 0,
      lastPublishedAt: hit?.last ?? null,
      inDirectory: true,
      ...(req ?? NO_REQUESTS),
    };
  });
  for (const [email, c] of byEmail) {
    const req = requests.get(email);
    requests.delete(email);
    rows.push({
      personId: null,
      name: null,
      email,
      published: c.n,
      lastPublishedAt: c.last,
      inDirectory: false,
      ...(req ?? NO_REQUESTS),
    });
  }
  // People visible only through requested-work activity (requester or
  // developer on listed rows, never a directory or published match) join as
  // stray rows too - their activity is already lane-public on the board.
  for (const [email, req] of requests) {
    rows.push({
      personId: null,
      name: null,
      email,
      published: 0,
      lastPublishedAt: null,
      inDirectory: false,
      ...req,
    });
  }
  return scorecardSort(rows);
}

// ---- /admin/roadmap console reads (metadata allowlist; content columns
// render only in the per-company detail view, which is directory + docs
// titles by design) ----

export type CompanyOverview = CompanyRow & {
  createdAt: Date;
  createdByEmail: string;
  people: number;
  docs: number;
  published: number;
  admins: number;
  pendingRequests: number;
  apolloLastImportAt: Date | null;
};

export async function companiesOverview(): Promise<CompanyOverview[]> {
  const rows = await db
    .select({
      id: C.id,
      domain: C.domain,
      name: C.name,
      status: C.status,
      createdAt: C.createdAt,
      createdByEmail: C.createdByEmail,
      apolloLastImportAt: C.apolloLastImportAt,
      // companies.id must be spelled out: drizzle renders ${C.id} inside a
      // select() sql fragment as unqualified "id", which a correlated
      // subquery resolves against the INNER table (42883 uuid = integer).
      people: sql<number>`(SELECT count(*)::int FROM company_people p WHERE p.company_id = companies.id)`,
      docs: sql<number>`(SELECT count(*)::int FROM company_governance_docs d WHERE d.company_id = companies.id)`,
      published: sql<number>`(SELECT count(*)::int FROM work_submissions w WHERE w.company_id = companies.id AND w.status = 'published')`,
      admins: sql<number>`(SELECT count(*)::int FROM company_admins a WHERE a.company_id = companies.id)`,
      pendingRequests: sql<number>`(SELECT count(*)::int FROM company_admin_requests r WHERE r.company_id = companies.id AND r.status = 'pending' AND r.expires_at > now())`,
    })
    .from(C)
    .orderBy(asc(C.domain));
  return rows;
}

export async function companyAdminsDetail(
  companyId: string
): Promise<{ userId: string; email: string; grantedVia: string; createdAt: Date }[]> {
  return db
    .select({
      userId: CA.userId,
      email: U.email,
      grantedVia: CA.grantedVia,
      createdAt: CA.createdAt,
    })
    .from(CA)
    .innerJoin(U, eq(U.id, CA.userId))
    .where(eq(CA.companyId, companyId))
    .orderBy(asc(CA.createdAt));
}

/** GA grant: the target must already have signed in (users row) AND the
 * account's email domain must equal the company domain — a role must never
 * follow a user across tenants. */
export async function grantAdminByEmail(opts: {
  companyId: string;
  companyDomain: string;
  targetEmail: string;
  granterEmail: string;
}): Promise<"granted" | "no_user" | "wrong_domain" | "already"> {
  const email = opts.targetEmail.toLowerCase();
  if (email.split("@")[1] !== opts.companyDomain) return "wrong_domain";
  const users = await db
    .select({ id: U.id })
    .from(U)
    .where(sql`lower(${U.email}) = ${email}`)
    .limit(1);
  if (!users[0]) return "no_user";
  const inserted = await db
    .insert(CA)
    .values({
      companyId: opts.companyId,
      userId: users[0].id,
      grantedVia: "global_admin",
      grantedByEmail: opts.granterEmail.toLowerCase(),
    })
    .onConflictDoNothing()
    .returning({ id: CA.id });
  return inserted.length > 0 ? "granted" : "already";
}

export async function revokeAdmin(opts: {
  companyId: string;
  targetUserId: string;
}): Promise<boolean> {
  const rows = await db
    .delete(CA)
    .where(
      and(eq(CA.companyId, opts.companyId), eq(CA.userId, opts.targetUserId))
    )
    .returning({ id: CA.id });
  return rows.length > 0;
}

export async function setCompanyStatus(
  companyId: string,
  status: "active" | "suspended"
): Promise<boolean> {
  const rows = await db
    .update(C)
    .set({ status, updatedAt: new Date() })
    .where(eq(C.id, companyId))
    .returning({ id: C.id });
  return rows.length > 0;
}

export async function setCompanyName(
  companyId: string,
  name: string
): Promise<boolean> {
  const rows = await db
    .update(C)
    .set({ name, updatedAt: new Date() })
    .where(eq(C.id, companyId))
    .returning({ id: C.id });
  return rows.length > 0;
}

/** Explicit ordered purge (work_submissions.company_id is RESTRICT by
 * design): submissions first, then the company row, which cascades
 * admins/requests/people/suppressions/docs. */
export async function purgeCompany(companyId: string): Promise<{
  submissions: number;
  requests: number;
}> {
  const deleted = await db
    .delete(W)
    .where(eq(W.companyId, companyId))
    .returning({ id: W.id });
  // §5.19: work_requests.company_id is also ON DELETE RESTRICT, so the
  // company's request rows must go before the companies row or the delete
  // below fails on the FK.
  const requests = await db
    .delete(schema.workRequests)
    .where(eq(schema.workRequests.companyId, companyId))
    .returning({ id: schema.workRequests.id });
  await db.delete(C).where(eq(C.id, companyId));
  return { submissions: deleted.length, requests: requests.length };
}

// ---- roadmap_usage ledger (work_usage pattern; ACTUALS only, no
// worst-case reservations are ever written) ----

const RU = schema.roadmapUsage;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function ensureToday(): Promise<void> {
  await db.execute(sql`
    INSERT INTO roadmap_usage (day) VALUES (${today()})
    ON CONFLICT (day) DO NOTHING
  `);
}

export async function readTodayRoadmapUsage(): Promise<{
  apolloCalls: number;
  brainCalls: number;
  panelRuns: number;
}> {
  await ensureToday();
  const rows = await db.select().from(RU).where(eq(RU.day, today()));
  return {
    apolloCalls: rows[0]?.apolloCalls ?? 0,
    brainCalls: rows[0]?.brainCalls ?? 0,
    panelRuns: rows[0]?.panelRuns ?? 0,
  };
}

export async function trySpendRoadmap(
  counter: "apollo_calls" | "brain_calls" | "panel_runs",
  n: number,
  cap: number
): Promise<boolean> {
  await ensureToday();
  const res = await db.execute(sql`
    UPDATE roadmap_usage
    SET ${sql.raw(counter)} = ${sql.raw(counter)} + ${n}
    WHERE day = ${today()} AND ${sql.raw(counter)} + ${n} <= ${cap}
    RETURNING day
  `);
  return (res as unknown as unknown[]).length > 0;
}

export async function refundRoadmap(
  counter: "apollo_calls" | "brain_calls" | "panel_runs",
  n: number
): Promise<void> {
  await db.execute(sql`
    UPDATE roadmap_usage
    SET ${sql.raw(counter)} = GREATEST(${sql.raw(counter)} - ${n}, 0)
    WHERE day = ${today()}
  `);
}

/**
 * Admission for a COMPANY-scope panel run: headroom-check brain calls on
 * BOTH ledgers (a started run must always be able to finish), then spend one
 * panel_run on BOTH. Mirrors the staff admission model exactly — no
 * worst-case brain reservation is written anywhere; actual brain calls
 * dual-increment both ledgers via spendCompanyBrainCall.
 */
export async function admitCompanyRun(): Promise<
  { ok: true } | { ok: false; reason: "roadmap_budget" | "work_budget" }
> {
  const [r, w] = await Promise.all([
    readTodayRoadmapUsage(),
    readTodayWorkUsage(),
  ]);
  const worst = WORK_CAPS.brainCallsWorstCasePerRun;
  if (r.brainCalls + worst > roadmapBrainDailyCap(process.env)) {
    return { ok: false, reason: "roadmap_budget" };
  }
  if (w.brainCalls + worst > workBrainDailyCap(process.env)) {
    return { ok: false, reason: "work_budget" };
  }
  const roadmapOk = await trySpendRoadmap(
    "panel_runs",
    1,
    roadmapPanelRunsDailyCap(process.env)
  );
  if (!roadmapOk) return { ok: false, reason: "roadmap_budget" };
  const workOk = await trySpendWork(
    "panel_runs",
    1,
    workPanelRunsDailyCap(process.env)
  );
  if (!workOk) {
    await refundRoadmap("panel_runs", 1);
    return { ok: false, reason: "work_budget" };
  }
  return { ok: true };
}

/** Refund a company run refused after admission (busy/claim refusals must
 * not burn either budget). */
export async function refundCompanyRun(): Promise<void> {
  await Promise.all([refundRoadmap("panel_runs", 1), refundWorkRun()]);
}

/** Roadmap-side record of one ACTUAL company-scope brain call (panel stage
 * or title inference). work_usage gets its increment where it always has
 * (callPanelBrain); this is the dual entry that makes client spend visible
 * and capped on the roadmap ledger. Uncapped increment on purpose: the
 * admission headroom check is the gate, and a run in flight must never be
 * starved mid-panel. */
export async function recordRoadmapBrainCall(): Promise<void> {
  await ensureToday();
  await db.execute(sql`
    UPDATE roadmap_usage SET brain_calls = brain_calls + 1
    WHERE day = ${today()}
  `);
}

/** Apollo page-budget spend (checked before each page fetch). */
export async function trySpendApolloCall(): Promise<boolean> {
  return trySpendRoadmap("apollo_calls", 1, apolloDailyCallCap(process.env));
}

// ---- Phases 09/10/11: the builder platform links (§5.20) ----

const CRL = schema.companyRoadmapLinks;

/** Lane axis for company_roadmap_links, same shape and same rule as
 * DirectoryScope: companyId null = the XL.net STAFF lane. REQUIRED on every
 * function below so a missed lane filter is a compile error. */
export type LinkScope = { companyId: string | null };
export const STAFF_LINK_SCOPE: LinkScope = { companyId: null };

/** Never eq() a null: drizzle renders "= NULL", which matches nothing. */
function linkLaneWhere(scope: LinkScope) {
  return scope.companyId === null
    ? isNull(CRL.companyId)
    : eq(CRL.companyId, scope.companyId);
}

export type LinkRow = typeof CRL.$inferSelect;
/** The three singleton kinds plus the 1:N tool card. */
export type LinkKind = "api_proxy" | "dev_vms" | "lakehouse" | "tool";
/** Per-URL verification state. ONLY "ok" may ever count toward a step or
 * the completion percentage (owner rule: an unreachable URL is saved, and
 * says so, but does not count). */
export type LinkCheckState =
  | "unchecked"
  | "ok"
  | "internal"
  | "attested"
  | "failed";


export async function listRoadmapLinks(scope: LinkScope): Promise<LinkRow[]> {
  return db
    .select()
    .from(CRL)
    .where(linkLaneWhere(scope))
    .orderBy(asc(CRL.createdAt));
}

export async function getSingletonLink(
  scope: LinkScope,
  kind: Exclude<LinkKind, "tool">
): Promise<LinkRow | null> {
  const rows = await db
    .select()
    .from(CRL)
    .where(and(linkLaneWhere(scope), eq(CRL.kind, kind)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listTools(
  scope: LinkScope,
  limit: number
): Promise<LinkRow[]> {
  return db
    .select()
    .from(CRL)
    .where(and(linkLaneWhere(scope), eq(CRL.kind, "tool")))
    .orderBy(asc(CRL.createdAt))
    .limit(limit);
}

export async function countTools(scope: LinkScope): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(CRL)
    .where(and(linkLaneWhere(scope), eq(CRL.kind, "tool")));
  return rows[0]?.n ?? 0;
}

/**
 * Save one of the three singletons.
 *
 * READ-THEN-WRITE rather than ON CONFLICT: the two lanes are protected by
 * two DIFFERENT partial unique indexes (company vs the NULL staff lane), so
 * a single upsert target cannot serve both. The unique indexes are still
 * the real arbiter - a lost race raises, and we retry once as an update.
 *
 * THE LOAD-BEARING RULE IS THE RESET: changing a URL clears that field's
 * verification state back to "unchecked". Carrying the old "ok" forward
 * would let an admin verify a reachable URL, edit it to anything at all,
 * and keep the step lit on evidence that was never gathered about the value
 * now stored.
 */
export async function saveSingletonLink(opts: {
  scope: LinkScope;
  kind: Exclude<LinkKind, "tool">;
  url: string | null;
  docsUrl: string | null;
  environments: string[] | null;
  addedByUserId: string | null;
  addedByEmail: string;
}): Promise<LinkRow> {
  const existing = await getSingletonLink(opts.scope, opts.kind);
  const envJson = opts.environments ? JSON.stringify(opts.environments) : null;
  if (!existing) {
    try {
      const [row] = await db
        .insert(CRL)
        .values({
          companyId: opts.scope.companyId,
          kind: opts.kind,
          url: opts.url,
          docsUrl: opts.docsUrl,
          environmentsJson: envJson,
          addedByUserId: opts.addedByUserId,
          addedByEmail: opts.addedByEmail,
        })
        .returning();
      return row;
    } catch (err) {
      if (
        !isUniqueViolation(
          err,
          "roadmap_links_singleton_uq",
          "roadmap_links_singleton_staff_uq"
        )
      )
        throw err;
      // Lost the race: fall through and update the winner's row.
      const winner = await getSingletonLink(opts.scope, opts.kind);
      if (!winner) throw err;
      return updateSingletonRow(winner, opts.url, opts.docsUrl, envJson);
    }
  }
  return updateSingletonRow(existing, opts.url, opts.docsUrl, envJson);
}

async function updateSingletonRow(
  existing: LinkRow,
  url: string | null,
  docsUrl: string | null,
  envJson: string | null
): Promise<LinkRow> {
  const urlChanged = (existing.url ?? null) !== (url ?? null);
  const docsChanged = (existing.docsUrl ?? null) !== (docsUrl ?? null);
  const [row] = await db
    .update(CRL)
    .set({
      url,
      docsUrl,
      environmentsJson: envJson,
      updatedAt: new Date(),
      // Reset ONLY the field that actually changed, so re-saving the VM
      // environment list does not throw away a confirmed instructions URL.
      ...(urlChanged
        ? {
            urlState: "unchecked" as const,
            urlReason: null,
            urlHttpStatus: null,
            urlCheckedAt: null,
            // BOTH of these must go with the state, and leaving either was
            // a bug. grace_until on a non-failed state violates
            // company_roadmap_links_grace_ck, so editing a URL while it sat
            // inside its grace window would have 500ed. And an attestation
            // describes ONE address: carrying the attester across an edit
            // would leave a person's name on a value they never saw.
            urlGraceUntil: null,
            urlAttestedBy: null,
          }
        : {}),
      ...(docsChanged
        ? {
            docsState: "unchecked" as const,
            docsReason: null,
            docsHttpStatus: null,
            docsCheckedAt: null,
            docsGraceUntil: null,
            docsAttestedBy: null,
          }
        : {}),
    })
    .where(eq(CRL.id, existing.id))
    .returning();
  return row;
}

export async function addToolLink(opts: {
  scope: LinkScope;
  label: string;
  description: string | null;
  url: string;
  docsUrl: string | null;
  addedByUserId: string | null;
  addedByEmail: string;
}): Promise<LinkRow> {
  const [row] = await db
    .insert(CRL)
    .values({
      companyId: opts.scope.companyId,
      kind: "tool",
      label: opts.label,
      description: opts.description,
      url: opts.url,
      docsUrl: opts.docsUrl,
      addedByUserId: opts.addedByUserId,
      addedByEmail: opts.addedByEmail,
    })
    .returning();
  return row;
}

/** Edit a tool card. The id is ALWAYS bound together with the lane, so a
 * row id from another tenant matches nothing (fetchOwnedProject
 * discipline). Same verification reset rule as the singletons. */
export async function updateToolLink(opts: {
  scope: LinkScope;
  id: string;
  label: string;
  description: string | null;
  url: string;
  docsUrl: string | null;
}): Promise<LinkRow | null> {
  const rows = await db
    .select()
    .from(CRL)
    .where(
      and(linkLaneWhere(opts.scope), eq(CRL.id, opts.id), eq(CRL.kind, "tool"))
    )
    .limit(1);
  const existing = rows[0];
  if (!existing) return null;
  const urlChanged = existing.url !== opts.url;
  const docsChanged = (existing.docsUrl ?? null) !== (opts.docsUrl ?? null);
  const [row] = await db
    .update(CRL)
    .set({
      label: opts.label,
      description: opts.description,
      url: opts.url,
      docsUrl: opts.docsUrl,
      updatedAt: new Date(),
      ...(urlChanged
        ? {
            urlState: "unchecked" as const,
            urlReason: null,
            urlHttpStatus: null,
            urlCheckedAt: null,
            // BOTH of these must go with the state, and leaving either was
            // a bug. grace_until on a non-failed state violates
            // company_roadmap_links_grace_ck, so editing a URL while it sat
            // inside its grace window would have 500ed. And an attestation
            // describes ONE address: carrying the attester across an edit
            // would leave a person's name on a value they never saw.
            urlGraceUntil: null,
            urlAttestedBy: null,
          }
        : {}),
      ...(docsChanged
        ? {
            docsState: "unchecked" as const,
            docsReason: null,
            docsHttpStatus: null,
            docsCheckedAt: null,
            docsGraceUntil: null,
            docsAttestedBy: null,
          }
        : {}),
    })
    .where(eq(CRL.id, existing.id))
    .returning();
  return row;
}

export async function removeToolLink(opts: {
  scope: LinkScope;
  id: string;
}): Promise<boolean> {
  const rows = await db
    .delete(CRL)
    .where(
      and(linkLaneWhere(opts.scope), eq(CRL.id, opts.id), eq(CRL.kind, "tool"))
    )
    .returning({ id: CRL.id });
  return rows.length > 0;
}

/**
 * Record the outcome of one reachability check against one field of one row.
 *
 * BOUND TO THE PROBED URL, not just to (lane, id), and that is the whole
 * point of the `probedUrl` parameter. A check takes seconds; the row can be
 * edited while it runs. Without this predicate the sequence
 *
 *   save A -> probe A starts -> save B (state resets to unchecked) ->
 *   probe A finishes -> UPDATE ... WHERE id = row
 *
 * stamps "ok" onto B, an address nothing ever reached. That turns the
 * verification into something an admin can forge by editing during the
 * window, which would defeat the entire saved-but-not-counted rule (and
 * would let a private address inherit a public address's pass). Binding the
 * UPDATE to the value we actually measured makes the late write a no-op
 * instead: it matches nothing, returns null, and the row correctly stays
 * unchecked until something probes what is now stored.
 *
 * Returns the fresh row, or null if the row vanished, never belonged to
 * this lane, or moved underneath the probe.
 */
export async function recordLinkCheck(opts: {
  scope: LinkScope;
  id: string;
  field: "url" | "docs";
  /** The exact string that was probed. */
  probedUrl: string;
  /** "unchecked" is reachable via the attestation WITHDRAW path,
   * which is not a verdict and must leave the field re-checkable. */
  state: LinkCheckState;
  reason: string | null;
  httpStatus: number | null;
  /** Rung 3 only: who asserted it. */
  attestedBy?: string | null;
  /** Optional second half of the compare-and-swap: only write if the field
   * is STILL in this state. The nightly job passes the state it selected,
   * because binding the URL alone left a window where an admin attested a
   * field after the batch was chosen and the job then overwrote a person's
   * claim with a machine verdict. */
  expectState?: string;
}): Promise<LinkRow | null> {
  const now = new Date();
  const stateCol = opts.field === "url" ? "url_state" : "docs_state";
  const graceCol = opts.field === "url" ? "url_grace_until" : "docs_grace_until";
  /**
   * The HYSTERESIS, computed in SQL so it reads the row's CURRENT state
   * atomically rather than a snapshot this process took seconds ago.
   *
   *  - a passing rung clears grace outright.
   *  - the FIRST failure of a field that was counting opens the window.
   *  - a later failure keeps the EXISTING deadline. Extending it on every
   *    failure would make the window slide forever and a dead endpoint
   *    would count until the heat death of the roadmap.
   *  - a field that never counted gets no grace at all: there is nothing
   *    to protect, and inventing one would let a brand new bad URL count.
   */
  // Grace belongs to a FAILING field and nothing else. Gating on "not
  // counting" instead was a bug: the attestation-withdraw path writes
  // "unchecked", which is not counting, so it would have opened a grace
  // window on an unchecked field and tripped the grace_ck CHECK
  // (grace_until IS NULL OR state = 'failed'), turning a withdraw into a
  // 500.
  const graceExpr = opts.state !== "failed"
    ? sql`NULL`
    : sql`CASE
            WHEN ${sql.raw(`"${stateCol}"`)} IN ('ok','internal','attested')
              THEN now() + ${sql.raw(`interval '${ROADMAP_CAPS.linkGraceHours} hours'`)}
            ELSE ${sql.raw(`"${graceCol}"`)}
          END`;
  const set =
    opts.field === "url"
      ? {
          urlState: opts.state,
          urlReason: opts.reason,
          urlHttpStatus: opts.httpStatus,
          urlCheckedAt: now,
          urlGraceUntil: graceExpr,
          urlAttestedBy: opts.state === "attested" ? (opts.attestedBy ?? null) : null,
          updatedAt: now,
        }
      : {
          docsState: opts.state,
          docsReason: opts.reason,
          docsHttpStatus: opts.httpStatus,
          docsCheckedAt: now,
          docsGraceUntil: graceExpr,
          docsAttestedBy: opts.state === "attested" ? (opts.attestedBy ?? null) : null,
          updatedAt: now,
        };
  const rows = await db
    .update(CRL)
    .set(set)
    .where(
      and(
        linkLaneWhere(opts.scope),
        eq(CRL.id, opts.id),
        // The TOCTOU fence described above.
        opts.field === "url"
          ? eq(CRL.url, opts.probedUrl)
          : eq(CRL.docsUrl, opts.probedUrl),
        ...(opts.expectState
          ? [
              opts.field === "url"
                ? eq(CRL.urlState, opts.expectState)
                : eq(CRL.docsState, opts.expectState),
            ]
          : [])
      )
    )
    .returning();
  return rows[0] ?? null;
}

/** One field of one row that the nightly re-check should look at again,
 * carrying the lane's VERIFIED domain so rung 2 can be re-evaluated without
 * the job having to know how tenancy works. */
export type RecheckCandidate = {
  id: string;
  companyId: string | null;
  kind: string;
  field: "url" | "docs";
  url: string;
  state: string;
  checkedAt: Date | null;
  /** companies.domain, or STAFF_LANE_DOMAIN for the NULL lane. */
  internalDomain: string;
};

/**
 * Rows whose verdict has gone stale, oldest first.
 *
 * ACROSS ALL LANES on purpose: this is the one caller that is not
 * tenant-scoped, because it is the background job rather than a request.
 * It reads companies.domain through a LEFT JOIN so a staff-lane row (NULL
 * company_id, no companies row) still gets its domain.
 *
 * INCLUDED: 'unchecked', because a save whose check the limiter refused and
 * a withdrawn attestation both land there and nothing else revisits them.
 *
 * NOT INCLUDED: "attested" fields. A human claim does not go stale because
 * a clock ticked, and silently re-checking one would either overwrite a
 * person's assertion with a machine verdict or waste a probe on an address
 * we already know we cannot reach. Re-affirmation is a UI prompt, not a job.
 */
export async function linksDueForRecheck(opts: {
  reachedAfterHours: number;
  internalAfterHours: number;
  failedAfterHours: number;
  limit: number;
  staffDomain: string;
}): Promise<RecheckCandidate[]> {
  const rows = await db.execute<{
    id: string;
    company_id: string | null;
    kind: string;
    field: string;
    url: string;
    state: string;
    checked_at: Date | null;
    domain: string | null;
  }>(sql`
    WITH fields AS (
      SELECT l.id, l.company_id, l.kind, 'url' AS field, l.url AS url,
             l.url_state AS state, l.url_checked_at AS checked_at
        FROM company_roadmap_links l
       WHERE l.url IS NOT NULL
      UNION ALL
      SELECT l.id, l.company_id, l.kind, 'docs' AS field, l.docs_url AS url,
             l.docs_state AS state, l.docs_checked_at AS checked_at
        FROM company_roadmap_links l
       WHERE l.docs_url IS NOT NULL
    )
    SELECT f.*, c.domain, c.status AS company_status
      FROM fields f
      LEFT JOIN companies c ON c.id = f.company_id
     WHERE
       -- A SUSPENDED company keeps its reads and loses this, exactly as it
       -- loses the interactive check (requirePlatformAdmin): "can still aim
       -- our outbound requests wherever they like" is not a capability a
       -- suspended tenant should keep, and an unattended nightly job is a
       -- worse place to leave it than a form.
       (f.company_id IS NULL OR c.status = 'active')
       AND (
        (f.state = 'ok'       AND (f.checked_at IS NULL OR f.checked_at < now() - make_interval(hours => ${opts.reachedAfterHours})))
     OR (f.state = 'internal' AND (f.checked_at IS NULL OR f.checked_at < now() - make_interval(hours => ${opts.internalAfterHours})))
     OR (f.state = 'failed'   AND (f.checked_at IS NULL OR f.checked_at < now() - make_interval(hours => ${opts.failedAfterHours})))
     -- 'unchecked' is due too. Two supported paths park a field there and
     -- nothing else would ever revisit it: a save whose check was refused
     -- by the rate limiter, and a withdrawn attestation. Leaving it out
     -- made those fields permanently uncounted with no automatic way back.
     OR (f.state = 'unchecked' AND (f.checked_at IS NULL OR f.checked_at < now() - make_interval(hours => ${opts.failedAfterHours})))
     )
     ORDER BY f.checked_at ASC NULLS FIRST
     LIMIT ${opts.limit}
  `);
  const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? []);
  return (list as Record<string, unknown>[])
    .map((r) => {
      const companyId = (r.company_id as string | null) ?? null;
      const domain = (r.domain as string | null) ?? null;
      // COALESCE(domain, STAFF) would merge two different things: "this is
      // the staff lane" and "this row points at a company that is not
      // there". The second is a data fault, and defaulting it to xl.net
      // would check a stranger's row against OUR domain, which is the one
      // binding rung 2 rests on. Only a genuinely NULL lane gets the staff
      // domain; an orphan is dropped.
      if (companyId !== null && !domain) return null;
      return {
        id: String(r.id),
        companyId,
        kind: String(r.kind),
        field: r.field === "url" ? ("url" as const) : ("docs" as const),
        url: String(r.url),
        state: String(r.state),
        checkedAt: (r.checked_at as Date | null) ?? null,
        internalDomain: domain ?? opts.staffDomain,
      };
    })
    .filter((r): r is RecheckCandidate => r !== null);
}
