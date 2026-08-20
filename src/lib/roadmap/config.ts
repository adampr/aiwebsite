// Your AI Roadmap (§5.18) - caps, kill switch, and canonical copy.
// Client-safe: constants and pure env readers only, NO EM DASHES in any
// string (site rule). Pattern: src/lib/work/config.ts.

// Pure constant from a pure module (client-safe both sides): the step-06
// blurb speaks the claim cap so copy and enforcement can never drift.
import { REQUEST_CAPS } from "@/lib/work/requests-config";

export const ROADMAP_CAPS = {
  // Client-lane submission quotas, applied to BOTH the web form and the
  // email lane (one quota story per audience; staff keep 20/200 per day).
  clientSubmissionsPerUserPerDay: 5,
  companySubmissionsPerDay: 10,
  clientUploadAttemptsPerUserPerHour: 6,
  // Per-company ceilings on brain-adjacent email work: replies the intake
  // may send (bounds a compromised org rotating senders into a reply
  // flood) and title-inference calls (bounds a no-usable-title flood that
  // creates no rows and so never trips the submission quotas).
  companyEmailRepliesPerHour: 20,
  companyTitleInfersPerDay: 10,
  // Pre-DKIM claim bound for the company branch only (forged-From spam at a
  // registered domain must not farm receiving.get); staff mail is never
  // bounded pre-DKIM.
  companyEmailDetectPerDomainPerHour: 60,
  // Portal write limits.
  bootstrapPerUserPerDay: 5,
  adminRequestPerUserPerDay: 2,
  adminRequestPerCompanyPerDay: 5,
  adminApprovePerUserPerHour: 10,
  // 3, not 2 (round 3): the directory AUTO-init draws from this same bucket
  // (one fence, no bypass lane) and a failed auto-kick must never cost the
  // admin their manual retries; the auto lane additionally has its own
  // 1/h sub-limit below.
  apolloImportsPerCompanyPerHour: 3,
  apolloAutoKicksPerCompanyPerHour: 1,
  apolloPagesPerImport: 5, // hard cap; a partial import reports itself
  apolloPeoplePerPage: 100,
  // WINDOW SHAPE IS THE RULE, not the number (2026-08-09 directory round).
  // Per-HOUR windows are for calls with EXTERNAL cost: Apollo pages, DNS
  // resolution, outbound email, brain spend (apolloImports*, dkim*,
  // docWrites). Per-MINUTE windows are for local-only single-row writes.
  // A directory write is one statement against loopback Postgres, and the
  // limiter's window is FIXED from its first request, so the old 60/HOUR
  // locked an admin clearing a bad Apollo import out for up to 59 minutes
  // (the owner's report). At 60/minute the same mistake self-heals in 60
  // seconds, which is the only wait "Give it a moment" was ever honest for.
  // ONE bucket for add + edit + remove: the key is about the actor, not the
  // verb.
  directoryWritesPerUserPerMinute: 60,
  // Bulk keeps its OWN key so one sweep can never spend the single-write
  // budget and lock the Add form. It is sized the SAME as single writes
  // because the client CHUNKS a selection into directoryBulkRemoveMax-sized
  // requests, so request count tracks SELECTION SIZE, not intent: a 250-row
  // selection is three requests, and at the default 10-row page ten
  // select-all-page sweeps spent a 10-request bucket in about fifty seconds,
  // which would have reproduced the reported lockout through the very
  // feature built to fix it. The damage bound is directoryBulkRemoveMax per
  // request plus the admin gate, never the request count: an actor holding
  // an admin session clears the whole render cap in about two minutes at any
  // of these settings.
  directoryBulkRemovesPerUserPerMinute: 60,
  // Ids per bulk-remove call. 100 = the Apollo page size, so "one bad page"
  // is one request and a full 500-row import clears in five.
  directoryBulkRemoveMax: 100,
  docWritesPerUserPerHour: 6,
  portalReadsPerUserPerHour: 240,
  // DKIM email-lane checks (§5.18 round 2; since the six-step round these
  // are a sub-surface of Submit AI-Built Work, not their own step). Status
  // reads get their own key (a cache miss triggers outbound DNS); the
  // per-company recheck cap bounds a tenant's total DNS traffic regardless
  // of headcount; the email caps are tight because the route sends mail.
  // 120 (round 3): the Initializing poll loop reads status up to 10 times
  // per episode; reads are cheap (concurrent polls join the in-flight
  // resolution and cache hits do no DNS).
  dkimStatusReadsPerUserPerHour: 120,
  dkimRechecksPerUserPerHour: 6,
  dkimRechecksPerCompanyPerHour: 12,
  dkimEmailsPerUserPerDay: 3,
  dkimEmailsPerCompanyPerDay: 10,
  // Governance doc upload (nginx allows 12m server-wide; this is the
  // route-enforced true limit).
  docUploadMaxBytes: 10_000_000,
  docTitleMaxChars: 120,
  // Directory render cap. The page pager (10/50/250) windows CLIENT-side over
  // rows the server already truncated here, so this is not a display limit:
  // listPeople is the only read path, and a row past it has no id on the
  // client, cannot be edited or removed, and (via scorecardRows) loses its
  // directory identity on the scorecard. So it sits ABOVE any reachable
  // directory rather than at a comfortable page size: 4x the largest single
  // Apollo import (5 pages x 100), ~240 KB of RSC payload at ~120 bytes/row,
  // which a single 4 GB fork carries fine. It stays BOUNDED on purpose.
  // TRIGGER for the next architectural step: if a real directory ever
  // approaches 2000, move to SERVER-side pagination (cursor in the URL,
  // selection model spanning fetches) rather than raising this again. When
  // it does truncate, the page says so (page.tsx passes countPeople as
  // `total`); silent truncation is the state this comment used to permit.
  directoryRenderMax: 2000,
  // Phases 09/10/11 (§5.20). URL reachability checks reach a THIRD-PARTY
  // server, so they take a per-HOUR window by the WINDOW SHAPE rule above
  // (external cost), and they get a per-company ceiling as well as a
  // per-user one: the per-user key alone would let a company with many
  // admins aim three times the traffic at one target through us. Saving the
  // row itself is one statement against loopback Postgres, so it takes a
  // per-MINUTE window like the directory writes.
  urlChecksPerUserPerHour: 30,
  urlChecksPerCompanyPerHour: 60,
  platformWritesPerUserPerMinute: 60,
  // Tool cards per lane. The page pages CLIENT-side over rows the server
  // already truncated at this number, exactly as the directory does, so it
  // sits ABOVE any plausible real list rather than at a comfortable page
  // size, and the page SAYS SO when it truncates.
  toolsMax: 100,
  toolLabelMaxChars: 120,
  toolDescriptionMaxChars: 600,
  // Hosting environments on the Developer VMs component: a multi-select
  // with free-form entries, so both the count and each label are bounded.
  environmentsMax: 12,
  environmentLabelMaxChars: 60,
  // HYSTERESIS window (§5.20 round 2). When a field that was counting starts
  // failing, it keeps counting for this long instead of dropping the step at
  // the first bad minute. Sized so a weekend outage on a customer's server
  // does not silently cost them a step before anyone is at a desk to see it,
  // while a genuinely dead endpoint still stops counting within days. The
  // window is NOT extended by later failures, or it would slide forever.
  linkGraceHours: 72,
  // How stale a decided field may get before the nightly job re-examines it.
  // Rung 1 costs an outbound HTTP request, rung 2 costs one DNS lookup, and
  // an attestation is a human claim and is never re-probed at all.
  recheckReachedAfterHours: 24 * 7,
  recheckInternalAfterHours: 24 * 7,
  // Wall clock one nightly run may spend. The loop is sequential and a
  // field can cost the checker's full budget, so without this a batch of
  // dead hosts would run past the unit's TimeoutStartSec and be SIGTERMed,
  // paging an operator about a slow night rather than a broken one.
  recheckRunBudgetMinutes: 20,
  // Rows one nightly run may examine. A hard ceiling on both our outbound
  // traffic and the run's wall clock; whatever is skipped is simply the
  // stalest next time, because selection is oldest-checked-first.
  recheckBatchMax: 200,
  // Fields ONE lane may consume in a single nightly run. A lane can hold
  // more checkable fields than a whole batch (toolsMax x 2 + singletons),
  // so without this cap one large tenant would occupy every run and every
  // other company's links would never be re-examined.
  recheckPerLaneMax: 25,
  // Admin-access requests expire after 7 days; non-approval reads as
  // expiry, after which the request button re-arms.
  adminRequestTtlDays: 7,
  // Global daily budgets (roadmap_usage ledger; work_usage stays the staff
  // ledger). Company panel runs and title inference draw BOTH ledgers, so
  // the whole client population can never consume more than this slice of
  // the shared brain.
  brainCallsPerDayDefault: 600,
  panelRunsPerDayDefault: 60,
  apolloCallsPerDayDefault: 100,
} as const;

