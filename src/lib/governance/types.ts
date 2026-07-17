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
  // "amend" rows only: index of the transcript entry being corrected. The
  // transcript is append-only in every write path, so the index is stable.
  amendsIndex?: number;
  // Question rows written since 2026-07-17: the question's feeds, kept so a
  // later amend can serialize the right sections verbatim. Older rows lack
  // it; amend falls back to the bank feeds (or full serialization).
  feeds?: string[];
}

export interface NextQuestion {
  // "q_<rev>", or "qi_<rev>" for a host-synthesized open-item chase question
  // (owner rule 2026-07-17; skipping one flips to review with no AI call).
  // The answer route 409s on any id that does not match the stored question.
  id: string;
  bankId: string | null;
  text: string;
  why: string;
  suggestions: string[];
  // "<doc-slug>#<section-id>" pairs this question's answer feeds — the doc
  // pane anchors and marks these sections while the question is active, so
  // the user can see exactly the text they are being asked about.
  feeds: string[];
  // Background-check question ("did I get your company right?"): the card
  // renders the research snapshot as the object of review and the
  // ask-anchor choreography is suppressed. DERIVED at view time from the
  // blueprint's bank declaration — never persisted, so it retrofits
  // projects whose Q1 was stored before the flag existed.
  snapshot?: boolean;
}

// Never "confirmed": signals are public-source observations, and the UPL
// posture forbids presenting research as an applicability determination.
export type SignalConfidence = "likely" | "unclear";

/** One standard-conditioned public-source observation (§5.12 probes). The
 * trigger label is attached host-side from the probe catalog, never taken
 * from model output. */
export interface ApplicabilitySignal {
  probeId: string; // from PROBE_PACKS in probes.ts
  trigger: string; // catalog label
  finding: string; // one hedged sentence, "public sources suggest ..."
  source: string; // URL, sanitized (http/https, no creds) or ""
  confidence: SignalConfidence;
}

export interface ResearchBrief {
  companyProfile: string;
  companyName: string; // short display name from the profile call; "" if unknown
  sizeAndFootprint: string;
  industryContext: string;
  aiUseSignals: string[];
  regulatoryExposure: string[];
  // Standard-specific probe findings: hedged observations to confirm with
  // the user, never determinations. Capped by MAX_APPLICABILITY_SIGNALS.
  applicabilitySignals: ApplicabilitySignal[];
  // Which kind's probe pack ran to completion for this brief; drives the
  // cross-kind top-up on brief reuse. null = probes incomplete or pre-probe.
  probedKind: GovernanceKind | null;
  dataSensitivity: string;
  openQuestions: string[]; // seeds Tron's early follow-ups
  topSources: string[];
  gaps: string[]; // e.g. "tavily_unavailable", "site_unreachable", "research_failed"
  confidenceNotes: string;
  distilledAt: string; // ISO
}

/**
 * Post-hoc audit evidence retained at handoff (research_audit_json): the
 * map-phase {fact, source} provenance the reduce step drew from, the model's
 * screened suspicion notes, and the regex screen-hit slugs, so a stored brief
 * is auditable and research_flagged's cause is diagnosable. Derived content
 * only, NEVER raw page bodies or Tavily snippets. INVARIANT: never rendered
 * into any prompt (the brief is the only research text a model ever sees).
 * Deleted with the row; rides the account export. Old code ignores the column.
 */
export interface ResearchAudit {
  version: 1;
  createdAt: string; // ISO
  facts: { fact: string; source: string }[];
  suspicious: { phase: "map" | "topup"; note: string }[];
  screenHits: string[]; // pattern slugs; "turnzero:" prefix = applyOps hits
  counts: { pages?: number; mentions?: number; industry?: number; probes?: number };
  // Brief-reuse lineage: set when this project's brief was copied from a
  // donor row (whose own audit dies with it); facts are carried over.
  reusedFrom?: { projectId: string; donorDistilledAt: string };
}

export type ResearchStep =
  | "site"
  | "mentions"
  | "industry"
  | "probes"
  | "distill"
  | "handoff";

