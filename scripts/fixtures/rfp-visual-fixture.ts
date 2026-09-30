/**
 * One invented-client proposal carrying every v1 visual block kind (ARCHITECTURE.md §5.17).
 *
 * Shared by the draft-blocks tests, the visual gate tests and `npm run rfp:render-fixture`, so the
 * screen, the gate and both exporters are all exercised against the SAME records. The client is
 * made up (never a real client's name or RFP text in the repo); XL.net's own facts come from the
 * seed corpus, which is what the grounding checks read.
 *
 * What it deliberately contains: a 14-row table (long enough to cross a page, so the pdf emitter's
 * row-by-row pagination and repeated header are exercised), two blocks at one anchor, a block
 * after the last paragraph, a legacy prose-only record with NO `blocks` key, the letter record,
 * and a closing References section carrying a two-entry `references` block (invented contacts,
 * never a real client's) whose opening paragraph states rule D3's etiquette sentence.
 */

import type { DraftSectionRecord } from "../../src/app/api/rfp/documents/[id]/generate/route";
import {
  buildAboutBlocks,
  buildOnboardingTimeline,
  buildServiceStatsBlock,
  type DraftBlock,
  type GroundFact,
} from "../../src/lib/rfp/draft-blocks";
import {
  applyReferencesAnswer,
  referencesOtherText,
} from "../../src/lib/rfp/references-answer";
import { ALL_FACTS } from "../../src/lib/rfp/seed/facts";

/** DraftSectionRecord as it will be once the route type gains the optional key. */
export type FixtureSection = DraftSectionRecord & { blocks?: DraftBlock[] };

export const FIXTURE_CLIENT = "Larkmoor Valley Housing Cooperative";
export const FIXTURE_UPDATED_AT = "2026-09-30T15:00:00.000Z";

/** The live seed corpus in the shape the drafter and the builders are handed. */
export const facts: GroundFact[] = ALL_FACTS.filter((f) => f.retiredInKb === null).map((f) => ({
  id: f.id,
  key: f.key,
  statement: f.statement,
  detail: f.detail,
  polarity: f.polarity,
}));

const id = (key: string): string => {
  const f = facts.find((x) => x.key === key);
  if (!f) throw new Error(`fixture: no live seed fact for ${key}`);
  return f.id;
};

/** Builders mint random ids; the fixture pins them so rendered output is comparable run to run. */
function pinned<T extends DraftBlock | null>(block: T, blockId: string, after: number): NonNullable<T> {
  if (!block) throw new Error(`fixture: builder returned nothing for ${blockId}`);
  return { ...block, id: blockId, after } as NonNullable<T>;
}

const about = buildAboutBlocks(facts);
if (about.length !== 2) throw new Error("fixture: expected a fact grid and a badge strip");

export const structure: { label: string; title: string }[] = [
  { label: "1.", title: "Overview" },
  { label: "2.", title: "Scope of Services" },
  { label: "3.", title: "Service Levels and Support" },
  { label: "4.", title: "Vendor Qualifications" },
  { label: "5.", title: "Contract and Pricing" },
  { label: "6.", title: "Transition Plan" },
  { label: "7.", title: "References" },
];

export const requirements: { structureLabel: string; text: string }[] = [
  { structureLabel: "1.", text: "Summarize your understanding of the Cooperative's needs." },
  { structureLabel: "2.", text: "Describe the tools and platforms used to deliver each managed service." },
  { structureLabel: "2.", text: "Describe how onsite support is provided." },
  { structureLabel: "3.", text: "State your response and resolution targets by priority." },
  { structureLabel: "3.", text: "Describe service desk hours and how calls are answered." },
  { structureLabel: "4.", text: "Provide a description of your business, including years in operation and staff size." },
  { structureLabel: "4.", text: "List certifications and insurance coverage held by the vendor." },
  { structureLabel: "5.", text: "Describe the contract term and termination provisions." },
  { structureLabel: "6.", text: "Describe your onboarding approach and timeline." },
  { structureLabel: "7.", text: "Provide two client references of comparable size." },
];

