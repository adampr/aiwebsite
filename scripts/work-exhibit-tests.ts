#!/usr/bin/env -S npx tsx
// Tests for the §5.16 EXHIBIT retention lane: the pure naming rules
// (exhibitSlug, storedExhibitRelPath, isExhibitRelPath, the store-root
// escape rule) and the pure refusal decisions the operator script rests
// on (title exact-match, argv contract, the per-slot idempotence gate).
// Run: npm run test:exhibit (tsx, no DB, no disk, no brain).
//
// Style follows scripts/work-archive-correlate-tests.ts: behavioural
// assertions first, then a short source-scrape section for the invariants
// types cannot hold (the store write reports failure instead of
// swallowing it; the script takes the shared ops lock and refuses root;
// the normalizeTitle copy has not drifted from db.ts).

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXHIBIT_DIR,
  EXHIBIT_SLUG_MAX,
  exhibitSlug,
  isExhibitRelPath,
  isExhibitSlug,
  resolveUnderStoreRoot,
  sanitizeStoredName,
  storedExhibitRelPath,
  storedRelPath,
} from "../src/lib/work/archive-naming";
import staticTitles from "../src/lib/work/static-titles.json";
import { ledgerSlot } from "./lib/work-archive-ops";
import {
  EXHIBIT_DOC_SLOT,
  EXHIBIT_PACKAGE_SLOT,
  exhibitPlanRefusal,
  matchExhibitTitle,
  nearExhibitTitles,
  normalizeExhibitTitle,
  parseRetainArgs,
  planExhibitSlots,
  type ExhibitCandidate,
  type ExhibitLedgerFact,
  type PlannedExhibitFile,
} from "./lib/work-exhibit-ops";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function slugOf(title: string): string {
  const r = exhibitSlug(title);
  assert.ok(r.ok, `expected a slug for ${JSON.stringify(title)}`);
  return r.slug;
}

function refusalOf(title: string): string {
  const r = exhibitSlug(title);
  assert.ok(!r.ok, `expected a REFUSAL for ${JSON.stringify(title)}`);
  return r.reason;
}

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

// ---------------------------------------------------------------------
// exhibitSlug: the six real exhibits, then the hostile shapes.
// ---------------------------------------------------------------------
section("exhibitSlug maps the six handed-over exhibit titles", () => {
  assert.equal(slugOf("Software Brain"), "software-brain");
  assert.equal(slugOf("@aicompany/core"), "aicompany-core");
  assert.equal(slugOf("ai.xl.net"), "ai-xl-net");
  assert.equal(slugOf("IT Support Chicago"), "it-support-chicago");
  assert.equal(slugOf("Roleplay"), "roleplay");
  assert.equal(slugOf("Leo Netter"), "leo-netter");
});

section("exhibitSlug: every static exhibit title has a distinct slug", () => {
  const titles: string[] = (staticTitles.exhibits ?? []).map((e) => e.title);
  assert.ok(titles.length > 0, "the snapshot carries exhibit titles");
  const seen = new Map<string, string>();
  for (const t of titles) {
    const s = slugOf(t);
    assert.ok(
      isExhibitSlug(s),
      `${JSON.stringify(t)} produced a slug the path minter would reject: ${s}`
    );
    const prev = seen.get(s);
    assert.ok(
      prev === undefined,
      `two exhibit cards share the slug ${s}: ${JSON.stringify(prev)} and ${JSON.stringify(t)} would share a store directory`
    );
    seen.set(s, t);
  }
});

section("exhibitSlug normalizes case, spacing and punctuation", () => {
  assert.equal(slugOf("  Software   Brain  "), "software-brain");
  assert.equal(slugOf("SOFTWARE BRAIN"), "software-brain");
  assert.equal(slugOf("Ticket Reply Composer!!!"), "ticket-reply-composer");
  assert.equal(slugOf("--leading and trailing--"), "leading-and-trailing");
  assert.equal(slugOf("a___b"), "a-b");
  assert.equal(slugOf("QBR Machine 2.0"), "qbr-machine-2-0");
});