export interface ResearchProgress {
  step: ResearchStep;
  pct: number; // 0-100
  counts: { pages?: number; mentions?: number; industry?: number; probes?: number };
  // Tavily results are checkpointed so a requeued job never re-spends credits.
  // tavilyProbes uses PRESENCE semantics per probe id (empty arrays included):
  // a zero-hit probe is still spent and must not re-run on requeue.
  checkpoints?: {
    tavilyCompany?: TavilyResult[];
    tavilyIndustry?: TavilyResult[];
    tavilyProbes?: Record<string, TavilyResult[]>;
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
  | { op: "set_stub"; doc: string; stub: boolean; markdown: string }
  // Structure adoption (§5.12): reorder a document's sections to the format
  // sample's outline. `order` must be an exact permutation of the doc's
  // current section ids (applyOps enforces; anything else is rejected).
  // Section ids never change, so feeds, placeholder detection, and open-item
  // tracking survive reordering; host-owned numbering renumbers on render.
  | { op: "reorder_sections"; doc: string; order: string[] };

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

/** Async answer-turn state on the poll (§5.12). "running" = a claim is
 * fresh; "failed" = the last turn recorded an error (or its claim aged past
 * the staleness horizon after a restart and is presented as a transport
 * failure). promptId lets the sending tab match the record to its flight. */
export type TurnState =
  | {
      phase: "running";
      promptId: string;
      questionId: string;
      startedAt: string; // ISO
    }
  | {
      phase: "failed";
      promptId: string;
      questionId: string;
      error: {
        code: GovernanceErrorCode | "network";
        message: string;
        retriable?: boolean;
      };
    };

/**
 * One open [TO CONFIRM] marker, addressable for resolution. `occurrence` is
 * the 0-based index among markers with the SAME excerpt inside the same
 * section (identical markers are rare but must stay distinguishable).
 * `contextBefore`/`contextAfter` are the text on the marker's line around it,
 * word-boundary windowed, so the user can see WHAT they would be affirming.
 * `confirmable` is false when stripping the marker would leave its containing
 * paragraph, list item, or table cell empty (the marker IS the content there;
 * only a typed answer can resolve it).
 */
export interface OpenConfirmItem {
  doc: string;
  section: string;
  excerpt: string;
  occurrence: number;
  contextBefore: string;
  contextAfter: string;
  confirmable: boolean;
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
  // docSlug -> [sectionId] still holding untouched blueprint scaffold text
  // (host-computed, exact match, stub docs excluded). The pane renders these
  // as Planned; confirm refuses while any remain.
  placeholderSections: Record<string, string[]>;
  progress: { answered: number; total: number };
  researchProgress: {
    step: ResearchStep;
    pct: number;
    counts: { pages?: number; mentions?: number; industry?: number; probes?: number };
    error?: string;
  } | null;
  openConfirmItems: OpenConfirmItem[];
  // TRUE total of open [TO CONFIRM] markers (lenient scan: counts malformed
  // markers the item list cannot parse). The confirm gate, the list header,
  // and all copy use this, never openConfirmItems.length (which is sliced).
  openConfirmTotal: number;
  // Tron's research understanding, capped for display: the object of review
  // on background-check questions (NextQuestion.snapshot). Composed at view
  // time from the research brief; null when research produced nothing.
  companySnapshot: {
    name: string;
    profile: string;
    size: string;
    industry: string;
  } | null;
  // The uploaded sample policy, name only (its text stays server-side; the
  // drafting prompt mirrors its formatting conventions). Null = none.
  styleSample: { name: string } | null;
  answersCount: number;
  deletesAt: string; // ISO — concrete date rendered everywhere
  createdAt: string;
  // True when the row is queued/stale and the client should POST /research
  // to claim it (GETs never claim — CSRF-guarded POSTs do).
  reclaimable: boolean;
  // Async answer-turn state; null when no turn record exists. Derived
  // read-only (GETs never mutate); the next POST /answer claim reaps.
  turn: TurnState | null;
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
  | "turn_pending"
  | "research_running"
  | "research_cap"
  | "budget_exhausted"
  | "brain_unavailable"
  | "invalid_turn"
  | "invalid_domain"
  | "ack_required"
  | "invalid_request"
  | "feature_disabled"
  // Review-phase open-item resolution (§5.12): confirm refused while markers
  // remain; a keep-as-drafted strip can miss (already resolved elsewhere) or
  // be structurally impossible (the marker is the block's only content).
  | "open_items"
  | "item_not_found"
  | "needs_answer";

export interface GovernanceError {
  error: { code: GovernanceErrorCode; message: string; retriable?: boolean };
}

export function isGovernanceKind(v: unknown): v is GovernanceKind {
  return typeof v === "string" && (GOVERNANCE_KINDS as string[]).includes(v);
}
