/**
 * The initial Fact corpus, transcribed from source-skill/references/xlnet-profile.md.
 *
 * BUILD-PLAN.md: "that file is the entire initial Fact corpus and it is worth transcribing
 * carefully rather than quickly, because everything downstream asserts against it."
 *
 * The seed carries REAL HISTORY rather than a clean snapshot. Five facts were wrong before July
 * 2026 and were corrected after the CHF proposal shipped on July 21. Both versions are seeded: the
 * wrong one at KB v1 (retired), the corrected one at KB v2 with `correctedAt` and `supersedes`.
 *
 * That is not decoration. The CHF proposal was drafted against KB v1 and cites the wrong facts, so
 * the C1 staleness sweep has a true positive to find on day one, and the gate has the document it
 * is supposed to reject. A clean seed would make both of them untestable.
 */

import type { Fact, FactCategory } from "@/lib/rfp/content-model";

/** Initial corpus. */
export const KB_V1_SEQ = 1;
export const KB_V1_AT = new Date("2026-07-01T00:00:00.000Z");

/** Corrections from the CyberSearch review, three days after CHF shipped. */
export const KB_V2_SEQ = 2;
export const KB_V2_AT = new Date("2026-07-24T00:00:00.000Z");

type FactSeed = {
  key: string;
  category: FactCategory;
  statement: string;
  polarity?: "affirmative" | "negative";
  detail?: string;
  sourceUrl?: string;
  verifiedAt?: Date;
  confidence?: "confirmed" | "needs-adam";
};

function fact(seed: FactSeed): Fact {
  return {
    id: `fact_${seed.key.replace(/[^a-z0-9]+/gi, "_")}_v${KB_V1_SEQ}`,
    key: seed.key,
    category: seed.category,
    statement: seed.statement,
    polarity: seed.polarity ?? "affirmative",
    detail: seed.detail ?? null,
    sourceUrl: seed.sourceUrl ?? null,
    verifiedAt: seed.verifiedAt ?? null,
    correctedAt: null,
    supersedes: null,
    introducedInKb: KB_V1_SEQ,
    retiredInKb: null,
    confidence: seed.confidence ?? "confirmed",
  };
}

// ---------------------------------------------------------------------------
// The five facts that were WRONG until 24 July 2026.
//
// These are seeded as retired v1 records. Everything drafted against KB v1 — including the CHF
// proposal — cites these, which is exactly why the CHF proposal fails rules A1 and A2.
// ---------------------------------------------------------------------------

type CorrectionSeed = {
  key: string;
  category: FactCategory;
  /** What the profile said before the correction, and what earlier proposals repeated. */
  wrongStatement: string;
  /** What is actually true. */
  statement: string;
  polarity?: "affirmative" | "negative";
  detail?: string;
};

