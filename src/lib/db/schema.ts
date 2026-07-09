import {
  pgTable,
  serial,
  text,
  timestamp,
  inet,
  uuid,
  boolean,
  integer,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  displayName: text("display_name"),
  authProvider: text("auth_provider").notNull(),
  emailDomain: text("email_domain").notNull(),
  // E.164 (+1XXXXXXXXXX); set only after the 6-digit SMS code is verified.
  phone: text("phone").unique(),
  phoneVerifiedAt: timestamp("phone_verified_at", { withTimezone: true }),
  smsOptInAt: timestamp("sms_opt_in_at", { withTimezone: true }),
  // "Don't ask again" on the SMS prompt card — account-level so it holds
  // across devices. UI preference only; deliberately NOT a consent event.
  smsPromptDismissedAt: timestamp("sms_prompt_dismissed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }).defaultNow(),
});

// One row per verification code sent from /texting. Codes are stored as
// SHA-256 hashes; a row is dead once consumed_at is set, expires_at passes,
// or attempts hits the cap. Only the newest live row per user is honored.
export const phoneVerifications = pgTable("phone_verifications", {
  id: serial("id").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  phone: text("phone").notNull(), // E.164
  codeHash: text("code_hash").notNull(),
  attempts: integer("attempts").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  ipAddress: inet("ip_address"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// Funnel telemetry for the SMS prompt card (shown → clicked → snoozed →
// dismissed); append-only, written by POST /api/auth/sms-prompt. Lets the
// admin judge whether the soft card surface converts, per the design audit.
export const smsPromptEvents = pgTable("sms_prompt_events", {
  id: serial("id").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  event: text("event").notNull(), // 'shown' | 'clicked' | 'snoozed' | 'dismissed'
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// TCPA compliance — immutable audit trail of SMS opt-ins/opt-outs. Never
// update or delete rows; retention is the life of the messaging program
// plus four years (see /privacy).
export const smsConsentLogs = pgTable("sms_consent_logs", {
  id: serial("id").primaryKey(),
  userId: uuid("user_id").references(() => users.id),
  email: text("email").notNull(),
  phone: text("phone").notNull(), // E.164
  smsOptIn: boolean("sms_opt_in").notNull(),
  // Exact consent language shown at the moment of opt-in.
  consentText: text("consent_text"),
  ipAddress: inet("ip_address"),
  userAgent: text("user_agent"),
  pageUrl: text("page_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const authLogs = pgTable("auth_logs", {
  id: serial("id").primaryKey(),
  userId: uuid("user_id").references(() => users.id),
  email: text("email").notNull(),
  authProvider: text("auth_provider").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  success: boolean("success").notNull(),
  failureReason: text("failure_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// One row per tracked page view; written only by /api/internal/track
// (fed by middleware.ts, secret-gated). Feeds /admin/seo and /admin/companies.
export const pageVisits = pgTable("page_visits", {
  id: serial("id").primaryKey(),
  path: text("path").notNull(),
  landingUrl: text("landing_url"),
  referrer: text("referrer"),
  utmSource: text("utm_source"),
  utmMedium: text("utm_medium"),
  utmCampaign: text("utm_campaign"),
  utmTerm: text("utm_term"),
  utmContent: text("utm_content"),
  ipAddress: inet("ip_address"),
  userAgent: text("user_agent"),
  sessionHash: text("session_hash"), // hash(IP + UA + date) for session grouping
  statusCode: integer("status_code").default(200),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// IP → owning-organization cache (MaxMind GeoLite2-ASN); each IP is looked
// up once, nulls cached too so misses aren't retried.
export const ipOrgs = pgTable("ip_orgs", {
  id: serial("id").primaryKey(),
  ipAddress: inet("ip_address").notNull().unique(),
  asn: integer("asn"),
  orgName: text("org_name"),
  isIsp: boolean("is_isp").notNull().default(false),
  lookedUpAt: timestamp("looked_up_at", { withTimezone: true }).defaultNow(),
});

// Emails composed by a human admin from /admin/mailbox. Tron's own email
// turns live in brain_messages; this table only records manual sends so
// mailbox threads show them alongside the AI conversation.
export const adminEmails = pgTable("admin_emails", {
  id: serial("id").primaryKey(),
  toEmail: text("to_email").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  // brain session id ("email2-<sender>-<thread>") when sent as a thread
  // reply; null for fresh compositions.
  sessionId: text("session_id"),
  sentBy: text("sent_by").notNull(), // admin email
  success: boolean("success").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
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
