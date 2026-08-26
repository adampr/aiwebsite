/**
 * C. Freshness and consistency.
 */

import { contentHash, flattenTimedMessage, type TimedMessage } from "@/lib/rfp/content-model";
import { documentText, textSpans, violation, type Rule } from "./rule";

/**
 * C1 - Stale-fact detection. BLOCK.
 *
 * If any fact cited by a proposal has a correctedAt LATER than the proposal's draft, the proposal
 * is stale.
 *
 * The rule is counterintuitive and worth restating: REBUILD, DO NOT PATCH. A stale draft usually
 * carries the error in several places plus placeholders for facts now on file, and patching leaves
 * the un-grepped instances behind. One proposal was four days old and still carried four corrected
 * errors: the contract term, the onboarding sequence, the onsite billing, and the service-desk
 * location. Four days.
 */
export const C1: Rule = {
  id: "C1",
  title: "Stale-fact detection",
  severity: "block",
  check: (ctx) => {
    const violations = [];
    const draftedAt = ctx.proposal.proposal.draftedAt;

    // A citation may point at a fact that has since been superseded, so both the cited record and
    // its replacement have to be considered.
    const correctionBySupersededId = new Map(
      ctx.knowledge.facts
        .filter((f) => f.correctedAt && f.supersedes)
        .map((f) => [f.supersedes as string, f]),
    );

    for (const section of ctx.proposal.sections) {
      for (const block of section.blocks) {
        for (const factId of block.cites) {
          const cited = ctx.factsById[factId];
          const replacement = correctionBySupersededId.get(factId);
          const correction = replacement ?? (cited?.correctedAt ? cited : undefined);
          if (!correction?.correctedAt) continue;
          if (correction.correctedAt <= draftedAt) continue;

          // §5.17, viewer-zone timestamps. This sentence carried two instants as bare
          // `toISOString().slice(0, 10)` UTC days, and it is READER-FACING: C1 is
          // registered in gate.ts, the GateResult crosses
          // POST /api/rfp/proposals/[id]/gate into workspace.tsx's Checks pane (and is
          // seeded there from the stored gate_json server-side), which paints the
          // message. So a Chicago staffer who corrected a fact at 21:30 on Jul 26 read
          // "Corrected Jul 26, 2026, 09:30 PM CDT" on /rfp/knowledge and "corrected on
          // 2026-07-27" here: one instant, two consoles, two days. The whole payload of
          // this sentence is the ORDERING of those two days, so a shifted day is not a
          // cosmetic wrongness, it is the point of the rule rendered false.
          //
          // A plain string cannot hold a React element, so the sentence is carried SPLIT
          // (TimedMessage) and the Checks pane renders each instant through
          // <LocalTime withTime>. `message` is DERIVED from the split form, never written
          // beside it, so the flat fallback (an older stored gate_json row,
          // formatGateResult's terminal report) cannot drift from what the pane paints.
          // Both values are real `Date`s: correctedAt is a timestamptz column and
          // draftedAt is proposal.createdAt, both through drizzle column selects, so
          // PgTimestamp.mapFromDriverValue has already mapped them (a raw sql<> select
          // would have handed back a string, which is the trap §4 records).
          const timedMessage: TimedMessage = {
            segments: [
              {
                before: `Block ${block.id} cites ${correction.key}, which was corrected on `,
                iso: correction.correctedAt.toISOString(),
              },
              {
                before: ", after this proposal was drafted on ",
                iso: draftedAt.toISOString(),
              },
            ],
            after: ". Rebuild; do not patch.",
          };

          violations.push(
            violation({
              ruleId: "C1",
              severity: "block",
              message: flattenTimedMessage(timedMessage),
              timedMessage,
              locator: { sectionId: section.id, blockId: block.id },
              suggestion: correction.statement,
            }),
          );
        }
      }
    }

    // The cheap version of the same question, for a proposal whose citations are incomplete.
    if (ctx.knowledge.kbVersion > ctx.proposal.proposal.draftedAgainstKbVersion && violations.length === 0) {
      violations.push(
        violation({
          ruleId: "C1",
          severity: "warn",
          message: `The knowledge base is at version ${ctx.knowledge.kbVersion} but this proposal was drafted against version ${ctx.proposal.proposal.draftedAgainstKbVersion}. No cited fact was corrected, so this is advisory.`,
        }),
      );
    }

    return violations;
  },
};

