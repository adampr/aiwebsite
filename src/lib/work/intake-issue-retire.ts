// §5.15(ii) retirement predicate for the `work-intake:cleaned:<lane>` ledger
// rows (2026-09-16; Panel C row 5, amended by refutation RC 14).
//
// WHAT THE ROW IS FOR. reportIntakeCleaningIssue (report-issue.ts) opens a WARN
// row when an upload was CLEANED at intake, because the owner has no other
// at-intake channel: the retention mail that names a cleaned package
// ("(CLEANED AT INTAKE)") is sent only on publish, so a cleaned submission that
// is held or fails would otherwise tell nobody. Nothing ever closed those rows,
// so they sat open after every cleaned submission had published (measured
// 2026-09-16: 7 cleaned rows, all `published`; the key at x7).
//
// THE CONDITION. The need is gone exactly when no cleaned submission is still
// short of publish. So: every row with `cleaning_json IS NOT NULL` has a status
// in the ALLOW-LIST {published, superseded}. `superseded` is reachable only
// from `published` (work/db.ts), so both mean the publish-time retention mail
// was attempted. An ALLOW-list on purpose: a status this file has never heard
// of keeps the row open, never closes it. The scan is lane-agnostic, because
// work_submissions does not record which lane a row came in through, so any
// pending cleaned submission keeps EVERY cleaned key open.
//
// NEVER TOUCHED: `work-intake:cleaning-failed:<lane>`. There the rebuild could
// not be verified and no copy was kept, which is a defect for a person. The
// LIKE prefix `work-intake:cleaned:` cannot match it, and isCleanedKey() is
// applied again in code so a widened query still cannot reach it.
//
// THE RACE (RC 14a) AND WHY ORDER MATTERS. A web create inserts the submission
// (route.ts ~718) and records the ledger row a few awaits later (~748). The
// ledger rows are read FIRST, with their last_seen_at; the submissions second;
// and each resolve is a compare-and-set on `last_seen_at <= <the value read>`
// (module IssueResolveEvent.lastSeenAtMax, @aicompany/core v1.130.0). A cleaned
// submission that lands after the status scan bumps last_seen_at when it
// records, so the resolve matches nothing; one that records after the resolve
// opens a fresh episode, which is the ledger's normal recurrence path.
//
// CURRENT PIN GUARD. Until the host pins a module with that CAS field, a
// resolve would be UNCONDITIONAL and would reopen exactly the race above. So
// the predicate is INERT below MIN_CAS_MODULE_VERSION: it reads nothing and
// resolves nothing, and says so once per process. The type is widened locally
// (CasResolveEvent) so this file typechecks against both the v1.129.1 pin and
// v1.130.0; scripts/intake-retire-tests.ts fails if a pin at or above
// v1.130.0 does not actually declare the field.
//
// WHERE IT RUNS. The §5.16 work-queue tick (queue-drain.ts startWorkQueueDrain),
// with its own catch, never inside drainWorkQueue(), which returns early on
// several gates and is re-kicked by the fast retry. Throttled to one evaluation
// per RETIRE_THROTTLE_MS per process. Consequence, documented in
// ARCHITECTURE.md §5.16: WORK_QUEUE_DRAIN_ENABLED=0, or any other gate that
// keeps the drain from starting, also turns retirement off.

import { readFileSync } from "node:fs";
import path from "node:path";
import { and, eq, isNotNull, like } from "drizzle-orm";
import {
  resolveIssue,
  type IssueResolveEvent,
} from "@aicompany/core/issues/record";
import { db, schema } from "@/lib/db";
import { siteConfig } from "site.config";

export const CLEANED_KEY_PREFIX = "work-intake:cleaned:";
/** No `_` or `%` inside the prefix, so the LIKE needs no escaping. */
export const CLEANED_KEY_LIKE = `${CLEANED_KEY_PREFIX}%`;
export const CLEANED_TERMINAL = ["published", "superseded"] as const;
export const RETIRE_RESOLVED_BY = "auto:work-intake-cleaned-reviewed";
export const RETIRE_THROTTLE_MS = 15 * 60_000;
export const MIN_CAS_MODULE_VERSION = "1.130.0";

/** v1.130.0's resolve event. Identical to IssueResolveEvent once the pin
 * declares the field; on the v1.129.1 pin it adds it, so the object still
 * typechecks (and is never sent, see casSupported). */
export type CasResolveEvent = IssueResolveEvent & { lastSeenAtMax?: Date };

export interface OpenCleanedRow {
  key: string;
  lastSeenAt: Date | null;
}

export interface RetireDeps {
  /** True only when the pinned module honours lastSeenAtMax. */
  casSupported: () => boolean;
  /** Open `work-intake:cleaned:*` rows with last_seen_at, read FIRST. */
  listOpenCleanedRows: () => Promise<OpenCleanedRow[]>;
  /** Distinct statuses of every submission with cleaning_json, read SECOND. */
  cleanedSubmissionStatuses: () => Promise<string[]>;
  resolve: (
    evt: CasResolveEvent
  ) => Promise<{ ok: boolean; resolved: number; known: boolean }>;
  log: (msg: string) => void;
}

export type RetireOutcome =
  | { kind: "inert-no-cas" }
  | { kind: "no-open-rows" }
  | { kind: "kept"; pending: string[] }
  | { kind: "resolved"; resolved: string[]; raced: string[]; failed: string[] };

export function isCleanedKey(key: string): boolean {
  return key.startsWith(CLEANED_KEY_PREFIX);
}

/** Allow-list: at least one cleaned submission, and every status terminal.
 * An EMPTY list keeps the row: an open cleaned row with no cleaned submission
 * left means they were all deleted, and nothing then shows any of them ever
 * reached publish (a vacuous "all published" is not evidence). A deleted row
 * beside published ones simply drops out of the scan. */
