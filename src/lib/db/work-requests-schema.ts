// Requested Work board (ARCHITECTURE.md §5.19): an authenticated lane member
// files a development request (title, description, estimated annual value in
// USD, one or more metric lines explaining the value); the lane admin
// approves it onto the lane's paginated list; any lane member claims it (max
// 3 concurrent, done_pending included), marks it complete, and the lane
// admin validates the completion.
//
// Tenancy axis is work_submissions.company_id byte for byte (schema.ts):
// NULL = the internal xl.net lane, a companyId = that company's private
// lane. RESTRICT, not CASCADE/SET NULL, for the same reasons recorded there;
// company offboarding purges these rows BEFORE the companies row.
//
// Conventions follow roadmap-schema.ts: uuid PK, JSON as text("*_json")
// never jsonb, timestamptz throughout, denormalized lowercased emails beside
// SET NULL user FKs so audit/attribution survives account deletion.
//
// Hand-written CHECKs and the two partial/expression indexes live ONLY in
// drizzle/migrations/0038 (drizzle cannot model them; 0033/0034/0035
// precedent) and are invisible to drizzle-kit. Deploys must keep using
// `drizzle-kit migrate`, never `push` (push would silently drop them).

import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./schema";
import { companies } from "./roadmap-schema";

// Status machine (work_req_status_ck, migration 0038):
//   pending -> approved -> in_progress -> done_pending -> completed
//   pending -> rejected; approved (unclaimed) -> rejected (admin delist);
//   in_progress -> approved (unclaim); done_pending -> in_progress (admin
//   send-back). Requester cancel is a hard DELETE of a still-pending row,
//   not a status. Vocabulary lives in src/lib/work/requests-config.ts.
export const workRequests = pgTable(
  "work_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").references(() => companies.id, {
      onDelete: "restrict",
    }),
    requesterUserId: uuid("requester_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    requesterEmail: text("requester_email").notNull(), // lowercased at write edge
    requesterName: text("requester_name"),
    title: text("title").notNull(), // short list label
    description: text("description").notNull(),
    // Estimated annual value, whole USD. Migration CHECK >= 0; the route
    // refuses above REQUEST_CAPS.valueMaxUsd (int4 ceiling is 2_147_483_647
    // and a create must never 500 on overflow).
    valueUsd: integer("value_usd").notNull(),
    // JSON array of 1..10 non-empty metric lines, each stating how the value
    // is calculated. Shape is app-enforced at the write edge
    // (validateRequestBody); parsed leniently at read edges (text-JSON
    // convention, never jsonb).
    metricsJson: text("metrics_json").notNull(),
    status: text("status").notNull().default("pending"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: text("approved_by"), // lane-admin email, lowercased
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    rejectReason: text("reject_reason"),
    developerUserId: uuid("developer_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // Cleared on unclaim; RETAINED on completed rows (scorecard attribution).
    developerEmail: text("developer_email"), // lowercased at write edge
    developerName: text("developer_name"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    markedCompleteAt: timestamp("marked_complete_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    validatedBy: text("validated_by"), // lane-admin email, lowercased
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Serves the board list (created_at DESC via backward scan), both admin
    // queues, and whole-lane count aggregation.
    index("work_req_lane_idx").on(t.companyId, t.status, t.createdAt),
    // The 5-cap requester index (work_req_requester_open_idx) and 3-cap
    // developer index (work_req_dev_active_idx) are migration-only partial
    // expression indexes in 0038, plus three CHECKs (status set, value_usd
    // >= 0, developer fields present while claimed): drizzle cannot model
    // any of them and `drizzle-kit push` would drop them.
  ]
);

export type WorkRequestRow = typeof workRequests.$inferSelect;