/** Kill switch (workSubmissionsEnabled pattern: default ON, set "0" to stop
 * WRITES: bootstrap, admin requests/approvals, Apollo import, directory and
 * doc mutations, company web submit and panel admission, and the company
 * branch of the email intake, which then delegates to conversational Tron.
 * Reads stay up: hiding a company's own data creates support pain without
 * safety gain. */
export function roadmapEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.ROADMAP_ENABLED !== "0";
}

export function roadmapBrainDailyCap(env: NodeJS.ProcessEnv): number {
  const n = Number(env.ROADMAP_BRAIN_DAILY_CAP);
  return Number.isFinite(n) && n > 0 ? n : ROADMAP_CAPS.brainCallsPerDayDefault;
}

export function roadmapPanelRunsDailyCap(env: NodeJS.ProcessEnv): number {
  const n = Number(env.ROADMAP_PANEL_RUNS_DAILY_CAP);
  return Number.isFinite(n) && n > 0 ? n : ROADMAP_CAPS.panelRunsPerDayDefault;
}

export function apolloDailyCallCap(env: NodeJS.ProcessEnv): number {
  const n = Number(env.APOLLO_DAILY_CALL_CAP);
  return Number.isFinite(n) && n > 0 ? n : ROADMAP_CAPS.apolloCallsPerDayDefault;
}