/**
 * C2 - Cross-format parity. BLOCK.
 *
 * Structurally guaranteed by single-sourcing, so this validator is a REGRESSION TEST rather than a
 * check: it asserts the content hash the artifacts will carry is derivable from the model alone.
 * If it ever fails, an emitter has started generating content instead of rendering it.
 */
export const C2: Rule = {
  id: "C2",
  title: "Cross-format parity",
  severity: "block",
  check: (ctx) => {
    const stated = ctx.proposal.contentHash;
    if (!stated) return [];

    const recomputed = contentHash({
      proposal: ctx.proposal.proposal,
      cover: ctx.proposal.cover,
      letter: ctx.proposal.letter,
      backCover: ctx.proposal.backCover,
      sections: ctx.proposal.sections,
      pricing: ctx.proposal.pricing,
      references: ctx.proposal.references,
      findings: ctx.proposal.findings,
    });

    if (stated === recomputed) return [];

    return [
      violation({
        ruleId: "C2",
        severity: "block",
        message: `The resolved proposal's contentHash (${stated.slice(0, 12)}…) does not match the hash of its own content (${recomputed.slice(0, 12)}…). Two artifacts built from this would not be twins.`,
      }),
    ];
  },
};

/**
 * C3 - Requirement coverage. BLOCK.
 *
 * Every Requirement extracted at ingest must map to at least one block. "gap-acknowledged" is a
 * PASS, because rule D4 says an honest "we do not do this, here is what we do instead" is a
 * correct answer, not a hole. The gate blocks only on "uncovered".
 */
export const C3: Rule = {
  id: "C3",
  title: "Requirement coverage",
  severity: "block",
  check: (ctx) => {
    if (ctx.requirements.length === 0) return [];

    const byRequirement = new Map<string, string[]>();
    for (const coverage of ctx.coverage) {
      const states = byRequirement.get(coverage.requirementId) ?? [];
      states.push(coverage.state);
      byRequirement.set(coverage.requirementId, states);
    }

    const violations = [];
    for (const requirement of ctx.requirements) {
      const states = byRequirement.get(requirement.id) ?? [];
      const satisfied = states.some((s) => s === "covered" || s === "gap-acknowledged");
      if (satisfied) continue;

      const partial = states.includes("partial");
      violations.push(
        violation({
          ruleId: "C3",
          severity: requirement.mandatory ? "block" : "warn",
          message: partial
            ? `Requirement ${requirement.ordinal} (${requirement.structureLabel}) is only partially covered: "${requirement.text.slice(0, 120)}"`
            : `Requirement ${requirement.ordinal} (${requirement.structureLabel}) is not answered anywhere: "${requirement.text.slice(0, 120)}"`,
          locator: { requirementId: requirement.id },
          suggestion:
            'Direct questions deserve direct answers. The phrasing that scores is "To answer your question directly: yes…" rather than an adjacent paragraph that implies it.',
        }),
      );
    }

    return violations;
  },
};

/**
 * C4 - Client structure fidelity. BLOCK.
 *
 * Sections appear in the client's order, with the client's headings and numbering. Every content
 * page carries the client's own section label so an evaluator can score against their checklist
 * without hunting.
 */
export const C4: Rule = {
  id: "C4",
  title: "Client structure fidelity",
  severity: "block",
  check: (ctx) => {
    const violations = [];

    for (const section of ctx.proposal.sections) {
      if (!section.structureLabel.trim()) {
        violations.push(
          violation({
            ruleId: "C4",
            severity: "block",
            message: `Section "${section.title}" has no structure label. Every content page must carry the client's own section label.`,
            locator: { sectionId: section.id },
          }),
        );
      }
    }

    // Ordinals must be strictly increasing, so the client's order is preserved.
    const ordinals = ctx.proposal.sections.map((s) => s.ordinal);
    for (let i = 1; i < ordinals.length; i += 1) {
      if (ordinals[i]! <= ordinals[i - 1]!) {
        violations.push(
          violation({
            ruleId: "C4",
            severity: "block",
            message: `Sections are out of order: "${ctx.proposal.sections[i]!.structureLabel}" has ordinal ${ordinals[i]} after ${ordinals[i - 1]}.`,
            locator: { sectionId: ctx.proposal.sections[i]!.id },
          }),
        );
      }
    }

    return violations;
  },
};

