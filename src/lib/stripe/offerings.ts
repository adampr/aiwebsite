// The two purchasable AI Builder offerings (§5.10). Prices are defined here
// (inline Checkout price_data) so no Stripe Dashboard product setup is needed;
// set STRIPE_PRICE_COHORT / STRIPE_PRICE_WORKSHOP to use dashboard-managed
// Prices instead (required if prices are edited without a deploy).
export type OfferingId = "cohort" | "workshop";

export interface Offering {
  id: OfferingId;
  name: string;
  description: string;
  /** USD cents. */
  amount: number;
  mode: "subscription" | "payment";
  /** Env var holding an optional Stripe Price ID override. */
  priceEnv: string;
}

export const OFFERINGS: Record<OfferingId, Offering> = {
  cohort: {
    id: "cohort",
    name: "AI Builder Cohort",
    description:
      "Weekly one-hour group session (up to 6 people) to learn AI step by step. Billed monthly; cancel anytime.",
    amount: 49_500,
    mode: "subscription",
    priceEnv: "STRIPE_PRICE_COHORT",
  },
  workshop: {
    id: "workshop",
    name: "Virtual Workshop — Thursday, July 30",
    description:
      "A four-hour online session (8:00am–12:00pm CT) building real AI workflows and automations.",
    amount: 99_500,
    mode: "payment",
    priceEnv: "STRIPE_PRICE_WORKSHOP",
  },
};

export function isOfferingId(value: unknown): value is OfferingId {
  return value === "cohort" || value === "workshop";
}
