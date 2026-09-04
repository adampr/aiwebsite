#!/usr/bin/env -S npx tsx
// Invariant checks for the chase register (ARCHITECTURE.md §5.21). Plain
// assertions, no framework (the host repo has none), NO DATABASE, no
// network. Run: npm run test:chase
//
// Every decision this feature makes about a real colleague's inbox is
// pinned here: which days it sends on, what turns it off, what counts as
// "they did it", what the owner's weekly report says when nobody is
// outstanding, and that a human-entered title cannot forge a line in either
// document. The source-scrape section at the bottom holds the two
// invariants types cannot: the claim row is inserted BEFORE the send, and
// the seeding gates are still there.
//
// SYNTHETIC ADDRESSES ONLY (example.com / example.org). This repository is
// public and the register's whole subject matter is which named people have
// not done what they were asked; a fixture naming a real colleague would
// publish that permanently, and git history would keep it after any revert.
// The last section enforces it over the chase sources themselves.

import assert from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHASE_CAPS,
  CHASE_NUDGE_SUBJECT,
  CHASE_REPORT_SUBJECT,
  chaseEnabled,
  chaseReportEnabled,
  clip,
  daysBetween,
  formatDay,
  isChaseDetector,
  isChaseStatus,
  isChaseWeekday,
  looksLikeEmail,
  normalizeEmail,
  oneLine,
  sameEmail,
  utcDateKey,
} from "../src/lib/chase/config";
import {
  IDENTICAL_RESUBMISSION_REASON,
  IDENTITY_STOP_TOKENS,
  NEAR_MATCH_PAUSE_STATUSES,
  identityTokens,
  matchCompletion,
  nearMatchPauseReason,
  packageIdentity,
  skillFrontMatterName,
  titleIdentityTokens,
  type ChaseCandidates,
  type ChaseTaskFacts,
  type SubmissionCandidate,
} from "../src/lib/chase/detect";
import {
  BLOCKED_CONTACT_SHA256,
  findBlockedContacts,
  scrubBlockedContacts,
  seedRowContactRefusal,
} from "../src/lib/chase/contact-policy";
import { createHash } from "node:crypto";
import {
  buildReportBody,
  partitionForReport,
  type ReportTask,
} from "../src/lib/chase/report";
import {
  composeNudge,
  nudgeHeaders,
  nudgeReplyTo,
} from "../src/lib/chase/notify";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");