const CORRECTIONS: CorrectionSeed[] = [
  {
    key: "contract.term",
    category: "commercial",
    wrongStatement:
      "The agreement is month-to-month, terminable with 30 days' written notice.",
    statement:
      "The agreement is a revolving 90-day term. Terminating it always requires 90 days' written notice, at any point.",
    detail:
      "It is NOT month-to-month, and it never was. Earlier proposals wrongly said \"month-to-month\" and \"30 days' notice\"; both are wrong. When this was corrected the phrase was found in six places in one document: the terms table, a reference blurb, a pull quote, the differentiator answer, and two body paragraphs. The no-lock-in argument still works, but the wording is \"we have to keep earning it, quarter after quarter,\" not \"every month.\"",
  },
  {
    key: "onboarding.sequence",
    category: "operations",
    wrongStatement:
      "Day 1 cutover: passwords are rotated and support goes live the same day the incumbent is notified, with a zero-gap takeover.",
    statement:
      "Onboarding begins with a meet and greet. The scheduled onboarding day follows roughly 10 to 14 days after that. XL.net becomes accountable for support as soon as it holds valid credentials.",
    detail:
      "Do NOT write \"Day 1 cutover, passwords rotated, support live\" as though service starts the instant passwords change, and do NOT promise same-day takeover from the incumbent. Both were in earlier drafts and Adam corrected them. The CHF proposal shipped with a \"Zero-gap cutover\" callout promising takeover \"the same day we are notified,\" which is not what the company does.",
  },
  {
    key: "operations.service-desk-location",
    category: "operations",
    wrongStatement:
      "All XL.net employees are U.S.-based. Nothing is offshored or nearshored; the service desk is entirely domestic.",
    statement:
      "Business hours are covered from the United States. After-hours coverage is split between XL.net teams in the Philippines and Serbia, deliberately, so that every shift is worked during that team's own daylight hours.",
    detail:
      "NEVER claim that all XL.net employees are U.S.-based, or that nothing is offshored or nearshored. That is not true and Adam has flagged it specifically. The honest framing is a strength: a client calling at 3am Chicago time reaches an engineer who is mid-workday and alert, rather than someone woken by a pager or four hours into a night shift. It is XL.net's own staff on staffed shifts throughout, never an outsourced call center. State the tradeoff rather than hiding it.",
  },
  {
    key: "onsite.billing",
    category: "commercial",
    wrongStatement:
      "Onsite visits are billed at an hourly onsite rate outside the flat fee.",
    statement:
      "Onsite visits to resolve reactive issues are included in the flat fee, with no hourly charge. Onsite work for moves, adds and changes, or for project work, is charged separately through a fixed-fee Statement of Work, not as a separate hourly or per-visit onsite charge.",
    detail:
      "Both halves must appear together whenever onsite is mentioned. Including one without the other has shipped before and reads as a promise the company will not keep.",
  },
  {
    key: "compliance.cis-controls",
    category: "compliance",
    wrongStatement:
      "Client environments are audited against the full CIS 20 Controls.",
    statement:
      "Client environments are audited against a subset of the CIS Controls (v8), not the full set, and not the retired \"CIS 20.\"",
    detail:
      "Adam corrected this wording in July 2026: write \"a subset of CIS Controls v8\" wherever the monthly audit is described. Typical subset items: conditional access, MFA coverage, sharing and external access settings, admin role assignment, tenant configuration drift.",
  },
];

/** The wrong versions, retired at KB v2 but kept so a sent proposal's citations stay resolvable. */
export const RETIRED_FACTS: Fact[] = CORRECTIONS.map((c) => ({
  id: `fact_${c.key.replace(/[^a-z0-9]+/gi, "_")}_v${KB_V1_SEQ}`,
  key: c.key,
  category: c.category,
  statement: c.wrongStatement,
  polarity: "affirmative",
  detail: "Superseded 24 July 2026. Retained for audit; never cite this in a new draft.",
  sourceUrl: null,
  verifiedAt: null,
  correctedAt: null,
  supersedes: null,
  introducedInKb: KB_V1_SEQ,
  retiredInKb: KB_V2_SEQ,
  confidence: "confirmed",
}));

/** The corrected versions. These are what a draft written today must cite. */
export const CORRECTED_FACTS: Fact[] = CORRECTIONS.map((c) => ({
  id: `fact_${c.key.replace(/[^a-z0-9]+/gi, "_")}_v${KB_V2_SEQ}`,
  key: c.key,
  category: c.category,
  statement: c.statement,
  polarity: c.polarity ?? "affirmative",
  detail: c.detail ?? null,
  sourceUrl: null,
  verifiedAt: null,
  correctedAt: KB_V2_AT,
  supersedes: `fact_${c.key.replace(/[^a-z0-9]+/gi, "_")}_v${KB_V1_SEQ}`,
  introducedInKb: KB_V2_SEQ,
  retiredInKb: null,
  confidence: "confirmed",
}));

// ---------------------------------------------------------------------------
// Everything that was right the first time.
// ---------------------------------------------------------------------------

