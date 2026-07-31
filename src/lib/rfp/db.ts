// Knowledge-base reads for /rfp (ARCHITECTURE.md §5.17).
//
// Every query lives here rather than beside a route, matching src/lib/work/db.ts
// and src/lib/governance/db.ts. Selects are explicit column allowlists, not
// SELECT *, so a column added later cannot silently widen what a page renders.

import { asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  rfpFacts,
  rfpKbVersions,
  rfpQuestions,
  rfpRateCardItems,
  rfpRateCards,
} from "@/lib/db/rfp-schema";

export type FactRow = typeof rfpFacts.$inferSelect;
export type QuestionRow = typeof rfpQuestions.$inferSelect;

export type RateCardView = {
  id: string;
  effectiveFrom: Date;
  minimumFullyManagedUsers: number;
  minimumMonthlyFeeCents: number;
  items: {
    code: string;
    label: string;
    unitPriceCents: number;
    unit: string;
    note: string | null;
  }[];
};

/** The highest knowledge-base version, or 0 when nothing has been seeded. */
export async function currentKbVersion(): Promise<number> {
  const rows = await db
    .select({ seq: rfpKbVersions.seq })
    .from(rfpKbVersions)
    .orderBy(desc(rfpKbVersions.seq))
    .limit(1);
  return rows[0]?.seq ?? 0;
}

/**
 * Live facts: everything not retired by a later knowledge-base version.
 *
 * A retired row is kept, never deleted, because a proposal that cited it must
 * stay resolvable and the correction history is what the stale-fact sweep
 * reads.
 */
export async function liveFacts(): Promise<FactRow[]> {
  return db
    .select()
    .from(rfpFacts)
    .where(isNull(rfpFacts.retiredInKb))
    .orderBy(asc(rfpFacts.key));
}

/**
 * Facts whose value was corrected, newest first.
 *
 * Note this reads the CORRECTING row (the one carrying correctedAt), not the
 * retired row it supersedes: a superseded fact's correctedAt is null.
 */
export async function correctedFacts(): Promise<FactRow[]> {
  return db
    .select()
    .from(rfpFacts)
    .where(isNotNull(rfpFacts.correctedAt))
    .orderBy(desc(rfpFacts.correctedAt));
}

export async function factCounts(): Promise<{
  live: number;
  negative: number;
  corrected: number;
  unconfirmed: number;
}> {
  const [row] = await db
    .select({
      live: sql<number>`count(*) filter (where ${rfpFacts.retiredInKb} is null)::int`,
      negative: sql<number>`count(*) filter (where ${rfpFacts.retiredInKb} is null and ${rfpFacts.polarity} = 'negative')::int`,
      corrected: sql<number>`count(*) filter (where ${rfpFacts.correctedAt} is not null)::int`,
      unconfirmed: sql<number>`count(*) filter (where ${rfpFacts.retiredInKb} is null and ${rfpFacts.confidence} = 'needs-adam')::int`,
    })
    .from(rfpFacts);
  return (
    row ?? { live: 0, negative: 0, corrected: 0, unconfirmed: 0 }
  );
}

/** The rate card in force, with its line items. Null when none is loaded. */
export async function currentRateCard(): Promise<RateCardView | null> {
  const cards = await db
    .select({
      id: rfpRateCards.id,
      effectiveFrom: rfpRateCards.effectiveFrom,
      minimumFullyManagedUsers: rfpRateCards.minimumFullyManagedUsers,
      minimumMonthlyFeeCents: rfpRateCards.minimumMonthlyFeeCents,
    })
    .from(rfpRateCards)
    .where(isNull(rfpRateCards.effectiveTo))
    .orderBy(desc(rfpRateCards.effectiveFrom))
    .limit(1);

  const card = cards[0];
  if (!card) return null;

  const items = await db
    .select({
      code: rfpRateCardItems.code,
      label: rfpRateCardItems.label,
      unitPriceCents: rfpRateCardItems.unitPriceCents,
      unit: rfpRateCardItems.unit,
      note: rfpRateCardItems.note,
    })
    .from(rfpRateCardItems)
    .where(eq(rfpRateCardItems.rateCardId, card.id))
    .orderBy(asc(rfpRateCardItems.code));

  return { ...card, items };
}

/** The intake questionnaire, in the order it is asked. */
export async function intakeQuestions(): Promise<QuestionRow[]> {
  return db.select().from(rfpQuestions).orderBy(asc(rfpQuestions.askOrder));
}

/** Integer cents to a display string. Money is never floated. */
export function usd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rest = String(abs % 100).padStart(2, "0");
  return `${sign}$${dollars.toLocaleString("en-US")}.${rest}`;
}
