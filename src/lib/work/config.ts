// Team work submissions (§5.16) - caps and canonical copy.
// Client-safe: constants only, no node imports, NO EM DASHES in any string
// (site rule).

export const WORK_CAPS = {
  // Upload transport. nginx allows 110m (deploy/nginx.d/governance-upload.conf,
  // shared server-wide body cap; headroom for multipart framing); these are
  // the route-enforced true limits. 10 MB -> 100 MB (owner directive
  // 2026-08-19: code repositories over 10 MB must submit). The routes read
  // the whole multipart body into memory, so one accepted upload holds up to
  // ~200 MB transiently (File + Buffer copy) in the single PM2 fork; bounded
  // by uploadAttemptsPerUserPerHour, accepted. The email lane shares this
  // constant but is really bounded lower by what mail carries (~40 MB
  // inbound); its reject copy points big packages at the web form.
  uploadMaxBytes: 100_000_000,
  skillMdMaxBytes: 1_000_000,
  // Zip hardening (inflateCapped pattern from governance/style-sample.ts).
  // 2000 -> 20000 with the 100 MB cap (2026-08-19): exceeding this REJECTS
  // the package (archive_too_complex), and a 100 MB code repo commonly has
  // >2000 files (node_modules-free trees included). Per-entry work stays
  // bounded: only .md/.txt entries (plus at most corpusHtmlMaxFiles .html,
  // below) under perEntryInflateMaxBytes are ever inflated, and
  // corpusInflateTotalMaxBytes bounds their combined inflate,
  // so 20k entries cost 20k name checks plus a capped text pass, not 20k
  // decompressions.
  zipMaxEntries: 20_000,
  perEntryInflateMaxBytes: 2_000_000,
  // Total inflated bytes across ALL text candidates in one archive
  // (extract.ts walkLevel). Without it, zipMaxEntries x
  // perEntryInflateMaxBytes = 40 GB of inflate on a hostile zip; with it the
  // walk stops inflating (ascending-size order, so the reviewed doc and the
  // corpus resolve first) and later text files are treated exactly like
  // oversized ones today: skipped for corpus and content scan. Same figure
  // as mail-screen.ts TOTAL_INFLATE_MAX.
  corpusInflateTotalMaxBytes: 64_000_000,
  manifestMaxEntries: 300,
  // "architecture.md or equivalent": minimum prose after stripping code
  // fences and front matter, and the slice of the doc the panel reads.
  archDocMinProseChars: 600,
  archDocMaxChars: 40_000,
  // Evidence corpus: matched doc in full (capped above), then remaining
  // .md/.txt files ascending by size, then the admitted .html files (below)
  // ascending by size, until this total. Source code is otherwise never
  // included. The corpus is the panel's whole universe of verifiable claims.
  corpusTotalMaxChars: 80_000,
  // Single-file HTML applications (2026-08-31). A program whose whole source
  // is one .html (markup plus inline script, no build step) has no other file
  // the panel could read: with a text allowlist of .md/.txt only, its card was
  // grounded 100% in the architecture document and the evidence critic could
  // never check a claim against the app itself. extract.ts therefore admits
  // `.html`/`.htm` entries as corpus text, under these limits: display-path
  // depth <= 1 (the matchesArchDoc depth rule), outer level only (never from
  // inside a lazily-opened inner archive), under perEntryInflateMaxBytes, and
  // at most this many per package in walk order (a site export with fifty
  // pages is not the case this serves). They ride the SAME TextFile pipeline
  // as .md/.txt (sanitize + redaction, the `buf` follows `text` rule, the gut
  // guard, both inflate budgets) and are appended to the corpus LAST, so an
  // HTML can never displace a document under corpusTotalMaxChars. An HTML
  // never satisfies a document gate: matchesArchDoc and the Skill ladder are
  // basename/.md tests, the program lane's architecture-doc requirement stays,
  // and classify.ts reads text only for .md paths.
  corpusHtmlMaxFiles: 3,
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
  // Rows GET /api/work/submissions will return, for the submitter's own list
  // and for the admin all-submissions list alike. The route asks the DB for
  // one MORE than this and reports `truncated`, because a list silently cut
  // at its cap is what made the 2026-08-07 pager's "N submissions" readout
  // assert a wrong total.
  submissionListMax: 200,
  uploadAttemptsPerUserPerHour: 10,
  panelRunsPerSubmissionPerDay: 3,
  // Global daily budgets (work_usage ledger). A run is admitted only when
  // brainCallsWorstCasePerRun still fits under the call cap, so a started
  // run can always finish. Sized so the GLOBAL caps never bite before the
  // per-user quotas (owner directive 2026-07-30 after hitting the old 6/day
  // global): 400 runs x 18 worst-case calls = 7200. Env-overridable.
  // A stage may now cost a dispatch PLUS one recovery dispatch, so the worst
  // case is 9 stage dispatches + 7 recovery dispatches (stages 4 and 5 are
  // unarmed) + 2 spare = 18. Raising this constant also tightens company
  // admission: src/lib/roadmap/db.ts admitCompanyRun checks it against the
  // ROADMAP ledger, so ROADMAP_CAPS.brainCallsPerDayDefault moves with it.
  brainCallsPerDayDefault: 7200,
  panelRunsPerDayDefault: 400,
  brainCallsWorstCasePerRun: 18,
  // Measured legitimate evidence-writer call on 2026-08-25: 75_587 ms, so the
  // old 90_000 left 14.4 s of margin on a NORMAL day. 150_000 is about 2x the
  // measured worst stage. HARD CEILING: this rides callBrain plain fetch,
  // where undici enforces an un-raisable 300 s headersTimeout, so any value
  // above 300_000 here is silently inert. A longer wait must use the re-attach
  // seam (reattachBrainTurn, node:http), never a bigger number here.
  brainTurnTimeoutMs: 150_000,
  // Recovery budget for ONE run's worth of stage failures. A pool for the
  // WHOLE run, not per stage: 9 x (150 s + 600 s) would be 90 minutes of the
  // one site-wide panel slot for one submission.
  panelRecoveryRunBudgetMs: 600_000,
  // Pause between a failed dispatch and its one recovery attempt.
  panelRecoveryDelayMs: 15_000,
  // Pool remainder below which a recovery is not worth starting.
  panelRecoveryFloorMs: 60_000,
  // Keepalive cadence while a single stage call is in flight, so a long wait
  // is not mistaken for a deploy orphan. Bounded by panelBeatBudget().
  panelBeatIntervalMs: 45_000,
  // Title inference (§5.16 email path) produces one line of output, so it must
  // not hold a slot on the voice-shared brain for the 150 s a panel stage gets.
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
 * scripts/work-tests.ts; edit with that test in mind.
 *
 * The tense clause is precise on purpose (2026-08-29 "Ticket Reply Composer"
 * incident): the old wording, "past tense for anything that ran", read to the
 * panel as a licence to describe the TOOL in the past, so a live tool
 * published as "Ticket Reply Composer was a browser-based helpdesk app" and
 * the card read as a retirement notice. A replay of the 96 published cards
 * found 27 summaries opening that way. /work shows tools people can still
 * use, so the tool is present tense and only a one-time event (a run, a
 * migration, an incident) is past. lintCard carries the deterministic half of
 * this rule for the summary opener. */
export const HOUSE_STYLE_RULES =
  "House copy rules, all mandatory: no em dashes or en dashes anywhere; no " +
  "frequency adverbs (always, never, often, usually, frequently, rarely, " +
  "constantly, typically, regularly); no URLs, email addresses, or phone " +
  "numbers; no HTML or markdown markup; plain factual prose; present tense " +
  "for what the tool is and does, because the page shows live tools; past " +
  "tense only for a one-time event such as a run, a migration, or an " +
  "incident, and never for the tool itself.";

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

/** First-party PEOPLE and PERSONAS, same register as FIRST_PARTY_NAMES
 * above (the 2026-07-30 precedent: names XL.net SHIPS are publishable,
 * organizations it SERVES are not). Owner ruling 2026-08-29/30: the
 * disclosure checklist's personal_names item held two cards on names the
 * /work page itself publishes ("introduced XL.net CEO Adam Radulovic", row
 * 859ba29b, when the skill's own template introduces him; "Leo Netter",
 * which has its own exhibit on the same page). These are the company's own
 * public faces, so clearing them is NOT a weakening of personal_names: the
 * item's default, hold any real private person, is unchanged. Enforced
 * twice, in the prompt's never-hits sentence AND deterministically in
 * panel.ts (clearFirstPartyPeople), so a model that hits anyway cannot
 * hold the card. Add here ONLY for a first-party public role or persona;
 * a client company's own people are a different owner call and never
 * belong on this list. */
export const FIRST_PARTY_PEOPLE: readonly { name: string; role: string }[] = [
  { name: "Adam Radulovic", role: "XL.net CEO, named in his public role" },
  { name: "Leo Netter", role: "XL.net AI persona" },
  { name: "Tron Netter", role: "XL.net public agent persona" },
  { name: "Troy Netter", role: "legacy alias of Tron Netter" },
  // Owner ruling 2026-08-30, during the tense-repair batch: named on the
  // IR Automation card, confirmed a persona when asked.
  { name: "Taylor Netter", role: "XL.net AI persona" },
];

/** The ONE held-outcome sentence every surface repeats (held-row UI, retry
 * 409, the submitter held email). Must read true for BOTH audiences:
 * removal is admin-only (owner directive 2026-07-30), so it describes the
 * process instead of instructing an action only admins can take. */
export const HELD_NEXT_STEPS =
  "Adam reviews held cards and will publish the draft, run the review again, " +
  "or remove it. Removing a submission is admin-only, so to change the " +
  "write-up ask Adam to remove it, then submit the corrected version.";

/**
 * Statuses a submission may be MOVED to another owner in (§5.16 transfer
 * round, 2026-08-09). ONE list, imported by both the route and the island,
 * so a control can never offer what the route refuses.
 *
 * `superseded` is deliberately absent, and it is the only interesting
 * exclusion. A superseded row is a historical generation inside a supersede
 * chain, and `updateChainEmails` walks `parent_id` UPWARD collecting each
 * ancestor's submitter_email, which `canProposeUpdate` then unions. So
 * moving a dead historical row would silently rewrite who may propose the
 * next update to the LIVE card: a live authorization change wearing the
 * clothes of an archival edit. The row's own "Submit an update" link
 * already points at the live version, which is the surface that should be
 * moved instead.
 *
 * `running` IS listed: the refusal there is temporal (a live panel run
 * addresses its outcome email to the row it read at claim time) and belongs
 * to the route, which can see the heartbeat and can say when to try again.
 */
export const TRANSFERABLE_STATUSES = [
  "received",
  "running",
  "published",
  "held",
  "failed",
  "pending_approval",
] as const;

export function isTransferableStatus(status: string): boolean {
  return (TRANSFERABLE_STATUSES as readonly string[]).includes(status);
}

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

/** Weekly storage-report kill switch (§5.16, 2026-08-19): stops ONLY the
 * usage email timer (storage-report.ts); the archive store, intake and the
 * /admin/work#storage console keep working. Default ON, drain semantics. */
export function workStorageReportEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.WORK_STORAGE_REPORT_ENABLED !== "0";
}

