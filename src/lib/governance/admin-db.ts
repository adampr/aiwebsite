// Admin-scoped reads for the /admin/governance review console (§5.12).
// Deliberately a SEPARATE file from db.ts: that file's contract is that every
// query binds the project owner into its WHERE clause, while these reads
// deliberately have no owner filter. Three invariants, pinned by tests
// (scripts/governance-tests.ts, adm32):
//   1. READ-ONLY. No mutation is ever exported from this file.
//   2. Every project read folds in retentionCutoff() exactly like the owner
//      reads in db.ts: an expired-but-unswept row must never surface, to the
//      owner OR the admin.
//   3. Content columns NEVER leave Postgres. Selects are explicit allowlists
//      of metadata; documents_json, transcript_json, research_json,
//      research_audit_json, research_progress_json, review_summary,
//      next_question_json, open_item_guesses_json, bank_profile_json,
//      turn_json, changed_sections_json, covered_bank_ids_json, and every
//      style_sample_* column are user business content and are not selected,
//      not even wrapped in octet_length().
//
// Queries are exported as NON-async builders (the page awaits the thenable)
// so the deploy-gating test script can pin .toSQL() shapes without a
// database connection.
//
// The presentation constants live here too (a Next.js page file may only
// export the page itself), so the test script can pin the status canon and
// the caveat copy without importing a component.

