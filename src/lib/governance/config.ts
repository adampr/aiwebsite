// AI Governance builder - caps, budgets, and canonical copy (§5.12).
// Client-safe: constants only, no node imports, NO EM DASHES in any string
// (site rule - checked by scripts/governance-tests).

import type { GovernanceKind } from "./types";

export const RETENTION_DAYS = 30;

export const CAPS = {
  activeProjectsPerUser: 3,
  // Per-person daily budget (owner directive 2026-07-16: x5). The only cap
  // that scales per person; active-projects/answers/research-runs are
  // concurrency and per-project quality guards, not person budgets.
  createsPerUserPerDay: 25,
  answersPerProject: 40,
  answerMaxChars: 2000,
  researchRunsPerProjectPerDay: 3,
  concurrentResearchJobs: 2,
  // JSON mode runs on the full executor model (gpt-5.4 class, ~$0.10/turn at
  // our budgets) - 1500/day authorizes roughly $150/day worst case (owner
  // directive 2026-07-16: global x10). Tavily 300/day = ~600 credits/day.
  // Both are env-overridable AND runtime-overridable via the Troy approval
  // loop (budget.ts), clamped to BUDGET_CEILINGS either way.
  brainCallsPerDayDefault: 1500,
  tavilyCallsPerDayDefault: 300,
  // 3 company + 1 industry + up to 3 standard probes = 7 worst case, 1 headroom.
  tavilyCallsPerResearchRun: 8,
  distillCallsPerResearchRun: 12,
  // Prompt-side output bound: the host cannot set max_tokens on the brain's
  // JSON path, so the per-turn op budget is the real ceiling (~4k output tok
  // worst case, inside the 90 s brain timeout like turn zero's 24k). The
  // prompt states the TARGET; validation enforces the MAX. The gap is
  // deliberate margin: the model cannot count characters, and prod turns
  // aiming at a stated-equals-enforced 8000 failed at 8037-8828 even after
  // repair (2026-07-17 snag incident). Late-project turns also legitimately
  // need more than 8000: one section may be 6000 alone, and chase/revise
  // turns re-emit every touched section in full.
  turnOpMarkdownTargetChars: 12000,
  turnOpMarkdownMaxChars: 16000,
  turnZeroOpMarkdownMaxChars: 24000,
  sectionMarkdownMaxChars: 6000,
  maxSectionsPerDoc: 20,
  maxDocsPerProject: 12,
  maxOpsPerTurn: 12,
  // Turn zero drafts up to 10 sections plus retitles in one response, so it
  // gets a higher op ceiling than the one-question turns (a 10-section group
  // sits one op from a whole-turn failure at 12).
  turnZeroMaxOps: 24,
  // Turn-zero groups that fail validation get at most this many repair calls
  // per research run (each budget-counted), each with this timeout and this
  // much of the raw output to repair. 90 s mirrors the original group call:
  // the repair re-emits a corrected ~20k-char object, and 60 s proved tight.
  turnZeroRepairMaxCalls: 2,
  turnZeroRepairTimeoutMs: 90_000,
  turnZeroRepairRawMaxChars: 48_000,
  documentsJsonMaxBytes: 150_000, // aligned with what is promptable
  transcriptJsonMaxBytes: 200_000,
  researchBriefMaxChars: 9000,
  // research_audit_json ceiling (facts+suspicion+screen hits, never page
  // bodies); truncateAudit sheds trailing facts to stay under it.
  researchAuditMaxChars: 20_000,
  // Answer turn timing. POST /answer (mode:"async" required; markerless =
  // stale pre-async client, told to reload) returns 202 and runs the turn
  // in-process with no route deadline: the brain call gets the full 90 s
  // and the repair pass its full 60 s. A running claim older than
  // turnStaleMs is an orphan (PM2 restart mid-turn) and is reclaimable; the
  // fence nonce keeps a slow zombie from writing. Worst honest turn: 90 s
  // brain + 60 s repair + semaphore wait + apply.
  turnStaleMs: 240_000,
  brainTurnTimeoutMs: 90_000,
  // Optional sample-policy upload (format matching): raw file cap, stored
  // extracted-text cap, and the slice of it that rides every prompt. The
  // file cap fits real multi-page policy PDFs; extraction cost stays bounded
  // by the page/char/deadline caps in style-sample.ts, not by file size.
  styleSampleFileMaxBytes: 2_000_000,
  styleSampleMaxChars: 20_000,
  styleSamplePromptMaxChars: 6_000,
  styleSamplePdfMaxPages: 40,
  styleSamplePdfDeadlineMs: 10_000,
} as const;

