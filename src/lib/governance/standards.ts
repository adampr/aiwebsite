// Standards reference reader (§5.12). The quarterly refresh script writes
// data/governance-standards/<slug>.md against a FIXED skeleton (## Overview /
// ## Key obligations / ## Document set blueprint / ## Question bank seeds /
// ## Glossary / ## Sources) so this module can slice mechanically. Until the
// first refresh runs (bootstrap window), hardcoded conservative fallbacks are
// served and the drafting prompt says so. mtime-cached hot reload, same
// discipline as the persona knowledge doc.

import fs from "node:fs";
import path from "node:path";
import type { GovernanceKind } from "./types";
import { screenInjection } from "./research";

export const STANDARDS_DIR = path.join(
  process.cwd(),
  "data",
  "governance-standards"
);

export const STANDARD_SLUGS: Record<
  Exclude<GovernanceKind, "usage_policy">,
  string
> = {
  ffiec_aup: "ffiec-ai",
  nist_ai_rmf: "nist-ai-rmf",
  eu_ai_act: "eu-ai-act",
  iso_42001: "iso-42001",
};

const FALLBACKS: Record<string, string> = {
  "nist-ai-rmf": `## Overview
The NIST AI Risk Management Framework (AI RMF 1.0) is a voluntary United States framework for managing risks from AI systems, organized around four functions: Govern, Map, Measure, and Manage. NIST also publishes a Generative AI Profile (NIST AI 600-1) describing risks specific to generative AI and suggested actions. (Bootstrap fallback: the full quarterly-researched reference is not on disk yet; draft conservatively, name the framework and its functions, and avoid citing specific subcategory identifiers.)
## Key obligations
Voluntary framework: organizations define their own risk tolerance, map AI systems and their contexts, measure trustworthiness characteristics, and manage risks across the lifecycle, with governance structures, documented roles, inventories, and incident processes.
## Document set blueprint
Policy, roles, system inventory, risk register, incident response, third-party procedure, generative AI addendum.
## Question bank seeds
Ask about systems in use, affected people, risk appetite, oversight roles, testing, monitoring, vendors, and incidents.`,
  "eu-ai-act": `## Overview
The EU AI Act (Regulation (EU) 2024/1689) is a binding European Union regulation applying risk-based obligations to providers and deployers of AI systems with EU market or user connections. Obligations phase in over several years and differ sharply between providers and deployers and between risk classes. (Bootstrap fallback: the full quarterly-researched reference is not on disk yet; draft conservatively, do not state application dates or article numbers beyond those the user provides, and recommend counsel confirmation.)
## Key obligations
Prohibited practices are banned outright; high-risk systems carry provider obligations (risk management, data governance, technical documentation, transparency, human oversight) and deployer obligations (use per instructions, oversight, logging, certain assessments); limited-risk systems carry transparency duties; AI literacy duties apply broadly.
## Document set blueprint
Applicability memo, prohibited-practice screening, classification register, risk management system, data and technical documentation, transparency and oversight, deployer procedure, post-market monitoring and incidents, literacy plan, provider conformity roadmap.
## Question bank seeds
Ask about EU nexus, built versus bought systems, consequential decision domains, biometrics, chatbots and synthetic content, deadlines, oversight, training, and incident paths.`,
  "iso-42001": `## Overview
ISO/IEC 42001:2023 specifies requirements for an AI management system (AIMS): an organization-level system of policies, roles, risk and impact assessments, lifecycle controls, and continual improvement for responsible AI. It follows the harmonized structure of other ISO management system standards and includes an Annex A control set addressed through a Statement of Applicability. (Bootstrap fallback: the full quarterly-researched reference is not on disk yet; paraphrase only, cite clause and control identifiers only if the user supplies them, and never reproduce standard text.)
## Key obligations
Define AIMS scope and context, leadership commitment and policy, roles, AI risk and impact assessment methodology, objectives and a Statement of Applicability over the Annex A controls, lifecycle and data management procedures, support and communication, performance evaluation, audits, management review, and corrective action.
## Document set blueprint
Scope and context, AI policy, roles, risk methodology, impact assessment, objectives and Statement of Applicability, lifecycle procedure, data management, support and communications, performance and improvement.
## Question bank seeds
Ask about certification goals, scope, leadership, existing ISO management systems, risk scales, high-impact systems, lifecycle practice, data provenance, suppliers, and audit readiness.`,
  "ffiec-ai": `## Overview
There is no standalone FFIEC AI regulation. Bank examiners assess AI through four existing lenses: the FFIEC IT Examination Handbook (the Architecture, Infrastructure, and Operations booklet's AI and machine learning section, the Development, Acquisition, and Maintenance booklet, and the Information Security booklet under GLBA safeguards); model risk management under SR 26-2, the interagency guidance that superseded SR 11-7, proportionate to size and materiality, with AI-specific provisions deferred to signaled future guidance; the Interagency Guidance on Third-Party Relationships (2023) and its community bank guide (2024); and consumer compliance, meaning ECOA and Regulation B adverse action duties per the CFPB circulars on AI credit decisions, UDAAP, Regulation P privacy, plus BSA/AML monitoring model validation and FinCEN alerting on deepfake and AI-enabled fraud. (Bootstrap fallback: the weekly-researched reference is not on disk yet; draft conservatively, name sources without quoting them, and mark anything uncertain for confirmation.)
## Key obligations
Board-approved policy and named accountability; a complete AI inventory including AI embedded in vendor systems; risk tiers driving proportionate validation, with outsourced validation acceptable for community banks and independent effective challenge expected as size grows; full bank responsibility for vendor models; AI-specific due diligence, contract terms, and monitoring for third parties; GLBA-grade data controls with customer nonpublic information, suspicious activity information, and confidential supervisory information in the never class; specific and accurate adverse action reasons even from complex models; human decisions on suspicious activity alerts; training and Board reporting that leave an exam-ready trail. Asset-size calibration: under $10 billion, expanded existing committees and outsourced validation suffice; $10 billion to $30 billion adds direct consumer-compliance supervision and formal fair lending testing; above $30 billion the full model risk expectations are most directly relevant, with standalone model risk functions; the largest institutions face large financial institution standards with dedicated AI governance.
## Document set blueprint
Board AI use policy hub; amendments to model risk, third-party, information security and incident response, compliance and fair lending, and BSA/AML policies; living artifacts covering inventory, tier matrix, tools register, vendor questionnaire, and an employee quick reference.
## Question bank seeds
Ask about charter and primary regulator, consolidated assets, which written policies exist today, AI in use including vendor-embedded features, customer-facing AI, AI in credit decisions, the BSA monitoring vendor, validation approach, committee ownership, never-share data including exam materials, incident channels, and recent exam themes.`,
  "cross-standard-digest": `## Overview
Cross-standard digest for AI acceptable use policies (bootstrap fallback). An AI acceptable use policy should tell employees in plain language which AI tools are approved, what data may and may not be shared with them (keyed to the organization's data classes), how to verify AI output, when to disclose AI use, extra care for decisions about people, how to raise incidents without blame, and who owns the policy. NIST AI RMF, the EU AI Act, and ISO/IEC 42001 all reward documented tool governance, human oversight, and incident reporting; a good acceptable use policy is the employee-facing edge of all three.`,
};

