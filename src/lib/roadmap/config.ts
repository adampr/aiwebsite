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
  apolloImportsPerCompanyPerHour: 2, // doubles as the double-click fence
  apolloPagesPerImport: 5, // hard cap; a partial import reports itself
  apolloPeoplePerPage: 100,
  directoryWritesPerUserPerHour: 60,
  docWritesPerUserPerHour: 6,
  portalReadsPerUserPerHour: 240,
  // DKIM step 05 (§5.18 round 2). Status reads get their own key (a cache
  // miss triggers outbound DNS); the per-company recheck cap bounds a
  // tenant's total DNS traffic regardless of headcount; the email caps are
  // tight because the route sends mail.
  dkimStatusReadsPerUserPerHour: 60,
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

/** The four roadmap steps in progressive order. Rendering, status derivation,
 * and copy all iterate this one list so surfaces can never disagree. */
export const ROADMAP_STEPS = [
  {
    key: "governance",
    num: "01",
    title: "AI Governance",
    href: "/roadmap/governance",
    blurb:
      "Put an AI governance document on file: upload your own, attach one " +
      "you built in the Governance Builder, or create one now.",
  },
  {
    key: "directory",
    num: "02",
    title: "Company Directory",
    href: "/roadmap/directory",
    blurb:
      "List the people on this journey. Import your team from Apollo or " +
      "add them by hand; your company admin keeps it current.",
  },
  {
    key: "work",
    num: "03",
    title: "Submit AI-Built Work",
    href: "/roadmap/work",
    blurb:
      "Ship something built with AI and submit it. An editorial panel " +
      "reviews it and publishes it to your company's private Your Work page.",
  },
  {
    key: "scorecard",
    num: "04",
    title: "Employee Scorecard",
    href: "/roadmap/scorecard",
    blurb:
      "Watch builders emerge: published work counted per person in your " +
      "directory. Published cards only, never drafts or attempts.",
  },
  // Step 05 (§5.18 round 2): a verdict step, not a task step. It has NO
  // (steps) page - the hub panel opens a dialog - so href is a hub anchor
  // (the caching gate bans new child paths). The runway gives it its own
  // states (attention/unconfirmed) and excludes it from frontier logic.
  {
    key: "dkim",
    num: "05",
    title: "Verified Email",
    href: "/roadmap#step-dkim",
    blurb:
      "Prove mail from your domain is really yours. DKIM signing lets " +
      "email submissions from your team reach your roadmap directly.",
  },
] as const;

export type RoadmapStepKey = (typeof ROADMAP_STEPS)[number]["key"];