section("exhibitSlug folds unicode instead of dropping the letters", () => {
  // Precomposed and decomposed forms must agree (NFKD before folding).
  assert.equal(slugOf("Café Résumé"), "cafe-resume");
  assert.equal(slugOf("Café Résumé"), "cafe-resume");
  assert.equal(slugOf("Über Brain"), "uber-brain");
  // Non-latin text carries no [a-z0-9] and must REFUSE, never silently
  // become an empty or invented directory name.
  assert.ok(refusalOf("知识库").includes("no [a-z0-9] characters"));
  assert.ok(refusalOf("🚀🚀🚀").length > 0);
});

section("exhibitSlug REFUSES rather than falling back", () => {
  for (const bad of ["", "   ", ".", "..", "../..", "///", "!!!", " "]) {
    const reason = refusalOf(bad);
    assert.ok(
      /Refusing rather than inventing one/.test(reason),
      `the refusal explains itself for ${JSON.stringify(bad)}`
    );
  }
  // The collision argument is the reason, and it is stated: two different
  // empty-reducing titles must never share one fallback directory.
  assert.notEqual(exhibitSlug("...").ok, true);
  assert.notEqual(exhibitSlug("???").ok, true);
});

section("exhibitSlug is bounded and never ends in a hyphen", () => {
  const long = slugOf("x".repeat(200));
  assert.equal(long.length, EXHIBIT_SLUG_MAX);
  // A cut that lands on a separator must not leave a trailing hyphen.
  const cut = slugOf(`${"a".repeat(EXHIBIT_SLUG_MAX - 1)} tail`);
  assert.equal(cut.length <= EXHIBIT_SLUG_MAX, true);
  assert.ok(!cut.endsWith("-"), `slug ends in a hyphen: ${cut}`);
  assert.ok(isExhibitSlug(cut));
  const wordy = slugOf(`${"word ".repeat(40)}end`);
  assert.ok(wordy.length <= EXHIBIT_SLUG_MAX && !wordy.endsWith("-"));
  assert.ok(isExhibitSlug(wordy));
});

section("traversal can never survive into a slug", () => {
  for (const hostile of [
    "../../etc/passwd",
    "..\\..\\windows",
    "a/../b",
    "./hidden",
    "~/.ssh/id_rsa",
    "$HOME/x",
  ]) {
    const r = exhibitSlug(hostile);
    if (!r.ok) continue;
    assert.ok(isExhibitSlug(r.slug), `not a safe slug: ${r.slug}`);
    assert.ok(!r.slug.includes("/") && !r.slug.includes("\\"));
    assert.ok(!r.slug.includes("."));
    assert.notEqual(r.slug, "..");
    assert.notEqual(r.slug, ".");
  }
  assert.equal(slugOf("../../etc/passwd"), "etc-passwd");
});

// ---------------------------------------------------------------------
// storedExhibitRelPath
// ---------------------------------------------------------------------
section("storedExhibitRelPath shape and NN slots", () => {
  assert.equal(
    storedExhibitRelPath("software-brain", EXHIBIT_PACKAGE_SLOT, "brain.zip"),
    "exhibits/software-brain/00-brain.zip"
  );
  assert.equal(
    storedExhibitRelPath("software-brain", EXHIBIT_DOC_SLOT, "README.md"),
    "exhibits/software-brain/01-README.md"
  );
  assert.equal(EXHIBIT_PACKAGE_SLOT, 0);
  assert.equal(EXHIBIT_DOC_SLOT, 1);
  assert.equal(
    storedExhibitRelPath("x", 12, "a.zip"),
    "exhibits/x/12-a.zip"
  );
  // Negative and fractional indices clamp exactly as storedRelPath does.
  assert.equal(storedExhibitRelPath("x", -3, "a.zip"), "exhibits/x/00-a.zip");
  assert.equal(storedExhibitRelPath("x", 1.9, "a.zip"), "exhibits/x/01-a.zip");
  // The NN prefix is readable by the SAME ledgerSlot the submission lane
  // uses, so one gate implementation can never disagree with the other.
  assert.equal(ledgerSlot(storedExhibitRelPath("x", 0, "a.zip")), 0);
  assert.equal(ledgerSlot(storedExhibitRelPath("x", 1, "a.md")), 1);
});

