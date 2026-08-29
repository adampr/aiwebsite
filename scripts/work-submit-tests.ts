// Tests for the §5.16 scripted submission lane (scripts/work-submit.ts +
// scripts/lib/work-submit-ops.ts): argument parsing, the submitter-address
// resolution, every refusal string in the route's own wording, the kind
// ladder's pure pieces, and the gate ORDER as data.
//
// NO DATABASE, no brain, no network: everything here is pure, and the one
// DB-backed import (normalizeTitle, via work/db.ts) rides the module's lazy
// drizzle proxy and is never asked to connect. Run: npx tsx
// scripts/work-submit-tests.ts (or npm run test:submit once the script line
// is added).
//
// TWO CLASSES OF ASSERTION, deliberately:
//   - behaviour, against the helpers themselves;
//   - a SOURCE PIN of every literal scripts/lib/work-submit-ops.ts had to
//     copy out of src/app/api/work/submissions/route.ts. Those are the
//     route's four unexported local helpers and its workError() sentences;
//     they cannot be imported, so the only thing keeping them honest is a
//     comparison against the committed route file. That pin reads
//     `git show HEAD:...`, not the working copy, because this checkout is
//     shared and another session's uncommitted edits are not the contract.
//
// NO EM DASHES in any of the three files, asserted below (site rule).

import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyWorkKind } from "../src/lib/work/classify";
import { WORK_CAPS } from "../src/lib/work/config";
import type { ExtractErr, ExtractOk } from "../src/lib/work/extract";
import staticTitles from "../src/lib/work/static-titles.json";
import {
  DISABLED_MESSAGE,
  PACKAGE_MISSING_MESSAGE,
  PUBLISHED_CLASH_MESSAGE,
  SUBMIT_GATES,
  SUBMIT_USAGE,
  activeClashMessage,
  blurbRefusal,
  clip,
  dailyQuotaFor,
  docBaseName,
  firstAdminEmail,
  isDocFailure,
  kindRefusalText,
  machineEchoRefusal,
  mdNameRefusal,
  mdSizeRefusal,
  outerLevelOnly,
  packageBytesRefusal,
  packageNameRefusal,
  packageSizeRefusal,
  parseAttribution,
  parseSubmitArgs,
  quotaRefusal,
  readBlurb,
  rescueApplies,
  rescuePassMessage,
  resolveSubmitterEmail,
  standaloneDocMessage,
  staticTitleClash,
  storedName,
  titleBandRefusal,
  titlePrefixRefusal,
  uniqueViolationMessage,
  type GateId,
} from "./lib/work-submit-ops";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

function err(over: Partial<ExtractErr> = {}): ExtractErr {
  return { ok: false, code: "invalid_archive", message: "boom", ...over };
}

function okPkg(over: Partial<ExtractOk> = {}): ExtractOk {
  return {
    ok: true,
    kind: "skill",
    kindVerdict: classifyWorkKind({
      packageName: "x.skill",
      paths: ["SKILL.md"],
      innerArchivePaths: [],
      texts: [],
    }),
    docText: "doc",
    docPath: "SKILL.md",
    corpus: [{ path: "SKILL.md", text: "doc" }],
    manifest: [{ path: "SKILL.md", bytes: 3 }],
    manifestTruncated: false,
    archiveSha256: "a".repeat(64),
    archiveBytes: 10,
    ...over,
  };
}

