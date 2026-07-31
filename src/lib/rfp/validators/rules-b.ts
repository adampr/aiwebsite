/**
 * B. Pricing.
 *
 * "Arithmetic belongs in code. A model doing multiplication in prose is a defect waiting for an
 * evaluator to find it."
 */

import {
  blendedRateThatMustNotAppear,
  formatMoney,
  fullyManagedUserCount,
  recomputeQuote,
  FULLY_MANAGED_USER_CODE,
} from "@/lib/rfp/content-model";
import { documentText, scanForbiddenPhrases, textSpans, violation, type Rule } from "./rule";

/**
 * B1 - Rate card. INFO.
 *
 * The rate card itself is data, not a check. What is worth validating is that every priced line
 * refers to a real rate-card item, so a quote cannot invent a service.
 */
export const B1: Rule = {
  id: "B1",
  title: "Rate card",
  severity: "info",
  check: (ctx) => {
    const quote = ctx.proposal.pricing;
    if (!quote) return [];

    const codes = new Set(ctx.rateCard.items.map((i) => i.code));
    const violations = [];

    for (const illustration of quote.illustrations) {
      for (const line of illustration.lines) {
        if (!codes.has(line.rateCardItemCode)) {
          violations.push(
            violation({
              ruleId: "B1",
              severity: "info",
              message: `Pricing line "${line.label}" refers to rate-card code "${line.rateCardItemCode}", which is not on the current rate card.`,
              locator: { pricingLineId: line.id },
            }),
          );
        }
      }
    }

    return violations;
  },
};

/**
 * B2 - Fifteen-user minimum. BLOCK.
 *
 * The monthly minimum is 15 fully managed users, billed at exactly $3,705/month. A prospect below
 * 15 users is billed the flat $3,705, not a pro-rated smaller figure, and the figure must be
 * rendered exactly: "approximately $3,705", "about $3,705", "~$3,705" and "$3,700" are all
 * violations. This was corrected explicitly on a 14-user prospect.
 */
export const B2: Rule = {
  id: "B2",
  title: "Fifteen-user minimum",
  severity: "block",
  check: (ctx) => {
    const violations = [];
    const quote = ctx.proposal.pricing;
    const minimum = ctx.rateCard.minimumMonthlyFee;
    const exact = formatMoney(minimum);

    // The floor must actually have been applied where it applies.
    if (quote) {
      for (const illustration of quote.illustrations) {
        const users = fullyManagedUserCount(illustration.lines);
        if (users > 0 && users < ctx.rateCard.minimumFullyManagedUsers && !illustration.minimumApplied) {
          const naive = illustration.lines
            .filter((l) => l.rateCardItemCode === FULLY_MANAGED_USER_CODE)
            .reduce((sum, l) => sum + l.lineTotal.cents, 0);
          violations.push(
            violation({
              ruleId: "B2",
              severity: "block",
              message: `Illustration "${illustration.label}" prices ${users} fully managed users at ${formatMoney({ cents: naive, currency: "USD" })} without applying the ${ctx.rateCard.minimumFullyManagedUsers}-user minimum of ${exact}.`,
              locator: {},
            }),
          );
        }
      }
    }

    // The figure must be stated exactly, never hedged.
    const hedges = [
      `approximately ${exact}`,
      `about ${exact}`,
      `roughly ${exact}`,
      `~${exact}`,
      `around ${exact}`,
      "$3,700",
      "$3700",
    ];
    violations.push(
      ...scanForbiddenPhrases(ctx, {
        ruleId: "B2",
        severity: "block",
        phrases: hedges,
        message: (phrase) =>
          `The monthly minimum must be stated as the exact figure ${exact}, never as "${phrase}".`,
        suggestion: exact,
      }),
    );

    // And the pro-rated figure the floor overrides must never appear.
    if (quote) {
      for (const illustration of quote.illustrations) {
        if (!illustration.minimumApplied) continue;
        const users = fullyManagedUserCount(illustration.lines);
        const unit = illustration.lines.find((l) => l.rateCardItemCode === FULLY_MANAGED_USER_CODE);
        if (!unit) continue;
        const proRated = formatMoney({ cents: users * unit.unitPrice.cents, currency: "USD" });

        violations.push(
          ...scanForbiddenPhrases(ctx, {
            ruleId: "B2",
            severity: "block",
            phrases: [proRated],
            message: () =>
              `The pro-rated figure ${proRated} appears, but the ${ctx.rateCard.minimumFullyManagedUsers}-user minimum of ${exact} applies at ${users} users.`,
            suggestion: exact,
          }),
        );
      }
    }

    return violations;
  },
};

/**
 * B3 - No blended per-user rate. BLOCK.
 *
 * Additional users are $247 in XL.net fees. Licensing that scales with headcount is billed at cost
 * on a separate line. A draft once quoted $275.20 as a blended rate and was corrected.
 */
