// Team work submissions (§5.16) - caps and canonical copy.
// Client-safe: constants only, no node imports, NO EM DASHES in any string
// (site rule).

export const WORK_CAPS = {
  // Upload transport. nginx allows 12m (deploy/nginx.d/governance-upload.conf,
  // shared server-wide body cap); these are the route-enforced true limits.
  uploadMaxBytes: 10_000_000,
  skillMdMaxBytes: 1_000_000,
  // Zip hardening (inflateCapped pattern from governance/style-sample.ts).
  zipMaxEntries: 2000,
  perEntryInflateMaxBytes: 2_000_000,
  manifestMaxEntries: 300,
  // "architecture.md or equivalent": minimum prose after stripping code
  // fences and front matter, and the slice of the doc the panel reads.
  archDocMinProseChars: 600,
  archDocMaxChars: 40_000,
  // Evidence corpus: matched doc in full (capped above), then remaining
  // .md/.txt files ascending by size until this total. Source code is never
  // included. The corpus is the panel's whole universe of verifiable claims.
  corpusTotalMaxChars: 80_000,
  // Form fields. The description has NO minimum anywhere (owner directive
  // 2026-08-05: the submitted documents are sufficient to describe the tool;
  // the description is context-only and never published). blurbMinChars
  // survives ONLY as the email receipt's "short note" disclosure threshold.
  titleMinChars: 4,
  titleMaxChars: 60,
  blurbMinChars: 80,
  blurbMaxChars: 900,
  // Email intake only (§5.16 natural-email round, 2026-08-03): people write
  // normally by email, so the acceptance band is far wider than the form's
  // (which has a live counter). Stored VERBATIM (uncapped text column; the
  // blurb is context-only, never published); panel prompts slice instead.
  emailBlurbMaxChars: 4000,
  // The slice of the description a panel prompt carries (lint.ts
  // blurbPromptBlock). Bounds description growth in the 80k-char prompt
  // corpus without trimming what is stored.
  blurbPromptMaxChars: 2000,
  attributionMaxChars: 20,
  // Quotas. Per-user submissions/day is counted from work_submissions rows
  // (durable across restarts); the attempts limiter is in-memory CPU
  // protection only.
  // Owner directives 2026-07-30: 20/day regular staff, 200/day for admins,
  // and failed submissions do not count (enforced in countCreatedToday).
  submissionsPerUserPerDay: 20,
  submissionsPerAdminPerDay: 200,
  uploadAttemptsPerUserPerHour: 10,
  panelRunsPerSubmissionPerDay: 3,
  // Global daily budgets (work_usage ledger). A run is admitted only when
  // brainCallsWorstCasePerRun still fits under the call cap, so a started
  // run can always finish. Sized so the GLOBAL caps never bite before the
  // per-user quotas (owner directive 2026-07-30 after hitting the old 6/day
  // global): 240 runs x 10 worst-case calls = 2400. Env-overridable.
  brainCallsPerDayDefault: 2400,
  panelRunsPerDayDefault: 240,
  brainCallsWorstCasePerRun: 10,
  brainTurnTimeoutMs: 90_000,
  // Title inference (§5.16 email path) produces one line of output, so it must
  // not hold a slot on the voice-shared brain for the 90 s a panel stage gets.
  titleInferTimeoutMs: 20_000,
  titleInferPerSenderPerHour: 3,
  // A running claim whose heartbeat is older than this is an orphan
  // (PM2 restart mid-panel) and is reclaimable via retry.
  panelStaleMs: 240_000,
  transcriptJsonMaxBytes: 60_000,
  // Card copy bands. Measured against the 24 hand-authored exhibits on
  // 2026-07-29 (scripts/work-tests.ts records the method): visible words
  // per card cluster between roughly 150 and 560 after the card-uniformity
  // pass; community cards have no <details> escape hatch, so the band is
  // set against visible text only.
  summaryMinWords: 40,
  summaryMaxWords: 90,
  bodyParagraphsMin: 1,
  bodyParagraphsMax: 2,
  paragraphMaxWords: 120,
  facetLabelMaxChars: 28,
  facetTextMinWords: 25,
  facetTextMaxWords: 70,
  footerFragmentsMin: 2,
  footerFragmentsMax: 5,
  footerFragmentMaxChars: 60,
  cardMinWords: 140,
  cardMaxWords: 560,
} as const;

/** Badge slot 2 vocabulary: a category, never a claim (editorial rule).
 * The status badge is NOT model-chosen: every community card renders the
 * constant "Built". Adding a badge here? Extend TITLE_KIND_PREFIX_RE below
 * so a "New Badge: X" title prefix is caught at intake and lint. */