/** The weekly storage report's send boundary: the first Monday 14:00:00 UTC
 * STRICTLY after `afterMs`. Strict, so a stamp written exactly on a boundary
 * waits a full week instead of double-sending on the next tick. Pure (ms in,
 * ms out) and here rather than storage-report.ts so the no-DB test:work
 * suite can pin the calendar math (the drainAction precedent); all UTC, so
 * DST never moves the send hour. */
export function nextStorageReportDueMs(afterMs: number): number {
  const d = new Date(afterMs);
  // getUTCDay: Sun=0..Sat=6; days forward to Monday, 0 when already Monday.
  const daysToMonday = (1 - d.getUTCDay() + 7) % 7;
  const candidate = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() + daysToMonday,
    14
  );
  return candidate > afterMs ? candidate : candidate + 7 * 86_400_000;
}

/** Human-readable byte size for the admin storage console and the weekly
 * report. Decimal units (1 MB = 1,000,000 bytes) so the 100 MB upload cap
 * and a 100 MB stored file read as the same number; up to two decimals,
 * trailing zeros trimmed. Pure, pinned by test:work. */
export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1000) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes;
  let u = -1;
  do {
    v /= 1000;
    u++;
  } while (v >= 1000 && u < units.length - 1);
  return `${v.toFixed(2).replace(/\.?0+$/, "")} ${units[u]}`;
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