const serviceMatrix: DraftBlock = {
  kind: "table",
  caption: "How each service is delivered",
  columns: [
    { header: "Service", align: "left" },
    { header: "Platform", align: "left" },
    { header: "What is included", align: "left" },
  ],
  rows: [
    ["Service desk", "In-house staff", "A true 24/7/365 live service desk with staffed shifts and no on-call rotation."],
    ["Monitoring and management", "Kaseya", "Remote monitoring and IT management across servers and workstations."],
    ["Ticketing", "Autotask", "Every request is tracked as a ticket from report to resolution."],
    ["Endpoint protection", "SentinelOne", "Managed endpoint EDR on every supported computer."],
    ["Multi-factor authentication", "Duo or Okta", "Across Microsoft 365, Google Workspace, and remote access, depending on client needs."],
    ["Email security", "Barracuda", "Email security and anti-spam filtering."],
    ["Security awareness", "KnowBe4 and BullPhish", "Training and phishing simulation, included in the base fee with no per-user add-on."],
    ["Microsoft 365 backup", "Datto SaaS Protection", "Exchange Online, OneDrive, SharePoint, and Teams. Restores are handled as a normal ticket, with no per-restore fee."],
    ["Backup and disaster recovery", "Veeam", "Backups are set up during onboarding and checked daily, with disaster recovery through Veeam Cloud Connect."],
    ["Credential management", "Keeper and Bitwarden", "Encrypted vaults with least-privilege role-based access."],
    ["Process and documentation", "SweetProcess", "Follow an SOP, or author one the first time if none exists."],
    ["Cloud administration", "Microsoft 365 and Google Workspace", "Provisioning and deprovisioning, security and permission settings, license administration, and periodic unused-license reviews."],
    ["Azure", "Azure subscriptions", "The monthly System Analyst audit reviews Azure cost and right-sizing."],
    ["AI governance", "Microsoft Copilot and Purview", "Copilot, Purview, DLP, and AI governance are deployed and managed."],
  ],
  emphasizeLastRow: false,
  id: "v_0000a001",
  after: 1,
  cites: [
    id("operations.service-desk-hours"),
    id("tooling.rmm"),
    id("tooling.psa"),
    id("tooling.edr"),
    id("tooling.mfa"),
    id("tooling.email-security"),
    id("tooling.security-awareness"),
    id("tooling.m365-backup"),
    id("tooling.backup-dr"),
    id("tooling.credential-vaults"),
    id("tooling.process-governance"),
    id("tooling.cloud-administration"),
    id("tooling.azure"),
    id("capability.ai-governance"),
  ],
  generatedBy: "llm",
};

const onsiteCards: DraftBlock = {
  kind: "cards",
  cards: [
    {
      title: "Reactive onsite visits",
      body: "Onsite visits to resolve reactive issues are included in the flat fee, with no hourly charge.",
    },
    {
      title: "Moves, adds and project work",
      body: "Onsite work for moves, adds and changes, or for project work, is charged separately through a fixed-fee Statement of Work.",
    },
  ],
  id: "v_0000a002",
  after: 2,
  cites: [id("onsite.billing")],
  generatedBy: "llm",
};

const slaTable: DraftBlock = {
  kind: "table",
  caption: "Suggested service level targets",
  columns: [
    { header: "Priority", align: "left" },
    { header: "Response", align: "left" },
    { header: "Target resolution", align: "left" },
  ],
  rows: [
    ["P1 Critical", "15 minutes", "4 hours"],
    ["P2 High", "1 hour", "8 business hours"],
    ["P3 Medium", "4 business hours", "2 business days"],
    ["P4 Low or Request", "8 business hours", "5 business days"],
  ],
  emphasizeLastRow: false,
  id: "v_0000a004",
  after: 1,
  cites: [id("operations.sla-targets")],
  generatedBy: "llm",
};

const overviewCallout: DraftBlock = {
  kind: "callout",
  title: "No lock-in",
  body: "The agreement is a revolving 90-day term, so we have to keep earning it, quarter after quarter.",
  tone: "emphasis",
  id: "v_0000a005",
  after: 2,
  cites: [id("contract.term"), id("contract.no-lock-in-wording")],
  generatedBy: "llm",
};

const transitionCallout: DraftBlock = {
  kind: "callout",
  title: null,
  body: "XL.net becomes accountable for support as soon as it holds valid credentials.",
  tone: "neutral",
  id: "v_0000a008",
  after: 2,
  cites: [id("onboarding.sequence")],
  generatedBy: "llm",
};

/**
 * Two invented references (organizations, people and contact details are made up; the phone
 * numbers sit in the 555-01xx fiction range and the emails on example.org). Stored exactly as the
 * references route lands the answer: no cites, generatedBy "system", origin "references", closing
 * the section.
 */
export const referencesBlock: DraftBlock = {
  kind: "references",
  references: [
    {
      referenceId: null,
      organization: "Northwind Clinic",
      relevance: "Healthcare, multi-site",
      contactName: "Alex Rivera",
      contactTitle: "COO",
      phone: "312-555-0142",
      email: "a.rivera@example.org",
    },
    {
      referenceId: "ref_fixture_harbor",
      organization: "Harborlight Credit Union",
      relevance: "Financial services, regulated",
      contactName: "Priya Natarajan",
      contactTitle: "VP Operations",
      phone: "",
      email: "p.natarajan@example.org",
    },
  ],
  id: "v_0000a010",
  after: 1,
  cites: [],
  generatedBy: "system",
  origin: "references",
};

const base = (): Pick<DraftSectionRecord, "gaps" | "updatedAt"> => ({ gaps: [], updatedAt: FIXTURE_UPDATED_AT });