/**
 * C5 - Product-name spelling. WARN.
 *
 * Spelling matters in a security proposal. These are the exact forms.
 */
const PRODUCT_SPELLINGS: Record<string, string> = {
  rocketcyber: "RocketCyber",
  bullphish: "BullPhish",
  sentinelone: "SentinelOne",
  saasalerts: "SaaSAlerts",
  dnsfilter: "DNSFilter",
  veeam: "Veeam",
  datto: "Datto",
  knowbe4: "KnowBe4",
  barracuda: "Barracuda",
  keeper: "Keeper",
  bitwarden: "Bitwarden",
  autotask: "Autotask",
  kaseya: "Kaseya",
};

export const C5: Rule = {
  id: "C5",
  title: "Product-name spelling",
  severity: "warn",
  check: (ctx) => {
    const violations = [];

    for (const span of textSpans(ctx)) {
      for (const [lower, correct] of Object.entries(PRODUCT_SPELLINGS)) {
        const pattern = new RegExp(`\\b${lower}\\b`, "gi");
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(span.text)) !== null) {
          if (match[0] === correct) continue;
          violations.push(
            violation({
              ruleId: "C5",
              severity: "warn",
              message: `"${match[0]}" should be spelled "${correct}".`,
              locator: {
                ...(span.sectionId ? { sectionId: span.sectionId } : {}),
                ...(span.blockId ? { blockId: span.blockId } : {}),
                field: span.field,
                charOffset: match.index,
              },
              excerpt: span.text.slice(Math.max(0, match.index - 30), match.index + 40),
              suggestion: correct,
            }),
          );
        }
      }
    }

    return violations;
  },
};

/**
 * C6 - SentinelOne vs Microsoft Sentinel. WARN.
 *
 * Different products, confusingly similar names. SentinelOne is the endpoint EDR/XDR agent;
 * Microsoft Sentinel is the cloud SIEM. Adam's own answers sometimes conflate them, so the app
 * should not inherit the confusion.
 */
export const C6: Rule = {
  id: "C6",
  title: "SentinelOne vs Microsoft Sentinel",
  severity: "warn",
  check: (ctx) => {
    const violations = [];
    const text = documentText(ctx);

    // "Sentinel" as a bare word, where SentinelOne or Microsoft Sentinel was meant.
    for (const span of textSpans(ctx)) {
      const bare = /\bSentinel\b(?!One)/g;
      let match: RegExpExecArray | null;
      while ((match = bare.exec(span.text)) !== null) {
        const before = span.text.slice(Math.max(0, match.index - 12), match.index);
        if (/microsoft\s*$/i.test(before) || /azure\s*$/i.test(before)) continue;
        violations.push(
          violation({
            ruleId: "C6",
            severity: "warn",
            message:
              'Bare "Sentinel" is ambiguous. SentinelOne is the endpoint EDR/XDR agent; Microsoft Sentinel is the cloud SIEM.',
            locator: {
              ...(span.sectionId ? { sectionId: span.sectionId } : {}),
              ...(span.blockId ? { blockId: span.blockId } : {}),
              field: span.field,
              charOffset: match.index,
            },
            excerpt: span.text.slice(Math.max(0, match.index - 30), match.index + 40),
            suggestion: 'Write "SentinelOne" or "Microsoft Sentinel" explicitly.',
          }),
        );
      }
    }

    // If the RFP topic is SIEM and Sentinel is discussed, the XL Secure+ position must be stated.
    const discussesSiem = /\bsiem\b/i.test(text);
    const mentionsMsSentinel = /microsoft sentinel/i.test(text);
    if (discussesSiem && mentionsMsSentinel && !/xl secure\+/i.test(text)) {
      violations.push(
        violation({
          ruleId: "C6",
          severity: "warn",
          message:
            "Microsoft Sentinel is discussed as the SIEM without stating the XL Secure+ position. Say it plainly rather than just agreeing to Sentinel.",
          suggestion:
            "XL.net can administer Microsoft Sentinel and includes it at no additional monthly fee for XL Secure+ clients, with Azure log ingestion at cost. XL Secure+ is recommended as the primary SIEM/SOC because it is what XL.net has run for years across thousands of endpoints.",
        }),
      );
    }

    return violations;
  },
};

export const C_RULES: Rule[] = [C1, C2, C3, C4, C5, C6];
