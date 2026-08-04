"use client";

// The "Your Work" nav probe (§5.18). Piggybacks on the ONE shared session
// probe (staff-probe.ts, unmodified): unauthenticated sessions and @xl.net
// staff skip entirely with ZERO extra requests; everyone else costs exactly
// one fetch of /api/roadmap/nav per page, shared by every island instance
// via this module-scoped promise.

import { probeSession } from "@/components/staff-probe";

let probe: Promise<boolean> | null = null;

export function probeYourWork(): Promise<boolean> {
  probe ??= probeSession().then((s) => {
    if (!s.authenticated || !s.email) return false;
    if (s.email.trim().toLowerCase().endsWith("@xl.net")) return false;
    return fetch("/api/roadmap/nav", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { yourWork?: boolean } | null) => Boolean(d?.yourWork))
      .catch(() => false);
  });
  return probe;
}