import { and, desc, eq, gte, like, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import type { GovernanceKind, ProjectStatus } from "./types";
import { CAPS } from "./config";
import { retentionCutoff } from "./db";

const P = schema.governanceProjects;
const U = schema.users;
const G = schema.governanceUsage;
const V = schema.pageVisits;

/** Turn-claim staleness horizon in seconds; MUST equal CAPS.turnStaleMs. */
export const TURN_STALE_SECS = CAPS.turnStaleMs / 1000;

/**
 * Research-heartbeat staleness horizon in seconds. Mirrors the 5-minute
 * literal inside claimResearch's reap SQL (db.ts); that literal is not
 * importable, so this constant carries the coupling comment instead.
 */
export const RESEARCH_HEARTBEAT_STALE_SECS = 300;

/**
 * Per-user rollup over live project rows, newest activity first. History is
 * bounded by the public 30-day retention promise BY DESIGN: rows hard-delete
 * 30 days after last activity, and this console never shows more than the
 * promise allows (no durable per-user ledger exists; see ARCHITECTURE.md
 * §5.12 "Admin review console").
 */
export function adminUsersQuery(limit = 200) {
  return db
    .select({
      userId: U.id,
      email: U.email,
      displayName: U.displayName,
      lastLoginAt: U.lastLoginAt,
      projects: sql<number>`count(*)::int`,
      done: sql<number>`(count(*) FILTER (WHERE ${P.status} = 'done'))::int`,
      flagged: sql<boolean>`coalesce(bool_or(${P.researchFlagged}), false)`,
      firstCreatedAt: sql<string>`min(${P.createdAt})`,
      lastActivityAt: sql<string>`max(${P.lastActivityAt})`,
    })
    .from(P)
    .innerJoin(U, eq(P.userId, U.id))
    .where(gte(P.lastActivityAt, retentionCutoff()))
    .groupBy(U.id, U.email, U.displayName, U.lastLoginAt)
    .orderBy(desc(sql`max(${P.lastActivityAt})`))
    .limit(limit);
}

/**
 * Flat project list, newest activity first. Explicit metadata allowlist
 * (invariant 3). Liveness/failure signals are derived booleans:
 *  - turnRunning: a fresh answer-turn claim is held right now.
 *  - researchAlive: a researching row with a fresh heartbeat.
 *  - lastTurnFailed: prompt_id set with started_at NULL is the recorded
 *    failed-turn state (schema.ts turn block) - the signal that the product
 *    broke for this user and they may be stuck.
 */
export function adminProjectsQuery(limit = 100) {
  return db
    .select({
      id: P.id,
      email: U.email,
      kind: P.kind,
      domain: P.domain,
      status: P.status,
      answersCount: P.answersCount,
      createdAt: P.createdAt,
      lastActivityAt: P.lastActivityAt,
      flagged: P.researchFlagged,
      turnRunning: sql<boolean>`coalesce(${P.turnStartedAt} > now() - make_interval(secs => ${TURN_STALE_SECS}), false)`,
      researchAlive: sql<boolean>`coalesce(${P.status} = 'researching' AND ${P.researchHeartbeatAt} > now() - make_interval(secs => ${RESEARCH_HEARTBEAT_STALE_SECS}), false)`,
      lastTurnFailed: sql<boolean>`(${P.turnPromptId} IS NOT NULL AND ${P.turnStartedAt} IS NULL)`,
    })
    .from(P)
    .innerJoin(U, eq(P.userId, U.id))
    .where(gte(P.lastActivityAt, retentionCutoff()))
    .orderBy(desc(P.lastActivityAt))
    .limit(limit);
}

/** Daily counters, newest first. Attribution-free by design (day PK only). */
export function adminUsageQuery(days = 14) {
  return db
    .select()
    .from(G)
    .where(
      gte(
        G.day,
        new Date(Date.now() - (days - 1) * 86_400_000)
          .toISOString()
          .slice(0, 10)
      )
    )
    .orderBy(desc(G.day));
}

/**
 * Page views on /governance paths over 30 days. page_visits has no user
 * linkage and no bot filter (path/ip/ua/session_hash only), so this is ALL
 * traffic, never a per-user signal. No index on created_at or path: this is
 * a sequential scan, acceptable at current volume and already the cost
 * profile of the module's own /admin/analytics queries.
 */
export function adminVisitsQuery() {
  return db
    .select({
      views: sql<number>`count(*)::int`,
      sessions: sql<number>`COUNT(DISTINCT ${V.sessionHash})::int`,
    })
    .from(V)
    .where(
      and(
        like(V.path, "/governance%"),
        sql`${V.createdAt} > now() - interval '30 days'`
      )
    );
}

/* ------------------------------------------------------------------ *
 * Presentation constants (pinned by tests)
 * ------------------------------------------------------------------ */

/**
 * Badge variant per status: the FULL eight-member ProjectStatus union, so a
 * ninth status fails the exhaustiveness pin loudly instead of rendering an
 * unstyled raw string. research_failed is the only error state (the product
 * broke for this user); bank_check and review both mean "waiting on the
 * user", the one condition the admin might act on.
 */
export const STATUS_BADGE_VARIANT: Record<
  ProjectStatus,
  "neutral" | "ok" | "warn" | "err"
> = {
  created: "neutral",
  queued: "neutral",
  researching: "neutral",
  research_failed: "err",
  bank_check: "warn",
  drafting: "neutral",
  review: "warn",
  done: "ok",
};

/** Status text renders verbatim except underscores become spaces. */
export function statusLabel(status: string): string {
  return status.replace(/_/g, " ");
}

/** Short admin labels (KIND_LABELS names are marketing-length). */
export const KIND_SHORT: Record<GovernanceKind, string> = {
  usage_policy: "AUP",
  ffiec_aup: "Bank AUP",
  nist_ai_rmf: "NIST RMF",
  eu_ai_act: "EU AI Act",
  iso_42001: "ISO 42001",
};

// Caveat copy. "user's last activity", never "owner's": on the admin pages
// "the owner" means the site owner, and this copy is about the account
// holder. No em or en dashes anywhere (owner ban on visible copy).
export const ADMIN_GOV_SUBLINE =
  "Live view of AI Governance builder usage. Projects delete 30 days after the user's last activity, so this page is a window, not an archive.";
export const ADMIN_GOV_POSTURE =
  "This console shows project metadata only. Drafts, transcripts, and research belong to the user and are not shown here.";
export const ADMIN_GOV_COUNTERS_NOTE =
  "Daily totals only, kept about 90 days. These counters are not tied to any user.";
