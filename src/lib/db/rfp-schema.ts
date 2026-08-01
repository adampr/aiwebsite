// RFP Response knowledge base (ARCHITECTURE.md §5.17). Host-owned tables for
// the gated /rfp section, ported from the XL.net Proposal Studio handoff,
// which shipped on Prisma + SQLite. Three conventions differ from that source
// and from the rest of this file, each deliberately:
//
//  1. `rfp_` prefix. Matches the host's feature-prefix convention
//     (governance_*, work_*), not the upstream app's name. These 6 tables
//     share a database with the site AND the brain, and `facts`/`references`
//     unprefixed would read as site infrastructure. `references` is also a
//     PostgreSQL reserved word; the prefix retires that entirely.
//
//  2. text PKs, application-generated, NO default. The source's ids are
//     semantic and load-bearing: facts are `fact_<key>_v<seq>`, rate-card
//     items are `<cardId>__<code>`, and the v1/v2 pairing behind the
//     stale-fact sweep is readable by eye. uuid().defaultRandom() (the host
//     convention for entity tables) would destroy that.
//
//  3. Structured values stay `text` holding JSON, not jsonb. The upstream
//     schema chose JSON-in-text for SQLite portability; on Postgres that
//     constraint is gone, but the host has ZERO jsonb columns against 16
//     text("*_json") ones, and the ported mapper already (de)serialises at
//     the edge. Consistency wins over a migration with no reader.
//
// timestamptz throughout, per the rest of this file: the stale-fact sweep
// compares a fact's correctedAt against a proposal's draftedAt as bare Dates,
// and `timestamp without time zone` would shift both by the server offset and
// silently drop rows from the sweep.

import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  index,
  unique,
  uniqueIndex,
  uuid,
  serial,
} from "drizzle-orm/pg-core";
import { users } from "./schema";

/** Knowledge-base versions. The seq is what every fact's introducedInKb points at. */
export const rfpKbVersions = pgTable(
  "rfp_kb_versions",
  {
    id: text("id").primaryKey(),
    seq: integer("seq").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    note: text("note"),
  },
  (t) => [unique("rfp_kb_versions_seq_uq").on(t.seq)]
);

/**
 * The fact corpus, carrying its own correction history.
 *
 * A corrected fact is NOT an update. The wrong version keeps its row with
 * retiredInKb set, and a NEW row carries correctedAt + supersedes pointing
 * back at it. That pairing is the entire basis of the stale-proposal sweep,
 * so `supersedes` is indexed even though the source schema does not index it.
 */
