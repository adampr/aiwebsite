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
 *
 * Round 32 (§5.17.20): a SECOND document renders beside the first, the
 * invented brief `buildR32GateInput` builds, carrying the narrative cover
 * headline with Attention, the letterhead's recipient block and system pricing
 * paragraph, the thesis closing, a model timeline, a ledger, three-up cards and
 * an editorial callout. It is the side-by-side harness against the CoWork
 * reference; test:rfpcoverletter asserts on the same input.
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
import type { DraftBlock } from "../src/lib/rfp/draft-blocks";
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
    intakeForm: "rfp",
    contactName: null,
    contactTitle: null,
    clientAddress: null,
    proposalHeadline: null,
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

/* ------------------------------------------------------------------------ */
/* The round-32 fixture (§5.17.20): the CoWork-parity side-by-side document  */
/* ------------------------------------------------------------------------ */

// An invented design studio, drafted from a BRIEF, carrying every piece of
// round-32 furniture and vocabulary: the narrative cover headline with an
// Attention clause and the submitted-by columns, the letterhead's recipient
// block with postal lines, the system pricing paragraph, the thesis on the
// navy closing, a model-authored timeline (Step kickers), a ledger (a model
// fact grid), three-up cards and an editorial callout. Names, the address and
// the 555-01xx phone are made up; XL.net's facts are the seed corpus.
export const R32_CLIENT = "Ashgrove Design Studio";
const R32_DOC_ID = "00000000-0000-4000-8000-00000000d032";
const R32_PROPOSAL_ID = "00000000-0000-4000-8000-0000000000p2";
export const R32_HEADLINE = "Managed IT for an Architecture Studio";
export const R32_CONTACT = { name: "Morgan Ellis", title: "Studio Manager and Operations Lead" };
export const R32_ADDRESS = ["400 Example Avenue, Suite 210", "Springfield, IL 62701", "M: 312-555-0186"];
export const R32_THESIS = "We keep your studio working, so your designers can keep designing.";

const factId = (key: string): string => {
  const f = ALL_FACTS.find((x) => x.key === key && x.retiredInKb === null);
  if (!f) throw new Error(`r32 fixture: no live seed fact for ${key}`);
  return f.id;
};

/** The model-authored round-32 visuals, as A's parsers land them: generatedBy
 *  "llm", no origin, ids pinned so renders compare run to run. */
