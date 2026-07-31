/**
 * The standing intake checklist, from source-skill/references/intake-questions.md.
 *
 * It lives in the database rather than in a markdown file so it can be filtered against the
 * knowledge base at runtime: a question whose `answeredByFactKey` resolves to an existing fact is
 * not asked.
 *
 * `kind` is the enforcement mechanism for the facts-versus-choices distinction. Getting it wrong in
 * either direction is costly: promoting a choice pollutes the KB with one client's preference, and
 * failing to promote a fact means asking Adam the same question every quarter.
 *
 * Note that the pricing-composition questions carry no `answeredByFactKey` even where a fact
 * exists. That is deliberate: the skill's own guidance is that pricing composition is re-confirmed
 * every time, because that is where errors are costliest.
 */

import type { Question } from "@/lib/rfp/content-model";

let order = 0;
function q(
  input: Omit<Question, "id" | "askOrder"> & { id: string },
): Question {
  return { ...input, askOrder: ++order };
}

export const QUESTIONS: Question[] = [
  // --- About the client --------------------------------------------------
  q({
    id: "q_client_name",
    text: "Company name as it should appear on the cover, and the coordinator's exact title.",
    category: "client",
    answeredByFactKey: null,
    kind: "choice",
    required: true,
  }),
  q({
    id: "q_submission",
    text: "Submission deadline, submission email or address, and required format.",
    category: "client",
    answeredByFactKey: null,
    kind: "choice",
    required: true,
  }),
  q({
    id: "q_start_date",
    text: "Target start date, especially if the RFP says the timeline has accelerated.",
    category: "client",
    answeredByFactKey: null,
    kind: "choice",
    required: true,
  }),

  // --- Pricing composition (ask every time) ------------------------------
  q({
    id: "q_pricing_inclusions",
    text: "Which services are inside the $247 and which are separate line items for THIS client?",
    category: "pricing",
    answeredByFactKey: null,
    kind: "choice",
    required: true,
  }),
  q({
    id: "q_pricing_secure_plus",
    text: "Is XL Secure+ being quoted? It usually is when the RFP asks for SOC, EDR, or DNS filtering.",
    category: "pricing",
    answeredByFactKey: null,
    kind: "choice",
    required: true,
  }),
  q({
    id: "q_pricing_datto_tier",
    text: "Datto retention tier: quote $3.20, $4.00, or present both and let the client choose?",
    category: "pricing",
    answeredByFactKey: null,
    kind: "choice",
    required: true,
  }),
  q({
    id: "q_pricing_quantity_conflicts",
    text: "Where the RFP's own numbers disagree with each other (for example 22 endpoints vs 25 mailboxes vs 33 licenses), should we price the difference or flag it for discovery?",
    category: "pricing",
    answeredByFactKey: null,
    kind: "choice",
    required: true,
  }),
  q({
    id: "q_pricing_onboarding_basis",
    text: "What is the onboarding fee one month OF: base service or the all-in total?",
    category: "pricing",
    answeredByFactKey: null,
    kind: "choice",
    required: true,
  }),
  q({
    id: "q_pricing_user_split",
    text: "Is the client's headcount the same as the supported-user count? It usually is not. Which staff need a managed device, which need only Microsoft 365, and which need nothing at all? Flag any seasonal or surge population separately rather than folding it into either figure.",
    category: "pricing",
    answeredByFactKey: null,
    kind: "choice",
    required: true,
  }),
  q({
    id: "q_pricing_onboarding_magnitude",
    text: "Should a large onboarding fee stand as calculated? The rule is one month of base service, which at a 200-plus-user prospect is a five-figure sum a nonprofit will notice.",
    category: "pricing",
    answeredByFactKey: null,
    kind: "choice",
    required: false,
  }),

  // --- Capabilities the profile may not cover ----------------------------
  q({
    id: "q_capability_gap",
    text: "Is there anything in the scope not covered by the knowledge base? Never guess a capability. Ask flatly: do we do this, with what tool, and is it included or extra?",
    category: "capability",
    answeredByFactKey: null,
    kind: "fact",
    required: true,
  }),
  q({
    id: "q_capability_substitution",
    text: "If the RFP names a product XL.net does not run, should we propose the XL.net equivalent, support the client's existing one, or both? Adam usually wants the recommendation stated plainly rather than a silent substitution.",
    category: "capability",
    answeredByFactKey: null,
    kind: "choice",
    required: false,
  }),

  // --- Firm facts that change --------------------------------------------
  q({
    id: "q_firm_numbers",
    text: "Anything with a number attached: retention, tenure, first-contact resolution, insurance limits, headcount splits. Is the current export still current?",
    category: "firm-fact",
    answeredByFactKey: "book.retention",
    kind: "fact",
    required: false,
  }),
  q({
    id: "q_references_selection",
    text: "Which two references should we use, and are contact details on file?",
    category: "firm-fact",
    answeredByFactKey: null,
    kind: "choice",
    required: true,
  }),

  // --- Business terms (commitments, always surfaced) ----------------------
  q({
    id: "q_terms_contract",
    text: "Contract term, notice period, minimums, exit fees.",
    category: "business-term",
    answeredByFactKey: "contract.term",
    kind: "fact",
    required: true,
  }),
  q({
    id: "q_terms_rate_hold",
    text: "Rate holds or price-increase language.",
    category: "business-term",
    answeredByFactKey: null,
    kind: "fact",
    required: true,
  }),
  q({
    id: "q_terms_onsite",
    text: "Anything about onsite coverage and what it costs.",
    category: "business-term",
    answeredByFactKey: "onsite.billing",
    kind: "fact",
    required: true,
  }),

  // --- The questions that produced the best material ---------------------
  // Worth asking even when the RFP does not force them, because Adam's answers were stronger than
  // the generic version would have been.
  q({
    id: "q_who_watches_alerts",
    text: "Who actually watches the alerts at 2am?",
    category: "capability",
    answeredByFactKey: "compliance.soc-model",
    kind: "fact",
    required: false,
  }),
  q({
    id: "q_unmet_scope_framing",
    text: "The RFP requires something our model does not do as written. Commit, commit-and-right-size, or price it as an add-on? Any scope item XL.net cannot meet as written deserves this framing rather than a quiet hedge in the copy.",
    category: "business-term",
    answeredByFactKey: null,
    kind: "choice",
    required: false,
  }),
  q({
    id: "q_fit_gap_disclosure",
    text: "How much should we disclose about a fit gap (scale, sector experience) in the cover letter?",
    category: "business-term",
    answeredByFactKey: null,
    kind: "choice",
    required: false,
  }),
];

/** Questions whose answers are durable truths and therefore promote into the KB. */
export const FACT_QUESTIONS = QUESTIONS.filter((q) => q.kind === "fact");

/** Questions whose answers belong to one proposal and must never touch the KB. */
export const CHOICE_QUESTIONS = QUESTIONS.filter((q) => q.kind === "choice");