/**
 * Bounds on runtime budget overrides (the Troy email-approval loop, §5.12).
 * Hard ceilings bound the email channel's blast radius: even a subverted
 * approval can at worst authorize ~$500/day of brain calls, never 10^9. The
 * floor keeps email from bricking the feature (that is GOVERNANCE_ENABLED's
 * job). The clamp applies to env values too, so a mistyped env var cannot
 * exceed a ceiling either.
 */
export const BUDGET_FLOOR = 1;
export const BUDGET_CEILINGS = {
  brainDaily: 5000,
  tavilyDaily: 2000,
  createsPerUserPerDay: 100,
} as const;

/** Sample-policy upload: extensions the extractor understands (client accept
 * attribute + server allowlist share this list; keep it client-safe here). */
export const STYLE_SAMPLE_EXTENSIONS = [".docx", ".pdf", ".md", ".txt"] as const;
// MIME types included: some mobile pickers ignore extension-only accepts.
export const STYLE_SAMPLE_ACCEPT = [
  ...STYLE_SAMPLE_EXTENSIONS,
  "text/plain",
  "text/markdown",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
].join(",");

export const STYLE_SAMPLE_TYPES_COPY = ".docx, .pdf, .md, or .txt";

/** Shared helper line for the format-sample upload (create panel + control). */
export const STYLE_SAMPLE_HELPER =
  `Optional. Upload a policy your organization has the right to share (${STYLE_SAMPLE_TYPES_COPY}). The draft follows its heading and list style, and section numbering is applied automatically; Tron is instructed not to reuse the policy's content. Only the extracted text is kept: it is sent to our AI providers with each drafting turn and is deleted with the project.`;

/** Client-side precheck for a sample file; returns the error copy or null. */
export function styleSampleFileError(name: string, size: number): string | null {
  const lower = name.toLowerCase();
  if (!STYLE_SAMPLE_EXTENSIONS.some((ext) => lower.endsWith(ext)))
    return `Upload a ${STYLE_SAMPLE_TYPES_COPY} file.`;
  if (size > CAPS.styleSampleFileMaxBytes)
    return `Keep the sample under ${Math.round(CAPS.styleSampleFileMaxBytes / 1_000_000)} MB. A few representative pages are plenty.`;
  return null;
}

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
  "Your answers, our research, the drafts in progress, and any format sample you upload are processed by third-party AI model providers to draft your documents. Nothing you type or upload here is stored in Tron's long-term memory or shared with other visitors.";

/** Affirmative acknowledgment required at project creation (UPL posture). */
export const ACK_TEXT =
  "I understand these are AI-generated drafts, not legal advice, and they will be reviewed by our counsel or compliance owner before adoption. I represent this organization or am authorized to prepare these drafts for it, and any file I upload here is one it may lawfully share.";

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
export const RESEARCH_DURATION_COPY = "3 to 8 minutes";

export const REVIEW_FORCED_SUMMARY =
  "We reached the depth limit for one project, so I stopped asking questions. The draft on the right reflects everything you told me. Review it, ask for revisions below, and confirm when it reads right.";

/** Skip-release flip (owner rule 2026-07-17): the user skipped an open-item
 * chase question, declining further questions. Host-written, no AI call. */
export const REVIEW_SKIPPED_SUMMARY =
  "You skipped, so I stopped asking questions. The draft on the right reflects everything you told me so far. Review it, ask for revisions below, and confirm when it reads right.";

/** Reopen flip (done -> review, owner request 2026-07-17): host-written, no
 * AI call. Non-temporal on purpose: it stays on the row through later edits,
 * so it must not claim the draft is unchanged since confirm. */
export const REVIEW_REOPENED_SUMMARY =
  "Reopened. Change any answer under Your answers below, ask for any other change in the box under them, or confirm again to make it final as is.";

/** Owner rule 2026-07-17: a review summary must never read as ready-for-final
 * while [TO CONFIRM] markers remain. Count-free on purpose: the stored
 * summary outlives resolutions (keep-as-drafted never rewrites it), so a
 * baked number would go stale; the live count renders from openConfirmTotal
 * next to the resolver. */
export function withOpenItemsNote(summary: string, openTotal: number): string {
  if (openTotal <= 0) return summary;
  // Idempotent: non-advancing review turns re-wrap priorSummary, which may
  // already carry the note; without this guard repeated amends stack it.
  if (summary.includes("Note: open [TO CONFIRM] items remain")) return summary;
  return `${summary} Note: open [TO CONFIRM] items remain in this draft. It is not final until you resolve each one in the list below, with the correct fact or an explicit keep as drafted.`;
}

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