let failures = 0;
function section(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${name}`);
    console.log(`     ${err instanceof Error ? err.message : String(err)}`);
  }
}

/* ------------------------------------------------------------------ *
 * 1. The weekday calendar
 * ------------------------------------------------------------------ */

section("isChaseWeekday is Monday to Friday, in UTC", () => {
  // 2026-08-31 is a Monday.
  const days = [
    ["2026-08-30T12:00:00Z", false, "Sunday"],
    ["2026-08-31T12:00:00Z", true, "Monday"],
    ["2026-09-01T12:00:00Z", true, "Tuesday"],
    ["2026-09-02T12:00:00Z", true, "Wednesday"],
    ["2026-09-03T12:00:00Z", true, "Thursday"],
    ["2026-09-04T12:00:00Z", true, "Friday"],
    ["2026-09-05T12:00:00Z", false, "Saturday"],
  ] as const;
  for (const [iso, want, label] of days)
    assert.equal(isChaseWeekday(new Date(iso)), want, `${label} (${iso})`);
});

section("the weekday test reads UTC, not the box's local time", () => {
  // 23:30 Friday UTC is Saturday in Sydney and Friday in Chicago. The job
  // and the chase_sends dedupe key must agree on the answer, so both read
  // UTC and this instant is a sending day wherever the VM thinks it is.
  assert.equal(isChaseWeekday(new Date("2026-09-04T23:30:00Z")), true);
  // 00:30 Saturday UTC is still Friday evening in Chicago; not a send day.
  assert.equal(isChaseWeekday(new Date("2026-09-05T00:30:00Z")), false);
});

section("utcDateKey is the ledger's dedupe axis, one calendar day", () => {
  assert.equal(utcDateKey(new Date("2026-08-31T00:00:00Z")), "2026-08-31");
  assert.equal(utcDateKey(new Date("2026-08-31T23:59:59Z")), "2026-08-31");
  assert.equal(utcDateKey(new Date("2026-09-01T00:00:00Z")), "2026-09-01");
});

section("daysBetween never goes negative and floors", () => {
  const a = Date.parse("2026-08-20T00:00:00Z");
  const b = Date.parse("2026-08-29T23:00:00Z");
  assert.equal(daysBetween(a, b), 9);
  assert.equal(daysBetween(b, a), 0);
  assert.equal(formatDay(null), "unknown");
  assert.equal(formatDay(new Date("2026-08-29T05:00:00Z")), "2026-08-29");
});

/* ------------------------------------------------------------------ *
 * 2. The kill switches
 * ------------------------------------------------------------------ */

section("both kill switches default ON and only \"0\" disables", () => {
  assert.equal(chaseEnabled({} as unknown as NodeJS.ProcessEnv), true, "unset = on");
  assert.equal(chaseEnabled({ WORK_CHASE_ENABLED: "1" } as unknown as NodeJS.ProcessEnv), true);
  assert.equal(chaseEnabled({ WORK_CHASE_ENABLED: "" } as unknown as NodeJS.ProcessEnv), true);
  assert.equal(chaseEnabled({ WORK_CHASE_ENABLED: "0" } as unknown as NodeJS.ProcessEnv), false);
  // "false", "no" and "off" are NOT off: the drain semantics are exactly
  // GOVERNANCE_ENABLED's, and inventing extra spellings here would make one
  // env var in this repo behave differently from all the others.
  assert.equal(
    chaseEnabled({ WORK_CHASE_ENABLED: "false" } as unknown as NodeJS.ProcessEnv),
    true
  );

  assert.equal(chaseReportEnabled({} as unknown as NodeJS.ProcessEnv), true);
  assert.equal(
    chaseReportEnabled({ WORK_CHASE_REPORT_ENABLED: "0" } as unknown as NodeJS.ProcessEnv),
    false
  );
  assert.equal(
    chaseReportEnabled({ WORK_CHASE_REPORT_ENABLED: "false" } as unknown as NodeJS.ProcessEnv),
    true
  );
});

section("the two switches are independent levers", () => {
  const nudgesOff = { WORK_CHASE_ENABLED: "0" } as unknown as NodeJS.ProcessEnv;
  assert.equal(chaseEnabled(nudgesOff), false);
  assert.equal(
    chaseReportEnabled(nudgesOff),
    true,
    "silencing the reminders must not blind the owner to who is outstanding"
  );
  const reportOff = { WORK_CHASE_REPORT_ENABLED: "0" } as unknown as NodeJS.ProcessEnv;
  assert.equal(chaseEnabled(reportOff), true);
});

section("the caps say what they promise", () => {
  assert.equal(CHASE_CAPS.nudgesPerAssigneePerUtcDay, 1);
  assert.ok(CHASE_CAPS.tasksPerEmail >= 1 && CHASE_CAPS.tasksPerEmail <= 20);
  assert.ok(CHASE_CAPS.recentlyClosedDays === 7, "the report window is a week");
});

section("the vocabularies match migration 0054's CHECK constraints", () => {
  const sql = readFileSync(
    resolve(repo, "drizzle/migrations/0054_chase_register.sql"),
    "utf8"
  );
  for (const s of ["blocked", "open", "paused", "done", "declined", "cancelled"])
    assert.ok(isChaseStatus(s), `${s} is a status`);
  assert.ok(!isChaseStatus("closed"), "closed is not a status");
  for (const d of ["manual", "work_submission", "work_update_child"])
    assert.ok(isChaseDetector(d), `${d} is a detector`);
  assert.ok(!isChaseDetector("work_update"), "no such detector");
  assert.ok(
    sql.includes(
      "status IN ('blocked','open','paused','done','declined','cancelled')"
    ),
    "the status CHECK still names exactly this set"
  );
  assert.ok(
    sql.includes("detector IN ('manual','work_submission','work_update_child')"),
    "the detector CHECK still names exactly this set"
  );
  assert.ok(
    sql.includes("chase_send_day_uq"),
    "the double-send guarantee is still an index"
  );
});

/* ------------------------------------------------------------------ *
 * 3. matchCompletion, every branch
 * ------------------------------------------------------------------ */

const OPENED = new Date("2026-08-20T00:00:00Z");
const AFTER = new Date("2026-08-25T10:00:00Z");
const BEFORE = new Date("2026-08-01T10:00:00Z");

function task(over: Partial<ChaseTaskFacts> = {}): ChaseTaskFacts {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    assigneeEmail: "doer@example.com",
    openedAt: OPENED,
    detector: "work_submission",
    detectorArg: "software-brain",
    ...over,
  };
}

function sub(over: Partial<SubmissionCandidate> = {}): SubmissionCandidate {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    submitterEmail: "doer@example.com",
    creatorEmail: null,
    createdAt: AFTER,
    status: "published",
    archiveName: "Software Brain.zip",
    archiveSha256: "a".repeat(64),
    corpusFilesJson: null,
    parentId: null,
    // Deliberately unrelated to the default detector_arg, so a fixture that
    // means to test the exact pass cannot quietly pass on a title near
    // match instead.
    title: "Quarterly Numbers",
    ...over,
  };
}

function candidates(over: Partial<ChaseCandidates> = {}): ChaseCandidates {
  return { submissions: [], children: [], parentArchiveSha256: null, ...over };
}

const PARENT_ID = "33333333-3333-4333-8333-333333333333";

section("manual tasks are never closed by a query", () => {
  const v = matchCompletion(
    task({ detector: "manual", detectorArg: null }),
    candidates({ submissions: [sub()] })
  );
  assert.deepEqual(v, { kind: "none", reason: "manual_detector" });
});

section("an open row with no time floor is refused, not guessed", () => {
  const v = matchCompletion(
    task({ openedAt: null }),
    candidates({ submissions: [sub()] })
  );
  assert.deepEqual(v, { kind: "none", reason: "no_time_floor" });
});

section("a non-manual detector with no argument matches nothing", () => {
  const v = matchCompletion(
    task({ detectorArg: null }),
    candidates({ submissions: [sub()] })
  );
  assert.deepEqual(v, { kind: "none", reason: "no_detector_arg" });
});

section("an unknown detector string closes nothing", () => {
  const v = matchCompletion(
    task({ detector: "work_something_else" }),
    candidates({ submissions: [sub()] })
  );
  assert.deepEqual(v, { kind: "none", reason: "unknown_detector" });
});

section("work_submission closes on the archive name", () => {
  const v = matchCompletion(task(), candidates({ submissions: [sub()] }));
  assert.equal(v.kind, "close");
  if (v.kind !== "close") return;
  assert.equal(v.matchedOn, "archive_name");
  assert.equal(v.submissionId, "22222222-2222-4222-8222-222222222222");
  assert.equal(v.evidence.detector, "work_submission");
});

section("work_submission closes on the SKILL.md front-matter name", () => {
  const corpus = JSON.stringify([
    { path: "docs/notes.md", text: "no front matter here" },
    {
      path: "pkg/SKILL.md",
      text: "---\nname: software-brain\ndescription: does things\n---\n\nBody.",
    },
  ]);
  const v = matchCompletion(
    task(),
    candidates({
      submissions: [sub({ archiveName: "upload-2026-08-25.zip", corpusFilesJson: corpus })],
    })
  );
  assert.equal(v.kind, "close");
  if (v.kind !== "close") return;
  assert.equal(v.matchedOn, "skill_front_matter_name");
});

section("a package that is not the one asked for closes nothing", () => {
  const v = matchCompletion(
    task(),
    candidates({ submissions: [sub({ archiveName: "something-else.zip" })] })
  );
  assert.deepEqual(v, { kind: "none", reason: "no_matching_submission" });
});

section("a submission that PREDATES the ask is not evidence of it", () => {
  const v = matchCompletion(
    task(),
    candidates({ submissions: [sub({ createdAt: BEFORE })] })
  );
  assert.deepEqual(v, { kind: "none", reason: "no_matching_submission" });
});

section("somebody else's submission never closes this person's task", () => {
  const v = matchCompletion(
    task(),
    candidates({
      submissions: [
        sub({ submitterEmail: "someone@example.org", creatorEmail: "someone@example.org" }),
      ],
    })
  );
  assert.deepEqual(v, { kind: "none", reason: "no_matching_submission" });
});

section("either ownership anchor counts: creator OR current submitter", () => {
  // Created by somebody else and TRANSFERRED to the assignee (the §5.16
  // gesture that corrects attribution): that is their work now.
  const transferred = matchCompletion(
    task(),
    candidates({
      submissions: [
        sub({ creatorEmail: "someone@example.org", submitterEmail: "doer@example.com" }),
      ],
    })
  );
  assert.equal(transferred.kind, "close");
  // Created by the assignee and since moved away: still their doing.
  const movedAway = matchCompletion(
    task(),
    candidates({
      submissions: [
        sub({ creatorEmail: "doer@example.com", submitterEmail: "someone@example.org" }),
      ],
    })
  );
  assert.equal(movedAway.kind, "close");
});

section("address matching is case-folded on both sides", () => {
  const v = matchCompletion(
    task({ assigneeEmail: "Doer@Example.com" }),
    candidates({ submissions: [sub({ submitterEmail: "DOER@EXAMPLE.COM" })] })
  );
  assert.equal(v.kind, "close");
});

section("the OLDEST qualifying submission is the one recorded", () => {
  const older = sub({ id: "44444444-4444-4444-8444-444444444444", createdAt: new Date("2026-08-21T00:00:00Z") });
  const newer = sub({ id: "55555555-5555-4555-8555-555555555555", createdAt: new Date("2026-08-27T00:00:00Z") });
  const v = matchCompletion(task(), candidates({ submissions: [newer, older] }));
  assert.equal(v.kind, "close");
  if (v.kind !== "close") return;
  assert.equal(v.submissionId, older.id);
});

section("work_update_child closes on ANY child status", () => {
  for (const status of ["received", "running", "held", "failed", "pending_approval", "published"]) {
    const v = matchCompletion(
      task({ detector: "work_update_child", detectorArg: PARENT_ID }),
      candidates({
        children: [sub({ parentId: PARENT_ID, status, archiveSha256: "b".repeat(64) })],
        parentArchiveSha256: "a".repeat(64),
      })
    );
    assert.equal(v.kind, "close", `status ${status} closes the task`);
  }
});

section("work_update_child with no child leaves the task open", () => {
  const v = matchCompletion(
    task({ detector: "work_update_child", detectorArg: PARENT_ID }),
    candidates({ children: [], parentArchiveSha256: "a".repeat(64) })
  );
  assert.deepEqual(v, { kind: "none", reason: "no_update_child" });
});

section("an UPPERCASE detector_arg uuid still matches the child", () => {
  // Postgres renders every uuid it returns in LOWERCASE, and uuid equality
  // in SQL is not textual, so an uppercase detector_arg finds the row and
  // then used to be thrown away by the JS compare: the person is emailed
  // every weekday after doing the work, and nothing anywhere says why.
  const parent = "AAAAAAAA-1111-4111-8111-AAAAAAAAAAAA";
  const v = matchCompletion(
    task({ detector: "work_update_child", detectorArg: parent }),
    candidates({
      children: [sub({ parentId: parent.toLowerCase(), archiveSha256: "beef" })],
      parentArchiveSha256: "cafe",
    })
  );
  assert.equal(v.kind, "close");
});

section("a child of a DIFFERENT parent does not close this task", () => {
  const v = matchCompletion(
    task({ detector: "work_update_child", detectorArg: PARENT_ID }),
    candidates({
      children: [sub({ parentId: "66666666-6666-4666-8666-666666666666" })],
      parentArchiveSha256: "a".repeat(64),
    })
  );
  assert.deepEqual(v, { kind: "none", reason: "no_update_child" });
});

section("THE IDENTICAL RESUBMISSION PAUSES, and never nags again", () => {
  const sha = "a".repeat(64);
  const v = matchCompletion(
    task({ detector: "work_update_child", detectorArg: PARENT_ID }),
    candidates({
      children: [sub({ parentId: PARENT_ID, archiveSha256: sha })],
      parentArchiveSha256: sha,
    })
  );
  assert.equal(v.kind, "pause");
  if (v.kind !== "pause") return;
  assert.equal(v.reason, IDENTICAL_RESUBMISSION_REASON);
  // The reason has to be readable by the person who must act on it.
  assert.ok(/same package again/i.test(v.reason));
  assert.ok(!/[\u2013\u2014]/.test(v.reason), "no long dashes in the reason");
});

section("the identical test is case-insensitive on the digest", () => {
  const v = matchCompletion(
    task({ detector: "work_update_child", detectorArg: PARENT_ID }),
    candidates({
      children: [sub({ parentId: PARENT_ID, archiveSha256: "A".repeat(64) })],
      parentArchiveSha256: "a".repeat(64),
    })
  );
  assert.equal(v.kind, "pause");
});

section("a MISSING digest is unknown, not identical, so it closes", () => {
  // A pause is a stronger claim than a close and must never rest on a null.
  const nullChild = matchCompletion(
    task({ detector: "work_update_child", detectorArg: PARENT_ID }),
    candidates({
      children: [sub({ parentId: PARENT_ID, archiveSha256: null })],
      parentArchiveSha256: "a".repeat(64),
    })
  );
  assert.equal(nullChild.kind, "close");
  const nullParent = matchCompletion(
    task({ detector: "work_update_child", detectorArg: PARENT_ID }),
    candidates({
      children: [sub({ parentId: PARENT_ID, archiveSha256: "a".repeat(64) })],
      parentArchiveSha256: null,
    })
  );
  assert.equal(nullParent.kind, "close");
});

section("one real fix beside a duplicate closes the task", () => {
  const sha = "a".repeat(64);
  const v = matchCompletion(
    task({ detector: "work_update_child", detectorArg: PARENT_ID }),
    candidates({
      children: [
        sub({ id: "77777777-7777-4777-8777-777777777777", parentId: PARENT_ID, archiveSha256: sha }),
        sub({
          id: "88888888-8888-4888-8888-888888888888",
          parentId: PARENT_ID,
          archiveSha256: "c".repeat(64),
          createdAt: new Date("2026-08-26T00:00:00Z"),
        }),
      ],
      parentArchiveSha256: sha,
    })
  );
  assert.equal(v.kind, "close");
  if (v.kind !== "close") return;
  assert.equal(v.submissionId, "88888888-8888-4888-8888-888888888888");
});

section("packageIdentity folds names people and tools spell differently", () => {
  assert.equal(packageIdentity("Software Brain.zip"), "software-brain");
  assert.equal(packageIdentity("software-brain"), "software-brain");
  assert.equal(packageIdentity("pkg/Software_Brain.skill"), "software-brain");
  assert.equal(packageIdentity("SOFTWARE BRAIN.ZIP"), "software-brain");
  assert.equal(packageIdentity("bundle.tar.gz"), "bundle");
  assert.equal(packageIdentity("   "), "");
  assert.equal(packageIdentity("!!!"), "");
});

section("skillFrontMatterName reads SKILL.md and nothing else", () => {
  const good = JSON.stringify([
    { path: "SKILL.md", text: "---\nname: my-skill\ndescription: d\n---\nbody" },
  ]);
  assert.equal(skillFrontMatterName(good), "my-skill");
  // A nested "name:" is not front matter (anchored the same way extract.ts
  // anchors its Skill signature test).
  const nested = JSON.stringify([
    { path: "SKILL.md", text: "---\nauthor:\n  name: someone\n---\nbody" },
  ]);
  assert.equal(skillFrontMatterName(nested), null);
  // Another document's front matter must not close somebody's task.
  const wrongFile = JSON.stringify([
    { path: "README.md", text: "---\nname: my-skill\ndescription: d\n---\n" },
  ]);
  assert.equal(skillFrontMatterName(wrongFile), null);
  assert.equal(skillFrontMatterName(null), null);
  assert.equal(skillFrontMatterName("not json"), null);
  assert.equal(skillFrontMatterName("{}"), null);
  assert.equal(skillFrontMatterName(JSON.stringify([null, 3, "x"])), null);
});

/* ------------------------------------------------------------------ *
 * 3b. The near match (work_submission's second pass)
 *
 * The prod incident this pins: an ask with detector_arg "morning" was
 * answered with an archive whose identity wrapped the asked-for word in
 * packaging words, the panel held it, an admin published it, and the exact
 * pass kept nagging for two more weekdays AFTER the card was live, under
 * copy promising the reminders close on their own once the work shows up.
 * ------------------------------------------------------------------ */

section("identityTokens strips the stoplist and folds like packageIdentity", () => {
  assert.deepEqual(
    [...identityTokens("Morning_Brief_Package.zip")].sort(),
    ["brief", "morning"]
  );
  assert.deepEqual([...identityTokens("morning")], ["morning"]);
  // A string made ONLY of packaging words carries no identity at all.
  assert.equal(identityTokens("package.zip").size, 0);
  assert.equal(identityTokens("My Skill Package v2.zip").size, 0);
  assert.equal(identityTokens("   ").size, 0);
  // The stoplist is the documented set, not a moving target.
  for (const t of ["package", "skill", "cowork", "update", "v2", "the"])
    assert.ok(IDENTITY_STOP_TOKENS.has(t), `"${t}" is a stop token`);
  assert.ok(!IDENTITY_STOP_TOKENS.has("morning"), "real words are not");
});

section("a near match on the ARCHIVE NAME closes once the row is published", () => {
  // packageIdentity("Morning_Brief_Package.zip") is "morning-brief-package",
  // which the exact pass compares to "morning" and rejects: the very bug.
  const v = matchCompletion(
    task({ detectorArg: "morning" }),
    candidates({
      submissions: [sub({ archiveName: "Morning_Brief_Package.zip" })],
    })
  );
  assert.equal(v.kind, "close");
  if (v.kind !== "close") return;
  assert.equal(v.matchedOn, "near_match_published");
  assert.equal(v.evidence.matchedField, "archive_name");
  assert.equal(v.evidence.submissionStatus, "published");
  assert.equal(v.evidence.wantedIdentity, "morning");
  assert.equal(v.evidence.submissionIdentity, "morning-brief-package");
});

section("a near match on the TITLE alone closes too", () => {
  // The archive name a tool generated carries no identity the ask named,
  // but the card title the person typed does. Either alone is enough.
  const v = matchCompletion(
    task({ detectorArg: "morning" }),
    candidates({
      submissions: [
        sub({ archiveName: "upload-final.zip", title: "Morning Brief" }),
      ],
    })
  );
  assert.equal(v.kind, "close");
  if (v.kind !== "close") return;
  assert.equal(v.matchedOn, "near_match_published");
  assert.equal(v.evidence.matchedField, "title");
});

section("containment works in BOTH directions", () => {
  // The ask can name more than the file ("morning-brief" vs "Morning.zip")
  // or less than it; both are the same person answering the same ask.
  const narrow = matchCompletion(
    task({ detectorArg: "morning-brief" }),
    candidates({ submissions: [sub({ archiveName: "Morning.zip" })] })
  );
  assert.equal(narrow.kind, "close");
  const wide = matchCompletion(
    task({ detectorArg: "brief" }),
    candidates({
      submissions: [sub({ archiveName: "Morning_Brief_Package.zip" })],
    })
  );
  assert.equal(wide.kind, "close");
});

section("the candidate-subset direction has a coverage floor", () => {
  // One shared token out of three must NOT be an answer: a published
  // "Digest v2" is a different tool from a "slack-digest-composer" ask,
  // however much they both digest. The floor is ceil(wanted/2).
  const oneOfThree = matchCompletion(
    task({ detectorArg: "slack-digest-composer" }),
    candidates({
      submissions: [
        sub({ archiveName: "digest-v2.zip", title: "Digest v2" }),
      ],
    })
  );
  assert.deepEqual(oneOfThree, {
    kind: "none",
    reason: "no_matching_submission",
  });
  // One of TWO still answers: {morning} covers ceil(2/2) of
  // "morning-brief" (the direction the containment test above pins).
  // Two of three answers too.
  const twoOfThree = matchCompletion(
    task({ detectorArg: "slack-digest-composer" }),
    candidates({ submissions: [sub({ archiveName: "Slack Digest.zip" })] })
  );
  assert.equal(twoOfThree.kind, "close");
});

section("titles tokenize as PROSE, never through packageIdentity", () => {
  // packageIdentity's basename split and extension strip are file-name
  // moves. On a title they mangle: "Ticket Notes w/ AI" would reduce to
  // its pseudo-basename "AI" (a false close for any ask carrying that
  // token) and "Morning brief / final" to "final", then to nothing (a
  // false miss for the ask it plainly answers).
  assert.deepEqual(
    [...titleIdentityTokens("Ticket Notes w/ AI")].sort(),
    ["ai", "notes", "ticket", "w"]
  );
  assert.deepEqual(
    [...titleIdentityTokens("Morning brief / final")].sort(),
    ["brief", "morning"]
  );
  // The contrast that makes the split necessary: the FILE tokenizer sees
  // only the pseudo-basename.
  assert.equal(identityTokens("Morning brief / final").size, 0);
  // "Ticket Notes w/ AI" must not answer an "ai-triage" ask: {ai} is one
  // of the title's four tokens, {ticket,notes,w,ai} is not inside
  // {ai,triage}, and {ai,triage} is not inside the title's set.
  const falseClose = matchCompletion(
    task({ detectorArg: "ai-triage" }),
    candidates({
      submissions: [
        sub({ archiveName: "upload-99.zip", title: "Ticket Notes w/ AI" }),
      ],
    })
  );
  assert.deepEqual(falseClose, {
    kind: "none",
    reason: "no_matching_submission",
  });
  // And "Morning brief / final" answers a "morning" ask via the title.
  const falseMiss = matchCompletion(
    task({ detectorArg: "morning" }),
    candidates({
      submissions: [
        sub({ archiveName: "upload-99.zip", title: "Morning brief / final" }),
      ],
    })
  );
  assert.equal(falseMiss.kind, "close");
  if (falseMiss.kind !== "close") return;
  assert.equal(falseMiss.evidence.matchedField, "title");
});

section("the near match PAUSES while the review still holds the package", () => {
  for (const status of [...NEAR_MATCH_PAUSE_STATUSES]) {
    const v = matchCompletion(
      task({ detectorArg: "morning" }),
      candidates({
        submissions: [
          sub({
            archiveName: "Morning_Brief_Package.zip",
            title: "Morning Brief",
            status,
          }),
        ],
      })
    );
    assert.equal(v.kind, "pause", `status ${status} pauses the task`);
    if (v.kind !== "pause") continue;
    // The reason has to be actionable from the weekly report alone: what
    // they called it, what the file was called, when it arrived, whose
    // move it is, and how to restart the reminders.
    assert.ok(v.reason.includes("Morning Brief"), "names the title");
    assert.ok(v.reason.includes("Morning_Brief_Package.zip"), "the archive");
    assert.ok(v.reason.includes("2026-08-25"), "the submitted date");
    assert.ok(/XL\.net/.test(v.reason), "says whose move it is");
    // BOTH outcomes, because a paused row is never re-examined by the
    // detector: a later publish will not auto-close it, so the reason has
    // to tell the operator the move for that case too.
    assert.ok(/chase:admin close/.test(v.reason), "the it-published move");
    assert.ok(/chase:admin open/.test(v.reason), "and how to restart");
    assert.ok(v.reason.length <= 500, "fits pauseTask's 500-char slice");
    assert.ok(!/[\u2013\u2014]/.test(v.reason), "no long dashes");
  }
});

section("the pause reason survives the 500-char slice at WORST case", () => {
  // pauseTask slices to 500; the closing how-to-restart sentence must never
  // be what the slice deletes, so the composer's own clips keep the whole
  // reason under the cap even for maximal inputs.
  const r = nearMatchPauseReason(
    sub({ archiveName: `${"A".repeat(200)}.zip`, title: "T".repeat(300) })
  );
  assert.ok(r.length <= 500, `worst case is ${r.length} chars`);
  assert.ok(/chase:admin open/.test(r), "the restart instruction survives");
});

section("the near-match pause set matches the /work status vocabulary", () => {
  // WorkStatus (src/lib/work/config.ts): received | running | published |
  // held | failed | pending_approval | superseded. The pause set is exactly
  // the four where XL.net has the package and the next move is the panel's
  // or the admin's. "failed" keeps chasing (the next move, retry, is the
  // submitter's) and "superseded" is a replaced card's rollback reservoir,
  // which answers nothing.
  assert.deepEqual(
    [...NEAR_MATCH_PAUSE_STATUSES].sort(),
    ["held", "pending_approval", "received", "running"]
  );
  for (const status of ["failed", "superseded"]) {
    const v = matchCompletion(
      task({ detectorArg: "morning" }),
      candidates({
        submissions: [sub({ archiveName: "Morning_Brief_Package.zip", status })],
      })
    );
    assert.deepEqual(
      v,
      { kind: "none", reason: "no_matching_submission" },
      `status ${status} keeps chasing`
    );
  }
});

section("an EXACT match still wins, and still closes on ANY status", () => {
  // The second pass runs only when the first found nothing: an exact
  // identity on a held row closes (the pre-existing contract), it does not
  // pause.
  const v = matchCompletion(
    task({ detectorArg: "morning-brief-package" }),
    candidates({
      submissions: [
        sub({ archiveName: "Morning_Brief_Package.zip", status: "held" }),
      ],
    })
  );
  assert.equal(v.kind, "close");
  if (v.kind !== "close") return;
  assert.equal(v.matchedOn, "archive_name");
});

section("a WHOLLY UNRELATED submission stays none (the vendor-tool case)", () => {
  // The same person really did submit an unrelated tool the same day the
  // incident package was in review. Sharing zero identity tokens with the
  // ask, it must neither close nor pause the task, published or not.
  const unrelated = sub({
    archiveName: "vendorticketlookup.zip",
    title: "Vendor Ticket Matcher",
  });
  const alone = matchCompletion(
    task({ detectorArg: "morning" }),
    candidates({ submissions: [unrelated] })
  );
  assert.deepEqual(alone, { kind: "none", reason: "no_matching_submission" });
  // Beside the real (held) package, the verdict is the PAUSE on the real
  // one, never a close on the unrelated published row.
  const beside = matchCompletion(
    task({ detectorArg: "morning" }),
    candidates({
      submissions: [
        unrelated,
        sub({
          id: "99999999-9999-4999-8999-999999999999",
          archiveName: "Morning_Brief_Package.zip",
          status: "held",
          createdAt: new Date("2026-08-26T09:00:00Z"),
        }),
      ],
    })
  );
  assert.equal(beside.kind, "pause");
  if (beside.kind !== "pause") return;
  assert.equal(beside.submissionId, "99999999-9999-4999-8999-999999999999");
});

section("a stop-token-only string never near-matches anything", () => {
  // "package.zip" tokenizes to the empty set: matching on nothing would
  // make every archive the answer to every ask.
  const emptyRow = matchCompletion(
    task({ detectorArg: "morning" }),
    candidates({
      submissions: [sub({ archiveName: "package.zip", title: "New Update" })],
    })
  );
  assert.deepEqual(emptyRow, {
    kind: "none",
    reason: "no_matching_submission",
  });
  // And a detector_arg of packaging words skips the whole second pass.
  const emptyWant = matchCompletion(
    task({ detectorArg: "skill-package" }),
    candidates({ submissions: [sub({ archiveName: "Morning.zip" })] })
  );
  assert.deepEqual(emptyWant, {
    kind: "none",
    reason: "no_matching_submission",
  });
});

section("published outranks in-review, and the OLDEST published wins", () => {
  const held = sub({
    id: "44444444-4444-4444-8444-444444444444",
    archiveName: "Morning_Brief_Package.zip",
    status: "held",
    createdAt: new Date("2026-08-21T00:00:00Z"),
  });
  const pubOld = sub({
    id: "55555555-5555-4555-8555-555555555555",
    archiveName: "Morning Brief v2.zip",
    createdAt: new Date("2026-08-24T00:00:00Z"),
  });
  const pubNew = sub({
    id: "66666666-6666-4666-8666-666666666666",
    archiveName: "Morning Brief v3.zip",
    createdAt: new Date("2026-08-27T00:00:00Z"),
  });
  const v = matchCompletion(
    task({ detectorArg: "morning" }),
    candidates({ submissions: [pubNew, held, pubOld] })
  );
  assert.equal(v.kind, "close");
  if (v.kind !== "close") return;
  assert.equal(v.submissionId, pubOld.id, "oldest PUBLISHED, not oldest row");
});

/* ------------------------------------------------------------------ *
 * 4. oneLine, and the forged line it exists to defeat
 * ------------------------------------------------------------------ */

section("oneLine defeats a forged newline in a human-entered value", () => {
  const forged =
    "Send the package\n- Someone Else <victim@example.org>\n  Ask: nothing outstanding";
  const safe = oneLine(forged);
  assert.ok(!safe.includes("\n"), "no newline survives");
  assert.ok(!safe.includes("\r"), "no carriage return survives");
  assert.equal(
    safe,
    "Send the package - Someone Else <victim@example.org> Ask: nothing outstanding"
  );
  // Every other control character too, not just the two obvious ones.
  assert.equal(oneLine("a\u0000b\u001fc\u007fd"), "a b c d");
  assert.equal(oneLine("  padded  "), "padded");
});

section("clip marks a truncation so a cut ask never reads as a whole one", () => {
  assert.equal(clip("short", 20), "short");
  assert.equal(clip("abcdefghij", 8), "abcde...");
  assert.equal(clip("with\nnewline", 40), "with newline");
});

section("a forged title cannot forge a line in the NUDGE", () => {
  const mail = composeNudge({
    assigneeName: "Doer\nFAKE HEADER: yes",
    assigneeEmail: "doer@example.com",
    requesterEmail: "asker@example.com",
    overseerEmail: "overseer@example.net",
    now: new Date("2026-08-31T13:00:00Z"),
    tasks: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        title: "Send it\n\nHow this stops:\n- Ignore this email",
        detail: "Because\nwe need it",
        actionUrl: null,
        openedAt: OPENED,
        requesterEmail: "asker@example.com",
        detector: "work_submission",
      },
    ],
  });
  // The forged text survives as TEXT inside the item line, which is fine
  // and honest. What it must never do is occupy a line of its own, because
  // a line of its own is indistinguishable from a line this code wrote.
  const lines = mail.text.split("\n");
  assert.equal(
    lines.filter((l) => l.trim() === "How this stops:").length,
    1,
    "exactly one real instruction heading"
  );
  assert.equal(
    lines.filter((l) => l.trim() === "- Ignore this email").length,
    0,
    "the forged instruction never gets its own line"
  );
  assert.equal(
    lines.filter((l) => l.trim() === "FAKE HEADER: yes").length,
    0,
    "a forged name cannot open a line either"
  );
  assert.ok(mail.text.includes("Send it How this stops: - Ignore this email"));
});

section("a forged title cannot forge a line in the REPORT", () => {
  const body = buildReportBody({
    now: new Date("2026-08-31T15:00:00Z"),
    live: [
      reportTask({
        title: "Send it\n\n1. STILL OUTSTANDING (0)\n   Nobody.",
        status: "open",
      }),
    ],
    recentlyClosed: [],
    lastSend: new Map(),
    nudgesEnabled: true,
  });
  const lines = body.split("\n");
  assert.equal(
    lines.filter((l) => l.trim().startsWith("1. STILL OUTSTANDING")).length,
    1,
    "only the real section heading gets a line"
  );
  assert.equal(
    lines.filter((l) => l.trim() === "Nobody.").length,
    0,
    "the forged all-clear never gets its own line"
  );
  assert.ok(body.includes("1. STILL OUTSTANDING (1)"), "the real count wins");
});

/* ------------------------------------------------------------------ *
 * 5. The nudge copy
 * ------------------------------------------------------------------ */

section("the nudge says what, why, where, and how to stop it", () => {
  const mail = composeNudge({
    assigneeName: "Doer Example",
    assigneeEmail: "doer@example.com",
    requesterEmail: "asker@example.com",
    overseerEmail: "overseer@example.net",
    now: new Date("2026-08-31T13:00:00Z"),
    tasks: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        title: "Send the CoWork skill package",
        detail: "It is the last exhibit missing from the handover.",
        actionUrl: "https://ai.xl.net/work/submit",
        openedAt: OPENED,
        requesterEmail: "asker@example.com",
        detector: "work_submission",
      },
    ],
  });
  assert.equal(mail.subject, CHASE_NUDGE_SUBJECT);
  assert.ok(mail.text.includes("Send the CoWork skill package"), "the ask");
  assert.ok(mail.text.includes("It is the last exhibit"), "the why");
  assert.ok(mail.text.includes("https://ai.xl.net/work/submit"), "the where");
  assert.ok(mail.text.includes("asker@example.com"), "a person to answer");
  assert.ok(mail.text.includes("How this stops:"), "how to stop it");
  assert.ok(mail.text.includes("11 days ago"), "when it was asked");
});

section("the nudge never guilts and never counts reminders at the reader", () => {
  const mail = composeNudge({
    assigneeName: "Doer Example",
    assigneeEmail: "doer@example.com",
    requesterEmail: "asker@example.com",
    overseerEmail: "overseer@example.net",
    now: new Date("2026-08-31T13:00:00Z"),
    tasks: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        title: "Send the package",
        detail: "We need it for the handover.",
        actionUrl: null,
        openedAt: OPENED,
        requesterEmail: "asker@example.com",
        detector: "work_submission",
      },
    ],
  });
  for (const banned of [
    "reminder number",
    "reminders sent",
    "you have failed",
    "overdue",
    "urgent",
    "please note that you",
    "as previously requested",
  ])
    assert.ok(
      !mail.text.toLowerCase().includes(banned),
      `the copy must not say "${banned}"`
    );
});

section("one email carries many asks and names who asked for each", () => {
  const tasks = Array.from({ length: CHASE_CAPS.tasksPerEmail + 2 }, (_, i) => ({
    id: `1111111${i}-1111-4111-8111-111111111111`,
    title: `Ask number ${i + 1}`,
    detail: "Detail.",
    actionUrl: null,
    openedAt: OPENED,
    requesterEmail: i === 0 ? "asker@example.com" : "second@example.org",
    detector: "work_submission",
  }));
  const mail = composeNudge({
    assigneeName: "Doer Example",
    assigneeEmail: "doer@example.com",
    requesterEmail: "asker@example.com",
    overseerEmail: "overseer@example.net",
    now: new Date("2026-08-31T13:00:00Z"),
    tasks,
  });
  assert.ok(mail.text.includes(`Ask number ${CHASE_CAPS.tasksPerEmail}`));
  assert.ok(
    !mail.text.includes(`Ask number ${CHASE_CAPS.tasksPerEmail + 1}`),
    "past the cap the items are counted, not printed"
  );
  assert.ok(mail.text.includes("are 2 more items"));
  // Two requesters in one email: both are named, because the cap is one
  // email per person per day and the second requester's ask would otherwise
  // be silently unchaseable.
  assert.ok(mail.text.includes("asker@example.com"));
  assert.ok(mail.text.includes("second@example.org"));
});

section("Reply-To and the RFC 3834 headers ride on every nudge", () => {
  const h = nudgeHeaders();
  assert.equal(h["Auto-Submitted"], "auto-generated");
  assert.ok(h["X-Auto-Response-Suppress"].includes("OOF"));
  // Reply-To is NOT a custom header: RFC 5322 allows one, and the address
  // goes on sendGovernanceEmail's first-class replyTo (Resend's reply_to).
  assert.ok(
    !("Reply-To" in h),
    "the reply address rides on the first-class field, not in headers"
  );
  assert.equal(nudgeReplyTo("Asker@Example.com"), "asker@example.com");
  // Header injection through a stored address is impossible.
  const dirty = nudgeReplyTo("asker@example.com\r\nBcc: someone@example.org");
  assert.ok(!dirty.includes("\n"));
  assert.ok(!dirty.includes("\r"));
});

section("the body names the requester even if Reply-To is dropped", () => {
  // sendGovernanceEmail has no first-class reply_to field, so the header is
  // best effort. The plain sentence is the guarantee, and this pin is what
  // stops a future edit from deleting it as redundant.
  const mail = composeNudge({
    assigneeName: "Doer Example",
    assigneeEmail: "doer@example.com",
    requesterEmail: "asker@example.com",
    overseerEmail: "overseer@example.net",
    now: new Date("2026-08-31T13:00:00Z"),
    tasks: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        title: "Send the package",
        detail: "We need it.",
        actionUrl: null,
        openedAt: OPENED,
        requesterEmail: "asker@example.com",
        detector: "work_submission",
      },
    ],
  });
  assert.ok(
    mail.text.includes("Write to asker@example.com"),
    "the address is spelled out in the body, not only in a header"
  );
});

/* ------------------------------------------------------------------ *
 * 5b. What the copy is ALLOWED to promise
 * ------------------------------------------------------------------ */

function nudgeTask(over: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Send the package",
    detail: "We need it for the handover.",
    actionUrl: "https://ai.xl.net/work/submit" as string | null,
    openedAt: OPENED,
    requesterEmail: "asker@example.com",
    detector: "work_submission",
    ...over,
  };
}

section("a MANUAL task is never promised an automatic close", () => {
  // The schema DEFAULT detector is 'manual', no query can close one, and
  // tasksForDetection excludes them. An email telling that person "nothing
  // else to do, I check the site every morning" is the one that keeps
  // arriving every weekday after they have done the work.
  const mail = composeNudge({
    assigneeName: "Doer Example",
    assigneeEmail: "doer@example.com",
    requesterEmail: "asker@example.com",
    overseerEmail: "overseer@example.net",
    now: new Date("2026-08-31T13:00:00Z"),
    tasks: [nudgeTask({ detector: "manual", actionUrl: null })],
  });
  assert.ok(
    !mail.text.includes("Nothing else to do"),
    "the auto-close promise must not appear on a manual row"
  );
  assert.ok(
    mail.text.includes("I cannot see this from the site"),
    "it says plainly that it will not close by itself"
  );
  assert.ok(
    mail.text.includes("Tell asker@example.com and they will close it"),
    "and names the person to tell"
  );
  // A row with no link still says where the work goes.
  assert.ok(
    mail.text.includes("send it to asker@example.com directly"),
    "no link means a named destination, never nothing"
  );
});

section("an AUTOMATIC task keeps the automatic promise", () => {
  const mail = composeNudge({
    assigneeName: "Doer Example",
    assigneeEmail: "doer@example.com",
    requesterEmail: "asker@example.com",
    overseerEmail: "overseer@example.net",
    now: new Date("2026-08-31T13:00:00Z"),
    tasks: [nudgeTask()],
  });
  assert.ok(mail.text.includes("Nothing else to do"));
  assert.ok(
    mail.text.includes("How it closes: on its own"),
    "the per-item line says which kind it is"
  );
});

section("a MIXED email says per item which ones close by themselves", () => {
  const mail = composeNudge({
    assigneeName: "Doer Example",
    assigneeEmail: "doer@example.com",
    requesterEmail: "asker@example.com",
    overseerEmail: "overseer@example.net",
    now: new Date("2026-08-31T13:00:00Z"),
    tasks: [
      nudgeTask(),
      nudgeTask({
        id: "22222222-2222-4222-8222-222222222222",
        detector: "manual",
        title: "Write the runbook",
      }),
    ],
  });
  assert.ok(!mail.text.includes("Nothing else to do"), "no blanket promise");
  assert.ok(mail.text.includes("Each item above says how it closes"));
  assert.equal(
    mail.text.split("How it closes: on its own").length - 1,
    1,
    "exactly one item claims the automatic close"
  );
  assert.equal(
    mail.text.split("How it closes: I cannot see this one").length - 1,
    1,
    "exactly one item says a person has to be told"
  );
});

section("the stop instruction names somebody who can actually stop it", () => {
  // The requester is told first, and the overseer is copied: chase:admin on
  // the VM is the only lever, and the requester is not guaranteed to have it.
  const mail = composeNudge({
    assigneeName: "Doer Example",
    assigneeEmail: "doer@example.com",
    requesterEmail: "asker@example.com",
    overseerEmail: "overseer@example.net",
    now: new Date("2026-08-31T13:00:00Z"),
    tasks: [nudgeTask()],
  });
  assert.ok(
    mail.text.includes(
      "Write to asker@example.com and copy overseer@example.net"
    ),
    "both addresses appear in the stop instruction"
  );
  // When the requester IS the overseer, it does not say "copy yourself".
  const same = composeNudge({
    assigneeName: "Doer Example",
    assigneeEmail: "doer@example.com",
    requesterEmail: "asker@example.com",
    overseerEmail: "asker@example.com",
    now: new Date("2026-08-31T13:00:00Z"),
    tasks: [nudgeTask()],
  });
  assert.ok(!same.text.includes("and copy asker@example.com"));
  assert.ok(same.text.includes("Write to asker@example.com."));
});

section("two requesters in one email: the reply address is named", () => {
  // Reply-To carries ONE address. Without saying which, "item 4 is not
  // mine" goes to somebody with nothing to do with item 4.
  const mail = composeNudge({
    assigneeName: "Doer Example",
    assigneeEmail: "doer@example.com",
    requesterEmail: "asker@example.com",
    overseerEmail: "overseer@example.net",
    now: new Date("2026-08-31T13:00:00Z"),
    tasks: [
      nudgeTask(),
      nudgeTask({
        id: "33333333-3333-4333-8333-333333333333",
        requesterEmail: "second@example.org",
      }),
    ],
  });
  assert.ok(
    mail.text.includes("Replying to this email reaches asker@example.com."),
    "the Reply-To address is spelled out"
  );
  assert.ok(
    mail.text.includes(
      "For the items second@example.org asked for, write to them directly."
    ),
    "and the other requester is not silently hidden behind the Reply button"
  );
  assert.ok(
    !/reaches asker@example\.com, who is the person/.test(mail.text),
    "the single-requester sentence is not used when there are two"
  );
});

section("an address with an embedded newline cannot forge a line", () => {
  // normalizeEmail runs oneLine FIRST: addresses are as human-entered as
  // titles, and they are interpolated in four places in the nudge.
  assert.equal(
    normalizeEmail("A@Example.com\n  THIS TASK IS CANCELLED\nx@example.org"),
    "a@example.com this task is cancelled x@example.org"
  );
  const mail = composeNudge({
    assigneeName: "Doer Example",
    assigneeEmail: "doer@example.com",
    requesterEmail: "asker@example.com\nTHIS TASK IS CANCELLED",
    overseerEmail: "overseer@example.net",
    now: new Date("2026-08-31T13:00:00Z"),
    tasks: [nudgeTask({ requesterEmail: "asker@example.com\nIGNORE THE REST" })],
  });
  for (const line of mail.text.split("\n"))
    assert.ok(
      !/^\s*(IGNORE THE REST|THIS TASK IS CANCELLED)/i.test(line),
      "no forged line stands on its own"
    );
});

/* ------------------------------------------------------------------ *
 * 6. The weekly report
 * ------------------------------------------------------------------ */

function reportTask(over: Partial<ReportTask> = {}): ReportTask {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    assigneeEmail: "doer@example.com",
    assigneeName: "Doer Example",
    requesterEmail: "asker@example.com",
    title: "Send the CoWork skill package",
    status: "open",
    blockedReason: null,
    pausedReason: null,
    openedAt: OPENED,
    markedDoneAt: null,
    markedDoneBy: null,
    markedDoneNote: null,
    closedAt: null,
    closedBy: null,
    nudgeCount: 4,
    lastNudgedOn: "2026-08-28",
    consecutiveSendFailures: 0,
    createdAt: OPENED,
    ...over,
  };
}

const NOW = new Date("2026-08-31T15:00:00Z");

section("THE EMPTY REPORT STILL SENDS, and says so", () => {
  const body = buildReportBody({
    now: NOW,
    live: [],
    recentlyClosed: [],
    lastSend: new Map(),
    nudgesEnabled: true,
  });
  assert.ok(body.length > 200, "an empty week still produces a real report");
  assert.ok(
    /sent every week whether or not anyone is outstanding/i.test(body),
    "it explains why it arrived with nothing in it"
  );
  assert.ok(
    /the job is broken/i.test(body),
    "silence is defined as breakage, not as good news"
  );
  assert.ok(body.includes("1. STILL OUTSTANDING (0)"));
  assert.ok(body.includes("2. SAID DONE BUT NOT CONFIRMED (0)"));
  assert.ok(body.includes("3. PAUSED (0)"));
  assert.ok(body.includes("4. BLOCKED (0)"));
  assert.ok(body.includes("5. CLOSED IN THE LAST 7 DAYS (0)"));
});

section("the report's five sections carry what the owner has to act on", () => {
  const body = buildReportBody({
    now: NOW,
    live: [
      reportTask({ status: "open" }),
      reportTask({
        id: "22222222-2222-4222-8222-222222222222",
        status: "open",
        markedDoneAt: new Date("2026-08-29T00:00:00Z"),
        markedDoneBy: "someone@example.org",
        markedDoneNote: "sent it last week",
      }),
      reportTask({
        id: "33333333-3333-4333-8333-333333333333",
        status: "paused",
        pausedReason: "They sent the same package again.",
      }),
      reportTask({
        id: "44444444-4444-4444-8444-444444444444",
        status: "blocked",
        blockedReason: "Attribution unconfirmed.",
      }),
    ],
    recentlyClosed: [
      reportTask({
        id: "55555555-5555-4555-8555-555555555555",
        status: "done",
        closedAt: new Date("2026-08-30T00:00:00Z"),
        closedBy: "detector",
      }),
    ],
    lastSend: new Map([
      [
        "doer@example.com",
        { sendDate: "2026-08-28", outcome: "accepted", detail: null, taskCount: 1 },
      ],
    ]),
    nudgesEnabled: true,
  });
  assert.ok(body.includes("1. STILL OUTSTANDING (1)"));
  assert.ok(body.includes("2. SAID DONE BUT NOT CONFIRMED (1)"));
  assert.ok(body.includes("3. PAUSED (1)"));
  assert.ok(body.includes("4. BLOCKED (1)"));
  assert.ok(body.includes("5. CLOSED IN THE LAST 7 DAYS (1)"));
  // The outstanding entry carries name, ask, when asked, reminder count and
  // the last send outcome: the five facts the owner asked for.
  assert.ok(body.includes("Doer Example <doer@example.com>"));
  assert.ok(body.includes("Ask: Send the CoWork skill package"));
  assert.ok(body.includes("Asked 2026-08-20 (11 days ago)"));
  assert.ok(body.includes("reminders sent: 4"));
  assert.ok(body.includes("last email 2026-08-28: accepted"));
  // The two sections nobody is being emailed about say so in the heading.
  assert.ok(/NOBODY IS BEING EMAILED/.test(body));
  assert.ok(/NO EMAIL HAS EVER GONE OUT/.test(body));
  assert.ok(body.includes("Paused because: They sent the same package again."));
  assert.ok(body.includes("Blocked because: Attribution unconfirmed."));
});

section("every actionable item prints the id chase:admin needs", () => {
  // The report's own call to action is `chase:admin <op> <id>`, and that
  // command dies without a uuid. A report naming four people who need a
  // ruling and no ids is one the reader has to open psql to act on.
  const body = buildReportBody({
    now: new Date("2026-08-31T15:00:00Z"),
    live: [
      reportTask({ id: "11111111-1111-4111-8111-111111111111", status: "open" }),
      reportTask({
        id: "22222222-2222-4222-8222-222222222222",
        status: "paused",
        pausedReason: "They re-sent the same package.",
      }),
      reportTask({
        id: "33333333-3333-4333-8333-333333333333",
        status: "blocked",
        blockedReason: "Attribution not confirmed.",
      }),
      reportTask({
        id: "44444444-4444-4444-8444-444444444444",
        status: "open",
        markedDoneAt: new Date("2026-08-30T00:00:00Z"),
      }),
    ],
    recentlyClosed: [],
    lastSend: new Map(),
    nudgesEnabled: true,
  });
  for (const id of [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
    "44444444-4444-4444-8444-444444444444",
  ])
    assert.ok(body.includes(`  id ${id}`), `${id} is printed`);
  assert.ok(
    /npm run chase:admin -- <op> <id>/.test(body),
    "and the footer tells the reader what to do with them"
  );
});

section("a row nobody is being emailed about says so, loudly", () => {
  // The weekday job skips an assignee the site no longer has in its records
  // (or who has a recorded deletion). Without this line the owner reads
  // those rows as people ignoring him.
  const body = buildReportBody({
    now: new Date("2026-08-31T15:00:00Z"),
    live: [reportTask({ status: "open" })],
    recentlyClosed: [],
    lastSend: new Map(),
    nudgesEnabled: true,
    unreachable: new Map([
      ["doer@example.com", "no longer in company_people or users"],
    ]),
  });
  assert.ok(body.includes("NO EMAIL IS GOING OUT"));
  assert.ok(body.includes("no longer in company_people or users"));
  assert.ok(
    body.includes("They are not ignoring you."),
    "the summary explains the group before the reader reaches it"
  );
  // And the ordinary case says nothing of the kind.
  const clean = buildReportBody({
    now: new Date("2026-08-31T15:00:00Z"),
    live: [reportTask({ status: "open" })],
    recentlyClosed: [],
    lastSend: new Map(),
    nudgesEnabled: true,
  });
  assert.ok(!clean.includes("NO EMAIL IS GOING OUT"));
});

section("a claim of completion outranks the status in the partition", () => {
  const s = partitionForReport([
    reportTask({ status: "paused", pausedReason: "x", markedDoneAt: new Date() }),
  ]);
  assert.equal(s.claimedDone.length, 1);
  assert.equal(s.paused.length, 0);
});

section("a repeatedly failing send reads as delivery, not as a person", () => {
  const body = buildReportBody({
    now: NOW,
    live: [reportTask({ consecutiveSendFailures: 9 })],
    recentlyClosed: [],
    lastSend: new Map([
      [
        "doer@example.com",
        { sendDate: "2026-08-28", outcome: "refused", detail: "vendor said no", taskCount: 1 },
      ],
    ]),
    nudgesEnabled: true,
  });
  assert.ok(body.includes("9 send failure(s) in a row"));
  assert.ok(/delivery problem before a person problem/.test(body));
});

section("a switched-off sender is stated, so nobody reads it as neglect", () => {
  const body = buildReportBody({
    now: NOW,
    live: [reportTask()],
    recentlyClosed: [],
    lastSend: new Map(),
    nudgesEnabled: false,
  });
  assert.ok(body.includes("WEEKDAY REMINDERS ARE SWITCHED OFF"));
  assert.ok(body.includes("WORK_CHASE_ENABLED=0"));
});

section("the report subject is a stable constant", () => {
  assert.ok(CHASE_REPORT_SUBJECT.startsWith("[aiwebsite] "));
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(CHASE_REPORT_SUBJECT), "no date in it");
  assert.ok(!/\(\d+\)/.test(CHASE_NUDGE_SUBJECT), "no count in it");
});

/* ------------------------------------------------------------------ *
 * 7. Small pure helpers
 * ------------------------------------------------------------------ */

section("address helpers fold case and refuse junk", () => {
  assert.equal(normalizeEmail("  Doer@Example.COM "), "doer@example.com");
  assert.ok(sameEmail("A@Example.com", "a@example.COM"));
  assert.ok(!sameEmail(null, "a@example.com"));
  assert.ok(!sameEmail("a@example.com", null));
  assert.ok(looksLikeEmail("a@example.co"));
  assert.ok(!looksLikeEmail("nope"));
  assert.ok(!looksLikeEmail("a@example"));
  assert.ok(!looksLikeEmail("a b@example.com"));
});

/* ------------------------------------------------------------------ *
 * 7b. The blocked-contact guard
 *
 * The production identities live ONLY as sha256 digests (the repo is
 * public), so every test here INJECTS its own hash set over invented
 * identities and never touches BLOCKED_CONTACT_SHA256's members beyond
 * counting them. The invented pair below is fictional on purpose.
 * ------------------------------------------------------------------ */

const inj = (s: string) =>
  createHash("sha256").update(s.toLowerCase()).digest("hex");
const FAKE_EMAIL = "robot.persona@example.com";
const FAKE_NAME = "Robot Persona";
const INJECTED: ReadonlySet<string> = new Set([inj(FAKE_EMAIL), inj(FAKE_NAME)]);

section("the production policy is four digests and nothing readable", () => {
  assert.equal(BLOCKED_CONTACT_SHA256.size, 4);
  for (const h of BLOCKED_CONTACT_SHA256)
    assert.ok(/^[0-9a-f]{64}$/.test(h), "sha256 hex, lowercased");
});

section("a blocked requester never reaches the Reply-To HEADER either", () => {
  // The body substitution alone is not enough: a scrubbed sentence naming
  // the overseer over a header still routing replies to a machine-account
  // mailbox would send "this is not mine, stop" to software after all.
  assert.equal(
    nudgeReplyTo(FAKE_EMAIL, "overseer@example.net", INJECTED),
    "overseer@example.net"
  );
  // An ordinary requester is untouched, with or without the hash set.
  assert.equal(
    nudgeReplyTo("Asker@Example.com", "overseer@example.net", INJECTED),
    "asker@example.com"
  );
  // No overseer passed (the pre-guard call shape) stays the plain address.
  assert.equal(nudgeReplyTo(FAKE_EMAIL), FAKE_EMAIL);
});

section("the detector finds an email and a name bigram, case-folded", () => {
  const text = `Ask ROBOT persona, or write to Robot.Persona@Example.com today.`;
  const spans = findBlockedContacts(text, INJECTED);
  assert.equal(spans.length, 2);
  assert.deepEqual(
    spans.map((s) => s.kind),
    ["name", "email"]
  );
  assert.equal(text.slice(spans[0].start, spans[0].end), "ROBOT persona");
  assert.equal(
    text.slice(spans[1].start, spans[1].end),
    "Robot.Persona@Example.com"
  );
  // A name closing a sentence is still found: the word class swallows the
  // trailing period, and the trimmed bigram is hashed too.
  const ended = findBlockedContacts("Write to Robot Persona.", INJECTED);
  assert.equal(ended.length, 1);
  assert.equal(
    "Write to Robot Persona.".slice(ended[0].start, ended[0].end),
    "Robot Persona",
    "the punctuation stays outside the span"
  );
  // Clean text, and near misses, find nothing.
  assert.equal(findBlockedContacts("Ask Doer Example.", INJECTED).length, 0);
  assert.equal(findBlockedContacts("Robot alone", INJECTED).length, 0);
  assert.equal(
    findBlockedContacts("other.robot@example.com", INJECTED).length,
    0
  );
});

section("scrub replaces a bare mention with the requester address", () => {
  assert.equal(
    scrubBlockedContacts(
      `Send it to ${FAKE_EMAIL} today.`,
      "asker@example.com",
      INJECTED
    ),
    "Send it to asker@example.com today."
  );
  assert.equal(
    scrubBlockedContacts(
      `Ask ${FAKE_NAME} for the list.`,
      "asker@example.com",
      INJECTED
    ),
    "Ask asker@example.com for the list."
  );
  // A mention inside an ORDINARY parenthetical keeps the shell: only the
  // relay wrappers exist solely to name the identity.
  assert.equal(
    scrubBlockedContacts(
      `The list (ask ${FAKE_NAME}) is ready.`,
      "asker@example.com",
      INJECTED
    ),
    "The list (ask asker@example.com) is ready."
  );
});

section("a relay parenthetical goes WHOLE, not just the name inside it", () => {
  // "(relayed by <replacement>)" would promote the replacement address to a
  // claim nobody made, so the wrapper goes with its contents.
  assert.equal(
    scrubBlockedContacts(
      `Adam (relayed by ${FAKE_NAME}) has decided to proceed.`,
      "asker@example.com",
      INJECTED
    ),
    "Adam has decided to proceed."
  );
  assert.equal(
    scrubBlockedContacts(
      `Approved (via ${FAKE_EMAIL}).`,
      "asker@example.com",
      INJECTED
    ),
    "Approved."
  );
  assert.equal(
    scrubBlockedContacts(
      `Approved (per ${FAKE_NAME}), ship it.`,
      "asker@example.com",
      INJECTED
    ),
    "Approved, ship it."
  );
  // Two mentions inside one wrapper collapse to ONE deletion.
  assert.equal(
    scrubBlockedContacts(
      `Adam (relayed by ${FAKE_NAME}, ${FAKE_EMAIL}) agreed.`,
      "asker@example.com",
      INJECTED
    ),
    "Adam agreed."
  );
  // Untouched text comes back byte-identical.
  const clean = "Nothing to see (via the portal) here.";
  assert.equal(scrubBlockedContacts(clean, "asker@example.com", INJECTED), clean);
});

section("the seed gate refuses a poisoned row without echoing the identity", () => {
  const row = {
    title: "Send the morning package",
    detail: "Please send it.",
    assigneeEmail: "doer@example.com",
    assigneeName: "Doer Example",
    requesterEmail: "asker@example.com",
  };
  assert.equal(seedRowContactRefusal(row, INJECTED), null, "clean row passes");
  for (const poisoned of [
    { ...row, detail: `Please send it (relayed by ${FAKE_NAME}).` },
    { ...row, detail: `Write to ${FAKE_EMAIL} when done.` },
    { ...row, assigneeName: FAKE_NAME },
    { ...row, requesterEmail: FAKE_EMAIL },
    { ...row, title: `Ask ${FAKE_NAME} about the brief` },
    // The optional trio is covered too: every field a reminder or the
    // report could ever print.
    { ...row, actionUrl: `https://ai.xl.net/work?ask=${FAKE_EMAIL}` },
    { ...row, blockedReason: `Waiting on ${FAKE_NAME} to confirm.` },
    { ...row, detectorArg: FAKE_EMAIL },
  ]) {
    const msg = seedRowContactRefusal(poisoned, INJECTED);
    assert.ok(msg, "the poisoned row is refused");
    if (!msg) continue;
    assert.ok(
      !msg.toLowerCase().includes(FAKE_NAME.toLowerCase()) &&
        !msg.toLowerCase().includes(FAKE_EMAIL),
      "the refusal never echoes what it matched"
    );
    assert.ok(/machine-account identity/.test(msg), "and says why");
    assert.ok(/requester/.test(msg), "and who the contact must be");
  }
});