/** The eleven roadmap steps in progressive order. Rendering, status
 * derivation, and copy all iterate this one list so surfaces can never
 * disagree.
 *
 * Steps 03 and 08 are PAID training sold on /builders (Ticket Tailor and
 * Stripe). They carry a `fee` token and NOTHING else numeric: prices are
 * volatile facts owned by /builders, so seat caps and session dates never
 * appear here (a stale roadmap card would contradict the page it links to).
 * They get no `(steps)` page because a purchase is invisible to this server
 * (neither checkout is linked to a workspace), so there is nothing
 * tenant-specific to render; /builders already owns the date windows and
 * the checkout buttons. Consequently they can never compute "done" and stay
 * outside frontier and segment state (runway.tsx).
 *
 * PRICE SWEEP: a price change has to move together in three places, this
 * list's `fee` tokens, the /roadmap teaser FAQ answer, and /builders. */
export const ROADMAP_STEPS = [
  {
    key: "governance",
    num: "01",
    title: "AI Governance",
    href: "/roadmap/governance",
    blurb:
      "Put an AI governance document on file: upload your own, link to it " +
      "where it lives, attach one you built in the Governance Builder, or " +
      "create one now.",
    cta: {
      todo: "Upload, link, or create your policy",
      done: "Review your documents",
    },
  },
  {
    key: "directory",
    num: "02",
    title: "Company Directory",
    href: "/roadmap/directory",
    blurb:
      "List the people on this journey. Import your team from Apollo or " +
      "add them by hand; your company admin keeps it current.",
    cta: { todo: "Add your team", done: "Review your team" },
  },
  {
    key: "workshop",
    num: "03",
    title: "AI Builders Workshop",
    href: "/builders#workshop",
    fee: "$995",
    blurb:
      "Train your first builders: a four-hour live virtual workshop where " +
      "your team builds real AI workflows and automations they keep. Seats " +
      "are limited and sold per session.",
    // Availability-neutral on purpose: /builders swaps between a bookable
    // session, a sold-out strip, and a "next date TBA" state, so a verb
    // like "reserve seats" would go stale on its own clock. This one is
    // also true for a company that already bought.
    cta: { todo: "See dates and pricing", done: "See dates and pricing" },
  },
  {
    key: "work",
    num: "04",
    title: "Submit AI-Built Work",
    href: "/roadmap/work",
    blurb:
      "Ship something built with AI and submit it on the site or by email. " +
      "An editorial panel reviews it and publishes it to your company's " +
      "private Your Work page.",
    cta: { todo: "Submit your first build", done: "See what is published" },
  },
  {
    key: "request",
    num: "05",
    title: "Request AI-Built Work",
    href: "/roadmap/request",
    blurb:
      "Ask for a project worth building: describe it, put an estimated " +
      "annual value in dollars on it, and list the metrics behind that " +
      "number. An admin reviews every request before it is listed.",
    cta: { todo: "Request your first project", done: "See your requests" },
  },
  {
    key: "requested",
    num: "06",
    title: "Approved Requested Work",
    href: "/roadmap/requested",
    // The claim cap is REQUEST_CAPS.concurrentPerDeveloper; interpolated so
    // the enforcement constant and this copy can never drift (the fee-token
    // PRICE SWEEP lesson).
    blurb:
      "The approved list, open to everyone here: claim a project to " +
      `build, up to ${REQUEST_CAPS.concurrentPerDeveloper} at a time, and ` +
      "mark it complete when it ships. An admin validates every completion.",
    cta: { todo: "See approved requests", done: "See approved requests" },
  },
  {
    key: "scorecard",
    num: "07",
    title: "Employee Scorecard",
    href: "/roadmap/scorecard",
    blurb:
      "Watch builders emerge: published work and requested-work activity " +
      "counted per person in your directory. Published cards and approved " +
      "requests only, never drafts or attempts.",
    cta: { todo: "See who is building", done: "See who is building" },
  },
  {
    key: "cohort",
    num: "08",
    title: "AI Builder Cohort",
    href: "/builders#cohort",
    fee: "$495/mo",
    blurb:
      "Keep your builders building: a weekly one-hour live group session " +
      "in a small group, working AI into your real work month over month.",
    cta: { todo: "See the cohort", done: "See the cohort" },
  },
  {
    key: "secure",
    num: "09",
    title: "Secure AI Builders",
    href: "/roadmap/secure",
    // PARTIAL-CAPABLE, and the only such step: two independent components,
    // either of which alone counts as half. COPY RULE (§5.20): this step is
    // named for the sanctioned path you are giving builders, and nothing
    // here may imply XL.net audited it. We confirm a link answers. We do
    // not inspect, test, or certify anything behind it.
    blurb:
      "Give your builders a sanctioned way in: an API proxy they can call, " +
      "and development machines they can build on. List either one to get " +
      "half the step, both to finish it.",
    cta: { todo: "Set up the platform", done: "Review the platform" },
  },
  {
    key: "data",
    num: "10",
    title: "Data Access",
    href: "/roadmap/data",
    blurb:
      "Point your builders at the data: your lakehouse address, plus the " +
      "instructions that explain how to connect to it and what the rules " +
      "are.",
    cta: { todo: "Add your lakehouse", done: "Review data access" },
  },
  {
    key: "tools",
    num: "11",
    title: "AI Builder Tools",
    href: "/roadmap/tools",
    // LADDER-NEUTRAL by copy rule (platform-copy.ts): only rung 1 may say
    // "reached", and a tool can count via internal, attested or grace too.
    blurb:
      "The tools your builders are cleared to use, each on its own card " +
      "with a link and instructions. The step completes with the first " +
      "tool whose link checks out; add as many as you need.",
    cta: { todo: "Add your first tool", done: "Review your tools" },
  },
] as const;

