// The pricing-quote builder (ARCHITECTURE.md §5.17.1).
//
// Humans enter QUANTITIES here; every dollar figure is computed by
// content-model/pricing from the rate card in force. This module is the ONLY
// place a PricingQuote is constructed at runtime, which is what makes rule
// B7's sanctioned set ("figures the pricing engine produced") a real
// boundary rather than a convention. Notes are engine-authored strings: the
// figures inside them are computed here from integer cents, never typed.
//
// One-time and per-session items (onboarding, Datto setup, vulnerability
// scanning) deliberately do NOT appear as illustration lines: an
// illustration's monthlyTotal sums every line, and a one-time fee inside it
// would state a wrong month. They land in `notes`, computed.

import {
  buildIllustration,
  makeLine,
  applyMinimum,
  computeMonthlyTotal,
  formatMoney,
  usd,
  FULLY_MANAGED_USER_CODE,
  type Money,
  type PricingIllustration,
  type PricingLine,
  type PricingQuote,
  type RateCard,
} from "@/lib/rfp/content-model";
import { onboardingFee } from "@/lib/rfp/seed/rate-card";
import type { RateCardView } from "@/lib/rfp/db";

/**
 * What the human answers. Everything optional so the workspace can ask one
 * question at a time and rebuild after every answer; the quote renders once
 * `fullyManagedUsers` exists and grows as the rest arrive.
 */
export type QuoteInputs = {
  /**
   * The supported POPULATION (or the RFP's stated headcount when
   * statesHeadcountOnly). The fully-managed line prices this count MINUS any
   * M365-only population below — m365OnlyUsers is "of those", never an
   * additional group, and every basis sentence states both counts so the
   * reading survives into the document.
   */
  fullyManagedUsers: number | null;
  /**
   * True when the RFP states total staff rather than supported users
   * (rule B4). Forces a second illustration.
   */
  statesHeadcountOnly: boolean;
  /** Confirmed split from the client (clears B4's demand for two views). */
  supportedUserSplitConfirmed: boolean;
  /** Estimated M365-only population for the split illustration. */
  m365OnlyUsers: number | null;
  /** Computers under XL Secure+. 0 = not offered in this quote. */
  securePlusComputers: number | null;
  /** Datto SaaS Protection retention tier. "both" totals the 1-year tier and notes the other. */
  dattoRetention: "1yr" | "infinite" | "both" | "none" | null;
  /** Users covered by Datto. Defaults to fullyManagedUsers when null. */
  dattoUsers: number | null;
  /** Vulnerability-scan sessions per year. 0 = not offered. */
  vulnScanSessionsPerYear: number | null;
  /** Onboarding: one month of BASE managed service, one time. */
  includeOnboarding: boolean | null;
};

export const EMPTY_QUOTE_INPUTS: QuoteInputs = {
  fullyManagedUsers: null,
  statesHeadcountOnly: false,
  supportedUserSplitConfirmed: false,
  m365OnlyUsers: null,
  securePlusComputers: null,
  dattoRetention: null,
  dattoUsers: null,
  vulnScanSessionsPerYear: null,
  includeOnboarding: null,
};

const int = (v: unknown, max: number): number | null => {
  // null/undefined/"" mean UNANSWERED and must round-trip as null.
  // Number(null) is 0, and a coerced 0 here silently turns "not asked yet"
  // into "answered zero", dropping services from the client-facing quote.
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(Math.floor(n), max);
};

/** Parse untrusted request/stored JSON into well-formed inputs. */
export function parseQuoteInputs(raw: unknown): QuoteInputs {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const retention = ["1yr", "infinite", "both", "none"].includes(String(o.dattoRetention))
    ? (String(o.dattoRetention) as QuoteInputs["dattoRetention"])
    : null;
  return {
    fullyManagedUsers: int(o.fullyManagedUsers, 100_000),
    statesHeadcountOnly: o.statesHeadcountOnly === true,
    supportedUserSplitConfirmed: o.supportedUserSplitConfirmed === true,
    m365OnlyUsers: int(o.m365OnlyUsers, 100_000),
    securePlusComputers: int(o.securePlusComputers, 100_000),
    dattoRetention: retention,
    dattoUsers: int(o.dattoUsers, 100_000),
    vulnScanSessionsPerYear: int(o.vulnScanSessionsPerYear, 52),
    includeOnboarding:
      o.includeOnboarding === true ? true : o.includeOnboarding === false ? false : null,
  };
}

/** DB rate-card view (integer cents) to the content-model shape (Money). */
export function toRateCard(view: RateCardView): RateCard {
  return {
    id: view.id,
    effectiveFrom: view.effectiveFrom,
    effectiveTo: null,
    minimumFullyManagedUsers: view.minimumFullyManagedUsers,
    minimumMonthlyFee: usd(view.minimumMonthlyFeeCents),
    items: view.items.map((i) => ({
      code: i.code,
      label: i.label,
      unitPrice: usd(i.unitPriceCents),
      unit: i.unit,
      note: i.note,
    })),
  };
}

function item(card: RateCard, code: string) {
  const found = card.items.find((i) => i.code === code);
  if (!found) throw new Error(`rate card has no item "${code}"`);
  return found;
}

