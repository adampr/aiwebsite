// AI Governance builder — shared types (ARCHITECTURE.md §5.12).
// Pure types + type guards only: this file is imported by server routes,
// detached scripts, AND the client workspace bundle. No node imports.

export type GovernanceKind =
  | "usage_policy"
  | "nist_ai_rmf"
  | "eu_ai_act"
  | "iso_42001";

export const GOVERNANCE_KINDS: GovernanceKind[] = [
  "usage_policy",
  "nist_ai_rmf",
  "eu_ai_act",
  "iso_42001",
];

export type ProjectStatus =
  | "created"
  | "queued"
  | "researching"
  | "research_failed"
  | "drafting"
  | "review"
  | "done";

export interface DocSection {
  id: string; // stable kebab id, the op target
  title: string;
  markdown: string;
}

export interface GovernanceDoc {
  slug: string; // from the kind's blueprint allowlist
  title: string;
  // A stub doc renders as a one-paragraph signed negative determination
  // instead of disappearing (auditors prefer negative determinations).
  stub: boolean;
  sections: DocSection[];
}

export interface TranscriptEntry {
  qId: string;
  bankId: string | null;
  q: string;
  a: string;
  skipped: boolean;
  askedAt: string; // ISO
  answeredAt: string; // ISO
}

export interface NextQuestion {
  id: string; // "q_<rev>" — the answer route 409s on any other id
  bankId: string | null;
  text: string;
  why: string;
  suggestions: string[];
  // "<doc-slug>#<section-id>" pairs this question's answer feeds — the doc
  // pane anchors and marks these sections while the question is active, so
  // the user can see exactly the text they are being asked about.
  feeds: string[];
}

export interface ResearchBrief {
  companyProfile: string;
  sizeAndFootprint: string;
  industryContext: string;
  aiUseSignals: string[];
  regulatoryExposure: string[];
  dataSensitivity: string;
  openQuestions: string[]; // seeds Tron's early follow-ups
  topSources: string[];
  gaps: string[]; // e.g. "tavily_unavailable", "site_unreachable", "research_failed"
  confidenceNotes: string;
  distilledAt: string; // ISO
}

export type ResearchStep =
  | "site"
  | "mentions"
  | "industry"
  | "distill"
  | "handoff";

export interface ResearchProgress {
  step: ResearchStep;
  pct: number; // 0-100
  counts: { pages?: number; mentions?: number; industry?: number };
  // Tavily results are checkpointed so a requeued job never re-spends credits.
  checkpoints?: {
    tavilyCompany?: TavilyResult[];
    tavilyIndustry?: TavilyResult[];
    profile?: { companyName: string; industry: string; oneLine: string };
  };
  error?: string;
}

export interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number | null;
}

/** Per-turn document operations the model may emit (server-validated). */
export type DocOp =
  | { op: "create_doc"; doc: string; title: string }
  | {
      op: "upsert_section";
      doc: string;
      section: string;
      title: string;
      markdown: string;
    }
  | { op: "remove_section"; doc: string; section: string }
  | { op: "retitle_doc"; doc: string; title: string }
  | { op: "set_stub"; doc: string; stub: boolean; markdown: string };

/** The validated shape of one brain turn (turn.ts enforces it). */
export interface TurnResult {
  docOps: DocOp[];
  status: "asking" | "review";
  question: {
    bankId: string | null;
    text: string;
    why: string;
    suggestions: string[];
  } | null;
  reviewSummary: string | null;
  answeredBankIds: string[];
}

/** What GET /api/governance/projects/[id] returns (the poll target). */
export interface ProjectView {
  id: string;
  kind: GovernanceKind;
  domain: string;
  status: ProjectStatus;
  rev: number;
  documents: GovernanceDoc[];
  transcript: TranscriptEntry[]; // full — elision happens only at prompt assembly
  nextQuestion: NextQuestion | null;
  reviewSummary: string | null;
  changedSections: Record<string, string[]>; // docSlug -> [sectionId]
  progress: { answered: number; total: number };
  researchProgress: {
    step: ResearchStep;
    pct: number;
    counts: { pages?: number; mentions?: number; industry?: number };
    error?: string;
  } | null;
  openConfirmItems: { doc: string; section: string; excerpt: string }[];
  // The uploaded sample policy, name only (its text stays server-side; the
  // drafting prompt mirrors its formatting conventions). Null = none.
  styleSample: { name: string } | null;
  answersCount: number;
  deletesAt: string; // ISO — concrete date rendered everywhere
  createdAt: string;
  // True when the row is queued/stale and the client should POST /research
  // to claim it (GETs never claim — CSRF-guarded POSTs do).
  reclaimable: boolean;
  featureDisabled: boolean; // GOVERNANCE_ENABLED=0: reads still work
}

export interface ProjectSummary {
  id: string;
  kind: GovernanceKind;
  domain: string;
  status: ProjectStatus;
  rev: number;
  answersCount: number;
  progress: { answered: number; total: number };
  deletesAt: string;
  createdAt: string;
}

export type GovernanceErrorCode =
  | "unauthenticated"
  | "not_found"
  | "rate_limited"
  | "project_cap"
  | "create_cap"
  | "answer_cap"
  | "answer_too_long"
  | "stale_question"
  | "research_running"
  | "research_cap"
  | "budget_exhausted"
  | "brain_unavailable"
  | "invalid_turn"
  | "invalid_domain"
  | "ack_required"
  | "invalid_request"
  | "feature_disabled";

export interface GovernanceError {
  error: { code: GovernanceErrorCode; message: string; retriable?: boolean };
}

export function isGovernanceKind(v: unknown): v is GovernanceKind {
  return typeof v === "string" && (GOVERNANCE_KINDS as string[]).includes(v);
}
