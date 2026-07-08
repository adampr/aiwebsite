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
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }).defaultNow(),
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