function monthlyLines(
  card: RateCard,
  idPrefix: string,
  q: {
    fullyManagedUsers: number;
    m365OnlyUsers: number;
    securePlusComputers: number;
    dattoTier: "1yr" | "infinite" | null;
    dattoUsers: number;
  }
): PricingLine[] {
  const lines: PricingLine[] = [];
  const push = (code: string, quantity: number, labelSuffix = "") => {
    if (quantity <= 0) return;
    const it = item(card, code);
    lines.push(
      makeLine({
        id: `${idPrefix}_${code}`,
        rateCardItemCode: code,
        label: it.label + labelSuffix,
        quantity,
        unitPrice: it.unitPrice,
      })
    );
  };
  push(FULLY_MANAGED_USER_CODE, q.fullyManagedUsers);
  push("m365-only-user", q.m365OnlyUsers);
  push("xl-secure-plus", q.securePlusComputers);
  if (q.dattoTier)
    push(q.dattoTier === "1yr" ? "datto-retention-1yr" : "datto-retention-infinite", q.dattoUsers);
  return lines;
}

/**
 * The floored BASE managed monthly (fully-managed line only), which is what
 * onboarding equals. Intake question 8 re-confirms this every time because
 * getting it wrong at a 200-user prospect is a five-figure error.
 */
function baseManagedMonthly(card: RateCard, fullyManagedUsers: number): Money {
  if (fullyManagedUsers <= 0) return usd(0);
  const base = [
    makeLine({
      id: "base_managed",
      rateCardItemCode: FULLY_MANAGED_USER_CODE,
      label: "base",
      quantity: fullyManagedUsers,
      unitPrice: item(card, FULLY_MANAGED_USER_CODE).unitPrice,
    }),
  ];
  const { lines } = applyMinimum(base, card);
  return computeMonthlyTotal(lines);
}

export type BuiltQuote = {
  quote: PricingQuote;
  /** True when the quote is renderable (has at least one illustration). */
  ready: boolean;
  /** Inputs still needed before the quote is complete enough to send. */
  missing: string[];
};

/**
 * Deterministic quote from inputs + the rate card in force.
 *
 * Rule B4: when the RFP states headcount only and no split has been
 * confirmed, two illustrations are REQUIRED: one with every stated person
 * fully managed, one with the estimated split, labelled as an estimate. A
 * zero or missing estimate keeps the quote not-ready rather than building
 * the single-figure quote B4 exists to prevent; if truly everyone needs
 * full support, the split gets CONFIRMED, which clears B4 instead.
 *
 * Outside that scenario (supported-user counts known, or split confirmed),
 * a provided M365-only population is a real line in the one illustration —
 * a confirmed split the staff typed in must never silently vanish from the
 * client-facing quote.
 */
