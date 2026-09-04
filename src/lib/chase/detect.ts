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
//                      whose package identity matches detector_arg. Two
//                      passes: an EXACT identity match closes on any
//                      status, and only when that finds nothing, a
//                      NEAR MATCH on shared identity tokens (below) closes
//                      on a published row or pauses on one the review
//                      still holds.
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
// WHY work_submission GAINED A SECOND PASS. The exact identity match is a
// string equality over packageIdentity(), and a real colleague answered a
// real ask with a package whose file name wrapped the asked-for identity in
// packaging words ("<identity> ... Package.zip" against a detector_arg of
// just the identity). The panel held it, an admin published it, and the
// exact pass kept saying no_matching_submission: she was nagged for two
// more weekdays AFTER her card was live on the site, under copy that
// promised the reminders would close on their own the morning after the
// work showed up. That is the identical-resubmission failure in different
// clothes (nagging somebody who has plainly answered), so it gets the same
// two remedies: a CLOSE when the near-matching work is published (it is on
// the site; the promise in the email is now true), and a PAUSE while the
// review still holds it (XL.net has the package and the next move belongs
// to the panel or the admin, not to the person being emailed). The pass is
// deliberately SECOND and deliberately token-based rather than fuzzy: an
// exact match keeps its close-on-any-status behaviour untouched, and set
// containment over stoplisted tokens cannot be tripped by a wholly
// unrelated package that happens to share a generic word, which the same
// person had also submitted the same day.
//
// NOT read in this round: chase_tasks.detector_md_sha256. The column is
// there for a future identity match on the SKILL.md digest (stable across a
// re-export, unlike archive_sha256); this round matches on the two things
// the ask named, archive_name and the SKILL.md front-matter name, and
// leaving the column unread is deliberate rather than forgotten.

