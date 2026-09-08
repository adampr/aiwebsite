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
//                      whose package identity matches detector_arg. Three
//                      passes: an EXACT identity match closes on any
//                      status; only when that finds nothing, a
//                      NEAR MATCH on shared identity tokens (below) closes
//                      on a published row or pauses on one the review
//                      still holds; and only when both assignee-fenced
//                      passes produce no verdict, a RECEIVED-BY-ANOTHER-HAND
//                      pass (below) can PAUSE, never close, on somebody
//                      else's exact-named row.
//   work_update_child  They were asked to FIX a published card. A child row
//                      (parent_id = detector_arg) created by them, at or
//                      after the ask. ANY status closes it, including one
//                      the panel held: the ball has left the assignee and
//                      the next move belongs to XL.net, so continuing to
//                      email them would be asking for something they have
//                      already handed over. Three passes: when NO child row
//                      exists, a FRESH-SUBMISSION pass (below) asks whether
//                      the person answered by submitting the named package
//                      anew instead of filing an update child, and when
//                      that too produces no verdict, the
//                      RECEIVED-BY-ANOTHER-HAND pass (below) can PAUSE on
//                      somebody else's child of the card or exact-named
//                      fresh row.
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
// WHY work_update_child GAINED A SECOND PASS. A colleague answered a
// fix-your-card ask by submitting the named package as a FRESH submission
// (parent_id null) rather than as an update child of the card: the package
// carried exactly the identity the ask was about (his new archive name
// equalled the parent card's SKILL.md front-matter name), the panel
// published it, and the child pass, which looks only at parent_id, said
// no_update_child and nagged him minutes after he had answered. Same
// failure class as the work_submission incident above (the detector's lane
// narrower than the ways a person can answer), so it gets the same shape of
// remedy, run ONLY when the child pass finds no child at all: the parent
// card contributes up to three identity strings (archive name and SKILL.md
// front-matter name, file-shaped; title, prose), each fresh submission by
// the assignee at or after the ask contributes the same three, and an EXACT
// packageIdentity equality between any file-shaped pair, or failing that a
// NEAR token containment over any pair, marks the row as the answer. The
// verdict ladder is the work_submission near-match one for BOTH exact and
// near, deliberately weaker than the child lane's close-on-any-status,
// because the fresh row was never declared to be about this card: published
// CLOSES (the work is on the site), a status the review holds PAUSES with a
// composed reason, failed and superseded keep chasing. A fresh row whose
// archive_sha256 equals the parent's is the same-bytes re-send and must
// never close; if it would otherwise have produced a verdict (a failed or
// superseded identical row matches but keeps chasing like any other failed
// row), it pauses with the identical-resubmission reason instead.
//
// WHY BOTH DETECTORS GAINED A RECEIVED-BY-ANOTHER-HAND PASS. A second
// colleague, in the same complaint class, answered a send-the-package ask
// by emailing the package to the requester, who filed it from their OWN
// account: the archive carried exactly the asked-for identity, its title
// was the pasted reminder subject, the panel published it, and both
// assignee-fenced passes were blind to the row (it is not byAssignee), so
// the colleague was nagged every run for a package the site already held.
// The remedy runs ONLY after every assignee-fenced pass produced no
// verdict, and can only PAUSE, never close: closing would falsely record
// that the assignee answered, and this pass cannot know whose work the
// relayed row really is. Its aperture is deliberately the narrowest in the
// file, because it has no assignee fence: EXACT packageIdentity equality
// over file-shaped identities only (no near matching, no titles), each
// side required to carry at least one non-stop token, statuses limited to
// published and the in-review set, and for work_update_child a row
// byte-identical to the parent is ignored entirely (a relayed copy of the
// unchanged parent answers nothing) while somebody else's CHILD of the
// card, which declared itself to be about the card, pauses without an
// identity test. The composed reason names who filed what and when, and
// hands the operator both moves, including the /work ownership transfer
// that puts a relayed row onto the person who really did the work.
//
// NOT read in this round: chase_tasks.detector_md_sha256. The column is
// there for a future identity match on the SKILL.md digest (stable across a
// re-export, unlike archive_sha256); this round matches on the two things
// the ask named, archive_name and the SKILL.md front-matter name, and
// leaving the column unread is deliberate rather than forgotten.

