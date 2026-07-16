// AI Governance builder - caps, budgets, and canonical copy (§5.12).
// Client-safe: constants only, no node imports, NO EM DASHES in any string
// (site rule - checked by scripts/governance-tests).

import type { GovernanceKind } from "./types";

export const RETENTION_DAYS = 30;

export const CAPS = {
  activeProjectsPerUser: 3,
  createsPerUserPerDay: 5,
  answersPerProject: 40,
  answerMaxChars: 2000,
  researchRunsPerProjectPerDay: 3,
  concurrentResearchJobs: 2,
  // JSON mode runs on the full executor model (gpt-5.4 class, ~$0.10/turn at
  // our budgets) - the daily default authorizes roughly $15/day worst case.
  brainCallsPerDayDefault: 150,
  tavilyCallsPerDayDefault: 30,
  tavilyCallsPerResearchRun: 6,
  distillCallsPerResearchRun: 12,
  // Prompt-side output bound: the host cannot set max_tokens on the brain's
  // JSON path, so the per-turn op budget is the real ceiling (~2k output tok,
  // finishes well inside the 90 s brain timeout). Turn zero runs detached and
  // may write big.
  turnOpMarkdownMaxChars: 8000,
  turnZeroOpMarkdownMaxChars: 24000,
  sectionMarkdownMaxChars: 6000,
  maxSectionsPerDoc: 20,
  maxDocsPerProject: 12,
  maxOpsPerTurn: 12,
  documentsJsonMaxBytes: 150_000, // aligned with what is promptable
  transcriptJsonMaxBytes: 200_000,
  researchBriefMaxChars: 9000,
  // Answer route timing: nginx cuts the proxy at 120 s, so the route must
  // always answer first. Brain turn 90 s; repair only if >=40 s remain.
  brainTurnTimeoutMs: 90_000,
  repairMinRemainingMs: 40_000,
  routeDeadlineMs: 115_000,
} as const;

/** Sign-in email domains that are not company domains - force manual entry. */
export const CONSUMER_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "aol.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "zoho.com",
  "fastmail.com",
  "hey.com",
  "duck.com",
  "yandex.com",
  "yandex.ru",
]);

export const KIND_LABELS: Record<
  GovernanceKind,
  { name: string; badge: string; blurb: string }
> = {
  usage_policy: {
    name: "AI Usage Policy",
    badge: "FASTEST · ONE DOCUMENT",
    blurb:
      "One page your employees will actually use. It answers the real questions, like what is OK to paste into a chatbot and what never is.",
  },
  nist_ai_rmf: {
    name: "NIST AI RMF draft set",
    badge: "DOCUMENT SET · ZIP",
    blurb:
      "A working draft set of the core documents aligned with the NIST AI Risk Management Framework: policy, roles, inventory, risk register, incidents, vendors.",
  },
  eu_ai_act: {
    name: "EU AI Act draft set",
    badge: "DOCUMENT SET · ZIP",
    blurb:
      "A working draft set of the core documents for the EU AI Act: applicability, prohibited-practice screening, classification, transparency, deployer duties, incident reporting.",
  },
  iso_42001: {
    name: "ISO/IEC 42001 draft set",
    badge: "DOCUMENT SET · ZIP",
    blurb:
      "A working draft set of the core AI management system documents aligned with ISO/IEC 42001: scope, policy, roles, risk and impact assessment, statement of applicability, lifecycle.",
  },
};

/**
 * Canonical deletion notice (reused verbatim in the create panel, workspace,
 * download menu, and 404 page copy; the concrete date is rendered beside it).
 * The backup tail is disclosed on purpose: nightly full-DB dumps retain up to
 * a further 30 days, so an absolute "all of it, gone" would be untrue.
 */
export const DELETION_NOTICE =
  "This project auto-deletes 30 days after your last activity. Drafts, research, answers: all of it is removed from our systems, and encrypted backup copies expire within a further 30 days. Download what you want to keep; the download is yours forever.";

