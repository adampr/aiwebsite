// Chase register (ARCHITECTURE.md §5.21, owner ask 2026-08-29: "For any work
// by others, I recommend Tron emails them every week day until they have
// completed your requested task. Report to me weekly if anyone is left that
// has not done what you asked.").
//
// Two tables, and the split is the whole design:
//
//   chase_tasks  - one row per thing XL.net asked a named person to do.
//   chase_sends  - one row per (UTC day, recipient, kind), INSERTED BEFORE
//                  the send. Its UNIQUE index, not any code path, is what
//                  guarantees nobody is nagged twice in a day. That holds
//                  across a reboot catch-up, a hand run of the script, two
//                  overlapping passes, and a PM2 restart mid-pass, because
//                  the dedupe axis is a calendar date rather than an
//                  interval anyone has to reason about.
//
// THESE TABLES SHIP EMPTY AND MUST STAY THAT WAY IN GIT. Every row names a
// colleague by address and records whether they have done what they were
// asked, and THIS REPOSITORY IS PUBLIC (github.com/adampr/aiwebsite): a
// checked-in seed, fixture or map would publish a machine-readable
// delinquency list of real people to the open internet permanently, and git
// history would keep it after any revert. This is the same ruling
// work_static_credits took on 2026-08-29 for the same reason. Rows are
// written on the production VM by `npm run chase:seed`, which reads the
// people from a file path or stdin supplied at run time and refuses any
// address that is not already in the site's own staff directory.
// scripts/chase-tests.ts pins that no colleague address literal appears in
// any chase source file.
//
// Conventions follow work-requests-schema.ts: uuid PK, JSON as text("*_json")
// never jsonb, timestamptz throughout, denormalized lowercased emails beside
// a SET NULL directory FK so the register still reads correctly after an
// offboarding removes the person.
//
// Hand-written CHECKs and the partial/expression indexes live ONLY in
// drizzle/migrations/0053 (drizzle models neither; 0033/0035/0038/0049
// precedent) and are invisible to drizzle-kit. Deploys must keep using
// `drizzle-kit migrate`, never `push` (push would silently drop them).
//
// RETENTION. chase_tasks is NEVER swept: the row IS the evidence of who was
// asked what and when, and an accusation that outlives its evidence is worse
// than no register at all. That is the reported_issues / work_archive_files
// disposition (ARCHITECTURE §6). chase_sends carries a bounded opportunistic
// sweep at 400 days from the weekday job itself, so the mail record outlives
// any plausible "how many times did you actually email me" question.
// NEITHER table joins the account export or account deletion handlers: these
// are company records of an internal assignment, the company_people /
// work_requests counter-precedent, not the signed-in user's own account
// data. Decided, not forgotten - the two precedents in this repo point in
// opposite directions and the next reader deserves to know which was picked.