section("composeNudge scrubs a poisoned legacy row (the backstop)", () => {
  const mail = composeNudge({
    // The assignee's own display name and the action URL are as
    // human-entered as the title, and both are interpolated.
    assigneeName: FAKE_NAME,
    assigneeEmail: "doer@example.com",
    requesterEmail: "asker@example.com",
    overseerEmail: "overseer@example.net",
    now: new Date("2026-08-31T13:00:00Z"),
    blockedContactHashes: INJECTED,
    tasks: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        title: `Send the morning brief to ${FAKE_NAME}`,
        detail: `Adam (relayed by ${FAKE_NAME}) wants it; write to ${FAKE_EMAIL}.`,
        actionUrl: `https://ai.xl.net/work/submit?ref=${FAKE_EMAIL}`,
        openedAt: OPENED,
        requesterEmail: "asker@example.com",
        detector: "work_submission",
      },
    ],
  });
  assert.ok(!mail.text.toLowerCase().includes(FAKE_NAME.toLowerCase()));
  assert.ok(!mail.text.includes(FAKE_EMAIL));
  assert.ok(
    mail.text.includes("Send the morning brief to asker@example.com"),
    "a bare mention becomes the requester"
  );
  assert.ok(
    mail.text.includes("Adam wants it; write to asker@example.com."),
    "the relay wrapper is gone whole"
  );
});

