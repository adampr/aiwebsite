// Route helpers for the roadmap portal (§5.18). The gate predicates live in
// access.ts; the generic response/limiter helpers are IMPORTED from
// work/http.ts, not copied — they carry no gate semantics, and the owner's
// "no two ways to do the same thing" rule applies (only what must be allowed
// to diverge gets its own definition).

import { okJson, rateLimit, workError } from "@/lib/work/http";
import { roadmapEnabled } from "@/lib/roadmap/config";

export { okJson, rateLimit };
export { workError as roadmapError };

/** Kill-switch guard for WRITE routes (reads stay up; §5.18). Returns the
 * refusal Response or null. */
export function requireRoadmapWritesEnabled(): Response | null {
  if (roadmapEnabled(process.env)) return null;
  return workError(
    "disabled",
    "Roadmap changes are paused right now. Reading is unaffected; try again later.",
    503
  );
}
