/**
 * Review and consolidate one /rfp proposal from the command line
 * (ARCHITECTURE.md §5.17.16).   npm run rfp:consolidate -- <proposalId>
 *
 * The workspace's "Review and consolidate" round, run inline at the VM with
 * no browser: at most 2 passes of the consolidation review turn, shaped
 * EXACTLY as the section route shapes it (prepareConsolidationReview: the
 * duplicate scan over paragraphs and tables, the prune guard), then
 *   - revise targets: reviseSection, then a CAS-on-rev write with the same
 *     semantics as the section PATCH (cites and generatedBy carried over, the
 *     letter's "human" stamp, visuals kept and re-anchored, a markdown table
 *     lifted into a table block, the letter never lifted);
 *   - prune-visual targets: applyVisualsOp "remove" + a CAS-on-rev write,
 *     exactly the PATCH visuals op (the server-side scan guard already
 *     limited them to scan-clustered blocks on their own section);
 *   - retitle/remove targets: printed as "needs a person", never applied.
 * Shared facts only (no user, so no private knowledge). Every write and turn
 * logs the activity row the route logs, actor "cli". Prints labels and
 * counts only, never client or drafted text, never an env value.
 * Exit 0 when the round applied changes or the review found it clean; 1 on a
 * refusal, a failed review, or when every attempted change failed; 2 usage.
 */

import "dotenv/config";
import { logRfpActivity } from "../src/lib/rfp/activity";
import {
  brainHealthy,
  prepareConsolidationReview,
  reviewDocumentConsolidation,
  reviseSection,
  sectionBlocksForPrompt,
} from "../src/lib/rfp/brain";
import { CONSOLIDATE_INSTRUCTION } from "../src/lib/rfp/consolidate";
import {
  getProposalById,
  isUuid,
  listRequirements,
  liveFacts,
  writeProposalSections,
  type FactRow,
} from "../src/lib/rfp/db";
import { liftMarkdownTables } from "../src/lib/rfp/draft-blocks";
import {
  applyVisualsOp,
  keptBlocks,
  toGroundFacts,
  withBlocks,
} from "../src/lib/rfp/draft-blocks-ops";
import { LETTER_LABEL } from "../src/lib/rfp/letter";
import type { DraftSectionRecord } from "../src/app/api/rfp/documents/[id]/generate/route";

// An operator at the VM, not the proposal's owner: the activity log must not
// claim the owner ran it (same actor as rfp:reread).
const actor = { email: "cli", admin: true };

type Outcome = { kind: "applied" | "skipped" | "failure"; line: string };

// The round's table-lift totals, printed as one count line at the end: a
// refused lift stays as visible pipe text, so it must not pass unreported.
const liftTotals = { lifted: 0, refused: 0 };

async function readSections(
  proposalId: string
): Promise<{
  rev: number;
  status: string;
  documentId: string;
  sections: DraftSectionRecord[];
} | null> {
  const p = await getProposalById(proposalId);
  if (!p) return null;
  return {
    rev: p.rev,
    status: p.status,
    documentId: p.documentId,
    sections: JSON.parse(p.sectionsJson || "[]") as DraftSectionRecord[],
  };
}