section("a BLOCKED requester is replaced by the overseer, everywhere", () => {
  // The requester address is the scrub's own replacement value, so an
  // unchecked one would be pasted back into every sentence the scrub
  // guards. When it trips the detector, the overseer stands in for that
  // item before any other use: the overseer really can stop the emails,
  // which is the promise every use of the address carries.
  const mail = composeNudge({
    assigneeName: "Doer Example",
    assigneeEmail: "doer@example.com",
    requesterEmail: FAKE_EMAIL,
    overseerEmail: "overseer@example.net",
    now: new Date("2026-08-31T13:00:00Z"),
    blockedContactHashes: INJECTED,
    tasks: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        title: `Send the package to ${FAKE_NAME}`,
        detail: "We need it for the handover.",
        actionUrl: null,
        openedAt: OPENED,
        requesterEmail: FAKE_EMAIL,
        detector: "manual",
      },
    ],
  });
  assert.ok(!mail.text.includes(FAKE_EMAIL), "the address never prints");
  assert.ok(!mail.text.toLowerCase().includes(FAKE_NAME.toLowerCase()));
  assert.ok(
    mail.text.includes("Asked by overseer@example.net"),
    "the per-item asker line names the overseer"
  );
  assert.ok(
    mail.text.includes("send it to overseer@example.net directly"),
    "so does the no-link fallback"
  );
  assert.ok(
    mail.text.includes("Replying to this email reaches overseer@example.net"),
    "and the Reply-To sentence"
  );
  assert.ok(
    mail.text.includes("Send the package to overseer@example.net"),
    "and the scrub replacement itself is the substituted address"
  );
});

