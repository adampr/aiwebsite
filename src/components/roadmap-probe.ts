"use client";

// The roadmap nav probe (§5.18, extended in §5.20). Piggybacks on the ONE
// shared session probe (staff-probe.ts, unmodified): unauthenticated
// sessions skip entirely with ZERO extra requests; everyone else costs
// exactly one fetch of /api/roadmap/nav per page, shared by every island
// instance via this module-scoped promise.
//
// §5.20 note: staff (@xl.net) used to short-circuit here, because the only
// consumer was the "Your Work" link and staff have /work. They now DO fetch,
// because the completion badge is meant to be visible to every user of a
// workspace and XL.net runs its own lane. `yourWork` still comes back false
// for them from the route, so the link behaves exactly as before.

import { probeSession } from "@/components/staff-probe";

export type RoadmapNav = {
  yourWork: boolean;
  /** Roadmap completion for the viewer's lane, or null when there is no
   * lane to report (signed out, untrusted, no workspace). */
  percent: number | null;
  /** May this session put a governance document on its lane's AI Roadmap
   * file (POST /api/roadmap/docs { governanceProjectId })? Mirrors the
   * route's docsWriteLane("attach") verdict: company member on the company
   * lane, global admin on the staff lane, false everywhere else. Consumed
   * by the §5.12 confirm-final auto-attach offer. */
  attach: boolean;
};

const EMPTY: RoadmapNav = { yourWork: false, percent: null, attach: false };

let probe: Promise<RoadmapNav> | null = null;
let probedAt = 0;

/** How long a fetched answer may be reused within one client session.
 *
 * The reset hook below covers changes THIS tab makes. It cannot cover a
 * change made anywhere else: the nightly re-check can demote a step at
 * 05:30 and move the percentage with no user action at all, and a tab left
 * open would otherwise show the old number until a full page load. A short
 * ceiling keeps the badge honest without turning it into a poll. */
const PROBE_TTL_MS = 5 * 60 * 1000;

const listeners = new Set<() => void>();

/** Re-read on the next reset. Returns an unsubscribe. */
export function subscribeRoadmapNav(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Drop the memo and tell live readers to re-read.
 *
 * BOTH halves are needed. The memo is per client MODULE, and App Router
 * client navigation and router.refresh() do not re-evaluate a client
 * module, so without the reset the badge would show whatever the percentage
 * was when the tab was first opened, forever. But the badge also stays
 * MOUNTED across a router.refresh(), so its mount effect never runs again
 * and clearing the memo alone would change nothing on screen. Every
 * mutation island that can move roadmap state calls this immediately before
 * router.refresh(), so the number in the nav and the page the user is
 * looking at cannot disagree.
 */
export function resetRoadmapNavProbe(): void {
  probe = null;
  for (const fn of listeners) fn();
}

export function probeRoadmapNav(): Promise<RoadmapNav> {
  if (probe && Date.now() - probedAt > PROBE_TTL_MS) probe = null;
  if (!probe) probedAt = Date.now();
  probe ??= probeSession().then((s) => {
    if (!s.authenticated || !s.email) return EMPTY;
    return fetch("/api/roadmap/nav", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Partial<RoadmapNav> | null) => ({
        yourWork: Boolean(d?.yourWork),
        percent: typeof d?.percent === "number" ? d.percent : null,
        attach: d?.attach === true,
      }))
      .catch(() => EMPTY);
  });
  return probe;
}

/** Back-compat shape for the "Your Work" link. */
export function probeYourWork(): Promise<boolean> {
  return probeRoadmapNav().then((d) => d.yourWork);
}
