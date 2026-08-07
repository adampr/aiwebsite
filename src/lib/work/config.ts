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
  // Raised 900 -> 5000 (owner directive 2026-08-06). Safe because the blurb
  // is context-only and panel prompts slice at blurbPromptMaxChars.
  blurbMaxChars: 5000,
  // Email intake only (§5.16 natural-email round, 2026-08-03): people write
  // normally by email, so the acceptance band is wider than the form's
  // (which enforces its cap live). Stored VERBATIM (uncapped text column; the
  // blurb is context-only, never published); panel prompts slice instead.
  // Raised with blurbMaxChars 2026-08-06 to keep the email band the wider one.
  emailBlurbMaxChars: 10_000,
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

/** Marker age past which `deployInProgress()` stops believing there is a live
 * deploy (governance/db.ts uses the same 30 minutes; a crashed deploy leaves
 * the marker behind deliberately and it ages out over this TTL). Pinned
 * against that file by a source scrape in test:work. */
export const DEPLOY_MARKER_TTL_MS = 1_800_000;

/** How long after the marker's last touch a process start can still be the
 * CUTOVER's restart rather than an unrelated one.
 *
 * Derivation, not a guess. Measured gap on the 2026-08-07 15:51 deploy:
 * 1.0 s (marker 15:51:08.607, next-server 15:51:09). The bracket between the
 * :575 touch and `pm2 startOrReload` is only the stage rename plus the
 * reload, because this host has no deploy/extra-services.json to stop and
 * start; the reload's own worst case is pm2's `kill_timeout` (default
 * 1600 ms before SIGKILL) plus a spawn. Add the ~0.7 s process.uptime()
 * bias and the realistic ceiling is a few seconds.
 *
 * Kept DELIBERATELY tight rather than generous, because the thing it must
 * exclude is closer than it looks: setup-vm.sh touches at :531 and starts
 * the staged build on the very next line, so a pm2/earlyoom restart seconds
 * into a build is only seconds after a touch. A wider bound would misread
 * more of those as cutovers. Erring tight costs only that the gate stays
 * shut and the queue waits as it did before 2026-08-07. */
export const CUTOVER_RESTART_MAX_GAP_MS = 10_000;

/** Should a panel run be refused because a deploy is mid-flight?
 *
 * The naive answer, and what kickPanel asked until 2026-08-07, is "yes
 * whenever the marker is fresh". That idles the queue for the WHOLE deploy:
 * the owner's "Queuebot" row was created 135 ms after a deploy took the lock
 * and published 15 min 14 s later, the moment the marker cleared, with no
 * panel work done in between.
 *
 * Most of that window is not dangerous. `deploy/setup-vm.sh` re-touches the
 * marker before every phase, and its LAST touch (line 575) sits immediately
 * before the cutover bracket; after `pm2 startOrReload` the marker is never
 * touched again, only removed (line 1152). Nothing else on the box writes it
 * (deploy.sh:325 creates it; the watchdog and hi-speed.sh only stat it). So
 * a marker that has NOT been touched since this process started belongs to a
 * deploy that has already restarted this process: the live-tree flip and the
 * migrations are behind it, and everything it has left to do (crawler config
 * snapshot, persona seeds, ops scripts, systemd timer units, initial crawl,
 * watchdog install, version stamp) is inert with respect to a panel run, with
 * ONE exception the review panel was right to name: the post-cutover health
 * gate (setup-vm.sh:596-622) can fail 120-360 s after the flip and restart
 * the app again to roll back. A run admitted in that window dies there and
 * lands in the stale-running orphan class the drain already recovers. Waiting
 * the gate out before admitting would consume the entire post-cutover tail
 * this exists to reclaim, so it is an accepted residual, not an oversight.
 *
 * Comparing against the touch time rather than the marker's creation time is
 * deliberate. Birthtime would give a multi-minute margin instead of the
 * measured 1.0 s between the pre-cutover touch and the pm2 restart, but it
 * survives `touch`, so under OVERLAPPING deploys (four ran in 26 minutes on
 * 2026-08-07, two with their builds killed) it would still name the FIRST
 * deploy's start and admit runs while a second deploy marched toward its own
 * cutover. A live deploy re-touches every phase, so the touch comparison
 * closes that gate again. The 1.0 s margin is structural, not luck: the
 * touch strictly precedes the flip and the restart in the script.
 *
 * "Started after the last touch" is necessary but NOT sufficient, and the
 * review panel was right to push on it: `deploy/ecosystem.config.cjs` runs
 * the app with `autorestart: true` and `max_memory_restart: '1G'`, so pm2 or
 * earlyoom can restart it for reasons that have nothing to do with a
 * cutover. A crash restart mid-build would otherwise open this gate for the
 * rest of the build, which is the one case the design set out to avoid. So
 * the start must also land WITHIN CUTOVER_RESTART_MAX_GAP_MS of the touch:
 * the cutover's restart follows its touch within about a second, while any
 * other restart is minutes deep into a phase. That bound also re-closes the
 * gate after the post-cutover health gate's rollback restart
 * (setup-vm.sh:596-622 fails 120-360 s after the flip, far outside the gap).
 *
 * Pure (numbers in, boolean out) so test:work can pin it without a DB, a
 * filesystem or a clock. Passing Infinity for processStartedAtMs reproduces
 * the older, wider `deployInProgress()` behaviour exactly, which is how the
 * admin re-run lane keeps it.
 */
export function deployBlocksPanelRun(
  /** Marker mtime in ms, or null when the marker does not exist. */
  markerTouchedAtMs: number | null,
  /** When THIS process started, in ms since epoch. */
  processStartedAtMs: number,
  nowMs: number
): boolean {
  if (markerTouchedAtMs === null) return false;
  // Same TTL and same strict comparison as deployInProgress(): a marker this
  // old means a deploy died without cleaning up, not that one is running.
  if (nowMs - markerTouchedAtMs >= DEPLOY_MARKER_TTL_MS) return false;
  const sinceTouch = processStartedAtMs - markerTouchedAtMs;
  // Ties block. `Date.now() - process.uptime()*1000` over-estimates process
  // start by ~700 ms (measured against /proc/self/stat: Node's uptime clock
  // starts after fork+exec+V8 init), which biases toward admitting, so the
  // one comparison that is free to be conservative should be.
  if (sinceTouch <= 0) return true;
  return sinceTouch > CUTOVER_RESTART_MAX_GAP_MS;
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