// SECRETS_DETECTED_MESSAGE was deleted on 2026-08-29, not reworded. It said
// the upload "was not accepted and nothing was stored" and told the submitter
// to resubmit, and all three of those are false under the cleaning lane. A
// near-miss refusal string left lying around is how a stale message gets
// reused by the next lane someone adds.
//
// What SURVIVES from it is the rotation duty, which is the important half and
// is still true: cleaning our copy is not an un-leak. The bytes reached this
// server exactly as sent, before any pattern ran.

/** The rotation duty, web lanes. Said ONCE per message, and never with a
 * matched value in it: the intake scan reports paths and rule names only. */
export const ROTATE_ANYWAY_WEB =
  "Rotate any real credential in them anyway: they reached our server exactly " +
  "as you sent them, and cleaning our copy does not make them secret again.";

/** The email twin. The second clause differs because on this lane it is
 * concretely checkable by the person reading it: the message they sent still
 * carries the attachment, in their Sent folder and at our mail provider. */
export const ROTATE_ANYWAY_EMAIL =
  "Rotate any real credential in them anyway: they reached our server exactly " +
  "as you sent them, and the email you sent still carries them.";

/** What the submitter is told when the intake scan cleaned their upload. The
 * claim is deliberately narrow: we say what WE did to what WE keep, never that
 * their package is now free of secrets. The scan only reads the documents it
 * can read (.md and .txt under the inflate caps) plus every filename, so
 * "your upload is clean now" would be a promise the mechanism cannot keep. */
