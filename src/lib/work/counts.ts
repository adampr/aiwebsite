// /work COUNTS (owner directive 2026-09-28): the ONE definition of the
// number the /work page shows. The page's "N works" total is the sum of two
// lanes with two different sources of truth — the hand-authored static
// exhibits (src/app/work/page.tsx, snapshotted into static-titles.json) and
// the team-submitted cards published from the work_submissions table — so
// any surface that derives its number from only one of them (a DB count,
// most obviously) disagrees with the page by exactly the static lane. That
// mismatch was reported as a bug often enough that the reconciliation is
// now PERMANENT AND VISIBLE: composeWorkCounts() is the single place the
// total is computed, workCountsLine() is the single public sentence that
// spells the breakdown out (rendered as the registry's foot line), and
// scripts/work-counts-tests.ts pins both plus the call sites, so the shown
// number and the database number can never drift apart silently.
//
// Pure by contract: no DB import, no React. The exhibit count comes from
// static-titles.json (GENERATED — the snapshot script keeps it equal to the
// exhibits page.tsx actually renders, and test:placements re-checks that),
// the team count is handed in by the caller from the page's one guarded
// publishedCards() fetch.

import staticTitles from "./static-titles.json";

export interface WorkCounts {
  /** Hand-authored static exhibits, built into page.tsx (no DB rows). */
  exhibits: number;
  /** Team-submitted cards published from the database (placed + run). */
  team: number;
  /** What the page shows everywhere: exhibits + team. */
  total: number;
}

/** Pure. THE definition of the /work total: the static exhibits counted
 * from the generated snapshot, plus the team cards the caller fetched. */
export function composeWorkCounts(teamCount: number): WorkCounts {
  const exhibits = staticTitles.exhibits.length;
  return { exhibits, team: teamCount, total: exhibits + teamCount };
}

/** The public reconciliation copy, byte-pinned by test:workcounts. Middots
 * only — never an em or en dash (owner ban). */
export function workCountsLine(c: WorkCounts): string {
  return `${c.total} works · ${c.team} team-submitted, published from the live database · ${c.exhibits} built into the page`;
}
