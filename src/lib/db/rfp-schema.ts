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

import {
  pgTable,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  index,
  unique,
} from "drizzle-orm/pg-core";

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