export type CleanedKind = "credential" | "personal" | "both";

/** What the scan actually found, so the sentence is true. "Credentials" for a
 * date of birth is wrong twice over: it misdescribes the finding, and it ends
 * in an instruction to rotate something that cannot be rotated. */
function cleanedNoun(kind: CleanedKind): string {
  return kind === "personal"
    ? "personal information"
    : kind === "both"
      ? "credentials and personal information"
      : "credentials";
}

export function secretsCleanedMessage(
  count: number,
  kind: CleanedKind = "credential"
): string {
  const noun = cleanedNoun(kind);
  const lead =
    count === 1
      ? `One file in your upload looked like it carried ${noun}, so it was cleaned before anything was stored or reviewed.`
      : `${count} files in your upload looked like they carried ${noun}, so they were cleaned before anything was stored or reviewed.`;
  // Rotation is a credential instruction. A personal identifier has nothing to
  // rotate, so that lane gets the sentence that IS true of it.
  return kind === "personal"
    ? `${lead} ${REMOVED_NOT_UNSENT}`
    : `${lead} ${ROTATE_ANYWAY_WEB}`;
}

/** The personal-information counterpart of the rotation duty: there is nothing
 * to rotate, but the submitter should still know the values reached us. */
export const REMOVED_NOT_UNSENT =
  "They reached our server exactly as you sent them, so treat them as " +
  "disclosed even though our stored copy no longer has them.";

/** The receipt block for the email lane. Hoisted to the top of the reply
 * rather than filed as an "Also:" note: every other adaptation note tells the
 * sender what we did with their subject line, and this one tells them to go
 * rotate a live credential. */
export function cleaningReceiptBlock(
  paths: string[],
  kind: CleanedKind = "credential",
  count = paths.length
): string {
  const noun = cleanedNoun(kind);
  const lead =
    count === 1
      ? `About the ${noun} in your package: one file looked like it carried them, so I cleaned it before anything was stored or reviewed.`
      : `About the ${noun} in your package: ${count} files looked like they carried them, so I cleaned them before anything was stored or reviewed.`;
  return kind === "personal"
    ? `${lead} ${REMOVED_NOT_UNSENT}`
    : `${lead} ${ROTATE_ANYWAY_EMAIL}`;
}

/** When cleaning removed files and the submission then failed for a DIFFERENT
 * reason, the refusal has to say so first. A package that was one .env would
 * otherwise be told to attach the architecture document it never had, with no
 * mention of the file we took out: an accurate mechanism wired to the wrong
 * instruction, which is the worst kind of refusal this system can send. */
export function cleanedBeforeRefusalLead(paths: string[]): string {
  const list = paths.slice(0, 5).join(", ");
  const lead =
    paths.length === 1
      ? `First, one thing about the upload itself: ${list} looked like it carried credentials, so it was cleaned out of the package before anything else happened.`
      : `First, one thing about the upload itself: ${paths.length} files looked like they carried credentials (${list}), so they were cleaned out of the package before anything else happened.`;
  return `${lead} ${ROTATE_ANYWAY_WEB}`;
}

