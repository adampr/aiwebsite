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
  bigint,
  customType,
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
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

// drizzle-orm has no built-in pg bytea (same workaround as the module's
// hero-image column, packages/aicompany/src/db/schema.ts).
const bytea = customType<{ data: Buffer; notNull: false; default: false }>({
  dataType() {
    return "bytea";
  },
});
import { companies } from "./roadmap-schema";
import {
  makeAdminEmailsTable,
  makeAuthLogsTable,
  makeMagicLinksTable,
  makeBlogAudioTable,
  makeBlogHeroImagesTable,
  makeBlogMetricsTable,
  makeBlogPostsTable,
  makeIpOrgsTable,
  makeMemoryDeletionLogsTable,
  makePageVisitsTable,
  makePhoneVerificationsTable,
  makeReportedIssuesTable,
  makeSeoRubricRecordsTable,
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

// Article audio narration (module §19.33, v1.38.0) — blog.audio.enabled
// requires registry key "blogAudio". Written by the nightly audio hook /
// backfill CLI; served by the /blog/audio/[slug] wrapper. Holds the MP3 bytes
// AND all audio metadata: no columns were added to blog_posts, so this table
// is the whole footprint. NOTE the hand-written storage clause in
// drizzle/ (SET STORAGE EXTERNAL) — drizzle will not emit it, and it is what
// makes the route's byte-range reads a genuine slice.
export const blogAudio = makeBlogAudioTable();

// GSC measurement loop (module §19.15) — measure.enabled requires registry
// key "blogMetrics". Enabled 2026-07-26 per reviews/2026-07-26-seo-upgrade-
// panel.md: sc-domain:ai.xl.net property granted to the fleet service
// account and verified (5 page rows on first probe). aiwebsite is the
// §19.30 meta-rewrite canary.
export const blogMetrics = makeBlogMetricsTable();

// Issue ledger (module §5.15, v1.30) — every WARN/FAIL-class alert email this
// host sends is mirrored here as an open-episode row; the watchdog drains its
// spool into /api/internal/issues and the dev-box `issues.mjs` CLI reads it
// back at build start. Registry key "reportedIssues".
export const reportedIssues = makeReportedIssuesTable();

// Weekly SEO rubric record store (module §21.19, v1.88) — one row per ISO
// week, upserted by the dev-box scorer's push leg via /api/internal/seo-rubric;
// /admin/seo-rubric renders the stored payload verbatim and never re-scores.
// Registry key "seoRubricRecords" (optional-WARN posture).
export const seoRubricRecords = makeSeoRubricRecordsTable();

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
    kind: text("kind").notNull(), // usage_policy (displayed "AI Acceptable Use Policy (AUP)")|nist_ai_rmf|eu_ai_act|iso_42001
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
    // Post-hoc research audit (§5.12): map-phase {fact, source} provenance +
    // screened suspicion notes + screen-hit slugs, retained at handoff so a
    // stored brief is auditable; <=20k, cleared at claim, deleted with row.
    researchAuditJson: text("research_audit_json"),
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
    // Sample letterhead (§5.12 round 17): the sample's page header/footer
    // captured at upload time (docx header/footer parts; repeated PDF
    // page-edge lines). Rendered into generated .docx page frames;
    // {{PAGE}}/{{PAGES}} tokens become live Word fields at render time.
    styleSampleHeader: text("style_sample_header"),
    styleSampleFooter: text("style_sample_footer"),
    // Reformat debt (§5.12 round 16): non-NULL = the sample changed since the
    // last COMPLETE whole-draft reformat run. Holds the upload's nonce so the
    // run worker's clear is fenced against a mid-run replacement (sample
    // uploads bump no rev, so the turn fences alone cannot tell samples apart).
    styleSampleDebt: text("style_sample_debt"),
    // Best-guess answers for open [TO CONFIRM] markers (§5.12), keyed by
    // marker excerpt: model-authored on drafting turns, pruned to live
    // markers on every turn write. Deliberately its OWN cold column so
    // guesses can never push documentsJson over its byte cap (that overflow
    // silently discards a paid turn). Null on old rows = no chips.
    openItemGuessesJson: text("open_item_guesses_json"),
    // Bank profile (§5.12 FFIEC offering, migration 0017): LBR lookup result,
    // bank-detection evidence, the user's switch/continue decision, and the
    // asset tier the drafting prompt calibrates to. Cold column, lenient-
    // parsed at read edges; NULL = detection never ran (all pre-FFIEC rows).
    bankProfileJson: text("bank_profile_json"),
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

// Team work submissions (§5.16): an @xl.net staffer submits a CoWork skill
// or a Claude Code program zip; an automated editorial panel (3 writers +
// 3 counterpart critics + synthesis, §5.16) drafts a /work card from the
// submitted documents and publishes it when the deterministic lint passes.
// One row carries everything (governance_projects pattern) so a hard DELETE
// removes the whole submission: extracted document text, the file manifest,
// the produced card, and (transiently) the original upload in archive_data.
// Since 2026-08-19 the durable copy of the upload lives in the on-disk
// archive store (work_archive_files below + data/work-archives/); the row
// blob is cleared after publish ONLY once that second copy re-verifies.
// user_id is SET NULL on account deletion (published cards are company
// content, not private user data; attribution is denormalized below).
export const workSubmissions = pgTable(
  "work_submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // CURRENT OWNER of the submission, and the only ownership anchor every
    // gate reads (list, retry, poll, update chain, notify recipient, the
    // scorecard's lower(submitter_email) credit). Movable since the §5.16
    // transfer round (2026-08-09): "move it to someone else" rewrites this
    // column and nothing else about who did the work.
    submitterEmail: text("submitter_email").notNull(),
    // Who CREATED the row, stamped once at intake and never rewritten by a
    // transfer. Exists solely so the per-person daily quota
    // (countCreatedToday) stays anchored on the person who spent the panel
    // run: without it, moving 20 rows to a colleague would consume that
    // colleague's whole day. NULL on every pre-transfer-round row, so every
    // read is COALESCE(creator_email, submitter_email) and the backfill is
    // implicit rather than a migration that must not fail.
    creatorEmail: text("creator_email"),
    // Optional public credit, a validated single first name; NULL = the card
    // credits "the XL.net team". Never derived from the OAuth profile.
    // A transfer does NOT touch it: the credit is what the submitter chose
    // to print on the card, not a pointer to the owner.
    submitterName: text("submitter_name"),
    kind: text("kind").notNull(), // "skill" | "program"
    title: text("title").notNull(),
    blurb: text("blurb").notNull(), // submitter's one-paragraph description
    // §5.16 "Time saved per month for you" (owner ask 2026-08-27): the
    // submitter's own estimate of the time this work saves THEM in a month.
    // NULLABLE, and NULL means "not reported" rather than zero: the figure is
    // optional at intake and usually unknowable then (the real number shows up
    // after weeks of use), so the row's OWNER sets or clears it afterwards on
    // any status, published included. Entering 0 hours clears it back to NULL,
    // which is the only gesture that removes a wrong figure from a live card.
    // Stored in whole MINUTES while every input asks for HOURS: people think
    // in hours a month, and minutes keep "6 hours 30 minutes" exact without a
    // float ever reaching a column. src/lib/work/time-saved.ts is the one
    // parse/format module for both directions.
    // SELF-REPORTED and never panel-verified, which is why every surface that
    // prints it attributes it to the submitter: /work's standing promise that
    // every claim is drawn from the submitted documents does not cover this
    // number.
    // The update lane (parent_id rows) arrives NULL on purpose: nothing is
    // copied at intake. An approved swap makes the child the live card, so
    // the figure is carried over inside publishWithSupersede AT SWAP TIME,
    // read from the FOR UPDATE-locked parent, and only when
    // sameEmail(parent.submitterEmail, child.submitterEmail) - a child that
    // reported its own figure keeps it. An intake copy (the first cut) was
    // refuted three ways: it froze a stale value while the parent stayed
    // editable, it missed the email update lane entirely, and it republished
    // one person's self-reported number under another person's row and
    // scorecard. The full reasoning lives at that call site; do not re-add a
    // copy here or in any createSubmission caller.
    // Range is enforced by migration 0049 (work_submissions_time_saved_ck,
    // time_saved_minutes IS NULL OR 1..44640, a 31-day month). Like the 0034
    // and 0035 CHECKs above, it is hand-written SQL invisible to drizzle
    // (snapshot has checkConstraints: {}), so `drizzle-kit push` would
    // silently drop it — deploys must keep using `drizzle-kit migrate`.
    timeSavedMinutes: integer("time_saved_minutes"),
    // received -> running -> published | held | failed (held = panel could
    // not verify safety/rules; renders nowhere until admin approves).
    status: text("status").notNull().default("received"),
    architectureText: text("architecture_text"),
    skillMdText: text("skill_md_text"),
    fileManifestJson: text("file_manifest_json"),
    // The exact files whose text was fed to the panel (the evidence corpus).
    corpusFilesJson: text("corpus_files_json"),
    archiveName: text("archive_name"),
    // THE SUBMITTED hash and length, always, even when what we stored is a
    // cleaned rebuild of them (§5.16 cleaning, 2026-08-29). This is the
    // provenance value: work:import and work:correlate compare it against the
    // submitter's own copy of their own file, so redefining it to describe our
    // rebuild would make the true original report as never submitted. What was
    // actually written to disk is in cleaning_json.
    archiveSha256: text("archive_sha256"),
    archiveBytes: integer("archive_bytes"),
    // What the intake scan removed, and the hashes of what we kept in its
    // place. NULL means the stored artifact IS the submitted artifact, which
    // is true of every row written before 2026-08-29 and of every upload that
    // carries nothing sensitive, so there is no backfill and an old row is
    // correctly indistinguishable from a new clean one.
    cleaningJson: text("cleaning_json"),
    // The original upload (.zip/.skill/.md). Intake writes it here AND to
    // the on-disk archive store; after the publish-time retention email
    // attempt it is cleared ONLY once every file re-verifies in the store
    // (notify.ts deliverArchiveRetention, the one clearing site). If
    // verification fails the bytes stay here (2026-08-04 ruling: never
    // delete the only copy). ≤100 MB per row while it lasts.
    archiveData: bytea("archive_data"),
    // Second original: the standalone reviewed document a submitter attached
    // beside the package (owner directive 2026-07-29: BOTH files are required
    // and retained). Same lifecycle as archive_data.
    // NO LONGER Skill-only (2026-08-28). While the form asked which kind you
    // were sending it offered this field to Skills alone, so these columns
    // were NULL on every program row and the retention email could hard-code
    // the label "SKILL.md". Now that the kind is inferred from the package
    // (src/lib/work/classify.ts) the form cannot know what to offer, so the
    // field is shown to everyone and a Code program's architecture document
    // lands here too; notify.ts labels the line from md_name for that reason.
    // Still NULL on legacy rows and on any submission that attached nothing.
    mdName: text("md_name"),
    mdSha256: text("md_sha256"),
    mdBytes: integer("md_bytes"),
    mdData: bytea("md_data"),
    // Panel claim/fence trio + daily runs guard (turn-runner pattern).
    panelAttemptId: text("panel_attempt_id"),
    panelStartedAt: timestamp("panel_started_at", { withTimezone: true }),
    panelHeartbeatAt: timestamp("panel_heartbeat_at", { withTimezone: true }),
    panelRuns: integer("panel_runs").notNull().default(0),
    panelRunsDate: date("panel_runs_date"),
    panelProgressJson: text("panel_progress_json"),
    panelTranscriptJson: text("panel_transcript_json"), // capped audit trail
    panelError: text("panel_error"),
    cardJson: text("card_json"),
    // Set the first time a run holds this row; NEVER cleared. Bars submitter
    // retry on any once-held submission (a failed admin re-run must not
    // reopen retry-until-the-critic-blinks; 2026-07-30 panel ruling).
    heldAt: timestamp("held_at", { withTimezone: true }),
    // Update lineage (§5.16 admin-mediated updates): the published card this
    // row proposes to replace, set at intake and kept after the swap for
    // provenance and rollback. SET NULL, not CASCADE: the DELETE route
    // refuses to remove a parent while any child is unresolved, so nulling
    // can only happen on deliberate cleanup. A row with parent_id set can
    // NEVER publish from the panel; it parks as pending_approval and only
    // publishWithSupersede (admin approve) can swap it live.
    parentId: uuid("parent_id").references((): AnyPgColumn => workSubmissions.id, {
      onDelete: "set null",
    }),
    // §5.16 admin web auto-approve: stamped true ONLY by the web update route
    // under a verified-staff admin session (isVerifiedStaffProvider:
    // Google, or Microsoft with the per-login mv claim, + exact-domain
    // parse; an mv-less Microsoft common-tenant lane can forge
    // isAdmin-passing sessions, see src/lib/rfp/access.ts). A true value lets a PASSING panel
    // run swap the update live without the /admin/work click. The email lane
    // (DKIM-spoofable From) must never arm it; migration 0034 adds a CHECK
    // (auto_approve = false OR parent_id IS NOT NULL) and createSubmission
    // throws on autoApprove without parentId, so a leaked option fails loudly.
    // NOTE: the CHECK is hand-written SQL invisible to drizzle (snapshot has
    // checkConstraints: {}); `drizzle-kit push` would silently drop a
    // security control — deploys must keep using `drizzle-kit migrate`.
    autoApprove: boolean("auto_approve").notNull().default(false),
    // Stamped on the parent when an approved update replaces it
    // (status "superseded", slug freed); cleared again on rollback.
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    // §5.18 tenancy axis: NULL = the original public /work lane (every
    // pre-roadmap row keeps its meaning, zero backfill); set = the row
    // belongs to that company's private "Your Work" page. RESTRICT, not
    // CASCADE/SET NULL: SET NULL would promote private cards into the public
    // lane, CASCADE would mass-delete on an accidental company delete —
    // offboarding is an explicit ordered purge (submissions, then the
    // company row). Migration 0035 CHECK (work_sub_company_no_update_ck):
    // company_id IS NULL OR parent_id IS NULL — the update lane is
    // staff-only in v1, which transitively (0034 CHECK) makes company
    // auto_approve doubly impossible. The CHECK covers only the child side;
    // the update route refuses company PARENTS in code.
    companyId: uuid("company_id").references(() => companies.id, {
      onDelete: "restrict",
    }),
    slug: text("slug"), // "team-<slugified-title>", disjoint from exhibit ids
    publishedAt: timestamp("published_at", { withTimezone: true }),
    // Admin curation order within a lane (§5.16 reorder, migration 0036).
    // NULL = never arranged: publishedCards orders by display_rank ASC (NULLS
    // LAST is the Postgres ASC default), then published_at DESC, so an
    // untouched lane keeps the newest-first showcase and an arranged lane
    // holds its admin-chosen spots while new publishes gather below the
    // arranged block, newest first among themselves. Dense 1..k
    // per lane, rewritten whole-lane by reorderPublishedCard; the update
    // swap copies the parent's rank to the child, rollback restores the
    // child's rank (the live spot) to the parent, holdPublishedForRerun
    // NULLs it (a resurrected stale rank would jump the current holder).
    displayRank: integer("display_rank"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("work_sub_user_idx").on(t.userId),
    index("work_sub_status_idx").on(t.status, t.publishedAt),
    uniqueIndex("work_sub_slug_uq").on(t.slug),
    index("work_sub_parent_idx").on(t.parentId),
    index("work_sub_company_idx").on(t.companyId, t.status, t.publishedAt),
    // The partial one-in-flight-update-per-parent unique index
    // (work_sub_parent_active_uq) and the active-title index are
    // migration-only (0033/0025, re-scoped per-company in 0035): drizzle
    // cannot model partial indexes.
  ]
);

// Ledger for the §5.16 on-disk archive store (data/work-archives/, or
// WORK_ARCHIVE_DIR): one row per stored upload file, written at intake by
// archive-store.ts right after the submission row. The DURABLE copy of
// every upload since 2026-08-19 (the 100 MB cap made the retention email
// unable to carry big packages): the row's bytea is cleared after publish
// only once the file here re-verifies. title/file_name are snapshots so
// the ledger stays meaningful after the submission row is deleted
// (submission_id goes NULL, the file stays until an admin cleans it).
// Admin cleanup (§5.16 storage console) hard-deletes the FILE and stamps
// deleted_at/deleted_by here; the row itself is the audit trail and is
// never deleted.
export const workArchiveFiles = pgTable(
  "work_archive_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    submissionId: uuid("submission_id").references(() => workSubmissions.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(), // submission title at write time
    fileName: text("file_name").notNull(), // original name, sanitized
    relPath: text("rel_path").notNull(), // under the store root; unique
    // bigint (mode number): file sizes to 100 MB fit a JS number with nine
    // orders of magnitude to spare; integer would cap at ~2.1 GB and this
    // column should never be the thing that caps an upload.
    bytes: bigint("bytes", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Stamped by admin cleanup when the FILE is deleted; the row stays.
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedBy: text("deleted_by"),
  },
  (t) => [
    uniqueIndex("work_archive_rel_path_uq").on(t.relPath),
    index("work_archive_sub_idx").on(t.submissionId),
  ]
);

// WHO BUILT EACH HAND-WRITTEN /work EXHIBIT (§5.16/§5.18). The exhibits on
// the public Our Work page are page copy in src/app/work/page.tsx, NOT
// work_submissions rows, so the colleagues who built them were counted by
// nothing: the §5.18 Employee Scorecard groups published cards by
// lower(submitter_email), and the builders of the remaining hand-written
// exhibits therefore read "1 published" while the company showcased two or
// three of their tools. A row here FOLDS INTO that person's Published count
// on the staff scorecard (published = cards + live-anchor exhibit credits);
// there is no separate Exhibits column.
//
// HISTORY, because this table has come and gone: created by migration 0052
// (2026-08-29, feeding a staff-lane Exhibits column), dropped by 0055 later
// that day when the owner retired the column, and RETURNED by 0056 on
// 2026-08-31 when the owner asked for the exhibits to count for their
// builders after all. 0052 and 0055 are applied history and are not edited.
//
// WHY A TABLE AND NOT A CHECKED-IN MAP, which is the obvious first idea and
// is wrong: THIS REPOSITORY IS PUBLIC. A JSON map, a seed INSERT inside a
// migration, a test fixture or a doc paragraph would publish colleagues'
// names and addresses to the open internet permanently, and git history
// would keep them after any revert. The anchor half of the mapping is
// already public (src/lib/work/static-titles.json is GENERATED from
// page.tsx and holds ids and titles, never addresses); the EMAIL half is
// new information about a person and lives ONLY in the production database.
// Migration 0056 creates this table EMPTY for exactly that reason, and the
// rows are written on the VM by `npm run work:credit`. Do not add a seed
// anywhere; the pre-commit gate (scripts/git-hooks/pre-commit.local) rejects
// an added line that names this table beside an email address.
//
// The credit is INTERNAL. It feeds the staff scorecard, which is
// force-dynamic, robots-noindex and gated to signed-in xl.net staff. It puts
// no name on the public page, which by owner ruling credits nobody, and it
// is not the §5.16 card credit (that one is opt-in, first-name-only and
// typed by the submitter into submitter_name).
//
// email is denormalized and lowercased with NO foreign key, the convention
// the audit columns in this file already follow: the scorecard matches
// people on lower(email), and a company_people row is a hard DELETE that a
// re-import replaces with a fresh uuid, so an FK would silently drop the
// attribution the moment someone left the directory.
//
// NO company_id COLUMN, DELIBERATELY. These exhibits are XL.net's own page
// copy and are meaningless in a client lane; an absent column is enforcement
// that no reader can forget, unlike a WHERE clause. scorecardRows() reads
// this table only when scope.companyId is null, so a company scorecard is
// byte-identical with or without rows here.
//
// The key is (anchor_id, lower(email)) rather than anchor_id alone: one
// exhibit can have two builders, and a PRIMARY KEY on the anchor would make
// the second credit silently overwrite the first. That index is
// MIGRATION-ONLY and invisible to drizzle, the 0039
// company_people_email_staff_uq precedent: drizzle cannot model an
// expression index, so `drizzle-kit push` would silently drop it and deploys
// must keep using `drizzle-kit migrate`. lower() is load-bearing rather than
// cosmetic: every read groups on lower(email), so a raw-column unique index
// would accept an address typed with a capital letter beside the same
// address in lower case, and the reader would collapse the two onto one key
// and count that person's exhibit twice.
export const workStaticCredits = pgTable(
  "work_static_credits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The /work section id, e.g. "lakehouse". Validated at READ time against
    // the generated anchor list, never by a CHECK: the id set changes
    // whenever page.tsx changes, and that must not require a migration. A
    // credit whose exhibit has been retired stops counting the day the
    // section leaves the page, which is the honest behaviour (one-tool-one-
    // card conversions, §5.16: the team card takes over the count and the
    // operator retires the row with `work:credit remove`).
    anchorId: text("anchor_id").notNull(),
    email: text("email").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Who recorded it. The durable answer to "who says so" for a colleague
    // who asks to be uncredited; removal is a DELETE by an admin.
    updatedByEmail: text("updated_by_email").notNull(),
  }
);