section("the weekly report scrubs every free-text string it prints", () => {
  const body = buildReportBody({
    now: new Date("2026-08-31T15:00:00Z"),
    blockedContactHashes: INJECTED,
    live: [
      reportTask({
        title: `Chase the ${FAKE_NAME} handover`,
        status: "paused",
        pausedReason: `Waiting on ${FAKE_EMAIL} to answer.`,
      }),
      reportTask({
        id: "22222222-2222-4222-8222-222222222222",
        title: "Send the report",
        status: "blocked",
        blockedReason: `Adam (relayed by ${FAKE_NAME}) has not ruled yet.`,
      }),
      // The said-done stamps are operator-typed on the admin paths, and
      // the assignee display name is as human-entered as a title.
      reportTask({
        id: "44444444-4444-4444-8444-444444444444",
        assigneeName: FAKE_NAME,
        status: "open",
        markedDoneAt: new Date("2026-08-29T00:00:00Z"),
        markedDoneBy: FAKE_EMAIL,
        markedDoneNote: `Handed to ${FAKE_NAME} last week.`,
      }),
      // The last-send failure detail is stored vendor text.
      reportTask({
        id: "55555555-5555-4555-8555-555555555555",
        status: "open",
      }),
    ],
    recentlyClosed: [
      reportTask({
        id: "33333333-3333-4333-8333-333333333333",
        title: `Ping ${FAKE_NAME}`,
        status: "done",
        closedAt: new Date("2026-08-30T00:00:00Z"),
        closedBy: FAKE_EMAIL,
      }),
    ],
    lastSend: new Map([
      [
        "doer@example.com",
        {
          sendDate: "2026-08-28",
          outcome: "refused",
          detail: `vendor said no, contact ${FAKE_EMAIL}`,
          taskCount: 1,
        },
      ],
    ]),
    nudgesEnabled: true,
  });
  assert.ok(!body.toLowerCase().includes(FAKE_NAME.toLowerCase()));
  assert.ok(!body.includes(FAKE_EMAIL));
  assert.ok(body.includes("Waiting on asker@example.com to answer."));
  assert.ok(body.includes("Adam has not ruled yet."));
  assert.ok(body.includes("Said done 2026-08-29 by asker@example.com"));
  assert.ok(body.includes("Handed to asker@example.com last week."));
  assert.ok(body.includes("vendor said no, contact asker@example.com"));
  assert.ok(body.includes("done 2026-08-30 by asker@example.com"));
});