export const CATEGORY_BADGES = [
  "Claude Skill",
  "CoWork Skill",
  "Internal tool",
  "Browser app",
  "Automation",
  "CLI tool",
  "Integration",
  "Report generator",
  "Documentation tool",
] as const;

/** Category/kind prefixes that duplicate the badge when they lead a title
 * ("Claude Skill: Slack Knowledge Assistant", 2026-07-31 incident). Covers
 * every CATEGORY_BADGES value plus bare "skill", "program", "tool"; a
 * separator (colon, or a spaced hyphen/middot) is required so titles that
 * merely contain badge words ("Skill Builder Dashboard", "Automation
 * Station") never match. Shared by intake stripping (subject-derived
 * titles), intake rejection (authored titles), and the lint backstop. */
export const TITLE_KIND_PREFIX_RE =
  /^\s*(?:(?:claude|cowork|co work)\s+skill|skill|code\s+program|program|internal\s+tool|browser\s+app|automation|cli\s+tool|integration|report\s+generator|documentation\s+tool|tool)\s*(?::\s*|\s[-·]\s)/i;

/** Panel prompt rule strings (2026-07-31 meta-commentary incident): the
 * style rules and the evidence rules are separate because the editorial
 * critic and the repair stage are docs-blind by design; feeding a stage an
 * evidence mandate it cannot execute is what produced the published
 * "no supporting source document was submitted" cards. Stages that see the
 * documents get HOUSE_RULES; docs-blind stages get HOUSE_STYLE_RULES only.
 * The concatenation is asserted byte-identical to the pre-split literal in
 * scripts/work-tests.ts; edit with that test in mind. */
export const HOUSE_STYLE_RULES =
  "House copy rules, all mandatory: no em dashes or en dashes anywhere; no " +
  "frequency adverbs (always, never, often, usually, frequently, rarely, " +
  "constantly, typically, regularly); no URLs, email addresses, or phone " +
  "numbers; no HTML or markdown markup; plain factual prose; past tense for " +
  "anything that ran.";

export const HOUSE_EVIDENCE_RULES =
  "every claim must be supported by the submitted " +
  "documents; claims must not outrun the evidence.";

export const HOUSE_RULES = `${HOUSE_STYLE_RULES.slice(0, -1)}; ${HOUSE_EVIDENCE_RULES}`;

/** First-party names the disclosure critic must never flag (2026-07-30
 * calibration: the pipeline held its own badge vocabulary and the owner's
 * own offering name). Add here when XL.net ships a new named offering; the
 * list is interpolated into the disclosure prompt. */
export const FIRST_PARTY_NAMES = [
  "XL.net",
  "Secure+",
  "Anthropic",
  "Claude",
  "Claude Skill",
  "CoWork Skill",
  "Claude Code",
];

/** The ONE held-outcome sentence every surface repeats (held-row UI, retry
 * 409, the submitter held email). Must read true for BOTH audiences:
 * removal is admin-only (owner directive 2026-07-30), so it describes the
 * process instead of instructing an action only admins can take. */
export const HELD_NEXT_STEPS =
  "Adam reviews held cards and will publish the draft, run the review again, " +
  "or remove it. Removing a submission is admin-only, so to change the " +
  "write-up ask Adam to remove it, then submit the corrected version.";

/** Frequency adverbs are banned in visible card copy (editorial rule 27). */
export const BANNED_ADVERBS = [
  "always",
  "never",
  "often",
  "usually",
  "frequently",
  "rarely",
  "constantly",
  "typically",
  "regularly",
];

/** TIER 1, never the reviewed SKILL doc by uniqueness: project furniture
 * that says nothing about what the Skill is. Unchanged since 2026-07-30; a
 * package carrying ONLY these resolves to no doc, which is the intent. */
export const BOILERPLATE_MD_BASENAMES =
  /^(readme|license|licence|changelog|contributing|code_of_conduct)\./i;

/** TIER 2, DEMOTED, not excluded (owner directive 2026-08-05: extra files
 * besides the Skill and its doc are to be ignored, not a reason to reject).
 * These are set aside ONLY when a better candidate exists, so a Skill zipped
 * alongside its architecture.md resolves to the other file instead of
 * dead-ending as "ambiguous" - while a package whose ONLY document is an
 * architecture doc keeps resolving to it exactly as before. Skill-kind only;
 * for kind "program" an architecture doc IS the reviewed doc (matchesArchDoc).
 * Shared by extract.ts (in-archive candidates) and email-parse.ts (attachment
 * selection) so the two lanes cannot drift. */
export const SUPPORT_MD_BASENAMES =
  /^(architecture|arch|design|readme-architecture)\./i;

export type WorkKind = "skill" | "program";

/** User-facing kind names (owner directive 2026-07-29: "Skill" is a noun and
 * capitalized; "Code program" is AI-agnostic). DB enum values never change. */