/** The row note on the submitter's own status list. The dialog message dies
 * with the dialog, and the person who most needs the instruction is the one
 * who closed the tab; rotation has no expiry, so this shows on every status
 * including published. */
export const CLEANED_ROW_NOTE =
  "Credentials were cleaned out of this upload when it arrived. Rotate any " +
  "real credential in the files below if you have not already.";

/** The admin-surface note. This is the one owner surface that exists for a row
 * which is held or failed, and therefore never sends a retention email. */
export const CLEANED_ADMIN_NOTE =
  "Cleaned at intake: credential-shaped content was taken out of these files " +
  "before this row was stored or reviewed. The submitter was told to rotate.";

// ---------------------------------------------------------------------------
// §5.16 panel stage vocabulary, progress copy, failure copy and the pure
// recovery/liveness arithmetic (2026-08-25 round). Everything below is pure
// and client-safe on purpose: the no-DB test:work suite pins it here, and the
// tracker component imports the same strings the server writes.
// ---------------------------------------------------------------------------

export const PANEL_STAGES = [
  "evidence writer",
  "voice writer",
  "structure writer",
  "evidence critic",
  "editorial critic",
  "synthesis",
  "disclosure critic",
  "adjudication",
  "repair",
] as const;
export type PanelStage = (typeof PANEL_STAGES)[number];

/** Stages whose null result FAILS or HOLDS the row, and therefore the only
 * ones recovery is armed on. 4 and 5 tolerate null by design (panel.ts), so a
 * critic can never eat the pool synthesis needs. */
export const PANEL_RECOVERABLE_STAGES: readonly PanelStage[] = [
  "evidence writer",
  "voice writer",
  "structure writer",
  "synthesis",
  "disclosure critic",
  "adjudication",
  "repair",
];

export type PanelFailReason =
  | "timeout"
  | "transport"
  | "parse"
  | "budget"
  | "no_document"
  | "crash";

export const WORK_STAGE_LABELS: Record<PanelStage, string> = {
  "evidence writer": "Reading your documents and listing what can be verified",
  "voice writer": "Rewriting the draft in the site's plain style",
  "structure writer": "Building the card's sections and its fact footer",
  "evidence critic": "Checking every claim against your documents",
  "editorial critic": "Checking the writing against the house rules",
  synthesis: "Merging the review notes into the final card",
  "disclosure critic": "Checking that nothing private made it into the card",
  adjudication: "Deciding whether a flagged name is safe to publish",
  repair: "Fixing the last wording issues",
};

/** `Step 4 of 9 · Checking every claim against your documents`. An unknown
 * stage degrades to `Step 4 of 9` with no separator, never to a blank and
 * never to a confident wrong sentence. */
export function workStageLine(
  stage: string | null,
  stageIndex: number | null,
  stageCount: number | null
): string {
  const n = (stageIndex ?? 0) + 1;
  const total = stageCount ?? PANEL_STAGES.length;
  const label =
    stage && stage in WORK_STAGE_LABELS
      ? WORK_STAGE_LABELS[stage as PanelStage]
      : null;
  return label ? `Step ${n} of ${total} · ${label}` : `Step ${n} of ${total}`;
}

/** `12s`, `4m 13s`, `1h 02m`. Clamps negatives to "0s": elapsed is a server
 * number offset by a client tick and a skewed laptop must never render
 * "-2m 14s" or "NaN". */
