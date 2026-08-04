// Apollo import outcome copy (§5.18 step 2) - the ONE human-facing source
// (dkim-copy.ts pattern), shared by the step page's import panel and the
// hub card's "Recheck database" button so two surfaces can never describe
// the same run differently. Client-safe: pure strings, no env, no em dashes.

export type ImportResult = {
  outcome?: string;
  partial?: boolean;
  found?: number;
  added?: number;
  updated?: number;
  keptManual?: number;
  skippedSuppressed?: number;
};

/** One line describing a completed import. `zeroCta` is the surface-local
 * follow-up for the nothing-found case: the step page points at its manual
 * add form, the hub card at adding by hand on the step page. */
export function importLine(
  r: ImportResult,
  domain: string,
  zeroCta: string
): string {
  const found = r.found ?? 0;
  if (found === 0) return `Apollo found no people for ${domain}. ${zeroCta}`;
  const parts = [`${r.added ?? 0} added`];
  if (r.updated) parts.push(`${r.updated} updated`);
  if (r.keptManual) parts.push(`${r.keptManual} already present`);
  if (r.skippedSuppressed)
    parts.push(`${r.skippedSuppressed} skipped as previously removed`);
  const line = `Apollo found ${found} people for ${domain} · ${parts.join(" · ")}`;
  return r.partial
    ? `Partial import (Apollo stopped answering partway): ${line}. Run it again later to pick up the rest.`
    : line;
}
