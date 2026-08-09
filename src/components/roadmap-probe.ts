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
};

const EMPTY: RoadmapNav = { yourWork: false, percent: null };

let probe: Promise<RoadmapNav> | null = null;

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
  probe ??= probeSession().then((s) => {
    if (!s.authenticated || !s.email) return EMPTY;
    return fetch("/api/roadmap/nav", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Partial<RoadmapNav> | null) => ({
        yourWork: Boolean(d?.yourWork),
        percent: typeof d?.percent === "number" ? d.percent : null,
      }))
      .catch(() => EMPTY);
  });
  return probe;
}

/** Back-compat shape for the "Your Work" link. */
export function probeYourWork(): Promise<boolean> {
  return probeRoadmapNav().then((d) => d.yourWork);
}