interface CacheEntry {
  mtimeMs: number;
  content: string;
}
const cache = new Map<string, CacheEntry>();

function readDoc(slug: string): { content: string; fallback: boolean } {
  const file = path.join(STANDARDS_DIR, `${slug}.md`);
  try {
    const stat = fs.statSync(file);
    const hit = cache.get(slug);
    if (hit && hit.mtimeMs === stat.mtimeMs)
      return { content: hit.content, fallback: false };
    const raw = fs.readFileSync(file, "utf8");
    if (raw.trim().length < 500) throw new Error("too short");
    // Defense in depth: the refresh script screens before writing, but the
    // doc sits in SYSTEM position for every governance turn, so screen again.
    const { clean } = screenInjection(raw);
    cache.set(slug, { mtimeMs: stat.mtimeMs, content: clean });
    return { content: clean, fallback: false };
  } catch {
    return { content: FALLBACKS[slug] ?? "", fallback: true };
  }
}

/** Slice out the prompt-relevant skeleton sections, capped. */
function slice(content: string, maxChars: number): string {
  const wanted = [
    "## Overview",
    "## Key obligations",
    "## Document set blueprint",
    "## Question bank seeds",
  ];
  const parts: string[] = [];
  for (const heading of wanted) {
    const start = content.indexOf(heading);
    if (start === -1) continue;
    const rest = content.slice(start + heading.length);
    const next = rest.search(/\n## /);
    parts.push(heading + (next === -1 ? rest : rest.slice(0, next)));
  }
  const joined = (parts.length ? parts.join("\n") : content).trim();
  return joined.length > maxChars ? joined.slice(0, maxChars) : joined;
}

export function standardsReference(kind: GovernanceKind): {
  text: string;
  fallback: boolean;
} {
  if (kind === "usage_policy") {
    const digest = readDoc("cross-standard-digest");
    return { text: slice(digest.content, 10_000), fallback: digest.fallback };
  }
  const doc = readDoc(STANDARD_SLUGS[kind]);
  return { text: slice(doc.content, 32_000), fallback: doc.fallback };
}

/** Knowledge currency date for disclaimers: state.json, else today. */
export function standardsDate(): string {
  try {
    const state = JSON.parse(
      fs.readFileSync(path.join(STANDARDS_DIR, "state.json"), "utf8")
    ) as { standards?: Record<string, { lastDeepResearch?: string }> };
    const dates = Object.values(state.standards ?? {})
      .map((s) => s.lastDeepResearch)
      .filter((d): d is string => !!d)
      .sort();
    if (dates.length) return dates[dates.length - 1].slice(0, 10);
  } catch {
    // fall through
  }
  return new Date().toISOString().slice(0, 10);
}

/** Age of the newest state.json in days; null when absent (bootstrap). */
export function standardsStalenessDays(): number | null {
  try {
    const stat = fs.statSync(path.join(STANDARDS_DIR, "state.json"));
    return Math.floor((Date.now() - stat.mtimeMs) / 86_400_000);
  } catch {
    return null;
  }
}