import { and, asc, eq, gte } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { clip, formatDay, sameEmail } from "./config";

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
  /** The assignee's own submissions at or after the ask. Read by BOTH
   * detectors: the work_submission passes, and work_update_child's
   * fresh-submission pass. */
  submissions: SubmissionCandidate[];
  /** work_update_child lane: the children of detector_arg. */
  children: SubmissionCandidate[];
  /** work_update_child lane: the parent card's own row, for the
   * identical-resubmission digest test and for the identity strings the
   * fresh-submission pass compares against. Replaces the former
   * parentArchiveSha256 field so one fetch carries both needs. null when
   * the parent row is gone, which disables both uses: a pause is a
   * stronger claim than a close and must never rest on a missing value,
   * and an identity match against nothing is not a match. */
  parent: SubmissionCandidate | null;
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

/** The paused_reason for a fresh submission that answers a fix-your-card
 * ask while the review still holds it. A sibling of nearMatchPauseReason
 * with the same 500-char-budget discipline (pauseTask slices its reason to
 * 500, test-pinned) and the same both-outcomes operator instructions,
 * because a paused row is never re-examined by the detector: a later
 * publish of this submission will NOT auto-close the task. The clips are
 * tighter than the sibling's (40/32 against 60/48) because this sentence
 * carries more fixed words; the worst case is pinned by the test suite. */
export function freshSubmissionPauseReason(row: SubmissionCandidate): string {
  const archive = row.archiveName
    ? ` (archive ${clip(row.archiveName, 32)})`
    : "";
  return (
    `They answered this ask with a fresh submission, "${clip(row.title, 40)}"${archive} on ${formatDay(row.createdAt)}, instead of an update to the card; the review has it, so the next move is XL.net's, not theirs, and reminders are paused. ` +
    `If the card publishes, close this with chase:admin close; if the review turns it away, chase:admin open resumes the reminders and re-dates the ask so the same submission cannot immediately re-pause it.`
  );
}

/** The paused_reason when the asked-for package arrived from ANOTHER
 * account (the received-by-another-hand pass). Same discipline as its two
 * siblings: clip budgets keeping the worst case under pauseTask's 500-char
 * slice (test-pinned), both operator moves spelled, no long dashes, and
 * only claims this code can stand behind: it says the row MAY be the
 * assignee's own work relayed, never that it is. The filer named is the
 * row's historical author (creator_email, submitter_email when that is
 * null): the account that actually filed it, which on a later §5.16
 * transfer is exactly the provenance the operator needs to see. All three
 * interpolated values are human-entered and clip() collapses control
 * characters, and the whole string rides the same scrub path every stored
 * pause reason does (report-side blocked-contact scrub included). */