section("storedExhibitRelPath sanitizes the file name", () => {
  assert.equal(
    storedExhibitRelPath("brain", 0, "../../etc/passwd"),
    "exhibits/brain/00-etc_passwd"
  );
  assert.equal(
    storedExhibitRelPath("brain", 0, "..\\..\\evil.zip"),
    "exhibits/brain/00-evil.zip"
  );
  assert.equal(
    storedExhibitRelPath("brain", 0, ".hidden.zip"),
    "exhibits/brain/00-hidden.zip"
  );
  assert.equal(storedExhibitRelPath("brain", 0, ".."), "exhibits/brain/00-upload");
  assert.equal(storedExhibitRelPath("brain", 0, ""), "exhibits/brain/00-upload");
  // Exactly three segments, always: prefix, slug, file; and the file
  // segment is the SAME sanitizeStoredName the submission lane mints, so
  // one sanitizer covers both lanes.
  for (const name of ["a/b/c.zip", "x".repeat(400), "p q.zip", "-rf.zip"]) {
    const rel = storedExhibitRelPath("brain", 0, name);
    const parts = rel.split("/");
    assert.equal(parts.length, 3, `not three segments: ${rel}`);
    assert.ok(rel.startsWith(`${EXHIBIT_DIR}/brain/`));
    assert.equal(parts[2], `00-${sanitizeStoredName(name)}`);
  }
});

section("storedExhibitRelPath refuses a slug it did not mint", () => {
  for (const bad of [
    "",
    ".",
    "..",
    "a/b",
    "a\\b",
    "Software-Brain",
    "-lead",
    "trail-",
    "a--b",
    "a_b",
    "café",
    "x".repeat(EXHIBIT_SLUG_MAX + 1),
  ])
    assert.throws(
      () => storedExhibitRelPath(bad, 0, "a.zip"),
      /not an exhibit slug/,
      `accepted a bad slug: ${JSON.stringify(bad)}`
    );
  assert.throws(
    () => storedExhibitRelPath("brain", Number.NaN, "a.zip"),
    /not a finite number/
  );
});

section("isExhibitRelPath separates the two lanes", () => {
  const uid = "123e4567-e89b-42d3-a456-426614174000";
  assert.equal(isExhibitRelPath(storedExhibitRelPath("brain", 0, "a.zip")), true);
  assert.equal(isExhibitRelPath(storedRelPath(uid, 0, "a.zip")), false);
  // The prefix is a whole segment: a submission uuid can never start with
  // it, and a file merely NAMED exhibits is not in the lane.
  assert.equal(isExhibitRelPath("exhibits"), false);
  assert.equal(isExhibitRelPath("exhibitsX/brain/00-a.zip"), false);
  assert.equal(isExhibitRelPath(`${uid}/00-exhibits.zip`), false);
});

// ---------------------------------------------------------------------
// The store-root escape rule (the real function archive-store calls).
// ---------------------------------------------------------------------
section("no exhibit path can escape the store root", () => {
  const root = "/var/data/work-archives";
  const inside = resolveUnderStoreRoot(
    root,
    storedExhibitRelPath("software-brain", 0, "brain.zip")
  );
  assert.equal(inside, `${root}/exhibits/software-brain/00-brain.zip`);
  assert.ok(inside.startsWith(root + sep));
  // Every hostile title/name pair still resolves under the root, because
  // both components are minted, not passed through.
  for (const title of ["../../etc/passwd", "..", "  ..  ", "a/../b"]) {
    const s = exhibitSlug(title);
    if (!s.ok) continue;
    for (const name of ["../../../etc/shadow", "..", "a/b/../../../c"]) {
      const abs = resolveUnderStoreRoot(root, storedExhibitRelPath(s.slug, 0, name));
      assert.ok(abs.startsWith(root + sep), `escaped: ${abs}`);
    }
  }
  // And a TAMPERED ledger rel_path (the only way an escape could arrive)
  // still throws, exhibit-shaped or not.
  for (const tampered of [
    "exhibits/../../etc/passwd",
    "exhibits/brain/../../../../etc/passwd",
    "../outside.zip",
    "/etc/passwd",
  ])
    assert.throws(
      () => resolveUnderStoreRoot(root, tampered),
      /archive path escapes the store root/,
      `did not refuse ${tampered}`
    );
  // A relative root resolves the same way (the default root is relative
  // to cwd), and the rule still holds.
  assert.throws(
    () => resolveUnderStoreRoot("data/work-archives", "exhibits/../../x"),
    /archive path escapes the store root/
  );
});