export const STABLE_FACTS: Fact[] = [
  // --- Company -----------------------------------------------------------
  fact({
    key: "company.identity",
    category: "firmography",
    statement:
      "XL.net Inc. is a managed IT services provider (MSP). Its founder and CEO is Adam Radulovic.",
  }),
  fact({
    key: "company.founded",
    category: "firmography",
    statement: "XL.net was founded in 2009 and is headquartered in the Chicago metropolitan area, Illinois.",
  }),
  fact({
    key: "company.proposal-address",
    category: "firmography",
    statement: "The proposal address is 1 E Erie Street, Suite 525 #244, Chicago, IL 60611.",
    detail:
      "The website also lists Naperville, Schaumburg, Arlington Heights, Rockford, and Milwaukee; BBB lists Park Ridge. Several read as suite or mailbox numbers. Use the Chicago address unless Adam says otherwise.",
  }),
  fact({
    key: "company.headcount",
    category: "firmography",
    statement: "XL.net has 47 full-time employees.",
  }),
  fact({
    key: "company.onsite-network",
    category: "operations",
    statement:
      "XL.net uses Field Nation as its national onsite \"hands\" network of vetted technicians, roughly 20,000 nationwide, for unplanned and emergency onsite work. For scheduled project work, XL.net employees are deployed nationally.",
  }),
  fact({
    key: "company.in-house-staff",
    category: "operations",
    statement:
      "Help desk and engineering are in-house staff, not an outsourced call center.",
  }),
  fact({
    key: "company.client-size-range",
    category: "firmography",
    statement: "XL.net serves organizations of 15 to 250 employees.",
    detail:
      "A prospect at the edge of this range should see it named in the cover letter rather than discovering it at reference check (rule D4).",
  }),
  fact({
    key: "company.multi-site-clients",
    category: "firmography",
    statement:
      "More than 14% of XL.net clients run two or more locations that XL.net supports.",
  }),
  fact({
    key: "company.primary-contact",
    category: "firmography",
    statement:
      "The primary contact for proposals is Adam Radulovic, adam@xl.net, 773-425-9686. The main office line is 847.242.1299 and the fax is 847.686.0201.",
  }),

  // --- Book of business --------------------------------------------------
  fact({
    key: "book.active-clients",
    category: "firmography",
    statement: "XL.net has 73 active client accounts.",
    detail: "From the July 2026 customer-list export. Recompute if a fresher export exists.",
  }),
  fact({
    key: "book.retention",
    category: "firmography",
    statement: "XL.net's client retention rate is 92%.",
  }),
  fact({
    key: "book.tenure",
    category: "firmography",
    statement:
      "Average client tenure is 4.8 years and median tenure is 3.0 years. 50% of clients are at three or more years and 34% are at five or more.",
  }),
  fact({
    key: "book.longest-client",
    category: "firmography",
    statement:
      "The longest-standing client is Tri Star Engineering, a client since February 2010, at 16.5 years.",
  }),
  fact({
    key: "book.median-client-size",
    category: "firmography",
    statement:
      "The median XL.net client is 18 users. 49 of 73 clients run between 15 and 30 users.",
  }),
  fact({
    key: "book.illinois-clients",
    category: "firmography",
    statement: "69 of XL.net's 73 clients are Illinois-based.",
  }),
  fact({
    key: "book.first-contact-resolution",
    category: "operations",
    statement: "First-contact resolution is above 70%.",
    detail:
      "Keep this distinct from \"99% of calls answered live\" and \"99.9% resolved remotely.\" Evaluators know the difference and blurring them reads evasive.",
  }),

  // --- Certifications and insurance --------------------------------------
  fact({
    key: "compliance.iso-27001",
    category: "compliance",
    statement:
      "XL.net holds ISO 27001:2022, and is one of the few IT firms in the Midwest to hold it.",
  }),
  fact({
    key: "compliance.soc-2",
    category: "compliance",
    statement: "XL.net holds SOC 2 Type 2, audited annually.",
  }),
  fact({
    key: "compliance.cmmc",
    category: "compliance",
    statement: "XL.net holds CMMC Level 1.",
  }),
  fact({
    key: "compliance.cyber-insurance",
    category: "compliance",
    statement:
      "XL.net carries $2,000,000 in cyber liability through Beazley MediaTech. The product covers technology errors and omissions alongside cyber liability, so describe it that way rather than as cyber-only. Certificates of insurance are available on request.",
  }),
  fact({
    key: "compliance.partner-tiers",
    category: "compliance",
    polarity: "negative",
    statement:
      "XL.net holds no strategic-partnership tier levels on file, with Microsoft, SentinelOne, or anyone else.",
    detail:
      "Do NOT write \"Gold Partner\" or similar unless a fact record confirms a specific tier. None currently does.",
  }),

  // --- Service model -----------------------------------------------------
  fact({
    key: "service.flat-fee",
    category: "commercial",
    statement: "XL.net sells flat-fee, all-inclusive managed IT.",
  }),
  fact({
    key: "contract.no-lock-in-wording",
    category: "commercial",
    statement:
      "The no-lock-in argument is phrased \"we have to keep earning it, quarter after quarter.\"",
    detail: "Not \"every month\": that wording belongs to the superseded month-to-month claim.",
  }),
  fact({
    key: "contract.multi-year",
    category: "commercial",
    polarity: "negative",
    statement: "XL.net offers no discounted multi-year alternative.",
  }),
  fact({
    key: "operations.service-desk-hours",
    category: "operations",
    statement:
      "XL.net runs a true 24/7/365 live service desk with staffed shifts and no on-call rotation. More than 99% of calls are answered live by a human; only two calls in the first half of 2026 were not. Roughly 99.9% of issues are resolved remotely.",
  }),
  fact({
    key: "contract.sla-client-defined",
    category: "commercial",
    statement:
      "Clients may write their preferred SLA language into the agreement. XL.net always lets the client define the criticality of an issue at report time, so a P3 for an executive may be reported as a P1.",
  }),
  fact({
    key: "operations.sla-targets",
    category: "operations",
    statement:
      "Suggested SLA targets, which clients can adjust: P1 Critical 15-minute response and 4-hour target resolution; P2 High 1 hour and 8 business hours; P3 Medium 4 business hours and 2 business days; P4 Low or Request 8 business hours and 5 business days.",
    detail:
      "Resolution targets exclude time waiting on third-party vendors, hardware RMA, or client input.",
  }),
  fact({
    key: "operations.escalation-tiers",
    category: "operations",
    statement:
      "Escalation runs Client Success (first line, roughly 15-minute triage), then Service Desk Engineer (roughly 1 hour), then Service Desk Escalation Engineer (roughly 2 hours), then Service Delivery Manager. Critical issues, and any issue the client flags critical, route straight to the Service Desk Escalation Engineer. An unresolved critical escalates within 1 hour.",
  }),
  fact({
    key: "operations.named-roles",
    category: "operations",
    statement:
      "Each account is assigned a named XLTO (XL.net Technology Officer) who owns strategy and acts as the strategic vendor manager, plus a named System Analyst. The XLTO informs the client in the event of a breach; a Proactive Manager is the designee when the XLTO is out.",
  }),

  // --- Pricing facts (the arithmetic itself lives on the RateCard) --------
  fact({
    key: "pricing.fully-managed-rate",
    category: "commercial",
    statement:
      "Fully managed users are $247 per user per month, covering complete IT, support, security, and alignment.",
  }),
  fact({
    key: "pricing.fully-managed-label",
    category: "commercial",
    statement:
      "When a client asks for a per-service breakdown, the $247 line is labelled \"24/7/365 Service Desk, Central Services, System Alignment, XLTO\" rather than just \"Service Desk.\"",
  }),
  fact({
    key: "pricing.m365-only-rate",
    category: "commercial",
    statement:
      "Users who only need support for Microsoft 365 or Office are $50 per user per month.",
  }),
  fact({
    key: "pricing.no-blended-rate",
    category: "commercial",
    statement:
      "Additional users are $247 per user per month in XL.net fees. Licensing that scales with headcount is billed at cost on a separate line, never blended into a single all-in per-user number.",
    detail: "An earlier draft quoted a blended $275.20 and Adam corrected it.",
  }),
  fact({
    key: "pricing.minimum-users",
    category: "commercial",
    statement:
      "The monthly minimum is 15 fully managed users, billed at exactly $3,705 per month. A prospect below 15 users is still billed the flat $3,705, never a smaller pro-rated figure.",
    detail:
      "State it as an exact number (\"$3,705/month\"), never as \"about\" or \"approximately.\" The CHF proposal quoted a 14-user client the flat $3,705 minimum rather than $3,458 for 14 users.",
  }),
  fact({
    key: "pricing.xl-secure-plus",
    category: "commercial",
    statement:
      "XL Secure+ is optional at $25 per computer per month and includes a SentinelOne Complete license, RocketCyber 24/7/365 SOC/SIEM, Kaseya SIEM, SaaSAlerts, and DNSFilter.",
  }),
  fact({
    key: "pricing.datto-saas-protection",
    category: "commercial",
    statement:
      "Microsoft 365 backup is Datto SaaS Protection, priced separately from the managed fee: $1,200 setup, $3.20 per user per month for 1-year retention or $4.00 per user per month for infinite retention, $2.50 per archive license, and $0.10 per GB per month for SharePoint storage beyond 70GB per user.",
    detail:
      "Offer both retention tiers and let the client pick. Archive licenses are a good upsell for clients with turnover, since they retain a departed employee's mail and files without a full M365 license.",
  }),
  fact({
    key: "pricing.vulnerability-scan",
    category: "commercial",
    statement:
      "A vulnerability scan is $2,500 per scanning and review session, covering internal and external scanning and including a review-and-prioritize remediation meeting.",
    detail:
      "It is per session, so always state a cadence: \"as scheduled,\" or one to two sessions a year for a small client.",
  }),
  fact({
    key: "pricing.onboarding-fee",
    category: "commercial",
    statement:
      "The onboarding cost equals one month of BASE managed service, not one month of the all-in total. It covers the end-to-end technology review, IT runbook creation, backup setup, documentation, and agent and tool deployment.",
  }),
  fact({
    key: "pricing.pass-through",
    category: "commercial",
    statement:
      "Hardware, software and licensing, Microsoft 365 licenses, and third-party vendor support are pass-through. Project work outside scope is quoted in advance via Statement of Work.",
  }),

  // --- Onboarding detail -------------------------------------------------
  fact({
    key: "onboarding.pre-onboarding",
    category: "operations",
    statement:
      "Pre-onboarding: interview leadership at the meet and greet, agree the 12-month Technology Alignment Plan, and begin credential collection.",
  }),
  fact({
    key: "onboarding.onboarding-day",
    category: "operations",
    statement:
      "On the onboarding day, credentials are validated and rotated, agents are deployed on servers, and fresh backups are taken.",
  }),
  fact({
    key: "onboarding.first-30-days",
    category: "operations",
    statement:
      "In the first 30 days, documentation reaches roughly 95%, agents are deployed on all workstations, reactive support and monitoring begin, and the first System Analyst audit day takes place.",
  }),
  fact({
    key: "onboarding.days-31-90",
    category: "operations",
    statement:
      "From day 31 to 90 and beyond, support continues, best-practice gaps close, reactive issues are cut in half, two more System Analyst audit days take place, and the first Quarterly Technology Meeting is held.",
  }),

  // --- Onsite ------------------------------------------------------------
  fact({
    key: "onsite.emergency-target",
    category: "operations",
    statement:
      "For a reactive emergency, an engineer is targeted to arrive onsite within 2 hours.",
    detail: "State it as a target, never as a guarantee.",
  }),
  fact({
    key: "onsite.dispatch",
    category: "operations",
    statement:
      "Onsite dispatch for staff outside the local area is arranged through Field Nation and quoted before dispatch.",
  }),

  // --- Differentiator ----------------------------------------------------
  fact({
    key: "capability.tap-alignment",
    category: "capability",
    statement:
      "XL.net's differentiator is a proprietary, homebuilt monthly audit and alignment process: a Technology Alignment Plan plus a monthly full-day System Analyst audit. It has reduced clients' technology issues and risk by more than 80%, held since 2017. Quarterly Technology Meetings review the plan with leadership.",
    detail:
      "Because the flat fee does not change with ticket volume, reducing problems and risk benefits XL.net and the client equally.",
  }),

  // --- Tooling -----------------------------------------------------------
  fact({
    key: "tooling.rmm",
    category: "tooling",
    statement: "XL.net's RMM and IT management platform is Kaseya.",
  }),
  fact({
    key: "tooling.psa",
    category: "tooling",
    statement: "XL.net's PSA and ticketing platform is Autotask.",
  }),
  fact({
    key: "tooling.edr",
    category: "tooling",
    statement:
      "Endpoint EDR is SentinelOne, managed, with SentinelOne Complete under XL Secure+. XL.net holds more than 2,000 SentinelOne licenses across its client base.",
  }),
  fact({
    key: "tooling.mfa",
    category: "tooling",
    statement:
      "MFA is Duo or Okta depending on client needs, across Microsoft 365, Google Workspace, and remote access.",
  }),
  fact({
    key: "tooling.cloud-administration",
    category: "capability",
    statement:
      "XL.net administers Google Workspace environments and can serve as a client's primary Google Workspace administrator, alongside Microsoft 365 (including 365 Nonprofit), Zoom and Zoom Phone, Monday.com, Adobe, DocuSign, and other SaaS applications. This includes provisioning and deprovisioning, security and permission settings, license administration, and periodic unused-license reviews.",
  }),
  fact({
    key: "tooling.google-workspace-tenure",
    category: "capability",
    statement:
      "XL.net has administered Google Workspace environments for over 10 years.",
    detail:
      "Use this when a prospect specifically runs Google Workspace rather than Microsoft 365, to answer the \"how long have you supported this platform\" question directly.",
  }),
  fact({
    key: "tooling.azure",
    category: "capability",
    statement:
      "XL.net manages client Azure subscriptions. The monthly System Analyst audit reviews Azure cost and right-sizing, so consumption creep is caught in the month it starts.",
  }),
  fact({
    key: "tooling.m365-backup",
    category: "tooling",
    statement:
      "Microsoft 365 backup is Datto SaaS Protection, covering Exchange Online, OneDrive, SharePoint, and Teams. Restores are handled by the service desk as a normal ticket, with no per-restore fee.",
  }),
  fact({
    key: "tooling.security-awareness",
    category: "tooling",
    statement:
      "Security awareness and phishing simulation use KnowBe4 and BullPhish, included in the base fee with no per-user add-on.",
  }),
  fact({
    key: "tooling.email-security",
    category: "tooling",
    statement: "Email security and anti-spam is Barracuda.",
  }),
  fact({
    key: "tooling.credential-vaults",
    category: "tooling",
    statement:
      "Credential vaults are Keeper and Bitwarden, encrypted, with least-privilege role-based access.",
  }),
  fact({
    key: "tooling.process-governance",
    category: "tooling",
    statement:
      "Process and governance run on SweetProcess. Documentation is governed by the \"Documentation Commandments\": follow an SOP, or author one the first time if none exists.",
  }),
  fact({
    key: "tooling.backup-dr",
    category: "tooling",
    statement:
      "Infrastructure backup and disaster recovery use Veeam, plus XL.net's own data center for disaster recovery via Veeam Cloud Connect. Backups are set up during onboarding and checked daily.",
  }),
  fact({
    key: "tooling.microsoft-sentinel",
    category: "capability",
    statement:
      "XL.net can administer Microsoft Sentinel, covering log collection, alert tuning, incident management, and reporting, and includes it at no additional monthly fee for XL Secure+ clients, with Azure log ingestion passed through at cost.",
    detail:
      "Adam's position is to recommend XL Secure+ as the primary SIEM/SOC because it is what XL.net has run for years across thousands of endpoints. Say this plainly rather than just agreeing to Sentinel.",
  }),
  fact({
    key: "tooling.sentinelone-vs-sentinel",
    category: "tooling",
    statement:
      "SentinelOne and Microsoft Sentinel are different products with confusingly similar names: SentinelOne is the endpoint EDR/XDR agent, Microsoft Sentinel is the cloud SIEM.",
    detail:
      "Adam's own answers sometimes conflate them. When an RFP asks for SIEM management and mentions Sentinel, spell the distinction out in the proposal; it protects against a competitor muddying it later.",
  }),
  fact({
    key: "capability.ai-governance",
    category: "capability",
    statement:
      "Microsoft Copilot, Purview, DLP, and AI governance are all deployed and managed. XL.net built a free self-service tool at https://ai.xl.net/governance that walks an organization through producing its own AI acceptable use policy in under fifteen minutes; it requires authentication.",
    detail: "Name it. It is a concrete, checkable differentiator, and Adam demos it on sales calls.",
    sourceUrl: "https://ai.xl.net/governance",
  }),

  // --- Services NOT offered ----------------------------------------------
  fact({
    key: "capability.dark-web-monitoring",
    category: "capability",
    polarity: "negative",
    statement: "XL.net does not offer dark web monitoring.",
    detail:
      "XL.net used to sell it and stopped, deliberately. The reasoning is worth writing out because it lands well: essentially every domain shows credential exposure every month, the report is always positive, and the recommended action is the same regardless of what it found (enforce MFA, rotate the credential). Once the answer never changes, the monitoring is not informing a decision, it is producing a document. The money goes into the control instead: enforced MFA, conditional access, credential rotation, and SaaSAlerts watching for a credential being used rather than merely listed. XL.net will source and manage it at cost if a client requires it for a contract or insurance question, without claiming it protects them.",
  }),
  fact({
    key: "capability.sharepoint-power-platform",
    category: "capability",
    polarity: "negative",
    statement:
      "XL.net does not offer advanced SharePoint builds or Power Platform development.",
    detail:
      "Keeping SharePoint healthy, permissioned, and working is included. Building new things in it is not. Site architecture and redesign, migrations, permission model rework, and Power Apps or Power Automate development are fixed-fee Statements of Work, or moves, adds and changes where the scope is small.",
  }),
  fact({
    key: "compliance.nist-csf-certification",
    category: "compliance",
    polarity: "negative",
    statement:
      "XL.net holds no NIST Cybersecurity Framework certification, because no such certification exists to hold.",
    detail:
      "CIS publishes mappings to the NIST Cybersecurity Framework, so a client needing NIST-framed answers can be served. That is a different claim from holding a certification.",
  }),
  fact({
    key: "firmography.senior-living-experience",
    category: "firmography",
    polarity: "negative",
    statement:
      "XL.net had not held a senior living community as a client as of mid-2026, though staff have supported senior living organizations earlier in their careers.",
    detail: "Present this as a fit gap using the D4 shape rather than omitting it.",
  }),

  // --- Security and compliance posture -----------------------------------
  fact({
    key: "compliance.iso-methodology",
    category: "compliance",
    statement: "XL.net follows ISO 27001:2022 methodology.",
  }),
  fact({
    key: "compliance.hipaa",
    category: "compliance",
    statement:
      "XL.net is HIPAA-aware: least-privilege access, MFA, encryption in transit and at rest where supported, EDR, network segmentation isolating clinical systems, audit logging, training, and written access, change, and incident policies. XL.net will sign a Business Associate Agreement where ePHI is involved.",
  }),
  fact({
    key: "compliance.zero-trust",
    category: "compliance",
    statement:
      "XL.net is actively moving clients off VPN toward Zero Trust access, because of VPN risk in recent years.",
  }),
  fact({
    key: "compliance.soc-model",
    category: "compliance",
    statement:
      "The SOC model is hybrid. XL.net's own 24/7/365 service desk works alongside an external 24/7/365 SOC that performs continuous monitoring and first-pass triage. Escalations come to XL.net engineers, who own investigation, containment, and client communication.",
    detail:
      "Describe it as a hybrid. Do not claim a wholly internal SOC, and do not let it read as pure resale either.",
  }),
  fact({
    key: "compliance.incident-response",
    category: "compliance",
    statement:
      "Incident response follows the ISO 27001 phases: prepare, detect and analyze, contain, eradicate, recover, and post-incident review. Internal incidents use a SIRT under the CISO; client incidents use the Client Security Incident Response procedure with the XLTO and, for severe incidents, a CIRT. Alerting comes from SentinelOne and RocketCyber. A written Incident Response Plan and a sample incident report can be attached to proposals.",
  }),

  // --- Offboarding -------------------------------------------------------
  fact({
    key: "offboarding.terms",
    category: "operations",
    statement:
      "On exit, XL.net provides full documentation hand-off, asset and configuration inventory, knowledge transfer, and secure, orderly transfer of credentials and admin access. Data and documentation are portable in standard formats. There are no offboarding or transition-out fees.",
  }),

  // --- Brand -------------------------------------------------------------
  fact({
    key: "brand.tagline",
    category: "firmography",
    statement: "XL.net's tagline is \"XLerate Your Business.\"",
    detail: "It replaces the older \"Improving Your Productivity.\"",
  }),
];

/** Everything, in seed order. */
export const ALL_FACTS: Fact[] = [...STABLE_FACTS, ...RETIRED_FACTS, ...CORRECTED_FACTS];

/** The keys whose value was wrong and has been fixed. Rule C1's sweep starts from these. */
export const CORRECTED_FACT_KEYS = CORRECTIONS.map((c) => c.key);
