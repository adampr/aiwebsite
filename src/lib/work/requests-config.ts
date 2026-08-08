// Requested Work board (ARCHITECTURE.md §5.19) - caps, status vocabulary,
// and canonical copy. Client-safe: constants and pure helpers only, no node
// imports, NO EM DASHES in any string (site rule). Pattern:
// src/lib/work/config.ts.
//
// ONE status vocabulary for the whole feature. The scorecard cell counts,
// their click-through lists, the hub step counts, and the board pages all
// import these arrays; a second spelling anywhere is how a clickable count
// and the page behind it come to disagree (SUBMISSIONS-PAGER lesson).

/** Status machine (work_req_status_ck, migration 0038):
 *  pending -> approved -> in_progress -> done_pending -> completed
 *  pending -> rejected; approved (unclaimed) -> rejected (admin delist);
 *  in_progress -> approved (unclaim); done_pending -> in_progress
 *  (admin send-back). Requester cancel is a hard DELETE of a still-pending
 *  row, not a status. */
export type WorkRequestStatus =
  | "pending"
  | "approved"
  | "in_progress"
  | "done_pending"
  | "completed"
  | "rejected";

/** Statuses visible to every lane member (the "listed" universe). pending
 * and rejected rows are PRIVATE to their requester and the lane admin:
 * a request that was never approved must not be inferable by colleagues
 * anywhere - board, scorecard, hub counts, or click-through lists. */
export const REQ_LISTED = [
  "approved",
  "in_progress",
  "done_pending",
  "completed",
] as const;

/** "Working On" universe; also EXACTLY the 3-cap predicate, so the scorecard
 * column always reads as capacity used and never disagrees with a claim
 * refusal. done_pending stays inside: the row is still the developer's until
 * an admin validates, and admin send-back must never be refusable. */
export const REQ_WORKING = ["in_progress", "done_pending"] as const;

/** "Open" on a board/hub line: approved and not yet validated complete. */
export const REQ_OPEN = ["approved", "in_progress", "done_pending"] as const;

/** The 5-cap universe: everything that is not finished or refused. */
export const REQ_CAP_OPEN = [
  "pending",
  "approved",
  "in_progress",
  "done_pending",
] as const;

export const REQUEST_CAPS = {
  /** Max not-yet-completed, not-rejected requests per requester per lane.
   * Enforced by a single-statement INSERT guard; truly concurrent creates
   * can overshoot by one (accepted, courtesy cap). */
  openPerRequester: 5,
  /** Max concurrent claimed projects per developer per lane (in_progress +
   * done_pending). Same single-statement fence and accepted overshoot. */
  concurrentPerDeveloper: 3,
  // Form bounds. Title/description reuse the submission form's numbers
  // (WORK_CAPS.titleMinChars/titleMaxChars/blurbMaxChars) restated here so
  // this module stays dependency-free; a drift would be caught by the pin in
  // scripts/roadmap-tests.ts. No description minimum (standing owner
  // directive: no 80-char minimums anywhere).
  titleMinChars: 4,
  titleMaxChars: 60,
  descriptionMaxChars: 5000,
  /** Estimated annual value, whole USD. Kept far under the int4 ceiling
   * (2_147_483_647) so the route refuses, never 500s. */
  valueMaxUsd: 1_000_000_000,
  metricsMaxCount: 10,
  metricMaxChars: 300,
  /** Serialized JSON array ceiling for metrics_json (text column). */
  metricsJsonMaxBytes: 4000,
  rejectReasonMaxChars: 1000,
  /** Server-side row cap for every request list surface (the
   * mySubmissionsForList narrow-projection reasoning); pages render a
   * "Showing the most recent 200." note when they hit it. */
  listMax: 200,
} as const;

/** Human status words, one map for every surface. */
export const REQUEST_STATUS_COPY: Record<WorkRequestStatus, string> = {
  pending: "Awaiting approval",
  approved: "Listed",
  in_progress: "In progress",
  done_pending: "Awaiting validation",
  completed: "Completed",
  rejected: "Not approved",
};

/** "$12,500" - value rendering, one spelling. */
export function formatValueUsd(valueUsd: number): string {
  return "$" + valueUsd.toLocaleString("en-US");
}

export type RequestValidationResult =
  | {
      ok: true;
      title: string;
      description: string;
      valueUsd: number;
      metrics: string[];
    }
  | { ok: false; message: string };

/** Create-form validation, shared by the API route and pinned by tests.
 * Unknown fields are ignored; every bound is enforced server-side. */
export function validateRequestBody(body: unknown): RequestValidationResult {
  if (typeof body !== "object" || body === null) {
    return { ok: false, message: "Send the request as JSON." };
  }
  const b = body as Record<string, unknown>;
  const title = typeof b.title === "string" ? b.title.trim() : "";
  if (
    title.length < REQUEST_CAPS.titleMinChars ||
    title.length > REQUEST_CAPS.titleMaxChars
  ) {
    return {
      ok: false,
      message: `Give the project a short title (${REQUEST_CAPS.titleMinChars} to ${REQUEST_CAPS.titleMaxChars} characters).`,
    };
  }
  const description =
    typeof b.description === "string" ? b.description.trim() : "";
  if (description.length < 1) {
    return { ok: false, message: "Describe the project you are requesting." };
  }
  if (description.length > REQUEST_CAPS.descriptionMaxChars) {
    return {
      ok: false,
      message: `Keep the description under ${REQUEST_CAPS.descriptionMaxChars.toLocaleString("en-US")} characters.`,
    };
  }
  const value = b.value;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > REQUEST_CAPS.valueMaxUsd
  ) {
    return {
      ok: false,
      message:
        "Value must be a whole number of US dollars (estimated annual value), up to 1,000,000,000.",
    };
  }
  const rawMetrics = Array.isArray(b.metrics) ? b.metrics : null;
  const metrics = (rawMetrics ?? [])
    .map((m) => (typeof m === "string" ? m.trim() : ""))
    .filter((m) => m.length > 0);
  if (metrics.length < 1 || metrics.length > REQUEST_CAPS.metricsMaxCount) {
    return {
      ok: false,
      message: `Add at least one metric (max ${REQUEST_CAPS.metricsMaxCount}) explaining how the value is calculated.`,
    };
  }
  if (metrics.some((m) => m.length > REQUEST_CAPS.metricMaxChars)) {
    return {
      ok: false,
      message: `Keep each metric under ${REQUEST_CAPS.metricMaxChars} characters.`,
    };
  }
  // TextEncoder, not Buffer: this module is imported by client islands
  // (status copy, value formatting) and must stay browser-safe.
  if (
    new TextEncoder().encode(JSON.stringify(metrics)).length >
    REQUEST_CAPS.metricsJsonMaxBytes
  ) {
    return {
      ok: false,
      message: "The metric lines are too long overall. Trim them down.",
    };
  }
  return { ok: true, title, description, valueUsd: value, metrics };
}

/** Lenient read-edge parse of metrics_json (text-JSON convention). */
export function parseMetricsJson(metricsJson: string): string[] {
  try {
    const parsed: unknown = JSON.parse(metricsJson);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((m): m is string => typeof m === "string");
  } catch {
    return [];
  }
}