/** One revise target: the turn, then the PATCH-equivalent CAS write. */
async function applyRevise(
  proposalId: string,
  label: string,
  directive: string,
  shared: FactRow[]
): Promise<Outcome> {
  const now = await readSections(proposalId);
  if (!now) return { kind: "failure", line: `${label}: the proposal is gone.` };
  const at = now.sections.findIndex((s) => s.label === label);
  if (at < 0) return { kind: "skipped", line: `${label}: the section is gone.` };
  const section = now.sections[at];
  const isLetter = label === LETTER_LABEL;
  const shownBlocks = sectionBlocksForPrompt(section);
  const result = await reviseSection(
    proposalId,
    isLetter ? section.title : `${section.label} ${section.title}`,
    section.paragraphs,
    shownBlocks,
    CONSOLIDATE_INSTRUCTION,
    shared,
    undefined,
    directive || undefined,
    !isLetter
  );
  if (!result) return { kind: "failure", line: `${label}: Tron did not return a revision.` };
  await logRfpActivity({
    actorEmail: actor.email,
    actorAdmin: actor.admin,
    action: "proposal.tron_revise",
    subjectKind: "proposal",
    subjectId: proposalId,
    meta: {
      section: label,
      instructionChars: CONSOLIDATE_INSTRUCTION.length,
      directiveChars: directive.length,
      attachedChars: 0,
      attachedInjectionHits: 0,
      proposedHeading: result.heading !== null,
      proposedRemove: result.remove,
      visualsShown: shownBlocks.length,
      via: "cli",
    },
  });
  if (result.remove)
    return { kind: "skipped", line: `${label}: needs a person (Tron proposed removing the section).` };
  if (result.paragraphs.length === 0)
    return { kind: "failure", line: `${label}: Tron did not return a revision.` };
  if (
    result.paragraphs.length === section.paragraphs.length &&
    result.paragraphs.every((p, i) => p === section.paragraphs[i])
  )
    return { kind: "skipped", line: `${label}: Tron left the text as it was.` };

  // The section PATCH's plain path, verbatim in effect: the PATCH caps, kept
  // visuals re-anchored, the table lift (never on the letter), cites and
  // generatedBy carried over, the letter's "human" stamp.
  const paragraphs = result.paragraphs.slice(0, 12).map((p) => p.slice(0, 4000));
  const kept = keptBlocks(section, paragraphs.length);
  const lift = isLetter
    ? { paragraphs, blocks: kept, lifted: 0, refused: 0 }
    : liftMarkdownTables(paragraphs, kept, toGroundFacts(shared), section.cites);
  const next = [...now.sections];
  next[at] = withBlocks(
    {
      ...section,
      paragraphs: lift.paragraphs,
      cites: section.cites,
      generatedBy: isLetter ? "human" : section.generatedBy,
      updatedAt: new Date().toISOString(),
    },
    lift.blocks
  ) as DraftSectionRecord;
  // CAS on the rev read BEFORE the turn: a change made while Tron worked
  // refuses this write, the same staleness guard the client applies.
  const ok = await writeProposalSections(proposalId, now.rev, JSON.stringify(next));
  if (!ok)
    return { kind: "failure", line: `${label}: the draft changed while Tron worked; not saved.` };
  liftTotals.lifted += lift.lifted;
  liftTotals.refused += lift.refused;
  await logRfpActivity({
    actorEmail: actor.email,
    actorAdmin: actor.admin,
    action: "proposal.section_edit",
    subjectKind: "proposal",
    subjectId: proposalId,
    meta: {
      section: label,
      paragraphs: lift.paragraphs.length,
      ...(lift.lifted > 0 ? { liftedTables: lift.lifted } : {}),
      ...(lift.refused > 0 ? { liftRefused: lift.refused } : {}),
      via: "cli",
    },
  });
  const heading = result.heading ? " Tron also proposed a new heading; needs a person." : "";
  return {
    kind: "applied",
    line: `${label}: consolidated${lift.lifted > 0 ? `, ${lift.lifted} table${lift.lifted === 1 ? "" : "s"} lifted` : ""}${lift.refused > 0 ? `, ${lift.refused} table${lift.refused === 1 ? "" : "s"} left as text (a control refused the lift)` : ""}.${heading}`,
  };
}

/** One prune-visual target: the PATCH visuals op "remove", CAS on rev. */
async function applyPrune(proposalId: string, label: string, blockId: string): Promise<Outcome> {
  const now = await readSections(proposalId);
  if (!now) return { kind: "failure", line: `${label}: the proposal is gone.` };
  const applied = applyVisualsOp(
    now.sections,
    { label, action: "remove", blockId },
    [],
    new Date().toISOString()
  );
  if (!applied.ok)
    return applied.status === 404
      ? { kind: "skipped", line: `${label}: the duplicated visual ${blockId} was already gone.` }
      : { kind: "failure", line: `${label}: visual ${blockId} not removed (${applied.code}).` };
  // The scan only clusters tables, so this never fires; removing a person's
  // references also reopens a question, which is the route's job.
  if (applied.removedReferences)
    return { kind: "skipped", line: `${label}: needs a person (that visual is the client references).` };
  const ok = await writeProposalSections(proposalId, now.rev, JSON.stringify(applied.sections));
  if (!ok) return { kind: "failure", line: `${label}: the draft changed; visual ${blockId} not removed.` };
  await logRfpActivity({
    actorEmail: actor.email,
    actorAdmin: actor.admin,
    action: "proposal.section_visuals",
    subjectKind: "proposal",
    subjectId: proposalId,
    meta: {
      section: label,
      visual: "remove",
      added: applied.added,
      removed: applied.removed,
      blocks: applied.section.blocks?.length ?? 0,
      via: "cli",
    },
  });
  return { kind: "applied", line: `${label}: removed a duplicated visual (${blockId}).` };
}

