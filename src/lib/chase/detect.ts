// Chase register completion detection (ARCHITECTURE.md §5.21).
//
// THE SHAPE OF THIS FILE IS THE POINT: matchCompletion() is pure, takes the
// task and the candidate rows, and returns a verdict. The two functions
// below it fetch those candidates and nothing else. So every rule about
// what counts as "they did it" is testable with no database, and the
// weekday job runs detection BEFORE the send: a task finished yesterday is
// closed this morning, not nagged.
//
// Three detectors, and only two of them can ever fire here:
//
//   manual             Only an operator closes it (npm run chase:admin).
//                      There is no query that could know, and pretending
//                      otherwise would either close it wrongly or nag
//                      somebody who finished weeks ago.
//   work_submission    They were asked to SEND a package. A /work
//                      submission row created by them, at or after the ask,
//                      whose package identity matches detector_arg.
//   work_update_child  They were asked to FIX a published card. A child row
//                      (parent_id = detector_arg) created by them, at or
//                      after the ask. ANY status closes it, including one
//                      the panel held: the ball has left the assignee and
//                      the next move belongs to XL.net, so continuing to
//                      email them would be asking for something they have
//                      already handed over.
//
// The one exception inside work_update_child is the reason this file has a
// third verdict. If the child's archive_sha256 equals the parent's, they
// re-sent the identical package: nothing was fixed, but they plainly
// believe they answered, and a reminder that says "please do the thing"
// every morning to somebody who thinks they did it is the exact failure the
// owner would not want shipped. So the task PAUSES with a reason, which
// takes it out of the send selector and puts it in the weekly report's
// "paused" section, where a person decides what to tell them.
//
// NOT read in this round: chase_tasks.detector_md_sha256. The column is
// there for a future identity match on the SKILL.md digest (stable across a
// re-export, unlike archive_sha256); this round matches on the two things
// the ask named, archive_name and the SKILL.md front-matter name, and
// leaving the column unread is deliberate rather than forgotten.

