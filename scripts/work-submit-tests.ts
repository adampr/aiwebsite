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
import {
  MULTIPART_UNREADABLE_MESSAGE,
  RAW_UNREADABLE_MESSAGE,
  WORK_CAPS,
  fileChangedOnDiskMessage,
  notMultipartMessage,
} from "../src/lib/work/config";
import { bodyRefusalFor } from "../src/lib/work/read-body";
import {
  WORK_RAW_CONTENT_TYPE,
  WORK_RAW_MAGIC,
  decodeRawWorkPackage,
  encodeRawWorkPackage,
} from "../src/lib/work/raw-package";
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
  // One byte over sits in the window where formatByteSize rounds the size
  // onto the limit string, so the measured clause is DROPPED rather than
  // asserting "100 MB is over the 100 MB limit" (refuter finding).
  assert.match(
    packageSizeRefusal(WORK_CAPS.uploadMaxBytes + 1) ?? "",
    /^That package is over the 100 MB limit\. Zip the project again without version control history/,
    "the just-over window keeps the generic opener, never a self-contradiction"
  );
  assert.match(
    packageSizeRefusal(104_800_000) ?? "",
    /^That package is 104\.8 MB, over the 100 MB limit\. Zip the project again without version control history/,
    "a clearly-over size is named (the incident's own 104.8 MB)"
  );
  assert.match(
    packageSizeRefusal(WORK_CAPS.uploadMaxBytes + 1) ?? "",
    /keep those in/,
    "the anti-downgrade clause survives (the 2026-08-31 incident's lesson)"
  );
  assert.equal(packageBytesRefusal(WORK_CAPS.uploadMaxBytes), null);
  assert.equal(
    packageBytesRefusal(WORK_CAPS.uploadMaxBytes + 1),
    packageSizeRefusal(WORK_CAPS.uploadMaxBytes + 1),
    "the post-read gate ships the same full message; the dead-end short sentence is gone"
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

  // ---- §5.16 raw fallback transport + unreadable-body refusals (2026-09-01,
  // the 2026-08-27 incident: six real multipart uploads all killed by
  // req.formData() throwing under body-rewriting middleware) ----------------
  // Codec + reader tests run in one async block: the encoder now returns a
  // Blob (BlobPart concatenation, so a 100 MB package is never copied into a
  // second in-memory buffer; refuter finding 2026-09-01) and Blob reads are
  // async. The block still fails the suite: its catch exits 1.
  void (async () => {
    const toBytes = async (b: Blob) => new Uint8Array(await b.arrayBuffer());
    {
      // Round-trip fidelity, the full create shape: every field, package AND
      // standalone doc, binary bytes that are not UTF-8, and the two part
      // shapes mixed (a Blob part like the form's File, a bytes part).
      const enc = new TextEncoder();
      const fileBytes = new Uint8Array([0x50, 0x4b, 3, 4, 0, 255, 128, 7]);
      const docBytes = enc.encode("# architecture\n\nwords about the tool");
      const body = encodeRawWorkPackage({
        fields: {
          title: "Beacon",
          blurb: "",
          attribution: "Adam",
          timeSavedHours: "6.5",
        },
        file: { name: "beacon.zip", data: new Blob([fileBytes]) },
        doc: { name: "architecture.md", data: docBytes },
      });
      assert.equal(
        body.type,
        WORK_RAW_CONTENT_TYPE,
        "the body Blob carries the wire content type"
      );
      const bytes = await toBytes(body);
      assert.equal(
        new TextDecoder().decode(bytes.subarray(0, 8)),
        WORK_RAW_MAGIC,
        "the magic leads the body"
      );
      const d = decodeRawWorkPackage(bytes);
      assert.ok(d.ok);
      assert.deepEqual(d.fields, {
        title: "Beacon",
        blurb: "",
        attribution: "Adam",
        timeSavedHours: "6.5",
      });
      assert.equal(d.file.name, "beacon.zip");
      assert.deepEqual([...d.file.bytes], [...fileBytes]);
      assert.equal(d.doc?.name, "architecture.md");
      assert.deepEqual([...(d.doc?.bytes ?? [])], [...docBytes]);
    }
    {
      // The update-lane shape: no title, no doc. Absent stays ABSENT, never
      // "", because the update route 400s a present title and
      // parseTimeSavedHours reads an absent field as "not reported".
      const d = decodeRawWorkPackage(
        await toBytes(
          encodeRawWorkPackage({
            fields: { blurb: "b", attribution: "" },
            file: { name: "repo.zip", data: new Uint8Array([1, 2, 3]) },
          })
        )
      );
      assert.ok(d.ok);
      assert.equal(d.fields.title, undefined);
      assert.equal(d.fields.timeSavedHours, undefined);
      assert.equal(d.fields.blurb, "b");
      assert.equal(d.doc, null);
      assert.deepEqual([...d.file.bytes], [1, 2, 3]);
    }
    {
      // Garbage and tampering refuse with a named reason, never a corrupt
      // parse: the transport exists BECAUSE something rewrites bodies.
      const enc = new TextEncoder();
      const bad = (b: Uint8Array<ArrayBuffer>, re: RegExp, what: string) => {
        const d = decodeRawWorkPackage(b);
        assert.ok(!d.ok, what);
        assert.match(d.error, re, what);
      };
      bad(new Uint8Array(0), /too short/, "empty body");
      bad(new Uint8Array(11), /too short/, "shorter than the header");
      const good = await toBytes(
        encodeRawWorkPackage({
          fields: {},
          file: { name: "a.zip", data: new Uint8Array([9, 9]) },
        })
      );
      const flipped = new Uint8Array(good);
      flipped[0] = 0x58;
      bad(flipped, /bad magic/, "flipped magic byte");
      bad(
        new Uint8Array(good.subarray(0, good.byteLength - 1)),
        /sum/,
        "one byte lost in transit"
      );
      const grown = new Uint8Array(good.byteLength + 1);
      grown.set(good);
      bad(grown, /sum/, "one byte grown in transit");
      const lied = new Uint8Array(good);
      new DataView(lied.buffer).setUint32(8, 100_000, false);
      bad(lied, /exceeds body/, "declared metadata length past the body");
      const mk = (meta: unknown, tailBytes: number) => {
        const json = enc.encode(JSON.stringify(meta));
        const out = new Uint8Array(12 + json.byteLength + tailBytes);
        out.set(enc.encode(WORK_RAW_MAGIC), 0);
        new DataView(out.buffer).setUint32(8, json.byteLength, false);
        out.set(json, 12);
        return out;
      };
      {
        // metadata bytes that are not JSON at all
        const notJson = new Uint8Array(16);
        notJson.set(enc.encode(WORK_RAW_MAGIC), 0);
        new DataView(notJson.buffer).setUint32(8, 4, false);
        notJson.set(enc.encode("abcd"), 12);
        bad(notJson, /JSON/, "non-JSON metadata");
      }
      bad(mk([1], 0), /not an object/, "array metadata");
      bad(mk({ fileSize: 2 }, 2), /fileName missing/, "no fileName");
      bad(mk({ fileName: "a.zip", fileSize: "2" }, 2), /byte length/, "string fileSize");
      bad(mk({ fileName: "a.zip", fileSize: 2.5 }, 2), /byte length/, "fractional fileSize");
      bad(
        mk({ fileName: "a.zip", fileSize: 2, docName: "d.md" }, 2),
        /travel together/,
        "docName without docSize"
      );
      bad(
        mk({ fileName: "a.zip", fileSize: 2, title: 5 }, 2),
        /not a string/,
        "non-string text field"
      );
    }
    {
      // The whole server side of the happy raw path, through the REAL
      // reader: a Request carrying the encoded Blob body comes back as a
      // FormData with the multipart path's exact keys and byte-identical
      // files. Runs here because a successful read never touches the ledger
      // (the suite stays no-DB).
      const fileBytes = new Uint8Array([0x50, 0x4b, 1, 2, 250]);
      const docBytes = new TextEncoder().encode("# doc\n\nbody");
      const raw = encodeRawWorkPackage({
        fields: { title: "Beacon", blurb: "why", timeSavedHours: "2" },
        file: { name: "beacon.zip", data: new Blob([fileBytes]) },
        doc: { name: "SKILL.md", data: docBytes },
      });
      const req = new Request("http://localhost/api/work/submissions", {
        method: "POST",
        headers: { "content-type": WORK_RAW_CONTENT_TYPE },
        body: raw,
      });
      const { readWorkBody } = await import("../src/lib/work/read-body");
      const r = await readWorkBody(req, "create", "test@xl.net");
      assert.ok(r.ok, "the raw happy path parses");
      assert.equal(r.form.get("title"), "Beacon");
      assert.equal(r.form.get("blurb"), "why");
      assert.equal(r.form.get("timeSavedHours"), "2");
      assert.equal(
        r.form.get("attribution"),
        null,
        "an absent field stays absent from the FormData"
      );
      const f = r.form.get("file");
      assert.ok(f instanceof File);
      assert.equal(f.name, "beacon.zip");
      assert.deepEqual([...new Uint8Array(await f.arrayBuffer())], [...fileBytes]);
      const md = r.form.get("skillMd");
      assert.ok(md instanceof File);
      assert.equal(md.name, "SKILL.md");
      assert.deepEqual([...new Uint8Array(await md.arrayBuffer())], [...docBytes]);
    }
    console.log(
      "work-submit-tests: raw-transport codec + reader assertions passed."
    );
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
  // The content-type branch split, lane-aware: a multipart header that failed
  // to parse is a body garbled in transit (body_unreadable, copy that names
  // the FORM's auto-retry without claiming one happened); anything else is a
  // script speaking the wrong format (invalid_request, the copy that teaches
  // -F, with NO title in the update example because that route refuses a
  // typed title).
  assert.deepEqual(bodyRefusalFor("multipart/form-data; boundary=----x", "create"), {
    code: "body_unreadable",
    message: MULTIPART_UNREADABLE_MESSAGE,
  });
  assert.deepEqual(bodyRefusalFor("MULTIPART/FORM-DATA", "update"), {
    code: "body_unreadable",
    message: MULTIPART_UNREADABLE_MESSAGE,
  });
  assert.deepEqual(bodyRefusalFor("application/json", "create"), {
    code: "invalid_request",
    message: notMultipartMessage("create"),
  });
  assert.deepEqual(bodyRefusalFor("", "update"), {
    code: "invalid_request",
    message: notMultipartMessage("update"),
  });
  assert.match(notMultipartMessage("create"), /curl -F "title=\.\.\." -F "file=@package\.zip"/);
  assert.match(notMultipartMessage("update"), /curl -F "file=@package\.zip"/);
  assert.ok(
    !notMultipartMessage("update").includes("title"),
    "the update example must not steer a script into the pinned-title 400"
  );
  // The copy itself. Both body_unreadable sentences name the REAL intake
  // address (ai@xl.net does not exist), say the files were never judged, and
  // never say "multipart" to a form user. The multipart sentence promises
  // only what the form does (it is what a retry-less script reads); ONLY the
  // raw sentence may say "tried twice", because a raw POST is by construction
  // the form's second attempt.
  for (const msg of [MULTIPART_UNREADABLE_MESSAGE, RAW_UNREADABLE_MESSAGE]) {
    assert.match(msg, /Tron\.Netter@ai\.xl\.net/);
    assert.match(msg, /never judged/);
    assert.ok(
      !/multipart/i.test(msg),
      "no wire-format jargon in a body_unreadable refusal"
    );
  }
  assert.match(MULTIPART_UNREADABLE_MESSAGE, /retries this automatically/);
  assert.ok(
    !/tried twice|retry failed/.test(MULTIPART_UNREADABLE_MESSAGE),
    "the multipart sentence never claims a retry already happened"
  );
  assert.match(RAW_UNREADABLE_MESSAGE, /tried twice/);
  assert.match(RAW_UNREADABLE_MESSAGE, /different network or browser/);
  // The changed-on-disk sentence names WHICH field the form cleared: it is
  // the only channel a screen-reader user gets.
  assert.match(
    fileChangedOnDiskMessage("package"),
    /^The package file you chose changed on disk/
  );
  assert.match(
    fileChangedOnDiskMessage("document"),
    /^The document you chose changed on disk/
  );
  assert.match(fileChangedOnDiskMessage("package"), /Choose the file again/);
  assert.equal(WORK_RAW_CONTENT_TYPE, "application/x-work-package");
  {
    // CALL-SITE PINS, against the WORKING COPY (this round's own files are
    // the contract; the committed-route pin block below keeps covering the
    // literals that predate it). Both routes read their body through the ONE
    // shared reader, the reader owns the parse plus its log line and ledger
    // mirror, and the form's retry is keyed on the code alone.
    const createSrc = readFileSync(
      resolve(REPO, "src/app/api/work/submissions/route.ts"),
      "utf8"
    );
    const updateSrc = readFileSync(
      resolve(REPO, "src/app/api/work/submissions/[id]/update/route.ts"),
      "utf8"
    );
    const readBodySrc = readFileSync(
      resolve(REPO, "src/lib/work/read-body.ts"),
      "utf8"
    );
    const formSrc = readFileSync(
      resolve(REPO, "src/app/work/submit/submission-form.tsx"),
      "utf8"
    );
    assert.ok(
      createSrc.includes('await readWorkBody(req, "create", user.email)'),
      "the create route reads its body through the shared reader"
    );
    assert.ok(
      updateSrc.includes('await readWorkBody(req, "update", user.email)'),
      "the update route reads its body through the shared reader"
    );
    for (const [label, src] of [
      ["create route", createSrc],
      ["update route", updateSrc],
    ] as const) {
      assert.ok(
        !src.includes("req.formData()"),
        `${label}: no direct req.formData() left; the reader owns the parse`
      );
      assert.ok(
        src.indexOf('req.headers.get("content-length")') <
          src.indexOf("readWorkBody("),
        `${label}: the Content-Length precheck runs BEFORE the body reader, so it covers the raw arrayBuffer read too`
      );
    }
    assert.ok(
      readBodySrc.includes(
        "[work] body-unreadable ${lane} submitter=${submitterEmail}"
      ),
      "the one forensic log line (the size-refusal precedent)"
    );
    assert.ok(
      readBodySrc.includes("work-intake:body-unreadable:web-${lane}"),
      "episodic ledger key: (reason class, lane), never per request"
    );
    assert.equal(
      (readBodySrc.match(/message: RAW_UNREADABLE_MESSAGE/g) ?? []).length,
      2,
      "both raw-branch refusals (unreadable body, bad framing) speak the tried-twice copy"
    );
    assert.ok(
      formSrc.includes('data?.error?.code === "body_unreadable"'),
      "the form retries only on the body_unreadable code"
    );
    assert.ok(
      formSrc.includes("encodeRawWorkPackage(") &&
        formSrc.includes("WORK_RAW_CONTENT_TYPE"),
      "the retry rides the shared encoder and content type"
    );
    assert.equal(
      (formSrc.match(/setTimeout\(\(\) => ctrl\.abort\(\), 90_000\)/g) ?? [])
        .length,
      2,
      "a FRESH 90 s window is armed for the raw retry; one shared window kills any package slower than ~45 s mid-retry"
    );
    assert.ok(
      formSrc.includes(".slice(0, 1).arrayBuffer()"),
      "the one-byte readability probe runs before the Blob body is built, so changed-on-disk keeps its own message"
    );
    assert.ok(
      formSrc.includes('fileChangedOnDiskMessage("package")') &&
        formSrc.includes('fileChangedOnDiskMessage("document")'),
      "each changed-on-disk branch names the field it clears"
    );
    assert.ok(
      formSrc.includes('"File could not be read"'),
      "the changed-on-disk modal heading never claims the package was judged"
    );
    assert.ok(
      (formSrc.match(/cancelledByUser\(\)/g) ?? []).length >= 3,
      "a user-cancel landing inside a response read is a quiet note, never the alarm modal (guarded after both json reads and in the catch)"
    );
    // House rule for the round's new src files: no em or en dashes (escapes,
    // not the characters, exactly like the scripts scan below).
    for (const [label, text] of [
      ["src/lib/work/raw-package.ts", readFileSync(resolve(REPO, "src/lib/work/raw-package.ts"), "utf8")],
      ["src/lib/work/read-body.ts", readBodySrc],
    ] as const)
      assert.ok(!/[\u2013\u2014]/.test(text), `no em or en dashes in ${label}`);
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
    // storeArchiveFiles: package at slot 0, standalone document at slot 1,
    // and this lane's call must equal the CREATE ROUTE'S call.
    //
    // DERIVED FROM THE ROUTE, not from a literal copied out of it (changed
    // 2026-08-29). The literal that stood here pinned `data: bytes`, so when
    // the §5.16 cleaning round changed BOTH files identically the mirror went
    // red for the one reason it should not: the two lanes still agreed. A
    // hand-written copy of the thing you are comparing against has to be
    // re-copied every time that thing moves, which is how a mirror test
    // becomes a thing people adjust until it passes. Reading the route means
    // the assertion can only fail when the two lanes genuinely DIVERGE.
    const routeSrc = readFileSync(
      "src/app/api/work/submissions/route.ts",
      "utf8"
    );
    const grab = (src: string) => {
      const at = src.indexOf("storeArchiveFiles(row.id");
      if (at === -1) return null;
      const end = src.indexOf("]);", at);
      return end === -1
        ? null
        : src.slice(at, end + 3).replace(/\s+/g, " ").trim();
    };
    const routeCall = grab(routeSrc);
    const scriptCall = grab(scriptSrc);
    assert.ok(routeCall, "the create route still has a storeArchiveFiles call");
    assert.equal(
      scriptCall,
      routeCall,
      "the store call is the route's, verbatim"
    );
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
    // The three size sentences stopped being route literals on 2026-08-31:
    // route, CLI and form all import packageTooLargeMessage /
    // DOC_TOO_LARGE_MESSAGE from work/config.ts, so there is no copy left to
    // drift. What CAN still drift is the route quietly reverting to an
    // inline sentence, so the pin now asserts the route composes from the
    // shared source at each gate.
    pin("packageTooLargeMessage()", "the precheck gate imports its sentence");
    pin("packageTooLargeMessage(file.size)", "the package size gate imports its sentence");
    pin("packageTooLargeMessage(bytes.length)", "the post-read gate imports its sentence");
    pin("The document must be a .md file.", "the document extension sentence");
    // The CALL SITE, not the bare constant name: the import line alone would
    // satisfy an includes() while the gate reverted to an inline literal.
    pin(
      'workError("invalid_request", DOC_TOO_LARGE_MESSAGE, 400)',
      "the document size gate imports its sentence"
    );
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