// ---------------------------------------------------------------------
// Title gate.
// ---------------------------------------------------------------------
const CARDS: ExhibitCandidate[] = [
  { title: "Software Brain", id: "brain", bay: "01" },
  { title: "@aicompany/core", id: "aicompany", bay: "02" },
  { title: "ai.xl.net", id: "aiwebsite", bay: "02" },
  { title: "IT Support Chicago", id: "itsupportchicago", bay: "02" },
  { title: "Roleplay", id: "roleplay", bay: "02" },
  { title: "Leo Netter", id: "leo-netter", bay: "02" },
  { title: "Ticket Reply Composer", id: "ticket-reply", bay: "05" },
];

section("matchExhibitTitle accepts only an exact normalized match", () => {
  const hit = matchExhibitTitle("Software Brain", CARDS);
  assert.ok(hit.ok && hit.exhibit.id === "brain");
  // Case and inner spacing are the ONLY forgiveness (that is normalizeTitle).
  for (const v of ["software brain", "  SOFTWARE   BRAIN ", "Software  Brain"]) {
    const r = matchExhibitTitle(v, CARDS);
    assert.ok(r.ok && r.exhibit.title === "Software Brain", `rejected ${v}`);
  }
  // Everything else refuses, including a prefix, a suffix and a near miss.
  for (const v of ["Software", "Software Brains", "The Software Brain", "brain"]) {
    const r = matchExhibitTitle(v, CARDS);
    assert.ok(!r.ok, `accepted a non-exact title: ${v}`);
  }
});

section("a title refusal names the near matches", () => {
  const r = matchExhibitTitle("software brains", CARDS);
  assert.ok(!r.ok);
  assert.ok(r.error.includes("Software Brain"), r.error);
  assert.ok(/Did you mean/.test(r.error));
  const none = matchExhibitTitle("zzzzz", CARDS);
  assert.ok(!none.ok);
  assert.ok(/No card title resembles it/.test(none.error));
  assert.ok(/static-titles\.json/.test(none.error));
  const empty = matchExhibitTitle("   ", CARDS);
  assert.ok(!empty.ok && /non-empty/.test(empty.error));
});

section("an ambiguous snapshot refuses instead of picking", () => {
  const dupes: ExhibitCandidate[] = [
    { title: "Beacon", bay: "03" },
    { title: "beacon", bay: "04" },
  ];
  const r = matchExhibitTitle("Beacon", dupes);
  assert.ok(!r.ok);
  assert.ok(/matches 2 exhibit cards/.test(r.error), r.error);
});

section("nearExhibitTitles is bounded and shares real words", () => {
  assert.deepEqual(
    nearExhibitTitles("support chicago", CARDS).map((c) => c.title),
    ["IT Support Chicago"]
  );
  assert.ok(nearExhibitTitles("", CARDS).length <= 5);
  assert.ok(nearExhibitTitles("ticket", CARDS, 2).length <= 2);
  // Two-letter noise words do not drag every card in.
  assert.deepEqual(nearExhibitTitles("of at in", CARDS), []);
});

section("the retain gate matches the live snapshot", () => {
  const cards: ExhibitCandidate[] = (staticTitles.exhibits ?? []).map((e) => ({
    title: e.title,
    id: e.id,
    bay: e.bay,
  }));
  for (const t of [
    "Software Brain",
    "@aicompany/core",
    "ai.xl.net",
    "IT Support Chicago",
    "Roleplay",
    "Leo Netter",
  ]) {
    const r = matchExhibitTitle(t, cards);
    assert.ok(r.ok, `the handed-over exhibit ${t} is not in the snapshot`);
  }
  // And a lane-A submission title is NOT an exhibit: the gate must not
  // let a "From the Team" card into the exhibit directory.
  const wrongLane = matchExhibitTitle("Some Submitted Skill", cards);
  assert.ok(!wrongLane.ok);
});

