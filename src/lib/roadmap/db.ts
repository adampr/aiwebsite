// DB access for the Your AI Roadmap portal (§5.18). Every company-scoped
// function takes companyId from the caller's SERVER-DERIVED principal (or a
// requireGlobalAdmin-guarded request param on /admin/roadmap only) and binds
// it into its WHERE clause — no function trusts a row id alone to imply a
// tenant (governance db.ts fetchOwnedProject discipline).

import crypto from "node:crypto";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { isCompanyEligibleDomain } from "@/lib/roadmap/domains";
import {
  ROADMAP_CAPS,
  apolloDailyCallCap,
  roadmapBrainDailyCap,
  roadmapPanelRunsDailyCap,
} from "@/lib/roadmap/config";
import {
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
const W = schema.workSubmissions;
const U = schema.users;

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

export async function listPeople(companyId: string): Promise<PersonRow[]> {
  return db
    .select()
    .from(CP)
    .where(eq(CP.companyId, companyId))
    .orderBy(asc(CP.name))
    .limit(ROADMAP_CAPS.directoryRenderMax);
}

export async function countPeople(companyId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(CP)
    .where(eq(CP.companyId, companyId));
  return rows[0]?.n ?? 0;
}

export async function addPerson(opts: {
  companyId: string;
  name: string;
  email: string | null;
  phone: string | null;
}): Promise<PersonRow> {
  const [row] = await db
    .insert(CP)
    .values({
      companyId: opts.companyId,
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
  companyId: string;
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
    .where(and(eq(CP.id, opts.personId), eq(CP.companyId, opts.companyId)))
    .returning();
  return rows[0] ?? null;
}

/** Hard delete; when suppress is set (default for Apollo rows in the UI) the
 * email's sha256 is recorded so re-imports skip this person for good. */
export async function removePerson(opts: {
  companyId: string;
  personId: string;
  suppress: boolean;
}): Promise<PersonRow | null> {
  const rows = await db
    .delete(CP)
    .where(and(eq(CP.id, opts.personId), eq(CP.companyId, opts.companyId)))
    .returning();
  const row = rows[0];
  if (row && opts.suppress && row.email) {
    await db
      .insert(DS)
      .values({
        companyId: opts.companyId,
        emailSha256: sha256Hex(row.email.toLowerCase()),
      })
      .onConflictDoNothing();
  }
  return row ?? null;
}

export async function suppressedHashes(
  companyId: string
): Promise<Set<string>> {
  const rows = await db
    .select({ h: DS.emailSha256 })
    .from(DS)
    .where(eq(DS.companyId, companyId));
  return new Set(rows.map((r) => r.h));
}

/** Apollo import upsert: keyed on (company_id, apollo_id); rows a human has
 * edited (source 'manual') are never clobbered. Returns what happened for
 * the admin-facing result line. */
export async function upsertApolloPerson(opts: {
  companyId: string;
  apolloId: string;
  name: string;
  email: string | null;
  phone: string | null;
}): Promise<"added" | "updated" | "kept_manual"> {
  const existing = await db
    .select({ id: CP.id, source: CP.source })
    .from(CP)
    .where(and(eq(CP.companyId, opts.companyId), eq(CP.apolloId, opts.apolloId)))
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
      companyId: opts.companyId,
      apolloId: opts.apolloId,
      name: opts.name,
      email: opts.email ? opts.email.toLowerCase() : null,
      phone: opts.phone,
      source: "apollo",
    })
    .onConflictDoNothing();
  return "added";
}

export async function stampApolloImport(
  companyId: string,
  count: number
): Promise<void> {
  await db
    .update(C)
    .set({
      apolloLastImportAt: new Date(),
      apolloLastImportCount: count,
      updatedAt: new Date(),
    })
    .where(eq(C.id, companyId));
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
};

/** Directory members with published-card counts, plus published submitters
 * missing from the directory. Counts PUBLISHED cards only: held, failed,
 * and in-review rows never appear anywhere in the scorecard, so it can
 * never reveal that a colleague tried and failed. */
export async function companyScorecard(
  companyId: string
): Promise<ScorecardRow[]> {
  const people = await listPeople(companyId);
  const counts = await db
    .select({
      email: sql<string>`lower(${W.submitterEmail})`,
      n: sql<number>`count(*)::int`,
      last: sql<Date | null>`max(${W.publishedAt})`,
    })
    .from(W)
    .where(and(eq(W.companyId, companyId), eq(W.status, "published")))
    .groupBy(sql`lower(${W.submitterEmail})`);
  const byEmail = new Map(counts.map((c) => [c.email, c]));
  const rows: ScorecardRow[] = people.map((p) => {
    const hit = p.email ? byEmail.get(p.email.toLowerCase()) : undefined;
    if (p.email) byEmail.delete(p.email.toLowerCase());
    return {
      personId: p.id,
      name: p.name,
      email: p.email,
      published: hit?.n ?? 0,
      lastPublishedAt: hit?.last ?? null,
      inDirectory: true,
    };
  });
  for (const [email, c] of byEmail) {
    rows.push({
      personId: null,
      name: null,
      email,
      published: c.n,
      lastPublishedAt: c.last,
      inDirectory: false,
    });
  }
  rows.sort(
    (a, b) => b.published - a.published || (a.name ?? a.email ?? "").localeCompare(b.name ?? b.email ?? "")
  );
  return rows;
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
}> {
  const deleted = await db
    .delete(W)
    .where(eq(W.companyId, companyId))
    .returning({ id: W.id });
  await db.delete(C).where(eq(C.id, companyId));
  return { submissions: deleted.length };
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