export function cleanedRowsRetirable(statuses: readonly string[]): boolean {
  return (
    statuses.length > 0 &&
    statuses.every((s) => (CLEANED_TERMINAL as readonly string[]).includes(s))
  );
}

/** Numeric x.y.z compare; anything unparseable is "not at least". */
export function versionAtLeast(version: string | null, min: string): boolean {
  const parse = (v: string) => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const a = version ? parse(version) : null;
  const b = parse(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

export async function retireIntakeCleaningRowsWith(
  deps: RetireDeps
): Promise<RetireOutcome> {
  if (!deps.casSupported()) return { kind: "inert-no-cas" };
  // 1. Ledger snapshot FIRST (see THE RACE above).
  const rows = (await deps.listOpenCleanedRows()).filter(
    (r) =>
      isCleanedKey(r.key) &&
      r.lastSeenAt instanceof Date &&
      !Number.isNaN(r.lastSeenAt.getTime())
  );
  if (rows.length === 0) return { kind: "no-open-rows" };
  // 2. Then the submissions.
  const statuses = await deps.cleanedSubmissionStatuses();
  if (!cleanedRowsRetirable(statuses)) {
    const pending =
      statuses.length === 0
        ? ["(no cleaned submission left)"]
        : [
            ...new Set(
              statuses.filter(
                (s) => !(CLEANED_TERMINAL as readonly string[]).includes(s)
              )
            ),
          ].sort();
    return { kind: "kept", pending };
  }
  // 3. One CAS resolve per key.
  const resolved: string[] = [];
  const raced: string[] = [];
  const failed: string[] = [];
  for (const row of rows) {
    const lastSeenAtMax = row.lastSeenAt as Date;
    const r = await deps.resolve({
      source: "module",
      key: row.key,
      resolvedBy: RETIRE_RESOLVED_BY,
      note: `Every cleaned submission is published or superseded (distinct statuses: ${[
        ...new Set(statuses),
      ]
        .sort()
        .join(", ")}), and each reached publish, which is where the (CLEANED AT INTAKE) retention mail is sent. Resolved with CAS last_seen_at <= ${lastSeenAtMax.toISOString()}; a new cleaned submission opens a fresh episode.`,
      lastSeenAtMax,
    });
    if (!r.ok) failed.push(row.key);
    else if (r.resolved > 0) resolved.push(row.key);
    else raced.push(row.key);
  }
  if (resolved.length > 0)
    deps.log(`retired ${resolved.length} cleaned-intake row(s): ${resolved.join(", ")}`);
  if (raced.length > 0)
    deps.log(
      `kept ${raced.length} cleaned-intake row(s) that moved since the snapshot (CAS lost): ${raced.join(", ")}`
    );
  if (failed.length > 0)
    deps.log(`resolve failed for ${failed.join(", ")} (ledger unavailable; next evaluation retries)`);
  return { kind: "resolved", resolved, raced, failed };
}

// ---- production wiring ----

interface RetireState {
  lastRunAt: number;
  inertLogged: boolean;
}
// globalThis for the same reason as queue-drain.ts: instrumentation compiles
// to its own bundle, so module scope is not a per-process singleton.
const G = globalThis as typeof globalThis & {
  __workIntakeCleanedRetire?: RetireState;
};
function state(): RetireState {
  return (G.__workIntakeCleanedRetire ??= { lastRunAt: 0, inertLogged: false });
}

function log(msg: string): void {
  console.log(`[work-retire] ${msg}`);
}

/** The pinned @aicompany/core version, read from the submodule checkout the
 * process runs from (the drain only starts in the supervised checkout). Null
 * when unreadable, which keeps the predicate inert. */
export function pinnedModuleVersion(root: string = process.cwd()): string | null {
  try {
    const pkg = JSON.parse(
      readFileSync(path.join(root, "packages/aicompany/package.json"), "utf8")
    ) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

function productionDeps(): RetireDeps {
  return {
    casSupported: () => {
      const v = pinnedModuleVersion();
      const ok = versionAtLeast(v, MIN_CAS_MODULE_VERSION);
      const st = state();
      if (!ok && !st.inertLogged) {
        st.inertLogged = true;
        log(
          `inert: @aicompany/core ${v ?? "unknown"} has no CAS resolve (needs >= ${MIN_CAS_MODULE_VERSION}); cleaned-intake rows are left for a person`
        );
      }
      return ok;
    },
    listOpenCleanedRows: async () => {
      const t = schema.reportedIssues;
      return db
        .select({ key: t.issueKey, lastSeenAt: t.lastSeenAt })
        .from(t)
        .where(
          and(
            eq(t.source, "module"),
            eq(t.status, "open"),
            like(t.issueKey, CLEANED_KEY_LIKE)
          )
        );
    },
    cleanedSubmissionStatuses: async () => {
      const S = schema.workSubmissions;
      const rows = await db
        .selectDistinct({ status: S.status })
        .from(S)
        .where(isNotNull(S.cleaningJson));
      return rows.map((r) => r.status);
    },
    resolve: (evt) => resolveIssue(siteConfig.site.slug, evt),
    log,
  };
}

/** Throttled entry point for the work-queue tick. Throws only on a DB read
 * error; the tick's own catch logs it. Returns null when throttled. */
export async function retireIntakeCleaningRows(
  now: number = Date.now()
): Promise<RetireOutcome | null> {
  const st = state();
  if (now - st.lastRunAt < RETIRE_THROTTLE_MS) return null;
  st.lastRunAt = now;
  return retireIntakeCleaningRowsWith(productionDeps());
}
