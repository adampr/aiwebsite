// Standard-specific applicability probes (§5.12). Each governance kind gets a
// small hardcoded pack of targeted Tavily queries that look for PUBLICLY
// findable company attributes on which the chosen standard's controls or
// documents are conditional (the owner's example: a control that applies only
// when the company works with the US DoD). Hardcoded on purpose: probe
// queries must be reviewable strings, never model output (injection surface,
// nondeterministic spend). Pure module, no node imports: used by the detached
// research script, research.ts brief shaping, and the invariant tests.
//
// Results become HEDGED "applicability signals" in the research brief:
// observations to confirm with the user during the interview, never
// applicability or compliance determinations (UPL posture). Trigger labels
// are attached host-side from this catalog; the model can never invent one.

import type { GovernanceKind } from "./types";

export interface ApplicabilityProbe {
  id: string; // stable kebab id; the reduce model attributes signals to it
  trigger: string; // applicability trigger label, host-attached, <= 80 chars
  queryTemplate: string; // Tavily query with {company} and/or {domain} slots
  confirmVia: string[]; // bank ids whose answers confirm or deny the signal
}

export const MAX_PROBE_QUERIES_PER_RUN = 3;
export const MAX_APPLICABILITY_SIGNALS = 5;
export const PROBE_RESULTS_PER_QUERY = 6; // top by score after filtering
export const PROBE_CONTENT_SLICE = 1000; // chars per result into distill

/**
 * Strip quotes, backslashes, and control chars; collapse whitespace; cap 80.
 * Company names come from untrusted page titles or model output and must not
 * be able to smuggle query operators or close a quoted phrase.
 */
export function sanitizeQueryTerm(s: string): string {
  return s
    .replace(/["\\\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

export function buildProbeQuery(
  p: ApplicabilityProbe,
  company: string,
  domain: string
): string {
  return p.queryTemplate
    .replaceAll("{company}", sanitizeQueryTerm(company))
    .replaceAll("{domain}", sanitizeQueryTerm(domain));
}

/**
 * Signal source URLs render into every drafting prompt, so they are a new
 * untrusted-text path: accept only parseable http/https URLs without
 * credentials, length-capped; anything else becomes "" (signal kept, source
 * dropped).
 */
export function sanitizeSignalSource(s: string): string {
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    if (u.username || u.password) return "";
    const out = u.toString();
    return out.length <= 160 ? out : "";
  } catch {
    return "";
  }
}

/** Individual-profile hosts: people pages must never enter the research pool
 * (public role holders reach us via company pages and press, not profiles). */
const INDIVIDUAL_PROFILE_URL = /linkedin\.com\/in\/|rocketreach\.co|zoominfo\.com\/p\/|signalhire\.com/i;

/**
 * Deterministic keep-filter for probe results: drop individual-profile pages
 * outright, and drop results that mention neither the company name nor the
 * domain (kills the generic-listicle class before it costs distill budget;
 * same-name collisions still go to the distill identity gate).
 */
export function probeResultRelevant(
  r: { title: string; url: string; content: string },
  company: string,
  domain: string
): boolean {
  if (INDIVIDUAL_PROFILE_URL.test(r.url)) return false;
  const hay = `${r.title} ${r.url} ${r.content}`.toLowerCase();
  const name = sanitizeQueryTerm(company).toLowerCase();
  return (name.length >= 3 && hay.includes(name)) || hay.includes(domain.toLowerCase());
}

export const PROBE_PACKS: Record<GovernanceKind, ApplicabilityProbe[]> = {
  usage_policy: [
    {
      id: "ai-tools-in-use",
      trigger: "AI tools the company publicly uses",
      queryTemplate: `"{company}" using ChatGPT OR Copilot OR Claude OR Gemini`,
      confirmVia: ["UP-03"],
    },
    {
      id: "customer-facing-ai",
      trigger: "AI-assisted content or code reaching customers",
      queryTemplate: `"{company}" AI-generated content OR AI-assisted development`,
      confirmVia: ["UP-07"],
    },
    {
      id: "gov-contracts",
      trigger: "Government or defense contract work",
      queryTemplate: `"{company}" federal OR defense OR government contract award`,
      confirmVia: ["UP-08"],
    },
  ],
  ffiec_aup: [
    {
      id: "charter-regulator",
      trigger: "Bank charter and primary federal regulator",
      queryTemplate: `"{company}" bank charter OCC OR FDIC OR "Federal Reserve" OR NCUA`,
      confirmVia: ["FF-03"],
    },
    {
      id: "ai-in-banking",
      trigger: "Public AI or generative AI use in bank operations",
      queryTemplate: `"{company}" AI OR chatbot OR "machine learning" lending OR fraud`,
      confirmVia: ["FF-05", "FF-06"],
    },
    {
      id: "fintech-partnerships",
      trigger: "Fintech or banking-as-a-service partnerships",
      queryTemplate: `"{company}" fintech partnership OR "banking as a service" OR "embedded finance"`,
      confirmVia: ["FF-11"],
    },
  ],
  nist_ai_rmf: [
    {
      id: "gov-contracts",
      trigger: "Government or defense contract work",
      queryTemplate: `"{company}" federal OR defense OR government contract award`,
      confirmVia: ["N-05"],
    },
    {
      id: "genai-products",
      trigger: "Generative AI in products or operations",
      queryTemplate: `"{company}" generative AI OR chatbot OR LLM product OR feature`,
      confirmVia: ["N-04"],
    },
    {
      id: "ai-hiring-buildout",
      trigger: "In-house AI or machine learning engineering",
      queryTemplate: `"{company}" hiring machine learning engineer OR AI engineer OR data scientist`,
      confirmVia: ["N-02"],
    },
  ],
  eu_ai_act: [
    {
      id: "eu-presence",
      trigger: "EU market presence or customers",
      queryTemplate: `"{company}" Europe OR European Union customers OR office OR subsidiary`,
      confirmVia: ["E-01"],
    },
    {
      id: "high-risk-domains",
      trigger: "AI touching hiring, credit, insurance, or biometrics",
      queryTemplate: `"{company}" AI hiring OR recruitment OR credit scoring OR biometric`,
      confirmVia: ["E-03", "E-04"],
    },
    {
      id: "public-facing-genai",
      trigger: "Public chatbots or AI-generated content",
      queryTemplate: `"{company}" chatbot OR virtual assistant OR AI-generated`,
      confirmVia: ["E-05"],
    },
  ],
  iso_42001: [
    {
      id: "existing-cert",
      trigger: "Existing management system certifications",
      queryTemplate: `"{company}" ISO 27001 OR SOC 2 OR ISO 9001 certified`,
      confirmVia: ["I-09"],
    },
    {
      id: "ai-provider-role",
      trigger: "Develops or sells AI systems",
      queryTemplate: `"{company}" AI platform OR AI product customers OR clients`,
      confirmVia: ["I-04"],
    },
    {
      id: "regulated-clients",
      trigger: "Regulated or government clients",
      queryTemplate: `"{company}" government OR defense OR healthcare OR banking clients OR contract`,
      confirmVia: ["I-03"],
    },
  ],
};

export function probeById(kind: GovernanceKind): Map<string, ApplicabilityProbe> {
  return new Map(PROBE_PACKS[kind].map((p) => [p.id, p]));
}
