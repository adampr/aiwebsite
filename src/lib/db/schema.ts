// Composed site tables (packages/aicompany/architecture.md §6, §12.4). The
// HOST owns these: shared tables come from the module's schema factories
// (users carries the texting columns since texting.enabled), and host-specific
// tables live below. src/lib/db/index.ts registers the shared set with the
// module's client so module code reads/writes these exact table objects.
//
// The composed shapes are identical to the tables this file used to define
// inline — existing rows are already in the module's shape (they are its
// source; see packages/aicompany/MIGRATIONS.md "aiwebsite adoption baseline").

import {
  pgTable,
  serial,
  text,
  timestamp,
  inet,
  uuid,
  integer,
  boolean,
  date,
  index,
} from "drizzle-orm/pg-core";
import {
  makeAdminEmailsTable,
  makeAuthLogsTable,
  makeBlogHeroImagesTable,
  makeBlogPostsTable,
  makeIpOrgsTable,
  makeMemoryDeletionLogsTable,
  makePageVisitsTable,
  makePhoneVerificationsTable,
  makeSmsConsentLogsTable,
  makeSmsMemoryNoticesTable,
  makeSmsNoticesTable,
  makeSmsPromptEventsTable,
  makeUsersTable,
  textingUserColumns,
} from "@aicompany/core/db/schema";

// phone / phoneVerifiedAt / smsOptInAt / smsPromptDismissedAt — the verified
// SMS opt-in columns (texting.enabled).
export const users = makeUsersTable({ ...textingUserColumns });

export const authLogs = makeAuthLogsTable(users);

// One row per tracked page view; written only by /api/internal/track
// (fed by middleware.ts, secret-gated). Feeds /admin/seo and /admin/companies.
export const pageVisits = makePageVisitsTable();

// IP → owning-organization cache (MaxMind GeoLite2-ASN); each IP is looked
// up once, nulls cached too so misses aren't retried.
export const ipOrgs = makeIpOrgsTable();

// Emails composed by a human admin from /admin/mailbox. Tron's own email
// turns live in brain_messages; this table only records manual sends so
// mailbox threads show them alongside the AI conversation.
export const adminEmails = makeAdminEmailsTable();

// TCPA compliance — immutable audit trail of SMS opt-ins/opt-outs. Never
// update or delete rows; retention is the life of the messaging program
// plus four years (see /privacy).
export const smsConsentLogs = makeSmsConsentLogsTable(users);

// One row per verification code sent from /texting. Codes are stored as
// SHA-256 hashes; a row is dead once consumed_at is set, expires_at passes,
// or attempts hits the cap. Only the newest live row per user is honored.
export const phoneVerifications = makePhoneVerificationsTable(users);

// Funnel telemetry for the SMS prompt card (shown → clicked → snoozed →
// dismissed); append-only, written by POST /api/auth/sms-prompt.
export const smsPromptEvents = makeSmsPromptEventsTable(users);

// One-time SMS notices, one row per phone+kind (module §5.10, v1.2.0): the
// durable once-ever record behind the registration invite (and the memory-off
// storage notice, which never fires here — memory.enabled). Keyed by E.164,
// not user id, so the guarantee outlives account linking.
export const smsNotices = makeSmsNoticesTable();

// AI-authored blog articles (module §19.2) — blog.enabled requires registry
// key "blogPosts". Written only by the nightly job / admin actions; rendered
// by the /blog wrappers.
export const blogPosts = makeBlogPostsTable();

// Hero image bytes (module §19.26, v1.3.0) — required since blog.heroImage
// uses createGeminiHeroGenerator's default DB storage (usesModuleDbTable).
// Written by the nightly hero hook / backfill CLI; served by the
// /blog/hero/[slug] wrapper.
export const blogHeroImages = makeBlogHeroImagesTable();

// ---- Host-owned tables (not part of the module contract) ----

