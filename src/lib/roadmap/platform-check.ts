// Running and recording reachability checks for phases 09/10/11 (§5.20).
//
// WHERE CHECKS ARE ALLOWED TO RUN: from an explicit POST, and nowhere else.
// Never from a page render, never from the status bundle, never from a
// layout. A render that awaits a stranger's server turns someone else's
// outage into ours, and roadmapStatus is on the critical path of both hubs
// AND every step page through the (steps) shell.
//
// The two fields of a row are checked CONCURRENTLY, so a save costs one
// probe of WALL CLOCK (12s worst case), not two. It costs two rate-limit
// TOKENS though, one per field: a field is what issues outbound requests,
// and charging per row let a single token buy two probes to two hosts of
// the caller's choosing.

import {
  recordLinkCheck,
  type LinkRow,
  type LinkScope,
} from "@/lib/roadmap/db";
import { checkUrlReachable } from "@/lib/roadmap/url-check";

export type CheckField = "url" | "docs";

function valueFor(row: LinkRow, field: CheckField): string | null {
  return field === "url" ? row.url : row.docsUrl;
}

function stateFor(row: LinkRow, field: CheckField): string {
  return field === "url" ? row.urlState : row.docsState;
}

/**
 * Check the fields of one row and persist the verdicts.
 *
 * By default only fields sitting at "unchecked" are attempted, so saving an
 * unrelated part of a row does not re-spend budget re-confirming something
 * already confirmed. `force` is the Retry button: it re-runs whatever the
 * current state is.
 *
 * A field with no URL is skipped entirely rather than recorded as failed:
 * an empty optional field is not a failure, and marking it one would light
 * a red state on a form the admin has not filled in yet.
 */
export async function verifyRow(
  scope: LinkScope,
  row: LinkRow,
  opts: {
    force?: boolean;
    fields?: CheckField[];
    /** Spend one rate-limit token, returning a refusal Response when the
     * budget is gone. Called ONCE PER FIELD, because a field is what costs
     * outbound requests; charging per row let one token buy two probes. */
    spend?: () => Response | null;
  } = {}
): Promise<{ row: LinkRow; skipped: boolean; checked: CheckField[] }> {
  const fields: CheckField[] = opts.fields ?? ["url", "docs"];
  const wanted = fields.filter((f) => {
    const value = valueFor(row, f);
    if (!value) return false;
    return opts.force || stateFor(row, f) === "unchecked";
  });
  const todo: CheckField[] = [];
  let skipped = false;
  for (const f of wanted) {
    if (opts.spend && opts.spend()) {
      // Out of budget: leave the field exactly as it is (unchecked, and
      // therefore not counting) so the admin can retry rather than
      // receiving a "failed" verdict we never actually measured.
      skipped = true;
      continue;
    }
    todo.push(f);
  }
  if (!todo.length) return { row, skipped, checked: [] };

  const results = await Promise.all(
    todo.map(async (field) => {
      // Captured BEFORE the probe and carried through to the write, so the
      // verdict can only ever land on the value it actually measured (see
      // recordLinkCheck's TOCTOU fence).
      const probedUrl = valueFor(row, field) ?? "";
      const outcome = await checkUrlReachable(probedUrl);
      return { field, probedUrl, outcome };
    })
  );

  let latest = row;
  for (const { field, probedUrl, outcome } of results) {
    const updated = await recordLinkCheck({
      scope,
      id: row.id,
      field,
      probedUrl,
      state: outcome.ok ? "ok" : "failed",
      reason: outcome.ok ? null : outcome.reason,
      httpStatus: outcome.status,
    });
    // null = the row moved underneath us (edited mid-probe) or left the
    // lane. Dropping the verdict is correct: it describes a URL that is no
    // longer stored.
    if (updated) latest = updated;
  }
  return { row: latest, skipped, checked: todo };
}

/** The row shape the client islands receive. Deliberately drops the
 * user-id column: the email is already the human-readable audit field the
 * pages render, and a uuid on the wire invites someone to try it as a
 * parameter somewhere else. */
export type PublicLinkRow = {
  id: string;
  kind: string;
  label: string | null;
  description: string | null;
  url: string | null;
  urlState: string;
  urlReason: string | null;
  urlHttpStatus: number | null;
  urlCheckedAt: string | null;
  docsUrl: string | null;
  docsState: string;
  docsReason: string | null;
  docsHttpStatus: number | null;
  docsCheckedAt: string | null;
  environments: string[];
  addedByEmail: string;
};

export function publicRow(row: LinkRow): PublicLinkRow {
  let environments: string[] = [];
  if (row.environmentsJson) {
    try {
      const parsed = JSON.parse(row.environmentsJson) as unknown;
      if (Array.isArray(parsed))
        environments = parsed.filter((v): v is string => typeof v === "string");
    } catch {
      environments = [];
    }
  }
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    description: row.description,
    url: row.url,
    urlState: row.urlState,
    urlReason: row.urlReason,
    urlHttpStatus: row.urlHttpStatus,
    urlCheckedAt: row.urlCheckedAt ? row.urlCheckedAt.toISOString() : null,
    docsUrl: row.docsUrl,
    docsState: row.docsState,
    docsReason: row.docsReason,
    docsHttpStatus: row.docsHttpStatus,
    docsCheckedAt: row.docsCheckedAt ? row.docsCheckedAt.toISOString() : null,
    environments,
    addedByEmail: row.addedByEmail,
  };
}
