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
 *
 * Round 32 (§5.17.20): the cover letter's system pricing paragraph
 * (letterPricingParagraph) is pinned here too, beside the engine it reads.
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
  letterPricingParagraph,
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

// ---- the cover letter's system pricing paragraph (§5.17.20) -------------------
// Composed ONLY from the stored quote, every figure one the Investment sheet
// prints, no term sentence (the quote carries none). The paragraph is prose:
// whole dollars print without ".00" (the Investment table keeps cents), and a
// list whose items carry commas joins with semicolons (F6, round 32 fixes).

const para = (q: ReturnType<typeof build>["quote"] | null, min: number | null = RATE_CARD.minimumFullyManagedUsers) =>
  letterPricingParagraph(q, min);

check("paragraph: no quote, no paragraph", para(null), null);
check(
  "paragraph: no illustration, no paragraph",
  para({ ...build({ fullyManagedUsers: 60 }).quote, illustrations: [] }),
  null
);
check(
  "paragraph: the reference's 60 users with onboarding",
  para(build({ fullyManagedUsers: 60 }).quote),
  "The pricing is straightforward: 60 fully managed users at $247 per user per month, $14,820 per month in total. Onboarding is a one-time fee of $14,820."
);
check(
  "paragraph: under the minimum reads as the block, never a pro-rated figure",
  para(build({ fullyManagedUsers: 10 }).quote),
  "The pricing is straightforward: up to 15 fully managed users at the monthly minimum, $3,705 per month in total. Onboarding is a one-time fee of $3,705."
);
check(
  "paragraph: AT the minimum reads as the block too (the quantity cell's rule)",
  para(build({ fullyManagedUsers: 15, includeOnboarding: false }).quote),
  "The pricing is straightforward: up to 15 fully managed users at the monthly minimum, $3,705 per month in total."
);
check(
  "paragraph: no rate card in force prints the count (the workspace with minimumUsers null)",
  para(build({ fullyManagedUsers: 15, includeOnboarding: false }).quote, null),
  "The pricing is straightforward: 15 fully managed users at $247 per user per month, $3,705 per month in total."
);
check(
  "paragraph: other paid lines are named (semicolons: a label carries a comma), one-time fees from the engine's notes, scanning by reference",
  para(
    build({
      fullyManagedUsers: 40,
      securePlusComputers: 40,
      dattoRetention: "1yr",
      vulnScanSessionsPerYear: 2,
    }).quote
  ),
  "The pricing is straightforward: 40 fully managed users at $247 per user per month, $11,008 per month in total. That total also covers XL Secure+; and Datto SaaS Protection, 1-year retention, each itemized on the Investment page. Onboarding is a one-time fee of $9,880. Datto SaaS Protection setup is a one-time fee of $1,200. Vulnerability scanning and review is billed per session, as the Investment page sets out."
);
check(
  "paragraph: rule B4's two views are both stated, neither anchored",
  para(build({ fullyManagedUsers: 20, statesHeadcountOnly: true, m365OnlyUsers: 5 }).quote),
  'The Investment page prices this two ways, because the real split of users is a discovery task: all supported users fully managed, $4,940 per month; or estimated split, to be confirmed in discovery, $3,955 per month. Each fully managed user is $247 per user per month in XL.net fees. Onboarding is a one-time fee: $4,940 under "All supported users fully managed"; and $3,705 under "Estimated split, to be confirmed in discovery".'
);
{
  // An included (zero-priced) line is named as included; nothing else is invented.
  const q = build({ fullyManagedUsers: 60, includeOnboarding: false }).quote;
  const ill = q.illustrations[0];
  const withIncluded = {
    ...q,
    illustrations: [
      {
        ...ill,
        lines: [
          ...ill.lines,
          { ...ill.lines[0], id: "l_inc", rateCardItemCode: "email-anti-spam", label: "Barracuda email anti-spam", unitPrice: { cents: 0, currency: "USD" as const }, lineTotal: { cents: 0, currency: "USD" as const } },
        ],
      },
    ],
  };
  check(
    "paragraph: an included line is stated as included",
    para(withIncluded),
    "The pricing is straightforward: 60 fully managed users at $247 per user per month, $14,820 per month in total. Barracuda email anti-spam is included in the monthly fee."
  );
}
{
  // Cents print only when a figure has some ("auto"), never ".00".
  const q = build({ fullyManagedUsers: 60, includeOnboarding: false }).quote;
  const ill = q.illustrations[0];
  const odd = {
    ...q,
    illustrations: [
      {
        ...ill,
        lines: ill.lines.map((l) => ({ ...l, unitPrice: { cents: 24750, currency: "USD" as const } })),
        monthlyTotal: { cents: 1485000, currency: "USD" as const },
      },
    ],
  };
  check(
    "paragraph: a figure with cents keeps them, a whole one drops .00",
    para(odd),
    "The pricing is straightforward: 60 fully managed users at $247.50 per user per month, $14,850 per month in total."
  );
  check("paragraph: no figure anywhere ends in .00", /\.00\b/.test(para(build({ fullyManagedUsers: 40, securePlusComputers: 40, dattoRetention: "1yr" }).quote) ?? ""), false);
  // No item with a comma: the plain "A and B" list stays.
  const plain = build({ fullyManagedUsers: 40, securePlusComputers: 40, includeOnboarding: false }).quote;
  check("paragraph: comma-free items keep the plain list", /covers XL Secure\+ each itemized|covers XL Secure\+, each itemized/.test(para(plain) ?? ""), true);
}
// Every one-time figure any engine note states reaches the paragraph (so a
// template edit in buildQuote cannot silently drop a fee), and no paragraph
// ever carries a term, an em dash, or a pro-rated figure.
for (const over of [
  { fullyManagedUsers: 1 },
  { fullyManagedUsers: 14, securePlusComputers: 3 },
  { fullyManagedUsers: 60, dattoRetention: "both" as const, dattoUsers: 60 },
  { fullyManagedUsers: 200, dattoRetention: "infinite" as const, dattoUsers: 120, vulnScanSessionsPerYear: 4 },
  { fullyManagedUsers: 30, statesHeadcountOnly: true, m365OnlyUsers: 18 },
  { fullyManagedUsers: 12, statesHeadcountOnly: true, m365OnlyUsers: 4 },
]) {
  const q = build(over).quote;
  const text = para(q) ?? "";
  const oneTime = q.notes
    .filter((n) => /one-time/.test(n))
    .flatMap((n) => [...n.matchAll(/\$(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{2}))?/g)])
    .map((m) => formatMoney({ cents: Number(m[1].replace(/,/g, "")) * 100 + Number(m[2] ?? 0), currency: "USD" }, { cents: "auto" }));
  check(`paragraph ${JSON.stringify(over)}: every one-time fee is stated`, oneTime.filter((f) => !text.includes(f)), []);
  const unit = managedLine(q.illustrations[0])?.unitPrice.cents ?? 0;
  const proRated = q.illustrations
    .filter((i) => i.minimumApplied)
    .map((i) => formatMoney({ cents: managedLine(i).quantity * unit, currency: "USD" }, { cents: "auto" }));
  check(
    `paragraph ${JSON.stringify(over)}: no term, no em dash, no pro-rated figure`,
    [/\b(?:term|days'|notice|contract)\b/i.test(text), text.includes("\u2014"), proRated.some((p) => text.includes(p))],
    [false, false, false]
  );
}

console.log(failures === 0 ? "\nALL QUOTE MINIMUM TESTS PASSED" : `\n*** ${failures} FAILURE(S) ***`);
process.exit(failures === 0 ? 0 : 1);
