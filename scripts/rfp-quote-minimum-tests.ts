/**
 * Monthly-minimum wording tests for the quote builder (ARCHITECTURE.md §5.17.1).
 *
 *   npm run test:rfpquote
 *
 * Pure, no server, no DB. Owner ruling 2026-09-30: a fully managed count at
 * or under the rate card's minimum READS as "up to 15 users at the monthly
 * minimum" (basis sentence and quantity cell), while the stored numbers stay
 * the real ones so rule B5's recompute is untouched. Pinned in both
 * directions: the new wording at or under the minimum, and byte-identical
 * old wording above it.
 */

import {
  formatMoney,
  recomputeQuote,
  FULLY_MANAGED_USER_CODE,
  type PricingIllustration,
  type RateCard,
} from "../src/lib/rfp/content-model";
import { RATE_CARD } from "../src/lib/rfp/seed/rate-card";
import {
  buildQuote,
  quantityLabel,
  EMPTY_QUOTE_INPUTS,
  type QuoteInputs,
} from "../src/lib/rfp/quote";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `\n     got ${a}\n     want ${e}`}`);
}

const ANSWERED: QuoteInputs = {
  ...EMPTY_QUOTE_INPUTS,
  securePlusComputers: 0,
  dattoRetention: "none",
  vulnScanSessionsPerYear: 0,
  includeOnboarding: true,
};
const build = (over: Partial<QuoteInputs>, card: RateCard = RATE_CARD) =>
  buildQuote(card, { ...ANSWERED, ...over }, "p1");
const managedLine = (ill: PricingIllustration) =>
  ill.lines.find((l) => l.rateCardItemCode === FULLY_MANAGED_USER_CODE)!;
const qty = (ill: PricingIllustration, card: RateCard = RATE_CARD) =>
  ill.lines.map((l) => quantityLabel(l, ill, card.minimumFullyManagedUsers));
/** Every engine-authored client-visible string of a quote. */
const strings = (q: ReturnType<typeof build>["quote"]) => [
  ...q.illustrations.flatMap((i) => [i.label, i.basis]),
  ...q.notes,
];

const ONBOARDING_MIN =
  "Onboarding is a one-time fee of $3,705, equal to one month of the base managed service (the fully managed user line with the 15-user minimum applied). It does not include XL Secure+, Datto, or licensing.";

// ---- under the minimum: the owner's Wōcc case -------------------------------

{
  const b = build({ fullyManagedUsers: 10 });
  const ill = b.quote.illustrations[0];
  check("10: ready, one illustration", [b.ready, b.quote.illustrations.length], [true, 1]);
  check("10: basis", ill.basis, "Up to 15 fully managed users at the monthly minimum.");
  check("10: minimumApplied", ill.minimumApplied, true);
  check("10: stored quantity stays the real count", managedLine(ill).quantity, 10);
  check("10: line total is the flat minimum", managedLine(ill).lineTotal.cents, 370_500);
  check("10: monthly total", ill.monthlyTotal.cents, 370_500);
  check("10: quantity cell", qty(ill), ["Up to 15"]);
  check("10: B5 recompute clean", recomputeQuote(b.quote, RATE_CARD), []);
  check("10: onboarding note unchanged", b.quote.notes, [ONBOARDING_MIN]);
}

{
  const b = build({
    fullyManagedUsers: 8,
    securePlusComputers: 8,
    dattoRetention: "1yr",
    dattoUsers: 8,
  });
  const ill = b.quote.illustrations[0];
  check(
    "8 + Secure+ + Datto: basis keeps the add-on clauses",
    ill.basis,
    "Up to 15 fully managed users at the monthly minimum, 8 computers under XL Secure+, Datto SaaS Protection for 8 users."
  );
  check("8 + add-ons: quantity cells", qty(ill), ["Up to 15", "8", "8"]);
  check("8 + add-ons: B5 recompute clean", recomputeQuote(b.quote, RATE_CARD), []);
}

// ---- exactly the minimum -----------------------------------------------------

{
  const b = build({ fullyManagedUsers: 15 });
  const ill = b.quote.illustrations[0];
  check("15: basis", ill.basis, "Up to 15 fully managed users at the monthly minimum.");
  check("15: minimumApplied stays false (15 x unit is the line)", ill.minimumApplied, false);
  check("15: line total", managedLine(ill).lineTotal.cents, 370_500);
  check("15: quantity cell", qty(ill), ["Up to 15"]);
  check("15: B5 recompute clean", recomputeQuote(b.quote, RATE_CARD), []);
  check("15: onboarding note unchanged", b.quote.notes, [ONBOARDING_MIN]);
}

// ---- above the minimum: byte-identical to the wording before this round -----

{
  const b = build({
    fullyManagedUsers: 16,
    securePlusComputers: 12,
    dattoRetention: "1yr",
    dattoUsers: 16,
  });
  const ill = b.quote.illustrations[0];
  check(
    "16: basis unchanged",
    ill.basis,
    "16 fully managed users, 12 computers under XL Secure+, Datto SaaS Protection for 16 users."
  );
  check("16: label unchanged", ill.label, "All supported users fully managed");
  check("16: quantity cells are the plain counts", qty(ill), ["16", "12", "16"]);
  check("16: minimumApplied", ill.minimumApplied, false);
  check("16: B5 recompute clean", recomputeQuote(b.quote, RATE_CARD), []);
  check(
    "16: onboarding note unchanged",
    b.quote.notes[0],
    "Onboarding is a one-time fee of $3,952, equal to one month of the base managed service (the fully managed user line with the 15-user minimum applied). It does not include XL Secure+, Datto, or licensing."
  );
}

{
  const b = build({ fullyManagedUsers: 40, m365OnlyUsers: 10 });
  check(
    "40 with a confirmed M365 tier: basis unchanged",
    b.quote.illustrations[0].basis,
    "30 fully managed users and 10 users on Microsoft 365 support only."
  );
  check("40 with M365: quantity cells", qty(b.quote.illustrations[0]), ["30", "10"]);
}

// ---- M365-only tier under the minimum: the count stays, it has to add up ----

{
  const b = build({ fullyManagedUsers: 13, m365OnlyUsers: 5 });
  const ill = b.quote.illustrations[0];
  check(
    "13 with 5 M365-only: basis keeps the count",
    ill.basis,
    "8 fully managed users (billed as up to 15 at the monthly minimum) and 5 users on Microsoft 365 support only."
  );
  check("13 with 5 M365-only: quantity cells", qty(ill), ["Up to 15", "5"]);
  check("13 with 5 M365-only: B5 recompute clean", recomputeQuote(b.quote, RATE_CARD), []);
}

// ---- headcount-only (rule B4): two illustrations ----------------------------

{
  const b = build({ fullyManagedUsers: 12, statesHeadcountOnly: true, m365OnlyUsers: 4 });
  const [all, split] = b.quote.illustrations;
  check("headcount 12/4: two illustrations, ready", [b.quote.illustrations.length, b.ready], [2, true]);
  check("headcount 12/4: ceiling basis", all.basis, "Up to 15 fully managed users at the monthly minimum.");
  check(
    "headcount 12/4: split basis",
    split.basis,
    "8 fully managed users (billed as up to 15 at the monthly minimum) and 4 users on Microsoft 365 support only, out of the 12 people the RFP states. The real split is a discovery task."
  );
  check("headcount 12/4: quantity cells", [qty(all), qty(split)], [["Up to 15"], ["Up to 15", "4"]]);
  check("headcount 12/4: B5 recompute clean", recomputeQuote(b.quote, RATE_CARD), []);
  // Both views floor to the same base month, so the single-figure note stands.
  check("headcount 12/4: onboarding note unchanged", b.quote.notes, [ONBOARDING_MIN]);
}

{
  const b = build({ fullyManagedUsers: 40, statesHeadcountOnly: true, m365OnlyUsers: 30 });
  const [all, split] = b.quote.illustrations;
  check("headcount 40/30: ceiling basis unchanged", all.basis, "40 fully managed users.");
  check(
    "headcount 40/30: split basis",
    split.basis,
    "10 fully managed users (billed as up to 15 at the monthly minimum) and 30 users on Microsoft 365 support only, out of the 40 people the RFP states. The real split is a discovery task."
  );
  check("headcount 40/30: quantity cells", [qty(all), qty(split)], [["40"], ["Up to 15", "30"]]);
  check(
    "headcount 40/30: onboarding note unchanged (per illustration)",
    b.quote.notes[0],
    'Onboarding is a one-time fee equal to one month of the base managed service (the fully managed user line with the 15-user minimum applied): $9,880 under "All supported users fully managed", $3,705 under "Estimated split, to be confirmed in discovery". It does not include XL Secure+, Datto, or licensing.'
  );
  check("headcount 40/30: B5 recompute clean", recomputeQuote(b.quote, RATE_CARD), []);
}

// ---- the minimum comes from the card, never a literal ------------------------

{
  const unit = managedLine(build({ fullyManagedUsers: 20 }).quote.illustrations[0]).unitPrice;
  const card: RateCard = {
    ...RATE_CARD,
    minimumFullyManagedUsers: 20,
    minimumMonthlyFee: { ...unit, cents: unit.cents * 20 },
  };
  const b = build({ fullyManagedUsers: 18 }, card);
  const ill = b.quote.illustrations[0];
  check("card minimum 20: minimumApplied", ill.minimumApplied, true);
  check("card minimum 20: basis", ill.basis, "Up to 20 fully managed users at the monthly minimum.");
  check("card minimum 20: quantity cell", qty(ill, card), ["Up to 20"]);
}

// ---- "Up to N" only when that is what was billed ------------------------------

{
  // A card whose floor is LOWER than count x unit: 18 users under a 20-user
  // minimum are billed the plain per-user product, so neither the cell nor
  // the basis may say "up to 20 at the monthly minimum".
  const card: RateCard = { ...RATE_CARD, minimumFullyManagedUsers: 20 };
  const b = build({ fullyManagedUsers: 18 }, card);
  const ill = b.quote.illustrations[0];
  check("floor below the product: minimumApplied", ill.minimumApplied, false);
  check("floor below the product: line is count x unit", managedLine(ill).lineTotal.cents, 18 * managedLine(ill).unitPrice.cents);
  check("floor below the product: quantity cell is the count", qty(ill, card), ["18"]);
  check("floor below the product: basis is the count", ill.basis, "18 fully managed users.");
}
{
  // A quote stored under a 15-user minimum, shown under a card that now
  // says 20 or 10: the cell never claims a block the line was not billed as.
  const ill18 = build({ fullyManagedUsers: 18 }).quote.illustrations[0];
  check("stored 18, card now 20: the count", quantityLabel(managedLine(ill18), ill18, 20), "18");
  const ill12 = build({ fullyManagedUsers: 12 }).quote.illustrations[0];
  check("stored 12 (floored), card now 10: the count", quantityLabel(managedLine(ill12), ill12, 10), "12");
}
{
  const card: RateCard = {
    ...RATE_CARD,
    minimumFullyManagedUsers: 1,
    minimumMonthlyFee: managedLine(build({ fullyManagedUsers: 1 }).quote.illustrations[0]).unitPrice,
  };
  const ill = build({ fullyManagedUsers: 1 }, card).quote.illustrations[0];
  check("minimum of one: no block, singular", ill.basis, "1 fully managed user.");
  check("minimum of one: quantity cell", qty(ill, card), ["1"]);
}
{
  const b = build({ fullyManagedUsers: 3, m365OnlyUsers: 2 });
  check(
    "one managed user beside an M365 tier is singular",
    b.quote.illustrations[0].basis,
    "1 fully managed user (billed as up to 15 at the monthly minimum) and 2 users on Microsoft 365 support only."
  );
}

// ---- a quote stored before this round (count 10, old basis) -----------------

{
  const b = build({ fullyManagedUsers: 10 });
  const old = structuredClone(b.quote);
  old.illustrations[0].basis = "10 fully managed users.";
  check("stored pre-round quote: quantity cell", qty(old.illustrations[0]), ["Up to 15"]);
  check("stored pre-round quote: B5 recompute clean", recomputeQuote(old, RATE_CARD), []);
}

// ---- gate surface: no figure in a basis (B7), no pro-rated figure (B2), -----
// ---- no em dash (D1) in any engine-authored string ---------------------------

for (const n of [1, 8, 10, 14, 15]) {
  const b = build({
    fullyManagedUsers: n,
    statesHeadcountOnly: n > 2,
    m365OnlyUsers: n > 2 ? 2 : null,
  });
  const unit = managedLine(b.quote.illustrations[0]).unitPrice.cents;
  const proRated = [n, n - 2]
    .filter((c) => c > 0 && c < RATE_CARD.minimumFullyManagedUsers)
    .map((c) => formatMoney({ cents: c * unit, currency: "USD" }));
  const all = strings(b.quote);
  check(
    `${n}: no currency figure in any basis`,
    b.quote.illustrations.some((i) => i.basis.includes("$")),
    false
  );
  check(
    `${n}: no pro-rated figure and no em dash anywhere`,
    all.some((s) => s.includes("—") || proRated.some((p) => s.includes(p))),
    false
  );
}

console.log(failures === 0 ? "\nALL QUOTE MINIMUM TESTS PASSED" : `\n*** ${failures} FAILURE(S) ***`);
process.exit(failures === 0 ? 0 : 1);
