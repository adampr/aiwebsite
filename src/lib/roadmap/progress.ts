// Roadmap completion percentage (§5.20, owner ask: "the company should
// prominently display its current AI Roadmap completion percentage for all
// of the company users anywhere on the site").
//
// ONE definition, read by the site-wide nav badge (through
// /api/roadmap/nav) and by the tests, so the number in the header can never
// disagree with the runway on /roadmap.
//
// WHAT IS IN THE DENOMINATOR, and why it is not "all eleven steps": steps
// 03 and 08 are paid training bought on /builders, and a purchase is
// INVISIBLE to this server (neither checkout is linked to a workspace). A
// step we can never observe as done can never be earned, so counting them
// would cap every company on earth at 9/11 = 82 percent forever and make
// "100%" unreachable by construction. The denominator is therefore the
// TRACKED steps (TRACKED_STEP_KEYS), which is exactly the set the runway's
// frontier and lightline already use.
//
// PARTIAL CREDIT: step 09 is the only partial-capable step (an API proxy
// and developer VMs are independent halves, per the owner). A half counts
// as 0.5, so the percentage moves when a company does half the work
// instead of pretending nothing happened.

import { TRACKED_STEP_KEYS, type TrackedStepKey } from "@/lib/roadmap/config";

/** The structural status input, in the RunwayStatus tradition: exactly the
 * fields this module reads, so RoadmapStatus and StaffRoadmapStatus both
 * satisfy it with no adapter. */
export type ProgressStatus = {
  governance: { done: boolean };
  directory: { done: boolean };
  work: { done: boolean };
  request: { done: boolean };
  requested: { live: boolean };
  scorecard: { live: boolean };
  secure: { done: boolean; partial: boolean };
  data: { done: boolean };
  tools: { done: boolean };
};

export const PROGRESS_TOTAL = TRACKED_STEP_KEYS.length;

/** Credit earned per tracked step: 0, 0.5 (step 09 half done), or 1. */
export function stepCredit(
  key: TrackedStepKey,
  status: ProgressStatus
): number {
  switch (key) {
    case "governance":
      return status.governance.done ? 1 : 0;
    case "directory":
      return status.directory.done ? 1 : 0;
    case "work":
      return status.work.done ? 1 : 0;
    case "request":
      return status.request.done ? 1 : 0;
    case "requested":
      return status.requested.live ? 1 : 0;
    case "scorecard":
      return status.scorecard.live ? 1 : 0;
    case "secure":
      return status.secure.done ? 1 : status.secure.partial ? 0.5 : 0;
    case "data":
      return status.data.done ? 1 : 0;
    case "tools":
      return status.tools.done ? 1 : 0;
  }
}

/**
 * The percentage, as an integer.
 *
 * ROUNDING IS ASYMMETRIC ON PURPOSE. Plain rounding lets 8.5/9 render as
 * "94%" (fine) but also lets a company one hair short of complete render
 * "100%", which is a lie the user can see through the moment they look at
 * the runway and find an unlit stop. So 100 is reserved for actually
 * complete, 0 is reserved for actually nothing started, and everything
 * between is clamped into 1..99.
 */
export function percentOf(earned: number, total: number): number {
  if (total <= 0) return 0;
  if (earned <= 0) return 0;
  if (earned >= total) return 100;
  const pct = Math.round((earned / total) * 100);
  return Math.min(99, Math.max(1, pct));
}

export type RoadmapProgress = {
  /** Steps earned, may end in .5 (step 09 half credit). */
  earned: number;
  /** Steps that can be completed here: the tracked set, never all eleven. */
  total: number;
  percent: number;
};

export function roadmapProgress(status: ProgressStatus): RoadmapProgress {
  let earned = 0;
  for (const key of TRACKED_STEP_KEYS) earned += stepCredit(key, status);
  return { earned, total: PROGRESS_TOTAL, percent: percentOf(earned, PROGRESS_TOTAL) };
}
