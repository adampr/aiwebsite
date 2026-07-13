// Composed site tables (packages/aicompany/architecture.md §6, §12.4). The
// HOST owns these: shared tables come from the module's schema factories
// (users carries the texting columns since texting.enabled), and host-specific
// tables live below. src/lib/db/index.ts registers the shared set with the
// module's client so module code reads/writes these exact table objects.
//
// The composed shapes are identical to the tables this file used to define
// inline — existing rows are already in the module's shape (they are its
// source; see packages/aicompany/MIGRATIONS.md "aiwebsite adoption baseline").

import { pgTable, serial, text, timestamp, inet } from "drizzle-orm/pg-core";
import {
  makeAdminEmailsTable,
  makeAuthLogsTable,
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

// ---- Host-owned tables (not part of the module contract) ----

// Memory feature tables (module contract since memory.enabled — §18):
// first-contact "Tron remembers — text FORGET to erase" disclosure tracking
// (row written only after the notice actually sent; deleted by FORGET so a
// returning texter is re-disclosed) and the proof-of-erasure audit for FORGET
// (per-brain-table deletion counts; retained + disclosed on /privacy).
export const smsMemoryNotices = makeSmsMemoryNoticesTable();
export const memoryDeletionLogs = makeMemoryDeletionLogsTable();

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