export function r32Blocks(): {
  escalation: DraftBlock;
  roles: DraftBlock;
  criticalCallout: DraftBlock;
  securityLedger: DraftBlock;
  onboardingSteps: DraftBlock;
} {
  return {
    escalation: {
      kind: "timeline",
      steps: [
        { label: "Step 1", title: "Client Success", body: "First-line triage begins within roughly 15 minutes." },
        { label: "Step 2", title: "Service Desk Engineer", body: "Takes the issue within roughly 1 hour if it is still open." },
        { label: "Step 3", title: "Escalation Engineer", body: "A senior engineer engages within roughly 2 hours." },
        { label: "Step 4", title: "Service Delivery Manager", body: "Owns anything still open, and the outcome." },
      ],
      id: "v_0000b001",
      after: 1,
      cites: [factId("operations.escalation-tiers")],
      generatedBy: "llm",
    },
    roles: {
      kind: "cards",
      cards: [
        { title: "Your XLTO", body: "A named XL.net Technology Officer owns strategy and acts as your strategic vendor manager." },
        { title: "Your System Analyst", body: "A named System Analyst audits your environment against best practice." },
        { title: "When the XLTO is out", body: "A Proactive Manager is the designee, so someone specific is always accountable." },
      ],
      id: "v_0000b002",
      after: 2,
      cites: [factId("operations.named-roles")],
      generatedBy: "llm",
    },
    criticalCallout: {
      kind: "callout",
      title: "Critical issues skip the queue",
      body: "Any issue your studio flags as critical routes straight to an escalation engineer, and an unresolved critical issue escalates again within 1 hour.",
      tone: "emphasis",
      id: "v_0000b003",
      after: 2,
      cites: [factId("operations.escalation-tiers")],
      generatedBy: "llm",
    },
    securityLedger: {
      kind: "fact-grid",
      pairs: [
        { label: "Endpoint protection", value: "SentinelOne EDR, managed" },
        { label: "Email security", value: "Barracuda anti-spam" },
        { label: "Multi-factor authentication", value: "Duo or Okta" },
        { label: "Security awareness", value: "KnowBe4 and BullPhish" },
        { label: "Credential vaults", value: "Keeper and Bitwarden" },
        { label: "Backup and recovery", value: "Veeam, checked daily" },
      ],
      id: "v_0000b004",
      after: 1,
      cites: [
        factId("tooling.edr"),
        factId("tooling.email-security"),
        factId("tooling.mfa"),
        factId("tooling.security-awareness"),
        factId("tooling.credential-vaults"),
        factId("tooling.backup-dr"),
      ],
      generatedBy: "llm",
    },
    onboardingSteps: {
      kind: "timeline",
      steps: [
        { label: "Before day one", title: "Meet and greet", body: "Leadership interview, the alignment plan agreed, credential collection begins." },
        { label: "Onboarding day", title: "Credentials and agents", body: "Credentials validated and rotated, agents deployed on servers, fresh backups taken." },
        { label: "First 30 days", title: "Documented and monitored", body: "Documentation reaches roughly 95%, agents on every workstation, the first audit day." },
        { label: "Days 31 to 90", title: "Gaps closed", body: "Best-practice gaps close and the first Quarterly Technology Meeting is held." },
      ],
      id: "v_0000b005",
      after: 1,
      cites: [
        factId("onboarding.pre-onboarding"),
        factId("onboarding.onboarding-day"),
        factId("onboarding.first-30-days"),
        factId("onboarding.days-31-90"),
      ],
      generatedBy: "llm",
    },
  };
}

/** The round-32 sections: narrative titles (brief-mode adoption), the letter
 *  record carrying a stored thesis. The letter ends on a standalone closing
 *  line, so the render shows the system pricing paragraph placed BEFORE the
 *  last drafted paragraph (furniture.ts pricingParagraphIndex), as the
 *  reference runs context, why-us, pricing, then the close. */
export function r32Sections(): FixtureSection[] {
  const b = r32Blocks();
  const at = FIXTURE_UPDATED_AT;
  return [
    {
      label: "__letter",
      title: "Cover Letter",
      paragraphs: [
        `Thank you for the opportunity to propose managed IT services for ${R32_CLIENT}. A design studio runs on its applications and its project files, and when either stops working on a deadline day the cost is design time. This proposal is built around keeping them working.`,
        "XL.net is a flat-fee managed IT provider with a live service desk staffed around the clock by its own engineers, never an outsourced call center. Because the fee does not change with ticket volume, preventing problems serves both of us.",
        "Onboarding begins with a meet and greet, followed by a scheduled onboarding day, and XL.net becomes accountable for support as soon as it holds valid credentials.",
        "We look forward to discussing this with you.",
      ],
      cites: [factId("service.flat-fee"), factId("operations.service-desk-hours"), factId("onboarding.sequence")],
      gaps: [],
      generatedBy: "llm",
      updatedAt: at,
      thesis: R32_THESIS,
    },
    {
      label: "1",
      title: "Service Desk and Escalation",
      paragraphs: [
        "The service desk is live around the clock, staffed in shifts by XL.net's own engineers rather than an on-call rotation.",
        "Every issue follows a defined escalation path, so nothing waits on a single person.",
        "Your account also has named people who own it.",
      ],
      cites: [factId("operations.service-desk-hours"), factId("operations.escalation-tiers"), factId("operations.named-roles")],
      gaps: [],
      generatedBy: "llm",
      updatedAt: at,
      blocks: [b.escalation, b.criticalCallout, b.roles],
    },
    {
      label: "2",
      title: "Security Included in the Flat Fee",
      paragraphs: [
        "Security tooling is part of the monthly fee, not an add-on, and every layer below is managed by XL.net.",
        "Backups are set up during onboarding and checked daily.",
      ],
      cites: [factId("service.flat-fee"), factId("tooling.backup-dr")],
      gaps: [],
      generatedBy: "llm",
      updatedAt: at,
      blocks: [b.securityLedger],
    },
    {
      label: "3",
      title: "The Onboarding Timeline",
      paragraphs: [
        "Onboarding is run by a dedicated team rather than squeezed in around support work.",
        "Designers keep working in the same applications throughout.",
      ],
      cites: [factId("onboarding.sequence")],
      gaps: [],
      generatedBy: "llm",
      updatedAt: at,
      blocks: [b.onboardingSteps],
    },
  ];
}

