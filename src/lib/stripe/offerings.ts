// The purchasable AI Builder offering (§5.10). The price is defined here
// (inline Checkout price_data) so no Stripe Dashboard product setup is needed;
// set STRIPE_PRICE_COHORT to use a dashboard-managed Price instead (required
// if the price is edited without a deploy). The virtual workshop is no longer
// sold here — seats live on Ticket Tailor (single seat pool; linked from
// /builders) since the July 30, 2026 session.
export type OfferingId = "cohort";

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
};

export function isOfferingId(value: unknown): value is OfferingId {
  return value === "cohort";
}
