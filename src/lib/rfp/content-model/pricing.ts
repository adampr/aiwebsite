/**
 * Pricing types and the pure arithmetic.
 *
 * DOMAIN-RULES B5: "Every total, subtotal, and annualization is computed from the rate card and
 * the quantities. The drafting layer may not emit a currency figure it did not receive from the
 * pricing engine." Everything in this file is deterministic and side-effect free so the validator
 * can recompute every number in every pricing block and diff.
 */

import { addMoney, moneyEquals, multiplyMoney, usd, type Money, ZERO } from "./money";
import type { RateCard } from "./knowledge";

/** The rate card code whose quantity the 15-user minimum is measured against. */
export const FULLY_MANAGED_USER_CODE = "fully-managed-user";

export type PricingLine = {
  id: string;
  rateCardItemCode: string;
  label: string;
  quantity: number;
  /**
   * Snapshotted from the rate card at quote time rather than joined, because a rate change must
   * not retroactively alter a quote that has been sent.
   */
  unitPrice: Money;
  /** COMPUTED = quantity * unitPrice. Never authored. */
  lineTotal: Money;
};

export type PricingIllustration = {
  id: string;
  /** "Year-round staff", "Including seasonal population" */
  label: string;
  /** What population this counts, stated plainly. */
  basis: string;
  lines: PricingLine[];
  /** COMPUTED. */
  monthlyTotal: Money;
  /** COMPUTED = monthlyTotal * 12. */
  annualTotal: Money;
  /**
   * True when the 15-user floor overrode the line sum. The emitter renders the honest sentence
   * rather than silently showing a number that does not equal the line sum.
   */
  minimumApplied: boolean;
};

export type PassThrough = {
  /** "Microsoft 365 licensing" */
  label: string;
  detail: string;
  billing: "at-cost" | "client-direct";
};

export type PricingQuote = {
  id: string;
  proposalId: string;
  rateCardId: string;
  /** ALWAYS at least 2 when the RFP states headcount only. Rule B4. */
  illustrations: PricingIllustration[];
  passThroughItems: PassThrough[];
  notes: string[];
};

// ---------------------------------------------------------------------------
// Pure arithmetic
// ---------------------------------------------------------------------------

/** lineTotal = quantity * unitPrice. The only place this multiplication happens. */
export function computeLineTotal(line: Pick<PricingLine, "quantity" | "unitPrice">): Money {
  return multiplyMoney(line.unitPrice, line.quantity);
}

export function makeLine(input: {
  id: string;
  rateCardItemCode: string;
  label: string;
  quantity: number;
  unitPrice: Money;
}): PricingLine {
  return { ...input, lineTotal: computeLineTotal(input) };
}

/** Total quantity of fully managed users across a set of lines. */
export function fullyManagedUserCount(lines: PricingLine[]): number {
  return lines
    .filter((l) => l.rateCardItemCode === FULLY_MANAGED_USER_CODE)
    .reduce((sum, l) => sum + l.quantity, 0);
}

/**
 * Rule B2, the fifteen-user minimum.
 *
 * "The monthly minimum is 15 fully managed users, billed at exactly $3,705/month. A prospect below
 * 15 users is billed the flat $3,705, not a pro-rated smaller figure."
 *
 *     if (fullyManagedUsers < 15) monthlyManagedFee = 3705   // exactly. Not 14 x 247 = 3458.
 *
 * The floor applies to the fully-managed-user component only. XL Secure+, Datto, and everything
 * else still add on top of it: the CHF prospect had 14 users and was quoted the flat $3,705 for
 * the managed line, not $3,458, with the other services priced normally above that.
 */
export function applyMinimum(
  lines: PricingLine[],
  rateCard: Pick<RateCard, "minimumFullyManagedUsers" | "minimumMonthlyFee">,
): { lines: PricingLine[]; minimumApplied: boolean } {
  const managedCount = fullyManagedUserCount(lines);
  if (managedCount === 0 || managedCount >= rateCard.minimumFullyManagedUsers) {
    return { lines, minimumApplied: false };
  }

  const managedSum = addMoney(
    ...lines.filter((l) => l.rateCardItemCode === FULLY_MANAGED_USER_CODE).map((l) => l.lineTotal),
    ZERO,
  );
  if (managedSum.cents >= rateCard.minimumMonthlyFee.cents) {
    return { lines, minimumApplied: false };
  }

  // Collapse the managed-user lines onto the first one, carrying the flat floor.
  let replaced = false;
  const adjusted: PricingLine[] = [];
  for (const line of lines) {
    if (line.rateCardItemCode !== FULLY_MANAGED_USER_CODE) {
      adjusted.push(line);
      continue;
    }
    if (replaced) continue;
    replaced = true;
    adjusted.push({ ...line, lineTotal: rateCard.minimumMonthlyFee });
  }

  return { lines: adjusted, minimumApplied: true };
}