export const rfpFacts = pgTable(
  "rfp_facts",
  {
    id: text("id").primaryKey(),
    key: text("key").notNull(),
    category: text("category").notNull(),
    statement: text("statement").notNull(),
    // "affirmative" | "negative". A negative fact is a record, not an absence:
    // it is what stops a drafter inventing a capability because nothing said
    // otherwise. Kept as text, not a native enum, so a new variant is a code
    // change rather than an ALTER TYPE migration.
    polarity: text("polarity").notNull(),
    detail: text("detail"),
    sourceUrl: text("source_url"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    // Distinct from any updatedAt: this marks a fact whose VALUE was wrong.
    correctedAt: timestamp("corrected_at", { withTimezone: true }),
    supersedes: text("supersedes"),
    introducedInKb: integer("introduced_in_kb").notNull(),
    retiredInKb: integer("retired_in_kb"),
    // "confirmed" | "needs-adam"
    confidence: text("confidence").notNull(),
  },
  (t) => [
    unique("rfp_facts_key_kb_uq").on(t.key, t.introducedInKb),
    index("rfp_facts_corrected_at_idx").on(t.correctedAt),
    index("rfp_facts_key_idx").on(t.key),
    index("rfp_facts_polarity_idx").on(t.polarity),
    index("rfp_facts_supersedes_idx").on(t.supersedes),
  ]
);

/**
 * Client references.
 *
 * Retired rather than deleted: a reference named in a proposal that already
 * went out must stay resolvable. The contact_* columns are third-party PII and
 * ship NULL — see scripts/rfp-seed.ts.
 */
export const rfpReferences = pgTable(
  "rfp_references",
  {
    id: text("id").primaryKey(),
    organization: text("organization").notNull(),
    website: text("website"),
    segment: text("segment").notNull(),
    // Third-party contact PII. Deliberately nullable and NOT seeded.
    contactName: text("contact_name"),
    contactTitle: text("contact_title"),
    contactPhone: text("contact_phone"),
    contactEmail: text("contact_email"),
    // Free text, not a date: real values read "June 2010", "2026".
    relationshipSince: text("relationship_since"),
    usableWithoutAsking: boolean("usable_without_asking")
      .notNull()
      .default(false),
    notes: text("notes"),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    replacedBy: text("replaced_by"),
  },
  (t) => [index("rfp_references_retired_at_idx").on(t.retiredAt)]
);

/** Rate cards. Money is integer cents, in bigint so no future floor can overflow int4. */
export const rfpRateCards = pgTable("rfp_rate_cards", {
  id: text("id").primaryKey(),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
  effectiveTo: timestamp("effective_to", { withTimezone: true }),
  minimumFullyManagedUsers: integer("minimum_fully_managed_users").notNull(),
  // A business floor that currently equals 15 x the per-user rate but does not
  // follow it automatically. mode:"number" is required, not stylistic: without
  // it postgres.js returns a JS bigint and the Money constructor's
  // Number.isInteger guard throws.
  minimumMonthlyFeeCents: bigint("minimum_monthly_fee_cents", {
    mode: "number",
  }).notNull(),
});

export const rfpRateCardItems = pgTable(
  "rfp_rate_card_items",
  {
    id: text("id").primaryKey(),
    rateCardId: text("rate_card_id")
      .notNull()
      .references(() => rfpRateCards.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    label: text("label").notNull(),
    unitPriceCents: bigint("unit_price_cents", { mode: "number" }).notNull(),
    unit: text("unit").notNull(),
    note: text("note"),
  },
  (t) => [unique("rfp_rate_card_items_card_code_uq").on(t.rateCardId, t.code)]
);

/** The human intake questionnaire. */
export const rfpQuestions = pgTable(
  "rfp_questions",
  {
    id: text("id").primaryKey(),
    text: text("text").notNull(),
    category: text("category").notNull(),
    answeredByFactKey: text("answered_by_fact_key"),
    // "fact" promotes into the knowledge base on confirmation; "choice" never
    // does, because a per-proposal decision is not a company fact.
    kind: text("kind").notNull(),
    required: boolean("required").notNull(),
    askOrder: integer("ask_order").notNull(),
  },
  (t) => [index("rfp_questions_ask_order_idx").on(t.askOrder)]
);

/* ==========================================================================
   RFP workspace (§5.17 round 2). The six tables above are the seeded
   knowledge base and keep semantic text PKs. Everything below is created by
   users at runtime with no semantic id, so it uses uuid().defaultRandom() —
   matching governanceProjects / workSubmissions in schema.ts.

   OWNERSHIP. Every root table carries BOTH owner_user_id (the FK, for
   referential truth and account-export/delete) and owner_email (denormalized,
   lowercased). The email is what the visibility predicate compares, because
   it survives a users-row deletion and because the session carries it
   directly. Child rows are reachable only through their parent's id, never by
   their own, so ownership is always exactly one join away.
   ========================================================================== */

/** An uploaded or pasted RFP. Original file bytes are NOT stored, only text. */
export const rfpDocuments = pgTable(
  "rfp_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    ownerEmail: text("owner_email").notNull(),
    title: text("title").notNull(),
    clientName: text("client_name"),
    // "pdf" | "docx" | "md" | "txt" | "paste"
    sourceKind: text("source_kind").notNull(),
    sourceName: text("source_name"),
    sourceSha256: text("source_sha256"),
    sourceBytes: integer("source_bytes"),
    /** Extracted plain text. Capped at CAPS.rfpSourceMaxChars, never the raw file. */
    rawText: text("raw_text").notNull(),
    /** screenInjection() dropped lines on ingest. A review signal, not a block. */
    injectionFlagged: boolean("injection_flagged").notNull().default(false),
    /** JSON StructureNode[] — the client's own labels, verbatim (rule C4). */
    structureJson: text("structure_json"),
    structureConfirmedAt: timestamp("structure_confirmed_at", {
      withTimezone: true,
    }),
    dueDate: timestamp("due_date", { withTimezone: true }),
    // "reading" | "extracted" | "read_failed". Stamped "reading" at insert;
    // the background readRfp worker moves it to "extracted" or "read_failed".
    status: text("status").notNull().default("new"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("rfp_documents_owner_idx").on(t.ownerEmail, t.createdAt),
    index("rfp_documents_status_idx").on(t.status, t.updatedAt),
  ]
);

/** One atomic ask from the client's RFP. Coverage is judged per row. */
export const rfpRequirements = pgTable(
  "rfp_requirements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => rfpDocuments.id, { onDelete: "cascade" }),
    /** The client's own section label, verbatim. Never normalized (rule C4). */
    structureLabel: text("structure_label").notNull(),
    text: text("text").notNull(),
    ordinal: integer("ordinal").notNull(),
    // "question" | "attachment" | "statement"
    kind: text("kind").notNull().default("question"),
    mandatory: boolean("mandatory").notNull().default(true),
    /** "covered" | "gap-acknowledged" | "uncovered" */
    coverageState: text("coverage_state").notNull().default("uncovered"),
    coverageNote: text("coverage_note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("rfp_requirements_doc_idx").on(t.documentId, t.ordinal)]
);

/**
 * A drafted response.
 *
 * sections_json holds the whole section/block IR rather than section and block
 * tables. Every edit (human or Tron) lands as ONE fenced UPDATE, which is what
 * makes a failed generation incapable of leaving a half-written document, and
 * the validators run on the in-memory model anyway, never on rows.
 */
export const rfpProposals = pgTable(
  "rfp_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => rfpDocuments.id, { onDelete: "cascade" }),
    ownerUserId: uuid("owner_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    ownerEmail: text("owner_email").notNull(),
    title: text("title").notNull(),
    // "draft" | "in-review" | "approved" | "sent" | "superseded"
    status: text("status").notNull().default("draft"),
    /** Optimistic-concurrency fence. Every write bumps it. */
    rev: integer("rev").notNull().default(0),
    draftedAgainstKbVersion: integer("drafted_against_kb_version")
      .notNull()
      .default(0),
    /** JSON ResolvedSection[] — the drafted content. */
    sectionsJson: text("sections_json").notNull().default("[]"),
    /** JSON GateResult from the last run. Null = never gated. */
    gateJson: text("gate_json"),
    gateRanAt: timestamp("gate_ran_at", { withTimezone: true }),
    /**
     * JSON QuoteInputs — the human-entered quantities (user counts, tiers).
     * Kept separately from the computed quote so the quote can be rebuilt
     * deterministically, and so what was ENTERED stays distinguishable from
     * what was COMPUTED.
     */
    pricingInputsJson: text("pricing_inputs_json"),
    /**
     * JSON PricingQuote — engine output only (content-model/pricing). Unit
     * prices are snapshotted into it at build time so a later rate-card
     * change cannot retroactively alter a quote that has been shown.
     */
    pricingJson: text("pricing_json"),
    /** Set from the SESSION at approval, never from a form field. */
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    // Generation claim state (governance turn pattern): started_at non-null =
    // a run is in flight; the attempt nonce fences a stale worker's write.
    genStartedAt: timestamp("gen_started_at", { withTimezone: true }),
    genAttemptId: text("gen_attempt_id"),
    genHeartbeatAt: timestamp("gen_heartbeat_at", { withTimezone: true }),
    genProgress: text("gen_progress"),
    genError: text("gen_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("rfp_proposals_owner_idx").on(t.ownerEmail, t.updatedAt),
    index("rfp_proposals_doc_idx").on(t.documentId),
    // ONE active proposal per document. Two racing first-generate calls
    // (the ?draft=all handoff in two tabs) both passed the check-then-insert
    // without this; the loser's worker then drafted onto an orphan row no
    // read ever returned. createProposal converges on conflict.
    uniqueIndex("rfp_proposals_doc_active_uq")
      .on(t.documentId)
      .where(sql`status <> 'superseded'`),
    index("rfp_proposals_status_idx").on(t.status, t.updatedAt),
  ]
);

/**
 * Append-only activity log (§5.17).
 *
 * Records SHAPE, never content: ids, keys, counts, rule ids. No RFP text, no
 * draft prose, no fact statements, no money. Denials are logged as well as
 * successes, because a horizontal-privilege probe shows up only as a run of
 * denied reads. There is deliberately no update or delete helper.
 */
export const rfpActivity = pgTable(
  "rfp_activity",
  {
    id: serial("id").primaryKey(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    actorEmail: text("actor_email").notNull(),
    actorAdmin: boolean("actor_admin").notNull().default(false),
    /** Closed vocabulary — see RFP_ACTIONS in src/lib/rfp/activity.ts. */
    action: text("action").notNull(),
    // "document" | "proposal" | "fact" | "section"
    subjectKind: text("subject_kind"),
    subjectId: text("subject_id"),
    /** "ok" | "denied" | "error" */
    outcome: text("outcome").notNull().default("ok"),
    /** Small JSON of non-confidential shape data. Capped on write. */
    metaJson: text("meta_json"),
  },
  (t) => [
    index("rfp_activity_at_idx").on(t.at),
    index("rfp_activity_actor_idx").on(t.actorEmail, t.at),
    index("rfp_activity_subject_idx").on(t.subjectKind, t.subjectId, t.at),
  ]
);

/**
 * Proposed knowledge, scoped to the person who wrote it (§5.17).
 *
 * WHY THIS IS A SEPARATE TABLE, not `visibility` columns on rfp_facts.
 * Private facts sharing a key with a shared fact would create duplicate keys
 * in one corpus, and the two fact readers disagree on duplicates:
 * `factByKey` (content-model/knowledge.ts) uses .find() so FIRST wins, while
 * rule A6 builds `new Map(negativeFacts(...))` so LAST wins. One unapproved
 * private row keyed like a shared negative fact would therefore replace that
 * fact's statement AND its remediation suggestion inside a BLOCK message,
 * putting unreviewed user text in front of the drafter as the fix to apply.
 *
 * Keeping proposals out of rfp_facts also means: the seed's ON CONFLICT
 * target keeps working, `factsById` stays unscoped (it must resolve EVERY
 * cited id, including another user's, or an admin auditing their document
 * gets a spurious A5 "cites a fact that does not exist"), and a rejection
 * cannot make an id vanish from someone else's live draft.
 *
 * Approval INSERTS a real row into rfp_facts with a new id at a new KB
 * version. That matches the corpus rule that corrections rebuild rather than
 * patch, and it means an approved fact's id has never been anything else.
 */
export const rfpKnowledgeProposals = pgTable(
  "rfp_knowledge_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    ownerEmail: text("owner_email").notNull(),
    /**
     * "fact"   — a durable truth about XL.net; promotable to the shared base.
     * "choice" — a decision about ONE proposal. Never promotable: a choice
     *            promoted to a fact poisons every future draft.
     */
    kind: text("kind").notNull().default("choice"),
    factKey: text("fact_key"),
    category: text("category").notNull().default("general"),
    statement: text("statement").notNull(),
    detail: text("detail"),
    // "affirmative" | "negative"
    polarity: text("polarity").notNull().default("affirmative"),
    /** The RFP this arose from, when it came from a draft gap. */
    documentId: uuid("document_id").references(() => rfpDocuments.id, {
      onDelete: "set null",
    }),
    // "private" | "submitted" | "approved" | "returned"
    status: text("status").notNull().default("private"),
    /** Set on approval: the rfp_facts.id that was minted from this row. */
    promotedFactId: text("promoted_fact_id"),
    reviewedBy: text("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewNote: text("review_note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("rfp_kprop_owner_idx").on(t.ownerEmail, t.status),
    index("rfp_kprop_status_idx").on(t.status, t.createdAt),
    index("rfp_kprop_doc_idx").on(t.documentId),
  ]
);