function main(): void {
  // ---- argv -------------------------------------------------------------
  {
    const p = parseSubmitArgs([
      "--title",
      "Beacon",
      "--file",
      "/r/beacon.zip",
      "--md",
      "/r/architecture.md",
      "--blurb-file",
      "/r/blurb.txt",
      "--email",
      "adam@xl.net",
      "--attribution",
      "Adam",
      "--time-saved",
      "6.5",
      "--dry-run",
      "--yes",
    ]);
    assert.ok(p.ok);
    assert.deepEqual(p.args, {
      title: "Beacon",
      file: "/r/beacon.zip",
      md: "/r/architecture.md",
      blurbFile: "/r/blurb.txt",
      email: "adam@xl.net",
      attribution: "Adam",
      timeSaved: "6.5",
      dryRun: true,
      yes: true,
    });
  }
  {
    const p = parseSubmitArgs(["--title", "Beacon", "--file", "/r/b.zip"]);
    assert.ok(p.ok);
    assert.equal(p.args.md, null);
    assert.equal(p.args.blurbFile, null);
    assert.equal(p.args.email, null, "no --email means the ADMIN_EMAIL default");
    assert.equal(p.args.attribution, null);
    assert.equal(
      p.args.timeSaved,
      null,
      "an absent --time-saved is the form's absent field, a parse to null and not a refusal"
    );
    assert.equal(p.args.dryRun, false);
    assert.equal(p.args.yes, false);
  }
  const badArgs = (argv: string[], re: RegExp) => {
    const p = parseSubmitArgs(argv);
    assert.ok(!p.ok, `expected a refusal for ${argv.join(" ")}`);
    assert.match(p.error, re);
  };
  badArgs(["--file", "/r/b.zip"], /--title is required/);
  badArgs(["--title", "Beacon"], /--file is required/);
  badArgs(["--title"], /--title needs a value/);
  badArgs(["--title", "--file"], /--title needs a value/);
  badArgs(
    ["--title", "A", "--title", "B", "--file", "/r/b.zip"],
    /--title given twice/
  );
  badArgs(["--title", "A", "--file", "/r/b.zip", "--kick"], /unknown flag --kick/);
  badArgs(
    ["Beacon", "--file", "/r/b.zip"],
    /unexpected argument "Beacon".*quote the title/s
  );
  assert.match(SUBMIT_USAGE, /npm run work:submit --/);

  // ---- who is submitting -------------------------------------------------
  assert.equal(firstAdminEmail({ ADMIN_EMAIL: "adam@xl.net" }), "adam@xl.net");
  assert.equal(
    firstAdminEmail({ ADMIN_EMAIL: " Adam <Adam@XL.net> , other@xl.net " }),
    "adam@xl.net",
    "the display-name form and the comma list both resolve through extractAddress"
  );
  assert.equal(firstAdminEmail({}), null);
  assert.equal(firstAdminEmail({ ADMIN_EMAIL: "not-an-address" }), null);
  {
    const r = resolveSubmitterEmail(null, { ADMIN_EMAIL: "Adam <Adam@XL.net>" });
    assert.ok(r.ok);
    assert.equal(r.email, "adam@xl.net", "canonical stored form is lowercased");
    assert.equal(r.fromDefault, true);
  }
  {
    const r = resolveSubmitterEmail("Jane@xl.net", { ADMIN_EMAIL: "adam@xl.net" });
    assert.ok(r.ok);
    assert.equal(r.email, "jane@xl.net");
    assert.equal(r.fromDefault, false);
  }
  {
    const r = resolveSubmitterEmail(null, {});
    assert.ok(!r.ok);
    assert.match(r.error, /ADMIN_EMAIL is unset/);
  }
  {
    const r = resolveSubmitterEmail("someone@example.com", {});
    assert.ok(!r.ok);
    assert.match(r.error, /not in the staff lane \(xl\.net\)/);
    assert.match(r.error, /company_id null/);
  }
  {
    // Exact-label domain parse: a subdomain is not the staff lane, and this
    // system's own automation identity lives at ai.xl.net.
    const r = resolveSubmitterEmail("Tron.Netter@ai.xl.net", {});
    assert.ok(!r.ok);
    const r2 = resolveSubmitterEmail("adam@evilxl.net", {});
    assert.ok(!r2.ok);
    const r3 = resolveSubmitterEmail("nonsense", {});
    assert.ok(!r3.ok);
    assert.match(r3.error, /not an email address/);
  }

  // ---- quota -------------------------------------------------------------
  assert.equal(dailyQuotaFor(true), WORK_CAPS.submissionsPerAdminPerDay);
  assert.equal(dailyQuotaFor(false), WORK_CAPS.submissionsPerUserPerDay);
  assert.equal(quotaRefusal(0, 200), null);
  assert.equal(quotaRefusal(199, 200), null);
  assert.match(quotaRefusal(200, 200) ?? "", /The limit is 200 submissions per person per day/);
  assert.match(quotaRefusal(201, 200) ?? "", /failed submissions do not count/);

  // ---- title band --------------------------------------------------------
  assert.match(titleBandRefusal("abc") ?? "", /Title must be 4 to 60 characters\./);
  assert.equal(titleBandRefusal("abcd"), null);
  assert.equal(titleBandRefusal("x".repeat(60)), null);
  assert.ok(titleBandRefusal("x".repeat(61)));

  // ---- category prefix ---------------------------------------------------
  assert.equal(titlePrefixRefusal("Beacon"), null);
  assert.match(
    titlePrefixRefusal("CoWork Skill: Ticket Triage") ?? "",
    /the card's badge already shows the kind/
  );
  assert.ok(titlePrefixRefusal("Automation - Morning Brief"));
  assert.ok(titlePrefixRefusal("tool: thing"));

  // ---- machine echo ------------------------------------------------------
  assert.equal(machineEchoRefusal("Entra Security Analyzer"), null);
  assert.match(
    machineEchoRefusal("Entra Security Analyzer (entra-security-analyzer)") ?? "",
    /says the same name twice/
  );

  // ---- blurb -------------------------------------------------------------
  assert.equal(blurbRefusal(""), null, "an empty description is legal");
  assert.equal(blurbRefusal("x".repeat(WORK_CAPS.blurbMaxChars)), null);
  assert.match(
    blurbRefusal("x".repeat(WORK_CAPS.blurbMaxChars + 1)) ?? "",
    new RegExp(`Description can be up to ${WORK_CAPS.blurbMaxChars} characters`)
  );

  // ---- title clashes -----------------------------------------------------
  assert.ok(staticTitles.titles.length > 0);
  const anExhibit = staticTitles.titles[0];
  assert.ok(staticTitleClash(anExhibit));
  assert.ok(
    staticTitleClash(`  ${anExhibit.toUpperCase()}  `),
    "normalizeTitle folds case and collapses whitespace, exactly as the index does"
  );
  assert.ok(!staticTitleClash("A Title No Exhibit Uses 91237"));
  assert.equal(
    PUBLISHED_CLASH_MESSAGE,
    "A published card already uses this title. Pick a different title."
  );
  {
    const own = activeClashMessage(
      "Beacon",
      { submitterEmail: "Adam@XL.net", status: "running" },
      "adam@xl.net"
    );
    assert.match(own, /You already have a submission titled "Beacon" in the pipeline \(status: running\)/);
    assert.match(own, /\/work\/submit/);
    assert.match(own, /ask Adam to clear it/);
    const other = activeClashMessage(
      "Beacon",
      { submitterEmail: "jane@xl.net", status: "held" },
      "adam@xl.net"
    );
    assert.match(other, /A teammate already has a submission titled "Beacon" in review/);
  }
  assert.match(
    uniqueViolationMessage("Beacon"),
    /A submission titled "Beacon" is already in the pipeline\. Check your submissions page at \/work\/submit\./
  );

  // ---- attribution -------------------------------------------------------
  assert.deepEqual(parseAttribution(null), { ok: true, attribution: null });
  assert.deepEqual(parseAttribution("   "), { ok: true, attribution: null });
  assert.deepEqual(parseAttribution(" Adam "), { ok: true, attribution: "Adam" });
  assert.deepEqual(parseAttribution("Mary-Jo"), { ok: true, attribution: "Mary-Jo" });
  for (const bad of ["A", "Adam Radulovic", "Adam2", "x".repeat(21), "'Adam"]) {
    const r = parseAttribution(bad);
    assert.ok(!r.ok, `${bad} must be refused`);
    assert.match(r.message, /single first name, letters only, 2 to 20 characters/);
  }

  // ---- the package + document envelope -----------------------------------
  assert.equal(
    PACKAGE_MISSING_MESSAGE,
    "Attach your package (.zip or .skill)."
  );
  assert.equal(packageNameRefusal("repo.zip"), null);
  assert.equal(packageNameRefusal("thing.SKILL"), null, "the check lowercases");
  assert.match(
    packageNameRefusal("repo.tar.gz") ?? "",
    /The package must be a \.zip or \.skill file\./
  );
  assert.equal(packageSizeRefusal(WORK_CAPS.uploadMaxBytes), null);
  assert.match(
    packageSizeRefusal(WORK_CAPS.uploadMaxBytes + 1) ?? "",
    /That file is too large \(limit 100 MB\)\./
  );
  assert.equal(packageBytesRefusal(WORK_CAPS.uploadMaxBytes), null);
  assert.equal(
    packageBytesRefusal(WORK_CAPS.uploadMaxBytes + 1),
    "That file is too large.",
    "the post-read gate keeps its own shorter sentence, as in the route"
  );
  for (const good of ["SKILL.md", "ARCHITECTURE.MD", "x.mdx", "x.markdown"])
    assert.equal(mdNameRefusal(good), null, good);
  assert.equal(mdNameRefusal("notes.txt"), "The document must be a .md file.");
  assert.equal(mdSizeRefusal(WORK_CAPS.skillMdMaxBytes), null);
  assert.equal(
    mdSizeRefusal(WORK_CAPS.skillMdMaxBytes + 1),
    "That document is too large (limit 1 MB)."
  );

  // ---- the kind ladder's pure pieces --------------------------------------
  {
    const verdict = classifyWorkKind({
      packageName: "repo.zip",
      paths: [".claude/settings.json", "src/index.ts"],
      innerArchivePaths: [],
      texts: [],
    });
    assert.equal(verdict.kind, "program");
    const withVerdict = kindRefusalText(verdict, "Your zip needs a doc.");
    assert.match(withVerdict, /^I read your upload as a Code program, because it has /);
    assert.ok(withVerdict.endsWith(" Your zip needs a doc."), "the verdict LEADS");
    assert.equal(
      kindRefusalText(undefined, "Your zip needs a doc."),
      "Your zip needs a doc.",
      "a refusal raised before classification passes through unchanged"
    );
  }
  assert.match(
    standaloneDocMessage(err({ code: "doc_too_short", message: "extract's Skill wording" })),
    /^The document you attached is too short to review\./
  );
  assert.ok(
    !/Skill/.test(
      standaloneDocMessage(err({ code: "doc_too_short", message: "extract's Skill wording" }))
    ),
    "the too-short copy must not name a Skill: this field carries a program's architecture doc just as often"
  );
  assert.equal(
    // Was "secrets_detected" until the 2026-08-29 cleaning round retired that
    // code; any kind-neutral code carries the same property.
    standaloneDocMessage(err({ code: "archive_too_complex", message: "too many files" })),
    "too many files",
    "kind-neutral copy passes through"
  );
  assert.match(
    rescuePassMessage(err({ code: "invalid_archive" }), "repo.zip"),
    /Your package contains an archive that could not be read, so the panel could not finish inspecting repo\.zip\./
  );
  assert.equal(
    rescuePassMessage(err({ code: "archive_too_complex", message: "too many files" }), "repo.zip"),
    "too many files"
  );
  {
    const pinned = okPkg({
      manifest: [
        { path: "outer/file.ts", bytes: 1 },
        { path: "wrapper.skill!/SKILL.md", bytes: 2 },
      ],
      corpus: [
        { path: "outer/README.md", text: "a" },
        { path: "wrapper.skill!/SKILL.md", text: "b" },
      ],
    });
    const filtered = outerLevelOnly(pinned);
    assert.deepEqual(filtered.manifest.map((m) => m.path), ["outer/file.ts"]);
    assert.deepEqual(filtered.corpus.map((c) => c.path), ["outer/README.md"]);
    assert.equal(filtered.archiveSha256, pinned.archiveSha256, "everything else is untouched");
    assert.equal(filtered.docPath, pinned.docPath);
  }
  // rescue truth table (route 482-484)
  assert.ok(rescueApplies(err({ code: "missing_architecture_doc", kind: "program" })));
  assert.ok(rescueApplies(err({ code: "doc_too_short", kind: "program" })));
  assert.ok(
    !rescueApplies(err({ code: "doc_too_short", kind: "skill" })),
    "a skill's doc failure never reaches this branch: the skill ladder returns ok-with-docMissing"
  );
  assert.ok(
    // The old "a clean standalone must never launder a dirty archive" leg
    // named secrets_detected, which no longer exists: nothing refuses for
    // carrying credentials since 2026-08-29, they are cleaned on every pass.
    // What the branch still must not do is rescue a STRUCTURAL failure.
    !rescueApplies(err({ code: "archive_too_complex", kind: "program" })),
    "a standalone document rescues a missing doc, never an unreadable package"
  );
  assert.ok(!rescueApplies(err({ code: "invalid_archive", kind: "program" })));
  assert.ok(!rescueApplies(err({ code: "archive_too_complex", kind: "program" })));
  // doc-failure truth table (route 529-531)
  assert.ok(isDocFailure(err({ code: "missing_architecture_doc" })));
  assert.ok(isDocFailure(err({ code: "missing_architecture_doc", kind: "skill" })));
  assert.ok(isDocFailure(err({ code: "doc_too_short", kind: "program" })));
  assert.ok(!isDocFailure(err({ code: "doc_too_short", kind: "skill" })));
  assert.ok(!isDocFailure(err({ code: "invalid_archive" })));

  // ---- small shared bits --------------------------------------------------
  assert.equal(docBaseName("wrapper.skill!/pkg/SKILL.md"), "SKILL.md");
  assert.equal(docBaseName("a/b/architecture.md"), "architecture.md");
  assert.equal(docBaseName("design.md"), "design.md");
  assert.equal(
    docBaseName(""),
    "",
    'the route\'s "SKILL.md" fallback is unreachable: String.split().pop() is never undefined, so an empty docPath yields an empty basename. Mirrored exactly rather than quietly improved; pkg.docPath is never empty on this branch (docMissing refuses first).'
  );
  assert.equal(storedName("", "upload"), "upload");
  assert.equal(storedName("repo.zip", "upload"), "repo.zip");
  assert.equal(storedName(`${"x".repeat(300)}.zip`, "upload").length, 200);
  assert.equal(clip("abc", 400), "abc");
  assert.equal(clip("x".repeat(500), 400), `${"x".repeat(400)}...`);
  {
    const dir = mkdtempSync(join(tmpdir(), "work-submit-tests-"));
    const p = join(dir, "blurb.txt");
    writeFileSync(p, "  a description\n\n");
    assert.equal(readBlurb(p), "a description", "trimmed like the form field");
    assert.equal(readBlurb(null), "", "no --blurb-file is an empty description");
  }

  // ---- the gate ladder as data --------------------------------------------
  const expectedGates: GateId[] = [
    "kill_switch",
    "daily_quota",
    "title_band",
    "title_kind_prefix",
    "title_machine_echo",
    "blurb_max",
    "time_saved",
    "published_title_clash",
    "active_title_clash",
    "attribution",
    "package_present",
    "package_ext",
    "package_size",
    "package_bytes",
    "md_ext",
    "md_size",
    "inspect_archive",
    "standalone_doc",
    "kind_ladder",
    "doc_precedence",
    "unique_violation",
  ];
  assert.deepEqual(
    SUBMIT_GATES.map((g) => g.id),
    expectedGates,
    "the route's order, and the daily quota is the THIRD gate (ahead of every title check), not a late one"
  );
  assert.equal(
    new Set(SUBMIT_GATES.map((g) => g.id)).size,
    SUBMIT_GATES.length,
    "no duplicate gate ids"
  );
  for (const g of SUBMIT_GATES) {
    assert.match(g.route, /^\d+(-\d+)?$/, `${g.id} names a route line span`);
    assert.ok(g.what.length > 0);
  }

  // ---- the script walks the gates IN THAT ORDER ---------------------------
  const scriptSrc = readFileSync(resolve(HERE, "work-submit.ts"), "utf8");
  const opsSrc = readFileSync(resolve(HERE, "lib/work-submit-ops.ts"), "utf8");
  const testSrc = readFileSync(resolve(HERE, "work-submit-tests.ts"), "utf8");
  {
    // Every gate carries a marker comment naming its id; the markers must
    // appear in the SUBMIT_GATES order, so a reordered ladder fails here.
    let cursor = -1;
    for (const g of SUBMIT_GATES) {
      const at = scriptSrc.indexOf(g.id, cursor + 1);
      assert.ok(
        at > cursor,
        `gate ${g.id} is missing from work-submit.ts or sits out of the route's order`
      );
      cursor = at;
    }
  }

  // ---- what the script must never do --------------------------------------
  // CODE lines only: the header comment NAMES kickPanel and --kick precisely
  // to say they are not here, which is the opposite of doing them.
  const scriptCode = scriptSrc
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
  assert.ok(
    !/kickPanel|work\/panel|noteQueueWait|from "next\/server"/.test(scriptCode),
    "the script never kicks a panel: the VM's queue drain owns that"
  );
  assert.ok(!/--kick\b/.test(scriptCode), "there is no --kick flag");
  assert.ok(
    /queue-drain\.ts/.test(scriptSrc) && /queuedWorkCandidates/.test(scriptSrc),
    "the header states what will pick the row up, and names the query it was verified against"
  );
  assert.ok(
    /gates INCLUDE brain health/.test(scriptSrc),
    "the brainHealthy omission is stated WITH its reason (the drain's own kick re-checks it)"
  );
  for (const omitted of [
    "requireWorkUser",
    "CSRF",
    "rateLimit",
    "Content-Length",
    "brainHealthy",
  ])
    assert.ok(
      scriptSrc.includes(omitted),
      `the header must name ${omitted} among the things deliberately not reproduced`
    );
  assert.ok(
    /process\.getuid\(\) === 0/.test(scriptSrc) &&
      /Refusing to run as root: store files must be owned by the user the site runs as/.test(scriptSrc),
    "the euid-0 refusal, with work:backfill's reason verbatim"
  );
  {
    // --dry-run must write NOTHING: the exit is ahead of every write.
    const dryExit = scriptSrc.indexOf("if (args.dryRun)");
    const create = scriptSrc.indexOf("await createSubmission(");
    const store = scriptSrc.indexOf("await storeArchiveFiles(");
    assert.ok(dryExit > 0 && create > dryExit, "createSubmission is after the dry-run exit");
    assert.ok(store > dryExit, "storeArchiveFiles is after the dry-run exit");
    // ... and the confirm prompt is ahead of the write too.
    const prompt = scriptSrc.indexOf("rl.question(");
    assert.ok(prompt > dryExit && prompt < create, "the confirm prompt sits between them");
  }
  assert.ok(
    /companyId: null,/.test(scriptSrc),
    "the row is filed in the public lane, explicitly"
  );
  assert.ok(
    !/autoApprove|parentId/.test(scriptSrc),
    "this lane never files an update row and never stamps auto-approve"
  );
  {
    // storeArchiveFiles: package at slot 0, standalone document at slot 1.
    const call = /await storeArchiveFiles\(row\.id, title, \[\s*\{ name: name\.slice\(0, 200\), data: bytes \},\s*\.\.\.\(mdMeta \? \[\{ name: mdMeta\.name, data: mdMeta\.data \}\] : \[\]\),\s*\]\);/;
    assert.ok(call.test(scriptSrc), "the store call is the route's, verbatim");
  }

  // ---- house rule: no em or en dashes -------------------------------------
  for (const [label, text] of [
    ["scripts/work-submit.ts", scriptSrc],
    ["scripts/lib/work-submit-ops.ts", opsSrc],
    ["scripts/work-submit-tests.ts", testSrc],
  ] as const)
    // Escapes, not the characters: a literal pair here would fail its own
    // scrape (the correlate suite's precedent).
    assert.ok(!/[\u2013\u2014]/.test(text), `no em or en dashes in ${label}`);

  // ---- SOURCE PIN: every literal copied out of the route -------------------
  // The route's four local helpers are unexported and its workError()
  // sentences are inline, so nothing above can import them. This is what
  // keeps the copies honest. Read from the COMMITTED route (this checkout is
  // shared; another session's uncommitted edits are not the contract).
  let routeSrc: string | null = null;
  try {
    routeSrc = execFileSync(
      "git",
      ["show", "HEAD:src/app/api/work/submissions/route.ts"],
      { cwd: REPO, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }
    );
  } catch {
    routeSrc = null;
  }
  if (routeSrc === null) {
    console.log(
      "work-submit-tests: NOTE, git show of the committed route failed, so the route-literal pin was skipped (behaviour assertions all ran)."
    );
  } else {
    // Bound to a const so the closure below narrows (a `let` would not).
    const route = routeSrc;
    const pin = (literal: string, what: string) => {
      assert.ok(
        literal.length > 20,
        `${what}: the pin has nothing to compare (an empty or missing literal)`
      );
      assert.ok(
        route.includes(literal),
        `${what} no longer matches the committed route: ${literal.slice(0, 70)}`
      );
    };
    pin(DISABLED_MESSAGE, "the kill-switch sentence");
    pin(
      "The limit is ${dailyQuota} submissions per person per day (failed submissions do not count). Try again tomorrow.",
      "the quota sentence"
    );
    pin(
      "Title must be ${WORK_CAPS.titleMinChars} to ${WORK_CAPS.titleMaxChars} characters.",
      "the title band sentence"
    );
    pin(titlePrefixRefusal("Skill: x") ?? "", "the category-prefix sentence");
    pin(
      machineEchoRefusal("Foo Tool (foo-tool)") ?? "",
      "the machine-echo sentence"
    );
    pin(
      "Description can be up to ${WORK_CAPS.blurbMaxChars} characters (it is optional; the card is written from your documents).",
      "the description cap sentence"
    );
    pin(PUBLISHED_CLASH_MESSAGE, "the published-clash sentence");
    pin(
      'You already have a submission titled "${title}" in the pipeline (status: ${clash.status}). Check it on your submissions page at /work/submit. Removing a submission is admin-only, so ask Adam to clear it if you want to resubmit under this title.',
      "the own-row clash sentence"
    );
    pin(
      'A teammate already has a submission titled "${title}" in review. Pick a different title, or check with them before resubmitting.',
      "the teammate clash sentence"
    );
    pin(
      "The public credit must be a single first name, letters only, 2 to 20 characters. Leave it empty to publish as the XL.net team.",
      "the attribution sentence"
    );
    pin(PACKAGE_MISSING_MESSAGE, "the missing-package sentence");
    pin("The package must be a .zip or .skill file.", "the package extension sentence");
    pin(
      "That file is too large (limit ${Math.floor(WORK_CAPS.uploadMaxBytes / 1_000_000)} MB).",
      "the package size sentence"
    );
    pin("That file is too large.", "the post-read size sentence");
    pin("The document must be a .md file.", "the document extension sentence");
    pin("That document is too large (limit 1 MB).", "the document size sentence");
    pin(
      standaloneDocMessage(err({ code: "doc_too_short" })),
      "standaloneDocError's too-short copy"
    );
    pin(
      "Your package contains an archive that could not be read, so the panel could not finish inspecting ${archiveName}. Remove it, or re-export it as a plain .zip, and resubmit.",
      "rescuePassError's inner-archive copy"
    );
    pin(
      'A submission titled "${title}" is already in the pipeline. Check ${isCompanyLane ? "your company\'s roadmap page at /roadmap/work" : "your submissions page at /work/submit"}.',
      "the unique-violation sentence"
    );
    // The route's local helpers, pinned by their load-bearing expressions.
    pin(
      "return verdict ? `${kindVerdictSentence(verdict)} ${message}` : message;",
      "kindRefusal"
    );
    pin(
      'manifest: pkg.manifest.filter((m) => !m.path.includes("!/")),',
      "outerLevelOnly's manifest filter"
    );
    pin(
      'corpus: pkg.corpus.filter((c) => !c.path.includes("!/")),',
      "outerLevelOnly's corpus filter"
    );
    pin(
      'extracted.code === "missing_architecture_doc" ||\n      extracted.code === "doc_too_short"',
      "the rescue's failure-code test"
    );
    pin(
      'extracted.code === "missing_architecture_doc" ||\n      (extracted.code === "doc_too_short" && extracted.kind === "program");',
      "the hard-failure docFailure test"
    );
    pin(
      'pkg.docPath.split("!/").pop()?.split("/").pop() ?? "SKILL.md";',
      "the md_* backfill basename"
    );
    // The two orderings this script had to preserve and could most easily
    // have got wrong: the quota BEFORE the title checks, and the standalone
    // document validated AFTER the package walk.
    assert.ok(
      route.indexOf("countCreatedToday(user.email)") <
        route.indexOf("WORK_CAPS.titleMinChars"),
      "the route really does run the daily quota ahead of the title band"
    );
    assert.ok(
      route.indexOf("await inspectArchive(bytes, null") <
        route.indexOf("mdFile ? inspectBareMd("),
      "the route really does validate the standalone document AFTER the package walk"
    );
  }

  console.log("work-submit-tests: all assertions passed.");
}

main();