/* ------------------------------------------------------------------ *
 * 8. Source scrapes: the invariants types cannot hold
 * ------------------------------------------------------------------ */

/** EVERY file in the lane, DISCOVERED rather than listed. A hardcoded array
 * silently stops covering the lane the moment somebody adds a file to it,
 * and the two files a future session would most plausibly paste a real
 * colleague into (the migration, where an INSERT would go, and the schema,
 * where a map would go) were exactly the two a hardcoded list had missed. */
const CHASE_FILES = [
  ...readdirSync(resolve(repo, "src/lib/chase"))
    .filter((f) => f.endsWith(".ts"))
    .sort()
    .map((f) => `src/lib/chase/${f}`),
  ...readdirSync(resolve(repo, "scripts"))
    .filter((f) => /^chase-.*\.ts$/.test(f))
    .sort()
    .map((f) => `scripts/${f}`),
  "src/lib/db/chase-schema.ts",
  ...readdirSync(resolve(repo, "drizzle/migrations"))
    .filter((f) => /chase_register\.sql$/.test(f))
    .sort()
    .map((f) => `drizzle/migrations/${f}`),
];

function src(rel: string): string {
  return readFileSync(resolve(repo, rel), "utf8");
}

section("the weekday job CLAIMS the ledger row before it composes or sends", () => {
  const s = src("scripts/chase-run.ts");
  const claim = s.indexOf("await claimSend(");
  const send = s.indexOf("await sendChaseNudge(");
  assert.ok(claim > 0 && send > 0, "both calls are present");
  assert.ok(
    claim < send,
    "the INSERT is the double-send guarantee; composing first would let two passes both send"
  );
  assert.ok(
    s.indexOf("await detectCompletions(") < s.indexOf("await openTasksForNudge()"),
    "completions are detected BEFORE the open tasks are selected"
  );
  assert.ok(
    /if \(!sendId\)/.test(s),
    "a lost claim race sends nothing rather than proceeding"
  );
  assert.ok(/process\.getuid\(\) === 0/.test(s), "refuses to run as root");
  assert.ok(s.includes("--dry-run"), "a dry run exists");
});