export function formatElapsed(ms: number): string {
  const t = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  if (t < 60) return `${t}s`;
  const m = Math.floor(t / 60);
  if (m < 60) return `${m}m ${t % 60}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export const PANEL_STEP_SLOW_MS = 120_000;
export const WORK_POLL_MS = 10_000;

export const WORK_STATUS_LABELS: Record<WorkStatus, string> = {
  received: "Waiting to start",
  running: "Reviewing",
  published: "Published",
  held: "Held for review",
  failed: "Review stopped",
  pending_approval: "Waiting for approval",
  superseded: "Replaced by an update",
};

/** EXHAUSTIVE by Record<WorkStatus,...>: a future status is a compile error,
 * not a stale sentence left frozen on a finished row. */
const TERMINAL_LINES: Record<WorkStatus, { internal: string; company: string }> =
  {
    received: { internal: "", company: "" },
    running: { internal: "", company: "" },
    published: {
      internal: "Published. Your card is live on the Our Work page.",
      company: "Published. Your card is live on your company's Your Work page.",
    },
    held: {
      internal: "Finished. A person is looking at it before it goes live.",
      company: "Finished. A person is looking at it before it goes live.",
    },
    failed: {
      internal:
        "The review stopped before it finished, so nothing published and nothing was lost.",
      company:
        "The review stopped before it finished, so nothing published and nothing was lost.",
    },
    pending_approval: {
      internal: "Finished. It is waiting for Adam to approve the swap.",
      company:
        "Finished. It is waiting for approval before the live card changes.",
    },
    superseded: {
      internal: "Replaced by a newer version of this card.",
      company: "Replaced by a newer version of this card.",
    },
  };

export function workTerminalLine(
  status: string,
  lane: "internal" | "company"
): string {
  const row = TERMINAL_LINES[status as WorkStatus];
  return row ? row[lane] : "";
}

export function isTerminalWorkStatus(status: string): boolean {
  return status !== "received" && status !== "running";
}

const PANEL_FAIL_CAUSE: Record<PanelFailReason, string> = {
  timeout:
    "The review pipeline was busy with another job and did not answer in time, so this review stopped. Nothing is wrong with your submission.",
  transport:
    "The review pipeline could not be reached, so this review stopped. Nothing is wrong with your submission.",
  parse:
    "The review pipeline returned an answer this site could not read, so the review stopped.",
  budget:
    "The review pipeline reached its daily call limit, so it stopped rather than start work it could not finish.",
  no_document:
    "The review could not start because no readable document text was stored with this submission.",
  crash: "The review stopped unexpectedly.",
};

/** The ONE builder for panel_error. Its output is submitter-safe plain prose
 * (view.ts projects panel_error verbatim to the submitter and /admin/work
 * renders it raw), and it names the step with the SAME label the progress line
 * uses, so the failure line and the progress line can never call one step two
 * names. NO machine tag is prepended: the only thing that ever wanted one was
 * a SQL LIKE for auto-retrying failed rows, and that lane is cut. */
export function panelFailMessage(
  stage: string | null,
  reason: PanelFailReason
): string {
  const base = PANEL_FAIL_CAUSE[reason];
  const idx = (PANEL_STAGES as readonly string[]).indexOf(stage ?? "");
  if (idx < 0) return base;
  const label = WORK_STAGE_LABELS[PANEL_STAGES[idx]];
  return `${base} It stopped at step ${idx + 1} of ${PANEL_STAGES.length}, ${label.charAt(0).toLowerCase()}${label.slice(1)}.`;
}

/** Lane-branched like HELD_NEXT_STEPS and notifyHeld: company copy NEVER names
 * Adam, /admin, or /work/submit (scope.ts rule). test:work asserts it. */
export const FAILED_NEXT_STEPS: Record<"internal" | "company", string> = {
  internal:
    "Retry review runs the panel again on the files you already uploaded. It cannot pick up a replacement file; to change the files, ask Adam to remove this row, then submit the corrected version.",
  company:
    "Retry review runs the panel again on the files you already uploaded. The XL.net team can clear this row if you need to send a corrected package.",
};

/** The ONE outcome promise, now TRUE in all three terminal states because
 * notifyPanelFailed ships in this commit. Used verbatim by
 * submission-form.tsx, work-submit-dialog.tsx, /work/submit/page.tsx, the
 * roadmap work page, work-islands.tsx and both email-intake receipts. */
export const EMAIL_PROMISE =
  "You get an email when the card publishes, when it is held for a person to look at, or if the review cannot finish.";

export const WORK_QUEUE_REASON_COPY: Record<string, string> = {
  deploy:
    "A site update is finishing right now. Your review starts on its own as soon as it is done.",
  busy: "Another review is running. Yours starts on its own when that one finishes.",
  brain:
    "The writing service is not answering right now. Your review starts on its own once it is back.",
  budget:
    "The review pipeline is at its limit for today. Your review starts on its own when capacity returns.",
  disabled: "Reviews are paused right now. Yours stays in the queue.",
};

/** null, "claim", or any unmapped token renders the generic sentence, so an
 * internal reason token can never reach a screen. */
export function queueWaitCopy(reason: string | null): string {
  return (
    (reason && WORK_QUEUE_REASON_COPY[reason]) ||
    "Waiting for its turn. The queue checks every minute and starts it on its own."
  );
}

export const QUEUE_TICK_MS = 60_000;
export const QUEUE_BOOT_DELAY_MS = 15_000;
export const QUEUE_FAST_RETRY_MS = 15_000;
export const QUEUE_FAST_RETRY_MAX = 8;
export const QUEUE_SIGNAL_TTL_MS = 180_000;

/** Moved OUT of queue-drain.ts so the no-DB test:work suite can pin it against
 * panelWorstCaseRunMs(). 30 min would now trip on a healthy worst-case run and
 * log an incident-shaped line on a normal path. */
export const PANEL_PASS_TAKEOVER_MS = 45 * 60_000;

/** Max beats one stage's pump may fire, derived from that stage's OWN
 * worst-case budget. THE BOUND IS THE POINT: an unbounded pump makes
 * panel_heartbeat_at unable to go stale, and that column is the only liveness
 * detector the panel has (anotherPanelRunning, queuedWorkCandidates). A stage
 * whose promise never settles would then beat forever, every other kickPanel
 * would refuse busy, drainAction maps busy to stop, and NO row in ANY lane
 * would run again until pm2 restarts. Bounded, a hung stage stops beating and
 * goes stale in 240 s exactly as today. */
export function panelBeatBudget(
  perCallMs: number = WORK_CAPS.brainTurnTimeoutMs,
  caps = WORK_CAPS
): number {
  const span = perCallMs + caps.panelRecoveryDelayMs + caps.panelRecoveryRunBudgetMs;
  return Math.ceil(span / caps.panelBeatIntervalMs) + 1;
}

/** One missed beat from a DB blip still must not orphan a live row. */
export function heartbeatPumpSafe(caps = WORK_CAPS): boolean {
  return caps.panelBeatIntervalMs * 2 + 30_000 <= caps.panelStaleMs;
}

export function panelWorstCaseRunMs(caps = WORK_CAPS): number {
  return (
    PANEL_STAGES.length * caps.brainTurnTimeoutMs +
    caps.panelRecoveryRunBudgetMs +
    PANEL_STAGES.length * caps.panelRecoveryDelayMs
  );
}

export function panelBrainCallsWorstCase(): number {
  return PANEL_STAGES.length + PANEL_RECOVERABLE_STAGES.length;
}

/** The recovery decision, pure so test:work pins it (the drainAction
 * precedent). cacheRetentionMs is INJECTED
 * (BRAIN_PROMPT_CACHE_RETENTION_MS from the module) so config.ts keeps zero
 * imports and stays client-safe. */
export function panelRecoveryPlan(o: {
  reason: PanelFailReason;
  recoverable: boolean;
  dispatchedAtMs: number;
  nowMs: number;
  poolRemainingMs: number;
  cacheRetentionMs: number;
  caps?: typeof WORK_CAPS;
}): {
  attempt: boolean;
  mode: "reattach" | "redispatch";
  budgetMs: number;
  why: string;
} {
  const caps = o.caps ?? WORK_CAPS;
  const no = (why: string) => ({
    attempt: false,
    mode: "redispatch" as const,
    budgetMs: 0,
    why,
  });
  if (!o.recoverable) return no("stage tolerates a null result");
  if (o.reason === "budget") return no("a ledger refusal needs the day to roll");
  if (o.reason !== "timeout" && o.reason !== "transport" && o.reason !== "parse")
    return no("not a brain-call failure");
  if (o.poolRemainingMs < caps.panelRecoveryFloorMs)
    return no("run recovery pool spent");
  if (o.reason === "timeout") {
    // Past this guard the brain's prompt cache is certain to MISS, so a re-POST
    // starts a SECOND fully billed generation instead of replaying the first.
    if (o.nowMs - o.dispatchedAtMs >= o.cacheRetentionMs - 300_000)
      return no("prompt cache would miss");
    return {
      attempt: true,
      mode: "reattach",
      budgetMs: Math.min(caps.panelRecoveryRunBudgetMs, o.poolRemainingMs),
      why: "same promptId re-attach to a turn the brain may already have finished",
    };
  }
  return {
    attempt: true,
    mode: "redispatch",
    budgetMs: Math.min(caps.brainTurnTimeoutMs, o.poolRemainingMs),
    why: "the socket died or the answer was unusable, so ask again",
  };
}
