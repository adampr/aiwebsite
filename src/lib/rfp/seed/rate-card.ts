/**
 * The rate card, from DOMAIN-RULES B1.
 *
 * Pricing is not a fact: it is a table with arithmetic attached, and the arithmetic is where the
 * errors live. Everything here is integer cents.
 */

import { dollars, usd, type RateCard } from "@/lib/rfp/content-model";

export const RATE_CARD: RateCard = {
  id: "ratecard_2026_07",
  effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
  effectiveTo: null,
  minimumFullyManagedUsers: 15,
  /**
   * $3,705.00 as integer cents. Stored as its own field rather than computed as 15 x $247,
   * because it is a business floor that happens to currently equal that product. If the per-user
   * rate changes, the floor does not automatically follow: Adam decides.
   */
  minimumMonthlyFee: usd(370_500),
  items: [
    {
      code: "fully-managed-user",
      label: "24/7/365 Service Desk, Central Services, System Alignment, XLTO",
      unitPrice: dollars(247),
      unit: "user/month",
      note: "Complete IT, support, security, and alignment. This is the label to use when a client asks for a per-service breakdown, rather than just \"Service Desk.\"",
    },
    {
      code: "m365-only-user",
      label: "Microsoft 365 / Office support only",
      unitPrice: dollars(50),
      unit: "user/month",
      note: "For users who need support for Microsoft 365 or Office and nothing else.",
    },
    {
      code: "xl-secure-plus",
      label: "XL Secure+",
      unitPrice: dollars(25),
      unit: "computer/month",
      note: "Optional. SentinelOne Complete, RocketCyber 24/7/365 SOC/SIEM, Kaseya SIEM, SaaSAlerts, DNSFilter.",
    },
    {
      code: "datto-setup",
      label: "Datto SaaS Protection setup",
      unitPrice: dollars(1_200),
      unit: "one-time",
      note: null,
    },
    {
      code: "datto-retention-1yr",
      label: "Datto SaaS Protection, 1-year retention",
      unitPrice: dollars(3.2),
      unit: "user/month",
      note: "Offer both retention tiers and let the client pick.",
    },
    {
      code: "datto-retention-infinite",
      label: "Datto SaaS Protection, infinite retention",
      unitPrice: dollars(4),
      unit: "user/month",
      note: "Offer both retention tiers and let the client pick.",
    },
    {
      code: "datto-archive-license",
      label: "Datto archive license",
      unitPrice: dollars(2.5),
      unit: "license",
      note: "A good upsell where there is turnover: retains a departed employee's mail and files without a full M365 license.",
    },
    {
      code: "sharepoint-storage-overage",
      label: "SharePoint storage beyond 70GB per user",
      unitPrice: dollars(0.1),
      unit: "GB/month",
      note: null,
    },
    {
      code: "vulnerability-scan",
      label: "Vulnerability scanning and review session",
      unitPrice: dollars(2_500),
      unit: "session",
      note: "Internal and external, including the review-and-prioritize remediation meeting. Per SESSION, so always state a cadence.",
    },
    {
      code: "onboarding",
      label: "Onboarding",
      /**
       * Priced as one month of BASE managed service, not the all-in total, so it has no fixed
       * unit price. The pricing engine derives it; see onboardingFee() below. A zero here means
       * "computed," and the note says so rather than leaving a reader to guess.
       */
      unitPrice: usd(0),
      unit: "one-time",
      note: "Equals one month of BASE managed service, not one month of the all-in total. Computed by the pricing engine, never entered.",
    },
    {
      code: "m365-license",
      label: "Microsoft 365 licensing",
      unitPrice: usd(0),
      unit: "user/month",
      note: "Pass-through at cost on a separate line. Never blended into the per-user XL.net fee (rule B3).",
    },
  ],
};

/**
 * Onboarding is one month of BASE managed service.
 *
 * "Base" means the fully-managed-user line only, with the 15-user floor applied: not XL Secure+,
 * not Datto, not licensing. Intake question 8 re-confirms this every time because getting it wrong
 * at a 200-user prospect is a five-figure error.
 */
export function onboardingFee(baseManagedMonthlyCents: number): number {
  return baseManagedMonthlyCents;
}