// ---------------------------------------------------------------------
// argv contract.
// ---------------------------------------------------------------------
section("parseRetainArgs contract", () => {
  const ok = parseRetainArgs([
    "--exhibit",
    "Software Brain",
    "--file",
    "/tmp/brain.zip",
  ]);
  assert.ok(ok.ok);
  assert.deepEqual(ok.args, {
    exhibit: "Software Brain",
    file: "/tmp/brain.zip",
    doc: null,
    dryRun: false,
    yes: false,
  });
  const full = parseRetainArgs([
    "--dry-run",
    "--exhibit",
    "Roleplay",
    "--file",
    "a.zip",
    "--doc",
    "b.md",
    "--yes",
  ]);
  assert.ok(full.ok && full.args.dryRun && full.args.yes && full.args.doc === "b.md");
  const bad = (argv: string[], re: RegExp) => {
    const r = parseRetainArgs(argv);
    assert.ok(!r.ok, `accepted ${argv.join(" ")}`);
    assert.ok(re.test(r.error), `${r.error} does not match ${re}`);
  };
  bad([], /--exhibit is required/);
  bad(["--exhibit", "Roleplay"], /--file is required/);
  bad(["--file", "a.zip"], /--exhibit is required/);
  bad(["--exhibit"], /--exhibit needs a value/);
  // A flag-shaped value is a MISSING value, never a file called --yes.
  bad(["--exhibit", "Roleplay", "--file", "--yes"], /--file needs a value/);
  bad(["--exhibit", "a", "--exhibit", "b", "--file", "x"], /--exhibit given twice/);
  bad(["--exhibit", "a", "--file", "x", "--file", "y"], /--file given twice/);
  bad(["--exhibit", "a", "--file", "x", "--doc", "y", "--doc", "z"], /--doc given twice/);
  bad(["--exhibit", "a", "--file", "x", "--force"], /unknown flag --force/);
  bad(["--exhibit", "a", "--file", "x", "stray"], /unexpected argument stray/);
  // A typo'd flag never silently becomes a positional or a value.
  bad(["--exhibit", "a", "--file", "x", "--dryrun"], /unknown flag --dryrun/);
});

// ---------------------------------------------------------------------
// The per-slot idempotence/refusal gate.
// ---------------------------------------------------------------------
const SLUG = "software-brain";
function planned(over: Partial<PlannedExhibitFile> = {}): PlannedExhibitFile {
  return {
    slot: EXHIBIT_PACKAGE_SLOT,
    label: "package",
    name: "brain.zip",
    bytes: 100,
    sha256: SHA_A,
    ...over,
  };
}
function fact(over: Partial<ExhibitLedgerFact> = {}): ExhibitLedgerFact {
  return {
    relPath: storedExhibitRelPath(SLUG, EXHIBIT_PACKAGE_SLOT, "brain.zip"),
    fileName: "brain.zip",
    bytes: 100,
    sha256: SHA_A,
    deleted: false,
    deletedAt: null,
    ...over,
  };
}
function planOf(ledger: ExhibitLedgerFact[], files: PlannedExhibitFile[]) {
  const r = planExhibitSlots(ledger, files);
  assert.ok(r.ok, `plan refused: ${r.ok ? "" : r.error}`);
  return r.plan;
}

section("an empty slot stores", () => {
  const plan = planOf([], [planned(), planned({ slot: EXHIBIT_DOC_SLOT, label: "document", name: "README.md", sha256: SHA_B })]);
  assert.deepEqual(plan.map((p) => p.action), ["store", "store"]);
  assert.equal(exhibitPlanRefusal(plan), null);
});

section("a byte-identical re-run SKIPS with a sha match message", () => {
  const plan = planOf([fact()], [planned()]);
  assert.equal(plan[0].action, "skip-sha-match");
  assert.ok(/already holds this exact file/.test(plan[0].reason ?? ""));
  assert.ok((plan[0].reason ?? "").includes(SHA_A));
  assert.equal(exhibitPlanRefusal(plan), null);
  // Same bytes under a different stored name still skips, and says so
  // rather than quietly filing a second copy of identical bytes.
  const renamed = planOf([fact({ fileName: "brain-v1.zip" })], [planned()]);
  assert.equal(renamed[0].action, "skip-sha-match");
  assert.ok(/stored under the name brain-v1\.zip/.test(renamed[0].reason ?? ""));
});

section("a DIFFERENT file for a live slot REFUSES", () => {
  const plan = planOf([fact()], [planned({ sha256: SHA_B, bytes: 200 })]);
  assert.equal(plan[0].action, "refuse");
  const refusal = exhibitPlanRefusal(plan);
  assert.ok(refusal !== null);
  assert.ok(/DIFFERENT bytes/.test(refusal ?? ""));
  assert.ok(/never replaces a stored file/.test(refusal ?? ""));
  // Same length, different bytes: the sha decides, never the size.
  const sameSize = planOf([fact()], [planned({ sha256: SHA_B })]);
  assert.equal(sameSize[0].action, "refuse");
});