export function buildQuote(
  card: RateCard,
  inputs: QuoteInputs,
  proposalId: string
): BuiltQuote {
  const missing: string[] = [];
  if (inputs.fullyManagedUsers === null) missing.push("fullyManagedUsers");
  if (inputs.securePlusComputers === null) missing.push("securePlusComputers");
  if (inputs.dattoRetention === null) missing.push("dattoRetention");
  if (inputs.dattoRetention && inputs.dattoRetention !== "none" && inputs.dattoUsers === null)
    missing.push("dattoUsers");
  if (inputs.vulnScanSessionsPerYear === null) missing.push("vulnScanSessionsPerYear");
  if (inputs.includeOnboarding === null) missing.push("includeOnboarding");
  // A zero estimate is unresolved, not answered: B4 needs either a real
  // second illustration or a confirmed split.
  const needsSplit =
    inputs.statesHeadcountOnly &&
    !inputs.supportedUserSplitConfirmed &&
    !inputs.m365OnlyUsers;
  if (needsSplit) missing.push("m365OnlyUsers");

  const users = inputs.fullyManagedUsers ?? 0;
  // A typo like m365=50 of 20 people would print a self-contradictory basis
  // sentence; clamp to the population.
  const m365Known = Math.min(inputs.m365OnlyUsers ?? 0, users);
  const secure = inputs.securePlusComputers ?? 0;
  let dattoTier =
    inputs.dattoRetention === "1yr" || inputs.dattoRetention === "both"
      ? ("1yr" as const)
      : inputs.dattoRetention === "infinite"
        ? ("infinite" as const)
        : null;
  let dattoUsers = dattoTier ? (inputs.dattoUsers ?? users) : 0;
  // A tier with zero covered users is Datto NOT INCLUDED: without this, the
  // basis printed "Datto SaaS Protection for 0 users" while the notes
  // charged a $1,200 setup fee for a service the quote does not contain.
  if (dattoUsers <= 0) {
    dattoTier = null;
    dattoUsers = 0;
  }

  const headcountAmbiguous =
    inputs.statesHeadcountOnly && !inputs.supportedUserSplitConfirmed;

  const illustrations: PricingIllustration[] = [];
  if (users > 0) {
    // Primary illustration. Under headcount ambiguity every stated person is
    // priced fully managed (the ceiling view B4 pairs with the split view).
    // Otherwise the counts are the real ones, INCLUDING the M365-only line.
    const primaryM365 = headcountAmbiguous ? 0 : m365Known;
    const primaryManaged = headcountAmbiguous
      ? users
      : Math.max(users - primaryM365, 0);
    illustrations.push(
      buildIllustration({
        id: "ill_all_managed",
        label:
          primaryM365 > 0
            ? "Fully managed with a Microsoft 365-only tier"
            : "All supported users fully managed",
        basis: `${primaryManaged} fully managed users${primaryM365 > 0 ? ` and ${primaryM365} users on Microsoft 365 support only` : ""}${secure > 0 ? `, ${secure} computers under XL Secure+` : ""}${dattoTier ? `, Datto SaaS Protection for ${dattoUsers} users` : ""}.`,
        lines: monthlyLines(card, "l1", {
          fullyManagedUsers: primaryManaged,
          m365OnlyUsers: primaryM365,
          securePlusComputers: secure,
          dattoTier,
          dattoUsers,
        }),
        rateCard: card,
      })
    );

    if (headcountAmbiguous && m365Known > 0) {
      const fullyManaged = Math.max(users - m365Known, 0);
      illustrations.push(
        buildIllustration({
          id: "ill_split",
          label: "Estimated split, to be confirmed in discovery",
          basis: `${fullyManaged} fully managed users and ${m365Known} users on Microsoft 365 support only, out of the ${users} people the RFP states. The real split is a discovery task.`,
          lines: monthlyLines(card, "l2", {
            fullyManagedUsers: fullyManaged,
            m365OnlyUsers: m365Known,
            securePlusComputers: secure,
            dattoTier,
            dattoUsers: dattoTier ? Math.min(dattoUsers, fullyManaged + m365Known) : 0,
          }),
          rateCard: card,
        })
      );
    }
  }

  // Engine-authored notes. Every figure below is computed from integer cents.
  const notes: string[] = [];
  if (illustrations.length > 0 && inputs.includeOnboarding) {
    // Onboarding = one month of BASE managed service, computed PER
    // ILLUSTRATION from that illustration's fully-managed count. One figure
    // computed from the raw headcount would anchor the client on the largest
    // available number, which is what rule B4 exists to prevent, and getting
    // this wrong at scale is a five-figure error (rate card, onboarding note).
    const fees = illustrations.map((ill) => {
      const managed = ill.lines
        .filter((l) => l.rateCardItemCode === FULLY_MANAGED_USER_CODE)
        .reduce((n, l) => n + l.quantity, 0);
      return {
        label: ill.label,
        fee: usd(onboardingFee(baseManagedMonthly(card, managed).cents)),
      };
    });
    const allSame = fees.every((f) => f.fee.cents === fees[0].fee.cents);
    notes.push(
      allSame
        ? `Onboarding is a one-time fee of ${formatMoney(fees[0].fee)}, equal to one month of the base managed service (the fully managed user line with the ${card.minimumFullyManagedUsers}-user minimum applied). It does not include XL Secure+, Datto, or licensing.`
        : `Onboarding is a one-time fee equal to one month of the base managed service (the fully managed user line with the ${card.minimumFullyManagedUsers}-user minimum applied): ${fees.map((f) => `${formatMoney(f.fee)} under "${f.label}"`).join(", ")}. It does not include XL Secure+, Datto, or licensing.`
    );
  }
  if (dattoTier) {
    const setup = item(card, "datto-setup").unitPrice;
    notes.push(
      `Datto SaaS Protection carries a one-time setup fee of ${formatMoney(setup)}.`
    );
  }
  if (inputs.dattoRetention === "both") {
    const oneYr = item(card, "datto-retention-1yr").unitPrice;
    const infinite = item(card, "datto-retention-infinite").unitPrice;
    notes.push(
      `The illustrations above price the 1-year retention tier at ${formatMoney(oneYr)} per user per month. Infinite retention is available at ${formatMoney(infinite)} per user per month; the client picks the tier.`
    );
  }
  if ((inputs.vulnScanSessionsPerYear ?? 0) > 0) {
    const sessions = inputs.vulnScanSessionsPerYear!;
    const per = item(card, "vulnerability-scan").unitPrice;
    const annual = usd(per.cents * sessions);
    notes.push(
      `Vulnerability scanning and review: ${sessions} session${sessions === 1 ? "" : "s"} per year at ${formatMoney(per)} per session, ${formatMoney(annual)} per year. Internal and external, including the review-and-prioritize remediation meeting.`
    );
  }

  const quote: PricingQuote = {
    id: `quote_${proposalId}`,
    proposalId,
    rateCardId: card.id,
    illustrations,
    passThroughItems: [
      {
        label: "Microsoft 365 licensing",
        detail:
          "Billed at cost on a separate line. Never blended into the per-user XL.net fee.",
        billing: "at-cost",
      },
    ],
    notes,
  };

  // Not ready while B4's second view is unresolved: storing the single
  // headcount illustration would render a quote the gate then blocks.
  return { quote, ready: illustrations.length > 0 && !needsSplit, missing };
}