/** Third-party AI processing disclosure (create panel + /privacy section). */
export const AI_PROCESSING_NOTICE =
  "Your answers and our research are processed by third-party AI model providers to draft your documents. Nothing you type here is stored in Tron's long-term memory or shared with other visitors.";

/** Affirmative acknowledgment required at project creation (UPL posture). */
export const ACK_TEXT =
  "I understand these are AI-generated drafts, not legal advice, and they will be reviewed by our counsel or compliance owner before adoption. I represent this organization or am authorized to prepare these drafts for it.";

export const NOT_LEGAL_ADVICE_LINE =
  "Drafts are a working starting point for your leadership and counsel to review. They are not legal advice.";

/** Page-1 disclaimer of every .docx and the zip README (word-wrapped there). */
export const DOCUMENT_DISCLAIMER = [
  "Important notice about this document",
  "",
  "This document was generated with AI assistance by Tron Netter, the AI agent at ai.xl.net, from your answers and public research about your organization. Standards knowledge current as of {standards_date}.",
  "",
  "Not legal advice. This draft does not create an attorney-client, consultant, or fiduciary relationship. It is a starting point, not a compliance determination.",
  "Review before use. Have your counsel and your compliance owner review and adapt this draft before adopting it.",
  "AI-generated content may contain errors. Verify every obligation, citation, and deadline against the primary sources before relying on it.",
  "No compliance guarantee or certification. Using this draft does not make you compliant with any law or standard, and it is not an ISO certification; only accredited certification bodies certify. No endorsement by NIST, ISO, IEC, or the European Union is implied.",
  "Standards references. NIST publications are public domain. ISO/IEC 42001 is copyrighted by ISO and IEC; this draft paraphrases and cites it but does not reproduce it. Purchase the standard to implement it.",
  "Your responsibility. You are responsible for what you adopt, publish, and file.",
  "Data retention. Your project, including drafts, research, and answers, is removed from our systems 30 days after your last activity; encrypted backup copies expire within a further 30 days.",
  "",
  'This document is provided "as is", without warranty of any kind. To the maximum extent permitted by law, XL.net disclaims all liability arising from its use.',
].join("\n");

/** Per-document footer; must stay truthful after confirm (never says Draft). */
export const DOC_FOOTER =
  "Generated {date} by the ai.xl.net governance assistant. Not legal advice; review by counsel required before adoption.";

export const DRAFT_WATERMARK = "DRAFT · generated {date} · ai.xl.net";

/** Research wait copy: one honest range, used everywhere. */
export const RESEARCH_DURATION_COPY = "3 to 6 minutes";

export const REVIEW_FORCED_SUMMARY =
  "We reached the depth limit for one project, so I stopped asking questions. The draft on the right reflects everything you told me. Review it, ask for revisions below, and confirm when it reads right.";

/** Feature kill switch: disabled ONLY when explicitly "0". Reads (project
 * fetch + downloads) stay up regardless - the switch is about spend. */
export function governanceEnabled(env: Record<string, string | undefined>) {
  return env.GOVERNANCE_ENABLED !== "0";
}

export function tavilyDailyCap(env: Record<string, string | undefined>) {
  const n = parseInt(env.GOVERNANCE_TAVILY_DAILY_CAP || "", 10);
  return Number.isFinite(n) && n > 0 ? n : CAPS.tavilyCallsPerDayDefault;
}

export function brainDailyCap(env: Record<string, string | undefined>) {
  const n = parseInt(env.GOVERNANCE_BRAIN_DAILY_CAP || "", 10);
  return Number.isFinite(n) && n > 0 ? n : CAPS.brainCallsPerDayDefault;
}

/** Strict slug for Content-Disposition filenames (header injection guard). */
export function fileSlug(s: string, fallback = "project"): string {
  const slug = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || fallback;
}

/** Validate a bare domain (no scheme/path/port/creds). Lowercases. */
export function normalizeDomain(input: string): string | null {
  const d = input.trim().toLowerCase().replace(/^https?:\/\//, "").split(/[/?#]/)[0];
  if (!d || d.length > 253) return null;
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(d)) return null;
  return d;
}