export function relayedPackagePauseReason(row: SubmissionCandidate): string {
  const who = clip(row.creatorEmail ?? row.submitterEmail, 32);
  const archive = row.archiveName
    ? ` (archive ${clip(row.archiveName, 24)})`
    : "";
  return (
    `A package matching this ask arrived from another account: ${who} filed "${clip(row.title, 24)}"${archive} on ${formatDay(row.createdAt)}; it may be their own work relayed by someone else, so reminders are paused. ` +
    `If it settles the ask, close it with chase:admin close, and if the work is really theirs a /work ownership transfer moves the row onto them; if their own submission is still wanted, chase:admin open resumes the reminders and re-dates the ask.`
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
 * wanted set ("morning" matches every package carrying that token),
 * accepted as designed. The wanted side is an operator-typed detector_arg
 * in the work_submission lane but, since the fresh-submission pass, can
 * also be a parent CARD's archive name, front-matter name or title, which
 * nobody chose with matching in mind; the aperture stands anyway because
 * every caller of this test is fenced to the assignee's own rows, at or
 * after the ask, and its verdicts to the published/in-review status
 * ladder, so the widest possible miss pauses a task for an operator to
 * rule on rather than closing one. */
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

  // The front-matter name is parsed out of JSON per row; cached so the
  // passes that read it (both work_submission passes, and
  // work_update_child's fresh-submission pass, which parses the parent's
  // too) share one parse per row instead of repeating it.
  const fmCache = new Map<SubmissionCandidate, string | null>();
  const fmName = (row: SubmissionCandidate): string | null => {
    if (!fmCache.has(row))
      fmCache.set(row, skillFrontMatterName(row.corpusFilesJson));
    return fmCache.get(row) ?? null;
  };

  if (task.detector === "work_submission") {
    const want = packageIdentity(task.detectorArg);
    if (!want) return { kind: "none", reason: "unusable_detector_arg" };
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

    // THIRD PASS: RECEIVED BY ANOTHER HAND, only when both assignee-fenced
    // passes produced no verdict (see the file header for the incident).
    // Somebody ELSE filed a package carrying exactly the asked-for
    // identity, plausibly the assignee's own emailed answer relayed by the
    // requester. This pass can only PAUSE: closing would falsely record
    // that the assignee answered, and nothing here can know whose work the
    // row really is. Because it has no assignee fence, the aperture is the
    // narrowest in the file: EXACT packageIdentity equality over
    // file-shaped identities only (no near matching, no titles), and both
    // sides must carry at least one non-stop token, so an ask or archive
    // named only in packaging words can never trip it. Published and
    // in-review rows pause (the site holds the package either way);
    // failed and superseded answer nothing and are ignored. Oldest
    // qualifying row is the one named, the file-wide convention.
    if (wanted.size > 0) {
      for (const row of oldestFirst(candidates.submissions)) {
        if (byAssignee(row, task.assigneeEmail)) continue;
        if (!atOrAfter(row, openedAt)) continue;
        if (
          row.status !== "published" &&
          !NEAR_MATCH_PAUSE_STATUSES.has(row.status)
        )
          continue;
        const byName =
          row.archiveName !== null &&
          packageIdentity(row.archiveName) === want &&
          identityTokens(row.archiveName).size > 0;
        const skillName = fmName(row);
        const byFrontMatter =
          skillName !== null &&
          packageIdentity(skillName) === want &&
          identityTokens(skillName).size > 0;
        if (!byName && !byFrontMatter) continue;
        return {
          kind: "pause",
          submissionId: row.id,
          reason: relayedPackagePauseReason(row),
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
    const parentSha = candidates.parent?.archiveSha256 ?? null;
    // "Identical" needs BOTH digests present. A null on either side is
    // unknown, and unknown must not be strong enough to pause somebody.
    const isIdentical = (row: SubmissionCandidate) =>
      parentSha !== null &&
      row.archiveSha256 !== null &&
      row.archiveSha256.toLowerCase() === parentSha.toLowerCase();
    if (kids.length > 0) {
      // THE CHILD PASS, semantics untouched: an existing child row settles
      // the verdict and the fresh-submission pass below never runs.
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

    // THE FRESH-SUBMISSION PASS, only when no child row exists (see the
    // file header for the incident that earned it). The person may have
    // answered the fix-your-card ask by submitting the named package anew
    // (parent_id null) instead of filing an update child, so the parent
    // card's identity strings are compared against the assignee's own
    // fresh submissions, the same candidate shape the work_submission lane
    // reads. Without the parent row there is nothing to compare against
    // and the pass cannot run.
    const parent = candidates.parent;
    // Up to three identity strings per row. File-shaped strings (archive
    // name, SKILL.md front-matter name) tokenize through packageIdentity;
    // the title through the prose tokenizer (see titleIdentityTokens for
    // why they must differ). An empty identity or token set contributes
    // nothing: matching on nothing would make every archive the answer to
    // every ask.
    type Ident = { field: string; identity: string; tokens: Set<string> };
    const fileIdentsOf = (row: SubmissionCandidate): Ident[] => {
      const out: Ident[] = [];
      if (row.archiveName !== null) {
        const identity = packageIdentity(row.archiveName);
        if (identity)
          out.push({
            field: "archive_name",
            identity,
            tokens: identityTokens(row.archiveName),
          });
      }
      const skillName = fmName(row);
      if (skillName !== null) {
        const identity = packageIdentity(skillName);
        if (identity)
          out.push({
            field: "skill_front_matter_name",
            identity,
            tokens: identityTokens(skillName),
          });
      }
      return out;
    };
    const allIdentsOf = (row: SubmissionCandidate): Ident[] => [
      ...fileIdentsOf(row),
      {
        field: "title",
        identity: collapseProse(row.title),
        tokens: titleIdentityTokens(row.title),
      },
    ];
    const parentFileIdents = parent ? fileIdentsOf(parent) : [];

    type FreshMatch = {
      row: SubmissionCandidate;
      parentField: string;
      candidateField: string;
      parentIdentity: string;
      candidateIdentity: string;
    };
    // The EXACT rung, shared by the fresh pass and the relay pass below:
    // string equality of packageIdentity between any file-shaped candidate
    // identity and any file-shaped parent identity. Titles are prose and
    // never take part. BOTH sides must carry at least one non-stop token:
    // "Package v2.zip" reduces to the identity "package-v2" but to an
    // EMPTY token set, and letting it exact-equal an unrelated upload that
    // happens to share the generic name would be matching on packaging
    // words, exactly what the tokenizer's stoplist exists to forbid.
    const findExact = (row: SubmissionCandidate): FreshMatch | null => {
      for (const c of fileIdentsOf(row))
        for (const p of parentFileIdents)
          if (
            c.tokens.size > 0 &&
            p.tokens.size > 0 &&
            c.identity === p.identity
          )
            return {
              row,
              parentField: p.field,
              candidateField: c.field,
              parentIdentity: p.identity,
              candidateIdentity: c.identity,
            };
      return null;
    };

    if (parent) {
      const parentAllIdents = allIdentsOf(parent).filter(
        (p) => p.tokens.size > 0
      );

      // Excluded on purpose: the parent row itself (a card is not its own
      // fix), and any row claiming parent_id = the parent, which belongs
      // to the child pass; if the child pass's ownership or time filters
      // rejected such a row, this pass must not readmit it.
      const eligible = oldestFirst(candidates.submissions).filter(
        (row) =>
          byAssignee(row, task.assigneeEmail) &&
          atOrAfter(row, openedAt) &&
          row.id.toLowerCase() !== parentId &&
          (row.parentId ?? "").toLowerCase() !== parentId
      );

      // NEAR: the same nearMatchTokens containment the work_submission
      // lane uses, over every (parent identity as wanted, candidate
      // identity) pair, titles included on both sides.
      const findNear = (row: SubmissionCandidate): FreshMatch | null => {
        for (const p of parentAllIdents)
          for (const c of allIdentsOf(row))
            if (c.tokens.size > 0 && nearMatchTokens(p.tokens, c.tokens))
              return {
                row,
                parentField: p.field,
                candidateField: c.field,
                parentIdentity: p.identity,
                candidateIdentity: c.identity,
              };
        return null;
      };

      // The verdict ladder, deliberately WEAKER than the child lane's
      // close-on-any-status for both exact and near (the work_submission
      // near-match rationale): the row never declared itself to be about
      // the parent card, so only a published row, where the email's own
      // promise has come true, closes. The identical-resubmission guard
      // partitions first: a same-bytes re-send must never close, and
      // pauses only when it would otherwise have produced a verdict, so a
      // failed or superseded identical row keeps chasing like any other
      // failed row. A real (changed-bytes) row outranks the identical
      // re-send in both upper rungs: new bytes are the thing the ask
      // wanted, and the composed reason on them is the more actionable
      // one. Returns null when the match set yields NO verdict, so the
      // caller can fall through to the next, weaker match set.
      const ladder = (
        matches: FreshMatch[],
        matchKind: string
      ): ChaseVerdict | null => {
        if (matches.length === 0) return null;
        const real = matches.filter((m) => !isIdentical(m.row));
        const dup = matches.filter((m) => isIdentical(m.row));
        // matches is oldest-first (eligible is), so find() is the oldest.
        const published = real.find((m) => m.row.status === "published");
        if (published) {
          return {
            kind: "close",
            submissionId: published.row.id,
            matchedOn: "fresh_submission_published",
            evidence: {
              detector: "work_update_child",
              pass: "fresh_submission",
              match: matchKind,
              submissionId: published.row.id,
              parentId,
              parentField: published.parentField,
              candidateField: published.candidateField,
              parentIdentity: published.parentIdentity,
              candidateIdentity: published.candidateIdentity,
              submissionStatus: published.row.status,
              submittedAt: published.row.createdAt.toISOString(),
            },
          };
        }
        const inReview = real.find((m) =>
          NEAR_MATCH_PAUSE_STATUSES.has(m.row.status)
        );
        if (inReview) {
          return {
            kind: "pause",
            submissionId: inReview.row.id,
            reason: freshSubmissionPauseReason(inReview.row),
          };
        }
        const dupWouldVerdict = dup.find(
          (m) =>
            m.row.status === "published" ||
            NEAR_MATCH_PAUSE_STATUSES.has(m.row.status)
        );
        if (dupWouldVerdict) {
          return {
            kind: "pause",
            submissionId: dupWouldVerdict.row.id,
            reason: IDENTICAL_RESUBMISSION_REASON,
          };
        }
        return null;
      };

      // EXACT first: when any exact row yields a verdict, it stands, even
      // when a near-named sibling row carries a friendlier status (a held
      // exact answer pauses; the review has the exact thing). But an
      // exact set whose every row is failed or superseded yields NO
      // verdict, and must NOT suppress the near set: a person whose exact
      // resubmission failed and whose renamed retry was published has
      // plainly answered, and swallowing the near pass there would nag
      // them forever.
      const exact: FreshMatch[] = [];
      for (const row of eligible) {
        const m = findExact(row);
        if (m) exact.push(m);
      }
      const exactVerdict = ladder(exact, "exact");
      if (exactVerdict) return exactVerdict;
      const near: FreshMatch[] = [];
      for (const row of eligible) {
        const m = findNear(row);
        if (m) near.push(m);
      }
      const nearVerdict = ladder(near, "near");
      if (nearVerdict) return nearVerdict;
    }

    // THIRD PASS: RECEIVED BY ANOTHER HAND, only when every
    // assignee-fenced pass produced no verdict (see the file header for
    // the incident). Can only PAUSE, never close: closing would falsely
    // record that the assignee answered. Two legs, in order of claim
    // strength. A row byte-identical to the parent is ignored entirely in
    // both: a relayed copy of the unchanged parent answers nothing, and
    // unlike the assignee-fenced identical guard it does not even pause,
    // because nothing about somebody else's unchanged copy says the
    // assignee believes they answered.
    const relayStatus = (row: SubmissionCandidate) =>
      row.status === "published" || NEAR_MATCH_PAUSE_STATUSES.has(row.status);
    // Leg (a): somebody ELSE filed a child of the card. The child row
    // declared itself to be about this very card, so no identity test is
    // needed; failed and superseded answer nothing, as everywhere.
    const otherKids = oldestFirst(candidates.children).filter(
      (row) =>
        (row.parentId ?? "").toLowerCase() === parentId &&
        !byAssignee(row, task.assigneeEmail) &&
        atOrAfter(row, openedAt) &&
        relayStatus(row) &&
        !isIdentical(row)
    );
    if (otherKids.length > 0) {
      return {
        kind: "pause",
        submissionId: otherKids[0].id,
        reason: relayedPackagePauseReason(otherKids[0]),
      };
    }
    // Leg (b): somebody else's FRESH row named exactly like the card.
    // EXACT file-shaped identities only, through the same guarded
    // findExact the fresh pass uses: no assignee fence means no near
    // matching and no titles, the narrowest aperture in the file.
    if (parent) {
      for (const row of oldestFirst(candidates.submissions)) {
        if (byAssignee(row, task.assigneeEmail)) continue;
        if (!atOrAfter(row, openedAt)) continue;
        if (row.id.toLowerCase() === parentId) continue;
        if ((row.parentId ?? "").toLowerCase() === parentId) continue;
        if (!relayStatus(row)) continue;
        if (isIdentical(row)) continue;
        if (!findExact(row)) continue;
        return {
          kind: "pause",
          submissionId: row.id,
          reason: relayedPackagePauseReason(row),
        };
      }
    }
    // The final reason stays "no_update_child" on purpose: it now means
    // "no child row, no matching fresh submission, and nothing relayed by
    // another hand". The string is pinned by existing tests and is the
    // vocabulary operators already read in dry runs; renaming it would
    // split one outcome across several names for no diagnostic gain (the
    // dry run shows the detector, and any match that mattered would have
    // produced a verdict above).
    return { kind: "none", reason: "no_update_child" };
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
 * time floor alone; ownership is deliberately NOT a SQL filter any more,
 * because the received-by-another-hand pass needs rows the assignee did
 * not file, and every assignee-fenced pass re-checks ownership in the pure
 * function (byAssignee) where a test can see it. The table is small and
 * the limits below cap the worst case. The identity match itself stays in
 * the pure function. */
export async function candidatesFor(
  task: ChaseTaskFacts
): Promise<ChaseCandidates> {
  const empty: ChaseCandidates = {
    submissions: [],
    children: [],
    parent: null,
  };
  if (task.detector === "manual" || !task.openedAt || !task.detectorArg)
    return empty;
  const openedAt = task.openedAt;

  // EVERYBODY'S rows at or after the ask: ONE query shape for both
  // detectors (the work_submission passes read it, and so do
  // work_update_child's fresh-submission and relay passes), factored so
  // the lanes cannot drift apart in time-floor semantics. The pure
  // function partitions byAssignee per pass.
  const recentSubmissions = () =>
    db
      .select(SUB_COLS)
      .from(W)
      .where(gte(W.createdAt, openedAt))
      .orderBy(asc(W.createdAt))
      .limit(500);

  if (task.detector === "work_submission")
    return { ...empty, submissions: await recentSubmissions() };

  if (task.detector === "work_update_child") {
    // detector_arg is a submission uuid; a malformed one would make
    // Postgres raise rather than return nothing, so refuse it here.
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        task.detectorArg
      )
    )
      return empty;
    // Children of the card by ANYONE at or after the ask: the child pass
    // filters byAssignee purely, and the relay pass's leg (a) reads the
    // rest.
    const children = await db
      .select(SUB_COLS)
      .from(W)
      .where(and(eq(W.parentId, task.detectorArg), gte(W.createdAt, openedAt)))
      .orderBy(asc(W.createdAt))
      .limit(200);
    // The parent's FULL candidate projection (still SUB_COLS: archive_data
    // and md_data stay unselected), because the fresh-submission pass
    // needs its identity strings, not just its digest.
    const parent = await db
      .select(SUB_COLS)
      .from(W)
      .where(eq(W.id, task.detectorArg))
      .limit(1);
    return {
      ...empty,
      children,
      submissions: await recentSubmissions(),
      parent: parent[0] ?? null,
    };
  }

  return empty;
}
