// Your AI Roadmap (ARCHITECTURE.md §5.18). Host-owned tables for the
// per-client-company portal at /roadmap: a company is keyed by its verified
// email DOMAIN (exact lowercase label, strict emailDomain() parser from
// src/lib/rfp/access.ts — never the module's split("@")[1] idiom).
//
// Membership is COMPUTED, never stored: a trusted session whose email domain
// equals companies.domain is a member. The ONLY stored authorization fact is
// the company-admin role (company_admins). This keeps the tenancy boundary in
// one predicate (src/lib/roadmap/access.ts) with no membership rows to sync.
//
// Conventions follow schema.ts: uuid PKs for entity tables, serial for
// join/log rows, JSON as text("*_json") never jsonb, timestamptz throughout,
// denormalized lowercased emails beside SET NULL user FKs so audit fields
// survive account deletion.
//
// Hand-written CHECKs and partial/expression indexes live ONLY in
// drizzle/migrations/0035 (drizzle cannot model them; 0033/0034 precedent).
// Deploys must keep using `drizzle-kit migrate`, never `push`.

import {
  customType,
  date,
  pgTable,
  serial,
  text,
  timestamp,
  uuid,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./schema";

// drizzle-orm has no built-in pg bytea (schema.ts precedent; local copy keeps
// the schema.ts diff to the one company_id column for concurrent sessions).
const bytea = customType<{ data: Buffer; notNull: false; default: false }>({
  dataType() {
    return "bytea";
  },
});

// One row per client company, keyed by verified email domain. Created only by
// an explicit "Set up workspace" click from a trusted, domain-eligible
// session (never a sign-in side effect); the domain UNIQUE index is the
// bootstrap race arbiter — exactly one first admin per company.
// Migration-only CHECK (companies_domain_ck): domain lowercased, never
// xl.net / ai.xl.net (would shadow the staff email-intake lane), never
// *.onmicrosoft.com (free Entra tenants mint "verified" addresses there).
// Freemail exclusion is code-level (isCompanyEligibleDomain) with a second
// code-level backstop in companyForDomain, so a bad row cannot open the
// email lane to a shared mailbox population.
export const companies = pgTable(
  "companies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    domain: text("domain").notNull(),
    name: text("name").notNull(), // display; defaults to domain
    status: text("status").notNull().default("active"), // "active" | "suspended"
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdByEmail: text("created_by_email").notNull(),
    apolloLastImportAt: timestamp("apollo_last_import_at", {
      withTimezone: true,
    }),
    apolloLastImportCount: integer("apollo_last_import_count"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("companies_domain_uq").on(t.domain)]
);

// The ONE stored authorization fact: who administers a company. CASCADE both
// ways — a deleted user loses the role instantly; the "email all admins"
// recipient list is a JOIN to users, never a denormalized email on a live
// authorization row. The principal lookup predicate is ALWAYS
// (company_id = principal.company.id AND user_id = principal.userId); a
// grant whose company does not match the grantee's email domain is refused
// at the grant routes, so a role can never follow a user across tenants.
export const companyAdmins = pgTable(
  "company_admins",
  {
    id: serial("id").primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    grantedVia: text("granted_via").notNull(), // "bootstrap" | "request:<uuid>" | "global_admin"
    grantedByEmail: text("granted_by_email").notNull(), // "system" for bootstrap
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("company_admins_member_uq").on(t.companyId, t.userId),
    index("company_admins_user_idx").on(t.userId),
  ]
);

// Request Admin Access (§5.18): the emailed link only IDENTIFIES the request
// (no capability token — approval demands a live verified approver session;
// a forwarded email authorizes nothing). Approval race is fenced by the
// UPDATE ... WHERE status='pending' rowCount. Decided rows are kept as audit.
// Migration-only partial unique: one pending request per requester+company.
export const companyAdminRequests = pgTable(
  "company_admin_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    requesterUserId: uuid("requester_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    requesterEmail: text("requester_email").notNull(),
    status: text("status").notNull().default("pending"), // "pending" | "approved" | "denied"
    notifiedEmailsJson: text("notified_emails_json"),
    decidedByUserId: uuid("decided_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    decidedByEmail: text("decided_by_email"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(), // created + 7 days
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("company_admin_req_company_idx").on(t.companyId, t.status)]
);

// Company directory (roadmap step 2): exactly name/email/phone (privacy
// minimization — no title/seniority/social columns; Apollo's raw response is
// never persisted or logged). source flips 'apollo' -> 'manual' on first
// human edit; re-import upserts on apollo_id but never clobbers a manual row.
// Removal is a hard DELETE. company_id NULL = the XL.net STAFF lane
// (migration 0039; the work_submissions/work_requests internal-lane
// pattern) — NULL rows have no parent and are cascade-immune; every read
// and write goes through a required DirectoryScope (src/lib/roadmap/db.ts)
// so a missed lane filter is a compile error. Migration-only uniques:
// (company_id, lower(email)) WHERE email IS NOT NULL and (company_id,
// apollo_id) WHERE apollo_id IS NOT NULL, plus the 0039 NULL-lane partials
// company_people_email_staff_uq / company_people_apollo_staff_uq (composite
// btrees treat NULL company_id rows as always-distinct, so the 0035 indexes
// never dedupe the staff lane).
export const companyPeople = pgTable(
  "company_people",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").references(() => companies.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    email: text("email"), // lowercased at write edge; nullable (Apollo gaps)
    phone: text("phone"),
    source: text("source").notNull().default("manual"), // "apollo" | "manual"
    apolloId: text("apollo_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("company_people_company_idx").on(t.companyId, t.name)]
);

// Deletion must survive re-import: when an admin removes an Apollo-sourced
// person, the sha256 of the lowercased email is recorded (the PII itself is
// not retained) and future imports skip it, reporting "N skipped as
// previously removed". Without this the next import silently resurrects a
// person who exercised deletion. company_id NULL = the staff lane (0039;
// NULL-lane unique directory_suppr_staff_uq on email_sha256).
export const directorySuppressions = pgTable(
  "directory_suppressions",
  {
    id: serial("id").primaryKey(),
    companyId: uuid("company_id").references(() => companies.id, {
      onDelete: "cascade",
    }),
    emailSha256: text("email_sha256").notNull(),
    removedAt: timestamp("removed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("directory_suppr_uq").on(t.companyId, t.emailSha256)]
);

// Roadmap step 1: a governance document on file for the company. Always a
// SNAPSHOT, never a reference — attaching a Governance Builder project COPIES
// its rendered markdown at attach time (governance_project_id is inert
// provenance, deliberately NO FK), so the source project keeps its 30-day
// lifecycle untouched and the no-ledger reversal is scoped to one explicit
// self-selection consent event by the project's OWNER. Upload lane keeps the
// original bytes (~10 MB route cap) plus extracted text for future use.
// company_id NULL = the XL.net STAFF lane (the company_people / roadmap_links
// precedent, migration 0045): xl.net can never be a companies row, so the
// staff document rides the NULL lane and is written only by global admins.
export const companyGovernanceDocs = pgTable(
  "company_governance_docs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").references(() => companies.id, {
      onDelete: "cascade",
    }),
    source: text("source").notNull(), // "upload" | "governance_project"
    title: text("title").notNull(),
    fileName: text("file_name"),
    fileMime: text("file_mime"), // recorded only; downloads always serve octet-stream
    fileSha256: text("file_sha256"),
    fileBytes: integer("file_bytes"),
    fileData: bytea("file_data"),
    docText: text("doc_text"), // extracted text (upload) or snapshotted markdown
    governanceProjectId: text("governance_project_id"), // inert provenance, no FK
    governanceKind: text("governance_kind"), // usage_policy|nist_ai_rmf|eu_ai_act|iso_42001
    addedByUserId: uuid("added_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    addedByEmail: text("added_by_email").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("company_gov_docs_company_idx").on(t.companyId)]
);

// One-row staff-lane analogue of companies.apollo_last_import_* (the staff
// lane has no companies row by invariant): the durable auto-kick once-flag
// for the XL.net directory import. CHECK (id = 1) is migration-only (0039),
// which also SEEDS the row; the stamp write is an UPSERT regardless, so a
// missing row can never silently no-op the stamp and re-arm the auto-kick.
export const staffRoadmapState = pgTable("staff_roadmap_state", {
  id: integer("id").primaryKey(),
  apolloLastImportAt: timestamp("apollo_last_import_at", {
    withTimezone: true,
  }),
  apolloLastImportCount: integer("apollo_last_import_count"),
});

// Phases 09/10/11 (§5.20): the platform a company gives its builders. ONE
// table with a `kind` discriminator, because every row is the same shape -
// a URL, an instructions URL, and the verification state of each - and the
// only difference is arity: api_proxy / dev_vms / lakehouse are 0:1
// singletons, `tool` is 1:N (the paginated Builder Tools cards).
//
// company_id NULL = the XL.net STAFF lane (the company_people /
// work_submissions precedent), so staff get real pages rather than a blank
// (steps) shell. Every read and write takes a required LinkScope
// (src/lib/roadmap/db.ts), so a missed lane filter is a compile error.
//
// SINGLETON ENFORCEMENT IS AN INDEX, NOT APPLICATION CODE: two concurrent
// saves would both pass a "does one exist" read. Migration 0041 carries
// roadmap_links_singleton_uq (company_id, kind) WHERE kind <> 'tool', PLUS
// a separate NULL-lane partial unique on (kind) alone - a composite btree
// treats every NULL company_id row as distinct, so the first index would
// never dedupe the staff lane (the trap 0039 was written to fix).
//
// VERIFICATION IS PER URL FIELD and never inferred: url_state/docs_state
// are 'unchecked' | 'ok' | 'failed', and ONLY 'ok' may count toward a
// step or the completion percentage. An unreachable URL is still SAVED
// (owner rule: save it, tell the user, let them edit or retry), which is
// exactly why the state lives in its own column rather than being implied
// by the URL's presence.
export const companyRoadmapLinks = pgTable(
  "company_roadmap_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").references(() => companies.id, {
      onDelete: "cascade",
    }),
    kind: text("kind").notNull(), // "api_proxy" | "dev_vms" | "lakehouse" | "tool"
    // Tool cards only; NULL on the singletons.
    label: text("label"),
    description: text("description"),
    // The primary URL. NULL on dev_vms, whose "enabled" input is the
    // hosting-environment list plus instructions, not an endpoint.
    url: text("url"),
    // EVIDENCE LADDER (§5.20 round 2). The vocabulary is
    // "unchecked" | "ok" | "internal" | "attested" | "failed", and the three
    // middle values are the three rungs that COUNT:
    //   ok       we reached it over HTTP
    //   internal the host is inside the tenant's verified domain AND resolves
    //            into private space; machine-checked, and we never connect
    //   attested a named admin asserted it after a real check failed
    // Rungs exist because the check asks "can XL.net reach this" as a stand-in
    // for "can your builders reach this", and those are unrelated for an
    // endpoint that lives on the company's own network. Without the ladder a
    // company that keeps its proxy off the public internet, which is the
    // better posture, could never complete a step called Secure AI Builders.
    urlState: text("url_state").notNull().default("unchecked"),
    urlReason: text("url_reason"), // UrlCheckFailReason when failed
    urlHttpStatus: integer("url_http_status"),
    urlCheckedAt: timestamp("url_checked_at", { withTimezone: true }),
    // HYSTERESIS. When a field that was counting starts failing, this is set
    // to now + a grace window instead of dropping the step immediately, and
    // the field keeps counting until it passes. A success clears it. One bad
    // minute on a customer's server must not un-light a step; a genuinely
    // dead endpoint must eventually stop counting. Time-based rather than a
    // failure counter so an every-other-day flap still expires.
    urlGraceUntil: timestamp("url_grace_until", { withTimezone: true }),
    /** Who attested, for state "attested". Attribution IS the control. */
    urlAttestedBy: text("url_attested_by"),
    docsUrl: text("docs_url"), // the associated instructions URL
    docsState: text("docs_state").notNull().default("unchecked"),
    docsReason: text("docs_reason"),
    docsHttpStatus: integer("docs_http_status"),
    docsCheckedAt: timestamp("docs_checked_at", { withTimezone: true }),
    docsGraceUntil: timestamp("docs_grace_until", { withTimezone: true }),
    docsAttestedBy: text("docs_attested_by"),
    // dev_vms only: the multi-select hosting environments, free-form
    // entries included. text("*_json"), never jsonb (schema.ts convention).
    environmentsJson: text("environments_json"),
    addedByUserId: uuid("added_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    addedByEmail: text("added_by_email").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("company_roadmap_links_company_idx").on(t.companyId, t.kind)]
);

// Daily budget ledger for the client population (work_usage pattern).
// brain_calls counts ACTUALS only — company-scope panel/title-infer brain
// calls dual-increment this AND work_usage; panel_runs is spent 1 per
// admitted company run on BOTH ledgers and refunded on busy/claim refusal on
// BOTH. No worst-case reservation is ever written to either ledger.
// apollo_calls counts Apollo API page fetches against APOLLO_DAILY_CALL_CAP.
export const roadmapUsage = pgTable("roadmap_usage", {
  day: date("day").primaryKey(),
  apolloCalls: integer("apollo_calls").notNull().default(0),
  brainCalls: integer("brain_calls").notNull().default(0),
  panelRuns: integer("panel_runs").notNull().default(0),
});