export const KIND_LABELS: Record<WorkKind, string> = {
  skill: "CoWork Skill",
  program: "Code program",
};
export function isWorkKind(v: unknown): v is WorkKind {
  return v === "skill" || v === "program";
}

export type WorkStatus =
  | "received"
  | "running"
  | "published"
  | "held"
  | "failed"
  // §5.16 updates: an update row that passed the panel and waits for the
  // admin swap click; nothing public changes until approval.
  | "pending_approval"
  // A former published card replaced by an approved update; the rollback
  // reservoir. Renders nowhere (publishedCards filters status=published).
  | "superseded";

/** Kill switch (governanceEnabled pattern: default ON, set "0" to stop
 * intake and panel admission; already-published cards keep rendering). */
export function workSubmissionsEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.WORK_SUBMISSIONS_ENABLED !== "0";
}

export function workBrainDailyCap(env: NodeJS.ProcessEnv): number {
  const n = Number(env.WORK_BRAIN_DAILY_CAP);
  return Number.isFinite(n) && n > 0 ? n : WORK_CAPS.brainCallsPerDayDefault;
}

export function workPanelRunsDailyCap(env: NodeJS.ProcessEnv): number {
  const n = Number(env.WORK_PANEL_RUNS_DAILY_CAP);
  return Number.isFinite(n) && n > 0 ? n : WORK_CAPS.panelRunsPerDayDefault;
}

/** Queue-drain kill switch (§5.16, 2026-08-05): stops ONLY the automatic
 * re-kick timer; intake and the manual Retry lever keep working. The
 * narrower lever next to WORK_SUBMISSIONS_ENABLED. Default ON. */
export function workQueueDrainEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.WORK_QUEUE_DRAIN_ENABLED !== "0";
}

export type DrainAction = "stop" | "skip";

/** Stop-vs-skip per kickPanel refusal reason for the §5.16 queue drain
 * (design-panel table, 2026-08-05). Pure and here (not queue-drain.ts) so
 * the no-DB test:work suite can pin it. Global conditions stop the pass;
 * per-row or per-lane conditions skip to the next candidate. The two
 * lane-dependent reasons: "budget" is the global work_usage ledger for
 * internal rows (every later internal row would refuse identically, so
 * stop) but the company's own roadmap ledger for company rows (must not
 * stall the /work queue, so skip); "disabled" for a company row can mean
 * only roadmapEnabled is off while work submissions stay on, so it skips
 * too, while for an internal row it is the global kill switch. */
export function drainAction(
  reason: "disabled" | "deploy" | "budget" | "busy" | "claim" | "brain",
  isCompanyRow: boolean
): DrainAction {
  switch (reason) {
    case "deploy":
    case "brain":
    case "busy":
      return "stop";
    case "budget":
    case "disabled":
      return isCompanyRow ? "skip" : "stop";
    case "claim":
      return "skip";
  }
}

/** The exact rejection copy for a program zip without an architecture doc
 * (owner requirement: reject and instruct). */
export const MISSING_ARCH_DOC_MESSAGE =
  "Your zip needs an architecture document before the panel can review it. " +
  "Include an architecture.md (or ARCHITECTURE.md, design.md, or a README.md " +
  "with an Architecture section) at the top level or one folder deep. It " +
  "should explain what the program does, its main components, and how data " +
  "flows between them, at least a few paragraphs. Add the file and resubmit.";

export const MISSING_SKILL_DOC_MESSAGE =
  "The panel could not find your Skill's SKILL.md anywhere in what you " +
  "uploaded. Fix it any of three ways: put SKILL.md at the top level of the " +
  "package, zip the .skill together with its .md file into one .zip, or " +
  "attach the .md in the second upload field. It should carry the Skill's " +
  "name, description, and instructions, at least a few paragraphs. Note a " +
  "SKILL.md over 2 MB inside a package cannot be read; attach it in the " +
  "second field instead (limit 1 MB) or trim it. Then resubmit.";

export const SKILL_DOC_TOO_SHORT_MESSAGE =
  "The panel found your Skill's document but it is too short to review. It " +
  "needs the Skill's name, description, and instructions, at least a few " +
  "paragraphs. Expand it and resubmit.";

export const AMBIGUOUS_SKILL_DOC_MESSAGE =
  "Several .md files could be the Skill's document and none is named " +
  "SKILL.md. Rename the one the panel should review to SKILL.md, or attach " +
  "it in the second upload field, then resubmit.";

export const SECRETS_DETECTED_MESSAGE =
  "Your upload contains files that look like credentials, so it was not " +
  "accepted and nothing was stored. Remove the listed files, rotate any real " +
  "credential in them (it left your machine when you uploaded), then resubmit.";