// Daily budget ledger for the submission panel (governance_usage pattern):
// survives PM2 restarts, checked at run admission and per brain call.
export const workUsage = pgTable("work_usage", {
  day: date("day").primaryKey(),
  brainCalls: integer("brain_calls").notNull().default(0),
  panelRuns: integer("panel_runs").notNull().default(0),
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

// Workshop notification list (§5.10): who asked to hear when the next AI
// Builders Workshop date is set. A row exists ONLY via the explicit opt-in
// click on /builders/notify (email/name/provider always from the session,
// email lowercased; never from a request body); leaving deletes the row
// outright. Keyed by email with no users FK — like contact_submissions —
// so /api/account/export and /api/account/delete carry it by email in
// extras/beforeDelete (see those routes).
export const workshopInterest = pgTable("workshop_interest", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(), // lowercased; the idempotent-join anchor
  displayName: text("display_name"),
  provider: text("provider").notNull(), // session provider at opt-in time
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// RFP Response knowledge base (§5.17). Kept in its own file: 6 foreign-domain
// tables with their own id/JSON conventions would bury this file's job, which
// is the composed site tables plus the module's registry. drizzle-kit reads
// exported pgTable objects, so the re-export is what puts them in migrations.
export * from "./rfp-schema";

// Your AI Roadmap tenancy tables (§5.18) — same own-file rationale. The
// magic_links table (module factory, registered in index.ts since
// auth.providers.magicLink) lives below so drizzle-kit emits it.
export * from "./roadmap-schema";

// Requested Work board (§5.19) — same own-file rationale; serves BOTH the
// internal xl.net lane and the per-company roadmap lanes.
export * from "./work-requests-schema";

// Chase register (§5.21) - same own-file rationale. Two tables whose rows
// name real colleagues and record whether they have done what they were
// asked; they ship EMPTY and are seeded on the VM, because this repo is
// public (see the file header). The re-export is load-bearing: drizzle.config
// points at THIS file only, so a table in a sibling that is not re-exported
// here never gets a migration.
export * from "./chase-schema";

// Magic-link sign-in tokens (module §5.5): hashed single-use 15-minute
// tokens. Registered with the module client in index.ts; enabled 2026-08-04
// as the roadmap's provider-agnostic trusted sign-in lane (§5.18).
export const magicLinks = makeMagicLinksTable();