section("an admin-deleted slot is retired permanently", () => {
  // Even for the very same bytes: the rel_path unique index is FULL, so
  // re-filing that name would collide, and a differently-named file would
  // resurrect a slot an admin deliberately emptied.
  for (const p of [planned(), planned({ sha256: SHA_B }), planned({ name: "other.zip" })]) {
    const plan = planOf(
      [fact({ deleted: true, deletedAt: "2026-08-20T10:00:00.000Z" })],
      [p]
    );
    assert.equal(plan[0].action, "refuse");
    assert.ok(/ADMIN-DELETED/.test(plan[0].reason ?? ""));
    assert.ok(/cleanup is final/.test(plan[0].reason ?? ""));
    assert.ok(/2026-08-20/.test(plan[0].reason ?? ""));
  }
});

section("a refusal on one slot refuses the whole run", () => {
  const plan = planOf(
    [fact({ deleted: true, deletedAt: "2026-08-20T10:00:00.000Z" })],
    [
      planned(),
      planned({ slot: EXHIBIT_DOC_SLOT, label: "document", name: "README.md", sha256: SHA_B }),
    ]
  );
  assert.equal(plan[0].action, "refuse");
  assert.equal(plan[1].action, "store");
  const refusal = exhibitPlanRefusal(plan);
  assert.ok(refusal !== null && /package:/.test(refusal));
});

section("slots are independent: one live, one free", () => {
  const plan = planOf(
    [fact()],
    [
      planned(),
      planned({ slot: EXHIBIT_DOC_SLOT, label: "document", name: "README.md", sha256: SHA_B }),
    ]
  );
  assert.deepEqual(plan.map((p) => p.action), ["skip-sha-match", "store"]);
});

section("a malformed ledger rel_path refuses the whole exhibit", () => {
  const r = planExhibitSlots(
    [fact({ relPath: `${EXHIBIT_DIR}/${SLUG}/brain.zip` })],
    [planned()]
  );
  assert.ok(!r.ok);
  assert.ok(/without a NN- slot prefix/.test(r.error));
  assert.ok(/tampered or hand-edited/.test(r.error));
});