export const letter: FixtureSection = {
  ...base(),
  label: "__letter",
  title: "Cover Letter",
  paragraphs: [
    `Thank you for the opportunity to respond to the ${FIXTURE_CLIENT} request for managed IT services.`,
    "XL.net serves organizations of 15 to 250 employees, and the Cooperative sits squarely inside that range.",
    "The pages that follow answer each section of your request in your own order.",
  ],
  cites: [id("company.client-size-range")],
  generatedBy: "llm",
};

const draftedSections: FixtureSection[] = [
  letter,
  {
    ...base(),
    label: "1.",
    title: "Overview",
    paragraphs: [
      `${FIXTURE_CLIENT} is asking for one accountable partner for day-to-day support, security and planning.`,
      "XL.net sells flat-fee, all-inclusive managed IT, delivered by in-house help desk and engineering staff rather than an outsourced call center.",
    ],
    cites: [id("service.flat-fee"), id("company.in-house-staff")],
    generatedBy: "llm",
    blocks: [overviewCallout],
  },
  {
    ...base(),
    label: "2.",
    title: "Scope of Services",
    paragraphs: [
      "Every service in scope is delivered on a named platform that XL.net runs across its client base.",
      "The table below sets out each service, the platform behind it and what is included.",
      "Onsite support follows two simple rules.",
    ],
    cites: [id("tooling.rmm"), id("tooling.psa"), id("onsite.billing")],
    generatedBy: "llm",
    blocks: [serviceMatrix, onsiteCards],
  },
  {
    ...base(),
    label: "3.",
    title: "Service Levels and Support",
    paragraphs: [
      "The service desk is staffed around the clock by XL.net's own engineers.",
      "Clients may write their preferred SLA language into the agreement, and the targets below are the suggested starting point.",
    ],
    cites: [id("operations.service-desk-hours"), id("contract.sla-client-defined"), id("operations.sla-targets")],
    generatedBy: "llm",
    // Two blocks at one anchor keep this order; the tiles open the section.
    blocks: [pinned(buildServiceStatsBlock(facts), "v_0000a003", 0), slaTable],
  },
  {
    ...base(),
    label: "4.",
    title: "Vendor Qualifications",
    paragraphs: [
      "XL.net Inc. is a managed IT services provider whose founder and CEO is Adam Radulovic.",
      "The differentiator is a proprietary monthly audit and alignment process, reviewed with leadership at Quarterly Technology Meetings.",
    ],
    cites: [id("company.identity"), id("capability.tap-alignment")],
    generatedBy: "llm",
    blocks: [pinned(about[0], "v_0000a006", 0), pinned(about[1], "v_0000a007", 0)],
  },
  // Legacy shape: prose only, no `blocks` key at all. Must flow and export exactly as before.
  {
    ...base(),
    label: "5.",
    title: "Contract and Pricing",
    paragraphs: [
      "The agreement is a revolving 90-day term, and terminating it always requires 90 days' written notice, at any point.",
      "XL.net offers no discounted multi-year alternative. Pricing is set out in the quote that accompanies this proposal.",
    ],
    cites: [id("contract.term"), id("contract.multi-year")],
    generatedBy: "human",
  },
  {
    ...base(),
    label: "6.",
    title: "Transition Plan",
    paragraphs: [
      "Onboarding begins with a meet and greet, and the scheduled onboarding day follows roughly 10 to 14 days after that.",
      "On the onboarding day, credentials are validated and rotated, agents are deployed on servers, and fresh backups are taken.",
    ],
    cites: [id("onboarding.sequence"), id("onboarding.onboarding-day")],
    generatedBy: "llm",
    blocks: [transitionCallout],
  },
];

/**
 * The References section EXACTLY as the references route lands the answer: the drafter left the
 * section empty (generatedBy "llm", no cites, no paragraphs) and applyReferencesAnswer, the
 * function the route calls, composed the intro with rule D3's etiquette sentence, appended the
 * block and made the record human-authored (its only prose is the system-written intro, so rule
 * A5 has nothing to demand cites of). Nothing here is hand-stamped; only the block id is pinned,
 * since the builder mints a random one.
 */
const referencesDrafted: FixtureSection = {
  ...base(),
  label: "7.",
  title: "References",
  paragraphs: [],
  cites: [],
  generatedBy: "llm",
};
const referencesAnswered = applyReferencesAnswer(
  referencesDrafted,
  referencesOtherText(`${FIXTURE_CLIENT} RFP`, draftedSections, -1, referencesDrafted),
  referencesBlock.kind === "references" ? referencesBlock.references : [],
  { now: FIXTURE_UPDATED_AT }
).section;

export const sections: FixtureSection[] = [
  ...draftedSections,
  {
    ...referencesAnswered,
    blocks: (referencesAnswered.blocks ?? []).map((b) =>
      b.origin === "references" ? { ...b, id: referencesBlock.id } : b
    ),
  },
];

/** The stretch kind, kept OUT of `sections` so a v1 renderer is never handed it by the fixture. */
export const stretchTimelineBlock: DraftBlock = pinned(buildOnboardingTimeline(facts), "v_0000a009", 0);