import { and, asc, eq, gte, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { normalizeEmail, sameEmail } from "./config";

const W = schema.workSubmissions;

/** Everything matchCompletion needs from a register row. A narrow input
 * type, not ChaseTask, so a test can state a case in four lines. */
export interface ChaseTaskFacts {
  id: string;
  assigneeEmail: string;
  openedAt: Date | null;
  detector: string;
  detectorArg: string | null;
}

/** Everything matchCompletion needs from a /work submission row. */
export interface SubmissionCandidate {
  id: string;
  submitterEmail: string;
  creatorEmail: string | null;
  createdAt: Date;
  status: string;
  archiveName: string | null;
  archiveSha256: string | null;
  corpusFilesJson: string | null;
  parentId: string | null;
}

export interface ChaseCandidates {
  /** work_submission lane. */
  submissions: SubmissionCandidate[];
  /** work_update_child lane: the children of detector_arg. */
  children: SubmissionCandidate[];
  /** The parent's archive digest, for the identical-resubmission test.
   * null when unknown, which counts as NOT identical: a pause is a stronger
   * claim than a close and must never rest on a missing value. */
  parentArchiveSha256: string | null;
}

export type ChaseVerdict =
  | { kind: "none"; reason: string }
  | {
      kind: "close";
      submissionId: string;
      matchedOn: string;
      evidence: Record<string, unknown>;
    }
  | { kind: "pause"; submissionId: string; reason: string };

/** The paused_reason written when somebody re-sends the identical package.
 * Exported because both the test suite and the weekly report quote it. */
export const IDENTICAL_RESUBMISSION_REASON =
  "They sent the same package again (identical checksum to the one it was meant to replace), so nothing changed. Reminders are paused because they believe they have answered; someone needs to tell them what to change.";

/* ------------------------------------------------------------------ *
 * Pure identity helpers
 * ------------------------------------------------------------------ */

/** Reduce a package name to a comparable identity: basename, extension
 * stripped, lowercased, every run of anything else collapsed to a hyphen.
 * "Software Brain.zip", "software-brain", "pkg/Software_Brain.skill" and
 * "SOFTWARE BRAIN.ZIP" are all "software-brain", which is what makes a
 * detector_arg written by a person match a file name produced by a tool. */
export function packageIdentity(raw: string): string {
  const base = raw.trim().split(/[\\/]/).pop() ?? "";
  // Twice, so "package.tar.gz" reduces past both extensions.
  const noExt = base
    .replace(/\.(zip|skill|md|mdx|markdown|tar|gz|tgz)$/i, "")
    .replace(/\.(zip|skill|md|mdx|markdown|tar|gz|tgz)$/i, "");
  return noExt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The `name:` of a leading YAML front-matter block. Anchored at column 0
 * exactly like extract.ts hasSkillFrontmatter, so a nested
 * "author:\n  name: ..." never matches. */
function frontMatterName(text: string): string | null {
  if (!/^---\r?\n/.test(text)) return null;
  const rest = text.slice(text.indexOf("\n") + 1);
  const end = rest.search(/^---\s*$/m);
  const front = end === -1 ? rest.slice(0, 4000) : rest.slice(0, end);
  const m = front.match(/^name:[ \t]*(\S.*)$/m);
  if (!m) return null;
  return m[1].trim().replace(/^["']|["']$/g, "").trim() || null;
}

/** The Skill's machine name as the panel recorded it: the front-matter
 * `name:` of the corpus entry actually called SKILL.md. Restricted to that
 * basename on purpose. Reading `name:` out of any .md in the package would
 * let an unrelated document's front matter close somebody's task. */
export function skillFrontMatterName(
  corpusFilesJson: string | null
): string | null {
  if (!corpusFilesJson) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(corpusFilesJson);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { path?: unknown; text?: unknown };
    if (typeof e.path !== "string" || typeof e.text !== "string") continue;
    const base = e.path.split(/[\\/]/).pop() ?? "";
    if (!/^skill\.(md|mdx|markdown)$/i.test(base)) continue;
    const name = frontMatterName(e.text);
    if (name) return name;
  }
  return null;
}

/** Was this row put there by the assignee? Either anchor counts, and both
 * are needed. creator_email is who created the row and is NULL on every
 * pre-transfer row, so the repo's own COALESCE(creator, submitter) reading
 * is the historical author; submitter_email is who owns it NOW, and a
 * transfer is precisely the gesture that moves a row onto the person who
 * really did the work (§5.16 ownership transfer). */
function byAssignee(row: SubmissionCandidate, assigneeEmail: string): boolean {
  const creator = row.creatorEmail ?? row.submitterEmail;
  return (
    sameEmail(creator, assigneeEmail) ||
    sameEmail(row.submitterEmail, assigneeEmail)
  );
}

/** The time floor. A package submitted before anyone asked for it is not
 * evidence that the ask was answered; chase_task_open_ck guarantees an open
 * row has an opened_at to compare against. */
function atOrAfter(row: SubmissionCandidate, openedAt: Date): boolean {
  return row.createdAt.getTime() >= openedAt.getTime();
}

function oldestFirst(rows: SubmissionCandidate[]): SubmissionCandidate[] {
  return [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

/* ------------------------------------------------------------------ *
 * The decision
 * ------------------------------------------------------------------ */

/** PURE. Given a task and the candidate rows, decide close / pause / leave
 * it open. Every "none" carries a machine-readable reason so a dry run can
 * explain why a task the operator expected to close did not. */
export function matchCompletion(
  task: ChaseTaskFacts,
  candidates: ChaseCandidates
): ChaseVerdict {
  if (task.detector === "manual")
    return { kind: "none", reason: "manual_detector" };
  if (!task.openedAt) return { kind: "none", reason: "no_time_floor" };
  if (!task.detectorArg) return { kind: "none", reason: "no_detector_arg" };
  const openedAt = task.openedAt;

  if (task.detector === "work_submission") {
    const want = packageIdentity(task.detectorArg);
    if (!want) return { kind: "none", reason: "unusable_detector_arg" };
    for (const row of oldestFirst(candidates.submissions)) {
      if (!byAssignee(row, task.assigneeEmail)) continue;
      if (!atOrAfter(row, openedAt)) continue;
      const byName =
        row.archiveName !== null && packageIdentity(row.archiveName) === want;
      const skillName = skillFrontMatterName(row.corpusFilesJson);
      const byFrontMatter =
        skillName !== null && packageIdentity(skillName) === want;
      if (!byName && !byFrontMatter) continue;
      return {
        kind: "close",
        submissionId: row.id,
        matchedOn: byName ? "archive_name" : "skill_front_matter_name",
        evidence: {
          detector: "work_submission",
          submissionId: row.id,
          identity: want,
          matchedOn: byName ? "archive_name" : "skill_front_matter_name",
          submissionStatus: row.status,
          submittedAt: row.createdAt.toISOString(),
        },
      };
    }
    return { kind: "none", reason: "no_matching_submission" };
  }

  if (task.detector === "work_update_child") {
    // CASE-FOLDED, on both sides. detector_arg is typed or pasted by a
    // person and Postgres renders every uuid it returns in LOWERCASE, so a
    // detector_arg with one uppercase character would make the SQL find the
    // child (uuid equality is not textual) and this filter then throw it
    // away, which reads as "they never did it" and nags them forever.
    const parentId = task.detectorArg.toLowerCase();
    const kids = oldestFirst(candidates.children).filter(
      (row) =>
        (row.parentId ?? "").toLowerCase() === parentId &&
        byAssignee(row, task.assigneeEmail) &&
        atOrAfter(row, openedAt)
    );
    if (kids.length === 0) return { kind: "none", reason: "no_update_child" };
    const parentSha = candidates.parentArchiveSha256;
    // "Identical" needs BOTH digests present. A null on either side is
    // unknown, and unknown must not be strong enough to pause somebody.
    const isIdentical = (row: SubmissionCandidate) =>
      parentSha !== null &&
      row.archiveSha256 !== null &&
      row.archiveSha256.toLowerCase() === parentSha.toLowerCase();
    const real = kids.filter((row) => !isIdentical(row));
    if (real.length > 0) {
      const row = real[0];
      return {
        kind: "close",
        submissionId: row.id,
        matchedOn: "update_child",
        evidence: {
          detector: "work_update_child",
          submissionId: row.id,
          parentId,
          childStatus: row.status,
          submittedAt: row.createdAt.toISOString(),
        },
      };
    }
    return {
      kind: "pause",
      submissionId: kids[0].id,
      reason: IDENTICAL_RESUBMISSION_REASON,
    };
  }

  return { kind: "none", reason: "unknown_detector" };
}

/* ------------------------------------------------------------------ *
 * Candidate queries. Explicit projections; archive_data and md_data are
 * never named, so the unattended job cannot pull a 100 MB blob into memory.
 * ------------------------------------------------------------------ */

const SUB_COLS = {
  id: W.id,
  submitterEmail: W.submitterEmail,
  creatorEmail: W.creatorEmail,
  createdAt: W.createdAt,
  status: W.status,
  archiveName: W.archiveName,
  archiveSha256: W.archiveSha256,
  corpusFilesJson: W.corpusFilesJson,
  parentId: W.parentId,
} as const;

/** Everything this task could possibly be closed by. Narrowed in SQL by the
 * two facts an index can use (the assignee and the time floor); the
 * identity match itself stays in the pure function. */
export async function candidatesFor(
  task: ChaseTaskFacts
): Promise<ChaseCandidates> {
  const empty: ChaseCandidates = {
    submissions: [],
    children: [],
    parentArchiveSha256: null,
  };
  if (task.detector === "manual" || !task.openedAt || !task.detectorArg)
    return empty;
  const who = normalizeEmail(task.assigneeEmail);
  const mine = sql`(lower(${W.submitterEmail}) = ${who} OR lower(coalesce(${W.creatorEmail}, ${W.submitterEmail})) = ${who})`;

  if (task.detector === "work_submission") {
    const submissions = await db
      .select(SUB_COLS)
      .from(W)
      .where(and(gte(W.createdAt, task.openedAt), mine))
      .orderBy(asc(W.createdAt))
      .limit(500);
    return { ...empty, submissions };
  }

  if (task.detector === "work_update_child") {
    // detector_arg is a submission uuid; a malformed one would make
    // Postgres raise rather than return nothing, so refuse it here.
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        task.detectorArg
      )
    )
      return empty;
    const children = await db
      .select(SUB_COLS)
      .from(W)
      .where(
        and(
          eq(W.parentId, task.detectorArg),
          gte(W.createdAt, task.openedAt),
          mine
        )
      )
      .orderBy(asc(W.createdAt))
      .limit(200);
    const parent = await db
      .select({ archiveSha256: W.archiveSha256 })
      .from(W)
      .where(eq(W.id, task.detectorArg))
      .limit(1);
    return {
      ...empty,
      children,
      parentArchiveSha256: parent[0]?.archiveSha256 ?? null,
    };
  }

  return empty;
}
