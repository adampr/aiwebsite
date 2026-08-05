// Your AI Roadmap (§5.18) - caps, kill switch, and canonical copy.
// Client-safe: constants and pure env readers only, NO EM DASHES in any
// string (site rule). Pattern: src/lib/work/config.ts.

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
  directoryWritesPerUserPerHour: 60,
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
  // Directory render cap (pagination is a deferral).
  directoryRenderMax: 500,
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

/** The six roadmap steps in progressive order. Rendering, status derivation,
 * and copy all iterate this one list so surfaces can never disagree.
 *
 * Steps 03 and 06 are PAID training sold on /builders (Ticket Tailor and
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
      "Put an AI governance document on file: upload your own, attach one " +
      "you built in the Governance Builder, or create one now.",
    cta: { todo: "Upload or create your policy", done: "Review your documents" },
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
    key: "scorecard",
    num: "05",
    title: "Employee Scorecard",
    href: "/roadmap/scorecard",
    blurb:
      "Watch builders emerge: published work counted per person in your " +
      "directory. Published cards only, never drafts or attempts.",
    cta: { todo: "See who is building", done: "See who is building" },
  },
  {
    key: "cohort",
    num: "06",
    title: "AI Builder Cohort",
    href: "/builders#cohort",
    fee: "$495/mo",
    blurb:
      "Keep your builders building: a weekly one-hour live group session " +
      "in a small group, working AI into your real work month over month.",
    cta: { todo: "See the cohort", done: "See the cohort" },
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

/** The ONE sessionStorage guard key for the directory auto-init kick (round
 * 3). Keyed by DOMAIN, not company id (the client never sees the uuid).
 * Every surface that can kick imports THIS constant; a second spelling is
 * how same-tab double imports happen. */
export function apolloKickGuardKey(domain: string): string {
  return `rmp:apollo-kick:${domain}`;
}
