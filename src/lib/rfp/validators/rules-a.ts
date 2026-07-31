/**
 * A. Business-term non-negotiables.
 *
 * These are statements about what XL.net actually sells. Getting one wrong means the proposal
 * commits the company to terms it does not offer.
 */

import { negativeFacts } from "@/lib/rfp/content-model";
import {
  documentText,
  mentions,
  scanForbiddenPhrases,
  textSpans,
  violation,
  type Rule,
} from "./rule";

/**
 * A1 - Contract term. BLOCK.
 *
 * The agreement is a revolving 90-day term, terminable at any point with 90 days' written notice.
 * It is not month-to-month. It never was.
 *
 * This is BLOCK rather than WARN because when it was corrected, "month-to-month" was found in SIX
 * places in one document. The user named one. The others were in a reference blurb, a pull quote,
 * the differentiator answer, and the terms table, none of which anyone thinks to check when told
 * "fix the contract term."
 */
export const A1: Rule = {
  id: "A1",
  title: "Contract term",
  severity: "block",
  check: (ctx) => {
    const violations = scanForbiddenPhrases(ctx, {
      ruleId: "A1",
      severity: "block",
      phrases: [
        "month-to-month",
        "month to month",
        "monthly term",
        "30 days' notice",
        "30 days’ notice",
        "30 days notice",
        "30-day notice",
        "cancel any month",
        "not locked in for a year",
      ],
      message: (phrase) =>
        `Forbidden contract-term language "${phrase}". The agreement is a revolving 90-day term, terminable at any point with 90 days' written notice.`,
      suggestion:
        "a revolving 90-day term, terminable at any point with 90 days' written notice",
    });

    // The no-lock-in argument is phrased "quarter after quarter", never "every month".
    violations.push(
      ...scanForbiddenPhrases(ctx, {
        ruleId: "A1",
        severity: "block",
        phrases: ["earning it, every month", "earn it every month", "keep earning it every month"],
        message: () =>
          'The no-lock-in argument must read "we have to keep earning it, quarter after quarter", not "every month".',
        suggestion: "we have to keep earning it, quarter after quarter",
      }),
    );

    // Where the term IS described, both halves must be present.
    const text = documentText(ctx).toLowerCase();
    const describesTerm = /\b(agreement term|contract term|term of the agreement|notice period)\b/.test(
      text,
    );
    if (describesTerm) {
      const hasRevolving = /90[\s-]day/.test(text) && /revolv/.test(text);
      const hasNotice = /90 days[’']? (written )?notice/.test(text);
      if (!hasRevolving || !hasNotice) {
        violations.push(
          violation({
            ruleId: "A1",
            severity: "block",
            message:
              "The agreement term is described but does not state BOTH a 90-day revolving term and a 90-day written notice period.",
            suggestion:
              "The agreement is a revolving 90-day term. Terminating it requires 90 days' written notice, at any point.",
          }),
        );
      }
    }

    return violations;
  },
};

/**
 * A2 - Onboarding sequence. BLOCK.
 *
 * Onboarding begins with a meet and greet. The scheduled onboarding day follows roughly 10 to 14
 * days later. XL.net becomes accountable for support when it holds valid credentials.
 *
 * The CHF proposal shipped with a "Zero-gap cutover" callout promising takeover "the same day we
 * are notified." That is not what the company does, and that exact string is a fixture.
 */
export const A2: Rule = {
  id: "A2",
  title: "Onboarding sequence",
  severity: "block",
  check: (ctx) =>
    scanForbiddenPhrases(ctx, {
      ruleId: "A2",
      severity: "block",
      phrases: [
        "same-day takeover",
        "same day takeover",
        "same day we are notified",
        "the same day we're notified",
        "day 1 cutover",
        "day one cutover",
        "zero-gap cutover",
        "zero gap cutover",
        "no gap in coverage",
        "support goes live the same day",
      ],
      message: (phrase) =>
        `Forbidden onboarding promise "${phrase}". Onboarding begins with a meet and greet; the scheduled onboarding day follows roughly 10 to 14 days later, and XL.net becomes accountable for support when it holds valid credentials.`,
      suggestion:
        "Onboarding begins with a meet and greet, with the scheduled onboarding day roughly 10 to 14 days later.",
    }),
};

/**
 * A3 - Staff location. BLOCK.
 *
 * Business hours are covered from the United States. After-hours coverage is split between XL.net
 * teams in the Philippines and Serbia, deliberately, so each shift is worked in that team's own
 * daylight hours. The honest version is a strength; state the tradeoff, do not hide it.
 */
export const A3: Rule = {
  id: "A3",
  title: "Staff location",
  severity: "block",
  check: (ctx) =>
    scanForbiddenPhrases(ctx, {
      ruleId: "A3",
      severity: "block",
      phrases: [
        "all u.s.-based",
        "all us based",
        "all u.s. based",
        "entirely domestic",
        "100% u.s.",
        "100% us",
        "onshore only",
        "nothing is offshored",
        "no offshore",
        "no nearshore",
      ],
      message: (phrase) =>
        `Forbidden staffing claim "${phrase}". Business hours are covered from the United States; after-hours coverage is split between XL.net teams in the Philippines and Serbia.`,
      suggestion:
        "A client calling at 3am Chicago time reaches an engineer who is mid-workday and alert, rather than someone woken by a pager. It is XL.net's own staff on staffed shifts throughout, never an outsourced call center.",
    }),
};

/**
 * A4 - Onsite billing. BLOCK.
 *
 * Reactive onsite is included in the flat fee. Moves, adds and changes, and project work, are a
 * fixed-fee SOW. Both halves must appear together: including one without the other has shipped
 * before and reads as a promise the company will not keep.
 */
export const A4: Rule = {
  id: "A4",
  title: "Onsite billing",
  severity: "block",
  check: (ctx) => {
    const violations = scanForbiddenPhrases(ctx, {
      ruleId: "A4",
      severity: "block",
      phrases: [
        "hourly onsite rate",
        "per hour onsite",
        "/hour onsite",
        "per-visit onsite charge",
        "all onsite visits are included",
        "guaranteed onsite within",
        "we guarantee arrival",
        "guarantee an engineer onsite",
      ],
      message: (phrase) =>
        `Forbidden onsite language "${phrase}". Reactive onsite is included in the flat fee; moves, adds and changes and project work are charged through a fixed-fee Statement of Work. The 2-hour emergency arrival is a target, never a guarantee.`,
      suggestion:
        "Onsite visits for reactive issues are included in the flat fee. Onsite work for moves, adds and changes, or projects, is quoted as a fixed-fee Statement of Work.",
    });

    const text = documentText(ctx).toLowerCase();
    if (/\bonsite\b/.test(text)) {
      const hasReactiveIncluded = /(reactive|emergenc)[^.]*includ|includ[^.]*reactive/.test(text);
      const hasSowHalf = /statement of work|fixed[- ]fee|sow\b/.test(text);
      if (!hasReactiveIncluded || !hasSowHalf) {
        violations.push(
          violation({
            ruleId: "A4",
            severity: "block",
            message:
              "Onsite is mentioned but only one half of the policy is stated. Both halves are required: reactive onsite included in the flat fee, AND moves/adds/changes and projects charged through a fixed-fee Statement of Work.",
            suggestion:
              "Onsite visits to resolve reactive issues are included in the flat fee. Onsite work for moves, adds and changes, or project work, is charged separately through a fixed-fee Statement of Work.",
          }),
        );
      }
    }

    return violations;
  },
};

/**
 * A5 - No invented capability. BLOCK.
 *
 * Every capability claim must cite a knowledge-base fact. This is the structural version of the
 * standing instruction: "ask me any questions you don't know the answer to, never guess."
 */
export const A5: Rule = {
  id: "A5",
  title: "No invented capability",
  severity: "block",
  check: (ctx) => {
    const violations = [];
    const knownFactIds = new Set(Object.keys(ctx.factsById));

    for (const section of ctx.proposal.sections) {
      for (const block of section.blocks) {
        // Structural blocks assert nothing, so they need no citation.
        if (["divider", "page-break", "image", "heading", "footnote"].includes(block.kind)) continue;

        // A block generated by the drafting layer that asserts something must cite a fact.
        if (block.generatedBy === "llm" && block.cites.length === 0) {
          violations.push(
            violation({
              ruleId: "A5",
              severity: "block",
              message: `Block ${block.id} (${block.kind}) was generated but cites no fact. A section that needs an uncited capability produces a gap marker routed back to intake, never a plausible sentence.`,
              locator: { sectionId: section.id, blockId: block.id },
            }),
          );
          continue;
        }

        for (const factId of block.cites) {
          if (!knownFactIds.has(factId)) {
            violations.push(
              violation({
                ruleId: "A5",
                severity: "block",
                message: `Block ${block.id} cites fact "${factId}", which does not exist in the knowledge base.`,
                locator: { sectionId: section.id, blockId: block.id },
              }),
            );
          }
        }
      }
    }

    return violations;
  },
};

/**
 * A6 - Negative facts. BLOCK.
 *
 * Some things must not be claimed because XL.net does not do them. Negative facts are first-class
 * records with polarity "negative", and this rule checks the document against them.
 */
export const A6: Rule = {
  id: "A6",
  title: "Negative facts",
  severity: "block",
  check: (ctx) => {
    const violations = [];

    /** Claim patterns that would contradict a negative fact, keyed by that fact's key. */
    const forbiddenClaims: Record<string, string[]> = {
      "capability.dark-web-monitoring": [
        "we offer dark web monitoring",
        "we provide dark web monitoring",
        "dark web monitoring is included",
        "our dark web monitoring",
        "includes dark web monitoring",
      ],
      "capability.sharepoint-power-platform": [
        "power apps development",
        "power automate development",
        "power platform development",
        "sharepoint site architecture and redesign is included",
        "advanced sharepoint builds",
      ],
      "compliance.partner-tiers": [
        "gold partner",
        "platinum partner",
        "silver partner",
        "premier partner",
        "elite partner",
      ],
      "compliance.nist-csf-certification": [
        "nist csf certified",
        "nist cybersecurity framework certified",
        "our nist csf certification",
        "certified against nist csf",
      ],
    };

    const negatives = new Map(negativeFacts(ctx.knowledge).map((f) => [f.key, f]));

    for (const [factKey, phrases] of Object.entries(forbiddenClaims)) {
      const fact = negatives.get(factKey);
      if (!fact) continue;

      violations.push(
        ...scanForbiddenPhrases(ctx, {
          ruleId: "A6",
          severity: "block",
          phrases,
          message: (phrase) =>
            `"${phrase}" contradicts the negative fact ${factKey}: ${fact.statement}`,
          suggestion: fact.detail ?? fact.statement,
        }),
      );
    }

    return violations;
  },
};

/**
 * A7 - SOC model is hybrid. BLOCK.
 *
 * XL.net's own 24/7/365 service desk works alongside an EXTERNAL 24/7/365 SOC. Describe it as a
 * hybrid: do not claim a wholly internal SOC, and do not let it read as pure resale.
 */
export const A7: Rule = {
  id: "A7",
  title: "SOC model is hybrid",
  severity: "block",
  check: (ctx) => {
    const violations = scanForbiddenPhrases(ctx, {
      ruleId: "A7",
      severity: "block",
      phrases: [
        "our own soc",
        "our in-house soc",
        "our internal soc",
        "wholly internal soc",
        "we operate our own security operations center",
        "xl.net's soc analysts",
      ],
      message: (phrase) =>
        `"${phrase}" claims a wholly internal SOC. The model is hybrid: XL.net's own 24/7/365 service desk works alongside an external 24/7/365 SOC doing continuous monitoring and first-pass triage, with escalations coming to XL.net engineers.`,
      suggestion:
        "Our 24/7/365 service desk works alongside an external 24/7/365 SOC that performs continuous monitoring and first-pass triage. Escalations come to XL.net engineers, who own investigation, containment, and client communication.",
    });

    // If the SOC is described at all, the hybrid nature must be visible.
    if (mentions(ctx, ["SOC", "security operations center"])) {
      const text = documentText(ctx).toLowerCase();
      const showsHybrid = /external|third[- ]party|partner soc|alongside/.test(text);
      if (!showsHybrid) {
        violations.push(
          violation({
            ruleId: "A7",
            severity: "block",
            message:
              "The SOC is described without naming its hybrid structure. It must read as neither wholly internal nor pure resale.",
            suggestion:
              "Describe the external SOC's continuous monitoring and first-pass triage, and XL.net engineers owning investigation, containment, and client communication.",
          }),
        );
      }
    }

    return violations;
  },
};

/**
 * A8 - CIS Controls scope. WARN.
 *
 * Client environments are audited against a SUBSET of the CIS Controls (v8), not the full set, and
 * never the retired "CIS 20."
 */
export const A8: Rule = {
  id: "A8",
  title: "CIS Controls scope",
  severity: "warn",
  check: (ctx) => {
    const violations = scanForbiddenPhrases(ctx, {
      ruleId: "A8",
      severity: "warn",
      phrases: ["cis 20", "all cis controls", "full cis controls", "the complete cis controls"],
      message: (phrase) =>
        `"${phrase}" overstates the CIS scope. Environments are audited against a subset of CIS Controls v8.`,
      suggestion: "a subset of CIS Controls v8",
    });

    // Mentioning CIS at all without the "subset" qualifier is the same overstatement.
    for (const span of textSpans(ctx)) {
      const lower = span.text.toLowerCase();
      if (!/\bcis controls?\b/.test(lower)) continue;
      if (/subset/.test(lower)) continue;

      violations.push(
        violation({
          ruleId: "A8",
          severity: "warn",
          message:
            'CIS Controls are referenced without the "subset" qualifier, which reads as the full set.',
          locator: {
            ...(span.sectionId ? { sectionId: span.sectionId } : {}),
            ...(span.blockId ? { blockId: span.blockId } : {}),
            field: span.field,
          },
          excerpt: span.text.slice(0, 140),
          suggestion: "a subset of CIS Controls v8",
        }),
      );
    }

    return violations;
  },
};

export const A_RULES: Rule[] = [A1, A2, A3, A4, A5, A6, A7, A8];