// Memory feature tables (module contract since memory.enabled — §18):
// first-contact "Tron remembers — text FORGET to erase" disclosure tracking
// (row written only after the notice actually sent; deleted by FORGET so a
// returning texter is re-disclosed) and the proof-of-erasure audit for FORGET
// (per-brain-table deletion counts; retained + disclosed on /privacy).
export const smsMemoryNotices = makeSmsMemoryNoticesTable();
export const memoryDeletionLogs = makeMemoryDeletionLogsTable();

// AI Governance builder projects (§5.12). One row per project: documents,
// transcript, and research brief ride the row as JSON text so the 30-day
// hard DELETE removes everything at once (downloads are generated on demand,
// no blobs anywhere). last_activity_at drives retention: touched by create,
// research kick, answer/revise, confirm, and download — never by GET/poll.
export const governanceProjects = pgTable(
  "governance_projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // usage_policy|nist_ai_rmf|eu_ai_act|iso_42001
    domain: text("domain").notNull(),
    status: text("status").notNull().default("created"),
    rev: integer("rev").notNull().default(0),
    // Detached research job claim state (survives PM2 restarts):
    researchStartedAt: timestamp("research_started_at", { withTimezone: true }),
    researchHeartbeatAt: timestamp("research_heartbeat_at", {
      withTimezone: true,
    }),
    researchRuns: integer("research_runs").notNull().default(0),
    researchRunsDate: date("research_runs_date"), // daily reset for the 3/day guard
    researchProgressJson: text("research_progress_json"),
    researchJson: text("research_json"), // distilled brief, <=9000 chars
    researchFlagged: boolean("research_flagged").notNull().default(false),
    documentsJson: text("documents_json").notNull().default("[]"),
    transcriptJson: text("transcript_json").notNull().default("[]"),
    coveredBankIdsJson: text("covered_bank_ids_json").notNull().default("[]"),
    nextQuestionJson: text("next_question_json"),
    reviewSummary: text("review_summary"),
    changedSectionsJson: text("changed_sections_json"),
    // Optional user-uploaded sample policy (§5.12): drafts mirror its
    // formatting conventions. Extracted plain text only — the original file
    // is never stored — and it deletes with the row (30-day retention).
    styleSampleName: text("style_sample_name"),
    styleSampleText: text("style_sample_text"),
    // In-process answer-turn claim state (§5.12 async turn). started_at set =
    // a turn is running (staleness judged against CAPS.turnStaleMs at read
    // time); started_at NULL with prompt_id set = the last turn failed and
    // turn_json carries the error; all NULL = no turn record. attempt_id is
    // the write-fencing nonce: promptId is reused across user retries by
    // design (brain replay), so it cannot fence worker writes.
    turnPromptId: text("turn_prompt_id"),
    turnAttemptId: text("turn_attempt_id"),
    turnStartedAt: timestamp("turn_started_at", { withTimezone: true }),
    turnJson: text("turn_json"),
    answersCount: integer("answers_count").notNull().default(0),
    // The user's affirmative not-legal-advice acknowledgment at creation.
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("gov_projects_user_idx").on(t.userId),
    index("gov_projects_activity_idx").on(t.lastActivityAt),
  ]
);

// Out-of-process daily budget ledger for the governance feature: Tavily and
// brain calls are counted here (not in the per-process rate limiter) so caps
// survive PM2 restarts and cover the detached research script too.
export const governanceUsage = pgTable("governance_usage", {
  day: date("day").primaryKey(),
  tavilyCalls: integer("tavily_calls").notNull().default(0),
  brainCalls: integer("brain_calls").notNull().default(0),
  researchRuns: integer("research_runs").notNull().default(0),
});

// Tiny key/value store for governance request-path state (canary alert
// throttles, last-sweep stamp). Single-writer rule: data/governance-standards/
// state.json belongs to the refresh script alone; the web process writes here.
export const governanceMeta = pgTable("governance_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const contactSubmissions = pgTable("contact_submissions", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  company: text("company"),
  phone: text("phone"),
  message: text("message").notNull(),
  ipAddress: inet("ip_address"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});