async function main(): Promise<number> {
  const proposalId = process.argv[2] ?? "";
  if (!isUuid(proposalId)) {
    console.error("usage: npm run rfp:consolidate -- <proposalId>");
    return 2;
  }
  const first = await readSections(proposalId);
  if (!first) {
    console.error(`refused: no proposal ${proposalId}`);
    return 1;
  }
  if (first.status === "sent") {
    console.error("refused: a sent proposal is never edited");
    return 1;
  }
  if (first.sections.filter((s) => s.label !== LETTER_LABEL).length < 2) {
    console.error("refused: fewer than two drafted sections");
    return 1;
  }
  if (!(await brainHealthy())) {
    console.error("refused: the brain is not responding");
    return 1;
  }

  const reqs = (await listRequirements(first.documentId)).map((r) => ({
    structureLabel: r.structureLabel,
    text: r.text,
    kind: r.kind,
    mandatory: r.mandatory,
  }));
  // Shared facts only: there is no user, so no private knowledge rides along.
  const shared = await liveFacts();

  const lines: string[] = [];
  let applied = 0;
  let failed = 0;
  let reviewFailed = false;
  let clean = false;
  for (const pass of [1, 2] as const) {
    const now = await readSections(proposalId);
    if (!now) {
      lines.push("the proposal is gone");
      reviewFailed = true;
      break;
    }
    const { shaped, clusters, findings, guard } = prepareConsolidationReview(
      now.sections
    );
    const review = await reviewDocumentConsolidation(
      proposalId,
      shaped,
      reqs,
      findings,
      shared,
      guard
    );
    if (!review) {
      lines.push(`pass ${pass}: Tron did not return a review.`);
      reviewFailed = true;
      break;
    }
    await logRfpActivity({
      actorEmail: actor.email,
      actorAdmin: actor.admin,
      action: "proposal.consolidate_plan",
      subjectKind: "proposal",
      subjectId: proposalId,
      meta: {
        targets: review.targets.length,
        retitles: review.targets.filter((t) => t.op === "retitle").length,
        removes: review.targets.filter((t) => t.op === "remove").length,
        pruneVisuals: review.targets.filter((t) => t.op === "prune-visual").length,
        duplicateClusters: clusters.length,
        clusterBlocks: guard.clusterOf.size,
        requirements: reqs.length,
        auto: false,
        via: "cli",
      },
    });
    console.log(
      `pass ${pass}: ${review.targets.length} targets, ${clusters.length} duplicate clusters (${guard.clusterOf.size} visuals in them)`
    );
    if (review.targets.length === 0) {
      clean = true;
      break;
    }
    let appliedThisPass = 0;
    for (const t of review.targets) {
      let o: Outcome;
      if (t.op === "retitle" || t.op === "remove")
        o = {
          kind: "skipped",
          line: `${t.label}: needs a person (the review proposed ${t.op === "remove" ? "removing" : "retitling"} the section).`,
        };
      else if (t.op === "prune-visual") o = await applyPrune(proposalId, t.label, t.blockId);
      else o = await applyRevise(proposalId, t.label, t.directive, shared);
      if (o.kind === "applied") {
        applied++;
        appliedThisPass++;
      } else if (o.kind === "failure") failed++;
      lines.push(`pass ${pass}: ${o.line}`);
    }
    // A pass that changed nothing would only repeat itself.
    if (appliedThisPass === 0) break;
  }

  for (const l of lines) console.log(l);
  console.log(
    `tables: ${liftTotals.lifted} lifted into table blocks, ${liftTotals.refused} left as text (a lift control refused them)`
  );
  console.log(
    clean && applied === 0
      ? "clean: the review found nothing to consolidate"
      : `applied ${applied} change${applied === 1 ? "" : "s"}, ${failed} failed${reviewFailed ? ", a review did not run" : ""}`
  );
  if (reviewFailed) return 1;
  if (applied === 0 && failed > 0) return 1;
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("rfp:consolidate failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