import {
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { companyPeople } from "./roadmap-schema";

// Status machine (chase_task_status_ck, migration 0053):
//   blocked -> open -> paused -> open        (a human moves every arrow)
//   open|paused -> done | declined | cancelled   (terminal, closed_at set)
// blocked is the DEFAULT so a row inserted by any path is silent until
// somebody deliberately opens it, and the weekday selector reads
// status='open' only: a blocked row is not a code path that chooses not to
// send, it is invisible to the sender.
export const chaseTasks = pgTable(
  "chase_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // WHO. Name and address are SNAPSHOTS taken at seed time so the weekly
    // report still reads in people's names after an offboarding removes the
    // directory row; the FK is a liveness probe, never the identity.
    assigneeEmail: text("assignee_email").notNull(), // lowercased at write edge
    assigneeName: text("assignee_name").notNull(),
    assigneePersonId: uuid("assignee_person_id").references(
      () => companyPeople.id,
      { onDelete: "set null" }
    ),
    requesterEmail: text("requester_email").notNull(), // lowercased at write edge
    // WHAT. Both are printed verbatim in the nudge and the report, each
    // through oneLine() at compose time: they are human-entered and an
    // embedded newline would otherwise forge report lines.
    title: text("title").notNull(),
    detail: text("detail").notNull(),
    // The exact place the work happens. Every existing notification in this
    // repo ends in a link and none of them ends in "reply and tell me".
    actionUrl: text("action_url"),
    status: text("status").notNull().default("blocked"),
    blockedReason: text("blocked_reason"), // required while blocked (CHECK)
    pausedReason: text("paused_reason"), // required while paused (CHECK)
    // When status first became open. The detector's time floor: a submission
    // that predates the ask is not evidence the ask was answered.
    openedAt: timestamp("opened_at", { withTimezone: true }),
    // COMPLETION DETECTION. manual | work_submission | work_update_child.
    detector: text("detector").notNull().default("manual"),
    detectorArg: text("detector_arg"), // skill machine name, or parent uuid
    // Optional pre-registered SKILL.md digest. md_sha256 hashes the SKILL.md
    // bytes ALONE and is stable across a re-export, unlike archive_sha256
    // which changes on every re-zip and can never be pre-registered.
    detectorMdSha256: text("detector_md_sha256"),
    // CLAIMED DONE: the doer said so. Stops the mail immediately; does NOT
    // close the row. The work_requests marked_complete_at vs validated_by
    // split, for the same reason: the owner asked who has not done what he
    // asked, and a register that closes on assertion answers an easier
    // question than the one he asked.
    markedDoneAt: timestamp("marked_done_at", { withTimezone: true }),
    markedDoneBy: text("marked_done_by"), // 'detector' | verified sender addr
    markedDoneNote: text("marked_done_note"),
    // CLOSED: latched, never re-derived. sweepExpiredWork hard-deletes a
    // received/failed submission 30 days after its last update and
    // rollbackSwappedUpdate hard-deletes an update child, so a design that
    // re-queried live state would silently reopen a task somebody completed
    // a month ago and start nagging them again.
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: text("closed_by"), // 'detector' | 'reply' | 'owner:<email>'
    closeEvidenceJson: text("close_evidence_json"),
    declinedReason: text("declined_reason"),
    // NUDGE COUNTERS. Derived; chase_sends is authoritative. nudge_count
    // counts sends the VENDOR ACCEPTED (a Resend 202), which is not the same
    // as a delivery: there is no suppression list and no bounce-to-
    // application path anywhere in this repo, so the weekly report prints
    // the last accepted date and lets the owner correlate it against his own
    // bounce alerts.
    nudgeCount: integer("nudge_count").notNull().default(0),
    firstNudgedOn: date("first_nudged_on"),
    lastNudgedOn: date("last_nudged_on"),
    lastAcceptedSendAt: timestamp("last_accepted_send_at", {
      withTimezone: true,
    }),
    consecutiveSendFailures: integer("consecutive_send_failures")
      .notNull()
      .default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("chase_task_status_idx").on(t.status, t.lastNudgedOn),
    // Migration-only in 0053, invisible here and dropped by `push`:
    //   chase_task_status_ck / _blocked_ck / _paused_ck / _open_ck /
    //   _closed_ck / _detector_ck  (the state machine, so an unexplained
    //     blocked row, an open row with no time floor and a closed row with
    //     no timestamp are all unrepresentable rather than merely unlikely)
    //   chase_task_live_uq   partial UNIQUE (lower(assignee_email), detector,
    //     coalesce(detector_arg,''), lower(title)) WHERE status IN
    //     (blocked,open,paused). FOUR key columns, lower(title) included:
    //     the same person CAN hold two live rows for the same detector and
    //     arg if the titles differ, which is what makes a re-worded re-seed
    //     a second row rather than a duplicate.
    //     the anti-duplicate rail. Nothing else stops a second run of the
    //     seed script from inserting the whole register again, after which
    //     every assignee is mailed twice a day forever with no constraint
    //     violated.
    //   chase_task_due_idx   partial (lower(assignee_email)) WHERE
    //     status='open' AND marked_done_at IS NULL: exactly the selector the
    //     send path and the inbound authority gate both use, so the two can
    //     never drift.
  ]
);

// The send ledger. One row per (UTC day, recipient, kind), claimed BEFORE
// the send and stamped afterwards with the vendor outcome.
export const chaseSends = pgTable(
  "chase_sends",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sendDate: date("send_date").notNull(), // UTC calendar day, the dedupe axis
    // Recipient. For kind='report' this is the requester, not an assignee.
    assigneeEmail: text("assignee_email").notNull(), // lowercased at write edge
    kind: text("kind").notNull().default("nudge"), // nudge | report
    taskIdsJson: text("task_ids_json").notNull(), // exactly what this mail carried
    taskCount: integer("task_count").notNull(),
    subject: text("subject").notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Set only when sendGovernanceEmail returned true, i.e. Resend accepted
    // the message. Acceptance is not delivery.
    sentAt: timestamp("sent_at", { withTimezone: true }),
    outcome: text("outcome"), // pending|accepted|refused|threw|skipped_*
    detail: text("detail"), // <=200 chars, the failure message
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("chase_send_date_idx").on(t.sendDate),
    // Migration-only in 0053: chase_send_day_uq UNIQUE (send_date,
    // lower(assignee_email), kind) - THE double-send guarantee - and
    // chase_send_kind_ck.
  ]
);

export type ChaseTaskRow = typeof chaseTasks.$inferSelect;
export type ChaseSendRow = typeof chaseSends.$inferSelect;