import { and, asc, eq, gte, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { clip, formatDay, normalizeEmail, sameEmail } from "./config";

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
  /** The card title the submitter typed. The near-match pass reads it as a
   * third identity string: the incident package's ARCHIVE name buried the
   * asked-for identity in packaging words, but its title carried it
   * plainly, and either one alone should have been enough. */
  title: string;
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

/** The paused_reason for a near-matched submission the review still holds.
 * Printed in the weekly report, so it names the three facts the owner needs
 * to check the verdict without opening a database: what they called it,
 * what the file was called, and when it arrived. Exported for the tests. */
export function nearMatchPauseReason(row: SubmissionCandidate): string {
  // Clip budgets picked so the WORST case stays under pauseTask's 500-char
  // slice (test-pinned): the closing sentence is the one that tells the
  // operator what to do in BOTH outcomes, and a slice must never be what
  // deletes it. Both outcomes are spelled because detection reads OPEN rows
  // only: a paused row is never re-examined, so a later publish of this
  // submission will NOT auto-close the task; the weekly report surfaces it
  // and the operator rules.
  const archive = row.archiveName
    ? ` (archive ${clip(row.archiveName, 48)})`
    : "";
  return (
    `They submitted "${clip(row.title, 60)}"${archive} on ${formatDay(row.createdAt)} and it looks like this ask under a different name; the review has it, so the next move is XL.net's, not theirs, and reminders are paused. ` +
    `If the card publishes, close this with chase:admin close; if the review turns it away, chase:admin open resumes the reminders and re-dates the ask so the same submission cannot immediately re-pause it.`
  );
}

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

/** Tokens that carry NO identity: the generic packaging words people wrap a
 * package name in. "Morning" answered with "<something> Brief Package.zip"
 * must match on the words that name the thing, and only on those; without
 * the stoplist, every package that says "package" would share a token with
 * every other. Version tags are here too because "v2" names a revision, not
 * a work. Small ON PURPOSE: every word added here widens what counts as
 * "the same thing", and a near match closes tasks. */
export const IDENTITY_STOP_TOKENS: ReadonlySet<string> = new Set([
  "package",
  "skill",
  "cowork",
  "app",
  "tool",
  "final",
  "update",
  "updated",
  "new",
  "copy",
  "file",
  "my",
  "the",
  "a",
  "an",
  "of",
  "for",
  "v1",
  "v2",
  "v3",
]);

function tokensOf(identity: string): Set<string> {
  const out = new Set<string>();
  for (const tok of identity.split("-"))
    if (tok && !IDENTITY_STOP_TOKENS.has(tok)) out.add(tok);
  return out;
}

/** packageIdentity, split into its hyphen-separated tokens, minus the
 * stop-token list. An EMPTY result means the string carries no identity at
 * all ("package.zip", "My Update v2") and can never near-match anything:
 * matching on nothing would make every archive the answer to every ask.
 * For FILE-SHAPED strings (archive names, front-matter names,
 * detector_arg) only; titles go through titleIdentityTokens. */
export function identityTokens(raw: string): Set<string> {
  return tokensOf(packageIdentity(raw));
}

/** The tokenizer for TITLES: lowercase, collapse every non-alphanumeric
 * run to a hyphen, stoplist. Deliberately NOT packageIdentity, whose
 * basename split and extension strip are file-name moves that mangle
 * prose: "Ticket Notes w/ AI" would reduce to its pseudo-basename "AI"
 * (a false match for any ask carrying that token), and
 * "Morning brief / final" to "final", then to nothing (a false miss for
 * the ask it plainly answers). A title has no path and no extension, so
 * neither move belongs. */
export function titleIdentityTokens(raw: string): Set<string> {
  return tokensOf(collapseProse(raw));
}

/** The prose half of packageIdentity: lowercase, collapse, no basename
 * split, no extension strip. Also the identity string the near-match
 * evidence records for a title match. */
function collapseProse(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isSubsetOf(a: Set<string>, b: Set<string>): boolean {
  for (const t of a) if (!b.has(t)) return false;
  return true;
}

/** The near-match containment test. Both directions are allowed, but NOT
 * symmetrically: the ask naming LESS than the package ("morning" vs
 * "morning-brief-package", the incident direction) is always a match,
 * while the package naming less than the ask must cover at least HALF the
 * wanted tokens (ceil(wanted/2)). Without that floor, any candidate
 * sharing ONE generic-ish token with a long ask would answer it: a
 * published "Digest v2" ({digest}) would falsely close a
 * "slack-digest-composer" ask ({slack, digest, composer}), which is a
 * different tool entirely. With it, {morning} still answers a
 * "morning-brief" ask (1 of 2) and {digest} does not answer that
 * three-token ask (1 of 3). The remaining aperture is the SINGLE-TOKEN
 * detector_arg ("morning" matches every package carrying that token),
 * accepted as designed: the operator chose how specific the ask's
 * identity is, and the pass is already fenced to the assignee's own
 * rows, at or after the ask, and to published/in-review statuses. */
function nearMatchTokens(wanted: Set<string>, s: Set<string>): boolean {
  if (isSubsetOf(wanted, s)) return true;
  return isSubsetOf(s, wanted) && s.size >= Math.ceil(wanted.size / 2);
}

/** The /work statuses on which a NEAR match pauses instead of closing.
 * The full work_submissions vocabulary is WorkStatus in
 * src/lib/work/config.ts: received | running | published | held | failed |
 * pending_approval | superseded. These four mean "XL.net has the package
 * and the next move is the panel's or the admin's" (waiting to start, in
 * review, held for a person, waiting for the approval click), so emailing
 * the submitter "please send it" every morning would nag them for work
 * they have already handed over. The two EXCLUDED non-published statuses
 * are excluded because continuing to chase is correct there: "failed"
 * means the review stopped and the next move (retry) is the submitter's,
 * and "superseded" is the rollback reservoir of a card that was replaced,
 * which answers nothing. Exported so the test suite pins the set against
 * the vocabulary. */
export const NEAR_MATCH_PAUSE_STATUSES: ReadonlySet<string> = new Set([
  "received",
  "running",
  "held",
  "pending_approval",
]);

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
    // The front-matter name is parsed out of JSON per row; cached so the
    // two passes share one parse instead of doing it twice per candidate.
    const fmCache = new Map<SubmissionCandidate, string | null>();
    const fmName = (row: SubmissionCandidate): string | null => {
      if (!fmCache.has(row))
        fmCache.set(row, skillFrontMatterName(row.corpusFilesJson));
      return fmCache.get(row) ?? null;
    };
    for (const row of oldestFirst(candidates.submissions)) {
      if (!byAssignee(row, task.assigneeEmail)) continue;
      if (!atOrAfter(row, openedAt)) continue;
      const byName =
        row.archiveName !== null && packageIdentity(row.archiveName) === want;
      const skillName = fmName(row);
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

    // SECOND PASS: the near match, only when the exact pass found nothing.
    // Same candidates, same ownership and time-floor filters; the identity
    // test loosens from string equality to token-set containment over THREE
    // identity strings per row (archive name, SKILL.md front-matter name,
    // card title). The verdict is deliberately weaker than the exact
    // pass's: a near match closes ONLY on a published row (the work is on
    // the site, so the email's own promise has come true) and pauses on a
    // row the review still holds; anything else keeps chasing. An empty
    // wanted-token set skips the pass entirely, because a detector_arg made
    // of packaging words would near-match everything.
    const wanted = identityTokens(task.detectorArg);
    if (wanted.size > 0) {
      // Every near-matching row, oldest-first, with WHICH field matched:
      // the close evidence and the pause reason both have to say what was
      // compared, or the operator reading them cannot check the verdict.
      const near: {
        row: SubmissionCandidate;
        field: string;
        identity: string;
      }[] = [];
      for (const row of oldestFirst(candidates.submissions)) {
        if (!byAssignee(row, task.assigneeEmail)) continue;
        if (!atOrAfter(row, openedAt)) continue;
        // Each identity string with ITS tokenizer: file-shaped strings go
        // through packageIdentity, the title through the prose tokenizer
        // (see titleIdentityTokens for why they must differ).
        const skillName = fmName(row);
        const idents: [string, string, Set<string>][] = [
          ...(row.archiveName !== null
            ? [
                [
                  "archive_name",
                  packageIdentity(row.archiveName),
                  identityTokens(row.archiveName),
                ] as [string, string, Set<string>],
              ]
            : []),
          ...(skillName !== null
            ? [
                [
                  "skill_front_matter_name",
                  packageIdentity(skillName),
                  identityTokens(skillName),
                ] as [string, string, Set<string>],
              ]
            : []),
          [
            "title",
            collapseProse(row.title),
            titleIdentityTokens(row.title),
          ] as [string, string, Set<string>],
        ];
        for (const [field, identity, s] of idents) {
          if (s.size === 0) continue;
          if (nearMatchTokens(wanted, s)) {
            near.push({ row, field, identity });
            break;
          }
        }
      }
      // Published outranks everything: if any near-matching row is live on
      // the site, the oldest such row closes the task even when a younger
      // one is still mid-review.
      const published = near.find((n) => n.row.status === "published");
      if (published) {
        return {
          kind: "close",
          submissionId: published.row.id,
          matchedOn: "near_match_published",
          evidence: {
            detector: "work_submission",
            submissionId: published.row.id,
            matchedOn: "near_match_published",
            matchedField: published.field,
            wantedIdentity: want,
            submissionIdentity: published.identity,
            submissionStatus: published.row.status,
            submittedAt: published.row.createdAt.toISOString(),
          },
        };
      }
      const inReview = near.find((n) =>
        NEAR_MATCH_PAUSE_STATUSES.has(n.row.status)
      );
      if (inReview) {
        // Reminders resume only through `chase:admin open`, which RE-DATES
        // the time floor to now (openTask's from-paused rule, built for the
        // identical-resubmission pause), so the very submission that paused
        // the row cannot immediately re-pause it on the next run.
        // Cap-aware: pauseTask slices its reason to 500 chars, so the two
        // human-entered strings are clipped here rather than trusted.
        return {
          kind: "pause",
          submissionId: inReview.row.id,
          reason: nearMatchPauseReason(inReview.row),
        };
      }
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
  title: W.title,
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