/** The round-32 gate input: a brief, a stored contact, address and headline,
 *  the reference's 60 users with onboarding priced by the engine. */
export function buildR32GateInput(over: Partial<DraftGateInput> = {}): DraftGateInput {
  const base = buildFixtureGateInput(r32Sections());
  const structure = [
    { label: "1", title: "Service Desk and Escalation" },
    { label: "2", title: "Security Included in the Flat Fee" },
    { label: "3", title: "The Onboarding Timeline" },
  ];
  const built = buildQuote(
    RATE_CARD,
    {
      ...EMPTY_QUOTE_INPUTS,
      fullyManagedUsers: 60,
      securePlusComputers: 0,
      dattoRetention: "none",
      vulnScanSessionsPerYear: 0,
      includeOnboarding: true,
    },
    R32_PROPOSAL_ID
  );
  return {
    ...base,
    doc: {
      ...base.doc,
      id: R32_DOC_ID,
      title: `${R32_CLIENT} brief`,
      clientName: R32_CLIENT,
      intakeForm: "brief",
      structureJson: JSON.stringify(structure),
      statedStaffCount: 60,
      contactName: R32_CONTACT.name,
      contactTitle: R32_CONTACT.title,
      clientAddress: R32_ADDRESS.join("\n"),
      proposalHeadline: R32_HEADLINE,
    },
    proposal: {
      ...base.proposal,
      id: R32_PROPOSAL_ID,
      documentId: R32_DOC_ID,
      sectionsJson: JSON.stringify(r32Sections()),
      pricingJson: JSON.stringify(built.quote),
    },
    structure,
    requirements: structure.map((n, i) => ({
      ...base.requirements[0],
      id: `00000000-0000-4000-8000-${String(900 + i).padStart(12, "0")}`,
      documentId: R32_DOC_ID,
      structureLabel: n.label,
      text: `Describe ${n.title.toLowerCase()}.`,
      ordinal: i,
    })),
    quote: built.quote,
    ...over,
  };
}

async function renderOne(outdir: string, input: DraftGateInput, json: string): Promise<void> {
  const gate = runDraftGate(input);
  console.log(formatGateResult(gate));
  const { resolved } = resolveDraft(input);
  const view = buildExportView(resolved, input.rateCard);
  const pdfName = exportFileName(view, "pdf");
  const docxName = exportFileName(view, "docx");
  fs.writeFileSync(path.join(outdir, pdfName), await renderRfpPdf(view));
  fs.writeFileSync(path.join(outdir, docxName), await renderRfpDocx(view));
  fs.writeFileSync(path.join(outdir, json), JSON.stringify(resolved, null, 2));
  console.log(`\nwrote ${path.join(outdir, pdfName)}\nwrote ${path.join(outdir, docxName)}\n`);
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

  // The visual-blocks fixture (an RFP), exactly as before, then the
  // round-32 brief beside it: the CoWork side-by-side document.
  await renderOne(outdir, buildFixtureGateInput(), "resolved.json");
  await renderOne(outdir, buildR32GateInput(), "resolved-r32.json");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
