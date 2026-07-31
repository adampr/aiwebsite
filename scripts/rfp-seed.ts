/**
 * Seed the /rfp knowledge base into Postgres.  npx tsx scripts/rfp-seed.ts
 *
 * Idempotent: every write is an upsert against a real unique constraint, so
 * re-running reconciles rather than duplicating. It is deliberately NOT a
 * drizzle migration — deploy.sh runs db:migrate unattended during cutover, and
 * a bad fact must never be able to fail a deploy.
 *
 * WHAT IS SEEDED, AND WHAT IS NOT
 *
 * Seeded: XL.net's own facts, rate card, and intake questions. The fact corpus
 * ships with its real correction history (five facts that were wrong before
 * 2026-07-24 are seeded at v1 and retired, with corrected v2 rows carrying
 * correctedAt + supersedes). That history is the point: it is what the
 * stale-fact sweep reads, and a clean snapshot would make it untestable.
 *
 * NOT seeded: client contact PII. The upstream reference rows carry named
 * individuals at client organisations with direct dials and work emails. The
 * organisation, segment and website are business-directory facts and ship;
 * contact_name / contact_title / contact_phone / contact_email stay NULL and
 * are filled in-app by staff. This is the first third-party contact data the
 * site database would hold, and the /privacy copy does not currently describe
 * it.
 *
 * ALSO NOT seeded: the CHF proposal fixture. It is a real prospect's document,
 * and it is deliberately a FAILING fixture (its assertion is that the gate
 * rejects it). In production it would sit permanently at the top of the
 * at-risk list, training the operator to ignore both it and the sweep.
 */

import "dotenv/config";
import { db } from "../src/lib/db";
import {
  rfpFacts,
  rfpKbVersions,
  rfpQuestions,
  rfpRateCardItems,
  rfpRateCards,
  rfpReferences,
} from "../src/lib/db/rfp-schema";
import {
  ALL_FACTS,
  KB_V1_AT,
  KB_V1_SEQ,
  KB_V2_AT,
  KB_V2_SEQ,
} from "../src/lib/rfp/seed/facts";
import { RATE_CARD } from "../src/lib/rfp/seed/rate-card";
import { QUESTIONS } from "../src/lib/rfp/seed/questions";
import { REFERENCES } from "../src/lib/rfp/seed/references";

async function main() {
  console.log("seeding /rfp knowledge base ...");

  // --- knowledge-base versions -------------------------------------------
  for (const [seq, at, note] of [
    [KB_V1_SEQ, KB_V1_AT, "Initial corpus, transcribed from the XL.net profile."],
    [KB_V2_SEQ, KB_V2_AT, "Five facts corrected after the 21 July proposal shipped."],
  ] as const) {
    await db
      .insert(rfpKbVersions)
      .values({ id: `kb_${seq}`, seq, createdAt: at, note })
      // Conflict on seq, not id: seq is the natural key the facts point at.
      .onConflictDoUpdate({
        target: rfpKbVersions.seq,
        set: { createdAt: at, note },
      });
  }

  // --- facts --------------------------------------------------------------
  for (const f of ALL_FACTS) {
    await db
      .insert(rfpFacts)
      .values({
        id: f.id,
        key: f.key,
        category: f.category,
        statement: f.statement,
        polarity: f.polarity,
        detail: f.detail,
        sourceUrl: f.sourceUrl,
        verifiedAt: f.verifiedAt,
        correctedAt: f.correctedAt,
        supersedes: f.supersedes,
        introducedInKb: f.introducedInKb,
        retiredInKb: f.retiredInKb,
        confidence: f.confidence,
      })
      .onConflictDoUpdate({
        target: [rfpFacts.key, rfpFacts.introducedInKb],
        set: {
          statement: f.statement,
          detail: f.detail,
          polarity: f.polarity,
          sourceUrl: f.sourceUrl,
          verifiedAt: f.verifiedAt,
          correctedAt: f.correctedAt,
          supersedes: f.supersedes,
          retiredInKb: f.retiredInKb,
          confidence: f.confidence,
        },
      });
  }

  // --- rate card ----------------------------------------------------------
  await db
    .insert(rfpRateCards)
    .values({
      id: RATE_CARD.id,
      effectiveFrom: RATE_CARD.effectiveFrom,
      effectiveTo: RATE_CARD.effectiveTo,
      minimumFullyManagedUsers: RATE_CARD.minimumFullyManagedUsers,
      minimumMonthlyFeeCents: RATE_CARD.minimumMonthlyFee.cents,
    })
    .onConflictDoUpdate({
      target: rfpRateCards.id,
      set: {
        effectiveFrom: RATE_CARD.effectiveFrom,
        effectiveTo: RATE_CARD.effectiveTo,
        minimumFullyManagedUsers: RATE_CARD.minimumFullyManagedUsers,
        minimumMonthlyFeeCents: RATE_CARD.minimumMonthlyFee.cents,
      },
    });

  for (const item of RATE_CARD.items) {
    await db
      .insert(rfpRateCardItems)
      .values({
        id: `${RATE_CARD.id}__${item.code}`,
        rateCardId: RATE_CARD.id,
        code: item.code,
        label: item.label,
        unitPriceCents: item.unitPrice.cents,
        unit: item.unit,
        note: item.note,
      })
      .onConflictDoUpdate({
        target: [rfpRateCardItems.rateCardId, rfpRateCardItems.code],
        set: {
          label: item.label,
          unitPriceCents: item.unitPrice.cents,
          unit: item.unit,
          note: item.note,
        },
      });
  }

  // --- intake questions ---------------------------------------------------
  for (const q of QUESTIONS) {
    await db
      .insert(rfpQuestions)
      .values({
        id: q.id,
        text: q.text,
        category: q.category,
        answeredByFactKey: q.answeredByFactKey,
        kind: q.kind,
        required: q.required,
        askOrder: q.askOrder,
      })
      .onConflictDoUpdate({
        target: rfpQuestions.id,
        set: {
          text: q.text,
          category: q.category,
          answeredByFactKey: q.answeredByFactKey,
          kind: q.kind,
          required: q.required,
          askOrder: q.askOrder,
        },
      });
  }

  // --- references, WITHOUT the contact columns ----------------------------
  for (const r of REFERENCES) {
    await db
      .insert(rfpReferences)
      .values({
        id: r.id,
        organization: r.organization,
        website: r.website,
        segment: r.segment,
        // contact_* deliberately omitted; see the header note.
        relationshipSince: r.relationshipSince,
        usableWithoutAsking: r.usableWithoutAsking,
        notes: r.notes,
        retiredAt: r.retiredAt,
        replacedBy: r.replacedBy,
      })
      .onConflictDoUpdate({
        target: rfpReferences.id,
        set: {
          organization: r.organization,
          website: r.website,
          segment: r.segment,
          relationshipSince: r.relationshipSince,
          usableWithoutAsking: r.usableWithoutAsking,
          notes: r.notes,
          retiredAt: r.retiredAt,
          replacedBy: r.replacedBy,
        },
      });
  }

  console.log(
    `done: ${ALL_FACTS.length} facts, ${RATE_CARD.items.length} rate-card items, ` +
      `${QUESTIONS.length} questions, ${REFERENCES.length} references (no contact PII).`
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("seed failed:", err);
  process.exit(1);
});