section("the report job never learns to skip an empty week", () => {
  const s = src("src/lib/chase/report.ts");
  assert.ok(
    /IT SENDS EVERY WEEK/.test(s),
    "the reason is written where the next editor will see it"
  );
  const claim = s.indexOf("await claimSend(");
  const build = s.indexOf("await buildReportBodyFromDb(");
  assert.ok(claim > 0 && build > 0 && claim < build, "claim before compose");
  assert.ok(
    s.includes('kind: "report"'),
    "the report is ledgered so a restart cannot double-send it"
  );
});

section("the seeding gates are all six still there", () => {
  const s = src("scripts/chase-seed.ts");
  assert.ok(s.includes("knownDirectoryEmails"), "gate 1: the directory check");
  assert.ok(
    /requester \$\{row\.requesterEmail\} is not in company_people or users/.test(s),
    "gate 1 covers the REQUESTER too: the nudge tells the reader to write to that address to make the mail stop"
  );
  assert.ok(/an open row needs openedAt/.test(s), "gate 2: the time floor");
  assert.ok(/a blocked row needs blockedReason/.test(s), "gate 3");
  assert.ok(/needs detectorArg/.test(s), "gate 4");
  assert.ok(/needs actionUrl \(gate 5\)/.test(s), "gate 5: a link to act on");
  assert.ok(
    s.includes("seedRowContactRefusal"),
    "gate 6: no row may name a machine-account identity as a contact"
  );
  assert.ok(
    s.includes("db.transaction"),
    "the --apply loop is ONE transaction: a half-written batch emails people about a list the operator was told was refused"
  );
  assert.ok(
    /nothing was written/i.test(s),
    "a refusal refuses the WHOLE batch rather than seeding part of it"
  );
  assert.ok(
    s.includes("chase_task_live_uq"),
    "duplicates are the index's job, not a read-then-write race"
  );
  assert.ok(
    /readFileSync\(0, "utf8"\)/.test(s),
    "the list can come from stdin, so it never has to touch the disk"
  );
  assert.ok(/process\.getuid\(\) === 0/.test(s), "refuses to run as root");
});