// ---------------------------------------------------------------------
// Source-scrape tripwires.
// ---------------------------------------------------------------------
section("storeExhibitArchive reports failure instead of swallowing it", () => {
  const src = readFileSync(resolve(repo, "src/lib/work/archive-store.ts"), "utf8");
  const slice = src.slice(
    src.indexOf("export async function storeExhibitArchive"),
    src.indexOf("export async function allArchiveFilesForExhibit")
  );
  assert.ok(slice.length > 0, "storeExhibitArchive is present");
  assert.ok(
    !/console\.log\(/.test(slice),
    "the exhibit store never turns a failure into a log line (that is the intake contract, and it depends on a bytea copy this lane does not have)"
  );
  assert.ok(
    /submissionId: null/.test(slice),
    "the ledger row is written with a null submission_id"
  );
  // The intake discipline, reused verbatim.
  for (const step of [
    "const tmp = `${abs}.tmp-",
    "await writeFile(tmp, f.data)",
    "await rename(tmp, abs)",
    "const st = await stat(abs)",
    "await unlink(abs).catch(() => undefined)",
    "throw err",
  ])
    assert.ok(slice.includes(step), `missing the ${step} step`);
  assert.ok(
    slice.indexOf("await rename(tmp, abs)") < slice.indexOf("const st = await stat(abs)"),
    "the re-stat follows the rename"
  );
  assert.ok(
    slice.indexOf("const st = await stat(abs)") < slice.indexOf("db\n        .insert(A)"),
    "the ledger insert follows the verified rename"
  );
  // And the WHY is written down where the next reader will look.
  assert.ok(
    /no bytea|no other copy|NO other copy/.test(slice),
    "the comment says why this lane cannot swallow failures"
  );
  // No migration was added for this lane.
  assert.ok(
    !/alter table|ALTER TABLE/.test(src),
    "the exhibit lane adds no schema change"
  );
});

section("the retain script keeps the operator-lane invariants", () => {
  const src = readFileSync(resolve(repo, "scripts/work-exhibit-retain.ts"), "utf8");
  assert.ok(
    src.includes("pg_try_advisory_lock") && src.includes("ARCHIVE_OPS_LOCK_KEY"),
    "retain takes the SAME advisory lock as backfill and import"
  );
  assert.ok(src.includes("process.getuid"), "retain refuses to run as root");
  const lockAt = src.indexOf("pg_try_advisory_lock");
  const writeAt = src.indexOf("await storeExhibitArchive(");
  const refusalAt = src.indexOf("const refusal = exhibitPlanRefusal(plan)");
  assert.ok(lockAt > 0 && refusalAt > lockAt && writeAt > refusalAt,
    "lock, then settle every verdict, then (only then) write");
  assert.ok(
    src.lastIndexOf("await storeExhibitArchive(") === writeAt,
    "the store write appears exactly once"
  );
  // --dry-run exits before the write.
  const dryAt = src.indexOf("if (dryRun) {");
  assert.ok(dryAt > 0 && dryAt < writeAt, "the dry-run exit precedes the write");
  assert.ok(
    /DRY RUN: would store/.test(src) && /Nothing was written/.test(src),
    "the dry run says it wrote nothing"
  );
  // It never touches submissions or the clearing primitives.
  assert.ok(
    !src.includes("verifyAndClearRowBytes") &&
      !src.includes("clearArchiveData") &&
      !src.includes("archiveDataById") &&
      !src.includes(".set("),
    "retain never clears bytea and never updates a submission row"
  );
  assert.ok(
    src.includes("ARCHIVE_OPS_LOCK_KEY") &&
      readFileSync(resolve(repo, "scripts/work-archive-import.ts"), "utf8").includes(
        "ARCHIVE_OPS_LOCK_KEY"
      ) &&
      readFileSync(resolve(repo, "scripts/work-archive-backfill.ts"), "utf8").includes(
        "ARCHIVE_OPS_LOCK_KEY"
      ),
    "all three ops scripts share one lock key"
  );
});

section("the normalizeTitle copy has not drifted from db.ts", () => {
  const dbSrc = readFileSync(resolve(repo, "src/lib/work/db.ts"), "utf8");
  const opsSrc = readFileSync(resolve(repo, "scripts/lib/work-exhibit-ops.ts"), "utf8");
  const expr = 'return title.trim().replace(/\\s+/g, " ").toLowerCase();';
  assert.ok(dbSrc.includes(expr), "db.ts normalizeTitle is the expected expression");
  assert.ok(opsSrc.includes(expr), "the pure copy is the same expression");
  for (const v of ["  A  B ", "A B", "a b", "\tA\nB\t", "Ünicode  TITLE"])
    assert.equal(
      normalizeExhibitTitle(v),
      v.trim().replace(/\s+/g, " ").toLowerCase(),
      `drift on ${JSON.stringify(v)}`
    );
});

section("the console labels an exhibit row as an exhibit, not an orphan", () => {
  const island = readFileSync(
    resolve(repo, "src/app/admin/work/storage-actions-client.tsx"),
    "utf8"
  );
  assert.ok(
    island.includes("exhibit archive (no submission row, by design)"),
    "a null-submission exhibit row renders as an exhibit"
  );
  assert.ok(
    island.includes("submission removed (file kept by design)"),
    "the orphaned-submission wording is still there for the other cause"
  );
  const page = readFileSync(resolve(repo, "src/app/admin/work/page.tsx"), "utf8");
  assert.ok(
    page.includes("isExhibitRelPath(f.relPath)"),
    "the lane comes from the rel_path, not from a new column"
  );
  assert.ok(
    page.includes("f.submissionId === null || !f.rowHasBytes"),
    "lastCopy still covers both null-submission causes"
  );
});

section("no em dashes in this round's files", () => {
  for (const f of [
    "src/lib/work/archive-naming.ts",
    "src/lib/work/archive-store.ts",
    "src/lib/work/storage-report.ts",
    "src/app/admin/work/storage-actions-client.tsx",
    "scripts/lib/work-exhibit-ops.ts",
    "scripts/work-exhibit-retain.ts",
    "scripts/work-exhibit-tests.ts",
  ]) {
    const text = readFileSync(resolve(repo, f), "utf8");
    assert.ok(!/[\u2013\u2014]/.test(text), `no em or en dashes in ${f}`);
  }
});

if (failures > 0) {
  console.log(`\n${failures} section(s) FAILED`);
  process.exit(1);
}
console.log("\nAll exhibit-lane tests passed.");