export type RoadmapStepKey = (typeof ROADMAP_STEPS)[number]["key"];
export type RoadmapStep = (typeof ROADMAP_STEPS)[number];
/** A step you buy rather than complete. */
export type PaidRoadmapStep = Extract<RoadmapStep, { fee: string }>;

/** The ONE paid-step predicate. Every surface narrows through this rather
 * than listing keys, so adding a paid step cannot leave a surface behind. */
export function isPaidStep(step: RoadmapStep): step is PaidRoadmapStep {
  return "fee" in step;
}

/** Task steps in ROADMAP_STEPS order: the only steps the frontier ("up
 * next") and the lightline consider. Paid steps are deliberately absent (a
 * never-satisfiable step would hold the frontier ring forever and dress an
 * upsell as wayfinding). INVARIANT (pinned in scripts/roadmap-tests.ts):
 * every step is tracked XOR paid - an untracked non-paid step would
 * silently render "Booked separately". */
export const TRACKED_STEP_KEYS = [
  "governance",
  "directory",
  "work",
  "request",
  "requested",
  "scorecard",
  "secure",
  "data",
  "tools",
] as const;
export type TrackedStepKey = (typeof TRACKED_STEP_KEYS)[number];

/** Where each step points for an xl.net STAFF session (§5.18 unification:
 * staff use the same hub backed by the internal lane). The ONE map - the
 * staff hub cards, the (steps) shell runway (RoadmapRunway hrefs prop), and
 * the per-page staff redirects under (steps) all read it; a second spelling
 * anywhere is how two surfaces come to disagree. xl.net can never be a
 * company (RESERVED_DOMAINS + DB CHECK), so the staff steps ride the
 * NULL-company_id lane: directory points at the real staff directory
 * (staff-parity round) and governance points at the step page's read-only
 * staff branch (owner ruling 2026-08-18: staff see whether XL.net's
 * document exists, is in draft, or is on file and read it when filed - and
 * are never funneled into the public builder; filing stays with global
 * admins). */