export function computeMonthlyTotal(lines: PricingLine[]): Money {
  return addMoney(...lines.map((l) => l.lineTotal), ZERO);
}

export function computeAnnualTotal(monthlyTotal: Money): Money {
  return multiplyMoney(monthlyTotal, 12);
}

/**
 * Build an illustration from its lines. Totals are computed here and nowhere else; the stored
 * values exist only so a sent proposal's numbers remain reconstructable.
 */
export function buildIllustration(input: {
  id: string;
  label: string;
  basis: string;
  lines: PricingLine[];
  rateCard: Pick<RateCard, "minimumFullyManagedUsers" | "minimumMonthlyFee">;
}): PricingIllustration {
  const normalized = input.lines.map((l) => ({ ...l, lineTotal: computeLineTotal(l) }));
  const { lines, minimumApplied } = applyMinimum(normalized, input.rateCard);
  const monthlyTotal = computeMonthlyTotal(lines);
  return {
    id: input.id,
    label: input.label,
    basis: input.basis,
    lines,
    monthlyTotal,
    annualTotal: computeAnnualTotal(monthlyTotal),
    minimumApplied,
  };
}

// ---------------------------------------------------------------------------
// Recomputation, for rule B5's validator
// ---------------------------------------------------------------------------

export type ArithmeticDiscrepancy = {
  illustrationId: string;
  /** Set when the discrepancy is on a specific line rather than on a total. */
  pricingLineId?: string;
  field: "lineTotal" | "monthlyTotal" | "annualTotal";
  stated: Money;
  computed: Money;
};

/**
 * Recompute every number in a quote and report anything that disagrees with what is stored.
 *
 * This is deliberately independent of buildIllustration's happy path: it re-derives from
 * quantity, unitPrice and the rate card, so a total that was hand-edited anywhere downstream
 * shows up here rather than in front of an evaluator.
 */
export function recomputeQuote(
  quote: PricingQuote,
  rateCard: Pick<RateCard, "minimumFullyManagedUsers" | "minimumMonthlyFee">,
): ArithmeticDiscrepancy[] {
  const discrepancies: ArithmeticDiscrepancy[] = [];

  for (const illustration of quote.illustrations) {
    for (const line of illustration.lines) {
      const computed = computeLineTotal(line);
      const isFlooredManagedLine =
        illustration.minimumApplied && line.rateCardItemCode === FULLY_MANAGED_USER_CODE;

      // A floored managed line legitimately does not equal quantity x unitPrice: it equals the
      // flat minimum. Check it against the floor instead of skipping it.
      const expected = isFlooredManagedLine ? rateCard.minimumMonthlyFee : computed;
      if (!moneyEquals(line.lineTotal, expected)) {
        discrepancies.push({
          illustrationId: illustration.id,
          pricingLineId: line.id,
          field: "lineTotal",
          stated: line.lineTotal,
          computed: expected,
        });
      }
    }

    const monthly = computeMonthlyTotal(illustration.lines);
    if (!moneyEquals(illustration.monthlyTotal, monthly)) {
      discrepancies.push({
        illustrationId: illustration.id,
        field: "monthlyTotal",
        stated: illustration.monthlyTotal,
        computed: monthly,
      });
    }

    const annual = computeAnnualTotal(illustration.monthlyTotal);
    if (!moneyEquals(illustration.annualTotal, annual)) {
      discrepancies.push({
        illustrationId: illustration.id,
        field: "annualTotal",
        stated: illustration.annualTotal,
        computed: annual,
      });
    }
  }

  return discrepancies;
}

/**
 * Rule B3: never blend XL.net fees with headcount-scaled licensing into one all-in per-user
 * number. Returns the per-user figure a blended rate WOULD produce, so the validator can search
 * the document for it. A draft once quoted $275.20 this way and was corrected.
 */
export function blendedRateThatMustNotAppear(illustration: PricingIllustration): Money | null {
  const users = fullyManagedUserCount(illustration.lines);
  if (users <= 0) return null;
  return usd(Math.round(illustration.monthlyTotal.cents / users));
}
