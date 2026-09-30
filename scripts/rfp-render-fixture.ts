/**
 * Render the visual-blocks fixture to PDF and Word (ARCHITECTURE.md §5.17).
 *
 *   npm run rfp:render-fixture -- <outdir>
 *
 * No database, no brain, no network: the fixture's sections, stub document and
 * proposal rows, the seed facts and a quote built from the seed rate card go
 * through the SAME path a download takes (resolveDraft -> gate -> buildExportView
 * -> both emitters). The gate report is printed so a fixture visual that trips a
 * rule is seen here, not in a client's download. Writes only into <outdir>, which
 * must be given and must lie outside the repository tree.
 *
 * `buildFixtureGateInput` is exported for the visual gate tests, so the tests and
 * the renders share one input.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RATE_CARD } from "../src/lib/rfp/seed/rate-card";
import { ALL_FACTS } from "../src/lib/rfp/seed/facts";
import { buildQuote, EMPTY_QUOTE_INPUTS } from "../src/lib/rfp/quote";
import { resolveDraft, runDraftGate, type DraftGateInput } from "../src/lib/rfp/resolve-draft";
import { formatGateResult } from "../src/lib/rfp/validators/gate";
import {
  buildExportView,
  exportFileName,
  renderRfpDocx,
  renderRfpPdf,
} from "../src/lib/rfp/export";
import type { DocumentRow, FactRow, ProposalRow, RequirementRow } from "../src/lib/rfp/db";
import {
  FIXTURE_CLIENT,
  FIXTURE_UPDATED_AT,
  requirements as fixtureRequirements,
  sections as fixtureSections,
  stretchTimelineBlock,
  structure as fixtureStructure,
  type FixtureSection,
} from "./fixtures/rfp-visual-fixture";

const DRAFTED_AT = new Date(FIXTURE_UPDATED_AT);
const DOC_ID = "00000000-0000-4000-8000-00000000d0c1";
const PROPOSAL_ID = "00000000-0000-4000-8000-0000000000p1";
const OWNER = "adam@xl.net";

/** The seed facts in row shape (the seed IS the content-model Fact, which the row mirrors). */
export function fixtureFactRows(): FactRow[] {
  return ALL_FACTS.map((f) => ({
    id: f.id,
    key: f.key,
    category: f.category,
    statement: f.statement,
    polarity: f.polarity,
    detail: f.detail,
    sourceUrl: f.sourceUrl,
    verifiedAt: f.verifiedAt,
    correctedAt: f.correctedAt,
    supersedes: f.supersedes,
    introducedInKb: f.introducedInKb,
    retiredInKb: f.retiredInKb,
    confidence: f.confidence,
  }));
}

/**
 * The gate input a download would build for the fixture proposal. `sections`
 * defaults to the fixture's, with the onboarding timeline closing the
 * Transition Plan section so every renderer meets the stretch kind too.
 */
export function buildFixtureGateInput(
  sections: FixtureSection[] = withTimeline(fixtureSections),
  over: Partial<DraftGateInput> = {}
): DraftGateInput {
  const doc: DocumentRow = {
    id: DOC_ID,
    ownerUserId: null,
    ownerEmail: OWNER,
    title: `${FIXTURE_CLIENT} RFP`,
    clientName: FIXTURE_CLIENT,
    sourceKind: "paste",
    sourceName: null,
    sourceSha256: null,
    sourceBytes: null,
    rawText: "",
    injectionFlagged: false,
    archivedAt: null,
    structureJson: JSON.stringify(fixtureStructure),
    statedStaffCount: 40,
    statedStaffQuote: null,
    statedStaffBasis: "users",
    structureConfirmedAt: DRAFTED_AT,
    dueDate: null,
    status: "extracted",
    createdAt: DRAFTED_AT,
    updatedAt: DRAFTED_AT,
  };
  const built = buildQuote(
    RATE_CARD,
    {
      ...EMPTY_QUOTE_INPUTS,
      fullyManagedUsers: 40,
      securePlusComputers: 40,
      dattoRetention: "1yr",
      vulnScanSessionsPerYear: 0,
      includeOnboarding: true,
    },
    PROPOSAL_ID
  );
  const proposal: ProposalRow = {
    id: PROPOSAL_ID,
    documentId: DOC_ID,
    ownerUserId: null,
    ownerEmail: OWNER,
    title: "Managed IT Services",
    status: "draft",
    rev: 1,
    draftedAgainstKbVersion: 2,
    sectionsJson: JSON.stringify(sections),
    gateJson: null,
    gateRanAt: null,
    pricingInputsJson: null,
    pricingJson: JSON.stringify(built.quote),
    approvedBy: null,
    approvedAt: null,
    genStartedAt: null,
    genAttemptId: null,
    genHeartbeatAt: null,
    genProgress: null,
    genError: null,
    createdAt: DRAFTED_AT,
    updatedAt: DRAFTED_AT,
  } as ProposalRow;
  const requirements: RequirementRow[] = fixtureRequirements.map((r, i) => ({
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    documentId: DOC_ID,
    structureLabel: r.structureLabel,
    text: r.text,
    ordinal: i,
    kind: "question",
    mandatory: true,
    coverageState: "covered",
    coverageNote: null,
    createdAt: DRAFTED_AT,
  }));
  return {
    doc,
    proposal,
    sections,
    structure: fixtureStructure,
    requirements,
    quote: built.quote,
    allFacts: fixtureFactRows(),
    myKnowledge: [],
    rateCard: RATE_CARD,
    kbVersion: 2,
    ownerName: "Adam Radulovic",
    statesHeadcountOnly: false,
    supportedUserSplitConfirmed: true,
    ...over,
  };
}

/** The fixture sections with the onboarding timeline closing "6. Transition Plan". */
export function withTimeline(sections: FixtureSection[]): FixtureSection[] {
  return sections.map((s) =>
    s.label === "6."
      ? { ...s, blocks: [...(s.blocks ?? []), { ...stretchTimelineBlock, after: s.paragraphs.length }] }
      : s
  );
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: npm run rfp:render-fixture -- <outdir>   (outside the repository)");
    process.exit(2);
  }
  const outdir = path.resolve(arg);
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  if (outdir === repo || outdir.startsWith(repo + path.sep)) {
    console.error(`refusing to write inside the repository tree: ${outdir}`);
    process.exit(2);
  }
  fs.mkdirSync(outdir, { recursive: true });

  const input = buildFixtureGateInput();
  const gate = runDraftGate(input);
  console.log(formatGateResult(gate));

  const { resolved } = resolveDraft(input);
  const view = buildExportView(resolved, input.rateCard);
  const pdfName = exportFileName(view, "pdf");
  const docxName = exportFileName(view, "docx");
  fs.writeFileSync(path.join(outdir, pdfName), await renderRfpPdf(view));
  fs.writeFileSync(path.join(outdir, docxName), await renderRfpDocx(view));
  fs.writeFileSync(path.join(outdir, "resolved.json"), JSON.stringify(resolved, null, 2));
  console.log(`\nwrote ${path.join(outdir, pdfName)}\nwrote ${path.join(outdir, docxName)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