export const STAFF_STEP_HREFS: Record<RoadmapStepKey, string> = {
  governance: "/roadmap/governance",
  directory: "/roadmap/directory",
  workshop: "/builders#workshop",
  work: "/work/submit",
  request: "/work/requested",
  requested: "/work/requested",
  scorecard: "/roadmap/scorecard",
  cohort: "/builders#cohort",
  // §5.20: staff get the REAL pages, backed by the NULL-company_id lane
  // (the staff-parity precedent). Same href as the company lane, so the
  // page itself serves both and needs no staff redirect - which is the only
  // way to satisfy the (steps) invariant without a blank shell.
  secure: "/roadmap/secure",
  data: "/roadmap/data",
  tools: "/roadmap/tools",
};

/** The staff lane's Apollo search domain AND the apolloKickGuardKey fence
 * domain for every staff surface (staff hub DirectoryCard, the staff
 * directory page, the apollo-import route's staff branch). ONE constant:
 * two spellings is how the hub and the step page stop sharing a
 * sessionStorage fence and a same-tab double import runs. */
export const STAFF_LANE_DOMAIN = "xl.net";

/** The ONE sessionStorage guard key for the directory auto-init kick (round
 * 3). Keyed by DOMAIN, not company id (the client never sees the uuid).
 * Every surface that can kick imports THIS constant; a second spelling is
 * how same-tab double imports happen. */
export function apolloKickGuardKey(domain: string): string {
  return `rmp:apollo-kick:${domain}`;
}

/** Prepopulated hosting environments for the Developer VMs component
 * (§5.20, step 09). A STARTING LIST, never a closed one: the control is a
 * checkbox group plus a free-form "add another" field, because a company's
 * builders may sit on a private cloud, a colo, or something with no brand
 * name at all, and a closed picklist would force them to lie. Order is
 * roughly by how often we expect to see them, not by preference. */
export const VM_ENVIRONMENTS = [
  "Microsoft Azure",
  "Amazon Web Services",
  "Google Cloud",
  "Vultr",
  "DigitalOcean",
  "Linode (Akamai)",
  "Oracle Cloud",
  "IBM Cloud",
  "Hetzner",
  "VMware / vSphere",
  "Proxmox",
  "On-premises hardware",
] as const;
