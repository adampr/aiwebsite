// Gate assembly for a runtime draft (ARCHITECTURE.md §5.17.1).
//
// Gathers everything ValidationContext needs from Postgres, lifts the draft
// through resolve-draft, runs the 26 rules, and stores the result on the
// proposal row. Shared by the gate route (the Checks pane) and the export
// route (which refuses to emit on a failing gate) so the two can never
// disagree about what "passing" means.

import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import {
  allFacts,
  currentKbVersion,
  currentRateCard,
  knowledgeProposalsForOwner,
  listRequirements,
  readProposalChecksIgnores,
  writeProposalGate,
  type DocumentRow,
  type ProposalRow,
} from "./db";
import type { RfpUser } from "./access";
import { applyIgnores, parseCheckIgnores } from "./check-ignores";
import { parseQuoteInputs, toRateCard, EMPTY_QUOTE_INPUTS } from "./quote";
import { resolveDraft, runDraftGate, type DraftGateInput } from "./resolve-draft";
import type { GateResult } from "./validators/gate";
import type { DraftSectionRecord } from "@/app/api/rfp/documents/[id]/generate/route";
import type { PricingQuote } from "./content-model";

export async function ownerDisplayName(email: string): Promise<string> {
  try {
    const rows = await db
      .select({ name: users.displayName })
      .from(users)
      .where(eq(users.email, email.toLowerCase()))
      .limit(1);
    const name = rows[0]?.name?.trim();
    if (name) return name;
  } catch {
    // fall through to the email-derived name
  }
  return email.split("@")[0].replace(/[._]/g, " ");
}

export async function buildGateInput(
  _user: RfpUser,
  doc: DocumentRow,
  proposal: ProposalRow
): Promise<DraftGateInput | { error: "no_rate_card" }> {
  const cardView = await currentRateCard();
  if (!cardView) return { error: "no_rate_card" };

  // pending_* citations resolve against the PROPOSAL OWNER's private
  // knowledge, not the caller's: an admin gating a user's draft must see the
  // drafter's rows, or rule A5 hard-blocks on citations that resolve fine.
  const [facts, requirements, kbVersion, mine, ownerName] = await Promise.all([
    allFacts(),
    listRequirements(doc.id),
    currentKbVersion(),
    knowledgeProposalsForOwner(proposal.ownerEmail),
    ownerDisplayName(proposal.ownerEmail),
  ]);

  const sections: DraftSectionRecord[] = JSON.parse(
    proposal.sectionsJson || "[]"
  );
  const structure: { label: string; title: string }[] = doc.structureJson
    ? JSON.parse(doc.structureJson)
    : [];
  const quote: PricingQuote | null = proposal.pricingJson
    ? JSON.parse(proposal.pricingJson)
    : null;
  const inputs = proposal.pricingInputsJson
    ? parseQuoteInputs(JSON.parse(proposal.pricingInputsJson))
    : EMPTY_QUOTE_INPUTS;

  return {
    doc,
    proposal,
    sections,
    structure,
    requirements,
    quote,
    allFacts: facts,
    myKnowledge: mine,
    rateCard: toRateCard(cardView),
    kbVersion,
    ownerName,
    statesHeadcountOnly: inputs.statesHeadcountOnly,
    supportedUserSplitConfirmed: inputs.supportedUserSplitConfirmed,
  };
}

export { resolveDraft };
export type { DraftGateInput };

/** Run the gate and persist the result on the proposal row. */
export async function runAndStoreGate(
  user: RfpUser,
  doc: DocumentRow,
  proposal: ProposalRow
): Promise<GateResult | { error: "no_rate_card" }> {
  const input = await buildGateInput(user, doc, proposal);
  if ("error" in input) return input;
  // Persisted dismissals are re-applied to EVERY stored result, here and in
  // the export route (§5.17.8): the rules recompute from scratch, so the
  // marks (and the recomputed `passed`) exist only through this re-apply,
  // and the two store sites must never disagree. The column is re-read AFTER
  // the rules run, not taken from the proposal snapshot, so an Ignore landing
  // mid-run still marks the result being stored (readProposalChecksIgnores
  // has the full rationale).
  const raw = runDraftGate(input);
  const result = applyIgnores(
    raw,
    parseCheckIgnores(await readProposalChecksIgnores(proposal.id))
  );
  await writeProposalGate(proposal.id, JSON.stringify(result));
  return result;
}