section("the admin console guards an attribution unblock", () => {
  const s = src("scripts/chase-admin.ts");
  assert.ok(/ATTRIBUTION_RE = \/attribution\/i/.test(s));
  assert.ok(s.includes("--attribution-confirmed"));
  assert.ok(
    /--actor <email> is required with --apply/.test(s),
    "an unattributed close is not a record"
  );
  // The arg parser must consume a flag's VALUE by index. A filter over argv
  // by string equality would make `--reason close` delete the operator's op
  // as well, and the script would then read the task id as the op.
  assert.ok(s.includes("VALUE_FLAGS"), "index-aware argument parsing");
  assert.ok(
    !/a !== reason && a !== actor/.test(s),
    "no filter-by-string-equality argument parsing"
  );
  for (const op of ["unblock", "open", "pause", "close", "decline", "cancel"])
    assert.ok(s.includes(`"${op}"`), `the ${op} op exists`);
});

section("both outbound builders run the blocked-contact scrub", () => {
  // The seed gate is the fence; these two calls are the backstop for a row
  // seeded before the gate existed. Losing either one silently reopens the
  // incident (a machine-account identity mailed as a contact), so their
  // presence is pinned the way the claim-before-send order is.
  assert.ok(
    src("src/lib/chase/notify.ts").includes("scrubBlockedContacts("),
    "composeNudge scrubs title and detail"
  );
  assert.ok(
    src("src/lib/chase/report.ts").includes("scrubBlockedContacts("),
    "buildReportBody scrubs titles and reasons"
  );
});

section("this round ships NO web surface: no route, no page, no reply lane", () => {
  // The deliberate boundary. If a later round adds one, it should also add
  // the review this round did not do, and delete this pin on purpose. This
  // file is excluded because it necessarily quotes the very patterns it
  // bans, which is the one place they are allowed to appear.
  for (const rel of CHASE_FILES.filter((f) => f !== "scripts/chase-tests.ts")) {
    const s = src(rel);
    assert.ok(
      !/NextRequest|NextResponse|export async function (GET|POST|PATCH|DELETE)/.test(s),
      `${rel} must not carry an API route`
    );
  }
});

section("a refused weekly report FAILS the unit instead of going quiet", () => {
  // The report is the one message with no backstop: the thing that would
  // have reported its own failure is the report. Exit 0 on a refusal leaves
  // the owner with the silence he is told means breakage, and nothing
  // telling him it happened, until the next Monday.
  const s = src("scripts/chase-report.ts");
  const refused = s.indexOf('case "refused":');
  assert.ok(refused > 0, "the refusal case exists");
  const tail = s.slice(refused, refused + 800);
  assert.ok(
    /process\.exit\(1\)/.test(tail),
    "a refused report exits nonzero so aiwebsite-chase-report-alert fires"
  );
  // The weekday nudge deliberately does NOT: one permanently bad address
  // must not page an operator nightly, and Monday's report covers it.
  const run = src("scripts/chase-run.ts");
  const runRefused = run.indexOf("refused++");
  assert.ok(runRefused > 0);
  assert.ok(
    !/process\.exit\(1\)/.test(run.slice(runRefused - 400, runRefused + 200)),
    "a refused nudge stays exit 0"
  );
});

section("the report's claim is released unless the send was ACCEPTED", () => {
  const r = src("src/lib/chase/report.ts");
  assert.ok(
    /reclaimUnlessAccepted: true/.test(r),
    "one transient failure must not burn the whole week on a Mon-only timer"
  );
  const d = src("src/lib/chase/db.ts");
  assert.ok(
    /coalesce\(\$\{S\.outcome\}, ''\) <> 'accepted'/.test(d),
    "and an ACCEPTED row is never reclaimed, so a second copy is impossible"
  );
  assert.ok(
    /IN \('refused','threw'\) OR/.test(d) && /pendingStaleMinutes/.test(d),
    "nor is a 'pending' row inside the stale window: that is another process mid-send, and reclaiming it would be the double-send the index exists to stop"
  );
  assert.ok(
    CHASE_CAPS.pendingStaleMinutes * 60 > 20,
    "the stale window is far above the send seam's own 20 second fetch timeout"
  );
  // The nudge must NOT reclaim: a colleague would rather miss one day than
  // get two emails in one.
  const run = src("scripts/chase-run.ts");
  assert.ok(
    !/reclaimUnlessAccepted/.test(run),
    "the weekday nudge keeps the strict one-per-day claim"
  );
});

section("reopening a PAUSED row really restarts the reminders", () => {
  // Both automatic pauses (identical resubmission, and a near-matched
  // submission the review still holds) rest on a submission that is still
  // there. Preserving opened_at would let the next run re-pause the row
  // inside the same run, making chase:admin open silently inert and the
  // pause a one-way trip.
  const d = src("src/lib/chase/db.ts");
  const open = d.indexOf("export async function openTask(");
  assert.ok(open > 0);
  const body = d.slice(open, open + 900);
  assert.ok(
    /opts\.from === "paused" \? sql`now\(\)`/.test(body),
    "a paused row's time floor moves to now on reopen"
  );
  assert.ok(
    /coalesce\(\$\{T\.openedAt\}, now\(\)\)/.test(body),
    "a blocked row keeps an opened_at it already had"
  );
});

section("no ledger row is left at 'pending' pretending to be delivered", () => {
  const s = src("scripts/chase-run.ts");
  assert.ok(
    /let sendId: string \| null = null;/.test(s),
    "sendId is hoisted OUT of the try so the catch can reach it"
  );
  const caught = s.indexOf("} catch (err) {", s.indexOf("THE CLAIM"));
  assert.ok(caught > 0);
  const tail = s.slice(caught, caught + 700);
  assert.ok(/recordSendOutcome\(sendId, "threw"/.test(tail));
  assert.ok(/markTasksSendFailed\(claimedIds\)/.test(tail));
});

section("the send loop re-reads status after the claim, and skips the dead", () => {
  const s = src("scripts/chase-run.ts");
  const claim = s.indexOf("await claimSend(");
  const reread = s.indexOf("await stillOpenTaskIds(");
  const send = s.indexOf("await sendChaseNudge(");
  assert.ok(claim > 0 && reread > claim && send > reread, "claim, re-read, send");
  assert.ok(
    s.indexOf("await unreachableAssignees(") < claim,
    "an assignee the site no longer has is dropped BEFORE a row is claimed for them"
  );
  assert.ok(
    /groups\.delete\(addr\)/.test(s),
    "and dropped from the batch, not merely logged"
  );
});

section("a DRY run names the people a live run would actually email", () => {
  // Detection writes nothing in DRY, so the rows it just decided to close
  // are still open in the database and would print as WOULD SEND.
  const s = src("scripts/chase-run.ts");
  assert.ok(/detected\.handledIds\.has\(t\.id\)/.test(s));
  assert.ok(/DRY && detected\.handledIds/.test(s));
});

section("both timed jobs stand down while a deploy is in progress", () => {
  // post-install.sh enables AND starts both timers before db:migrate and the
  // cutover, so a deploy across 13:00 on a weekday would otherwise fire
  // against the pre-migrate tree and page an operator on the deploy that
  // shipped the feature.
  for (const rel of ["scripts/chase-run.ts", "scripts/chase-report.ts"])
    assert.ok(/if \(deployInProgress\(\)\)/.test(src(rel)), `${rel} checks the marker`);
  assert.ok(
    src("src/lib/chase/db.ts").includes(
      'fs.statSync("/var/run/aiwebsite-deploy-in-progress")'
    ),
    "the same marker file governance/db.ts stats"
  );
});

section("close evidence is never stored as half a JSON token", () => {
  const d = src("src/lib/chase/db.ts");
  assert.ok(
    !/JSON\.stringify\(opts\.evidence\)\.slice\(/.test(d),
    "a byte slice over serialized JSON leaves a row nothing can parse"
  );
  assert.ok(/truncated: true, bytes: j\.length/.test(d));
});

section("the schema file describes chase_task_live_uq as it was built", () => {
  // CLAUDE.md: when code and the doc disagree, the code wins. The index has
  // FOUR key columns; a three-column comment oversells the anti-reseed rail.
  const sql = src(
    CHASE_FILES.find((f) => f.endsWith("_chase_register.sql")) as string
  );
  assert.ok(
    /lower\(assignee_email\), detector, coalesce\(detector_arg, ''\), lower\(title\)/.test(
      sql
    )
  );
  const schema = src("src/lib/db/chase-schema.ts");
  assert.ok(
    /coalesce\(detector_arg,''\), lower\(title\)/.test(schema),
    "the schema comment lists all four key columns"
  );
});

section("only synthetic addresses appear anywhere in the chase sources", () => {
  // The register's subject matter is which named people have not done what
  // they were asked, and this repository is public.
  const ok = /@(example\.[a-z]{2,4}|ai\.xl\.net)$/i;
  for (const rel of CHASE_FILES) {
    const found = src(rel).match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
    for (const addr of found)
      assert.ok(
        ok.test(addr),
        `${rel} names ${addr}; chase sources carry synthetic addresses only`
      );
  }
});

section("no em dash or en dash in any chase file", () => {
  for (const rel of CHASE_FILES) {
    const text = src(rel);
    assert.ok(!/[\u2013\u2014]/.test(text), `no em or en dashes in ${rel}`);
  }
});

if (failures > 0) {
  console.log(`\n${failures} section(s) FAILED`);
  process.exit(1);
}
console.log("\nAll chase register tests passed.");