export const B3: Rule = {
  id: "B3",
  title: "No blended per-user rate",
  severity: "block",
  check: (ctx) => {
    const quote = ctx.proposal.pricing;
    if (!quote) return [];

    const violations = [];
    for (const illustration of quote.illustrations) {
      const blended = blendedRateThatMustNotAppear(illustration);
      if (!blended) continue;

      const managedUnit = illustration.lines.find(
        (l) => l.rateCardItemCode === FULLY_MANAGED_USER_CODE,
      )?.unitPrice;
      // If the blended figure happens to equal the real per-user fee, there is nothing to catch.
      if (managedUnit && blended.cents === managedUnit.cents) continue;

      const rendered = formatMoney(blended);
      violations.push(
        ...scanForbiddenPhrases(ctx, {
          ruleId: "B3",
          severity: "block",
          phrases: [`${rendered} per user`, `${rendered}/user`, `${rendered} / user`],
          message: () =>
            `${rendered} is the blended per-user rate for illustration "${illustration.label}". XL.net fees and headcount-scaled licensing must be quoted on separate lines, never blended.`,
          suggestion: managedUnit
            ? `${formatMoney(managedUnit)} per user per month in XL.net fees, with licensing at cost on a separate line`
            : undefined,
        }),
      );
    }

    return violations;
  },
};

/**
 * B4 - Headcount is not user count. BLOCK when ambiguous.
 *
 * When the RFP states a staff count rather than a supported-user count, quote TWO illustrations,
 * not one. Multiplying headcount by $247 invents a number the client anchors on, and it is always
 * the largest one available.
 */
export const B4: Rule = {
  id: "B4",
  title: "Headcount is not user count",
  severity: "block",
  check: (ctx) => {
    if (!ctx.statesHeadcountOnly || ctx.supportedUserSplitConfirmed) return [];

    const quote = ctx.proposal.pricing;
    const count = quote?.illustrations.length ?? 0;
    if (count >= 2) return [];

    return [
      violation({
        ruleId: "B4",
        severity: "block",
        message: `The RFP states a headcount rather than a supported-user count and the split is unconfirmed, so at least two pricing illustrations are required. This proposal has ${count}.`,
        suggestion:
          "Quote one illustration with all staff fully managed and a second splitting fully managed against the $50 Microsoft 365 tier, name the difference in plain language, say which is expected, and make establishing the real split a discovery task. Flag any seasonal or surge population separately.",
      }),
    ];
  },
};

/**
 * B5 - Arithmetic is computed, never written. BLOCK.
 *
 * Recompute every number in every pricing block and diff. The drafting layer may not emit a
 * currency figure it did not receive from the pricing engine.
 */
export const B5: Rule = {
  id: "B5",
  title: "Arithmetic is computed, never written",
  severity: "block",
  check: (ctx) => {
    const quote = ctx.proposal.pricing;
    if (!quote) return [];

    return recomputeQuote(quote, ctx.rateCard).map((d) =>
      violation({
        ruleId: "B5",
        severity: "block",
        message: `Illustration "${d.illustrationId}" states ${d.field} of ${formatMoney(d.stated)} but it recomputes to ${formatMoney(d.computed)}.`,
        locator: d.pricingLineId ? { pricingLineId: d.pricingLineId } : {},
      }),
    );
  },
};

/**
 * B6 - Pass-through is labelled. WARN.
 *
 * Optional add-ons must not read as included in one section and optional in another. This is the
 * single most common internal contradiction.
 */
export const B6: Rule = {
  id: "B6",
  title: "Pass-through is labelled",
  severity: "warn",
  check: (ctx) => {
    const violations = [];
    const text = documentText(ctx).toLowerCase();

    // The optional services, and the words that would wrongly bundle them into the flat fee.
    const optionalServices = ["xl secure+", "datto saas protection", "vulnerability scan"];

    for (const service of optionalServices) {
      if (!text.includes(service)) continue;

      const describedOptional = new RegExp(`optional[^.]{0,60}${escapeRegExp(service)}|${escapeRegExp(service)}[^.]{0,60}optional`).test(text);
      const describedIncluded = new RegExp(`${escapeRegExp(service)}[^.]{0,60}\\bincluded\\b|\\bincluded\\b[^.]{0,60}${escapeRegExp(service)}`).test(text);

      if (describedOptional && describedIncluded) {
        violations.push(
          violation({
            ruleId: "B6",
            severity: "warn",
            message: `"${service}" is described as both optional and included. Optional add-ons must not read as included in one section and optional in another.`,
          }),
        );
      }
    }

    // Pass-through items should be labelled where licensing is priced.
    if (ctx.proposal.pricing && ctx.proposal.pricing.passThroughItems.length === 0) {
      const mentionsLicensing = /licens(e|ing)|microsoft 365|hardware/.test(text);
      if (mentionsLicensing) {
        violations.push(
          violation({
            ruleId: "B6",
            severity: "warn",
            message:
              "Licensing or hardware is mentioned but the quote declares no pass-through items. Hardware, software and licensing, M365 licenses, and third-party vendor support are pass-through.",
          }),
        );
      }
    }

    return violations;
  },
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const B_RULES: Rule[] = [B1, B2, B3, B4, B5, B6];
