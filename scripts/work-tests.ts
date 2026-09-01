// Tests for the team work submission pipeline's pure pieces (§5.16):
// archive inspection (required-doc rule, zip hardening, secret scan) and the
// deterministic card lint. Run: npm run test:work (tsx, no DB, no brain).

import assert from "node:assert";
import JSZip from "jszip";
import {
  hasSkillFrontmatter,
  inspectArchive,
  inspectBareMd,
  isCorpusHtml,
  mergeSkillCorpus,
  nonZipMessage,
  proseLength,
  type ExtractOk,
} from "../src/lib/work/extract";
import {
  SANITIZE_RULES,
  placeholderFor,
  sanitizeText,
  textLooksSecret,
} from "../src/lib/work/sanitize";
import { rebuildWithout } from "../src/lib/work/sanitize-archive";
import { decideStorage } from "../src/lib/work/cleaning";
import {
  classifyWorkKind,
  kindVerdictSentence,
  hasSkillFrontmatter as classifyFrontmatter,
} from "../src/lib/work/classify";
import {
  isNoneFound,
  lintCard,
  quoteInCorpus,
  slugForTitle,
  stringViolations,
  wordCount,
} from "../src/lib/work/lint";
import { friendlyHeldReason } from "../src/lib/work/view";
import { isFreshDate } from "../src/lib/governance/approval";
import {
  archiveDeclaredNames,
  docDeclaredNames,
  isPlaceholderSubject,
  isSenderIdentity,
  looksLikeAWorkName,
  nameKey,
  parseSubmissionBody,
  pickAttachments,
  resolveSubjectTitle,
  senderIdentityTokens,
  splitMachineEcho,
  stripKindPrefix,
  stripMachineEcho,
  titleFromSubject,
  validateInferredTitle,
  validateWeakTitle,
} from "../src/lib/work/email-parse";
import {
  HOUSE_RULES,
  MISSING_ARCH_DOC_MESSAGE,
  TITLE_KIND_PREFIX_RE,
  WORK_CAPS,
  formatByteSize,
  nextStorageReportDueMs,
} from "../src/lib/work/config";
import {
  composeParagraphs,
  composeRefusal,
  repeatedParagraphs,
} from "../src/lib/work/refusal";
import staticTitles from "../src/lib/work/static-titles.json";
import {
  byteLessRowClass,
  importShaRefusal,
  parseImportArgs,
  planRowBackfill,
} from "./lib/work-archive-ops";

import {
  classifyViolations,
  grantFreesAnything,
  mergeRepair,
  repairDrift,
  restoredFields,
  storableDraft,
} from "../src/lib/work/repair";
import {
  MAIL_SAFE_TEXT_EXT,
  mailSafePath,
  oneLine,
  partitionAttachmentsBySize,
  predictArmoredLength,
  RETENTION_ATTACH_TOTAL_MAX,
  toDeliverableAttachment,
  willArmorFile,
} from "../src/lib/work/retention-encoding";
import {
  sanitizeStoredName,
  storedRelPath,
} from "../src/lib/work/archive-naming";
import {
  blockedByBytes,
  blockedByName,
  finalExt,
  GMAIL_BLOCKED_EXT,
  PRECAUTION_BLOCKED_EXT,
} from "../src/lib/work/blocked-types";
import { screenPackageForMail } from "../src/lib/work/mail-screen";
const PROSE = "This tool ingests Autotask ticket exports and produces a scored summary for the service desk. ".repeat(12);

async function zipOf(files: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [path, text] of Object.entries(files)) zip.file(path, text);
  return zip.generateAsync({ type: "nodebuffer" });
}

const ctx = { publishedTitles: [], publishedFacetLabels: [] };

function sentence(words: number, seed = "the tool parsed each export row and wrote one scored line"): string {
  const base = seed.split(" ");
  const out: string[] = [];
  while (out.length < words) out.push(base[out.length % base.length]);
  return out.join(" ") + ".";
}

function goodCard() {
  return {
    title: "Export Scorer",
    categoryBadge: "Internal tool",
    summary: sentence(60),
    body: [sentence(80)],
    facets: [
      { label: "Scored Rows", text: sentence(30) },
      { label: "One Export In", text: sentence(30) },
      { label: "Desk Handoff", text: sentence(30) },
    ],
    footerLine: ["from architecture.md", "one export in, one report out"],
  };
}

async function main() {
  // ---- extract ----
  assert.ok(proseLength("```\ncode\n```\nreal prose here") < 20);

  const okZip = await zipOf({
    "myproj/architecture.md": PROSE,
    "myproj/main.py": "print('hi')",
    "myproj/notes.md": "Some extra notes on usage that are fine.",
  });
  const ok = await inspectArchive(okZip, "program");
  assert.ok(ok.ok, "arch doc at depth 1 accepted");
  if (ok.ok) {
    assert.equal(ok.docPath, "myproj/architecture.md");
    assert.ok(ok.corpus.some((c) => c.path === "myproj/notes.md"));
    assert.ok(!ok.corpus.some((c) => c.path.endsWith("main.py")), "source never in corpus");
    assert.equal(ok.manifest.length, 3);
  }

  const readmeZip = await zipOf({
    "README.md": `# Tool\n\n## Architecture\n\n${PROSE}`,
    "main.js": "x",
  });
  assert.ok((await inspectArchive(readmeZip, "program")).ok, "README with Architecture heading accepted");

  const noDoc = await inspectArchive(await zipOf({ "main.py": "x" }), "program");
  assert.ok(!noDoc.ok && noDoc.code === "missing_architecture_doc");
  assert.match(noDoc.ok ? "" : noDoc.message, /architecture\.md/);

  const deepDoc = await inspectArchive(
    await zipOf({ "a/b/c/architecture.md": PROSE, "main.py": "x" }),
    "program"
  );
  assert.ok(!deepDoc.ok, "doc deeper than one folder rejected");

  const shortDoc = await inspectArchive(
    await zipOf({ "architecture.md": "too short" }),
    "program"
  );
  assert.ok(!shortDoc.ok && shortDoc.code === "doc_too_short");

  const skillPkg = await inspectArchive(
    await zipOf({ "myskill/SKILL.md": PROSE, "myskill/references/r.md": "ref" }),
    "skill"
  );
  assert.ok(skillPkg.ok, "skill package with SKILL.md accepted");
  // New contract (2026-07-30): doc-resolution failure on the skill kind is
  // ok-with-docMissing (rescuable by a standalone .md), not a hard error;
  // boilerplate readme.md never qualifies by uniqueness.
  const skillMissing = await inspectArchive(
    await zipOf({ "myskill/readme.md": PROSE }),
    "skill"
  );
  assert.ok(
    skillMissing.ok && skillMissing.docMissing === "missing",
    "doc-less skill package is ok-with-docMissing"
  );

  // CLEANED, NOT REFUSED (owner directive 2026-08-29). The whole point of the
  // round: the submission is accepted, the .env is gone from the stored
  // archive AND from the manifest, and the rebuilt bytes are what a caller may
  // persist.
  const secretFile = await inspectArchive(
    await zipOf({ "architecture.md": PROSE, ".env": "X=1" }),
    "program"
  );
  assert.ok(secretFile.ok, "a package carrying a .env is accepted and cleaned");
  if (secretFile.ok) {
    assert.deepEqual(
      secretFile.cleaning?.droppedPaths.map((d) => d.path),
      [".env"]
    );
    assert.ok(
      !secretFile.manifest.some((m) => m.path === ".env"),
      "a dropped entry leaves the manifest: it describes the STORED artifact"
    );
    const rebuilt = await JSZip.loadAsync(secretFile.cleaning!.stored!.bytes);
    assert.ok(!rebuilt.files[".env"], "the stored archive does not hold it");
    assert.ok(rebuilt.files["architecture.md"], "everything else survives");
    assert.notEqual(
      secretFile.cleaning!.stored!.sha256,
      secretFile.archiveSha256,
      "archiveSha256 still describes what the submitter SENT (provenance)"
    );
  }

  // Fixture assembled at runtime so the repo's own pre-commit secrets gate
  // (which scans staged literals) does not trip on a deliberately fake key.
  const fakeSecretLine = ["API", "KEY"].join("_") + '="abcdefgh12345678"';
  const secretContent = await inspectArchive(
    await zipOf({
      "architecture.md": PROSE,
      // Real prose AROUND the credential, which is the ordinary shape: a
      // runbook that happens to paste a key into one line. A file that is
      // NOTHING but the credential takes the gut-guard path instead, asserted
      // just below.
      "notes.md": `${PROSE}\n\n${fakeSecretLine}\n`,
    }),
    "program"
  );
  assert.ok(secretContent.ok, "an inline credential is cleaned, not refused");
  if (secretContent.ok) {
    assert.deepEqual(secretContent.cleaning?.redactedPaths, ["notes.md"]);
    // The value is gone from all three places it could have reached: the
    // corpus the panel reads, the stored archive, and the manifest is intact.
    const corpusText = secretContent.corpus.map((c) => c.text).join("\n");
    assert.ok(!corpusText.includes("abcdefgh12345678"), "corpus is clean");
    assert.ok(corpusText.includes("[redacted:"), "and says so where it cut");
    const rebuilt = await JSZip.loadAsync(secretContent.cleaning!.stored!.bytes);
    const stored = await rebuilt.files["notes.md"].async("string");
    assert.ok(!stored.includes("abcdefgh12345678"), "stored archive is clean");
    assert.ok(
      secretContent.manifest.some((m) => m.path === "notes.md"),
      "a REDACTED file stays in the manifest: it is still in the archive"
    );
  }

  // THE GUT GUARD. A supporting file that is mostly placeholder is not
  // evidence, and handing the panel a page of redaction tokens is worse than
  // handing it nothing. It leaves the CORPUS but keeps its manifest row and
  // stays in the stored archive: it is still a file the package contains.
  const gutted = await inspectArchive(
    await zipOf({ "architecture.md": PROSE, "notes.md": fakeSecretLine }),
    "program"
  );
  assert.ok(gutted.ok, "a mostly-credential support file does not refuse");
  if (gutted.ok) {
    assert.ok(
      !gutted.corpus.some((c) => c.path === "notes.md"),
      "a gutted file is not offered to the panel as evidence"
    );
    assert.ok(
      gutted.manifest.some((m) => m.path === "notes.md"),
      "but the manifest still describes the archive truthfully"
    );
  }

  // JSZip normalizes "../" away on write, so byte-patch an equal-length
  // placeholder to fabricate the hostile archive a real attacker would send.
  const patched = await zipOf({ "xx/evil.md": PROSE, "architecture.md": PROSE });
  const evilZip = Buffer.from(
    patched.toString("latin1").replaceAll("xx/evil.md", "../evil.md"),
    "latin1"
  );
  // JSZip strips the "../" on load as well (verified 2026-07-29: the entry
  // surfaces as "evil.md"), so a traversal name can never reach our walk;
  // normalizePath in extract.ts stays as defense-in-depth. Assert the
  // sanitized result: accepted, and no stored path escapes.
  const traversal = await inspectArchive(evilZip, "program");
  assert.ok(traversal.ok, "sanitized traversal zip accepted");
  if (traversal.ok)
    assert.ok(
      traversal.manifest.every((m) => !m.path.includes("..")),
      "no manifest path contains .."
    );

  const bare = inspectBareMd("SKILL.md", Buffer.from(PROSE));
  assert.ok(bare.ok, "bare md accepted");
  assert.ok(!inspectBareMd("SKILL.md", Buffer.from("short")).ok);

  // Two-file CoWork Skill corpus: the standalone SKILL.md leads (slot 0, its
  // text is the reviewed doc), package texts follow, byte-identical
  // duplicates of the standalone .md are skipped.
  const standalone = inspectBareMd("SKILL.md", Buffer.from(PROSE + " standalone edition."));
  const pkgForMerge = await inspectArchive(
    await zipOf({
      "myskill/SKILL.md": PROSE,
      "myskill/references/notes.md": "Reference notes with enough text to ride along.",
    }),
    "skill"
  );
  assert.ok(standalone.ok && pkgForMerge.ok);
  if (standalone.ok && pkgForMerge.ok) {
    const merged = mergeSkillCorpus(standalone, pkgForMerge);
    assert.equal(merged[0].path, "SKILL.md", "standalone md leads the corpus");
    assert.ok(merged[0].text.endsWith("standalone edition."));
    assert.ok(
      merged.some((c) => c.path === "myskill/references/notes.md"),
      "package extras ride along"
    );
    // Byte-identical package SKILL.md is deduped when texts match.
    const identical = inspectBareMd("SKILL.md", Buffer.from(PROSE));
    assert.ok(identical.ok);
    if (identical.ok) {
      const merged2 = mergeSkillCorpus(identical, pkgForMerge);
      assert.equal(
        merged2.filter((c) => c.text === identical.docText).length,
        1,
        "identical package copy deduped"
      );
    }
  }

  // ---- single-file HTML apps enter the corpus (2026-08-31) ----
  // A Code program whose whole source is one .html (markup + inline script,
  // no build step) had no file the panel could read: the card was grounded
  // 100% in the architecture document and the evidence critic could never
  // check a claim against the app. The rule admits such an HTML as EVIDENCE,
  // through the same TextFile pipeline as .md/.txt, and never as a document.
  const APP_HTML =
    "<!doctype html>\n<html><head><title>Ticket Reply Generator</title></head>\n" +
    "<body><script>\nfunction draftReply(ticket) { return 'Hello ' + ticket.requester; }\n" +
    "</script></body></html>\n";
  assert.equal(WORK_CAPS.corpusHtmlMaxFiles, 3, "small fixed per-package HTML cap");
  assert.ok(
    isCorpusHtml("app.html") &&
      isCorpusHtml("dir/App.HTM") &&
      !isCorpusHtml("x.md") &&
      !isCorpusHtml("html.txt"),
    "isCorpusHtml is a basename extension test"
  );

  // (i) architecture.md + app.html: program, corpus = [doc, html] in that order,
  // and the kind is INFERRED (null): the .html changes nothing in classify.ts.
  const htmlApp = await inspectArchive(
    await zipOf({ "app.html": APP_HTML, "architecture.md": PROSE }),
    null,
    { packageName: "ticket-reply-generator.zip" }
  );
  assert.ok(htmlApp.ok, "html app with an architecture doc accepted");
  if (htmlApp.ok) {
    assert.equal(htmlApp.kind, "program");
    assert.equal(htmlApp.kindVerdict.rule, "program_scaffolding");
    assert.equal(htmlApp.docPath, "architecture.md");
    assert.deepEqual(
      htmlApp.corpus.map((c) => c.path),
      ["architecture.md", "app.html"],
      "doc first, HTML last"
    );
    assert.equal(htmlApp.corpus[1].text, APP_HTML, "the app text itself is the evidence");
    assert.equal(htmlApp.cleaning, undefined, "a clean HTML leaves no cleaning record");
  }
  // The order is by KIND first, size second: a tiny HTML still sits behind a
  // larger supporting document, so it can never displace one under the cap.
  const htmlSmall = await inspectArchive(
    await zipOf({
      "tiny.html": "<p>x</p>",
      "architecture.md": PROSE,
      "notes.md": `${PROSE} notes.`,
    }),
    "program"
  );
  assert.ok(htmlSmall.ok);
  if (htmlSmall.ok)
    assert.deepEqual(
      htmlSmall.corpus.map((c) => c.path),
      ["architecture.md", "notes.md", "tiny.html"],
      "documents ascending by size, then HTML"
    );

  // (ii) The HTML never satisfies the document gate, however much prose it
  // carries and whatever it is named.
  const htmlNoDoc = await inspectArchive(
    await zipOf({ "app.html": `${APP_HTML}<p>${PROSE}</p>` }),
    null,
    { packageName: "app.zip" }
  );
  assert.ok(
    !htmlNoDoc.ok && htmlNoDoc.code === "missing_architecture_doc",
    "html alone is still refused missing_architecture_doc"
  );
  const htmlNamedArch = await inspectArchive(
    await zipOf({ "architecture.html": `<p>${PROSE}</p>`, "main.py": "x" }),
    "program"
  );
  assert.ok(
    !htmlNamedArch.ok && htmlNamedArch.code === "missing_architecture_doc",
    "an .html named architecture is not the architecture doc"
  );

  // (iii) depth <= 1 on the display path (matchesArchDoc's rule): one wrapper
  // folder in, two folders out.
  const htmlDeep = await inspectArchive(
    await zipOf({
      "architecture.md": PROSE,
      "a/b/app.html": APP_HTML,
      "w/app.html": APP_HTML,
    }),
    "program"
  );
  assert.ok(htmlDeep.ok);
  if (htmlDeep.ok) {
    assert.deepEqual(
      htmlDeep.corpus.map((c) => c.path),
      ["architecture.md", "w/app.html"],
      "depth 1 in, depth 2 out"
    );
    assert.ok(
      htmlDeep.manifest.some((m) => m.path === "a/b/app.html"),
      "the deep file is still listed"
    );
  }

  // (iv) more than corpusHtmlMaxFiles: the first N in WALK order (the outer
  // archive's central-directory order) are admitted, NOT the N smallest;
  // within the corpus the admitted ones then sort ascending by size like any
  // other text. Sizes descend in walk order here so the two orders differ.
  const manyHtml = await inspectArchive(
    await zipOf({
      "architecture.md": PROSE,
      "one.html": "<p>1</p>".repeat(40),
      "two.html": "<p>2</p>".repeat(30),
      "three.html": "<p>3</p>".repeat(20),
      "four.html": "<p>4</p>",
      "five.html": "<p>5</p>",
    }),
    "program"
  );
  assert.ok(manyHtml.ok);
  if (manyHtml.ok) {
    assert.deepEqual(
      manyHtml.corpus.map((c) => c.path).filter(isCorpusHtml),
      ["three.html", "two.html", "one.html"],
      "first three in walk order, ascending by size in the corpus"
    );
    assert.equal(manyHtml.corpus[0].path, "architecture.md");
    assert.equal(manyHtml.manifest.length, 6, "the rest stay in the manifest");
  }

  // (v) A Skill package carrying assets/template.html beside SKILL.md still
  // resolves skill with SKILL.md as the doc. PINNED: at depth 1 the template
  // enters the corpus after SKILL.md (a Skill's HTML template is evidence of
  // what the Skill produces, and the rule is deliberately kind-blind).
  const skillWithHtml = await inspectArchive(
    await zipOf({
      "SKILL.md": `---\nname: t\ndescription: d\n---\n${PROSE}`,
      "assets/template.html": APP_HTML,
    }),
    null,
    { packageName: "t.skill" }
  );
  assert.ok(skillWithHtml.ok && !skillWithHtml.docMissing, "skill with an html asset resolves");
  if (skillWithHtml.ok) {
    assert.equal(skillWithHtml.kind, "skill");
    assert.equal(skillWithHtml.kindVerdict.rule, "skill_package");
    assert.equal(skillWithHtml.docPath, "SKILL.md");
    assert.deepEqual(skillWithHtml.corpus.map((c) => c.path), [
      "SKILL.md",
      "assets/template.html",
    ]);
  }
  // The Skill ladder never counts an .html: a sole .md beside an index.html is
  // still the one qualifying document (not ambiguous, not missing), and the
  // classifier still calls the package a Skill (sole_document; .html is not
  // in SOURCE_EXT and never was).
  const soleDocHtml = await inspectArchive(
    await zipOf({ "guide.md": PROSE, "index.html": APP_HTML }),
    null,
    { packageName: "t.zip" }
  );
  assert.ok(
    soleDocHtml.ok &&
      soleDocHtml.kind === "skill" &&
      soleDocHtml.kindVerdict.rule === "sole_document" &&
      soleDocHtml.docPath === "guide.md" &&
      !soleDocHtml.docMissing,
    "html is never a Skill doc candidate and never a program signal"
  );
  if (soleDocHtml.ok)
    assert.deepEqual(soleDocHtml.corpus.map((c) => c.path), ["guide.md", "index.html"]);
  // Inside a lazily-opened inner archive the HTML rule is OFF (outer level
  // only): the inner SKILL.md is the doc, the inner template is not evidence.
  const innerHtml = await inspectArchive(
    await (async () => {
      const zip = new JSZip();
      zip.file("pkg.skill", await zipOf({ "SKILL.md": PROSE, "template.html": APP_HTML }));
      return zip.generateAsync({ type: "nodebuffer" });
    })(),
    "skill"
  );
  assert.ok(innerHtml.ok && innerHtml.docPath === "pkg.skill!/SKILL.md");
  if (innerHtml.ok) {
    assert.ok(
      !innerHtml.corpus.some((c) => isCorpusHtml(c.path)),
      "HTML inside an inner archive never enters the corpus"
    );
    assert.ok(
      innerHtml.manifest.some((m) => m.path === "pkg.skill!/template.html"),
      "but is still listed"
    );
  }
  // mergeSkillCorpus keeps the same order: standalone doc, package documents,
  // package HTML last.
  const pkgWithHtml = await inspectArchive(
    await zipOf({
      "myskill/SKILL.md": PROSE,
      "myskill/preview.html": APP_HTML,
      "myskill/references/notes.md": "Reference notes with enough text to ride along.",
    }),
    "skill"
  );
  assert.ok(standalone.ok && pkgWithHtml.ok);
  if (standalone.ok && pkgWithHtml.ok) {
    const merged = mergeSkillCorpus(standalone, pkgWithHtml);
    assert.deepEqual(
      merged.map((c) => c.path),
      ["SKILL.md", "myskill/SKILL.md", "myskill/references/notes.md", "myskill/preview.html"],
      "merge: standalone doc, the package's corpus in its own order (its doc, then documents ascending), HTML last"
    );
  }

  // (vi) The HTML goes through the same cleaner: an inline credential is
  // redacted in the corpus, in the stored archive, and the file is recorded
  // as redacted. (fakeSecretLine is assembled at runtime above so the repo's
  // pre-commit secrets gate never sees the literal.)
  const htmlSecret = await inspectArchive(
    await zipOf({
      "architecture.md": PROSE,
      "app.html": `${APP_HTML}<script>const ${fakeSecretLine};</script>\n`,
    }),
    "program"
  );
  assert.ok(htmlSecret.ok, "an inline credential in the HTML is cleaned, not refused");
  if (htmlSecret.ok) {
    assert.deepEqual(htmlSecret.cleaning?.redactedPaths, ["app.html"]);
    const html = htmlSecret.corpus.find((c) => c.path === "app.html");
    assert.ok(html, "the cleaned HTML is still evidence");
    assert.ok(!html!.text.includes("abcdefgh12345678"), "corpus HTML is clean");
    assert.ok(html!.text.includes("[redacted:"), "and says so where it cut");
    assert.ok(html!.text.includes("draftReply"), "the rest of the app survives");
    const rebuilt = await JSZip.loadAsync(htmlSecret.cleaning!.stored!.bytes);
    const stored = await rebuilt.files["app.html"].async("string");
    assert.ok(!stored.includes("abcdefgh12345678"), "stored archive HTML is clean");
    assert.equal(htmlSecret.docPath, "architecture.md", "the doc is untouched");
  }
  // The gut guard applies too: an HTML that is mostly credential leaves the
  // corpus but stays in the manifest, exactly like a .md would.
  const htmlGutted = await inspectArchive(
    await zipOf({
      "architecture.md": PROSE,
      "k.html": `<script>${fakeSecretLine}</script>`,
    }),
    "program"
  );
  assert.ok(htmlGutted.ok);
  if (htmlGutted.ok) {
    assert.ok(
      !htmlGutted.corpus.some((c) => c.path === "k.html"),
      "a gutted HTML is not offered to the panel"
    );
    assert.ok(htmlGutted.manifest.some((m) => m.path === "k.html"));
  }

  // (vii) classify.ts is blind to HTML TEXT: a front-matter-looking body in an
  // .html cannot fire the skill_document rung, and an .html beside program
  // scaffolding changes nothing. (The full fixture ladder is pinned under
  // "kind inference" below and runs unchanged.)
  assert.equal(
    classifyWorkKind({
      packageName: "t.zip",
      paths: ["notes.html"],
      innerArchivePaths: [],
      texts: [{ path: "notes.html", text: "---\nname: x\ndescription: y\n---\nbody" }],
    }).rule,
    "default_program",
    "HTML text never satisfies the Skill front-matter rung"
  );
  assert.equal(
    classifyWorkKind({
      packageName: "t.zip",
      paths: ["architecture.md", "app.html"],
      innerArchivePaths: [],
      texts: [{ path: "app.html", text: APP_HTML }],
    }).rule,
    "program_scaffolding"
  );

  // ---- lint ----
  assert.equal(wordCount("one two  three"), 3);
  assert.equal(slugForTitle("My Cool Tool!"), "team-my-cool-tool");

  assert.ok(lintCard(goodCard(), ctx).ok, `good card passes: ${lintCard(goodCard(), ctx).violations.join("; ")}`);

  const emDash = goodCard();
  emDash.summary = emDash.summary.replace(".", " — done.");
  assert.ok(!lintCard(emDash, ctx).ok, "em dash rejected");

  const url = goodCard();
  url.body = [sentence(70) + " See https://example.com for more."];
  assert.ok(!lintCard(url, ctx).ok, "URL rejected");

  const adverb = goodCard();
  adverb.summary = sentence(59) + " It always works.";
  assert.ok(!lintCard(adverb, ctx).ok, "frequency adverb rejected");

  // Machine-name echo backstop (2026-08-04 incident): title-only, and the
  // violation must START with "title" so repairDrift classifies it. A body
  // paragraph naming an export ("named X (x-slug)") must NOT fire.
  const echoTitle = goodCard();
  echoTitle.title = "Outage Checker (outage-checker)";
  {
    const res = lintCard(echoTitle, ctx);
    assert.ok(!res.ok, "machine-echo title rejected by the publish lint");
    assert.ok(
      res.violations.some((v) => v.startsWith("title:")),
      "echo violation is classified as a title violation"
    );
  }
  const echoBody = goodCard();
  echoBody.body = [
    sentence(60) + " The export is named Outage Checker (outage-checker).",
  ];
  assert.ok(
    lintCard(echoBody, ctx).ok,
    `echo shape in a body paragraph is legal: ${lintCard(echoBody, ctx).violations.join("; ")}`
  );

  // Retired-tool opener (2026-08-29 "Ticket Reply Composer" incident): a
  // summary that opens by putting the TOOL in the past tense publishes a live
  // tool as a retirement notice. The violation must START with "summary" so
  // classifyViolations frees that field for the repair stage.
  {
    const pastOpener = goodCard();
    pastOpener.summary =
      "Export Scorer was a browser-based tool that scored each export row. " +
      sentence(50);
    const res = lintCard(pastOpener, ctx);
    assert.ok(!res.ok, "past-tense summary opener rejected");
    assert.ok(
      res.violations.some((v) => v.startsWith("summary describes the tool in the past tense")),
      "the tense violation is classified as a summary violation"
    );
    // The same shape without the title, and with a leading article.
    const theOpener = goodCard();
    theOpener.summary =
      "The Export Scoring Dashboard was a locally run web application. " +
      sentence(50);
    {
      const res = lintCard(theOpener, ctx);
      assert.ok(!res.ok, "\"The <noun> was\" opener rejected");
      assert.ok(
        res.violations.some((v) => v.startsWith("summary describes the tool in the past tense")),
        "the article opener fails for the tense reason, not another rule"
      );
    }

    // A COMPLIANT sentence that obeys the new rule exactly (present tense for
    // the tool, past for a one-time event in the same sentence) must pass:
    // the article branch stops at a clause boundary instead of scanning 60
    // characters for any "was" (refutation MAJOR, 2026-08-29).
    for (const opener of [
      "The tool exports tickets, and the first run was slow.",
      "This skill drafts replies, and the pilot run was short.",
      "The tool replaced a manual process that was slow.",
      "Tickets were routed by hand before this tool shipped.",
      "The first run was completed across 40 tickets.",
      "The migration was finished in March, and the tool now syncs nightly.",
      "Tickets were piling up before this tool existed.",
    ]) {
      const compliant = goodCard();
      compliant.summary = opener + " " + sentence(48);
      assert.ok(
        lintCard(compliant, ctx).ok,
        `compliant opener passes: ${JSON.stringify(opener)}: ${lintCard(compliant, ctx).violations.join("; ")}`
      );
    }

    // Present tense passes.
    const present = goodCard();
    present.summary =
      "Export Scorer is a browser-based tool that scores each export row. " +
      sentence(50);
    assert.ok(
      lintCard(present, ctx).ok,
      `present-tense summary passes: ${lintCard(present, ctx).violations.join("; ")}`
    );

    // A legitimate past-tense EVENT later in the summary passes: past tense is
    // banned only for the tool itself, in the opening clause.
    const event = goodCard();
    event.summary =
      "Export Scorer is a browser-based tool that scores each export row. " +
      sentence(46) +
      " The first run processed 40 tickets.";
    assert.ok(
      lintCard(event, ctx).ok,
      `past-tense event later in the summary passes: ${lintCard(event, ctx).violations.join("; ")}`
    );
  }

  const collide = goodCard();
  collide.title = staticTitles.titles[0];
  assert.ok(!lintCard(collide, ctx).ok, "static title collision rejected");

  const facetCollide = goodCard();
  facetCollide.facets[0].label = staticTitles.facetLabels[0];
  assert.ok(!lintCard(facetCollide, ctx).ok, "static facet collision rejected");

  const dbCollide = goodCard();
  assert.ok(
    !lintCard(dbCollide, {
      publishedTitles: ["export scorer"],
      publishedFacetLabels: [],
    }).ok,
    "published title collision rejected"
  );

  const badBadge = goodCard();
  badBadge.categoryBadge = "Flagship product";
  assert.ok(!lintCard(badBadge, ctx).ok, "off-enum category rejected");

  const twoFacets = goodCard();
  twoFacets.facets = twoFacets.facets.slice(0, 2);
  assert.ok(!lintCard(twoFacets, ctx).ok, "facet count enforced");

  const markup = goodCard();
  markup.footerLine = ["<script>alert(1)</script>", "x"];
  assert.ok(!lintCard(markup, ctx).ok, "markup-shaped text rejected");

  const email = goodCard();
  email.body = [sentence(70) + " Contact ai@xl.net for access."];
  assert.ok(!lintCard(email, ctx).ok, "email address rejected");

  const extraKey = { ...goodCard(), statusBadge: "Live" };
  assert.ok(!lintCard(extraKey, ctx).ok, "unknown key rejected");

  // ---- meta-commentary gate (2026-07-31 incident: four published cards
  // were ABOUT the review instead of about the tool) ----
  const meta = goodCard();
  meta.summary =
    sentence(50) + " No supporting source document was submitted for this card.";
  assert.ok(!lintCard(meta, ctx).ok, "process meta-commentary in summary rejected");

  const metaFacet = goodCard();
  metaFacet.facets[0].label = "Editorial Decision";
  assert.ok(!lintCard(metaFacet, ctx).ok, "meta facet label rejected");

  const metaFooter = goodCard();
  metaFooter.footerLine = ["evidence unavailable", "source review required"];
  assert.ok(!lintCard(metaFooter, ctx).ok, "meta footer fragments rejected");

  const docTool = goodCard();
  docTool.summary =
    sentence(40) +
    " The documented workflow searches SweetProcess documentation and cites the source of each answer in the reply.";
  assert.ok(
    lintCard(docTool, ctx).ok,
    `document vocabulary about the tool stays legal: ${lintCard(docTool, ctx).violations.join("; ")}`
  );

  const metaTitle = goodCard();
  metaTitle.title = "Editorial Calendar Builder";
  assert.ok(
    lintCard(metaTitle, ctx).ok,
    "meta vocabulary in a submitter-chosen title is not a meta-commentary violation"
  );

  const titlePrefix = goodCard();
  titlePrefix.title = "Claude Skill: Export Scorer";
  assert.ok(
    !lintCard(titlePrefix, ctx).ok,
    "category-prefixed title rejected by the lint backstop"
  );

  // The HOUSE_RULES split (docs-blind stages get style rules only) must be
  // byte-identical to the pre-split literal, or every writer prompt shifts.
  // ---- repair containment (repair.ts, 2026-08-04 "Rippling Mileage Entry"
  // incident: the one-shot repair paraphrased the summary while fixing an
  // unrelated violation and the drift gate held a fine card; the publish
  // candidate is now MERGED in code) ----

  // T1: the shared violation->grant table, one representative string per row.
  {
    const one = (v: string) => classifyViolations([v]);
    assert.deepEqual(one("summary must be 40-90 words (got 12)"), {
      title: false, badge: false, summary: true, body: false, facets: false, footer: false,
    });
    assert.ok(one("body paragraph 1 exceeds 120 words").body);
    assert.ok(one("body 2: contains an em or en dash").body);
    assert.ok(one("facet 2 text must be 25-70 words (got 8)").facets);
    assert.ok(one("facet 1 label: contains the frequency adverb \"always\"").facets);
    assert.ok(one("facet labels must differ from each other").facets);
    assert.ok(one('facet label "Scored Rows" collides with an existing /work facet title').facets);
    assert.ok(one("footerLine must be 2-5 plain-string fragments").footer);
    assert.ok(one("footer fragment 2 must be 1-60 characters").footer);
    assert.ok(one("categoryBadge must be one of: Internal tool").badge);
    assert.ok(one("title must be 4-60 characters").title);
    assert.ok(one('title "Export Scorer" collides with an existing /work card').title);
    assert.ok(one('title: ends with a parenthetical that repeats the tool\'s own name; state the name once and drop "(x)"').title);
    const band = one("card visible copy must total 140-560 words (got 120)");
    assert.deepEqual(band, {
    // The band counts summary + body + facet text only, so it must NOT free
    // the footer: a footer edit cannot satisfy it, and freeing it would let
    // the docs-blind repair publish footer copy the disclosure critic never
    // saw.
      title: false, badge: false, summary: true, body: true, facets: true, footer: false,
    });
    // Fail-closed rows: schema-level strings free NOTHING (the old
    // else-bucket freed all visible copy on an unknown key).
    assert.ok(!grantFreesAnything(one('unknown key "statusBadge"')));
    assert.ok(!grantFreesAnything(one("card is not an object")));
    assert.ok(!grantFreesAnything(one("some future string the table has never seen")));
  }

  // T2: catalog tripwire — every violation lintCard can emit must classify
  // to the field it actually names, not merely to SOMETHING. A cross-routed
  // string (a summary message freeing body) would silently hand the
  // docs-blind repair the wrong rewrite license; a string that frees nothing
  // makes its own violation unrepairable. Each case declares the fields its
  // breakage should free, and the union is asserted exactly.
  const GC = goodCard();
  const cases: { card: Record<string, unknown>; frees: (keyof ReturnType<typeof classifyViolations>)[] }[] = [
    { card: { ...goodCard(), title: "abc" }, frees: ["title"] },
    { card: { ...goodCard(), title: "Claude Skill: Export Scorer" }, frees: ["title"] },
    { card: { ...goodCard(), title: "Export Scorer (export-scorer)" }, frees: ["title"] },
    // Static collision. Read the title out of the snapshot rather than
    // pinning a literal: "Log Analyzer" was pinned here until 2026-08-29 and
    // the exhibit-to-team-card round deleted it from static-titles.json, so
    // the case stopped producing a violation and this suite went red. The
    // dynamic form is the same idiom lines 373/377 already use and cannot rot
    // on the next exhibit change.
    { card: { ...goodCard(), title: staticTitles.titles[0] }, frees: ["title"] },
    { card: { ...goodCard(), categoryBadge: "Flagship product" }, frees: ["badge"] },
    { card: { ...goodCard(), summary: sentence(10) }, frees: ["summary"] },
    { card: { ...goodCard(), summary: sentence(50) + " It ran — fast." }, frees: ["summary"] },
    { card: { ...goodCard(), summary: sentence(50) + " Visit https://x.example now." }, frees: ["summary"] },
    { card: { ...goodCard(), summary: sentence(50) + " Mail tron@example.com today." }, frees: ["summary"] },
    { card: { ...goodCard(), summary: sentence(50) + " Call 312 555 1212 now." }, frees: ["summary"] },
    { card: { ...goodCard(), summary: sentence(50) + " It always ran." }, frees: ["summary"] },
    { card: { ...goodCard(), summary: sentence(40) + " No supporting source document was submitted." }, frees: ["summary"] },
    { card: { ...goodCard(), body: [sentence(121)] }, frees: ["body"] },
    { card: { ...goodCard(), body: [sentence(60), sentence(60), sentence(60)] }, frees: ["body"] },
    { card: { ...goodCard(), body: [sentence(60) + " <div>x</div>"] }, frees: ["body"] },
    { card: { ...goodCard(), facets: GC.facets.slice(0, 2) }, frees: ["facets"] },
    { card: { ...goodCard(), facets: GC.facets.map((f) => ({ ...f, label: "Scored Rows" })) }, frees: ["facets"] },
    { card: { ...goodCard(), facets: GC.facets.map((f, i) => (i === 0 ? { ...f, label: "x".repeat(29) } : f)) }, frees: ["facets"] },
    { card: { ...goodCard(), facets: GC.facets.map((f, i) => (i === 0 ? { ...f, text: sentence(8) } : f)) }, frees: ["facets"] },
    { card: { ...goodCard(), facets: GC.facets.map((f, i) => (i === 0 ? { ...f, label: "Editorial Decision" } : f)) }, frees: ["facets"] },
    { card: { ...goodCard(), footerLine: [] }, frees: ["footer"] },
    { card: { ...goodCard(), footerLine: ["ok", "x".repeat(61)] }, frees: ["footer"] },
    { card: { ...goodCard(), footerLine: ["ok", "evidence unavailable"] }, frees: ["footer"] },
    {
      card: { ...goodCard(), summary: sentence(40), body: [sentence(5)],
        facets: GC.facets.map((f) => ({ ...f, text: sentence(25) })) },
      frees: ["summary", "body", "facets"],
    },
  ];
  {
    for (const { card, frees } of cases) {
      const violations = lintCard(card, ctx).violations;
      assert.ok(violations.length > 0, `case produces a violation: ${JSON.stringify(card).slice(0, 80)}`);
      const grant = classifyViolations(violations);
      const freed = (Object.keys(grant) as (keyof typeof grant)[]).filter((k) => grant[k]);
      assert.deepEqual(
        freed.sort(),
        [...frees].sort(),
        `violations route to exactly the broken field(s): ${violations.join(" | ")}`
      );
    }
    // Frees-nothing is reserved for schema-level strings: a violation that
    // names a real copy defect must never land there (it would be
    // unrepairable), and unknown keys must never free copy.
    const unknownKey = lintCard({ ...goodCard(), statusBadge: "Live" }, ctx);
    assert.deepEqual(unknownKey.violations, ['unknown key "statusBadge"']);
    assert.ok(!grantFreesAnything(classifyViolations(unknownKey.violations)));
    // Prefix integrity: submitted text is only ever interpolated mid-string,
    // so a crafted title/label cannot occupy the classified prefix.
    const craftedTitle = { ...goodCard(), title: "Summary Must Be Short" };
    const craftedCtx = {
      publishedTitles: ["summary must be short"],
      publishedFacetLabels: [],
    };
    const craftedViolations = lintCard(craftedTitle, craftedCtx).violations;
    assert.ok(craftedViolations.length > 0, "crafted title collides");
    const craftedGrant = classifyViolations(craftedViolations);
    assert.ok(craftedGrant.title && !craftedGrant.summary,
      "adversarial title text classifies as a title violation, never summary");
  }

  // T3: incident regression — summary violation only; the repair fixes the
  // summary but ALSO paraphrases body, retitles, and rewrites the footer.
  // The merge keeps only the licensed fix; the backstop stays silent.
  {
    const synth = { ...goodCard(), summary: sentence(10) };
    const violations = lintCard(synth, ctx).violations;
    assert.deepEqual(violations, ["summary must be 40-90 words (got 10)"]);
    const repair = {
      ...goodCard(),
      summary: sentence(60, "the workflow converted address events into mileage drafts for review"),
      body: [sentence(80, "a paraphrased body the lint never licensed to change at all")],
      title: "Hijacked Name",
      footerLine: ["rewritten", "fragments"],
    };
    const merged = mergeRepair(synth, repair, violations);
    assert.ok(merged, "merge produced a candidate");
    if (merged) {
      assert.equal(merged.summary, repair.summary);
      assert.deepEqual(merged.body, synth.body);
      assert.equal(merged.title, synth.title);
      assert.deepEqual(merged.footerLine, synth.footerLine);
      assert.deepEqual(merged.facets, synth.facets);
      const relint = lintCard(merged, ctx);
      assert.ok(relint.ok, `merged card passes: ${relint.violations.join("; ")}`);
      assert.deepEqual(
        relint.card && repairDrift(synth, relint.card, violations),
        [],
        "backstop unreachable on a correct merge"
      );
      assert.deepEqual(
        restoredFields(synth, repair, violations).sort(),
        ["body", "footerLine", "title"],
        "restored-field FYI names exactly what the model tried to change"
      );
    }
  }

  // T4: the word-band grant frees all visible copy but never title/badge.
  {
    const synth = {
      ...goodCard(),
      summary: sentence(40),
      body: [sentence(5)],
      facets: goodCard().facets.map((f) => ({ ...f, text: sentence(25) })),
    };
    const violations = lintCard(synth, ctx).violations;
    assert.deepEqual(violations, ["card visible copy must total 140-560 words (got 120)"]);
    const repair = { ...synth, body: [sentence(60)], title: "Hijacked", categoryBadge: "Automation" };
    const merged = mergeRepair(synth, repair, violations);
    assert.ok(merged);
    if (merged) {
      assert.equal(merged.title, synth.title);
      assert.equal(merged.categoryBadge, synth.categoryBadge);
      assert.deepEqual(merged.body, repair.body);
      assert.ok(lintCard(merged, ctx).ok);
    }
    // And the backstop still pins visible-never-frees-title.
    const lied = lintCard({ ...synth, body: [sentence(60)], title: "Other Name Here" }, ctx);
    assert.ok(lied.ok && lied.card);
    if (lied.ok && lied.card)
      assert.deepEqual(repairDrift(synth, lied.card, violations), [
        "title changed without a title violation",
      ]);
  }

  // T5: unknown-key-only violations free nothing; the merge drops the key
  // structurally and a hostile repair value cannot reach any field.
  {
    const synth = { ...goodCard(), statusBadge: "Live" };
    const violations = lintCard(synth, ctx).violations;
    assert.deepEqual(violations, ['unknown key "statusBadge"']);
    assert.ok(!grantFreesAnything(classifyViolations(violations)));
    const merged = mergeRepair(synth, { title: "Hijacked", statusBadge: "Live" }, violations);
    assert.ok(merged);
    if (merged) {
      assert.deepEqual(Object.keys(merged).sort(), [
        "body", "categoryBadge", "facets", "footerLine", "summary", "title",
      ]);
      assert.equal(merged.title, synth.title);
      assert.ok(lintCard(merged, ctx).ok, "unknown key fixed by merge construction alone");
    }
    assert.ok(
      mergeRepair(synth, null, violations),
      "frees-nothing grant tolerates a null repair (no model call is made)"
    );
  }

  // T6: a wrong-shaped repair value in a FREED field holds with the
  // accurate field-prefixed reason via the merged relint.
  {
    const synth = { ...goodCard(), footerLine: ["only one"] };
    const violations = lintCard(synth, ctx).violations;
    const merged = mergeRepair(synth, { ...synth, footerLine: "not an array" }, violations);
    assert.ok(merged);
    if (merged) {
      const relint = lintCard(merged, ctx);
      assert.ok(!relint.ok);
      assert.ok(relint.violations.some((v) => v.startsWith("footerLine must be")));
    }
  }

  // T7: a freeing grant with a non-object repair yields null (caller holds).
  {
    const synth = { ...goodCard(), summary: sentence(10) };
    const violations = lintCard(synth, ctx).violations;
    assert.equal(mergeRepair(synth, null, violations), null);
    assert.equal(mergeRepair(synth, "prose apology", violations), null);
    assert.equal(mergeRepair(synth, ["a card in an array"], violations), null);
  }

  // T8: a field missing from synth is always freed by its own violation and
  // filled from the repair.
  {
    const synth: Record<string, unknown> = { ...goodCard() };
    delete synth.footerLine;
    const violations = lintCard(synth, ctx).violations;
    assert.ok(classifyViolations(violations).footer);
    const merged = mergeRepair(synth, { footerLine: ["from architecture.md", "one in, one out"] }, violations);
    assert.ok(merged);
    if (merged) assert.ok(lintCard(merged, ctx).ok);
  }

  // T9: a genuine cross-field conflict (licensed fix shrinks the card below
  // the whole-card band) still holds, with the band violation named.
  {
    const synth = {
      ...goodCard(),
      summary: sentence(40),
      body: [sentence(10)],
      facets: [
        { label: "Scored Rows", text: sentence(25) },
        { label: "One Export In", text: sentence(75) },
        { label: "Desk Handoff", text: sentence(25) },
      ],
    };
    const violations = lintCard(synth, ctx).violations;
    assert.deepEqual(violations, ["facet 2 text must be 25-70 words (got 75)"]);
    const repair = {
      ...synth,
      facets: synth.facets.map((f, i) => (i === 1 ? { ...f, text: sentence(25) } : f)),
    };
    const merged = mergeRepair(synth, repair, violations);
    assert.ok(merged);
    if (merged) {
      const relint = lintCard(merged, ctx);
      assert.ok(!relint.ok);
      assert.ok(
        relint.violations.some((v) => v.startsWith("card visible copy must total")),
        "merged-band conflict holds with the accurate reason"
      );
    }
  }

  // T10: trim symmetry — an untrimmed synth string can never fire the
  // backstop after a correct merge (lintCard's trim matches norm()'s).
  {
    const synth = { ...goodCard(), title: " Export Scorer ", summary: sentence(10) };
    const violations = lintCard(synth, ctx).violations;
    const merged = mergeRepair(synth, { ...goodCard(), summary: sentence(60) }, violations);
    assert.ok(merged);
    if (merged) {
      const relint = lintCard(merged, ctx);
      assert.ok(relint.ok && relint.card);
      if (relint.ok && relint.card)
        assert.deepEqual(repairDrift(synth, relint.card, violations), []);
    }
  }

  // T11: the backstop itself still detects a mis-merge (the incident string
  // is now reachable only through a mergeRepair bug).
  {
    const synth = goodCard();
    const bad = lintCard({ ...goodCard(), summary: sentence(55, "a silently paraphrased summary the merge should have restored") }, ctx);
    assert.ok(bad.ok && bad.card);
    if (bad.ok && bad.card)
      assert.deepEqual(
        repairDrift(synth, bad.card, ["facet 2 text must be 25-70 words (got 8)"]),
        ["summary changed without a summary violation"]
      );
  }

  // T12: a PARTIAL repair reply (only the fixed field, which models send
  // despite the full-card schema) must not read as a rewrite attempt: the
  // omitted unfreed fields keep synth's values and the owner FYI stays
  // silent, or the round's own drift signal cries wolf on every terse reply.
  {
    const synth = { ...goodCard(), summary: sentence(10) };
    const violations = lintCard(synth, ctx).violations;
    const partial = { summary: sentence(60) };
    const merged = mergeRepair(synth, partial, violations);
    assert.ok(merged);
    if (merged) {
      assert.equal(merged.summary, partial.summary);
      assert.equal(merged.title, synth.title);
      assert.deepEqual(merged.body, synth.body);
      assert.deepEqual(merged.footerLine, synth.footerLine);
      assert.ok(lintCard(merged, ctx).ok, "partial reply still publishes");
    }
    assert.deepEqual(
      restoredFields(synth, partial, violations),
      [],
      "an omitted field is an omission, never a reported rewrite attempt"
    );
    // A FREED field the repair omitted keeps synth's violating value and
    // re-fails its own violation: never an absent key in the merged card.
    const omitted = mergeRepair(synth, { title: "Export Scorer" }, violations);
    assert.ok(omitted);
    if (omitted) {
      assert.equal(omitted.summary, synth.summary);
      assert.ok(Object.keys(omitted).includes("summary"));
      const relint = lintCard(omitted, ctx);
      assert.ok(!relint.ok);
      assert.ok(relint.violations.some((v) => v.startsWith("summary must be")));
    }
  }

  // T13: the FYI compares canonically — key order and surrounding
  // whitespace in an echoed field are not a rewrite attempt.
  {
    const synth = { ...goodCard(), summary: sentence(10) };
    const violations = lintCard(synth, ctx).violations;
    const echoed = {
      ...goodCard(),
      summary: sentence(60),
      title: " Export Scorer ",
      facets: goodCard().facets.map((f) => ({ text: f.text, label: f.label })),
    };
    assert.deepEqual(
      restoredFields(synth, echoed, violations),
      [],
      "whitespace and key-order echoes are not drift"
    );
    const reworded = { ...goodCard(), summary: sentence(60), title: "Renamed Tool" };
    assert.deepEqual(restoredFields(synth, reworded, violations), ["title"]);
  }

  // T14: storableDraft — approveHeld publishes a held draft verbatim, so a
  // stored draft must always carry all six keys through a JSON round trip
  // (an absent footerLine would throw where work-card.tsx spreads it).
  {
    const husk = { title: "Export Scorer", footerLine: "not an array" };
    const stored = JSON.parse(JSON.stringify(storableDraft(husk)));
    assert.deepEqual(Object.keys(stored).sort(), [
      "body", "categoryBadge", "facets", "footerLine", "summary", "title",
    ]);
    assert.deepEqual(stored.footerLine, []);
    assert.deepEqual([...stored.footerLine, "credit"], ["credit"], "renderer-safe");
    assert.equal(stored.title, "Export Scorer", "present fields survive");
    // Non-object synthesis output degrades to a complete empty card, never
    // Junk ELEMENTS inside a kept array throw as hard as an absent array:
    // f.label on a null facet takes down the whole /work render, and there
    // is no error boundary above it. Elements are typed, not just containers.
    const junk = storableDraft({
      ...goodCard(),
      facets: [null, { label: {}, text: "x" }, { label: "Kept", text: "ok" }],
      body: [{ para: "x" }, "kept paragraph"],
      footerLine: [42, "kept fragment"],
    });
    assert.deepEqual(junk.facets, [{ label: "Kept", text: "ok" }], "junk facets dropped");
    assert.deepEqual(junk.body, ["kept paragraph"], "non-string paragraphs dropped");
    assert.deepEqual(junk.footerLine, ["kept fragment"], "non-string fragments dropped");
    for (const f of junk.facets as { label: string }[]) assert.equal(typeof f.label, "string");
    // a bare "{}" whose approve click throws in slugForTitle.
    const fromArray = JSON.parse(JSON.stringify(storableDraft(["not a card"])));
    assert.deepEqual(Object.keys(fromArray).length, 6);
    assert.equal(fromArray.title, "");
    // A lint-passing card round-trips byte-identical.
    assert.deepEqual(storableDraft(goodCard()), goodCard());
  }

  assert.equal(
    HOUSE_RULES,
    "House copy rules, all mandatory: no em dashes or en dashes anywhere; no " +
      "frequency adverbs (always, never, often, usually, frequently, rarely, " +
      "constantly, typically, regularly); no URLs, email addresses, or phone " +
      "numbers; no HTML or markdown markup; plain factual prose; present tense " +
      "for what the tool is and does, because the page shows live tools; past " +
      "tense only for a one-time event such as a run, a migration, or an " +
      "incident, and never for the tool itself; every claim must be supported " +
      "by the submitted documents; claims must not outrun the evidence.",
    "HOUSE_RULES concatenation is byte-identical to the pre-split literal"
  );

  // ---- wrapper-zip shapes (2026-07-30 owner directive) ----
  const innerSkillBytes = await zipOf({
    "SKILL.md": PROSE,
    "references/notes.md": "Reference notes that ride the corpus along.",
  });
  async function wrapperOf(extra: Record<string, string>): Promise<Buffer> {
    const zip = new JSZip();
    zip.file("my-skill.skill", innerSkillBytes);
    for (const [p, t] of Object.entries(extra)) zip.file(p, t);
    return zip.generateAsync({ type: "nodebuffer" });
  }

  // Owner's shape: wrapper zip with .skill + a differently-named .md.
  const wrapped = await inspectArchive(
    await wrapperOf({ "secure-audit.md": PROSE + " wrapper doc." }),
    "skill"
  );
  assert.ok(wrapped.ok && !wrapped.docMissing, "wrapper .skill + .md accepted");
  if (wrapped.ok) {
    assert.equal(wrapped.docPath, "secure-audit.md", "outer .md wins by uniqueness");
    assert.ok(wrapped.docRawBytes, "raw doc bytes surfaced for retention");
  }

  // Wrapper with ONLY the .skill: doc resolved from inside it (lazy open).
  const skillOnly = await inspectArchive(await wrapperOf({}), "skill");
  assert.ok(skillOnly.ok && !skillOnly.docMissing, "wrapper .skill-only accepted");
  if (skillOnly.ok) {
    assert.equal(skillOnly.docPath, "my-skill.skill!/SKILL.md");
    assert.ok(
      skillOnly.corpus.some((c) => c.path === "my-skill.skill!/references/notes.md"),
      "inner texts ride the corpus with prefixed paths"
    );
  }

  // Bare package with an opaque asset zip still passes (lazy rule: the
  // inner archive is never opened when the outer level resolves the doc).
  const bareWithAsset = await inspectArchive(
    await (async () => {
      const zip = new JSZip();
      zip.file("SKILL.md", PROSE);
      zip.file("assets.zip", await zipOf({ ".env": "SECRET=1" }));
      return zip.generateAsync({ type: "nodebuffer" });
    })(),
    "skill"
  );
  assert.ok(
    bareWithAsset.ok && !bareWithAsset.docMissing,
    "bare package with asset zip unchanged (inner stays opaque)"
  );

  // Secret INSIDE the opened inner archive rejects with a prefixed path.
  const dirtyInner = await (async () => {
    const innerDirty = await zipOf({ "SKILL.md": PROSE, ".env": "X=1" });
    const zip = new JSZip();
    zip.file("my-skill.skill", innerDirty);
    return zip.generateAsync({ type: "nodebuffer" });
  })();
  const dirty = await inspectArchive(dirtyInner, "skill");
  // The WHOLE bundled archive leaves, rather than being rewritten and
  // re-embedded: rewriting a nested archive would be the first code here to
  // treat one as writable, and it would cost a second full rebuild inside the
  // one already running. Nothing read out of it may be reviewed either, so the
  // row falls back to the doc-missing lane the standalone .md field rescues.
  assert.ok(dirty.ok, "a credential inside a bundled archive no longer refuses");
  if (dirty.ok) {
    assert.equal(dirty.docMissing, "missing", "its documents are not reviewed");
    assert.deepEqual(
      dirty.cleaning?.droppedPaths.map((d) => d.path),
      ["my-skill.skill"]
    );
    const rebuilt = await JSZip.loadAsync(dirty.cleaning!.stored!.bytes);
    assert.ok(!rebuilt.files["my-skill.skill"], "the bundle is not stored");
    assert.ok(
      !dirty.manifest.some((m) => m.path.startsWith("my-skill.skill")),
      "and neither it nor its inner rows remain in the manifest"
    );
  }

  // Short boilerplate-adjacent .md does not dead-end resolution: floor-gated
  // candidacy falls through to the inner SKILL.md.
  const shortNotes = await inspectArchive(
    await wrapperOf({ "NOTES.md": "short note" }),
    "skill"
  );
  assert.ok(shortNotes.ok && !shortNotes.docMissing, "short .md falls through");
  if (shortNotes.ok) assert.equal(shortNotes.docPath, "my-skill.skill!/SKILL.md");

  // Two qualifying outer .mds, none named SKILL.md, no resolvable inner doc:
  // ambiguous with candidate paths.
  const ambiguous = await inspectArchive(
    await zipOf({ "one.md": PROSE, "two.md": PROSE + " different." }),
    "skill"
  );
  assert.ok(ambiguous.ok && ambiguous.docMissing === "ambiguous", "ambiguity flagged");
  if (ambiguous.ok)
    assert.equal(ambiguous.candidatePaths?.length, 2, "candidates listed");

  // Doc-less package + standalone .md: mergeSkillCorpus rescues (slot 0 =
  // the standalone).
  if (ambiguous.ok) {
    const standalone = inspectBareMd("SKILL.md", Buffer.from(PROSE + " standalone."));
    assert.ok(standalone.ok);
    if (standalone.ok) {
      const rescued = mergeSkillCorpus(standalone, ambiguous);
      assert.equal(rescued[0].path, "SKILL.md", "standalone leads doc-less corpus");
    }
  }

  // ---- 2026-08-05 tolerance round: supporting names + front-matter ----
  // A Skill zipped with its architecture.md no longer dead-ends: the
  // supporting basename is set aside and the remaining candidate wins.
  const withArch = await inspectArchive(
    await zipOf({ "mytool.md": PROSE, "architecture.md": PROSE + " support." }),
    "skill"
  );
  assert.ok(withArch.ok && !withArch.docMissing, "architecture.md set aside");
  if (withArch.ok) assert.equal(withArch.docPath, "mytool.md");
  // ...but DEMOTED, never excluded: a package whose only document IS the
  // architecture doc still resolves to it, exactly as before this round.
  const archOnly = await inspectArchive(await zipOf({ "architecture.md": PROSE }), "skill");
  assert.ok(archOnly.ok && !archOnly.docMissing, "architecture-doc-only still resolves");
  if (archOnly.ok) assert.equal(archOnly.docPath, "architecture.md");
  // True boilerplate stays tier 1: readme-only resolves to nothing (the
  // pre-existing contract this round must not widen).
  const readmeOnly = await inspectArchive(await zipOf({ "readme.md": PROSE }), "skill");
  assert.ok(readmeOnly.ok && readmeOnly.docMissing === "missing", "readme-only still missing");

  // Front-matter tiebreak: several plausible docs, exactly one carrying the
  // Skill signature (name: + description: in the leading YAML block).
  const FM_DOC = `---\nname: Entra Analyzer\ndescription: Reviews Entra security posture.\n---\n\n${PROSE}`;
  assert.ok(hasSkillFrontmatter(FM_DOC), "signature detected");
  assert.ok(!hasSkillFrontmatter(PROSE), "plain prose has no signature");
  assert.ok(
    !hasSkillFrontmatter(`---\nauthor:\n  name: Jane\n  description: x\n---\n${PROSE}`),
    "nested keys never match (column-0 anchor)"
  );
  const fmTiebreak = await inspectArchive(
    await zipOf({ "entra.md": FM_DOC, "helper.md": PROSE + " helper." }),
    "skill"
  );
  assert.ok(fmTiebreak.ok && !fmTiebreak.docMissing, "front-matter tiebreak resolves");
  if (fmTiebreak.ok) assert.equal(fmTiebreak.docPath, "entra.md");
  // Two signatures stays ambiguous (selection, never authoring).
  const fmBoth = await inspectArchive(
    await zipOf({ "a-skill.md": FM_DOC, "b-skill.md": FM_DOC + " other." }),
    "skill"
  );
  assert.ok(fmBoth.ok && fmBoth.docMissing === "ambiguous", "two signatures stay ambiguous");

  // The wideners must NEVER pre-empt the inner-archive open: with a single
  // inner .skill present, an outer ambiguity still hands the decision inward,
  // so the package's real SKILL.md stays the reviewed doc (refutation-round
  // finding: widening here would silently review an outer guess instead, and
  // the inner doc would not even reach the evidence corpus).
  const wrapperWithOuterMds = await (async () => {
    const zip = new JSZip();
    zip.file("my-skill.skill", await zipOf({ "SKILL.md": PROSE + " inner." }));
    zip.file("mytool.md", PROSE + " outer.");
    zip.file("architecture.md", PROSE + " support.");
    return zip.generateAsync({ type: "nodebuffer" });
  })();
  const inner = await inspectArchive(wrapperWithOuterMds, "skill");
  assert.ok(inner.ok && !inner.docMissing, "wrapper still resolves");
  if (inner.ok)
    assert.equal(
      inner.docPath,
      "my-skill.skill!/SKILL.md",
      "inner SKILL.md still wins over a demoted outer candidate"
    );

  // ---- 2026-08-05 zip-inspection round: parse decides, not magic bytes ----
  assert.match(nonZipMessage(Buffer.from([0x1f, 0x8b, 0x08, 0x00])), /gzip/);
  assert.match(nonZipMessage(Buffer.from("Rar!\x1a\x07\x00")), /RAR/);
  assert.match(nonZipMessage(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])), /7-Zip/);
  assert.match(nonZipMessage(Buffer.from("PK\x03\x04 but truncated")), /truncated/);
  assert.match(nonZipMessage(Buffer.from("hello world")), /could not be read as a zip/);
  // Short buffers must not throw or misclassify (undefined byte comparisons).
  assert.match(nonZipMessage(Buffer.alloc(0)), /could not be read as a zip/);
  assert.match(nonZipMessage(Buffer.from([0x50])), /could not be read as a zip/);
  const gz = await inspectArchive(Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00]), "skill");
  assert.ok(!gz.ok && gz.code === "invalid_archive", "gzip rejects as invalid_archive");
  assert.match(gz.ok ? "" : gz.message, /gzip/, "gzip named in the rejection");
  // A real zip with prepended junk parses (JSZip reads the central directory
  // from the end); the old two-byte sniff wrongly rejected these.
  const prefixed = Buffer.concat([
    Buffer.from("JUNK-PREFIX-8-BYTES-LONG"),
    await zipOf({ "SKILL.md": PROSE }),
  ]);
  const prefixedOk = await inspectArchive(prefixed, "skill");
  assert.ok(prefixedOk.ok && !prefixedOk.docMissing, "junk-prefixed zip still inspected");

  // ---- disclosure gate helpers (2026-07-30 calibration round) ----
  assert.ok(isNoneFound("none found"));
  assert.ok(isNoneFound(' "None found." '));
  assert.ok(isNoneFound("None."));
  assert.ok(isNoneFound(""));
  assert.ok(!isNoneFound("Kaseya VSA9"));

  const corpus = "The tool reads exports from Kaseya VSA 9 and SentinelOne agents nightly.";
  assert.ok(
    quoteInCorpus("reads exports from Kaseya VSA 9 and SentinelOne", corpus),
    "real quote verifies"
  );
  assert.ok(
    quoteInCorpus("READS   exports from kaseya vsa 9 and sentinelone", corpus),
    "whitespace/case-insensitive"
  );
  assert.ok(!quoteInCorpus("Kaseya is our client", corpus), "invented quote fails");
  assert.ok(!quoteInCorpus("Kaseya", corpus), "too-short quote fails");

  const friendly = friendlyHeldReason(
    'disclosure checklist hit:\nclient_or_served_org_names (upheld after adjudication): "Acme Corp"'
  );
  assert.ok(
    friendly?.startsWith("Possible client or company names:"),
    `friendly label applied: ${friendly}`
  );
  assert.equal(
    friendlyHeldReason("lint failed after repair:\ntitle must be 4-60 characters"),
    "lint failed after repair:\ntitle must be 4-60 characters",
    "unrecognized format falls back to raw"
  );

  // ---- email intake parsers (§5.16 email path) ----
  assert.equal(titleFromSubject("Re: Fwd: RE:  Ticket Wizard  "), "Ticket Wizard");
  assert.equal(titleFromSubject("FW[2]: Ticket Wizard"), "Ticket Wizard");
  assert.equal(titleFromSubject("Ticket\r\nWizard"), "Ticket Wizard", "header injection collapsed");

  // Subject hygiene (2026-07-31): gateway bracket tags, copy counters,
  // zero-width characters. The BOM case pins the strip ORDER: ECMAScript \s
  // includes U+FEFF, so stripping after the sanitize \s+ collapse would
  // leave "Out age Checker".
  assert.equal(
    titleFromSubject("[EXTERNAL] Fwd: [xl-net] Outage Checker"),
    "Outage Checker"
  );
  assert.equal(titleFromSubject("Re: Ticket Wizard (2)"), "Ticket Wizard");
  assert.equal(
    titleFromSubject("Quarterly Report (2024)"),
    "Quarterly Report (2024)",
    "4-digit parenthetical is not a copy counter"
  );
  assert.equal(
    titleFromSubject("Legit (parenthetical) name"),
    "Legit (parenthetical) name"
  );
  assert.equal(
    titleFromSubject("Out\u{FEFF}age Checker"),
    "Outage Checker",
    "BOM stripped before the \\s+ collapse can turn it into a space"
  );
  assert.equal(titleFromSubject("Zero\u{200B}width Wizard"), "Zerowidth Wizard");

  // Category/kind prefix stripping (subject-derived titles only; authored
  // titles are rejected at their call sites using the raw regex).
  assert.equal(
    stripKindPrefix("Claude Skill: Slack Knowledge Assistant"),
    "Slack Knowledge Assistant"
  );
  assert.equal(stripKindPrefix("skill: outage-checker"), "outage-checker");
  assert.equal(stripKindPrefix("CoWork Skill - License Tracker"), "License Tracker");
  assert.equal(stripKindPrefix("Code program: TPS Count"), "TPS Count");
  assert.equal(
    stripKindPrefix("Claude Skill: Skill: Outage Checker"),
    "Outage Checker",
    "nested prefixes strip"
  );
  assert.equal(
    stripKindPrefix("Skill Builder Dashboard"),
    "Skill Builder Dashboard",
    "badge word without separator kept"
  );
  assert.equal(stripKindPrefix("Automation Station"), "Automation Station");
  assert.equal(
    stripKindPrefix("Autotask: CI Intake"),
    "Autotask: CI Intake",
    "non-badge lead word kept"
  );
  assert.ok(
    TITLE_KIND_PREFIX_RE.test("Claude Skill: X") &&
      !TITLE_KIND_PREFIX_RE.test("Autotask: CI Intake"),
    "raw regex backs the reject paths (form field, Title: body line)"
  );

  const body = parseSubmissionBody(
    [
      "Kind: CoWork Skill",
      "Credit: Adam",
      "",
      "This skill turns raw notes into tickets.",
      "It replaced manual triage.",
      "-- ",
      "Adam | XL.net | 555-1212",
    ].join("\r\n")
  );
  assert.equal(body.kind, "skill");
  assert.equal(body.credit, "Adam");
  assert.equal(body.kindRaw, null);
  assert.equal(
    body.blurb,
    "This skill turns raw notes into tickets.\nIt replaced manual triage.",
    "directives lifted, signature stripped"
  );

  const quoted = parseSubmissionBody(
    "The description.\nOn Tue, Jul 29, Tron Netter wrote:\n> older text\n> more"
  );
  assert.equal(quoted.blurb, "The description.", "quoted history stripped");
  const wrappedAttribution = parseSubmissionBody(
    "The description.\nOn Tue, Jul 29, 2026 at 3:14 PM Tron Netter\n<Tron.Netter@ai.xl.net> wrote:\n> older text"
  );
  assert.equal(
    wrappedAttribution.blurb,
    "The description.",
    "Gmail hard-wrapped attribution stripped"
  );
  assert.ok(
    parseSubmissionBody(
      "On Mondays the tool runs a sweep.\nMore of the description."
    ).blurb.startsWith("On Mondays"),
    "prose starting with On is kept"
  );
  assert.equal(
    parseSubmissionBody("Desc.\n> quoted first line style").blurb,
    "Desc.",
    "bare quote marker stops the body"
  );
  assert.equal(
    parseSubmissionBody("Kind: spreadsheet\nA description.").kindRaw,
    "spreadsheet",
    "unknown kind surfaced for the reply"
  );
  assert.equal(parseSubmissionBody("kind: code program\nx").kind, "program");
  assert.equal(
    parseSubmissionBody("-----Original Message-----\nFrom: someone@xl.net\nold").blurb,
    "",
    "outlook top-post separator stops the body"
  );
  assert.equal(
    parseSubmissionBody(
      "My description of the tool.\n\n---------- Forwarded message ---------\nFrom: Someone <x@xl.net>\nforwarded content"
    ).blurb,
    "My description of the tool.",
    "gmail forwarded-message marker stops the body"
  );

  // Title directive (owner report 2026-07-31: the first real forwarded
  // submission published under its subject, "skill to our work"; the body's
  // Gmail-bolded "*Skill Name: *Outage Checker" line must name the card).
  const named = parseSubmissionBody(
    [
      "I just created a skill in Claude Cowork. Please see its details below.",
      "",
      "*Skill Name: *Outage Checker",
      "",
      "*Description:* Outage Checker looks at all of your open tickets.",
      "",
      "*Relation to Role: *This helps reduce time spent troubleshooting.",
    ].join("\n")
  );
  assert.equal(named.title, "Outage Checker", "Gmail-bold Skill Name lifted");
  assert.ok(!named.blurb.includes("Skill Name"), "title line leaves the blurb");
  assert.ok(
    named.blurb.includes("*Description:*") &&
      named.blurb.includes("*Relation to Role: *"),
    "unrecognized labels stay in the blurb as prose"
  );
  assert.equal(
    parseSubmissionBody("Title: Ticket Wizard\nA description.").title,
    "Ticket Wizard",
    "plain Title line lifted"
  );
  assert.equal(
    parseSubmissionBody("A description with no name line.").title,
    null,
    "no directive = subject stays authoritative"
  );
  assert.equal(
    parseSubmissionBody("Title:\nA description.").title,
    null,
    "empty Title line ignored, not an empty title"
  );
  assert.equal(
    parseSubmissionBody("*Kind:* code program\nx").kind,
    "program",
    "bolded Kind still recognized"
  );
  // Signature collisions (critic findings 2026-07-31): a job-title line in
  // an uncut signature must not beat an explicit directive above it, and a
  // bare contact-block "Name:" line must not name the card at all.
  const signature = parseSubmissionBody(
    [
      "Skill Name: Outage Checker",
      "",
      "A fine description of the tool.",
      "",
      "Thanks,",
      "John Smith",
      "Title: Senior Systems Engineer",
      "XL.net",
    ].join("\n")
  );
  assert.equal(
    signature.title,
    "Outage Checker",
    "first title directive wins over a signature job-title line"
  );
  const contact = parseSubmissionBody("A description.\nName: Jane Doe");
  assert.equal(contact.title, null, "bare Name: is not a title label");
  assert.ok(
    contact.blurb.includes("Name: Jane Doe"),
    "contact-block line stays in the blurb"
  );
  // The assertion that keeps the prior critic's ruling alive as the rules
  // widen around it: the weak-candidate path added 2026-07-31 must not turn
  // this fixture into a card named after the sender. "A description." is a
  // non-salutation line before it, so the Name: line is out of heading
  // position and emits nothing.
  assert.equal(
    contact.titleCandidates.length,
    0,
    "bare Name: after prose emits no weak candidate either"
  );

  // ── Title resolution for humans (2026-07-31 owner directive) ──────
  // A real submission was rejected for having no subject while its body
  // opened "Name: Patching Visualizer". NOTE the honest limit of this file:
  // the inference prompt itself is untestable here, so every branch below can
  // be green while the model still returns low confidence on real informal
  // mail. The first genuinely subject-less inbound is the actual test.
  const incidentBody = [
    "Name: Patching Visualizer",
    "",
    "Created a skill for CS that solves a real Kaseya pain point.",
    "",
    "The problem: Kaseya doesn't produce a patch report you'd actually want to put in front of a client.",
    "",
    "The flow: Generate the 3 reports, run them through the skill, pull the finished one-pager.",
  ].join("\n");
  const incident = parseSubmissionBody(incidentBody);
  assert.deepEqual(
    incident.titleCandidates,
    [{ value: "Patching Visualizer", source: "name-line" }],
    "the incident body yields exactly one name-line candidate"
  );
  assert.equal(incident.title, null, "a weak candidate never sets the title");
  assert.ok(
    incident.blurb.includes("Name: Patching Visualizer"),
    "a weak name line is never lifted out of the blurb"
  );
  assert.deepEqual(
    parseSubmissionBody(
      "Hi Tron,\n\nName: Patching Visualizer\n\nCreated a skill for CS."
    ).titleCandidates,
    [{ value: "Patching Visualizer", source: "name-line" }],
    "a greeting does not push the name out of heading position"
  );
  assert.equal(
    parseSubmissionBody(
      "Name: Jane Doe\nTitle: Senior Systems Engineer\nEmail: jane@xl.net\nA description."
    ).titleCandidates.length,
    0,
    "a Name: inside a contact block emits no candidate"
  );
  assert.deepEqual(
    parseSubmissionBody(
      "Patching Visualizer\n\nCreated a skill for CS that solves a Kaseya pain point.\n"
    ).titleCandidates,
    [{ value: "Patching Visualizer", source: "first-line" }],
    "a bare heading line above the description is a first-line candidate"
  );
  assert.equal(
    parseSubmissionBody("Hi Tron,\n\nHere is a thing.").titleCandidates.length,
    0,
    "a greeting is not itself a candidate"
  );

  // The signature job-title bug the critics confirmed live: with no directive
  // above it, "Title: Senior Systems Engineer" in an uncut signature became
  // the card title. No existing assertion covered this shape.
  const jobTitle = parseSubmissionBody(
    [
      "A fine description of the tool.",
      "",
      "Thanks,",
      "John Smith",
      "Title: Senior Systems Engineer",
      "XL.net",
    ].join("\n")
  );
  assert.equal(
    jobTitle.title,
    null,
    "a bare Title: under a signature name line does not title the card"
  );
  assert.ok(
    jobTitle.blurb.includes("Title: Senior Systems Engineer"),
    "the suppressed job-title line stays in the blurb as prose"
  );

  // The suppressor must NEVER defeat the escape hatch noTitleMessage
  // advertises. Every fixture below is a legitimate top-of-body "Title:" that
  // an earlier draft of the contact-block rule silently dropped, which would
  // have republished the incident it was meant to fix (verification round).
  for (const [name, body] of [
    [
      "signature with a Phone: line under a one-line blurb",
      "Title: Patching Visualizer\n\nA fine description of the tool it is.\n\nAdam Radulovic\nSystems Engineer\nPhone: (312) 555-1212",
    ],
    [
      "adjacent Kind: and Company: lines",
      "Title: Patching Visualizer\nKind: CoWork Skill\nCompany: XL.net\n\nA fine description.",
    ],
    [
      "comma-less greeting directly above",
      "Hey Tron\n\nTitle: Patching Visualizer\n\nA fine description of the tool.",
    ],
    [
      "an ordinary header line above the directive",
      "New Work Submission\n\nTitle: Patching Visualizer\n\nA fine description of the tool it is.\n\nThanks,\nAdam",
    ],
  ] as const)
    assert.equal(
      parseSubmissionBody(body).title,
      "Patching Visualizer",
      `a legitimate top-of-body Title: survives: ${name}`
    );
  // ...while the signature job-title, which only ever appears AFTER content
  // and under a sign-off, still does not.
  assert.equal(
    parseSubmissionBody(
      "A fine description of the tool.\n\nRegards,\nJohn Smith\nTitle: Senior Systems Engineer\nXL.net"
    ).title,
    null,
    "a job title under a sign-off is still suppressed"
  );

  // A weak candidate must survive an ordinary signature: the 4-line lookahead
  // an earlier draft used reached past a short blurb into the sender's
  // signature and forced the free corroboration rung onto a brain call.
  assert.deepEqual(
    parseSubmissionBody(
      "Name: Patching Visualizer\n\nA fine description of the tool it is.\n\nAdam Radulovic\nXL.net\nPhone: (312) 555-1212"
    ).titleCandidates,
    [{ value: "Patching Visualizer", source: "name-line" }],
    "a signature does not suppress a heading-position name line"
  );

  // Placeholder subjects. Screening the RAW header alone left the bug live:
  // real forwards only reduce to the bare placeholder after titleFromSubject.
  const stripped = (s: string) => stripKindPrefix(titleFromSubject(s));
  for (const s of [
    "(no subject)",
    "no subject",
    "(none)",
    "(sin asunto)",
    "(kein Betreff)",
    "<no subject>",
    "(Untitled)",
    "无主题",
  ])
    assert.ok(isPlaceholderSubject(s), `placeholder recognized: ${s}`);
  for (const s of [
    "[EXTERNAL] (no subject)",
    "Fwd: (no subject)",
    "Re: (no subject)",
    "Fwd: [EXTERNAL] (no subject)",
    "[EXT] (none)",
  ])
    assert.ok(
      isPlaceholderSubject(stripped(s)),
      `placeholder recognized after transport strip: ${s}`
    );
  for (const s of [
    "Outage Checker",
    "(none) Outage Checker",
    "Note: no subject line here",
    "Test",
    "Fwd: Patching Visualizer",
  ])
    assert.ok(
      !isPlaceholderSubject(s) && !isPlaceholderSubject(stripped(s)),
      `real subject not treated as a placeholder: ${s}`
    );

  for (const bad of [
    "https://example.com/tool",
    "someone@xl.net",
    "Hi Tron",
    "Created a skill for CS that solves a real Kaseya pain point.",
    "one two three four five six seven",
    "patching-visualizer",
    "Skill: Patching Visualizer",
    "x".repeat(61),
    "Report 12345",
  ])
    assert.ok(!looksLikeAWorkName(bad), `shape gate rejects: ${bad}`);
  for (const good of ["Patching Visualizer", "Outage Checker", "Tech's Helper"])
    assert.ok(looksLikeAWorkName(good), `shape gate accepts: ${good}`);

  const senderTokens = senderIdentityTokens(
    "Adam Radulovic <adam.radulovic@xl.net>",
    "adam.radulovic@xl.net"
  );
  for (const own of ["Adam Radulovic", "Radulovic Adam", "Adam"])
    assert.ok(isSenderIdentity(own, senderTokens), `sender identity: ${own}`);
  assert.ok(
    !isSenderIdentity("Patching Visualizer", senderTokens),
    "a tool name is not the sender's identity"
  );

  // Corroboration. The front-matter scan is anchored so a nested
  // "author:\n  name: Jane Doe" never corroborates a person.
  const declared = docDeclaredNames(
    "---\nname: patching-visualizer\nauthor:\n  name: Jane Doe\n---\n\n# Patch Status One-Pager\n\nprose\n"
  );
  assert.deepEqual(declared, ["patching-visualizer", "Patch Status One-Pager"]);
  assert.ok(
    !declared.some((d) => nameKey(d) === nameKey("Jane Doe")),
    "a nested author name is not a declared doc name"
  );
  assert.ok(
    !docDeclaredNames("Some prose naming Jane Doe in passing.").length,
    "prose alone declares nothing"
  );
  assert.equal(
    nameKey("patching-visualizer"),
    nameKey("Patching Visualizer"),
    "slug and title compare equal"
  );
  assert.ok(
    archiveDeclaredNames("patching-visualizer.skill", [
      "patching-visualizer/SKILL.md",
      "patching-visualizer/assets/a.md",
    ]).some((d) => nameKey(d) === nameKey("Patching Visualizer")),
    "package filename and sole top-level directory corroborate"
  );

  // A model-proposed title. The model SELECTS, it never AUTHORS: every answer
  // must be a verbatim span of the submitter's own words, and nothing here
  // ever truncates (truncation is a silent rename, and renaming is
  // admin-only).
  const vOpts = { sourceText: incidentBody, senderTokens };
  assert.deepEqual(validateInferredTitle("Patching Visualizer", vOpts), {
    ok: true,
    title: "Patching Visualizer",
  });
  assert.deepEqual(
    validateInferredTitle("Patching Visualizer", {
      ...vOpts,
      sourceText: "the patching-visualizer skill builds it",
    }),
    { ok: true, title: "Patching Visualizer" },
    "grounding sees through a hyphen"
  );
  for (const [bad, reason] of [
    ["Kaseya Patch Reporter", "ungrounded"],
    ["Visual", "ungrounded"],
    ["x".repeat(61), "shape"],
    ["patching-visualizer", "shape"],
    ["Skill: Patching Visualizer", "shape"],
    ["<b>Patching</b>", "shape"],
    ["https://x.test/a", "shape"],
  ] as const)
    assert.deepEqual(
      validateInferredTitle(bad, vOpts),
      { ok: false, reason },
      `inferred title rejected (${reason}): ${bad}`
    );
  assert.deepEqual(
    validateInferredTitle("Always On Monitor", {
      ...vOpts,
      sourceText: "we call it Always On Monitor",
    }),
    { ok: false, reason: "house_rules" },
    "a banned frequency adverb is caught before it can become a held card"
  );
  assert.deepEqual(
    validateInferredTitle("Patch — Visualizer", {
      ...vOpts,
      sourceText: "we call it Patch — Visualizer",
    }),
    { ok: false, reason: "house_rules" },
    "an em dash never reaches a card title, even when it is grounded"
  );
  assert.deepEqual(
    validateInferredTitle("Adam Radulovic", {
      ...vOpts,
      sourceText: "Adam Radulovic wrote this",
    }),
    { ok: false, reason: "sender_identity" },
    "the sender's own name is never the card title"
  );
  // The corroborated rung shares this gate. It once did not, so a candidate
  // carrying an en dash (Word autocorrects " - " into " – ") corroborated
  // against the package slug, since nameKey collapses punctuation on both
  // sides; it reached the card, failed the publish lint, and the repair
  // prompt then let the MODEL rename it.
  assert.deepEqual(
    validateWeakTitle("Patch Manager – Pro", senderTokens),
    { ok: false, reason: "house_rules" },
    "an en dash is caught on the corroborated rung too"
  );
  assert.ok(
    nameKey("Patch Manager – Pro") === nameKey("patch-manager-pro"),
    "and it would otherwise have corroborated against the package slug"
  );
  // sanitizeHeaderValue runs on this path as well, so the exotic line
  // terminators JSON.stringify leaves unescaped downstream cannot survive.
  assert.deepEqual(
    validateWeakTitle("Patching Visualizer", senderTokens),
    { ok: true, title: "Patching Visualizer" },
    "U+2028 is collapsed before the title can reach a prompt"
  );
  assert.equal(
    parseSubmissionBody("Skill\u00A0Name: Outage Checker\nDesc.").title,
    "Outage Checker",
    "Gmail non-breaking space inside the label still matches"
  );

  // ---- machine-name echo (2026-08-04 incident) ----
  // The live card published as "Entra/M365 Security Analyzer
  // (entra-m365-security-analyzer)": 59 characters, inside the 60 band, so
  // the length gate passed it, and no other gate saw the trailing
  // parenthetical as the same name twice. nameKey equality is the proof of
  // redundancy.
  const incidentTitle =
    "Entra/M365 Security Analyzer (entra-m365-security-analyzer)";
  assert.ok(
    incidentTitle.length <= WORK_CAPS.titleMaxChars,
    "the incident string is inside the band; that is why it published"
  );
  assert.equal(
    stripMachineEcho(incidentTitle),
    "Entra/M365 Security Analyzer",
    "the incident string strips to its head"
  );
  assert.equal(stripMachineEcho("Outage Checker (outage-checker)"), "Outage Checker");
  assert.equal(
    stripMachineEcho("Patch O Matic (PATCH_O_MATIC)"),
    "Patch O Matic",
    "nameKey collapses case and underscores"
  );
  assert.equal(
    stripMachineEcho("Foo Tool (foo-tool) (foo-tool)"),
    "Foo Tool",
    "stacked echoes strip to a fixpoint"
  );
  assert.equal(
    stripMachineEcho("entra-analyzer (Entra Analyzer)"),
    "Entra Analyzer",
    "a slug-shaped head yields to the human-shaped parenthetical"
  );
  // Negatives, each pinned UNCHANGED: the strip must be provably lossless,
  // so only exact nameKey equality of a TRAILING parenthetical fires.
  for (const keep of [
    "Quarterly Report (2024)",
    "Legit (parenthetical) name",
    "Patch Tool (Windows)",
    "Tool (v2) (tool)", // non-trailing echo: documented residue
    "Foo (skill-foo)", // fused kind token defeats equality: documented residue
    "(no subject)",
    "!!! (???)", // empty-nameKey guard
    "Caf\u00E9 Tracker (cafe-tracker)", // nameKey does NOT fold diacritics: deliberate
  ])
    assert.equal(stripMachineEcho(keep), keep.trim(), `echo strip keeps: ${keep}`);
  assert.deepEqual(splitMachineEcho("Outage Checker (outage-checker)"), {
    head: "Outage Checker",
    inner: "outage-checker",
  });
  assert.equal(splitMachineEcho("Patch Tool (Windows)"), null);
  // Length guard (refutation finding 2026-08-04): lintCard runs string bans
  // on RAW model output before the band violation stops anything, so a
  // pathological stacked-echo string must return null instead of exhausting
  // the stack through the mutual recursion.
  const stacked = "a" + " (a)".repeat(5000);
  assert.equal(splitMachineEcho(stacked), null, "oversized input never recurses");
  assert.equal(stripMachineEcho(stacked), stacked, "oversized input unchanged");
  {
    const res = lintCard({ ...goodCard(), title: stacked }, ctx);
    assert.ok(!res.ok, "an oversized echo title still fails lint (on the band)");
  }
  // The full subject chain: hostile chars, then kind prefix and echo strip
  // interleaved to a fixpoint, whitespace last. Also pins the over-60
  // rescue: an echo subject beyond titleMaxChars resolves at the subject
  // rung with the submitter's own head instead of falling to a brain call.
  assert.deepEqual(
    resolveSubjectTitle('Skill: "Outage Checker (outage-checker)"'),
    { title: "Outage Checker", echoStripped: true },
    "hostile strip, then kind prefix, then echo"
  );
  assert.deepEqual(
    resolveSubjectTitle("Fwd: Endpoint Compliance Reporter (endpoint-compliance-reporter)"),
    { title: "Endpoint Compliance Reporter", echoStripped: true },
    "an over-60 echo subject is rescued into the band"
  );
  assert.deepEqual(
    resolveSubjectTitle("Re: Ticket Wizard"),
    { title: "Ticket Wizard", echoStripped: false },
    "echoStripped false when nothing fired"
  );
  assert.ok(
    !looksLikeAWorkName("Outage Checker (outage-checker)"),
    "weak candidates never carry an echo; the drop falls to the brain rung"
  );
  assert.deepEqual(
    validateWeakTitle("Outage Checker (outage-checker)", senderTokens),
    { ok: false, reason: "shape" },
    "the corroborated rung rejects the echo shape"
  );
  assert.deepEqual(
    validateInferredTitle("Patching Visualizer (patching-visualizer)", {
      ...vOpts,
      sourceText: "see Patching Visualizer (patching-visualizer) here",
    }),
    { ok: false, reason: "shape" },
    "a grounded echo is still rejected; the model may select the bare head"
  );

  // isFreshDate must accept Resend's JSON-quoted ISO Date header (2026-07-30
  // prod incident: literal quotes in the value parsed as NaN = every real
  // inbound dropped as stale_or_missing_date).
  const nowMs = Date.parse("2026-07-30T23:00:00.000Z");
  assert.ok(isFreshDate('"2026-07-30T22:19:47.000Z"', nowMs), "quoted ISO date accepted");
  assert.ok(isFreshDate("2026-07-30T22:19:47.000Z", nowMs), "bare ISO date accepted");
  assert.ok(isFreshDate("Wed, 30 Jul 2026 22:19:47 +0000", nowMs), "RFC 2822 date accepted");
  assert.ok(!isFreshDate('"2026-07-01T00:00:00.000Z"', nowMs), "stale date still fails");
  assert.ok(!isFreshDate('"not a date"', nowMs), "garbage still fails");

  const picked = pickAttachments([
    { id: "1", filename: "tool.skill", size: 10 },
    { id: "2", filename: "SKILL.md", size: 10 },
    { id: "3", filename: "logo.png", size: 10 },
    { id: "4", filename: null, size: 10 },
  ]);
  assert.equal(picked.archives.length, 1);
  assert.equal(picked.mds.length, 1);
  // Windows 8.3 short names from real forwards (2026-07-30 incident).
  assert.equal(
    pickAttachments([{ id: "1", filename: "SD-DAI~1.SKI", size: 10 }]).archives.length,
    1,
    "8.3-truncated .SKI recognized as the package"
  );

  // ---- kind inference (§5.16, owner directive 2026-08-28) ----
  // The ladder is the contract. Every rung gets a test, and every ORDER
  // inversion gets one (agent config over the extension, the hoisted
  // arch-doc names over the extension, scaffolding over the Skill-document
  // rungs), because the order is the part a later edit is most likely to
  // break by "simplifying".
  const sig = (
    packageName: string | null,
    paths: string[],
    texts: { path: string; text: string }[] = []
  ) => ({
    packageName,
    paths,
    // walkLevel's OWN collection rule (extract.ts INNER_ARCHIVE_EXT), not a
    // third regex invented for the tests: this array is only ever filled by
    // that walk, so a test helper that collects a wider set would pin rungs
    // against inputs the real pipeline can never produce.
    innerArchivePaths: paths.filter(
      (p) => /\.(skill|zip)$/i.test(p) && p.split("/").length - 1 <= 1
    ),
    texts,
  });
  const SKILL_FM = `---\nname: thing\ndescription: does a thing\n---\n\n${PROSE}`;

  // bare_document: no package at all
  assert.equal(classifyWorkKind(sig(null, [])).rule, "bare_document");
  assert.equal(classifyWorkKind(sig(null, [])).kind, "skill");

  // claude_code_project: agent configuration, CI. Above the extension rung on purpose.
  for (const p of [
    ".claude/settings.json",
    "wrapper/.claude/commands/go.md",
    ".claude-plugin/plugin.json",
    ".mcp.json",
    "proj/.mcp.json",
    ".github/workflows/ci.yml",
  ])
    assert.equal(
      classifyWorkKind(sig("tool.zip", [p, "SKILL.md"])).kind,
      "program",
      `${p} reads as a Claude Code project`
    );
  assert.equal(
    classifyWorkKind(sig("tool.skill", [".claude/settings.json", "SKILL.md"]))
      .rule,
    "claude_code_project",
    "ORDER: agent config outranks the .skill extension (the extension records how a file was exported, .claude records what it is)"
  );

  // skill_package: the package is a Skill export
  assert.equal(classifyWorkKind(sig("tool.skill", ["SKILL.md"])).rule, "skill_package");
  assert.equal(
    classifyWorkKind(sig("OUTAGE_1.SKI", ["SKILL.md"])).kind,
    "skill",
    "8.3-truncated .SKI is still a Skill package"
  );

  // ORDER: the unambiguous arch-doc names outrank the extension rung.
  // The real 2026-09-01 shape ("Slack Thread Archiver V3"): a .skill export
  // wrapping ARCHITECTURE.md + SKILL.md in one folder. The extension records
  // how the file was exported; an architecture doc at the package's own root
  // records what it is, and the program lane accepts the convicting file by
  // name (its prose floor still applies to the content, an accepted
  // residual).
  const archOverExt = classifyWorkKind(
    sig("slack-thread-archiver-v3.0.skill", [
      "slack-thread-archiver/ARCHITECTURE.md",
      "slack-thread-archiver/SKILL.md",
    ])
  );
  assert.equal(
    archOverExt.rule,
    "program_scaffolding",
    "ORDER: architecture.md at the package root outranks the .skill extension"
  );
  assert.equal(archOverExt.kind, "program");
  // Everything else in the scaffolding gather stays BELOW the extension on
  // purpose. A launcher or CLAUDE.md alone comes with no architecture doc
  // for the program lane to accept, so a program verdict would be a HARD 422
  // where the Skill lane's worst case is a soft doc-missing the standalone
  // upload can rescue; the looser "design"/"arch" doc names are ones a
  // genuine CoWork Skill can plausibly use for a design note beside its
  // SKILL.md, too weak to override an explicit Skill export. Unsure leans
  // Skill; every boundary is pinned.
  assert.equal(
    classifyWorkKind(sig("tool.skill", ["SKILL.md", "Run.cmd"])).rule,
    "skill_package",
    "a launcher-only .skill stays a Skill (no arch doc to hand the program lane)"
  );
  assert.equal(
    classifyWorkKind(sig("tool.skill", ["pkg/CLAUDE.md", "pkg/SKILL.md"])).rule,
    "skill_package",
    "a CLAUDE.md-only .skill stays a Skill for the same reason"
  );
  assert.equal(
    classifyWorkKind(sig("tool.skill", ["pkg/SKILL.md", "pkg/design.md"])).rule,
    "skill_package",
    "a root design.md does not override an explicit .skill export"
  );
  assert.equal(
    classifyWorkKind(sig("tool.zip", ["pkg/SKILL.md", "pkg/design.md"])).kind,
    "program",
    "the same design.md still convicts a .zip package exactly as before"
  );

  // program_scaffolding: the two placements straddling the extension rung
  for (const p of [
    "architecture.md",
    "proj/ARCHITECTURE.md",
    "design.md",
    "proj/CLAUDE.md",
    "package.json",
    "app/server/package.json",
    "requirements.txt",
    "proj/pyproject.toml",
    "Run.cmd",
    "app/start.bat",
  ])
    assert.equal(
      classifyWorkKind(sig("tool.zip", [p, "README.md"])).kind,
      "program",
      `${p} is program scaffolding`
    );
  // THE WRAPPER-FOLDER RULE. "Depth <= 1" read literally means "the root or
  // one folder down", and in a package with NO wrapper that makes every
  // first-level subdirectory count as the package's own root: a Skill's
  // references/design.md would then be read as its architecture document,
  // call the whole package a program, AND get resolved as the reviewed doc,
  // so the card would be written from a reference note. A wrapper is only a
  // wrapper when everything is inside it. Both shapes are pinned.
  assert.equal(
    classifyWorkKind(
      sig(
        "dr.zip",
        ["SKILL.md", "references/design.md", "references/checklist.md"],
        [{ path: "SKILL.md", text: SKILL_FM }]
      )
    ).rule,
    "skill_document",
    "no wrapper: references/design.md is not this package's architecture doc"
  );
  assert.equal(
    classifyWorkKind(
      sig(
        "dr.zip",
        ["pkg/SKILL.md", "pkg/references/design.md"],
        [{ path: "pkg/SKILL.md", text: SKILL_FM }]
      )
    ).rule,
    "skill_document",
    "one wrapper: a doc two folders down is not this package's own either"
  );
  assert.equal(
    classifyWorkKind(sig("p.zip", ["proj/ARCHITECTURE.md", "proj/main.py"]))
      .rule,
    "program_scaffolding",
    "one wrapper: a doc directly inside it IS this package's own"
  );

  // A Skill that ships helper scripts ships their dependency manifest with
  // them. Convicting it on requirements.txt while deliberately exempting the
  // scripts themselves was self-contradictory, so the manifest rung sits
  // BELOW the Skill-document rungs.
  assert.equal(
    classifyWorkKind(
      sig(
        "soql.zip",
        ["SKILL.md", "requirements.txt", "scripts/translate.py", "references/f.md"],
        [{ path: "SKILL.md", text: SKILL_FM }]
      )
    ).kind,
    "skill",
    "a Skill's helper-script dependencies do not make it a program"
  );
  assert.equal(
    classifyWorkKind(sig("a.zip", ["app/package.json", "app/src/i.js", "app/README.md"]))
      .rule,
    "program_dependencies",
    "a dependency manifest with no Skill document still decides"
  );

  // The Skill document is recognised by SIGNATURE, not only by filename:
  // extract.ts's own ladder resolves a Skill's doc by uniqueness and by this
  // same front matter, so a name-only test here would send packages it
  // happily accepts down the program lane to a hard refusal.
  assert.equal(
    classifyWorkKind(
      sig("soql.zip", ["soql-translator.md", "references/f.md"], [
        { path: "soql-translator.md", text: SKILL_FM },
      ])
    ).rule,
    "skill_document",
    "a Skill doc that is not named SKILL.md is still a Skill doc"
  );
  assert.equal(
    classifyWorkKind(sig("usage.zip", ["how-to-run-the-audit.md"])).rule,
    "sole_document",
    "one document and no code is the shape extract.ts accepts as a Skill"
  );
  assert.equal(
    classifyWorkKind(sig("w.zip", ["my-skill.zip", "my-skill-SKILL.md"])).kind,
    "skill",
    "a wrapper holding an inner .zip Skill keeps working (walkLevel collects .skill AND .zip)"
  );

  // ORDER: a program that CONTAINS a Skill is still a program. Containment
  // points one way only, which is exactly the mistake three production rows
  // recorded before this ladder existed.
  assert.equal(
    classifyWorkKind(
      sig(
        "tool.zip",
        ["proj/ARCHITECTURE.md", "proj/SKILL.md", "proj/inner.skill"],
        [{ path: "proj/SKILL.md", text: SKILL_FM }]
      )
    ).rule,
    "program_scaffolding",
    "ORDER: scaffolding outranks both the wrapped Skill and a signed SKILL.md"
  );

  // wrapped_skill_package: a wrapper zip whose payload is one packaged Skill
  assert.equal(
    classifyWorkKind(sig("files (2).zip", ["my.skill", "my-SKILL.md"])).rule,
    "wrapped_skill_package"
  );
  assert.equal(
    classifyWorkKind(sig("bundle.zip", ["a.skill", "b.skill"])).kind,
    "program",
    "two packaged Skills is a bundle, not a Skill"
  );

  // skill_document / skill_document_weak: the SKILL.md rungs, signed and unsigned
  const signed = classifyWorkKind(
    sig("t.zip", ["pkg/SKILL.md"], [{ path: "pkg/SKILL.md", text: SKILL_FM }])
  );
  assert.equal(signed.rule, "skill_document");
  const unsigned = classifyWorkKind(
    sig("t.zip", ["pkg/SKILL.md"], [{ path: "pkg/SKILL.md", text: PROSE }])
  );
  assert.equal(unsigned.rule, "skill_document_weak");
  assert.equal(unsigned.kind, "skill", "a file named SKILL.md is still the submitter's own statement");

  // program_source: source outside a helper directory, and the exemption that keeps
  // a real Skill (the SOQL translator on production) from being reclassified
  assert.equal(
    classifyWorkKind(sig("t.zip", ["notes.md", "runner.py"])).rule,
    "program_source"
  );
  assert.equal(
    classifyWorkKind(
      sig(
        "t.zip",
        ["pkg/SKILL.md", "pkg/references/o.md", "pkg/scripts/build.py"],
        [{ path: "pkg/SKILL.md", text: SKILL_FM }]
      )
    ).kind,
    "skill",
    "a Skill's helper scripts are not program source"
  );

  // The last rung. A single .md is now `sole_document` (extract.ts accepts
  // that shape as a Skill, so refusing it here would manufacture a 422), so
  // reaching `default_program` takes a package with no usable document at
  // all: several boilerplate-named files and nothing else.
  assert.equal(
    classifyWorkKind(sig("t.zip", ["notes.md"])).rule,
    "sole_document"
  );
  assert.equal(
    classifyWorkKind(sig("t.zip", ["README.md", "LICENSE.md"])).rule,
    "default_program"
  );
  // The one rung whose reading most needs to be arguable, so its sentence
  // must not be the broken "because it has no program scaffolding".
  const lastRung = kindVerdictSentence(
    classifyWorkKind(sig("t.zip", ["README.md", "LICENSE.md"]))
  );
  assert.match(lastRung, /because it carries neither/);
  assert.ok(!/because it has no/.test(lastRung), "no self-contradicting reason");

  // The two front-matter implementations must agree; classify.ts keeps its
  // own copy so the reclassification script can load it without jszip.
  for (const t of [SKILL_FM, PROSE, "---\nname: x\n---\n", ""])
    assert.equal(
      classifyFrontmatter(t),
      hasSkillFrontmatter(t),
      "classify.ts and extract.ts agree on the Skill front-matter signature"
    );

  // The sentence a submitter reads when an inferred kind is what refused them.
  const verdictSentence = kindVerdictSentence(
    classifyWorkKind(sig("t.zip", ["architecture.md", "package.json"]))
  );
  assert.match(verdictSentence, /Code program/);
  assert.match(verdictSentence, /architecture\.md/);
  assert.ok(!/[\u2014\u2013]/.test(verdictSentence), "no long dashes in submitter-facing copy");

  // ---- inspectArchive infers when the kind is null (§5.16) ----
  const inferredProgram = await inspectArchive(okZip, null, {
    packageName: "myproj.zip",
  });
  assert.ok(inferredProgram.ok && inferredProgram.kind === "program");
  if (inferredProgram.ok)
    assert.equal(inferredProgram.kindVerdict.rule, "program_scaffolding");

  const inferredSkill = await inspectArchive(
    await zipOf({ "myskill/SKILL.md": SKILL_FM }),
    null,
    { packageName: "myskill.skill" }
  );
  assert.ok(inferredSkill.ok && inferredSkill.kind === "skill");

  // A pinned kind still wins, and the verdict still reports the package, so
  // the update lane can see a disagreement without being ruled by it.
  const pinned = await inspectArchive(okZip, "skill", {
    packageName: "myproj.zip",
  });
  assert.ok(pinned.ok && pinned.kind === "skill", "an explicit kind pins");
  if (pinned.ok)
    assert.equal(
      pinned.kindVerdict.kind,
      "program",
      "the verdict still describes the package under a pin"
    );

  // The walk is unconditionally collectInner now. Assert that is inert: the
  // manifest, the corpus and the resolved doc of a program package must be
  // identical to what the old collectInner=false walk produced.
  const innerZip = await zipOf({
    "proj/architecture.md": PROSE,
    "proj/assets.zip": "PK-not-really",
    "proj/notes.md": "notes",
  });
  const withInner = await inspectArchive(innerZip, "program");
  assert.ok(withInner.ok, "a program package carrying a zip is unaffected");
  if (withInner.ok) {
    assert.equal(withInner.docPath, "proj/architecture.md");
    assert.equal(withInner.manifest.length, 3);
    assert.ok(
      !withInner.corpus.some((c) => c.path.includes("!/")),
      "the program lane never opens the inner archive"
    );
  }

  // The standalone-document rescue rests on ONE property of extract.ts, and
  // both routes and the email lane depend on it: the same bytes that
  // hard-fail as a program return ok-with-docMissing when the kind is pinned
  // to skill, carrying the manifest, corpus and hashes the ExtractErr does
  // not. If that ever stops holding, three rescue paths silently stop
  // rescuing, so it is pinned here rather than left to the callers.
  const noArchDoc = await zipOf({
    "app/package.json": '{"name":"x"}',
    "app/src/index.js": "console.log(1)",
    "app/README.md": "short readme",
  });
  const rescueFirst = await inspectArchive(noArchDoc, null, {
    packageName: "tool.zip",
  });
  assert.ok(
    !rescueFirst.ok && rescueFirst.code === "missing_architecture_doc",
    "a dependency manifest with no architecture doc is a program that refuses"
  );
  assert.equal(rescueFirst.ok ? "" : rescueFirst.kind, "program");
  const rescueSecond = await inspectArchive(noArchDoc, "skill", {
    packageName: "tool.zip",
  });
  assert.ok(
    rescueSecond.ok && rescueSecond.docMissing === "missing",
    "the same bytes pinned to skill yield a rescuable walk"
  );
  if (rescueSecond.ok) {
    assert.equal(rescueSecond.manifest.length, 3, "the rescue pass carries the manifest");
    assert.equal(rescueSecond.archiveSha256.length, 64);
  }
  // The rescue pass cleans on the same terms as the first pass. It used to
  // refuse here ("a rescue never launders an archive"); now nothing refuses
  // for carrying credentials on any pass, and the .env is simply gone from
  // what would be stored.
  const dirtyPkg = await zipOf({ "app/package.json": "{}", ".env": "SECRET=1" });
  for (const k of [null, "skill"] as const) {
    const r = await inspectArchive(dirtyPkg, k, { packageName: "t.zip" });
    assert.ok(r.ok || r.droppedPaths?.includes(".env"),
      "the rescue pass cleans, and any refusal still names what it removed");
    if (r.ok)
      assert.deepEqual(r.cleaning?.droppedPaths.map((d) => d.path), [".env"]);
  }

  // A bare .md carries the bare_document verdict, not a hand-written literal.
  const bareDoc = inspectBareMd("SKILL.md", Buffer.from(PROSE));
  assert.ok(bareDoc.ok && bareDoc.kind === "skill");
  if (bareDoc.ok) assert.equal(bareDoc.kindVerdict.rule, "bare_document");

  // inferKind is GONE (owner directive 2026-08-28). It answered from the
  // package FILENAME plus a "Kind:" line, and both halves were wrong: the
  // line outranked the files, and "a .md is attached" meant Skill, which
  // silently reclassified every Code program that mailed its architecture
  // document beside the zip. classify.ts reads the archive instead, and its
  // ladder is pinned below under "kind inference".

  // ── §5.16 admin-mediated updates: directive parsing (2026-08-03) ──

  // Strong labels lift the line out of the blurb; first match wins.
  for (const label of ["Update Card", "Updates Card", "Card Update", "Replace Card"]) {
    const p = parseSubmissionBody(`${label}: Outage Checker\n\n${PROSE}`);
    assert.equal(p.updateTarget, "Outage Checker", `${label}: recognized`);
    assert.ok(
      !p.blurb.includes("Outage Checker"),
      `${label}: line lifted out of the blurb`
    );
  }
  {
    const p = parseSubmissionBody(
      `Update Card: First Target\nUpdate Card: Second Target\n\n${PROSE}`
    );
    assert.equal(p.updateTarget, "First Target", "first update directive wins");
  }
  // Bare "Update:" is PROSE, never a directive (silent-conversion FATAL
  // class; same reasoning as bare "Name:").
  {
    const p = parseSubmissionBody(`Update: now handles PDFs too\n\n${PROSE}`);
    assert.equal(p.updateTarget, null, "bare Update: stays prose");
    assert.ok(
      p.blurb.includes("Update: now handles PDFs too"),
      "bare Update: line stays in the blurb"
    );
  }
  // A dangling label with no value never claims the submission.
  assert.equal(
    parseSubmissionBody(`Update Card:\n\n${PROSE}`).updateTarget,
    null,
    "empty Update Card: value ignored"
  );
  // Gmail bold markers around the label still match (DIRECTIVE_RE shape).
  assert.equal(
    parseSubmissionBody(`*Update Card: *Outage Checker\n\n${PROSE}`).updateTarget,
    "Outage Checker",
    "bolded update directive recognized"
  );

  // Subject rung: separator REQUIRED, so a card named "Update Broadcaster"
  // never matches; "Update:" and "Update - " forms do.
  const { UPDATE_SUBJECT_RE } = await import("../src/lib/work/email-parse");
  assert.ok(UPDATE_SUBJECT_RE.test("Update: Outage Checker"));
  assert.ok(UPDATE_SUBJECT_RE.test("Updates: Outage Checker"));
  assert.ok(UPDATE_SUBJECT_RE.test("Update - Outage Checker"));
  assert.ok(!UPDATE_SUBJECT_RE.test("Update Broadcaster"), "no separator, no match");
  assert.ok(!UPDATE_SUBJECT_RE.test("Outage Checker Update"), "suffix never matches");
  assert.equal(
    UPDATE_SUBJECT_RE.exec("Update: Outage Checker")?.[1],
    "Outage Checker"
  );
  // The rung runs on titleFromSubject output, so transport prefixes unwrap.
  assert.equal(
    UPDATE_SUBJECT_RE.exec(titleFromSubject("Fwd: Update: Outage Checker"))?.[1],
    "Outage Checker",
    "forwarded update subject still resolves"
  );

  // F2 subject-mismatch shape: padded nameKey containment lets descriptive
  // subjects through while a different tool's name fails containment.
  const contains = (subject: string, predTitle: string) =>
    ` ${nameKey(subject)} `.includes(` ${nameKey(predTitle)} `);
  assert.ok(
    contains("Outage Checker v2 update", "Outage Checker"),
    "descriptive subject naming the card passes"
  );
  assert.ok(
    contains("Update: Outage Checker", "Outage Checker"),
    "update-prefixed subject passes"
  );
  assert.ok(
    !contains("Patch Rollup Notifier", "Outage Checker"),
    "a different tool's subject fails containment"
  );

  // The held-update canned line replaces raw panel_error for submitters
  // (conflict-park notes carry admin-only instructions).
  const { statusView } = await import("../src/lib/work/view");
  const baseRow = {
    id: "00000000-0000-0000-0000-000000000001",
    userId: null,
    submitterEmail: "a@xl.net",
    creatorEmail: null as string | null,
    submitterName: null,
    kind: "skill",
    title: "T",
    blurb: "b",
    status: "held",
    architectureText: null,
    skillMdText: null,
    fileManifestJson: null,
    corpusFilesJson: null,
    archiveName: null,
    archiveSha256: null,
    archiveBytes: null,
    mdName: null,
    mdSha256: null,
    mdBytes: null,
    panelAttemptId: null,
    panelStartedAt: null,
    panelHeartbeatAt: null,
    panelRuns: 0,
    panelRunsDate: null,
    panelProgressJson: null,
    panelTranscriptJson: null,
    panelError: "update approval conflict: admin-only instructions here",
    cardJson: null,
    heldAt: new Date(),
    parentId: null as string | null,
    autoApprove: false,
    companyId: null as string | null,
    supersededAt: null,
    slug: null,
    publishedAt: null,
    displayRank: null as number | null,
    // Every column statusView() reads has to exist on this hand-written row
    // or the whole suite stops compiling; time_saved_minutes arrived with the
    // 2026-08-27 "Time saved per month" round and rides statusView like the
    // rest. null is the honest default: not reported.
    timeSavedMinutes: null as number | null,
    // §5.16 cleaning (2026-08-29): null means the stored artifact IS the
    // submitted one, which is the state of every row that predates the round.
    cleaningJson: null as string | null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  assert.ok(
    statusView({ ...baseRow }).heldReason?.includes("admin-only instructions"),
    "non-update held rows still surface the panel reason"
  );
  const updView = statusView({
    ...baseRow,
    parentId: "00000000-0000-0000-0000-000000000002",
  });
  assert.ok(
    updView.heldReason !== null &&
      !updView.heldReason.includes("admin-only instructions"),
    "held update rows get the canned line, never the raw panel_error"
  );
  assert.equal(updView.isUpdate, true, "statusView projects isUpdate");

  // §5.16 auto-approve projections: a conflict-parked update gets the
  // dead-end line (not "waiting on Adam"), and autoApprove reaches the
  // client only on update rows (drives poll liveness + the Publishing
  // badge).
  const { UPDATE_CONFLICT_NOTE } = await import("../src/lib/work/db");
  const conflictView = statusView({
    ...baseRow,
    parentId: "00000000-0000-0000-0000-000000000002",
    panelError: UPDATE_CONFLICT_NOTE,
  });
  assert.ok(
    conflictView.heldReason?.includes("no longer on /work"),
    "conflict-parked updates get the dead-end line"
  );
  assert.ok(
    !conflictView.heldReason?.includes("waiting on Adam"),
    "conflict park is not described as a wait"
  );
  const autoView = statusView({
    ...baseRow,
    status: "pending_approval",
    parentId: "00000000-0000-0000-0000-000000000002",
    autoApprove: true,
    heldAt: null,
  });
  assert.equal(autoView.autoApprove, true, "autoApprove projected on updates");
  assert.equal(
    statusView({ ...baseRow, autoApprove: true, heldAt: null }).autoApprove,
    false,
    "autoApprove never projects on a non-update row"
  );
  assert.equal(
    statusView({
      ...baseRow,
      status: "pending_approval",
      parentId: "00000000-0000-0000-0000-000000000002",
      autoApprove: true,
    }).autoApprove,
    false,
    "a once-held auto row never shows Publishing (heldAt one-shot, refutation MAJOR)"
  );

  // §5.16 verifiedWebAdmin: the auto-approve stamp predicate is strictly
  // AND over admin + a VERIFIED staff provider + exact-label domain. Google
  // needs no mv (Workspace anchor); Microsoft needs the per-login mv claim,
  // because the mv-less common-tenant lane can forge isAdmin-passing
  // sessions (Microsoft parity round 2026-08-09).
  const { verifiedWebAdmin } = await import("../src/lib/work/http");
  const webAdmin = {
    userId: "u",
    email: "someone@xl.net",
    emailDomain: "xl.net",
    provider: "google",
    mv: false,
    admin: true,
  };
  assert.equal(
    verifiedWebAdmin(webAdmin),
    true,
    "google admin on xl.net stamps with mv false (Workspace anchor, never tightened)"
  );
  assert.equal(
    verifiedWebAdmin({ ...webAdmin, provider: "microsoft" }),
    false,
    "microsoft session WITHOUT mv never stamps (nOAuth forgery)"
  );
  assert.equal(
    verifiedWebAdmin({ ...webAdmin, provider: "microsoft", mv: true }),
    true,
    "microsoft admin WITH mv stamps (parity)"
  );
  assert.equal(
    verifiedWebAdmin({ ...webAdmin, provider: "microsoft", mv: true, email: "a@evil.com", emailDomain: "evil.com" }),
    false,
    "verified microsoft on a foreign domain never stamps"
  );
  assert.equal(
    verifiedWebAdmin({ ...webAdmin, admin: false }),
    false,
    "non-admin never stamps"
  );
  assert.equal(
    verifiedWebAdmin({ ...webAdmin, email: "a@xl.net@evil.com" }),
    false,
    "double-@ address never stamps (exact-label parse)"
  );
  assert.equal(
    verifiedWebAdmin({ ...webAdmin, email: "tron.netter@ai.xl.net" }),
    false,
    "subdomain never stamps"
  );

  // ── §5.16 natural-email round (2026-08-03): signature + softened gates ──

  const { tronSignature } = await import("../src/lib/tron-signature");
  const { readFileSync } = await import("node:fs");
  const { createHash: mkHash } = await import("node:crypto");

  // 1. The mirror's exact output for THIS site's config, pinned verbatim.
  //    Drift in host config or the mirror fails here.
  assert.equal(
    tronSignature(),
    [
      "Tron Netter",
      "AI Agent, XL.net AI",
      "Tron.Netter@ai.xl.net",
      "(872) 350-4325 · Call or Text",
      "https://ai.xl.net",
      "I remember our conversations so I can pick up where we left off - details & removal: https://ai.xl.net/privacy",
    ].join("\n"),
    "tronSignature renders the module-canonical block for this config"
  );
  // 2. Module-side drift detector: the mirror copies the UNEXPORTED
  //    signatureBlock() in the submodule; if that function's source changes
  //    on an @aicompany/core upgrade, this hash fails and the mirror must be
  //    re-synced (then re-pin the hash).
  {
    const modSrc = readFileSync(
      "packages/aicompany/src/channels/email-inbound.ts",
      "utf8"
    );
    const start = modSrc.indexOf("function signatureBlock");
    const end = modSrc.indexOf("\n}", start) + 2;
    assert.ok(start > 0, "module signatureBlock found");
    assert.equal(
      mkHash("sha256").update(modSrc.slice(start, end)).digest("hex"),
      "22f72dfc25ff33a3fcadb582a7424b911193fc9a941377a5e0ccb5879fecdcf4",
      "module signatureBlock changed: re-sync src/lib/tron-signature.ts, then re-pin this hash"
    );
  }
  // 3. No em/en dash in the signature or the form pointer.
  const { FORM_POINTER, fuzzyKind, pickSkillDoc, CREDIT_RE } = await import(
    "../src/lib/work/email-parse"
  );
  const { withTronSignature, TRON_FROM } = await import(
    "../src/lib/tron-signature"
  );
  for (const s of [tronSignature(), TRON_FROM, FORM_POINTER])
    assert.ok(!/—|–/.test(s), "no em or en dash in outbound constants");

  // ── §5.16 one-persona round (2026-08-06, owner: "there should be NO
  // Troy"; supersedes the same-day two-persona signature round) ──
  // TRON_FROM is the single outbound identity for every host-composed
  // email, derived in tron-signature.ts from the same config fields the
  // signature block renders, and equal to oversight.mailFrom.
  const cfgTop = (await import("../site.config")).siteConfig;
  assert.equal(
    TRON_FROM,
    "Tron Netter <Tron.Netter@ai.xl.net>",
    "TRON_FROM is the single outbound identity for host-composed mail"
  );
  assert.equal(
    TRON_FROM,
    `${cfgTop.persona.name} <${cfgTop.channels.email.mailbox}>`,
    "TRON_FROM is derived from siteConfig, not a drifting literal"
  );
  assert.ok(
    tronSignature().includes(cfgTop.channels.email.mailbox),
    "the signature names the mailbox on the From line"
  );
  // Wrapper behavior: append, idempotence, trailing-whitespace
  // normalization. The idempotence leg is the byte-stability proof for the
  // intake replies that carried per-site signatures before the seam change:
  // wrapping an already-signed body is a no-op.
  {
    const sig = tronSignature();
    const wrap = withTronSignature;
    assert.equal(wrap("Body."), `Body.\n\n${sig}`, "wrapper appends");
    assert.equal(wrap(wrap("Body.")), wrap("Body."), "wrapper is idempotent");
    assert.equal(
      wrap("Body.\n\n"),
      wrap("Body."),
      "wrapper normalizes trailing whitespace"
    );
    assert.equal(
      wrap(`Body.\n\n${sig}`),
      `Body.\n\n${sig}`,
      "an already-signed body is unchanged"
    );
  }
  // Seam wiring pins (source scrape, the technique the module-sha pin above
  // already uses; a runtime probe would need a network seam because both
  // senders early-return before composing when RESEND_API_KEY is unset).
  // These fail LOUD on refactor: re-wire the seam, then fix the assertion.
  {
    const budgetSrc = readFileSync("src/lib/governance/budget.ts", "utf8");
    assert.ok(
      /text:\s*withTronSignature\(opts\.text\)/.test(budgetSrc),
      "sendGovernanceEmail signs every governance send at the seam"
    );
    assert.ok(
      /from:\s*TRON_FROM/.test(budgetSrc),
      "sendGovernanceEmail sends from the shared TRON_FROM"
    );
    const intakeSrc = readFileSync("src/lib/work/email-intake.ts", "utf8");
    assert.ok(
      /text:\s*withTronSignature\(text\)/.test(intakeSrc),
      "sendTronEmail signs every Tron send at the seam (covers warnAdmin)"
    );
    assert.ok(
      /from:\s*TRON_FROM/.test(intakeSrc),
      "sendTronEmail sends from the shared TRON_FROM"
    );
    assert.ok(
      !intakeSrc.includes("${tronSignature()"),
      "no per-site signature appends remain in email-intake (seam only)"
    );
    const notifySrc = readFileSync("src/lib/work/notify.ts", "utf8");
    const retStart = notifySrc.indexOf("function sendArchiveRetentionEmail");
    const retSlice = notifySrc.slice(
      retStart,
      notifySrc.indexOf("export async function deliverArchiveRetention")
    );
    assert.ok(retStart > 0, "sendArchiveRetentionEmail found");
    assert.ok(
      retSlice.includes("withTronSignature("),
      "the retention raw-fetch send (bypasses sendGovernanceEmail) signs as Tron"
    );
    assert.ok(
      retSlice.includes("from: TRON_FROM"),
      "the retention raw-fetch send uses the shared TRON_FROM"
    );
    // Mail-safe armor (2026-08-06 ContentRejected round): Gmail bounces
    // archives with blocked inner types, so raw upload bytes must never be
    // attached directly again. Since the 100 MB round the encoder runs
    // per-item inside the attach loop (omitted files skip it entirely).
    assert.ok(
      /prepared: toDeliverableAttachment\(file\)/.test(retSlice),
      "retention attachments go through the mail-safe encoder"
    );
    assert.ok(
      retSlice.includes("await screenPackageForMail("),
      "the package is screened against the provider's blocked-type policy first"
    );
    assert.ok(
      !/attachments:\s*files\.map/.test(retSlice) &&
        !retSlice.includes("f.data.toString"),
      "raw upload bytes are never attached directly"
    );
    // The screen may only ever REPLACE a package with a screened copy or
    // return the original: an "attach nothing" branch would turn a bounce
    // (an alarm) into a silent loss.
    const screenSrc = readFileSync("src/lib/work/mail-screen.ts", "utf8");
    assert.ok(
      !/kind:\s*"none"/.test(screenSrc),
      "no failure path attaches nothing; every degrade returns the original"
    );
    assert.equal(
      (screenSrc.match(/kind: "original"/g) ?? []).length >= 5,
      true,
      "every failure branch returns the original"
    );
    assert.ok(
      screenSrc.includes("mailSafePath(e.name)"),
      "entry paths are sanitized before they reach owner-facing copy"
    );
    // The word "original" may never describe a screened copy: the first
    // live screened send called it "the original upload" (caught 2026-08-06
    // by reading the delivered mail, not by a test).
    assert.ok(
      retSlice.includes("base64 text encoding a SCREENED COPY of the upload"),
      "a screened attachment is never described as the original"
    );
    assert.ok(
      !/encoded original on macOS/.test(retSlice),
      "the decode heading says attachment, not original"
    );
    assert.ok(
      retSlice.includes('openssl base64 -d -in "'),
      "the body carries the openssl decode one-liner (BSD/macOS base64 rejects --decode; openssl works on both)"
    );
    const warnStart = notifySrc.indexOf(
      "export async function deliverArchiveRetention"
    );
    const warnSlice = notifySrc.slice(
      warnStart,
      notifySrc.indexOf("export async function notifyPublished")
    );
    assert.ok(
      warnSlice.includes("withTronSignature("),
      "the retention-failure WARN (module sendEmail, From = oversight.mailFrom = Tron) signs as Tron"
    );
    const roadmapSrc = readFileSync("src/lib/roadmap/notify.ts", "utf8");
    assert.ok(
      /text:\s*withTronSignature\(opts\.text\)/.test(roadmapSrc),
      "sendRoadmapEmail signs every roadmap send at the seam"
    );
    const govScriptSrc = readFileSync(
      "scripts/governance-standards-refresh.ts",
      "utf8"
    );
    assert.ok(
      govScriptSrc.includes("${body.trimEnd()}\\n\\n${SIGNATURE}"),
      "the nightly governance script signs its reports/WARNs at its seam"
    );
    // Single-identity coherence: the module's own sends (oversight.mailFrom)
    // and every host raw sender resolve to the same From string.
    assert.equal(
      cfgTop.oversight.mailFrom,
      TRON_FROM,
      "oversight.mailFrom is the same single outbound identity as TRON_FROM"
    );
    // email-intake and roadmap import the shared constant instead of
    // re-declaring the identity literal.
    assert.ok(
      /TRON_FROM[^}]*\}\s*from\s*"@\/lib\/tron-signature"/.test(intakeSrc),
      "email-intake imports the shared TRON_FROM instead of re-declaring it"
    );
    assert.ok(
      !/const TRON_FROM\s*=/.test(intakeSrc) &&
        !/const TRON_FROM\s*=/.test(roadmapSrc),
      "no file re-declares the outbound identity literal"
    );
  }

  // ── No Troy anywhere (owner directive 2026-08-06: "there should be NO
  // Troy"). A whole-repo scan is unusable ("destroy" contains the
  // substring), so hits are stripped first. This is the CLOSED set of files
  // that composed or routed the retired persona's mail; a NEW outbound lane
  // must be added here. site.config.ts is the ONE permitted mention: the
  // retired mailbox stays aliased (additionalMailboxes + the onInbound
  // approval list) so replies to pre-retirement threads are answered, and
  // those literals sunset together (review 2026-11-06). ──
  {
    const troyFree = [
      "src/lib/tron-signature.ts",
      "src/lib/governance/budget.ts",
      "src/lib/governance/approval.ts",
      "src/lib/governance/approval-inbound.ts",
      "src/lib/governance/config.ts",
      "src/lib/work/notify.ts",
      "src/lib/work/email-intake.ts",
      "src/lib/roadmap/notify.ts",
      "src/lib/report-issue.ts",
      "src/app/api/webhooks/resend/route.ts",
      "src/app/api/work/submissions/[id]/route.ts",
      "scripts/governance-standards-refresh.ts",
      "deploy/verify-governance.sh",
      ".env.example",
    ];
    const deDestroy = (x: string) => x.replace(/destroy(s|ed|ing)?/gi, "");
    for (const f of troyFree)
      assert.ok(
        !/troy/i.test(deDestroy(readFileSync(f, "utf8"))),
        `${f} still names Troy (persona retired 2026-08-06)`
      );
    const cfgLines = deDestroy(readFileSync("site.config.ts", "utf8"))
      .split("\n")
      .filter((l) => /troy/i.test(l));
    assert.ok(
      cfgLines.length > 0,
      "the retired-mailbox alias is still configured"
    );
    assert.ok(
      cfgLines.every(
        (l) => /troy\.netter@ai\.xl\.net/i.test(l) || /^\s*(\/\/|\*)/.test(l)
      ),
      "site.config may name Troy only as the retired-mailbox alias and its comments"
    );
  }

  // ── §5.12 approval routing (2026-08-06 refit): commands at the persona
  // mailbox, nothing dropped. Pure decision + source-shape pins. ──
  {
    const { parseApprovalCommands, probeApprovalMail } = await import(
      "../src/lib/governance/approval"
    );
    assert.equal(
      parseApprovalCommands("SET GLOBAL BRAIN 2000").commands.length,
      1,
      "a command line parses"
    );
    assert.equal(
      parseApprovalCommands("Hi Tron, can you resend that deck?").commands
        .length,
      0,
      "ordinary prose carries no command, so it reaches the conversational path"
    );
    assert.equal(
      probeApprovalMail("SET GLOBAL BRAIN 2000", null),
      "text_commands"
    );
    assert.equal(probeApprovalMail("please and thanks", null), "none");
    assert.equal(probeApprovalMail(null, null), "none");
    assert.equal(
      probeApprovalMail(null, "<p>SET GLOBAL BRAIN 2000</p>"),
      "html_only_commands",
      "an HTML-only command is detected but never applied"
    );
    assert.equal(
      probeApprovalMail(
        "> SET GLOBAL BRAIN 2000",
        "<blockquote>SET GLOBAL BRAIN 2000</blockquote>"
      ),
      "none",
      "a command quoted in BOTH parts is thread history, not a command: it must reach the conversational path (an admin's ordinary reply quotes the whole earlier thread)"
    );
    assert.equal(
      probeApprovalMail(
        null,
        "<p>SET GLOBAL BRAIN 2000</p><blockquote>SET GLOBAL TAVILY 5</blockquote>"
      ),
      "html_only_commands",
      "a fresh HTML command above the quoted history is still detected"
    );
    assert.equal(
      probeApprovalMail(
        null,
        "<div>-----Original Message-----</div><div>SET GLOBAL BRAIN 2000</div>"
      ),
      "none",
      "Outlook's divider line stops the HTML projection like the text parser"
    );
    const apSrc = readFileSync(
      "src/lib/governance/approval-inbound.ts",
      "utf8"
    );
    assert.ok(
      /Promise<"handled" \| "delegate">/.test(apSrc),
      "the approval handler is a probe that can hand mail back to the conversational path"
    );
    const cfgSrc = readFileSync("site.config.ts", "utf8");
    assert.ok(
      !/void\s+handle(Approval|Troy)Inbound/.test(cfgSrc),
      "the approval probe is AWAITED: its verdict decides handled vs delegate"
    );
    assert.ok(
      !cfgSrc.includes('envelopeRecipients.length === 1 ? "handled"'),
      "the sole-recipient handled shortcut is gone (it silently dropped non-command mail)"
    );
    // One-const coupling: mailbox, additionalMailboxes and the approval
    // gate all derive from PERSONA_MAILBOXES, so a rename or the alias
    // sunset cannot silently disable command routing.
    assert.ok(
      /mailbox:\s*PERSONA_MAILBOXES\[0\]/.test(cfgSrc) &&
        /additionalMailboxes:\s*PERSONA_MAILBOXES\.slice\(1\)/.test(cfgSrc) &&
        /PERSONA_MAILBOXES\.map\(\(a\) => a\.toLowerCase\(\)\)/.test(cfgSrc),
      "mailbox, additionalMailboxes and the approval gate share PERSONA_MAILBOXES"
    );
    assert.equal(
      cfgTop.channels.email.mailbox,
      "Tron.Netter@ai.xl.net",
      "the persona mailbox is Tron's"
    );
    assert.ok(
      apSrc.includes("gov_msg_"),
      "approval dedupe keys use the gov_msg_ prefix"
    );
    const pruneSrc = readFileSync(
      "scripts/governance-standards-refresh.ts",
      "utf8"
    );
    assert.ok(
      pruneSrc.includes('deleteMetaByPrefixOlderThan("gov_msg_"'),
      "the nightly pruner prunes the SAME prefix the handler writes"
    );
  }

  // Retention attachment armor (2026-08-06 ContentRejected round): archives
  // become base64 text the mail provider will not unpack; text files pass
  // through untouched; the round trip is byte-exact so the emailed copy
  // still hashes to the row's stored SHA-256.
  {
    const zipBytes = await zipOf({
      "tool/SKILL.md": PROSE,
      "tool/scripts/export.ps1": "Write-Host 'hello'\n",
    });
    for (const name of ["pkg.zip", "pkg.skill", "OUTAGE_1.SKI", "run.ps1"]) {
      const spec = toDeliverableAttachment({ name, data: zipBytes });
      assert.equal(spec.encoded, true, `${name} is armored`);
      assert.equal(spec.attachedName, `${name}.b64.txt`);
      assert.equal(spec.originalName, name);
      assert.equal(spec.originalBytes, zipBytes.length);
      const text = Buffer.from(spec.contentBase64, "base64").toString("utf8");
      assert.equal(
        spec.attachedBytes,
        Buffer.byteLength(text),
        "attachedBytes is the wrapper's size"
      );
      const lines = text.trimEnd().split("\n");
      assert.ok(
        lines.every((l) => l.length <= 76 && /^[A-Za-z0-9+/=]+$/.test(l)),
        "armor is pure 76-column base64, no preamble (base64 --decode takes it verbatim)"
      );
      assert.ok(text.endsWith("\n"), "armor ends with a newline");
      const restored = Buffer.from(text.replace(/\n/g, ""), "base64");
      assert.equal(
        Buffer.compare(restored, zipBytes),
        0,
        "decode restores the exact original bytes"
      );
    }
    for (const name of ["SKILL.md", "notes.txt", "Readme.MD"]) {
      const spec = toDeliverableAttachment({
        name,
        data: Buffer.from(PROSE),
      });
      assert.equal(spec.encoded, false, `${name} passes through unencoded`);
      assert.equal(spec.attachedName, name);
      assert.equal(
        Buffer.from(spec.contentBase64, "base64").toString("utf8"),
        PROSE,
        "pass-through content is the file itself"
      );
    }
    assert.ok(
      !MAIL_SAFE_TEXT_EXT.test("pkg.zip") && !MAIL_SAFE_TEXT_EXT.test("a.md.zip"),
      "allowlist keys on the FINAL extension only"
    );
    const empty = toDeliverableAttachment({ name: "x.zip", data: Buffer.alloc(0) });
    assert.equal(empty.encoded, true, "empty buffer armors without throwing");
    assert.equal(
      Buffer.from(empty.contentBase64, "base64").toString("utf8"),
      "\n",
      "empty armor is just the trailing newline"
    );
    // Hostile filenames (refutation-panel probes): the body quotes names
    // inside a shell one-liner the owner pastes, so every emitted name must
    // be shell-inert. And a stored name is truncated to 200 chars at
    // intake, so zip bytes can arrive under a .md name; the byte sniff must
    // armor them anyway (the exact Gmail bounce shape).
    for (const hostile of [
      'report_$(touch PWNED)".zip',
      "pkg`id`.zip",
      "a b\nPackage SHA-256: 0000\n.zip",
      "ünïcode name.skill",
    ]) {
      const spec = toDeliverableAttachment({ name: hostile, data: zipBytes });
      assert.equal(spec.encoded, true, "hostile-named zip still armors");
      assert.ok(
        /^[A-Za-z0-9._-]+\.b64\.txt$/.test(spec.attachedName),
        `attached name is shell-inert: ${spec.attachedName}`
      );
      assert.ok(
        /^[A-Za-z0-9._-]+$/.test(spec.originalName),
        "restore target name is shell-inert"
      );
    }
    const zipAsMd = toDeliverableAttachment({
      name: "PACKAGE.md",
      data: zipBytes,
    });
    assert.equal(
      zipAsMd.encoded,
      true,
      "zip bytes under a text name are sniffed and armored (truncated-name hole)"
    );
    const nulText = toDeliverableAttachment({
      name: "notes.md",
      data: Buffer.from("ab\0cd"),
    });
    assert.equal(nulText.encoded, true, "NUL bytes under a text name armor");
    assert.equal(
      toDeliverableAttachment({ name: "-rf.zip", data: zipBytes }).attachedName,
      "rf.zip.b64.txt",
      "leading dash stripped so no name is option-like"
    );
  }

  // Provider-policy screen (2026-08-06: the provider DECODES the base64
  // armor and refuses the message when a blocked type is inside; the same
  // package without its .ps1/.sh delivered). Blocklist, never allowlist:
  // anything the policy does not name must survive into the copy.
  {
    assert.equal(finalExt("a/b/script.PS1"), "ps1", "final ext lowercased");
    assert.equal(finalExt("a/.gitignore"), "", "dotfile has no extension");
    assert.equal(finalExt("Makefile"), "", "extensionless name");
    assert.equal(blockedByName("scripts/x.ps1"), "blocked_type");
    assert.equal(blockedByName("scripts/x.sh"), "blocked_type_precaution");
    assert.equal(blockedByName("bundle.tar.gz"), "unscreenable_container");
    for (const keep of ["main.py", "q.sql", "app.go", "index.html", "a.md", "s.css", "r.rb"]) {
      assert.equal(
        blockedByName(keep),
        null,
        `${keep} is not on the provider list and must survive the screen`
      );
    }
    assert.ok(
      !PRECAUTION_BLOCKED_EXT.has("py") && !GMAIL_BLOCKED_EXT.has("py"),
      "python is deliberately never withheld"
    );
    assert.equal(blockedByBytes(Buffer.from("#!/bin/sh\necho hi")), "executable_content");
    assert.equal(blockedByBytes(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02])), "executable_content");
    assert.equal(blockedByBytes(Buffer.from("# Notes\n\nplain markdown")), null);
    assert.equal(mailSafePath('a b/"$(id)".md'), "a_b/_id_.md", "entry paths are shell-inert");
    assert.equal(mailSafePath("x\ny.md"), "x_y.md", "newlines cannot forge body lines");

    // A clean package is returned untouched: the screen may never reduce
    // what today's code sends.
    const clean = await zipOf({ "tool/SKILL.md": PROSE, "tool/q.sql": "select 1" });
    assert.equal(
      (await screenPackageForMail("tool.zip", clean, null)).kind,
      "original",
      "no blocked entries means the original is sent"
    );
    // The incident shape: a package carrying scripts.
    const dirty = await zipOf({
      "tool/SKILL.md": PROSE,
      "tool/references/objects.md": PROSE,
      "tool/scripts/export.ps1": "Write-Host 'x'\n",
      "tool/scripts/export.sh": "echo x\n",
    });
    const res = await screenPackageForMail("tool.zip", dirty, "abc123");
    assert.equal(res.kind, "screened", "blocked entries produce a screened copy");
    if (res.kind === "screened") {
      assert.equal(res.removed.length, 2, "both scripts removed");
      assert.equal(res.kept, 2, "both docs kept");
      assert.equal(res.total, 4);
      assert.ok(/^[0-9a-f]{64}$/.test(res.sha256), "screened sha is a full hash");
      const back = await JSZip.loadAsync(res.zip);
      const names = Object.keys(back.files).filter((n) => !back.files[n].dir);
      assert.ok(
        names.includes("tool/SKILL.md") && names.includes("tool/references/objects.md"),
        "kept entries survive byte-for-byte paths"
      );
      assert.ok(
        !names.some((n) => n.endsWith(".ps1") || n.endsWith(".sh")),
        "no blocked entry rides the screened copy"
      );
      assert.ok(
        names.includes("_SCREENED-COPY-README.txt"),
        "the artifact carries its own not-the-original statement"
      );
      const readme = await back.file("_SCREENED-COPY-README.txt")!.async("string");
      assert.ok(
        readme.startsWith("THIS IS NOT THE ORIGINAL PACKAGE."),
        "README leads with the disclaimer"
      );
      assert.ok(readme.includes("export.ps1") && readme.includes("export.sh"));
      assert.ok(!readme.includes("—"), "no em dashes in owner-facing copy");
      const kept = await back.file("tool/SKILL.md")!.async("string");
      assert.equal(kept, PROSE, "kept entry bytes are unmodified");
    }
    // Every failure path returns the original, never zero bytes.
    assert.equal(
      (await screenPackageForMail("x.zip", Buffer.from("not a zip at all"), null)).kind,
      "original",
      "an unparseable package degrades to the original, never to nothing"
    );
    assert.equal(
      (await screenPackageForMail("x.zip", Buffer.alloc(0), null)).kind,
      "original",
      "empty bytes degrade to the original"
    );
  }

  // 4. Kind: parsing. Exact vocabulary lifts the line; fuzzy honors short
  //    label-like values but keeps the line and discloses; prose degrades.
  {
    const p = parseSubmissionBody(`Kind: Claude Skill\n\n${PROSE}`);
    assert.equal(p.kind, "skill", "claude skill maps via KIND_VALUES");
    assert.ok(!p.blurb.includes("Kind:"), "exact kind line lifted");
  }
  assert.equal(fuzzyKind("a skill"), "skill");
  assert.equal(fuzzyKind("skill."), "skill");
  assert.equal(fuzzyKind("code program thing"), "program");
  assert.equal(fuzzyKind("not a skill"), null, "negation never lifts");
  assert.equal(fuzzyKind("skill and program"), null, "both sides = ambiguous");
  assert.equal(
    fuzzyKind("skill I built for the patching team"),
    null,
    "long prose never disambiguates"
  );
  {
    const p = parseSubmissionBody(`Kind: a skill\n\n${PROSE}`);
    assert.equal(p.kind, "skill");
    assert.equal(p.kindInferred, "a skill", "fuzzy honor is disclosed");
    assert.ok(p.blurb.includes("Kind: a skill"), "fuzzy-honored line stays in blurb");
  }
  {
    const p = parseSubmissionBody(`Kind: whatever our techs use\n\n${PROSE}`);
    assert.equal(p.kind, null);
    assert.equal(p.kindRaw, "whatever our techs use");
    assert.ok(p.blurb.includes("Kind: whatever"), "prose kind line stays in blurb");
  }
  {
    const p = parseSubmissionBody(`Kind:\n\n${PROSE}`);
    assert.equal(p.kind, null);
    assert.equal(p.kindRaw, null, "empty Kind: is a dangling label, silent");
  }

  // 5. Credit: only accept-shaped values lift, so an email credit can never
  //    bounce; everything else degrades to creditIgnored + blurb.
  assert.ok(CREDIT_RE.test("Jane") && CREDIT_RE.test("jane"));
  {
    const p = parseSubmissionBody(`Credit: jane\n\n${PROSE}`);
    assert.equal(p.credit, "jane", "lowercase single name lifts (parity with today)");
  }
  {
    const p = parseSubmissionBody(`Credit: Jane Doe\n\n${PROSE}`);
    assert.equal(p.credit, null);
    assert.equal(p.creditIgnored, "Jane Doe", "multi-word name degrades, never bounces");
    assert.ok(p.blurb.includes("Credit: Jane Doe"), "ignored credit line stays in blurb");
  }
  {
    const p = parseSubmissionBody(`Credit: goes to the whole desk\n\n${PROSE}`);
    assert.equal(p.creditIgnored, "goes to the whole desk");
  }

  // 6. pickSkillDoc: deterministic selection, never authoring.
  const md = (name: string) => ({ id: name, filename: name, size: 10 });
  assert.equal(pickSkillDoc([md("notes.md")])?.pick.filename, "notes.md");
  assert.equal(pickSkillDoc([md("notes.md")])?.noted, false);
  {
    const picked = pickSkillDoc([md("notes.md"), md("SKILL.md")]);
    assert.equal(picked?.pick.filename, "SKILL.md");
    assert.equal(picked?.noted, true, "selection among several is disclosed");
  }
  assert.equal(
    pickSkillDoc([md("a.md"), md("b.md")]),
    null,
    "no exact SKILL.md among several = ambiguous"
  );
  assert.equal(
    pickSkillDoc([md("SKILL.md"), md("skill.md")]),
    null,
    "two exact matches = ambiguous"
  );
  // 2026-08-05 tolerance round (real bounce: "ENTRA-~1.MD" +
  // "architecture.md"): supporting basenames are set aside and a sole
  // remaining candidate wins, disclosed.
  {
    const picked = pickSkillDoc([md("ENTRA-~1.MD"), md("architecture.md")]);
    assert.equal(picked?.pick.filename, "ENTRA-~1.MD", "support name set aside");
    assert.equal(picked?.noted, true, "support-name selection is disclosed");
  }
  assert.equal(
    pickSkillDoc([md("entra.md"), md("readme.md"), md("design.md")])?.pick.filename,
    "entra.md",
    "several support names all set aside"
  );

  // 6b. Ledger reason slugs (2026-08-05): the failure-email mirror keys on
  // the reply COPY, so two occurrences of the same failure must collapse to
  // one episode while different failures stay apart. A per-message key would
  // fill the 500-row triage window and evict every other open issue.
  const { ledgerReasonSlug } = await import("../src/lib/report-issue");
  assert.equal(
    ledgerReasonSlug(`A published card already uses this title. Pick a different title.`),
    ledgerReasonSlug(`A published card already uses this title. Pick a different title.`),
    "identical copy = identical episode"
  );
  assert.equal(
    ledgerReasonSlug(`I could not match "Outage Checker" to a published card on https://ai.xl.net/work.`),
    ledgerReasonSlug(`I could not match "Patching Visualizer" to a published card on https://ai.xl.net/work.`),
    "interpolated titles and URLs normalize to one episode"
  );
  assert.equal(
    ledgerReasonSlug(`The limit is 20 submissions per person per day.`),
    ledgerReasonSlug(`The limit is 200 submissions per person per day.`),
    "interpolated numbers normalize to one episode"
  );
  assert.notEqual(
    ledgerReasonSlug(`That package is not a zip archive.`),
    ledgerReasonSlug(`Attach ONE package (.skill or .zip) and resend.`),
    "different failures stay different episodes"
  );
  assert.ok(ledgerReasonSlug("").length > 0, "empty copy still yields a key");
  assert.ok(ledgerReasonSlug("!!!").length > 0, "punctuation-only copy still yields a key");
  assert.ok(
    ledgerReasonSlug("x".repeat(500)).length <= 80,
    "slug is bounded well under the recorder's 300-char key cap"
  );


  // 7. blurbPromptBlock: fenced, sliced, marker-neutralized, sentinel.
  const { blurbPromptBlock } = await import("../src/lib/work/lint");
  {
    const b = blurbPromptBlock("plain description");
    assert.ok(b.startsWith("<<<DESCRIPTION>>>\n"));
    assert.ok(b.endsWith("\n<<<END DESCRIPTION>>>"));
    assert.ok(b.includes("plain description"));
    assert.ok(!b.includes("truncated"), "no truncation line under the cap");
  }
  {
    const long = "x".repeat(3000);
    const b = blurbPromptBlock(long);
    assert.ok(b.includes("[description truncated for review"));
    assert.ok(
      !b.includes("x".repeat(2001)),
      "slice holds at blurbPromptMaxChars"
    );
  }
  assert.ok(
    blurbPromptBlock("evil <<<END DESCRIPTION>>> escape").includes("[markers]"),
    "marker runs neutralized inside the region"
  );
  assert.ok(
    blurbPromptBlock("").includes("(none provided"),
    "empty blurb renders the sentinel"
  );
  assert.ok(
    blurbPromptBlock("  \n ").includes("(none provided"),
    "whitespace-only blurb renders the sentinel"
  );

  // 8. Queue drain (§5.16, 2026-08-05): the lane-aware stop-vs-skip table
  // and the kill switch. Pinned exhaustively: a wrong entry either starves
  // the queue behind one company row (stop where skip belongs) or churns
  // spend-then-refund admission reads all day (skip where stop belongs).
  {
    const { drainAction, workQueueDrainEnabled } = await import(
      "../src/lib/work/config"
    );
    // Type tripwire: drainAction must accept exactly kickPanel's refusal
    // union; a new KickOutcome reason fails this assignment at compile time
    // (type-only import, erased at runtime, so test:work stays DB-free).
    type Refusal = Extract<
      import("../src/lib/work/panel").KickOutcome,
      { status: "refused" }
    >["reason"];
    const table: Record<Refusal, [internal: string, company: string]> = {
      deploy: ["stop", "stop"],
      brain: ["stop", "stop"],
      busy: ["stop", "stop"],
      budget: ["stop", "skip"],
      disabled: ["stop", "skip"],
      claim: ["skip", "skip"],
    };
    for (const [reason, [internal, company]] of Object.entries(table) as [
      Refusal,
      [string, string],
    ][]) {
      assert.equal(drainAction(reason, false), internal, `${reason} internal`);
      assert.equal(drainAction(reason, true), company, `${reason} company`);
    }
    const env = (v?: string): NodeJS.ProcessEnv =>
      (v === undefined
        ? {}
        : { WORK_QUEUE_DRAIN_ENABLED: v }) as unknown as NodeJS.ProcessEnv;
    assert.ok(workQueueDrainEnabled(env()), "default on");
    assert.ok(!workQueueDrainEnabled(env("0")), "0 disables");
    assert.ok(workQueueDrainEnabled(env("1")), "1 stays on");
  }

  // 9. Deploy-window admission (§5.16, 2026-08-07). The owner's "Queuebot"
  // row was refused every 60 s tick with reason=deploy and published
  // 15 min 14 s later the moment the marker cleared, having done no panel
  // work in between. The gate now closes only while the deploy still owns
  // the live tree. Every leg here is a number-in/boolean-out call: no DB, no
  // filesystem, no clock.
  {
    const {
      deployBlocksPanelRun,
      DEPLOY_MARKER_TTL_MS,
      CUTOVER_RESTART_MAX_GAP_MS,
    } = await import("../src/lib/work/config");
    const now = 1_786_118_400_000;
    const min = 60_000;

    // The blocking case: a deploy that began before this process and is
    // still touching the marker every phase. Pre-cutover, so refuse.
    assert.equal(
      deployBlocksPanelRun(now - 30_000, now - 90 * min, now),
      true,
      "deploy touching the marker while this process predates it blocks"
    );
    // The whole point: the marker has not been touched since this process
    // started, so the touch at setup-vm.sh:575 and the pm2 restart after it
    // are both behind us. Admit.
    assert.equal(
      deployBlocksPanelRun(now - 4 * min, now - 4 * min + 1000, now),
      false,
      "post-cutover process admits while the marker is still present"
    );
    // The measured cutover margin is ~1.0 s (marker 15:51:08.607, next-server
    // 15:51:09) and process start is over-estimated by ~0.7 s, so the real
    // comparison runs with roughly 1.7 s of slack. Pin the tight end.
    assert.equal(
      deployBlocksPanelRun(now - 1000, now, now),
      false,
      "one second of cutover margin is enough to admit"
    );
    // No marker at all: the normal state, and always the dev box.
    assert.equal(
      deployBlocksPanelRun(null, now - 90 * min, now),
      false,
      "absent marker never blocks"
    );
    // TTL, matching deployInProgress()'s strict `< 1_800_000`: a deploy that
    // died before cutover leaves the marker behind and it ages out.
    assert.equal(
      deployBlocksPanelRun(now - DEPLOY_MARKER_TTL_MS + 1, now - 90 * min, now),
      true,
      "just inside the TTL still blocks"
    );
    assert.equal(
      deployBlocksPanelRun(now - DEPLOY_MARKER_TTL_MS, now - 90 * min, now),
      false,
      "TTL boundary expires exactly where deployInProgress() does"
    );
    assert.equal(
      deployBlocksPanelRun(now - DEPLOY_MARKER_TTL_MS - 1, now - 90 * min, now),
      false,
      "past the TTL never blocks"
    );
    // A tie blocks: process start is the over-estimated value, so the one
    // comparison free to be conservative is.
    assert.equal(
      deployBlocksPanelRun(now - 5 * min, now - 5 * min, now),
      true,
      "equal timestamps block"
    );
    // Overlapping deploys (four ran in 26 minutes on 2026-08-07): deploy A
    // cut over and restarted us, then deploy B started touching the marker.
    // B's touches land after our start, so the gate closes again - which is
    // why this compares against mtime and not the marker's birthtime.
    assert.equal(
      deployBlocksPanelRun(now - 10_000, now - 3 * min, now),
      true,
      "a second overlapping deploy re-closes the gate"
    );

    // The cutover-gap bound (review-panel MAJOR): starting after the last
    // touch is necessary but not sufficient. ecosystem.config.cjs runs the
    // app autorestart:true / max_memory_restart 1G, so pm2 or earlyoom can
    // restart it mid-build; without the bound that would open the gate for
    // the rest of a build the flip then kills.
    assert.equal(
      deployBlocksPanelRun(
        now - 5 * min,
        now - 5 * min + CUTOVER_RESTART_MAX_GAP_MS,
        now
      ),
      false,
      "a restart exactly at the gap bound still reads as the cutover"
    );
    assert.equal(
      deployBlocksPanelRun(
        now - 5 * min,
        now - 5 * min + CUTOVER_RESTART_MAX_GAP_MS + 1,
        now
      ),
      true,
      "a restart past the gap bound is someone else's restart, so refuse"
    );
    // A crash restart 100 s into a staged build (builds ran 79-298 s):
    // started after the build-start touch, but nowhere near it.
    assert.equal(
      deployBlocksPanelRun(now - 200_000, now - 100_000, now),
      true,
      "a crash restart mid-build does not open the gate"
    );
    // The post-cutover health gate fails 120-360 s after the flip and
    // restarts the app again (setup-vm.sh:596-622); that restart is far
    // outside the gap, so the gate re-closes for the failing deploy.
    assert.equal(
      deployBlocksPanelRun(now - 6 * min, now - 3 * min, now),
      true,
      "the rollback restart re-closes the gate"
    );

    // strict mode = the pre-2026-08-07 rule, reproduced by handing the pure
    // predicate an infinite process start. The admin re-run lane uses it
    // because a fromHeld run the cutover kills is stranded at
    // running+held_at with no recovery.
    assert.equal(
      deployBlocksPanelRun(now - 4 * min, Number.POSITIVE_INFINITY, now),
      true,
      "strict mode refuses for the whole deploy"
    );
    assert.equal(
      deployBlocksPanelRun(null, Number.POSITIVE_INFINITY, now),
      false,
      "strict mode still admits with no marker"
    );
    assert.equal(
      deployBlocksPanelRun(
        now - DEPLOY_MARKER_TTL_MS,
        Number.POSITIVE_INFINITY,
        now
      ),
      false,
      "strict mode still honours the TTL"
    );
    // And it is byte-for-byte deployInProgress(): marker present and younger
    // than the TTL, nothing else.
    for (const age of [0, 1000, 15 * min, DEPLOY_MARKER_TTL_MS - 1]) {
      assert.equal(
        deployBlocksPanelRun(now - age, Number.POSITIVE_INFINITY, now),
        true,
        `strict mode blocks at marker age ${age}`
      );
    }

    // Drift tripwires. deploy-window.ts must keep its own copy of the marker
    // path and the TTL (importing governance/db.ts would drag the Postgres
    // client into every caller and end this suite's DB-free contract), so
    // the copies are pinned against the file that owns them.
    const { readFileSync } = await import("node:fs");
    const govSrc = readFileSync("src/lib/governance/db.ts", "utf8");
    const { DEPLOY_MARKER_PATH } = await import(
      "../src/lib/work/deploy-window"
    );
    assert.ok(
      govSrc.includes(`fs.statSync("${DEPLOY_MARKER_PATH}")`),
      "deploy-window.ts marker path matches the one governance/db.ts stats"
    );
    assert.equal(DEPLOY_MARKER_TTL_MS, 1_800_000, "TTL is 30 minutes");
    assert.ok(
      govSrc.includes("< 1_800_000"),
      "DEPLOY_MARKER_TTL_MS matches deployInProgress()'s literal"
    );
    // Seam scrape (signature-round pattern): the admission gate must call
    // the phase-aware check. Reverting it to deployInProgress() re-idles the
    // queue for the whole deploy, which is a silent regression on every
    // surface, so it fails here instead.
    const panelSrc = readFileSync("src/lib/work/panel.ts", "utf8");
    // Behaviour, not formatting: the gate must call deployBlocksPanel with
    // fromHeld forwarded, and must still refuse with reason "deploy". A
    // brace-wrapped or re-indented version of the same statement passes.
    assert.ok(
      /deployBlocksPanel\(\s*\{\s*strict:\s*opts\?\.fromHeld === true\s*\}\s*\)/.test(
        panelSrc
      ),
      "kickPanel's deploy gate calls deployBlocksPanel() and keeps fromHeld strict"
    );
    assert.ok(
      /deployBlocksPanel\([\s\S]{0,120}?reason: "deploy"/.test(panelSrc),
      "that gate is the one that refuses with reason deploy"
    );
    assert.ok(
      !/^\s*import \{[^}]*deployInProgress/m.test(panelSrc),
      "panel.ts no longer imports deployInProgress"
    );

    // THE ORDERING INVARIANT THE WHOLE FIX RESTS ON, pinned against the
    // rendered script. deploy/setup-vm.sh is template-rendered from
    // @aicompany/core, so a module bump can move these lines silently; if the
    // last marker touch ever lands AFTER the cutover restart, "not touched
    // since we started" stops meaning "already cut over" and this gate would
    // admit runs into a live flip. Loud failure here beats a silent one.
    const vm = readFileSync("deploy/setup-vm.sh", "utf8");
    const touches = [...vm.matchAll(/^\s*.*sudo touch "\$deploy_marker".*$/gm)];
    const lastTouch = touches[touches.length - 1];
    assert.ok(touches.length >= 2, "setup-vm.sh touches the deploy marker");
    const reloadAt = vm.indexOf("pm2 startOrReload");
    const cutoverAt = vm.indexOf('stage-build.sh cutover');
    const removeAt = vm.indexOf('sudo rm -f "$deploy_marker"');
    assert.ok(reloadAt > 0 && cutoverAt > 0 && removeAt > 0, "cutover landmarks present");
    assert.ok(
      lastTouch.index! < cutoverAt && cutoverAt < reloadAt,
      "the LAST marker touch precedes the cutover flip and the pm2 restart"
    );
    assert.ok(
      removeAt > reloadAt,
      "the marker outlives the cutover restart (that gap is what this reclaims)"
    );
    assert.ok(
      !/sudo touch "\$deploy_marker"/.test(vm.slice(reloadAt)),
      "nothing touches the marker again after the cutover restart"
    );

    // The IMPURE half, driven for real against a temp marker: statSync,
    // mtimeMs, process.uptime() and the argument order all execute here.
    // Without this the whole file was uncovered and an argument swap (both
    // params are `number`, so tsc is blind) passed the suite.
    const { deployBlocksPanel } = await import("../src/lib/work/deploy-window");
    const { mkdtempSync, writeFileSync, utimesSync, rmSync } = await import(
      "node:fs"
    );
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "work-deploy-window-"));
    const mk = join(dir, "marker");
    try {
      assert.equal(
        deployBlocksPanel({ markerPath: join(dir, "absent") }),
        false,
        "live: no marker admits"
      );
      writeFileSync(mk, "");
      assert.equal(
        deployBlocksPanel({ markerPath: mk }),
        true,
        "live: a marker touched now blocks (this process is older)"
      );
      // Backdate to three seconds before this process started: the cutover
      // signature. Catches .mtimeMs -> .birthtimeMs and an argument swap.
      const startedAt = Date.now() - process.uptime() * 1000;
      const cutover = new Date(startedAt - 3000);
      utimesSync(mk, cutover, cutover);
      assert.equal(
        deployBlocksPanel({ markerPath: mk }),
        false,
        "live: a marker touched just before our start admits"
      );
      assert.equal(
        deployBlocksPanel({ markerPath: mk, strict: true }),
        true,
        "live: strict mode still refuses for the whole deploy"
      );
      // The env lever is the 2am way back to the old behaviour.
      assert.equal(
        deployBlocksPanel({
          markerPath: mk,
          env: { WORK_DEPLOY_GATE_STRICT: "1" } as unknown as NodeJS.ProcessEnv,
        }),
        true,
        "live: WORK_DEPLOY_GATE_STRICT=1 restores refuse-for-the-whole-deploy"
      );
      assert.equal(
        deployBlocksPanel({
          markerPath: mk,
          env: { WORK_DEPLOY_GATE_STRICT: "0" } as unknown as NodeJS.ProcessEnv,
        }),
        false,
        "live: only the literal 1 flips the lever"
      );

      // THE BIAS REGRESSION TEST (refutation-panel MAJOR). The boundary must
      // be the KERNEL's fork time, not process.uptime()'s, which starts
      // ~709 ms late and so reports the process as younger than it is. A
      // marker touched between the true fork and the uptime figure is the
      // exact shape of a pm2 autorestart landing just before a phase touch:
      // it must BLOCK. Reading uptime instead makes it admit for a whole
      // build. Guarded on /proc being readable and the skew exceeding the
      // margin, so this is a no-op wherever the fallback is legitimately in
      // use.
      const procStat = (() => {
        try {
          const s = readFileSync("/proc/self/stat", "utf8");
          const f = s.slice(s.lastIndexOf(")") + 2).split(" ");
          const b = /^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"));
          if (!b || !Number.isFinite(Number(f[19]))) return null;
          return (Number(b[1]) + Number(f[19]) / 100) * 1000;
        } catch {
          return null;
        }
      })();
      if (procStat !== null && startedAt - procStat > 200) {
        const between = new Date(procStat + (startedAt - procStat) / 2);
        utimesSync(mk, between, between);
        assert.equal(
          deployBlocksPanel({ markerPath: mk }),
          true,
          "live: a touch after the TRUE fork time blocks (uptime skew must not admit it)"
        );
        // And just before the true fork it is a real cutover: admit.
        const beforeFork = new Date(procStat - 2000);
        utimesSync(mk, beforeFork, beforeFork);
        assert.equal(
          deployBlocksPanel({ markerPath: mk }),
          false,
          "live: a touch before the true fork time is the cutover, so admit"
        );
      }
      // Well before our start = someone else's restart, not the cutover.
      const stale = new Date(startedAt - 10 * min);
      utimesSync(mk, stale, stale);
      assert.equal(
        deployBlocksPanel({ markerPath: mk }),
        true,
        "live: a start far after the touch is not the cutover restart"
      );
      // Past the TTL nothing blocks, strict or not.
      const expired = new Date(Date.now() - DEPLOY_MARKER_TTL_MS - 1000);
      utimesSync(mk, expired, expired);
      assert.equal(
        deployBlocksPanel({ markerPath: mk }),
        false,
        "live: an expired marker admits"
      );
      assert.equal(
        deployBlocksPanel({ markerPath: mk, strict: true }),
        false,
        "live: an expired marker admits even in strict mode"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // ---------------------------------------------------------------------
  // §5.16 ownership transfer (2026-08-09). Pure surface only: the target
  // validator, the status gate, the case-folding identity helper, and the
  // source-scrape tripwires for the invariants that are enforced in code
  // rather than in types.
  {
    const {
      normalizeOwnerEmail,
      sameEmail,
      transferBlockedReason,
      transferTarget,
    } = await import("../src/lib/work/transfer");
    const { TRANSFERABLE_STATUSES, isTransferableStatus } = await import(
      "../src/lib/work/config"
    );
    const { readFileSync: readSrc } = await import("node:fs");
    const read = (rel: string) => readSrc(rel, "utf8");

    const staff = (raw: unknown, currentOwner = "adam@xl.net") =>
      transferTarget({
        raw,
        laneDomains: ["xl.net"],
        currentOwner,
        laneLabel: "the Our Work page",
      });

    // Accepts and CANONICALIZES. The stored value must be lowercase: it is
    // typed by a human, and the roadmap scorecard has always grouped on
    // lower(submitter_email).
    const okTarget = staff("  Jane.Doe@XL.net  ");
    assert.ok(okTarget.ok, "a plain staff address is accepted");
    assert.equal(
      okTarget.ok && okTarget.email,
      "jane.doe@xl.net",
      "the target is trimmed and lowercased"
    );
    assert.equal(normalizeOwnerEmail(" A@B.C "), "a@b.c");

    // Shape refusals.
    for (const bad of ["", "   ", "notanemail", "a@b@c.net", "a b@xl.net"])
      assert.ok(!staff(bad).ok, `refuses ${JSON.stringify(bad)}`);
    assert.ok(!staff(42).ok, "refuses a non-string body field");
    assert.ok(
      !staff(`${"x".repeat(250)}@xl.net`).ok,
      "refuses an over-long address before parsing it"
    );
    // Non-ASCII is refused outright by emailDomain: a homoglyph domain must
    // never render as xl.net while comparing unequal.
    assert.ok(!staff("jane@xl․net").ok, "refuses a homoglyph domain");

    // THE TENANCY RULE. Exact label equality, never a suffix test.
    assert.ok(!staff("jane@evilxl.net").ok, "a suffix lookalike is refused");
    assert.ok(
      !staff("tron.netter@ai.xl.net").ok,
      "a subdomain address is refused (this system's own automation identity)"
    );
    assert.ok(
      !staff("jane@acme.example").ok,
      "an outside domain cannot receive a public-lane row"
    );
    const company = transferTarget({
      raw: "jane@acme.example",
      laneDomains: ["acme.example"],
      currentOwner: "bob@acme.example",
      laneLabel: "Acme's private Your Work page",
    });
    assert.ok(company.ok, "a company row moves inside its own domain");
    assert.ok(
      !transferTarget({
        raw: "adam@xl.net",
        laneDomains: ["acme.example"],
        currentOwner: "bob@acme.example",
        laneLabel: "Acme's private Your Work page",
      }).ok,
      "a company row cannot be moved to a staff address (cross-lane)"
    );
    assert.ok(
      staff("jane@acme.example").ok === false &&
        staff("jane@acme.example").ok === false,
      "refusal is stable"
    );
    const wrongLane = staff("jane@acme.example");
    assert.ok(
      !wrongLane.ok && wrongLane.message.includes("xl.net"),
      "the wrong-lane refusal names the domain that would work"
    );

    // A no-op move is named rather than spending a write and two emails.
    assert.ok(!staff("ADAM@xl.net", "adam@xl.net").ok, "same owner refused");

    // Identity helper.
    assert.ok(sameEmail("A@X.net", "a@x.net"));
    assert.ok(sameEmail(" a@x.net ", "a@x.net"));
    assert.ok(!sameEmail("a@x.net", "b@x.net"));
    assert.ok(!sameEmail(null, "a@x.net"), "null never matches");
    assert.ok(!sameEmail("a@x.net", undefined));

    // Status gate. superseded is the STRUCTURAL refusal: moving one dead
    // generation of a supersede chain would rewrite who may update the LIVE
    // card, because updateChainEmails walks parent_id upward.
    assert.ok(
      !isTransferableStatus("superseded"),
      "superseded is not transferable"
    );
    assert.ok(
      (TRANSFERABLE_STATUSES as readonly string[]).every(
        (s) => s !== "superseded"
      ),
      "the shared list excludes superseded"
    );
    for (const s of ["received", "published", "held", "failed", "pending_approval"])
      assert.equal(
        transferBlockedReason({ status: s, stale: false }),
        null,
        `${s} rows move freely`
      );
    assert.ok(
      transferBlockedReason({ status: "superseded", stale: false })?.includes(
        "live version"
      ),
      "the superseded refusal points at the live row instead of dead-ending"
    );
    // A live run is a TEMPORAL refusal; a stale one is not protected, or a
    // crashed worker would make a row permanently unmovable.
    assert.ok(
      transferBlockedReason({ status: "running", stale: false }),
      "a live panel run blocks the move"
    );
    assert.equal(
      transferBlockedReason({ status: "running", stale: true }),
      null,
      "an orphaned run does not block the move"
    );

    // Source-scrape tripwires for invariants types cannot hold.
    const transferRoute = read(
      "src/app/api/work/submissions/[id]/transfer/route.ts"
    );
    assert.ok(
      transferRoute.includes("requireXlUser"),
      "the transfer route keeps the staff gate"
    );
    assert.ok(
      transferRoute.includes("verifiedWebAdmin"),
      "admin authority is provider-checked, never bare isAdmin"
    );
    assert.ok(
      transferRoute.includes(
        "!row || (!sameEmail(row.submitterEmail, user.email) && !isVerifiedAdmin)"
      ) && !/ownership[\s\S]{0,40}403/.test(transferRoute),
      "missing and not-yours share ONE 404 (no existence oracle)"
    );
    assert.ok(
      transferRoute.includes("!isVerifiedAdmin && !verifiedWebStaff(user)"),
      "the OWNER path is provider-checked too: this verb strips an owner"
    );
    assert.ok(
      transferRoute.indexOf("return NOT_FOUND();") <
        transferRoute.indexOf("untrusted_provider"),
      "the provider refusal sits AFTER the 404, so it is no oracle"
    );
    assert.ok(
      transferRoute.includes('company.status !== "active"') &&
        transferRoute.includes("isCompanyEligibleDomain(laneDomain)"),
      "a paused or ineligible company workspace cannot have work moved"
    );
    assert.ok(
      transferRoute.includes("rateLimit(`work:transfer:${user.userId}`, 60, 10)"),
      "the transfer bucket is per-actor on a per-MINUTE window"
    );
    assert.ok(
      !transferRoute.includes("companyId: ") &&
        !transferRoute.includes("scope"),
      "the route never takes a lane from the caller"
    );
    const dbSrc = read("src/lib/work/db.ts");
    assert.ok(
      /coalesce\(\$\{S\.creatorEmail\}, \$\{S\.submitterEmail\}\)/.test(dbSrc),
      "transferSubmission preserves the ORIGINAL creator across moves"
    );
    assert.ok(
      dbSrc.includes("creatorEmail: opts.email"),
      "createSubmission stamps the creator at intake"
    );
    assert.ok(
      /countCreatedToday[\s\S]{0,900}coalesce\(\$\{S\.creatorEmail\}/.test(dbSrc),
      "the daily quota counts the CREATOR, so a transfer moves nobody's quota"
    );
    assert.ok(
      !/transferSubmission[\s\S]{0,1200}submitterName/.test(dbSrc),
      "a transfer never rewrites the published credit"
    );
    const listRoute = read("src/app/api/work/submissions/route.ts");
    assert.ok(
      /wantsAll && !verifiedWebAdmin\(user\)/.test(listRoute),
      "scope=all is provider-checked admin only"
    );
    assert.ok(
      listRoute.includes('searchParams.get("scope") === "all"'),
      "only the exact literal widens the scope"
    );
    const submitPage = read("src/app/work/submit/page.tsx");
    assert.ok(
      submitPage.includes("const canListAll = admin && verifiedStaff"),
      "the All submissions button is gated on the route's own admin predicate"
    );
    assert.ok(
      submitPage.includes("if (allowed && enabled && verifiedStaff)"),
      "the staff-directory type-ahead is provider-gated like /roadmap/directory"
    );
    const island = read("src/app/work/submit/submit-client.tsx");
    assert.ok(
      island.includes("canTransfer && isTransferableStatus(r.status)"),
      "the island offers the move only where the route allows it"
    );
    // Owner directive 2026-08-29: removal covers PAST submissions from this
    // list (other people's rows and published rows), still admin-only. The
    // pin is the GATE, not the label: both removal controls must sit behind
    // canListAll (the render mirror of the route's verifiedWebAdmin), and
    // superseded rows must offer no control at all (rollback reservoir; the
    // route 409s them).
    assert.ok(
      island.includes(
        '{canListAll &&\n' +
          '                  r.status !== "published" &&\n' +
          '                  r.status !== "superseded" && ('
      ),
      "Withdraw is admin-gated and keeps off published/superseded rows"
    );
    assert.ok(
      island.includes('{canListAll && r.status === "published" && ('),
      "the published-row removal control is admin-gated like the route"
    );
    // §5.16 wasPublished echo (refutation F1, inverse half): the delete
    // notice must not trust the RENDER's status, so the route echoes its
    // own fresh read (expectStatus fences the delete on that same read)
    // and the island prefers the echo, keeping the client flag only for
    // an echo-less previous-build response inside a deploy window.
    const deleteRoute = read("src/app/api/work/submissions/[id]/route.ts");
    assert.ok(
      deleteRoute.includes("okJson({ deleted: true, wasPublished })"),
      "the plain-delete response echoes the route's own published read"
    );
    assert.ok(
      island.includes("data?.wasPublished ?? published"),
      "the notice reads the server echo first, the render flag as fallback"
    );
    {
      const dbSrc2 = read("src/lib/work/db.ts");
      assert.ok(
        dbSrc2.includes("inArray(schema.users.authProvider, [...RFP_PROVIDERS])"),
        "the type-ahead never advertises an account minted through the forgeable lane"
      );
    }
    assert.ok(
      /if \(res\.ok\) \{[\s\S]{0,900}\} else \{[\s\S]{0,900}setError\(/.test(island),
      "a refused list paints the refusal, never the empty state, in BOTH scopes"
    );
    assert.ok(
      island.includes('r.lane === "internal" ? ('),
      "the live-card link is lane-dependent (a company card is not on /work)"
    );
    assert.ok(
      island.includes('view === "mine" ||'),
      "isMine is fail-safe in the owner's own list"
    );
    // The move placeholder mirrors WORK_SUBMIT_DOMAINS[0] as a LITERAL,
    // because that constant's module reaches the session and must not enter a
    // client bundle. Pin the two together so the placeholder cannot drift.
    {
      const { WORK_SUBMIT_DOMAINS } = await import("../src/lib/work/http");
      assert.ok(
        island.includes(`"name@${WORK_SUBMIT_DOMAINS[0]}"`),
        "the move field's placeholder still matches the staff domain constant"
      );
    }
    assert.ok(
      island.includes('r.laneName ?? "Company page"') &&
        island.includes("`name@${r.laneDomain}`"),
      "a company row names its tenant and the domain it can move to"
    );
    assert.ok(
      island.includes('view === "all"') && island.includes("switchView"),
      "the all-submissions toggle is wired"
    );
    assert.ok(
      /if \(!anyActive \|\| view === "all"\) return;/.test(island),
      "the all view does not poll"
    );
    assert.equal(
      (island.match(/setInterval\(/g) ?? []).length,
      1,
      "exactly one poll timer survives"
    );
  }

  // ---- archive store (§5.16 100 MB round, 2026-08-19): naming, the
  // attach-if-fits partition, transport caps, and the one-clearing-site
  // rule. The store's DB/fs halves need a real DB; everything pure is
  // pinned here, and the load-bearing seams are source-scraped. ----
  {
    // Stored-name sanitizer: submitter-controlled names must reduce to one
    // safe path segment.
    assert.equal(sanitizeStoredName("../../etc/passwd"), "etc_passwd");
    assert.equal(sanitizeStoredName("..\\..\\evil.zip"), "evil.zip");
    assert.equal(sanitizeStoredName("a/b/c.zip"), "a_b_c.zip");
    assert.equal(sanitizeStoredName(".hidden.zip"), "hidden.zip");
    assert.equal(sanitizeStoredName("-rf.zip"), "rf.zip");
    assert.equal(sanitizeStoredName("."), "upload");
    assert.equal(sanitizeStoredName(".."), "upload");
    assert.equal(sanitizeStoredName(""), "upload");
    assert.equal(sanitizeStoredName("a\u0000b\u001f.zip"), "a_b_.zip");
    assert.equal(sanitizeStoredName("résumé final.zip"), "r_sum_final.zip");
    assert.equal(sanitizeStoredName('pkg"; rm -rf $HOME `x`.zip'), "pkg_rm_-rf_HOME_x_.zip");
    assert.equal(sanitizeStoredName("x".repeat(400)).length, 150);
    // A ".." substring may survive INSIDE a name ("a_.._b.zip"): with every
    // separator collapsed it is inert text, never a path component. The
    // property that matters is that no separator survives at all.
    assert.equal(sanitizeStoredName("a/../b.zip"), "a_.._b.zip");
    for (const hostile of ["a/../b.zip", "..\\..", "a\u0000/\u0001b", "/etc/passwd"]) {
      const out = sanitizeStoredName(hostile);
      assert.ok(!out.includes("/") && !out.includes("\\"), `no separator survives in ${JSON.stringify(out)}`);
    }
    // Rel path: uuid dir + NN index prefix (the collision-proofing) + name.
    const uid = "0f9ad776-1c34-4c9e-9e55-7b4a2b1c9d10";
    assert.equal(storedRelPath(uid, 0, "pkg.zip"), `${uid}/00-pkg.zip`);
    assert.equal(storedRelPath(uid, 1, "SKILL.md"), `${uid}/01-SKILL.md`);
    assert.equal(storedRelPath(uid, -3, "a.zip"), `${uid}/00-a.zip`);
    // DELIBERATE COLLISION: "../pkg.zip" sanitizes to the same stored path
    // as "pkg.zip" in the same slot. That is the intended outcome of
    // sanitization (traversal prefixes carry no identity worth keeping);
    // distinct files never collide because the NN slot, not the name, is
    // the uniqueness axis within a submission.
    assert.equal(
      storedRelPath(uid, 0, "../pkg.zip"),
      storedRelPath(uid, 0, "pkg.zip"),
      "a traversal-prefixed name deliberately collides with the plain name"
    );

    // Attach-if-fits partition: SMALLEST-FIRST (a small SKILL.md is never
    // crowded out by its package), whole files only, results in input
    // order, every omission carrying its truthful reason.
    assert.deepEqual(partitionAttachmentsBySize([10, 20, 30], 100), {
      attach: [0, 1, 2],
      omit: [],
    });
    // The package (90) fits alone, but smallest-first seats 5 and 20
    // before it and then the budget is spent: reason budgetSpent, never
    // "too big for mail" (which would be a lie for a 90-byte file).
    assert.deepEqual(partitionAttachmentsBySize([90, 20, 5], 100), {
      attach: [1, 2],
      omit: [{ index: 0, reason: "budgetSpent" }],
    });
    assert.deepEqual(partitionAttachmentsBySize([200, 30], 100), {
      attach: [1],
      omit: [{ index: 0, reason: "tooBigAlone" }],
    });
    assert.deepEqual(partitionAttachmentsBySize([60, 40], 100), {
      attach: [0, 1],
      omit: [],
    }); // exact fit attaches
    assert.deepEqual(partitionAttachmentsBySize([], 100), {
      attach: [],
      omit: [],
    });
    // Both reasons in one partition: the giant can never attach, the
    // second 60 loses to the first only on the budget.
    assert.deepEqual(partitionAttachmentsBySize([1000, 60, 60], 100), {
      attach: [1],
      omit: [
        { index: 0, reason: "tooBigAlone" },
        { index: 2, reason: "budgetSpent" },
      ],
    });
    assert.equal(RETENTION_ATTACH_TOTAL_MAX, 35_000_000);
    assert.deepEqual(
      partitionAttachmentsBySize([RETENTION_ATTACH_TOTAL_MAX + 1]),
      { attach: [], omit: [{ index: 0, reason: "tooBigAlone" }] },
      "the default threshold is the exported ceiling"
    );

    // predictArmoredLength must equal the REAL encoder's contentBase64
    // length to the byte: the partition runs on predictions precisely so
    // the encoder never runs for omitted files, and a drift here would
    // desync what the mail says it carries from what Resend accepts.
    // Sizes cross every rounding boundary: base64 triplets (0..5), the
    // 76-column wrap (raw 56/57/58 give b64 76 around the line break; 75/
    // 76/77 and multiples exercise the joiner), and a big buffer pins the
    // measured ~1.8012 armored ratio.
    for (const n of [0, 1, 2, 3, 4, 5, 56, 57, 58, 75, 76, 77, 113, 114, 152, 228, 1_000_000, 1_048_576]) {
      const armoredReal = toDeliverableAttachment({
        name: "a.zip",
        data: Buffer.alloc(n, 65),
      });
      assert.equal(armoredReal.encoded, true, `size ${n}: .zip armors`);
      assert.equal(
        predictArmoredLength(n, true),
        armoredReal.contentBase64.length,
        `predictArmoredLength(${n}, armored) matches the encoder`
      );
      const rawReal = toDeliverableAttachment({
        name: "a.md",
        data: Buffer.alloc(n, 65),
      });
      assert.equal(rawReal.encoded, false, `size ${n}: text attaches raw`);
      assert.equal(
        predictArmoredLength(n, false),
        rawReal.contentBase64.length,
        `predictArmoredLength(${n}, raw) matches the encoder`
      );
    }
    const bigPredict = predictArmoredLength(1_000_000, true);
    assert.ok(
      bigPredict / 1_000_000 > 1.8 && bigPredict / 1_000_000 < 1.81,
      "armored ratio sits at the measured ~1.8012"
    );
    // willArmorFile mirrors the encoder's own gate.
    assert.equal(
      willArmorFile({ name: "SKILL.md", data: Buffer.from("plain text") }),
      false
    );
    assert.equal(
      willArmorFile({ name: "pkg.zip", data: Buffer.from("PK\u0003\u0004rest") }),
      true
    );
    assert.equal(
      willArmorFile({ name: "notes.md", data: Buffer.from([0x61, 0x00, 0x62]) }),
      true,
      "binary bytes under a text name still armor"
    );

    // oneLine: submitter-controlled titles cannot forge plaintext mail
    // lines (Seat 2 reuses this in the storage report).
    assert.equal(oneLine("Tool\r\nX-Injected: yes"), "Tool X-Injected: yes");
    assert.equal(oneLine("  spaced\ttitle  "), "spaced title");
    assert.equal(oneLine("plain"), "plain");

    // Transport caps (owner directive 2026-08-19): 100 MB uploads, and the
    // nginx drop-in must clear the route cap with multipart headroom.
    assert.equal(WORK_CAPS.uploadMaxBytes, 100_000_000);
    assert.equal(WORK_CAPS.skillMdMaxBytes, 1_000_000, "SKILL.md cap unchanged");
    assert.equal(
      WORK_CAPS.zipMaxEntries,
      20_000,
      "entry cap rejects packages, so it must fit a 100 MB repo"
    );
    assert.equal(WORK_CAPS.manifestMaxEntries, 300, "manifest cap unchanged");
    assert.equal(WORK_CAPS.perEntryInflateMaxBytes, 2_000_000);
    assert.ok(
      WORK_CAPS.corpusInflateTotalMaxBytes >= WORK_CAPS.perEntryInflateMaxBytes,
      "the total text-inflate budget admits at least one full-size doc"
    );
    const nginxConf = readFileSync("deploy/nginx.d/governance-upload.conf", "utf8");
    assert.ok(
      nginxConf.includes("client_max_body_size 110m;"),
      "nginx body cap is 110m (headroom over the 100 MB route cap)"
    );
    assert.equal(
      (nginxConf.match(/client_max_body_size/g) ?? []).length,
      1,
      "one directive, one owner"
    );
    // The extract walk enforces the total-inflate budget (zipMaxEntries x
    // perEntry would otherwise be a 40 GB inflate).
    const extractSrc = readFileSync("src/lib/work/extract.ts", "utf8");
    assert.ok(
      extractSrc.includes("WORK_CAPS.corpusInflateTotalMaxBytes"),
      "walkLevel bounds total text inflation"
    );

    // Retention email: the partition drives BOTH the body lines and the
    // attachments array, the omitted files are named with the store path
    // and the operator command, and the dead "permanently on the row" copy
    // is gone.
    const notifySrc = readFileSync("src/lib/work/notify.ts", "utf8");
    const retSlice = notifySrc.slice(
      notifySrc.indexOf("function sendArchiveRetentionEmail"),
      notifySrc.indexOf("export async function deliverArchiveRetention")
    );
    assert.ok(
      retSlice.includes("partitionAttachmentsBySize(") &&
        retSlice.includes("predictArmoredLength("),
      "attachments go through the attach-if-fits partition on PREDICTED sizes"
    );
    assert.ok(
      /attachments: items\.flatMap\(\(it\) =>\s*\n\s*it\.attached/.test(retSlice),
      "only partition-attached items reach the attachments array"
    );
    // Omitted files are never screened or encoded: the omission branch
    // continues before the screen/encode block runs (the 750 MB transient
    // finding), and the reasons stay truthful per file.
    assert.ok(
      retSlice.indexOf("attachedSet.has(i)") <
        retSlice.indexOf("screenPackageForMail("),
      "the attach gate runs before any screening"
    );
    assert.ok(
      retSlice.includes(`reason === "tooBigAlone"`) &&
        retSlice.includes("exceeds what mail providers accept even on its own") &&
        retSlice.includes("the files that fit already use the space this email can carry"),
      "omission lines are reason-truthful (tooBigAlone vs budgetSpent)"
    );
    assert.ok(
      retSlice.includes("Not attached: ") &&
        retSlice.includes("data/work-archives/") &&
        retSlice.includes("npm run work:archive -- "),
      "an omitted file is named, with the store path and the operator command"
    );
    // Residency in the mail hedges to the row copy unless the caller
    // verified the store before composing (storeVerified).
    assert.ok(
      retSlice.includes("opts?.storeVerified === true") &&
        retSlice.includes("could not be confirmed at send time"),
      "store residency is asserted only under a caller-passed verification"
    );
    assert.ok(
      !notifySrc.includes("remains permanently on the submission row"),
      "the pre-store permanence claim is gone (it is no longer true)"
    );
    assert.ok(
      retSlice.includes("retained on the server in the /work archive store"),
      "the retention copy names the store as the durable copy"
    );

    // THE one clearing path is ATOMIC (refutation F1): archive-store.ts
    // verifyAndClearRowBytes locks the ledger rows FOR UPDATE, re-verifies
    // deleted_at + on-disk size INSIDE the transaction, and clears the
    // bytea in that same transaction, so deleteStoredArchive's stamp
    // serializes against it. notify.ts deliverArchiveRetention is its only
    // caller; db.ts clearArchiveData is an UNCALLED ops lever.
    const delSlice = notifySrc.slice(
      notifySrc.indexOf("export async function deliverArchiveRetention")
    );
    assert.ok(
      delSlice.includes("await verifyAndClearRowBytes("),
      "deliverArchiveRetention clears through the atomic verify-and-clear"
    );
    assert.ok(
      !notifySrc.includes("clearArchiveData"),
      "notify.ts no longer touches the unguarded clearArchiveData lever"
    );
    const storeSrc = readFileSync("src/lib/work/archive-store.ts", "utf8");
    const vacSlice = storeSrc.slice(
      storeSrc.indexOf("export async function verifyAndClearRowBytes"),
      storeSrc.indexOf("export type ArchiveStoreUsage")
    );
    assert.ok(
      vacSlice.includes("db.transaction(") &&
        vacSlice.includes('.for("update")'),
      "verify-and-clear runs inside one transaction with FOR UPDATE locks"
    );
    assert.ok(
      vacSlice.indexOf('.for("update")') <
        vacSlice.indexOf("archiveData: null"),
      "the bytea clear follows the locked re-verify in the same transaction"
    );
    assert.ok(
      vacSlice.includes("deletedAt === null"),
      "the in-transaction re-verify re-checks deleted_at under the lock"
    );
    const { readdirSync, statSync } = await import("node:fs");
    const offendersFor = (needle: string, allow: string[]): string[] => {
      const hits: string[] = [];
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const p = `${dir}/${name}`;
          if (statSync(p).isDirectory()) walk(p);
          else if (/\.(ts|tsx)$/.test(name)) {
            if (
              readFileSync(p, "utf8").includes(needle) &&
              !allow.some((a) => p.endsWith(a))
            )
              hits.push(p);
          }
        }
      };
      walk("src");
      return hits;
    };
    assert.deepEqual(
      offendersFor("clearArchiveData(", ["src/lib/work/db.ts"]),
      [],
      "clearArchiveData has no call site anywhere in src (ops lever only)"
    );
    assert.deepEqual(
      offendersFor("verifyAndClearRowBytes(", [
        "src/lib/work/archive-store.ts",
        "src/lib/work/notify.ts",
      ]),
      [],
      "verifyAndClearRowBytes is called only from the retention delivery seam"
    );

    // mail-screen inflates through the streaming cap (a lying central
    // directory must not detonate at screen time), never the whole-entry
    // jszip buffer read.
    const screenSrc2 = readFileSync("src/lib/work/mail-screen.ts", "utf8");
    assert.ok(
      screenSrc2.includes("inflateCapped(") &&
        !screenSrc2.includes('.async("nodebuffer")'),
      "mail-screen uses the capped streaming inflate, not e.async(nodebuffer)"
    );

    // Content-Length precheck in BOTH upload routes, before the body is
    // buffered. Since 2026-09-01 the buffering call site is the shared
    // reader (read-body.ts), which owns req.formData() AND the raw fallback
    // transport's arrayBuffer read, so the precheck ahead of it covers both
    // wire formats at once.
    for (const lane of [
      "src/app/api/work/submissions/route.ts",
      "src/app/api/work/submissions/[id]/update/route.ts",
    ]) {
      const src = readFileSync(lane, "utf8");
      const clAt = src.indexOf('req.headers.get("content-length")');
      const readAt = src.indexOf("await readWorkBody(");
      assert.ok(
        clAt > 0 && readAt > clAt,
        `${lane} checks Content-Length before buffering the body`
      );
    }

    // All three intake lanes store the durable copy at the accept seam.
    for (const lane of [
      "src/app/api/work/submissions/route.ts",
      "src/app/api/work/submissions/[id]/update/route.ts",
      "src/lib/work/email-intake.ts",
    ]) {
      assert.ok(
        readFileSync(lane, "utf8").includes("await storeArchiveFiles("),
        `${lane} persists the upload into the archive store at accept time`
      );
    }
    // The email lane's own size reject stays lane-truthful: never a bare
    // promise of the shared 100 MB cap by email.
    const intakeSrc2 = readFileSync("src/lib/work/email-intake.ts", "utf8");
    assert.ok(
      intakeSrc2.includes("Email also cannot carry packages anywhere near that size"),
      "the email-lane size reject says mail carries less than the shared cap"
    );
  }

  // ── §5.16 archive-store cleanup + weekly storage report (2026-08-19) ──
  {
    // Monday-14:00-UTC due math (nextStorageReportDueMs): strictly-after
    // semantics so a boundary stamp waits a full week; pure UTC in and out,
    // so DST is irrelevant by construction.
    const DAY = 86_400_000;
    const mon14 = Date.UTC(2026, 7, 17, 14); // 2026-08-17 14:00 UTC
    assert.equal(new Date(mon14).getUTCDay(), 1, "fixture is a Monday");
    assert.equal(
      nextStorageReportDueMs(mon14),
      mon14 + 7 * DAY,
      "a stamp exactly on the boundary is due a full week later (strict)"
    );
    assert.equal(
      nextStorageReportDueMs(mon14 - 1),
      mon14,
      "one ms before the boundary is due at it"
    );
    assert.equal(
      nextStorageReportDueMs(Date.UTC(2026, 7, 16, 20)),
      mon14,
      "a Sunday-evening stamp is due the next day at 14:00 UTC"
    );
    assert.equal(
      nextStorageReportDueMs(Date.UTC(2026, 7, 17, 15)),
      mon14 + 7 * DAY,
      "Monday 15:00 UTC rolls to next Monday"
    );
    assert.equal(
      nextStorageReportDueMs(Date.UTC(2026, 7, 11, 9)),
      mon14,
      "a Tuesday-morning stamp is due the following Monday"
    );
    // Across the March clock changes the boundary stays Monday 14:00 UTC.
    const springDue = nextStorageReportDueMs(Date.UTC(2027, 2, 12, 14));
    assert.equal(new Date(springDue).getUTCDay(), 1, "due day stays Monday");
    assert.equal(new Date(springDue).getUTCHours(), 14, "due hour stays 14 UTC");

    // Byte formatting: decimal units so the 100 MB cap reads as 100 MB;
    // up to two decimals, trailing zeros trimmed.
    assert.equal(formatByteSize(0), "0 B");
    assert.equal(formatByteSize(999), "999 B");
    assert.equal(formatByteSize(1000), "1 KB");
    assert.equal(formatByteSize(1234), "1.23 KB");
    assert.equal(formatByteSize(WORK_CAPS.uploadMaxBytes), "100 MB");
    assert.equal(formatByteSize(987_654_321), "987.65 MB");
    assert.equal(formatByteSize(1_500_000_000), "1.5 GB");
    assert.equal(formatByteSize(-5), "0 B");

    // The admin storage DELETE route: verifiedWebAdmin BEFORE the rate
    // limit (the [id] DELETE sibling's order), the destructive-verb 10/min
    // window, and the ledger-stamping primitive.
    const storageRouteSrc = readFileSync(
      "src/app/api/work/admin/storage/[id]/route.ts",
      "utf8"
    );
    const gateAt = storageRouteSrc.indexOf("verifiedWebAdmin(user)");
    const limitAt = storageRouteSrc.indexOf(
      "rateLimit(`work:storage-delete:"
    );
    assert.ok(
      gateAt > 0 && limitAt > gateAt,
      "storage DELETE checks verifiedWebAdmin before the rate limit"
    );
    assert.ok(
      /rateLimit\(`work:storage-delete:\$\{user\.userId\}`, 60, 10\)/.test(
        storageRouteSrc
      ),
      "storage DELETE keeps the destructive-verb 10/min window"
    );
    assert.ok(
      storageRouteSrc.includes("deleteStoredArchive("),
      "storage DELETE goes through the stamp-then-unlink primitive"
    );

    // Weekly report: the stamp write (claim) precedes the send in the tick,
    // so a failed send waits for next Monday instead of looping hourly.
    const reportSrc = readFileSync("src/lib/work/storage-report.ts", "utf8");
    const claimAt = reportSrc.indexOf("await setMeta(STAMP_KEY");
    const sendAt = reportSrc.indexOf("await sendStorageReport()");
    assert.ok(
      claimAt > 0 && sendAt > claimAt,
      "storage report claims the stamp BEFORE sending"
    );
    assert.ok(
      reportSrc.includes("sendGovernanceEmail("),
      "storage report sends through the signed governance seam"
    );
    assert.ok(
      !/[–—]/.test(reportSrc),
      "no em or en dashes in the storage report module"
    );
    assert.ok(
      reportSrc.includes("oneLine(f.title)"),
      "report titles pass oneLine so an embedded newline cannot forge lines"
    );

    // Console honesty (refutation M1/M7): the storage island's last-copy
    // confirm admits unrecoverability, the page derives lastCopy from the
    // rowHasBytes existence bit, and every submission-Delete confirm names
    // the retained store files.
    const islandSrc = readFileSync(
      "src/app/admin/work/storage-actions-client.tsx",
      "utf8"
    );
    assert.ok(
      islandSrc.includes("LAST copy anywhere") &&
        islandSrc.includes("cannot be recovered after deletion"),
      "last-copy delete confirms state unrecoverability plainly"
    );
    const adminPageSrc = readFileSync("src/app/admin/work/page.tsx", "utf8");
    assert.ok(
      adminPageSrc.includes("f.submissionId === null || !f.rowHasBytes"),
      "lastCopy = submission gone OR row bytea cleared"
    );
    assert.ok(
      readFileSync("src/app/admin/work/actions-client.tsx", "utf8").includes(
        "remain in the archive store"
      ),
      "submission-Delete confirms say stored files remain until cleaned (M7)"
    );
  }

  // ---- §5.16 archive backfill/import ops scripts (2026-08-19, refuted
  // and hardened same day): pure pins for the extracted planning/gating
  // helpers plus source-scrape tripwires for the invariants types cannot
  // hold (the backfill never clears bytea; admin cleanup is final for the
  // scripted lanes; the clearing transaction now proves disk==row by
  // hash, not just name+size+stat). ----
  {
    const sid = "123e4567-e89b-42d3-a456-426614174000";
    const live = (relPath: string, fileName: string, bytes: number) => ({
      relPath,
      fileName,
      bytes,
      deleted: false,
    });
    const gone = (relPath: string, fileName: string, bytes: number) => ({
      relPath,
      fileName,
      bytes,
      deleted: true,
    });

    // Per-FILE plan (refutation M3): empty ledger stores every slot.
    assert.deepEqual(
      planRowBackfill(
        sid,
        [
          { slot: 0, name: "pkg.zip", bytes: 10 },
          { slot: 1, name: "SKILL.md", bytes: 5 },
        ],
        []
      ).map((p) => p.action),
      ["store", "store"]
    );
    // A live match skips ONLY its own slot; the other still stores (the
    // half-stored row completes instead of wedging).
    assert.deepEqual(
      planRowBackfill(
        sid,
        [
          { slot: 0, name: "pkg.zip", bytes: 10 },
          { slot: 1, name: "SKILL.md", bytes: 5 },
        ],
        [live(`${sid}/00-pkg.zip`, "pkg.zip", 10)]
      ).map((p) => p.action),
      ["skip-live", "store"]
    );
    // Consuming match: identical name+bytes in both slots, ONE live row -
    // it satisfies exactly one expected file, never two.
    assert.deepEqual(
      planRowBackfill(
        sid,
        [
          { slot: 0, name: "a.md", bytes: 5 },
          { slot: 1, name: "a.md", bytes: 5 },
        ],
        [live(`${sid}/00-a.md`, "a.md", 5)]
      ).map((p) => p.action),
      ["skip-live", "store"]
    );
    // Admin cleanup is FINAL (refutation M1): a deleted ledger row at the
    // slot's minted rel_path is disclosed and skipped, NEVER re-filed
    // (work_archive_rel_path_uq is a FULL unique index; the insert would
    // collide and the collision handler unlinks the fresh file).
    assert.deepEqual(
      planRowBackfill(
        sid,
        [{ slot: 0, name: "pkg.zip", bytes: 10 }],
        [gone(`${sid}/00-pkg.zip`, "pkg.zip", 10)]
      ).map((p) => p.action),
      ["skip-deleted"]
    );
    // ... regardless of whether the deleted row's bytes match.
    assert.deepEqual(
      planRowBackfill(
        sid,
        [{ slot: 0, name: "pkg.zip", bytes: 10 }],
        [gone(`${sid}/00-pkg.zip`, "pkg.zip", 99)]
      ).map((p) => p.action),
      ["skip-deleted"]
    );
    // A LIVE row occupying the rel_path without matching is a conflict
    // for a human, never an overwrite.
    assert.deepEqual(
      planRowBackfill(
        sid,
        [{ slot: 0, name: "pkg.zip", bytes: 10 }],
        [live(`${sid}/00-pkg.zip`, "pkg.zip", 99)]
      ).map((p) => p.action),
      ["conflict"]
    );
    // A row that never stamped archive_bytes matches on name alone.
    assert.deepEqual(
      planRowBackfill(
        sid,
        [{ slot: 0, name: "pkg.zip", bytes: null }],
        [live(`${sid}/00-pkg.zip`, "pkg.zip", 42)]
      ).map((p) => p.action),
      ["skip-live"]
    );

    // Byte-less row classification.
    assert.equal(byteLessRowClass([live("x", "x", 1)]), "ledgered");
    assert.equal(byteLessRowClass([gone("x", "x", 1)]), "admin-cleaned");
    assert.equal(
      byteLessRowClass([gone("x", "x", 1), live("y", "y", 2)]),
      "ledgered"
    );
    assert.equal(byteLessRowClass([]), "needs-recovery");

    // work:import argv contract: at least one of --file/--md.
    const full = parseImportArgs([
      sid,
      "--file",
      "/tmp/pkg.zip",
      "--md",
      "/tmp/SKILL.md",
      "--force",
      "--yes",
    ]);
    assert.deepEqual(full, {
      ok: true,
      args: {
        id: sid,
        file: "/tmp/pkg.zip",
        md: "/tmp/SKILL.md",
        extra: [],
        force: true,
        yes: true,
      },
    });
    const mdOnly = parseImportArgs([sid, "--md", "/tmp/SKILL.md"]);
    assert.ok(
      mdOnly.ok && mdOnly.args.file === null && mdOnly.args.md === "/tmp/SKILL.md",
      "a standalone md import is valid (slot 01, md_sha256-gated)"
    );
    const fileOnly = parseImportArgs(["--file", "a.zip", sid]);
    assert.ok(fileOnly.ok && fileOnly.args.md === null && !fileOnly.args.force);
    assert.ok(
      !parseImportArgs([sid]).ok,
      "at least one of --file/--md is required"
    );
    assert.ok(!parseImportArgs(["--file", "a.zip"]).ok, "uuid is required");
    assert.ok(
      !parseImportArgs(["not-a-uuid", "--file", "a.zip"]).ok,
      "a malformed id is refused, not passed to the DB"
    );
    assert.ok(
      !parseImportArgs([sid, "--file", "--yes"]).ok,
      "--file must not swallow a following flag as its value"
    );
    assert.ok(
      !parseImportArgs([sid, "--md", "--force"]).ok,
      "--md must not swallow a following flag as its value"
    );
    assert.ok(
      !parseImportArgs([sid, "--file", "a.zip", "--frce"]).ok,
      "a typo'd flag is refused, never a silent positional"
    );
    assert.ok(
      !parseImportArgs([sid, "--file", "a.zip", "extra"]).ok,
      "a second positional is refused"
    );

    // The import sha gate, pure (this IS the refusal-precedes-write pin:
    // every verdict is settled in one call over ALL files, and the script
    // writes only when it returns null).
    const shaA = "a".repeat(64);
    const shaB = "b".repeat(64);
    assert.equal(
      importShaRefusal(
        [{ label: "package", localSha256: shaA, recordedSha256: shaA }],
        false
      ),
      null
    );
    assert.equal(
      importShaRefusal(
        [{ label: "package", localSha256: shaA, recordedSha256: null }],
        false
      ),
      null,
      "no recorded sha proceeds (the caller says so)"
    );
    const refusal = importShaRefusal(
      [
        { label: "package", localSha256: shaA, recordedSha256: shaA },
        { label: "md", localSha256: shaA, recordedSha256: shaB },
      ],
      false
    );
    assert.ok(
      refusal !== null &&
        refusal.includes("sha256 mismatch for md") &&
        !refusal.includes("mismatch for package") &&
        refusal.includes(shaA) &&
        refusal.includes(shaB),
      "a mismatch refuses naming only the mismatched file, with both hashes"
    );
    assert.equal(
      importShaRefusal(
        [{ label: "md", localSha256: shaA, recordedSha256: shaB }],
        true
      ),
      null,
      "--force proceeds (the caller prints PROVENANCE UNVERIFIED)"
    );

    const { readFileSync: readOps } = await import("node:fs");
    const backfillSrc = readOps("scripts/work-archive-backfill.ts", "utf8");
    // THE deliberate rule: backfill never clears row bytea. Clearing stays
    // exclusively the publish-time retention transaction; the script must
    // not even reference either clearing primitive, and it never UPDATEs
    // any row at all.
    assert.ok(
      !backfillSrc.includes("clearArchiveData") &&
        !backfillSrc.includes("verifyAndClearRowBytes"),
      "backfill references neither bytea-clearing primitive"
    );
    assert.ok(
      !backfillSrc.includes(".set("),
      "backfill never updates any row (no drizzle .set anywhere)"
    );
    assert.ok(
      backfillSrc.includes("NEVER clears the row's bytea"),
      "backfill states the no-clear rule in its header"
    );
    assert.ok(
      backfillSrc.includes("await storeArchiveFilesAt(") &&
        backfillSrc.includes("planRowBackfill(") &&
        backfillSrc.includes("allArchiveFilesForSubmission("),
      "backfill plans per file (deleted rows seen) and writes slot-explicit"
    );
    assert.ok(
      backfillSrc.includes("pg_try_advisory_lock") &&
        backfillSrc.includes("process.getuid"),
      "backfill takes the shared ops lock and refuses root"
    );

    const importSrc = readOps("scripts/work-archive-import.ts", "utf8");
    const refuseAt = importSrc.indexOf("const refusal = importShaRefusal(");
    const dieAt = importSrc.indexOf("if (refusal) die(refusal)");
    const writeAt = importSrc.indexOf("await storeArchiveFilesAt(");
    assert.ok(
      refuseAt > 0 && dieAt > refuseAt && writeAt > dieAt,
      "import settles ALL sha verdicts through the pure gate, dies on a refusal, and only then writes"
    );
    assert.ok(
      importSrc.lastIndexOf("await storeArchiveFilesAt(") === writeAt,
      "the store write appears exactly once, after the gate"
    );
    assert.ok(
      !importSrc.includes("clearArchiveData") &&
        !importSrc.includes("verifyAndClearRowBytes") &&
        !importSrc.includes("archiveDataById") &&
        !importSrc.includes(".set("),
      "import never reads bytea buffers, never clears, never updates a row"
    );
    assert.ok(
      importSrc.includes("is not null") &&
        importSrc.includes("byte-less rows only"),
      "import refuses rows that still hold bytea (recovery lane only, F1)"
    );
    assert.ok(
      importSrc.includes("allArchiveFilesForSubmission(") &&
        importSrc.includes("cleanup is final"),
      "import refuses per slot on a ledger row, deleted included (cleanup is final at slot granularity since 2026-08-29)"
    );
    assert.ok(
      importSrc.includes("PROVENANCE UNVERIFIED"),
      "--force prints the loud provenance warning"
    );
    assert.ok(
      importSrc.includes("pg_try_advisory_lock") &&
        importSrc.includes("process.getuid"),
      "import takes the shared ops lock and refuses root"
    );

    // Defense in depth (refutation F1b): the clearing transaction hashes
    // the exact bytea it is about to clear and requires the matched ledger
    // row's stored sha256 to EQUAL it - disk==row proven, not assumed.
    const storeSrc3 = readOps("src/lib/work/archive-store.ts", "utf8");
    const vac3 = storeSrc3.slice(
      storeSrc3.indexOf("export async function verifyAndClearRowBytes"),
      storeSrc3.indexOf("export type ArchiveStoreUsage")
    );
    assert.ok(
      vac3.includes('createHash("sha256")'),
      "verify-and-clear hashes the buffers it is about to clear"
    );
    assert.ok(
      storeSrc3.includes("row.sha256 !== e.sha256"),
      "matchAndStat enforces ledger sha == bytea sha when a hash is given"
    );
    assert.ok(
      readOps("src/lib/work/notify.ts", "utf8").includes(
        "verifyAndClearRowBytes(row.id, rowFiles)"
      ),
      "the retention clear passes the BUFFERS, arming the hash check"
    );

    const opsSrc = readOps("scripts/lib/work-archive-ops.ts", "utf8");
    for (const src of [backfillSrc, importSrc, opsSrc])
      assert.ok(!/[–—]/.test(src), "no em or en dashes in the ops scripts");
  }

  // ---------------------------------------------------------------------
  // 2026-08-25 round: the panel's budget, liveness, recovery and copy
  // invariants. All pure, so this NO-DB suite is where they are pinned.
  // ---------------------------------------------------------------------
  {
    const cfg = await import("../src/lib/work/config");
    const {
      FAILED_NEXT_STEPS,
      PANEL_PASS_TAKEOVER_MS,
      PANEL_RECOVERABLE_STAGES,
      PANEL_STAGES,
      WORK_STAGE_LABELS,
      WORK_STATUS_LABELS,
      formatElapsed,
      heartbeatPumpSafe,
      panelBeatBudget,
      panelBrainCallsWorstCase,
      panelFailMessage,
      panelRecoveryPlan,
      panelWorstCaseRunMs,
      queueWaitCopy,
      workStageLine,
      workTerminalLine,
    } = cfg;
    const { ROADMAP_CAPS } = await import("../src/lib/roadmap/config");

    // ---- budget: the admission invariant, with equality ----
    assert.ok(
      WORK_CAPS.panelRunsPerDayDefault * WORK_CAPS.brainCallsWorstCasePerRun <=
        WORK_CAPS.brainCallsPerDayDefault,
      "work admission invariant: runs x worst case <= calls (400 x 18 = 7200)"
    );
    // roadmap/db.ts admitCompanyRun headroom-checks the WORK worst case
    // against the ROADMAP ledger, so the two constants move in lockstep or
    // company admission silently drops from 60 runs a day to 33.
    assert.ok(
      ROADMAP_CAPS.panelRunsPerDayDefault *
        WORK_CAPS.brainCallsWorstCasePerRun <=
        ROADMAP_CAPS.brainCallsPerDayDefault,
      "company admission invariant: 60 x 18 = 1080 <= ROADMAP brain cap"
    );
    // Arming another stage for recovery must be a TEST failure, never a
    // silent overrun of the reservation every admission is made against.
    assert.ok(
      panelBrainCallsWorstCase() <= WORK_CAPS.brainCallsWorstCasePerRun,
      "9 stages + 7 armed recoveries fits inside brainCallsWorstCasePerRun"
    );
    // undici enforces an un-raisable 300 s headersTimeout on callBrain's
    // fetch path, so anything at or above it here is silently inert.
    assert.ok(
      WORK_CAPS.brainTurnTimeoutMs < 300_000,
      "brainTurnTimeoutMs stays under undici's un-raisable headersTimeout"
    );

    // ---- liveness: the heartbeat pump must cover a stage, and STOP ----
    assert.equal(
      heartbeatPumpSafe(),
      true,
      "one missed beat from a DB blip cannot orphan a live row"
    );
    const beats = panelBeatBudget();
    assert.ok(
      beats * WORK_CAPS.panelBeatIntervalMs >=
        WORK_CAPS.brainTurnTimeoutMs +
          WORK_CAPS.panelRecoveryDelayMs +
          WORK_CAPS.panelRecoveryRunBudgetMs,
      "the beat budget covers a full worst-case stage plus its recovery"
    );
    // The bound is the point: an unbounded pump keeps panel_heartbeat_at
    // fresh forever, anotherPanelRunning stays true, drainAction maps busy
    // to stop, and no row in any lane runs again until pm2 restarts.
    assert.ok(
      Number.isFinite(beats) && beats < 40,
      "the beat budget is finite and small: a hung stage still goes stale"
    );
    assert.ok(
      panelWorstCaseRunMs() < PANEL_PASS_TAKEOVER_MS,
      "a healthy worst-case run never trips the drain's pass takeover"
    );

    // ---- panelRecoveryPlan, the whole decision table ----
    const RETENTION_MS = 1_800_000; // stand-in for the module's constant
    const nowRp = Date.now();
    const planBase = {
      recoverable: true,
      dispatchedAtMs: nowRp - 1_000,
      nowMs: nowRp,
      poolRemainingMs: WORK_CAPS.panelRecoveryRunBudgetMs,
      cacheRetentionMs: RETENTION_MS,
    };
    assert.equal(
      panelRecoveryPlan({ ...planBase, reason: "budget" }).attempt,
      false,
      "a ledger refusal is never recovered: the wall does not move"
    );
    assert.equal(
      panelRecoveryPlan({ ...planBase, reason: "timeout", recoverable: false })
        .attempt,
      false,
      "an unarmed stage (4 and 5 tolerate null) never spends the pool"
    );
    assert.equal(
      panelRecoveryPlan({
        ...planBase,
        reason: "timeout",
        poolRemainingMs: WORK_CAPS.panelRecoveryFloorMs - 1,
      }).attempt,
      false,
      "a spent pool stops recovery instead of starting one that cannot finish"
    );
    const freshTimeout = panelRecoveryPlan({ ...planBase, reason: "timeout" });
    assert.equal(freshTimeout.attempt, true, "a fresh timeout is recovered");
    assert.equal(
      freshTimeout.mode,
      "reattach",
      "a timeout re-attaches to the turn the brain may already have finished"
    );
    assert.equal(
      panelRecoveryPlan({
        ...planBase,
        reason: "timeout",
        dispatchedAtMs: nowRp - (RETENTION_MS - 300_000),
      }).attempt,
      false,
      "past the cache horizon a re-POST would bill a SECOND generation"
    );
    for (const reason of ["transport", "parse"] as const) {
      const plan = panelRecoveryPlan({ ...planBase, reason });
      assert.equal(plan.attempt, true, `${reason} is recovered`);
      assert.equal(
        plan.mode,
        "redispatch",
        `${reason} asks again with a FRESH envelope, never the same promptId`
      );
    }

    // ---- copy: one vocabulary, no confident wrong sentence ----
    for (const stage of PANEL_STAGES)
      assert.ok(
        WORK_STAGE_LABELS[stage],
        `every panel stage has a reader-facing label (${stage})`
      );
    assert.equal(
      Object.keys(WORK_STAGE_LABELS).length,
      PANEL_STAGES.length,
      "WORK_STAGE_LABELS carries no label for a stage that does not exist"
    );
    for (const stage of PANEL_RECOVERABLE_STAGES)
      assert.ok(
        (PANEL_STAGES as readonly string[]).includes(stage),
        `every armed stage is a real stage (${stage})`
      );
    assert.equal(
      workStageLine("no such stage", 2, 9),
      "Step 3 of 9",
      "an unknown stage degrades to the bare count, with no trailing separator"
    );
    assert.equal(formatElapsed(-5), "0s", "a skewed clock clamps to 0s");
    assert.equal(formatElapsed(253_000), "4m 13s", "minutes and seconds");
    const ALL_STATUSES = [
      "received",
      "running",
      "published",
      "held",
      "failed",
      "pending_approval",
      "superseded",
    ] as const;
    for (const status of ALL_STATUSES) {
      assert.ok(
        WORK_STATUS_LABELS[status],
        `every status has a badge label (${status})`
      );
      if (status === "received" || status === "running") continue;
      // EVERY reachable terminal status gets a lane-aware closing sentence,
      // so the tracker never leaves the last running sentence on screen.
      for (const lane of ["internal", "company"] as const)
        assert.ok(
          workTerminalLine(status, lane).length > 0,
          `terminal line for ${status} / ${lane}`
        );
    }
    assert.equal(
      workTerminalLine("running", "internal"),
      "",
      "a running row has no terminal line to freeze on screen"
    );
    // scope.ts rule: company copy never names Adam, /admin or /work/submit.
    for (const forbidden of ["Adam", "/admin", "/work/submit"])
      assert.ok(
        !FAILED_NEXT_STEPS.company.includes(forbidden),
        `FAILED_NEXT_STEPS.company never says "${forbidden}"`
      );
    // panel_error is projected VERBATIM to the submitter, so its builder must
    // emit plain prose: no machine tag, no dashes, and never the old literal
    // that manufactured the budget hypothesis.
    for (const reason of [
      "timeout",
      "transport",
      "parse",
      "budget",
      "no_document",
      "crash",
    ] as const) {
      const message = panelFailMessage("synthesis", reason);
      assert.ok(message.length > 0, `panelFailMessage(${reason}) says something`);
      assert.ok(
        !message.includes("#") && !/[–—]/.test(message),
        `panelFailMessage(${reason}) carries no machine tag and no dash`
      );
      assert.ok(
        !message.includes("or over budget"),
        `panelFailMessage(${reason}) never blames the budget by reflex`
      );
    }
    assert.ok(
      queueWaitCopy("claim") === queueWaitCopy(null) &&
        queueWaitCopy(null).length > 0,
      "an unmapped queue reason renders the generic sentence, never a token"
    );
    // Every exported string in config.ts, including the ones inside exported
    // records and arrays (roadmap-tests.ts precedent).
    for (const [key, value] of Object.entries(cfg)) {
      if (typeof value === "string")
        assert.ok(!/[–—]/.test(value), `config export ${key} has no em/en dash`);
      else if (value && typeof value === "object" && !(value instanceof RegExp))
        for (const [k2, v2] of Object.entries(value as Record<string, unknown>))
          if (typeof v2 === "string")
            assert.ok(
              !/[–—]/.test(v2),
              `config export ${key}.${k2} has no em/en dash`
            );
    }

    // ---- source scrapes: the shape the compile cannot see ----
    const { readFileSync: readSrc } = await import("node:fs");
    const panelSrc = readSrc("src/lib/work/panel.ts", "utf8");
    assert.ok(
      /import\s*\{[^}]*\bPANEL_STAGES\b[^}]*\}\s*from\s*"\.\/config"/s.test(
        panelSrc
      ),
      "panel.ts takes its stage list from config.ts, not a local copy"
    );
    assert.ok(
      !panelSrc.includes("const stages = ["),
      "the local stages array is gone (it renamed repair to adjudication)"
    );
    // A missed failPanel site would read .updated off a void return, skip the
    // email and write the old machine string. Prove by scrape, not by memory.
    const failPanelHits = [...panelSrc.matchAll(/failPanel\(/g)];
    assert.equal(
      failPanelHits.length,
      1,
      "failPanel has exactly one caller, and it is failRun"
    );
    const failRunAt = panelSrc.indexOf("async function failRun");
    assert.ok(failRunAt > 0, "failRun exists");
    assert.ok(
      (failPanelHits[0].index ?? -1) > failRunAt,
      "the one failPanel call sits inside failRun"
    );
    const dbSrc = readSrc("src/lib/work/db.ts", "utf8");
    const failPanelSrc = dbSrc.slice(
      dbSrc.indexOf("export async function failPanel")
    );
    assert.ok(
      failPanelSrc
        .slice(0, failPanelSrc.indexOf("\nexport "))
        .includes("panelHeartbeatAt: null"),
      "failPanel NULLs the heartbeat, so Retry is not inert for four minutes"
    );

    // ---- statusView: the structured progress the tracker formats ----
    const runningBase = {
      ...baseRow,
      status: "running",
      heldAt: null,
      panelError: null,
      panelHeartbeatAt: new Date(),
      panelStartedAt: new Date(Date.now() - 300_000),
    };
    const slowView = statusView({
      ...runningBase,
      panelProgressJson: JSON.stringify({
        stage: "synthesis",
        stageIndex: 5,
        stageCount: 9,
        stageStartedAtMs: Date.now() - 200_000,
      }),
    });
    assert.equal(slowView.stage, "synthesis", "statusView projects the RAW stage");
    assert.equal(slowView.stageIndex, 5, "statusView projects the step index");
    assert.equal(slowView.stageCount, 9, "statusView projects the step count");
    assert.equal(slowView.slow, true, "a long-running STAGE reads as slow");
    assert.ok((slowView.elapsedMs ?? 0) > 0, "elapsed measures the RUN");
    assert.ok(slowView.serverNowMs > 0, "the client gets this box's clock");
    // slow is derived from the stage START, never from panel_heartbeat_at:
    // the pump refreshes that column every 45 s, so its age no longer
    // measures progress and a heartbeat-derived slow could never fire.
    const freshView = statusView({
      ...runningBase,
      panelProgressJson: JSON.stringify({
        stage: "synthesis",
        stageIndex: 5,
        stageCount: 9,
        stageStartedAtMs: Date.now(),
      }),
    });
    assert.equal(freshView.slow, false, "a fresh stage is not slow");
    const queuedView = statusView(
      { ...baseRow, status: "received", heldAt: null, panelError: null },
      { queueReason: "deploy" }
    );
    assert.equal(queuedView.stage, null, "a queued row names no stage");
    assert.equal(
      queuedView.queueReason,
      "deploy",
      "a received row carries the queue-wait reason"
    );
    assert.ok(
      (queuedView.elapsedMs ?? 0) >= 0,
      "a queued row's elapsed measures the ROW age"
    );
    assert.equal(
      statusView({ ...runningBase }, { queueReason: "deploy" }).queueReason,
      null,
      "only a received row carries a queue reason"
    );
    const failedView = statusView({
      ...baseRow,
      status: "failed",
      heldAt: null,
      panelError: panelFailMessage("synthesis", "timeout"),
    });
    assert.ok(
      failedView.error && !failedView.error.includes("#"),
      "a failed row's error is plain prose, with no machine tag"
    );
  }

  // ---------------------------------------------------------------------
  // 2026-08-27 round: "Time saved per month for you" (§5.16 / §5.18). The
  // whole feature funnels through ONE pure module, so this is where its
  // contract is pinned: the optional field on the submission form, the
  // create route, the afterwards-editor route, the published card line and
  // the scorecard column all call these four functions and nothing else. A
  // parser that drifts from the form's `max` or from migration 0049's CHECK
  // turns a typo into a 500, so the ceiling is asserted against both.
  // ---------------------------------------------------------------------
  {
    const {
      TIME_SAVED_MAX_HOURS,
      TIME_SAVED_MAX_MINUTES,
      formatTimeSavedCompact,
      formatTimeSavedPhrase,
      hoursFieldValue,
      parseTimeSavedHours,
    } = await import("../src/lib/work/time-saved");

    // Narrowing helpers. The parser returns a union and every assertion
    // below wants one half of it; asserting the half FIRST is deliberate,
    // because the `if (r.ok)` shape used elsewhere in this file silently
    // runs zero assertions when the parser regresses.
    const minutesOf = (raw: unknown): number | null => {
      const r = parseTimeSavedHours(raw);
      assert.ok(
        r.ok,
        `expected ${String(raw)} to parse, refused with: ${r.ok ? "" : r.message}`
      );
      return r.ok ? r.minutes : null;
    };
    const refusalFor = (raw: unknown): string => {
      const r = parseTimeSavedHours(raw);
      assert.ok(!r.ok, `expected ${String(raw)} to be refused`);
      return r.ok ? "" : r.message;
    };

    // ---- the two constants are one ceiling ----
    assert.equal(
      TIME_SAVED_MAX_MINUTES,
      TIME_SAVED_MAX_HOURS * 60,
      "the hours cap and the minutes cap are the same bound in two units"
    );

    // ---- parseTimeSavedHours: "not reported" has several spellings ----
    // Absent and empty are both real inputs: FormData.get() returns null for
    // a field the form never set (the field is optional, and update-lane
    // submissions never render it at all), and an untouched input posts "".
    assert.equal(minutesOf(undefined), null, "absent field is not reported");
    assert.equal(minutesOf(null), null, "null field is not reported");
    assert.equal(minutesOf(""), null, "empty string is not reported");
    assert.equal(minutesOf("   "), null, "whitespace only is not reported");
    // Zero CLEARS instead of refusing. The row editor pre-fills the current
    // hours, so typing 0 and saving is the only gesture anyone reaches for
    // when they want a wrong figure off a published card; a refusal there
    // would strand it with no way to remove it.
    assert.equal(minutesOf("0"), null, "0 hours clears back to not reported");
    assert.equal(minutesOf(0), null, "numeric 0 clears too");

    // ---- hours in, whole minutes out ----
    assert.equal(minutesOf("6"), 360, "6 hours stores as 360 minutes");
    assert.equal(minutesOf(6), 360, "a JSON number reaches the same value");
    assert.equal(minutesOf("6.5"), 390, "half hours survive as minutes");
    assert.equal(minutesOf(" 6.5 "), 390, "a pasted value with spaces trims");
    assert.equal(minutesOf("0.25"), 15, "a quarter of an hour lands on 15m");
    // Values no step grid would have allowed. The round-2 fix moved every
    // time-saved input to step="any" precisely because the submission form
    // is a real <form onSubmit> with no noValidate: under step=0.25 the
    // BROWSER refused 6.3 ("the two nearest valid values are 6.25 and 6.5")
    // after the whole form was filled in and a package attached, for a
    // value this parser has always accepted and the inline row editor (not
    // inside a form) saved without a word. These pin what the field can now
    // actually send, so the parser and the input can never disagree again.
    assert.equal(minutesOf("6.3"), 378, "6.3 hours, the value step=0.25 refused");
    assert.equal(minutesOf("0.1"), 6, "a tenth of an hour is 6 minutes");
    assert.equal(
      minutesOf("6.333333"),
      380,
      "a long decimal rounds to whole minutes rather than being refused"
    );
    // Clamped to at least one minute: 0.005 h rounds to 0 minutes, and
    // storing THAT as null would tell a submitter who typed a real number
    // that their report vanished. One minute is the honest floor and is
    // exactly the CHECK's lower bound.
    assert.equal(minutesOf(0.005), 1, "a sliver of an hour records as 1m");
    assert.equal(
      minutesOf(TIME_SAVED_MAX_HOURS),
      TIME_SAVED_MAX_MINUTES,
      "the ceiling itself is accepted, not refused off by one"
    );

    // ---- refusals, each with copy the reader can act on ----
    assert.match(
      refusalFor("abc"),
      /number of hours/,
      "unparseable text names the shape it wanted"
    );
    // Refused BY TYPE, never coerced: Number(true) is 1 and Number([]) is 0,
    // and both would reach the card as a deliberate report.
    assert.match(refusalFor(true), /number of hours/, "a boolean is refused");
    assert.match(refusalFor([]), /number of hours/, "an array is refused");
    assert.match(refusalFor({}), /number of hours/, "an object is refused");
    assert.match(refusalFor(Number.NaN), /number of hours/, "NaN is refused");
    assert.match(
      refusalFor(Number.POSITIVE_INFINITY),
      /number of hours/,
      "Infinity is refused before the range check can pass it"
    );
    assert.match(
      refusalFor("-2"),
      /negative/,
      "a negative names the empty-field alternative"
    );
    const overCap = refusalFor("745");
    assert.match(
      overCap,
      new RegExp(String(TIME_SAVED_MAX_HOURS)),
      "the over-cap refusal names the actual bound, so a typo is diagnosable"
    );
    assert.match(overCap, /31-day month/, "and says where the bound comes from");
    assert.equal(
      refusalFor(745),
      overCap,
      "a JSON number over the cap is refused identically to the string"
    );
    // These messages are visible site copy on three surfaces (the form's
    // inline error, the create route's 400, the row editor's alert), so the
    // owner's em-dash ban reaches them.
    for (const m of [
      refusalFor("abc"),
      refusalFor("-2"),
      overCap,
    ])
      assert.ok(!/[–—]/.test(m), "no em or en dashes in a refusal message");

    // ---- formatTimeSavedPhrase: prose for the card and the row line ----
    // null renders NOTHING anywhere. A "0 minutes a month" line on a
    // published card would read as a claim that the work saves no time,
    // which is the opposite of "nobody reported one".
    assert.equal(formatTimeSavedPhrase(null), null, "not reported prints nothing");
    assert.equal(formatTimeSavedPhrase(0), null, "a stored 0 prints nothing");
    assert.equal(formatTimeSavedPhrase(-5), null, "so does a negative");
    assert.equal(formatTimeSavedPhrase(1), "1 minute a month", "singular minute");
    assert.equal(formatTimeSavedPhrase(45), "45 minutes a month");
    assert.equal(formatTimeSavedPhrase(60), "1 hour a month", "singular hour");
    assert.equal(formatTimeSavedPhrase(61), "1 hour 1 minute a month");
    assert.equal(formatTimeSavedPhrase(90), "1 hour 30 minutes a month");
    assert.equal(formatTimeSavedPhrase(360), "6 hours a month");
    assert.equal(formatTimeSavedPhrase(390), "6 hours 30 minutes a month");
    // The card reads "Time saved · {phrase}, reported by the submitter", so
    // the phrase must never end in punctuation or start with a capital.
    for (const m of [1, 45, 60, 90, 360, 390, TIME_SAVED_MAX_MINUTES]) {
      const phrase = formatTimeSavedPhrase(m) ?? "";
      assert.match(phrase, /a month$/, "every phrase ends in the period it covers");
      assert.ok(!/[–—]/.test(phrase), "no em or en dashes in card copy");
    }

    // ---- formatTimeSavedCompact: the scorecard cell ----
    assert.equal(formatTimeSavedCompact(390), "6h 30m");
    assert.equal(formatTimeSavedCompact(360), "6h", "whole hours drop the 0m");
    assert.equal(formatTimeSavedCompact(45), "45m", "under an hour drops the 0h");
    assert.equal(formatTimeSavedCompact(1), "1m");
    // A bare "0", not "0m": the cell sits beside Published's faint zero and
    // must read the same way, as a not-yet rather than a measurement.
    assert.equal(formatTimeSavedCompact(0), "0", "an empty sum is a bare 0");
    assert.equal(
      formatTimeSavedCompact(Number.NaN),
      "0",
      "a decoding accident renders as 0 rather than NaN in a table cell"
    );

    // ---- hoursFieldValue: the editor's pre-fill, and the round trip ----
    assert.equal(hoursFieldValue(null), "", "nothing reported pre-fills empty");
    assert.equal(hoursFieldValue(0), "", "so does a stored 0");
    assert.equal(hoursFieldValue(390), "6.5");
    assert.equal(hoursFieldValue(360), "6", "no trailing .0 to strip");
    assert.equal(hoursFieldValue(45), "0.75");
    for (const m of [1, 15, 45, 60, 90, 360, 390, TIME_SAVED_MAX_MINUTES]) {
      const field = hoursFieldValue(m);
      // At most two decimals. The step=0.25 grid this used to defend against
      // is gone (every input is step="any" since the round-2 fix, so no
      // browser rejects its own pre-filled value for being off a grid any
      // more), but the reason survives in a plainer form: minutes/60 lands
      // float tails like "6.500000000000001" in the field, and a person
      // asked to correct THAT is reading a machine's number instead of the
      // one they typed. Two decimals is also exactly what the round trip
      // below survives, which is the property that actually has to hold.
      assert.ok(
        /^\d+(\.\d{1,2})?$/.test(field),
        `pre-fill ${field} is a plain 2-decimal number`
      );
      // Round trip: what the editor shows, saved again unchanged, must come
      // back as the same figure. Minutes are the storage resolution, so one
      // minute of slack is the honest tolerance.
      const back = minutesOf(field);
      assert.ok(
        back !== null && Math.abs(back - m) <= 1,
        `${m} minutes round-trips through "${field}" (got ${String(back)})`
      );
    }

    // ---- the invariants the compiler cannot see ----
    const { readFileSync } = await import("node:fs");
    // The module constant and migration 0049's CHECK are two spellings of
    // one ceiling. If they drift, the route hands postgres a value the
    // constraint refuses and the submitter gets a 500 instead of the
    // sentence the parser would have handed them.
    const migSrc = readFileSync(
      "drizzle/migrations/0049_work_time_saved.sql",
      "utf8"
    );
    const ck =
      /time_saved_minutes >= (\d+) AND time_saved_minutes <= (\d+)/.exec(migSrc);
    assert.ok(ck, "0049 still carries the range CHECK");
    assert.equal(
      Number(ck?.[1]),
      1,
      "the CHECK's floor is the parser's 1-minute clamp"
    );
    assert.equal(
      Number(ck?.[2]),
      TIME_SAVED_MAX_MINUTES,
      "the CHECK's ceiling is TIME_SAVED_MAX_MINUTES"
    );
    assert.ok(
      migSrc.includes("ADD COLUMN IF NOT EXISTS"),
      "0049 survives a hand-applied VM catch-up (the 0044 lesson)"
    );

    // The scorecard sum is PUBLISHED-ONLY by the same predicate as the
    // Published column. That is not a preference: the page's standing
    // doctrine is that a held or failed row never surfaces, so a nonzero
    // time-saved cell on a person with 0 published would announce exactly
    // what the page exists not to reveal. The same predicate also drops
    // superseded rows, so a card and its predecessor never both count.
    const roadmapDbSrc = readFileSync("src/lib/roadmap/db.ts", "utf8");
    const aggStart = roadmapDbSrc.indexOf("timeSaved: sql<number>");
    assert.ok(aggStart > 0, "the scorecard still sums time_saved_minutes");
    const agg = roadmapDbSrc.slice(
      aggStart,
      roadmapDbSrc.indexOf(".groupBy(", aggStart)
    );
    assert.ok(
      agg.includes('eq(W.status, "published")'),
      "the time-saved sum rides the published-only where clause"
    );
    assert.ok(
      agg.includes("::int"),
      "sum() over an integer column is bigint and arrives as a STRING through noopDecoder; the ::int cast is what keeps callers from concatenating"
    );

    // The card line names its source. Everything else on that card came out
    // of the panel and /work opens by promising every claim is drawn from
    // the submitted documents; this number is typed by the submitter and no
    // review stage checks it, so the attribution is what keeps the promise
    // true. Deleting it would be invisible to types and to every other test.
    const cardSrc = readFileSync("src/components/work-card.tsx", "utf8");
    assert.ok(
      cardSrc.includes("Time saved · {timeSaved}, reported by the submitter"),
      "the published card attributes the figure to the submitter"
    );
  }

  // ---------------------------------------------------------------------
  // 2026-08-27 round 2: the refuter panel's findings on the same feature.
  // Everything below is a SOURCE scrape rather than a call, because each
  // invariant lives in the SHAPE of the code - which function carries an
  // expression, which route deliberately does NOT pass a field, which
  // branch is tested first - and no value a unit test can pass in would
  // observe any of it. They exist because every one of these decisions
  // reads like an oversight to a later reader, and "tidying" any of them
  // puts back a defect that shipped once already.
  // ---------------------------------------------------------------------
  {
    const { readFileSync } = await import("node:fs");
    // JSX copy wraps across lines at the formatter's whim, so every prose
    // assertion below runs against a whitespace-flattened copy. Scraping
    // the raw text would fail on a reflow that changed nothing.
    const flat = (s: string) => s.replace(/\s+/g, " ");

    // ---- the time-saved figure is inherited at SWAP time, not at intake ----
    // The first shape of this feature copied the parent's minutes onto the
    // child inside the update ROUTE, at intake. That was wrong three ways
    // and all three were live: (1) the time-saved route is deliberately
    // status-blind, so the owner can correct the figure on the LIVE parent
    // for the whole time an update waits for approval, and an intake
    // snapshot silently reverted that correction at the swap; (2) the EMAIL
    // update lane never runs the web route at all, so an emailed update
    // republished the card with the figure GONE; (3) an update may be
    // submitted by someone else entirely (an admin, or any earlier
    // participant in the supersede chain), and the intake copy republished
    // one person's self-reported number under another person's row, summed
    // it into that person's scorecard column under a disclosure paragraph
    // saying each person reports their own, and left the original reporter
    // unable to take it back (the row is not theirs any more, so their POST
    // 404s). publishWithSupersede is the ONE primitive every swap path
    // reaches, so the rule lives there and nowhere else.
    const dbSrc = readFileSync("src/lib/work/db.ts", "utf8");
    const swapStart = dbSrc.indexOf(
      "export async function publishWithSupersede"
    );
    assert.ok(swapStart > 0, "publishWithSupersede is still the swap primitive");
    const swapEnd = dbSrc.indexOf("export type UpdateFinishResult", swapStart);
    assert.ok(
      swapEnd > swapStart,
      "publishWithSupersede still ends where UpdateFinishResult begins"
    );
    const swap = dbSrc.slice(swapStart, swapEnd);
    assert.ok(
      swap.includes("child.timeSavedMinutes ??"),
      "the child's OWN figure wins at the swap: the time-saved route is status-blind, so an updater may have reported one deliberately while the child waited"
    );
    assert.ok(
      swap.includes("sameEmail(parent.submitterEmail, child.submitterEmail)"),
      "the parent's figure is inherited ONLY when both rows belong to the same person"
    );
    assert.ok(
      swap.includes("parent.timeSavedMinutes"),
      "and it is read from the FOR UPDATE-locked parent, so a correction made on the live card while the update waited is what publishes"
    );
    assert.ok(
      /import \{ sameEmail \} from "\.\/transfer"/.test(dbSrc),
      "sameEmail rides the pure transfer.ts (no cycle back through the DB layer, unlike scope.ts's type-only import)"
    );

    // The update route must carry NO time-saved field at all. A negative
    // assertion is the only shape that works here: the defect was a line
    // that looked helpful, and nothing about its absence is visible to the
    // compiler. The comment that replaced it has to keep naming where the
    // inheritance went, or the next reader re-adds the line.
    const updateRouteSrc = readFileSync(
      "src/app/api/work/submissions/[id]/update/route.ts",
      "utf8"
    );
    assert.ok(
      !updateRouteSrc.includes("timeSavedMinutes"),
      "the update route no longer snapshots the parent's figure at intake"
    );
    assert.ok(
      updateRouteSrc.includes("publishWithSupersede"),
      "and it still says where that inheritance moved to"
    );

    // Rollback is the deliberate non-participant: it DELETEs the child and
    // restores the parent, and its .set() never mentions the column, so the
    // parent keeps the value it always had. Adding the field here would
    // write the child's inherited copy back over the parent's own.
    const rbStart = dbSrc.indexOf(
      "export async function rollbackSwappedUpdate"
    );
    const rbEnd = dbSrc.indexOf("export async function activeUpdateChild", rbStart);
    assert.ok(rbStart > 0 && rbEnd > rbStart, "rollbackSwappedUpdate is intact");
    assert.ok(
      !dbSrc.slice(rbStart, rbEnd).includes("timeSavedMinutes"),
      "rollback leaves the restored parent's own figure alone"
    );

    // ---- step="any" on every time-saved input, all three of them ----
    // The submission form is a real <form onSubmit> with no noValidate, so
    // the browser runs constraint validation BEFORE the submit handler. A
    // step grid there refuses values parseTimeSavedHours accepts, and the
    // inline row editors (not inside a form) accept them, so the same field
    // said two different things about the same number depending on which
    // write moment the person used. min and max stay: they agree with the
    // parser exactly, and they give instant native feedback.
    const formSrc = readFileSync(
      "src/app/work/submit/submission-form.tsx",
      "utf8"
    );
    const submitSrc = readFileSync(
      "src/app/work/submit/submit-client.tsx",
      "utf8"
    );
    const islandSrc = readFileSync(
      "src/app/roadmap/(steps)/work/work-islands.tsx",
      "utf8"
    );
    for (const [name, src] of [
      ["submission-form.tsx", formSrc],
      ["submit-client.tsx", submitSrc],
      ["work-islands.tsx", islandSrc],
    ] as const) {
      assert.ok(
        src.includes('step="any"'),
        `${name}'s time-saved input is step="any"`
      );
      // Braced/quoted forms only: the why-comments in these files still
      // quote the old `step=0.25` while explaining what it broke, and
      // deleting that history to satisfy a regex would be the wrong trade.
      assert.ok(
        !/step=\{0\.25\}|step="0\.25"/.test(src),
        `${name} carries no quarter-hour step grid`
      );
      assert.ok(
        src.includes("TIME_SAVED_MAX_HOURS"),
        `${name} keeps its max at the shared constant, never a hand-typed 744`
      );
    }

    // ---- a superseded row shows the figure, and offers no control ----
    // Both surfaces render superseded rows on purpose: on /work/submit it is
    // the submitter's only remaining surface when the live version belongs
    // to someone else, and the roadmap "In Review" list is not
    // status-filtered at all (mySubmissions selects every row the person
    // owns). isMine() is true for such a row, so the editor used to open
    // there and answer a save with "Saved. This submission reports 6 hours a
    // month." Nothing reads that value: publishedCards() and the scorecard
    // sum both key on status = 'published', which is also what stops a card
    // and the generation it replaced from being counted twice. Held and
    // failed rows deliberately KEEP their editor, because a retry can still
    // publish them and the figure becomes real the moment it does.
    for (const [name, src] of [
      ["submit-client.tsx", submitSrc],
      ["work-islands.tsx", islandSrc],
    ] as const) {
      assert.ok(
        flat(src).includes("as reported on this version"),
        `${name} labels a superseded row's figure as belonging to that version`
      );
      assert.ok(
        flat(src).includes("Nothing reads this figure now."),
        `${name} says plainly that the superseded figure counts nowhere`
      );
      // CONDITIONAL, and pinned as such. The first cut said "The live
      // version carries its own", which is false in the very case that
      // makes a superseded row visible on /work/submit: the live version
      // belongs to someone else, and publishWithSupersede's same-person
      // guard published it with NO figure. Telling a person their number
      // moved across while /work shows no such line, and their scorecard
      // total just fell, is the class of falsehood this suite exists to
      // stop, so assert the sentence does not claim a live figure exists.
      assert.ok(
        !flat(src).includes("The live version carries its own"),
        `${name} does not assert the live version has a figure of its own`
      );
    }
    // Branch ORDER, not just presence: the superseded test has to run
    // BEFORE the isMine() test, because /work/submit's admin all-view
    // resolves no currentId and never runs the dedupe, so a superseded row
    // reaches this block with isMine false and would otherwise fall to the
    // read-only arm by accident rather than by rule.
    const supIdx = submitSrc.indexOf('r.status === "superseded" ? (');
    const mineIdx = submitSrc.indexOf(") : isMine(r) ? (");
    assert.ok(
      supIdx > 0 && mineIdx > supIdx,
      "superseded is decided before ownership, so the all-submissions view gets the same rule"
    );
    assert.ok(
      islandSrc.includes('if (status === "superseded")'),
      "the roadmap island takes the same early return"
    );
    // AFTER the hooks, always. An early return placed above any hook makes
    // React count a different number of hooks on a superseded row than on
    // its neighbours, and the throw lands on the re-render after someone
    // else's router.refresh() rather than on the row that caused it. So:
    // no hook call may appear anywhere BELOW the early return in this
    // component. (TimeSavedEditor is the file's last export, so its body
    // runs to the end of the file.)
    const editorBody = islandSrc.slice(
      islandSrc.indexOf("export function TimeSavedEditor")
    );
    const earlyReturn = editorBody.indexOf('if (status === "superseded")');
    assert.ok(earlyReturn > 0, "TimeSavedEditor still takes the early return");
    assert.ok(
      !/\buse[A-Z]\w*\(/.test(editorBody.slice(earlyReturn)),
      "no hook is called below the superseded early return"
    );
    assert.ok(
      /\buse[A-Z]\w*\(/.test(editorBody.slice(0, earlyReturn)),
      "and the hooks it must sit below are genuinely above it"
    );

    // ---- the editor copy is true on every status it renders under ----
    // These editors render on received, running, held and failed rows, where
    // there is no card and the published-only scorecard counts nothing. The
    // first copy asserted both outright, which made the page lie to exactly
    // the person most likely to be watching it.
    assert.ok(
      flat(submitSrc).includes(
        "Once the card is published the figure shows on it"
      ),
      "/work/submit's editor conditions the promise on publication"
    );
    assert.ok(
      flat(islandSrc).includes(
        "Once your card is published the figure shows on it"
      ),
      "the roadmap editor does too, in company-lane voice"
    );
    assert.ok(
      flat(formSrc).includes("Once your card is published the figure shows"),
      "and so does the submission form's help copy"
    );

    // ---- a poll issued before a save cannot repaint the old number ----
    // refresh() already dropped replies from a scope the reader had left,
    // but had no ORDERING guard: a poll issued before an inline save could
    // land after it and put the pre-save value back under the confirmation
    // saying it saved. If that late reply also carried the row's terminal
    // status, anyActive went false, the 10 s interval was torn down, and
    // nothing ever came to correct it. One monotonic ref carries both halves
    // of staleness in a single predicate.
    assert.ok(
      submitSrc.includes("const refreshSeq = useRef(0)"),
      "refresh() has a monotonic request sequence"
    );
    assert.ok(
      submitSrc.includes("seq === refreshSeq.current") &&
        submitSrc.includes("s === viewRef.current"),
      "and one predicate drops both a stale scope and a stale request"
    );
    assert.ok(
      submitSrc.includes("if (newest()) setLoading(false)"),
      "only the newest request clears the spinner, so a refused or thrown request still clears it and a late reply cannot clear it out from under one still in flight"
    );

    // ---- the row editors have distinguishing accessible names ----
    // A reader with five submissions otherwise meets five buttons whose
    // accessible names are all "Edit time saved", and a screen reader's
    // button list is exactly where identical names stop being usable. The
    // precedent is CountCell's sr-only suffix on the scorecard: the visible
    // label stays short because it sits beside the row it belongs to; the
    // announced one does not, so it carries the title.
    assert.ok(
      flat(submitSrc).includes('<span className="sr-only"> for {r.title}</span>'),
      "/work/submit's toggle announces the row it belongs to"
    );
    assert.ok(
      flat(islandSrc).includes(
        '<span className="sr-only"> time saved for {title}</span>'
      ),
      "the roadmap toggle does too (its visible label is a bare Edit/Add)"
    );
    // The island cannot invent either value, so the page has to hand both
    // down: the title for the name above, the status for the superseded
    // branch. A prop that stops being passed is a silent regression in both.
    const roadmapWorkPageSrc = readFileSync(
      "src/app/roadmap/(steps)/work/page.tsx",
      "utf8"
    );
    assert.ok(
      flat(roadmapWorkPageSrc).includes(
        "<TimeSavedEditor id={row.id} title={row.title} status={row.status} minutes={row.timeSavedMinutes} />"
      ),
      "the roadmap page passes id, title, status and minutes into the island"
    );

    // ---- /work's standing promise is narrowed, not quietly broken ----
    // The section intro has always opened with "Every claim below is drawn
    // from the submitted documents", and it is the reason the card line says
    // "reported by the submitter" at all. A card can now carry a figure no
    // panel stage ever saw, so the promise itself needs the exception named
    // in it. A comma clause, never an em dash (owner ban on visible copy).
    const communitySrc = readFileSync("src/app/work/community.tsx", "utf8");
    assert.ok(
      flat(communitySrc).includes(
        "Every claim below is drawn from the submitted documents, apart from a time saved figure, which is reported by the submitter and labelled that way on the card."
      ),
      "the /work intro names the one claim the panel did not verify"
    );
    // Scoped to the paragraph, not the file: line 11's ordering comment
    // carries a legitimate em dash, and prose comments are not site copy.
    const flatCommunity = flat(communitySrc);
    const introFrom = flatCommunity.indexOf("XL.net staff submit tools");
    const introTo = flatCommunity.indexOf("</p>", introFrom);
    assert.ok(
      introFrom > 0 && introTo > introFrom,
      "the /work intro paragraph is still where this scrape looks for it"
    );
    assert.ok(
      !/[–—]/.test(flatCommunity.slice(introFrom, introTo)),
      "no em or en dashes in the /work section intro (owner ban, visible copy)"
    );
  }

  // ---------------------------------------------------------------------
  // 2026-08-29 round (canvas recovery): work:import refuses per SLOT, not
  // per row, and grows --extra <name>=<path> for ASSOCIATED files stored
  // at slot 02+ with no originality claim. All pure, pinned here DB-free.
  // ---------------------------------------------------------------------
  {
    const ops = await import("./lib/work-archive-ops");
    const {
      EXTRA_SLOT_MIN,
      extraNameRefusal,
      freeExtraSlots,
      importSlotRefusal,
      ledgerSlot,
      parseImportArgs: parseImport,
    } = ops;
    const sid = "11111111-2222-4333-8444-555555555555";
    const live = (rel: string) => ({ relPath: `${sid}/${rel}`, deletedAt: null });
    const gone = (rel: string) => ({
      relPath: `${sid}/${rel}`,
      deletedAt: new Date("2026-08-20T00:00:00Z"),
    });

    assert.equal(EXTRA_SLOT_MIN, 2, "extras start above the two recorded slots");
    assert.equal(ledgerSlot(`${sid}/00-kb-style-guide.skill`), 0);
    assert.equal(ledgerSlot(`${sid}/07-x.md`), 7);
    assert.equal(ledgerSlot(`${sid}/kb-style-guide.skill`), null);
    assert.equal(ledgerSlot(`${sid}/0-x.md`), null, "one digit is not a slot");

    // importSlotRefusal: the per-slot ledger gate.
    assert.equal(importSlotRefusal([], [0, 1]), null, "empty ledger: ok");
    assert.equal(
      importSlotRefusal([live("00-kb-style-guide.skill")], [1]),
      null,
      "live 00 + write 01 = ok (the 681e4ea4 shape: slot 00 from the 08-19 backfill accepts --md)"
    );
    const live00 = importSlotRefusal([live("00-kb-style-guide.skill")], [0]);
    assert.ok(
      live00 !== null &&
        live00.includes(`${sid}/00-kb-style-guide.skill`) &&
        live00.includes("live"),
      "live 00 + write 00 = refuse, naming the live path"
    );
    const gone01 = importSlotRefusal([gone("01-SKILL.md")], [1]);
    assert.ok(
      gone01 !== null &&
        gone01.includes("ADMIN-DELETED") &&
        gone01.includes("final"),
      "deleted 01 + write 01 = refuse, ADMIN-DELETED and final"
    );
    assert.equal(
      importSlotRefusal([gone("01-SKILL.md")], [0, 2]),
      null,
      "a deleted slot only refuses writes to THAT slot"
    );
    const both = importSlotRefusal(
      [live("00-a.zip"), gone("01-SKILL.md")],
      [0, 1]
    );
    assert.ok(
      both !== null && both.includes("slot 00") && both.includes("slot 01"),
      "every conflicting slot is reported in one refusal"
    );
    const tampered = importSlotRefusal([live("kb-style-guide.skill")], [5]);
    assert.ok(
      tampered !== null && tampered.includes("tampered"),
      "a rel_path without the NN- prefix refuses loudly even when no slot overlaps"
    );

    // freeExtraSlots: lowest free slots >= 02, deleted rows count as taken.
    assert.deepEqual(freeExtraSlots([], 2), [2, 3]);
    assert.deepEqual(
      freeExtraSlots([live("00-a.zip"), gone("02-x.md"), live("03-y.md")], 2),
      [4, 5],
      "extras skip slots held live OR admin-deleted"
    );
    assert.deepEqual(freeExtraSlots([live("00-a.zip")], 0), []);

    // --extra name rules.
    assert.equal(extraNameRefusal("kb-style-guide.md"), null);
    assert.equal(extraNameRefusal("license-renewal-tracker.skill"), null);
    assert.ok(extraNameRefusal("") !== null, "empty name refused");
    assert.ok(extraNameRefusal("a/b.md") !== null, "slash refused");
    assert.ok(extraNameRefusal("a\\b.md") !== null, "backslash refused");
    assert.ok(extraNameRefusal("noext") !== null, "an extension is required");
    assert.ok(extraNameRefusal("trailing.") !== null, "empty extension refused");
    const b64 = extraNameRefusal("kb-style-guide.skill.b64.txt");
    assert.ok(
      b64 !== null && b64.includes("decode"),
      ".b64.txt refused and the refusal says to decode first"
    );
    assert.ok(
      extraNameRefusal("X.B64.TXT") !== null,
      ".b64.txt refusal is case-insensitive"
    );

    // parseImportArgs with --extra.
    const two = parseImport([
      sid,
      "--md",
      "/tmp/SKILL.md",
      "--extra",
      "kb-style-guide.md=/tmp/a.bin",
      "--extra",
      "license-renewal-tracker.skill=/tmp/b.bin",
    ]);
    assert.deepEqual(two, {
      ok: true,
      args: {
        id: sid,
        file: null,
        md: "/tmp/SKILL.md",
        extra: [
          { name: "kb-style-guide.md", path: "/tmp/a.bin" },
          { name: "license-renewal-tracker.skill", path: "/tmp/b.bin" },
        ],
        force: false,
        yes: false,
      },
    });
    const extraOnly = parseImport([sid, "--extra", "x.skill=/tmp/x"]);
    assert.ok(
      extraOnly.ok && extraOnly.args.file === null && extraOnly.args.md === null,
      "--extra alone satisfies the at-least-one rule"
    );
    const eqInPath = parseImport([sid, "--extra", "x.skill=/tmp/a=b"]);
    assert.ok(
      eqInPath.ok && eqInPath.args.extra[0].path === "/tmp/a=b",
      "the first = splits name from path; later ones belong to the path"
    );
    assert.ok(!parseImport([sid]).ok, "still nothing to write without any flag");
    assert.ok(
      !parseImport([sid, "--extra", "foo"]).ok,
      "--extra foo without = is refused"
    );
    assert.ok(
      !parseImport([sid, "--extra", "foo.md="]).ok,
      "--extra with an empty path is refused"
    );
    assert.ok(
      !parseImport([sid, "--extra", "=/tmp/x"]).ok,
      "--extra with an empty name is refused"
    );
    assert.ok(
      !parseImport([sid, "--extra"]).ok && !parseImport([sid, "--extra", "--yes"]).ok,
      "--extra must not swallow a following flag as its value"
    );
    assert.ok(
      !parseImport([sid, "--extra", "a.md=/x", "--extra", "a.md=/y"]).ok,
      "duplicate --extra names are refused"
    );
    assert.ok(
      !parseImport([sid, "--extra", "a b.md=/x", "--extra", "a_b.md=/y"]).ok,
      "names that collide after sanitizing are duplicates too"
    );
    assert.ok(
      !parseImport([sid, "--extra", "dir/a.md=/x"]).ok,
      "a name with a slash is refused"
    );
    assert.ok(
      !parseImport([sid, "--extra", "a.skill.b64.txt=/x"]).ok,
      ".b64.txt names are refused at parse time"
    );

    // Script text pins: the slot gate precedes the sha gate and the write;
    // extras are labelled and never enter importShaRefusal.
    const { readFileSync: readSrc } = await import("node:fs");
    const importSrc2 = readSrc("scripts/work-archive-import.ts", "utf8");
    const slotAt = importSrc2.indexOf("importSlotRefusal(ledger, slotsToWrite)");
    const shaAt = importSrc2.indexOf("const refusal = importShaRefusal(");
    const writeAt2 = importSrc2.indexOf("await storeArchiveFilesAt(");
    assert.ok(
      slotAt > 0 && shaAt > slotAt && writeAt2 > shaAt,
      "import settles the slot gate, then the sha gate, then writes"
    );
    assert.ok(
      importSrc2.includes("ASSOCIATED FILE (not the recorded original)"),
      "each --extra is labelled as associated, not original, in the console"
    );
    assert.ok(
      importSrc2.includes("freeExtraSlots(ledger, extra.length)"),
      "extra slots are assigned from the ledger, never from argv position"
    );
    assert.ok(
      !importSrc2.includes("row already has") &&
        importSrc2.includes("cleanup is final"),
      "the whole-row refusal is gone; finality is stated per slot"
    );
    // The extra loader pushes to entries but NOT to checks (no sha claim).
    const extraBlock = importSrc2.slice(
      importSrc2.indexOf("extra.forEach("),
      importSrc2.indexOf("if (!md && row.mdName)")
    );
    assert.ok(
      extraBlock.includes("entries.push(") && !extraBlock.includes("checks.push("),
      "--extra never enters importShaRefusal"
    );
    for (const src of [importSrc2, readSrc("scripts/lib/work-archive-ops.ts", "utf8")])
      assert.ok(!/[–—]/.test(src), "no em or en dashes in the import lane");
  }

  // ---------------------------------------------------------------------
  // 2026-08-29 canvas round: scripts/work-transfer.ts, the scripted twin of
  // POST /api/work/submissions/[id]/transfer. Everything decided here is in
  // scripts/lib/work-transfer-ops.ts and reuses the route's own gates
  // (transferTarget, transferBlockedReason, emailDomain), so these tests pin
  // the SCRIPT's contract: plan shape, per-row verdict, argv.
  // ---------------------------------------------------------------------
  {
    const { decideTransfer, parseTransferArgs, parseTransferPlan } =
      await import("./lib/work-transfer-ops");
    const { readFileSync: readTx } = await import("node:fs");
    const uidA = "2d17baef-3130-425c-8689-69617b6811c3";
    const uidB = "30011d6b-c02e-4712-a34c-912eb1c4722b";

    // Plan shape. Every refusal names the row index, since the plan is typed
    // by hand from a canvas.
    assert.ok(!parseTransferPlan({ id: uidA }).ok, "plan must be an array");
    assert.ok(!parseTransferPlan([]).ok, "an empty plan is refused");
    assert.ok(!parseTransferPlan([{ to: "a@xl.net" }]).ok, "id is required");
    assert.ok(
      !parseTransferPlan([{ id: "2d17baef", to: "a@xl.net" }]).ok,
      "a prefix is not a uuid"
    );
    assert.ok(
      !parseTransferPlan([{ id: uidA, to: "" }]).ok,
      "an empty target is refused"
    );
    const dup = parseTransferPlan([
      { id: uidA, to: "a@xl.net" },
      { id: uidA.toUpperCase(), to: "b@xl.net" },
    ]);
    assert.ok(!dup.ok && /duplicate id/.test(dup.error), "duplicate ids are refused case-insensitively");
    const unk = parseTransferPlan([{ id: uidA, too: "a@xl.net" }]);
    assert.ok(!unk.ok && /unknown key "too"/.test(unk.error), "an unknown key is named, not ignored");
    assert.ok(
      !parseTransferPlan([{ id: uidA, to: "a@xl.net", note: 7 }]).ok,
      "note must be a string when present"
    );
    const good = parseTransferPlan([
      { id: uidA.toUpperCase(), to: " Alice@xl.net ", note: "A Person" },
      { id: uidB, to: "bob@xl.net" },
    ]);
    assert.ok(good.ok);
    if (good.ok) {
      assert.equal(good.rows[0].id, uidA, "ids are lowercased");
      assert.equal(good.rows[0].to, "Alice@xl.net", "to is trimmed, not folded (decide folds)");
      assert.equal(good.rows[1].note, "", "note defaults to empty");
    }

    // Per-row verdict, in the route's order.
    const base = {
      id: uidA,
      title: "ARC",
      status: "published",
      submitterEmail: "adam@xl.net",
      companyId: null,
      panelAttemptId: null,
      stale: false,
    };
    const missing = decideTransfer(null, "alice@xl.net");
    assert.equal(missing.verdict, "refuse");
    const company = decideTransfer({ ...base, companyId: "c1" }, "alice@xl.net");
    assert.ok(
      company.verdict === "refuse" && /company-lane/.test(company.reason),
      "a company row is refused and says why (the lane needs the company's domain)"
    );
    const superseded = decideTransfer({ ...base, status: "superseded" }, "alice@xl.net");
    assert.ok(
      superseded.verdict === "refuse" && /previous version/.test(superseded.reason),
      "superseded is the route's structural refusal, verbatim"
    );
    const live = decideTransfer({ ...base, status: "running", panelAttemptId: "a1" }, "alice@xl.net");
    assert.ok(
      live.verdict === "refuse" && /being reviewed right now/.test(live.reason),
      "a live run refuses"
    );
    const staleRun = decideTransfer(
      { ...base, status: "running", panelAttemptId: "a1", stale: true },
      "alice@xl.net"
    );
    assert.equal(staleRun.verdict, "move", "a stale run is movable (an orphaned row is never unmovable)");
    const same = decideTransfer(base, " ADAM@xl.net ");
    assert.ok(
      same.verdict === "skip" && /already owns/.test(same.reason),
      "the current owner is a skip, not a refusal (a re-run after a partial apply)"
    );
    for (const bad of ["alice@gmail.com", "alice@evilxl.net", "alice@ai.xl.net", "not-an-email", "alice@xl.net x"]) {
      const v = decideTransfer(base, bad);
      assert.equal(v.verdict, "refuse", `target ${bad} refused by the staff lane`);
    }
    const ok = decideTransfer(base, " Alice@XL.net ");
    assert.deepEqual(
      ok,
      { verdict: "move", from: "adam@xl.net", to: "alice@xl.net" },
      "a move carries the row's owner (the CAS pin) and the normalized target"
    );
    const otherLane = decideTransfer(base, "alice@xl.net", ["example.com"]);
    assert.equal(otherLane.verdict, "refuse", "laneDomains is honoured, not hardcoded");

    // argv.
    const dry = parseTransferArgs(["plan.json"]);
    assert.deepEqual(dry, {
      ok: true,
      args: { plan: "plan.json", apply: false, actor: null, notify: false, yes: false },
    });
    const full = parseTransferArgs(["plan.json", "--apply", "--actor", "Adam@XL.net", "--notify", "--yes"]);
    assert.deepEqual(full, {
      ok: true,
      args: { plan: "plan.json", apply: true, actor: "adam@xl.net", notify: true, yes: true },
    });
    const noActor = parseTransferArgs(["plan.json", "--apply"]);
    assert.ok(!noActor.ok && /--actor/.test(noActor.error), "--apply without --actor is refused");
    const notifyDry = parseTransferArgs(["plan.json", "--notify"]);
    assert.ok(!notifyDry.ok && /--apply/.test(notifyDry.error), "--notify without --apply is refused");
    const unknownFlag = parseTransferArgs(["plan.json", "--force"]);
    assert.ok(!unknownFlag.ok && /unknown flag --force/.test(unknownFlag.error));
    assert.ok(!parseTransferArgs([]).ok, "the plan path is required");
    assert.ok(!parseTransferArgs(["a.json", "b.json"]).ok, "one plan only");
    assert.ok(!parseTransferArgs(["a.json", "--actor", "--apply"]).ok, "--actor must not swallow a flag");
    assert.ok(!parseTransferArgs(["a.json", "--actor", "x@xl.net", "--actor", "y@xl.net"]).ok, "--actor given twice");
    // The actor lands in the audit line and the new-owner email, so it takes
    // the recipient's shape checks (transferTarget): the last three cases
    // pass a bare domain parse and are refused only by those.
    for (const badActor of [
      "adam@gmail.com",
      "adam@evilxl.net",
      "adam",
      "@xl.net",
      "a b@xl.net",
      '"quoted"@xl.net',
      "adam..r@xl.net",
    ])
      assert.ok(
        !parseTransferArgs(["a.json", "--apply", "--actor", badActor]).ok,
        `actor ${badActor} refused (transferTarget shape + WORK_SUBMIT_DOMAINS)`
      );

    // The notify.ts refactor: the new-owner send is its own export and
    // notifyTransfer still routes through it (byte-identical copy).
    const notifySrc = readTx("src/lib/work/notify.ts", "utf8");
    assert.ok(/export async function notifyTransferNewOwner\(/.test(notifySrc));
    assert.ok(
      /await notifyTransferNewOwner\(\{ row, actorEmail \}\)/.test(notifySrc),
      "notifyTransfer delegates the new-owner copy"
    );
    assert.equal(
      (notifySrc.match(/A work submission was moved to you:/g) ?? []).length,
      1,
      "the moved-to-you subject exists exactly once (no forked copy)"
    );

    // The script prints the route's log line in the route's shape.
    const scriptSrc = readTx("scripts/work-transfer.ts", "utf8");
    // The route's line is READ, not restated: both literals are reduced to
    // their shape (every ${...} hole becomes ${}) and compared, so a route
    // edit fails this test instead of leaving the script's audit line
    // silently different.
    const logShape = (src: string): string | null => {
      const m = src.match(/`\[work\] transferred [^`]*`/);
      return m ? m[0].replace(/\$\{[^}]*\}/g, "${}") : null;
    };
    const routeShape = logShape(
      readTx("src/app/api/work/submissions/[id]/transfer/route.ts", "utf8")
    );
    assert.ok(routeShape !== null, "the route still logs a [work] transferred line");
    assert.strictEqual(
      logShape(scriptSrc),
      routeShape,
      "the transfer log line matches the route's"
    );
    for (const src of [scriptSrc, readTx("scripts/lib/work-transfer-ops.ts", "utf8")])
      assert.ok(!/[–—]/.test(src), "no em or en dashes in the transfer lane");
  }

  // ── §5.16 a refusal says each thing ONCE (2026-08-29) ──────────────
  // On 2026-08-28 20:53Z an emailed submission (a Claude plugin bundle with
  // no architecture document) was refused with the SAME six sentences printed
  // twice: extract.ts answers both program document failures WITH the
  // instruction paragraph, and the email lane appended that constant again.
  // The first repair was a string equality at that one call site. These
  // assertions cover the CLASS instead: the composer owns assembly, and a
  // repeat is caught wherever it is composed.
  {
    const { readFileSync } = await import("node:fs");

    const paragraphsOf = (body: string): string[] =>
      body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    /** Sentences of 8+ words, across paragraph boundaries. Sentence level and
     * not only paragraph level, deliberately: the 2026-08-28 defect was an
     * exact paragraph repeat, but the next one will not be. The moment a
     * failure's message gains one clause ("... the closest file was
     * docs/design.md"), paragraph equality goes green while the reader still
     * gets the same six sentences twice. */
    const sentencesOf = (body: string): string[] =>
      body
        .split(/\n\s*\n/)
        .flatMap((p) => p.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/))
        .map((s) => s.trim())
        .filter((s) => s.split(/\s+/).length >= 8);
    const repeats = (xs: string[]): string[] => {
      const n = new Map<string, number>();
      for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1);
      return [...n].filter(([, c]) => c > 1).map(([x]) => x);
    };
    const duplicatedCopy = (body: string): string[] => [
      ...repeats(paragraphsOf(body)),
      ...repeats(sentencesOf(body)),
    ];
    const saysItOnce = (body: string, what: string): void => {
      assert.deepEqual(duplicatedCopy(body), [], `${what}: repeats copy`);
      assert.equal(
        body.split(MISSING_ARCH_DOC_MESSAGE).length - 1,
        body.includes(MISSING_ARCH_DOC_MESSAGE) ? 1 : 0,
        `${what}: the instruction paragraph appears at most once`
      );
    };

    // NEGATIVE CONTROLS FIRST. A duplication detector that quietly stopped
    // detecting would leave every assertion below green forever.
    const incidentBody = [MISSING_ARCH_DOC_MESSAGE, MISSING_ARCH_DOC_MESSAGE].join("\n\n");
    assert.ok(
      duplicatedCopy(incidentBody).length > 0,
      "the detector fires on the 2026-08-28 body (exact paragraph repeat)"
    );
    const driftBody = [
      `${MISSING_ARCH_DOC_MESSAGE} The closest file was skills/xlnet-policy/SKILL.md.`,
      MISSING_ARCH_DOC_MESSAGE,
    ].join("\n\n");
    assert.equal(
      repeats(paragraphsOf(driftBody)).length,
      0,
      "the drift shape is invisible to a paragraph-only check (hence sentences)"
    );
    assert.ok(
      duplicatedCopy(driftBody).length > 0,
      "the detector fires once a message gained a clause, where string equality would miss it"
    );

    // ---- the composer itself ----
    assert.equal(composeParagraphs(["A", "B"]), "A\n\nB");
    assert.equal(composeParagraphs(["A", "B", "A"]), "A\n\nB", "first occurrence keeps its place");
    assert.equal(
      composeParagraphs(["Add the file and resubmit.", "add the  file\nand resubmit."]),
      "Add the file and resubmit.",
      "normalization is for comparison only; the kept block is printed verbatim"
    );
    assert.equal(composeParagraphs(["A", "", null, undefined, false, "   ", "B"]), "A\n\nB");
    assert.equal(
      composeParagraphs(["A\n\nB", "B"]),
      "A\n\nB",
      "a multi-paragraph block is flattened, so nesting cannot smuggle a repeat past the check"
    );
    assert.equal(repeatedParagraphs("A\n\nB\n\nA").length, 1);
    assert.equal(repeatedParagraphs("A\n\nB").length, 0);
    assert.equal(
      repeatedParagraphs("A\r\n\r\nB\r\n\r\nA").length,
      1,
      "the seam detector reads CRLF bodies too (inbound mail is CRLF)"
    );
    // The seam net itself: a body that repeats loses the repeat, an ordinary
    // body is untouched. Pinned because sendTronEmail is the last chance for
    // the three sends that never see reject().
    assert.equal(composeParagraphs(["A\n\nB\n\nA"]), "A\n\nB");
    assert.equal(composeParagraphs(["A\n\nB"]), "A\n\nB");
    // Not fuzzy: two refusal paragraphs that share most of their words but
    // name different fixes must both survive.
    assert.equal(
      paragraphsOf(
        composeParagraphs([
          `Several .md attachments could be the Skill's document, and none carries a Skill front-matter block, so I could not settle on one. Rename the right one to SKILL.md and resend.`,
          `2 attachments were over the 1 MB limit for the Skill's document and could not be read. If the right one is in there, trim it or send it inside the package.`,
        ])
      ).length,
      2,
      "similar paragraphs that name different fixes both survive"
    );
    assert.equal(
      composeRefusal({ diagnosis: "That package is empty." }),
      "That package is empty.",
      "a one-slot refusal is the identity"
    );
    const LEAD = "I read your upload as a Code program, because it has a .claude-plugin folder.";
    assert.equal(
      composeRefusal({
        lead: LEAD,
        diagnosis: MISSING_ARCH_DOC_MESSAGE,
        instruction: MISSING_ARCH_DOC_MESSAGE,
      }),
      `${LEAD}\n\n${MISSING_ARCH_DOC_MESSAGE}`,
      "the 2026-08-28 shape: the instruction is dropped when the diagnosis already IS it"
    );
    assert.equal(
      composeRefusal({
        diagnosis: `${LEAD} ${MISSING_ARCH_DOC_MESSAGE}`,
        instruction: MISSING_ARCH_DOC_MESSAGE,
      }).split(MISSING_ARCH_DOC_MESSAGE).length - 1,
      1,
      "and when the diagnosis WRAPS it, which a string-equality check missed"
    );
    assert.ok(
      composeRefusal({
        diagnosis: "That package is empty.",
        instruction: MISSING_ARCH_DOC_MESSAGE,
      }).includes(MISSING_ARCH_DOC_MESSAGE),
      "the instruction is still printed when it is genuinely new"
    );
    assert.equal(
      composeRefusal({
        lead: "L",
        diagnosis: "D",
        blocked: "B",
        instruction: "I",
        evidence: ["E", null],
      }),
      "L\n\nD\n\nB\n\nI\n\nE",
      "slot order: lead, diagnosis, blocked, instruction, evidence"
    );
    // The `cleaned` slot (2026-08-29) sits AHEAD of the verdict lead, and
    // nothing above defends that position: the assertion here pins C before L
    // so a later refactor cannot quietly reorder it. The ordering is a copy
    // ruling, not a formatting one. An action taken on the submitter's own
    // files outranks the explanation of the verdict, because a package that
    // was one .env must learn what was removed before it is told to attach a
    // document it never had.
    assert.equal(
      composeRefusal({
        cleaned: "C",
        lead: "L",
        diagnosis: "D",
        blocked: "B",
        instruction: "I",
        evidence: ["E"],
      }),
      "C\n\nL\n\nD\n\nB\n\nI\n\nE",
      "slot order: cleaned FIRST, then lead, diagnosis, blocked, instruction, evidence"
    );
    assert.equal(
      composeRefusal({ diagnosis: "msg", evidence: ["Files: a, b"] }),
      ["msg", "", "Files: a, b"].join("\n"),
      "the evidence shape is byte-identical to the joins it replaced"
    );

    // ---- driven by the REAL failure shapes ----
    // The 2026-08-28 archive: a .claude-plugin folder, two packaged skills,
    // and a README with no Architecture section. Replayed against the real
    // bytes this yields missing_architecture_doc / program /
    // claude_code_project, and so does this fixture.
    const README_NO_ARCH = ["# xlnet-context", "", "## What it does", "", PROSE, "", "## Installing", "", PROSE].join("\n");
    const incidentShaped = await zipOf({
      ".claude-plugin/plugin.json": '{"name":"xlnet-context","version":"0.1.0"}',
      "README.md": README_NO_ARCH,
      "skills/xlnet-policy/SKILL.md": `---\nname: xlnet-policy\ndescription: policy lookup\n---\n${PROSE}`,
      "skills/xlnet-onboarding/SKILL.md": `---\nname: xlnet-onboarding\ndescription: onboarding interview\n---\n${PROSE}`,
    });
    const incident = await inspectArchive(incidentShaped, null, {
      packageName: "xlnet-context.zip",
    });
    assert.ok(!incident.ok, "the incident shape is refused");
    if (!incident.ok) {
      assert.equal(incident.code, "missing_architecture_doc");
      assert.equal(incident.kind, "program");
      assert.equal(incident.kindVerdict?.rule, "claude_code_project");
      // The body the email lane composes for it, envelope and pointer
      // included, exactly as reject() assembles one.
      const body = composeParagraphs([
        "I could not accept this as a /work submission. Nothing was stored.",
        composeRefusal({
          lead: incident.kindVerdict ? kindVerdictSentence(incident.kindVerdict) : null,
          diagnosis: incident.message,
          instruction: MISSING_ARCH_DOC_MESSAGE,
        }),
        "If the form is easier, you can also submit at https://ai.xl.net/work/submit.",
      ]);
      saysItOnce(body, "the 2026-08-28 dcollett refusal");
      assert.equal(paragraphsOf(body).length, 4);
    }
    // Every other shape that reaches the program document refusal.
    const docShapes: { name: string; bytes: Buffer; pin: "program" | null; blocked?: string }[] = [
      { name: "source with no document at all", bytes: await zipOf({ "main.py": "print(1)", "util.py": "x=1" }), pin: null },
      { name: "an architecture doc below the prose floor", bytes: await zipOf({ "architecture.md": "too short", "main.py": "x=1" }), pin: null },
      {
        name: "the incident shape with the rescue blocked by an oversize .md",
        bytes: incidentShaped,
        pin: null,
        blocked: `The "architecture.md" attachment looks like that document, but it is over the 1 MB limit for a document sent outside the package, so I could not read it. Put it inside the package, or trim it and resend.`,
      },
      { name: "the update lane's pinned program whose package reads as a Skill", bytes: await zipOf({ "src/SKILL.md": PROSE, "src/a.py": "x=1" }), pin: "program" },
    ];
    for (const shape of docShapes) {
      const res = await inspectArchive(shape.bytes, shape.pin, { packageName: "tool.zip" });
      assert.ok(!res.ok, `${shape.name}: refused`);
      if (res.ok) continue;
      const failedKind = res.kind ?? shape.pin;
      assert.ok(
        res.code === "missing_architecture_doc" ||
          (res.code === "doc_too_short" && failedKind === "program"),
        `${shape.name}: is a program document failure (got ${res.code})`
      );
      saysItOnce(
        composeRefusal({
          lead:
            res.kindVerdict && res.kindVerdict.kind === failedKind
              ? kindVerdictSentence(res.kindVerdict)
              : null,
          diagnosis: res.message,
          blocked: shape.blocked ?? null,
          instruction: MISSING_ARCH_DOC_MESSAGE,
        }),
        shape.name
      );
    }
    // The fact the retired suppressor silently rested on, now pinned: both
    // program document codes answer WITH the instruction, so any caller that
    // appends the constant duplicates it.
    for (const res of [incident, await inspectArchive(await zipOf({ "architecture.md": "too short", "main.py": "x=1" }), null, { packageName: "tool.zip" })])
      assert.equal(
        res.ok ? "" : res.message,
        MISSING_ARCH_DOC_MESSAGE,
        "extract.ts answers the program document failures WITH the instruction paragraph"
      );

    // ---- the source guards: the class, not the one call site ----
    const refusalSrc = readFileSync("src/lib/work/refusal.ts", "utf8");
    assert.ok(
      !/^import /m.test(refusalSrc) && !/\bimport\s*\(/.test(refusalSrc),
      "refusal.ts stays a zero-import leaf (static or dynamic), so any work module can compose through it"
    );
    const intakeSrc4 = readFileSync("src/lib/work/email-intake.ts", "utf8");
    assert.ok(
      !/[!=]== MISSING_ARCH_DOC_MESSAGE/.test(intakeSrc4),
      "the 2026-08-28 per-call-site duplicate suppressor does not come back in either polarity; refusal.ts owns assembly"
    );
    // Pins the retired idiom specifically. It is a ratchet, not a proof: the
    // file still joins single newlines for the receipt and the admin WARN,
    // and a hand-built paragraph pair could still be passed in as one
    // diagnosis. What actually holds the property is that every refusal is
    // replayed through the composer above and checked at SENTENCE level.
    assert.ok(
      !intakeSrc4.includes('join("\\n\\n")'),
      "the paragraph-joining idiom the duplicate shipped through is gone from email-intake"
    );
    assert.ok(
      /text:\s*composeParagraphs\(\[/.test(intakeSrc4),
      "reject() composes its reply body through the composer"
    );
    assert.ok(
      /repeatedParagraphs\(text\)/.test(intakeSrc4) &&
        intakeSrc4.indexOf("repeatedParagraphs(text)") <
          intakeSrc4.indexOf("withTronSignature(text)"),
      "sendTronEmail re-checks the finished body at the seam, before the signature is appended"
    );
    assert.ok(
      /ledgerReasonSlug\(parts\.diagnosis\)/.test(intakeSrc4),
      "the §5.15 ledger key comes from the diagnosis slot, never the composed body (episodic keys)"
    );
    // The web lane's 422 must not carry a second submitter-facing copy field:
    // that shape is what read as "message is the diagnosis, the fix lives
    // elsewhere" and licensed the append.
    for (const route of [
      "src/app/api/work/submissions/route.ts",
      "src/app/api/work/submissions/[id]/update/route.ts",
    ])
      assert.ok(
        !/\binstructions\s*:/.test(readFileSync(route, "utf8")),
        `${route} ships one submitter-facing text, with no instructions twin`
      );
    const httpSrc = readFileSync("src/lib/work/http.ts", "utf8");
    assert.ok(
      /extra\?: WorkErrorExtras/.test(httpSrc) &&
        !/extra\?: Record<string, unknown>/.test(httpSrc),
      "workError's extras stay closed, so a second copy field cannot be added back silently"
    );
    assert.ok(!/[–—]/.test(refusalSrc), "no em or en dashes in refusal.ts");
  }

  // ───────────────────────────────────────────────────────────────────
  // §5.16 INTAKE CLEANING (owner directive 2026-08-29). The properties the
  // whole round rests on; each one is here because losing it silently
  // reintroduces the exact failure it guards.
  // ───────────────────────────────────────────────────────────────────

  // C1. THE DETECTOR AND THE CLEANER CANNOT DISAGREE. textLooksSecret is
  // derived from sanitizeText, so a pattern that detects without redacting is
  // unrepresentable. Pin it on every rule the module ships.
  for (const rule of SANITIZE_RULES) {
    assert.ok(
      /^[a-z-]+$/.test(rule.id),
      `rule id ${rule.id} must be lowercase-kebab and DIGIT-FREE: it is the
       placeholder label, and a digit would trip lint's phone-number ban`
    );
  }

  // C2. THE PLACEHOLDER'S OWN VOCABULARY IS CLEAN. A card quoting the marker
  // is refused (C3), and it should be refused FOR THAT REASON: the violation a
  // reviewer reads has to name the marker, not send them chasing a phantom
  // phone number. This is what forces rule ids to stay digit-free and
  // lowercase-kebab, since a digit in a label would land inside the
  // phone-number ban and an "@" inside the email one.
  for (const rule of SANITIZE_RULES) {
    const token = placeholderFor(rule.id);
    const violations = stringViolations("summary", token);
    assert.equal(
      violations.length,
      1,
      `placeholder ${token} should trip exactly one ban, got: ${violations.join("; ")}`
    );
    assert.ok(
      violations[0].includes("redaction marker"),
      `placeholder ${token} must be refused as a marker, not as something else`
    );
  }

  // C3. ...but a card that QUOTES the marker is refused, in every field
  // INCLUDING the title. The panel reads a cleaned corpus, so the token sits
  // in the evidence looking like submitter text; a card is about the tool,
  // never about what was taken out of the package.
  for (const field of ["title", "summary"]) {
    assert.ok(
      stringViolations(field, `Tool [redacted:private-key] here`).some((v) =>
        v.includes("redaction marker")
      ),
      `${field} must refuse the intake redaction marker`
    );
  }

  // PEM armor assembled at runtime, never as a source literal: the repo's
  // pre-commit secrets gate scans staged lines and a literal block reads to it
  // as a real key. Same reason the API_KEY fixtures above are joined.
  const PEM_B = `-----BEGIN RSA ${["PRIVATE", "KEY"].join(" ")}-----`;
  const PEM_E = `-----END RSA ${["PRIVATE", "KEY"].join(" ")}-----`;

  // C4. IDEMPOTENCE. Cleaning a cleaned file changes nothing. Two rules used
  // to re-match their own output (a written connection-string placeholder
  // reparses as user:pass; the date-of-birth token contains its own label),
  // which is why the transform masks existing placeholders before scanning
  // rather than tuning each rule.
  const idempotenceCorpus = [
    "postgres://[redacted:connection-string-password]@host/db",
    "date-of-birth [redacted:date-of-birth] and DOB 1990-01-02",
    `${["API", "KEY"].join("_")} = "abcdefgh12345678"`,
    "SSN 123-45-6789 and card 4111 1111 1111 1111",
    `${PEM_B}\nAAAA\n${PEM_E}`,
  ];
  for (const text of idempotenceCorpus) {
    const once = sanitizeText(text).text;
    assert.equal(
      sanitizeText(once).changed,
      false,
      `sanitize must be idempotent for ${JSON.stringify(text.slice(0, 40))}`
    );
  }

  // C5. THE RULING THAT DEFINES THE ROUND: ordinary work contact details are
  // NOT personal information to be redacted. This corpus is XL.net's own
  // tooling documentation, where the address IS the subject matter, and the
  // panel writes the published card from exactly this text. Measured before
  // ruling: naive email+phone patterns fire 75 times on 1 MB of this repo's
  // own docs, every hit legitimate. Deleting these assertions to "also redact
  // emails" would quietly turn working documents into nonsense.
  for (const keep of [
    "Escalate to 312-555-0142 or email flester@xl.net for the export.",
    "Tron.Netter@ai.xl.net handles inbound at (872) 350-4325.",
    "Customer account number 4471203 in ConnectWise needs review.",
    "Open Passportal and copy the entry name only.",
    "Hire date 2019-03-01 stays, and so does commit a1b2c3d4e5f6a7b8c9d0e1f2.",
    // The label-anchored rules are case-INSENSITIVE, so a value class of
    // [A-Z0-9] happily matches ordinary words. Measured over 1.3 MB of this
    // repo's own prose, the driver-licence rule's only hit in the entire
    // corpus was the word "Ordinary" in a sentence that just mentions the
    // document type. A real licence number carries digits; the lookahead is
    // what keeps that true.
    "Check the driver licence and Ordinary paperwork before dispatch.",
    `${["PASS", "WORD"].join("")} = "<your-password-here>"`,
  ]) {
    assert.equal(
      sanitizeText(keep).changed,
      false,
      `must survive untouched: ${keep}`
    );
  }

  // ...but a real licence number, which carries digits, still goes.
  assert.ok(
    sanitizeText("Driver licence number D1234567 on file").changed,
    "a real driver licence number is still redacted"
  );

  // C6. UNTERMINATED KEY MATERIAL LEAVES WHOLE. A BEGIN header with no END
  // inside the block bound has no span to patch, and leaving the body in the
  // corpus because a marker was missing is the one outcome this all exists to
  // prevent. The old pattern matched ONLY the BEGIN line, so a naive span
  // replacement would have deleted the header and shipped the key body.
  const unterminated = sanitizeText(`${PEM_B}\nMIIEowIBAAKCAQEASECRETBODY`);
  assert.equal(unterminated.excludeFile, "unterminated-private-key");
  assert.ok(textLooksSecret(`${PEM_B}\nMIIEowSECRET`));

  // C7. proseLength does not count placeholders, so a document that was mostly
  // credentials cannot buy its way over the prose floor with the tokens we
  // wrote in their place.
  assert.ok(
    proseLength("[redacted:private-key] ".repeat(60)) < 100,
    "a wall of redaction tokens is not prose"
  );

  // C8. THE REBUILD PASSES ENTRIES THROUGH BY REFERENCE, and the per-entry
  // compression pin is what makes that true. Measured on the pinned jszip: a
  // global DEFLATE re-deflates STORE entries and a global STORE inflates every
  // DEFLATE entry and DOUBLES the archive. At the 100 MB cap that is a
  // multi-hundred-megabyte artifact conjured from a package we were only asked
  // to clean, so this asserts the bytes themselves did not move.
  const mixed = new JSZip();
  mixed.file("keep-store.bin", Buffer.alloc(40_000, 7), { compression: "STORE" });
  mixed.file("keep-deflate.txt", "compressible ".repeat(4_000), {
    compression: "DEFLATE",
  });
  mixed.file(".env", "TOKEN=zzz");
  const mixedBytes = await mixed.generateAsync({ type: "nodebuffer" });
  const mixedLoaded = await JSZip.loadAsync(mixedBytes);
  const rebuiltMixed = await rebuildWithout(mixedLoaded, {
    drop: new Set([".env"]),
    redact: new Map(),
  });
  assert.ok(rebuiltMixed.ok, "the rebuild succeeds");
  if (rebuiltMixed.ok) {
    const after = await JSZip.loadAsync(rebuiltMixed.zip);
    assert.ok(!after.files[".env"], "the dropped entry is gone");
    for (const name of ["keep-store.bin", "keep-deflate.txt"]) {
      const before = mixedLoaded.files[name] as unknown as {
        _data?: { crc32?: number; compressedSize?: number };
      };
      const now = after.files[name] as unknown as {
        _data?: { crc32?: number; compressedSize?: number };
      };
      assert.equal(
        now._data?.crc32,
        before._data?.crc32,
        `${name} kept its crc32: it was carried, not re-encoded`
      );
      assert.equal(
        now._data?.compressedSize,
        before._data?.compressedSize,
        `${name} kept its compressed size: no transcode happened`
      );
    }
  }

  // C9. A WINDOWS-AUTHORED NAME IS PLANNED ON ITS RAW ZIP KEY. normalizePath
  // rewrites "\\" to "/", so a plan keyed on the display path would miss
  // "dir\\.env" and the credential would ride into the stored archive
  // silently, and only for archives authored on Windows.
  const winZip = new JSZip();
  winZip.file("dir\\.env", "TOKEN=zzz");
  winZip.file("architecture.md", PROSE);
  const winWalk = await inspectArchive(
    await winZip.generateAsync({ type: "nodebuffer" }),
    "program"
  );
  assert.ok(winWalk.ok, "the windows-authored package is accepted");
  if (winWalk.ok) {
    const rebuilt = await JSZip.loadAsync(winWalk.cleaning!.stored!.bytes);
    assert.ok(
      !Object.keys(rebuilt.files).some((k) => k.includes(".env")),
      "the backslash-named .env is really gone from the stored archive"
    );
  }

  // C10. CONTAINMENT: a rebuild we cannot verify stores NOTHING. Never the
  // submitted bytes (that writes the exact material we were told to remove)
  // and never a refusal (the submitter did nothing wrong, our code did).
  const failedDecision = decideStorage({
    pkg: {
      ...(winWalk as ExtractOk),
      cleaning: {
        droppedPaths: [{ path: ".env", reason: "filename marks it as key material" }],
        redactedPaths: [],
        excludedPaths: [],
        rules: [],
        stored: null,
        failed: "rebuilt archive did not parse",
      },
    },
    submittedArchive: Buffer.from("SUBMITTED-BYTES"),
  });
  assert.equal(
    failedDecision.archiveData,
    null,
    "a failed rebuild stores no archive at all"
  );
  assert.equal(failedDecision.failed, "rebuilt archive did not parse");
  assert.ok(failedDecision.cleaned, "and the row still records that it happened");

  // C11. A CLEAN UPLOAD IS STORED EXACTLY AS IT ARRIVED. A rebuild is never
  // byte-identical (jszip rewrites headers and degrades mtimes), so the common
  // path must not pay for one.
  const untouched = decideStorage({
    pkg: winWalk as ExtractOk,
    submittedArchive: Buffer.from("SUBMITTED-BYTES"),
  });
  if (!(winWalk as ExtractOk).cleaning)
    assert.equal(untouched.cleaningJson, null, "nothing cleaned, nothing recorded");

  // C12. THE STANDALONE DOCUMENT IS CLEANED TOO, AND ITS BYTES FOLLOW ITS
  // TEXT. docRawBytes becomes md_data and the retention email attachment, so a
  // cleaner that updated the text and left the buffer would keep the corpus
  // clean and mail the credential out of the building.
  const dirtyMd = inspectBareMd(
    "SKILL.md",
    Buffer.from(`${PROSE}\n\n${["API", "KEY"].join("_")} = "abcdefgh12345678"\n`)
  );
  assert.ok(dirtyMd.ok, "a standalone .md with a credential is cleaned, not refused");
  if (dirtyMd.ok) {
    assert.ok(!dirtyMd.docText.includes("abcdefgh12345678"), "text is clean");
    assert.ok(
      !dirtyMd.docRawBytes!.toString("utf8").includes("abcdefgh12345678"),
      "and docRawBytes follows the text, or retention mails the original"
    );
    assert.equal(dirtyMd.cleaning?.redactedPaths[0], "SKILL.md");
  }


  // C13. THE TWO FATALS THIS ROUND SHIPPED AND THEN FIXED. Both were found by
  // an adversarial review that EXECUTED the scenarios; the suite at the time
  // passed with both defects present, which is why these are pinned by
  // behaviour rather than by shape.
  //
  // (a) THE GUARD ASKED A WHOLE-FILE QUESTION WHILE THE REDACTOR WORKS PER
  // MATCH. One complete key block anywhere satisfied the paired test, so a
  // SECOND key with no END line rode through verbatim into the corpus, the
  // stored archive and the retention mail, while the submitter was told the
  // upload had been cleaned. It was a REGRESSION: that file used to be
  // refused outright. Any future "does this file contain X" check reaching for
  // the same shape breaks this assertion.
  const pairedThenUnterminated = `intro\n\n${PEM_B}\nAAAAPAIRED\n${PEM_E}\n\nreal:\n${PEM_B}\nREALSECRETKEYBODY\n`;
  const pt = sanitizeText(pairedThenUnterminated);
  assert.equal(
    pt.excludeFile,
    "unterminated-private-key",
    "a paired block must not vouch for an unpaired one later in the file"
  );
  assert.equal(pt.changed, false, "the file leaves whole rather than patched");

  // ...and end to end, the second key body must reach nothing.
  const leakZip = await zipOf({
    "architecture.md": PROSE,
    "notes.md": pairedThenUnterminated,
    "main.py": "print(1)",
  });
  const leakWalk = await inspectArchive(leakZip, "program");
  assert.ok(leakWalk.ok, "the package is still accepted");
  if (leakWalk.ok) {
    assert.ok(
      !JSON.stringify(leakWalk.corpus).includes("REALSECRETKEYBODY"),
      "the key body must not reach the corpus the panel reads"
    );
    const storedZip = await JSZip.loadAsync(leakWalk.cleaning!.stored!.bytes);
    assert.ok(
      !storedZip.files["notes.md"],
      "the file holding unterminated key material leaves the stored archive"
    );
  }

  // (b) THE LAZY 20,000-CHARACTER GAP WAS QUADRATIC IN DISGUISE. Measured on
  // the shipped version: 2 MB of repeated headers took 2.8s, a 38 KB upload
  // took 22s of BLOCKING CPU in the single fork, and filling the inflate
  // budget extrapolated to ~95s. The linear scanner does the same 2 MB in
  // single-digit milliseconds. The bound here is deliberately loose: it is
  // catching a return to quadratic behaviour, not measuring performance.
  const headerFlood = `${PEM_B}\n`.repeat(20_000);
  const floodStart = Date.now();
  const floodResult = sanitizeText(headerFlood);
  const floodMs = Date.now() - floodStart;
  assert.equal(floodResult.excludeFile, "unterminated-private-key");
  assert.ok(
    floodMs < 2_000,
    `a header flood must not re-expand a lazy gap per header (took ${floodMs}ms)`
  );

  // C14. docVeto is ANCHORED. It used to match its keywords as a substring
  // anywhere in the value, so a real secret that merely contained one was
  // silently kept while the submitter was told the file had been cleaned.
  const vaultish = `${["PASS", "WORD"].join("")} = "Vault-Prod-2024!"`;
  assert.ok(
    sanitizeText(vaultish).changed,
    "a real secret containing a placeholder word is still redacted"
  );
  assert.equal(
    sanitizeText(`${["API", "KEY"].join("_")} = "\${DB_API_KEY}"`).changed,
    false,
    "but a genuine documentation placeholder still survives"
  );

  // C14b. THE PROSE VETO on secret-assignment (2026-08-31). Source files now
  // enter the corpus (single-file HTML apps), and UI copy in JS object
  // literals has a high base rate of `password: "<sentence>"` shapes: the
  // first real package redacted two such lines, told the submitter to rotate
  // a credential that did not exist, and handed the panel a mangled line. A
  // credential has no internal whitespace; a sentence does. Fixtures are
  // assembled at runtime, never as literals the pre-commit secrets gate reads.
  const PW = ["pass", "word"].join("");
  const AK = ["API", "KEY"].join("_");
  const proseKept = [
    // The two real lines from the package that found this (the value group
    // used to stop at the apostrophe of "didn't"; it now pairs its
    // delimiters, and shape 3/4 read the whole sentence).
    `  ${PW}: "Your account was temporarily locked after several sign-in attempts didn't go through, which is a security safeguard rather than a sign anything is wrong with your account.",`,
    `  ${PW}: "Password / Account",`,
    `const ${PW}Error = "Password must be at least 8 characters long";`,
    // The group spans the gap BETWEEN two string literals: `" + key + "`.
    `const url = "https://api.example.com/v1/search?apikey=" + key + "&q=" + encodeURIComponent(q);`,
    `const apiKeyLabel = "Paste the key from the console into this field";`,
    `${PW}: "two words"`,
    // Lone shapes, one veto each. An apostrophe inside a double-quoted value
    // is now visible PAST the apostrophe (paired delimiters) and shape 4 sees
    // the second word:
    `${PW}Hint: "Administrator's password"`,
    // Lone shape 2 (`+` at the end): the identifier is uppercase so shape 4
    // stays silent and only the concatenation vetoes.
    `u = "?apikey=" + KEY; alert("x")`.replace("apikey", ["api", "key"].join("")),
    // A double quote inside a single-quoted value is text, and three tokens.
    `${PW} = 'Type "yes" to continue'`,
  ];
  for (const text of proseKept) {
    const r = sanitizeText(text);
    assert.equal(r.changed, false, `prose is not a credential: ${JSON.stringify(text.slice(0, 60))}`);
    assert.equal(r.hits.length, 0, "and the inventory agrees with the text");
    assert.equal(r.text, text, "byte-identical");
  }
  const stillRedacted = [
    `${PW}: "hunter2!!"`,
    `${AK} = "abc123def456ghi789"`,
    `${PW} = "Vault-Prod-2024!"`,
    `${AK}: '3f9a1c7e5b2d4a6f8e0c1b3d5f7a9c2e'`,
    // Paired delimiters: an apostrophe inside a double-quoted credential used
    // to END the match there and leak the tail (`word!"`); now the whole
    // literal is the value and the whole literal goes.
    `${PW}: "secretpass'word!"`,
    `${PW}: "it's-secret-long"`,
    // A concatenation whose FIRST literal is itself credential-shaped: the
    // group stops at the first literal's own closing quote, the inner holds
    // no `+`, so it redacts (shape 2 only fires when the group spanned the
    // gap between literals).
    `${AK} = "abcdefghij" + "klmnopqrst"`,
  ];
  for (const text of stillRedacted) {
    const r = sanitizeText(text);
    assert.ok(r.changed, `a one-token value is still a credential: ${JSON.stringify(text)}`);
    assert.equal(r.hits[0]?.ruleId, "secret-assignment");
    // The FULL quoted value is gone, delimiter to matching delimiter: the
    // apostrophe cases are the point (before this round `word!` and
    // `s-secret-long` survived past the apostrophe).
    const literal = text.match(/"[^"]*"|'[^']*'/)?.[0] ?? "";
    assert.ok(literal.length >= 10, `fixture parse: ${literal}`);
    assert.equal(
      r.text,
      text.replace(literal, "[redacted:secret-assignment]"),
      `the whole paired literal is the span: ${r.text}`
    );
    assert.equal(r.hits.length, 1, "one hit");
  }
  assert.equal(
    sanitizeText(`${PW}: "secretpass'word!"`).text,
    `${PW}: [redacted:secret-assignment]`,
    "nothing leaks past an inner apostrophe"
  );
  // PRE-EXISTING, pinned so the veto is not blamed for it: the rule's inner
  // value floor is 8 characters, so a 7-character `hunter2` never matched.
  assert.equal(sanitizeText(`${PW}: "hunter2"`).changed, false, "7-char floor predates the veto");
  // Idempotence with one real hit and one prose veto in the same text.
  const mixedVeto = `${proseKept[1]}\n${stillRedacted[0]}\n${proseKept[2]}`;
  const once = sanitizeText(mixedVeto);
  assert.ok(once.changed && once.hits.length === 1, "exactly the credential line is cut");
  assert.ok(once.text.includes("Password / Account") && once.text.includes("at least 8 characters"));
  assert.equal(sanitizeText(once.text).changed, false, "idempotent with a veto beside a hit");

  // C15. The value's offset comes from the match's group INDICES, never from
  // indexOf inside the match: when the same digits appear twice in one match,
  // indexOf redacts the earlier copy and leaves the real one in the corpus.
  const repeated = sanitizeText("bank account number 123456 and routing 123456 on file");
  assert.ok(
    repeated.text.startsWith("bank account number [redacted:bank-account-number]"),
    `the labelled occurrence is the one replaced, got: ${repeated.text}`
  );

  // C16. THE TWO OPERATOR GUARDS THAT STAND BETWEEN A CLEANED ROW AND ITS
  // UNCLEANED ORIGINAL. Source-scraped because both are refusals in scripts
  // the suite cannot execute (they need a DB and a filesystem), and because
  // parseCleaning fails OPEN by design: a malformed value reads as "nothing
  // was cleaned", which is the safe direction for a renderer and the unsafe
  // one here. One careless refactor removes either guard silently.
  const importSrc = readFileSync("scripts/work-archive-import.ts", "utf8");
  // Anchored on the WHOLE condition, not a substring of it: a first cut
  // matched `rowCleaning && !force` and therefore still passed when the guard
  // was disabled with `if (false && rowCleaning && !force)`. Mutation-tested.
  assert.ok(
    /if \(rowCleaning && !force\) \{/.test(importSrc),
    "work:import must refuse a cleaned row unless --force is given"
  );
  assert.ok(
    /row was CLEANED at intake/.test(importSrc),
    "and the refusal must say why, naming what was removed"
  );
  assert.ok(
    /FORCING ONTO A CLEANED ROW/.test(importSrc),
    "and --force must SAY so: the sha MATCHES on a cleaned row, so the run would otherwise read as a clean verified recovery"
  );
  const correlateSrc = readFileSync("scripts/lib/work-archive-correlate.ts", "utf8");
  assert.ok(
    /if \(rowCleaned\)\n?\s*return \{/.test(correlateSrc),
    "work:correlate must never propose an import for a cleaned row"
  );
  assert.ok(
    /row was cleaned at intake/.test(correlateSrc),
    "and must say why, since the sha MATCHING is exactly what makes it dangerous"
  );


  // C17. THE FOURTH INTAKE LANE. scripts/work-submit.ts is a full intake lane
  // (inspectArchive, createSubmission, storeArchiveFiles) and it was missed
  // when cleaning shipped, which turned it into this round's own worst case:
  // the walk stopped REFUSING credential-bearing uploads, so that lane began
  // ACCEPTING them while still writing the SUBMITTED buffer to the row bytea,
  // to the durable store, and onward to the owner's retention mail. A round
  // that introduces an invariant owns finding every site that must honour it,
  // so this pins the count: any NEW createSubmission caller must route
  // through decideStorage or this fails.
  const submitSrc = readFileSync("scripts/work-submit.ts", "utf8");
  assert.ok(
    /decideStorage\(/.test(submitSrc),
    "work:submit must make the same storage decision as the other lanes"
  );
  assert.ok(
    !/archiveData: bytes\b/.test(submitSrc),
    "work:submit must never write the SUBMITTED buffer to the row"
  );
  for (const lane of [
    "src/app/api/work/submissions/route.ts",
    "src/app/api/work/submissions/[id]/update/route.ts",
    "src/lib/work/email-intake.ts",
    "scripts/work-submit.ts",
  ]) {
    const src = readFileSync(lane, "utf8");
    assert.ok(
      /decideStorage\(/.test(src),
      `${lane} calls createSubmission and must route through decideStorage`
    );
    assert.ok(
      !/data: bytes \}/.test(src),
      `${lane} must not hand the submitted buffer to storeArchiveFiles`
    );
  }


  // C18. A DOCUMENT-SLOT FAILURE MUST NOT FALL BACK TO THE SUBMITTED FILE.
  // decideStorage returns mdData null for two different reasons, and only one
  // of them makes `?? mdMeta.data` safe: no document slot at all (the package
  // walk already cleaned that document) versus a document that WAS cleaned and
  // could not be stored (that buffer is the submitted, uncleaned file). The
  // module reports the second separately so the lanes can drop the slot.
  {
    const fakePkg = { ...(winWalk as ExtractOk), cleaning: undefined };
    const mdRecord = {
      droppedPaths: [],
      redactedPaths: ["SKILL.md"],
      excludedPaths: [],
      rules: [{ ruleId: "private-key", cls: "credential" as const }],
      stored: null,
      failed: "document rebuild failed",
    };
    const d = decideStorage({
      pkg: fakePkg,
      submittedArchive: Buffer.from("PKG"),
      md: {
        extract: { ...(winWalk as ExtractOk), cleaning: mdRecord },
        submitted: Buffer.from("SUBMITTED-UNCLEANED-MD"),
      },
    });
    assert.equal(d.mdData, null, "no cleaned document bytes are offered");
    assert.equal(
      d.mdFailed,
      "document rebuild failed",
      "and the failure is reported separately, so the lanes can tell it apart from having no slot"
    );
    // `failed` stays PACKAGE-only, because notify's "NO COPY RETAINED" keys on
    // it and that sentence is about the package; the document slot has its own
    // field so the failure is still recorded rather than looking like success.
    assert.equal(d.failed, null, "a document failure is not a package failure");
    const rec = JSON.parse(d.cleaningJson!) as { mdFailed?: string | null };
    assert.equal(
      rec.mdFailed,
      "document rebuild failed",
      "and the stored record carries it, or nothing downstream can tell"
    );
  }
  // The benign shape: no document slot passed at all.
  {
    const d = decideStorage({
      pkg: winWalk as ExtractOk,
      submittedArchive: Buffer.from("PKG"),
    });
    assert.equal(d.mdFailed, null, "no slot is not a failure");
  }
  // Every lane guards on mdFailed rather than on mdData being null.
  for (const lane of [
    "src/app/api/work/submissions/route.ts",
    "src/app/api/work/submissions/[id]/update/route.ts",
    "src/lib/work/email-intake.ts",
    "scripts/work-submit.ts",
  ]) {
    assert.ok(
      /mdMeta && !storage\.mdFailed/.test(readFileSync(lane, "utf8")),
      `${lane} must drop the document slot on a document-rebuild failure, not fall back to the submitted file`
    );
  }

  // ---- FIRST_PARTY_PEOPLE disclosure allowlist (owner ruling 2026-08-29/30;
  // DISCLOSURE-ALLOWLIST seat). Two cards held on names the /work page
  // itself publishes: "introduced XL.net CEO Adam Radulovic" (row 859ba29b;
  // the skill's own template introduces him) and "Leo Netter" (which has its
  // own exhibit on the same page). The allowlist is enforced in the prompt
  // AND deterministically (clearFirstPartyPeople), so a model that hits
  // anyway cannot hold the card. personal_names' default, hold any real
  // private person, is unchanged. ----
  {
    const { clearFirstPartyPeople } = await import(
      "../src/lib/work/first-party"
    );
    const { FIRST_PARTY_PEOPLE } = await import("../src/lib/work/config");

    // The register stays tiny, full-name only, dash-free: a bare first name
    // in the allowlist would make the whole-name rule below vacuous.
    assert.ok(
      FIRST_PARTY_PEOPLE.length <= 8,
      "FIRST_PARTY_PEOPLE stays a tiny explicit register, not a directory"
    );
    for (const p of FIRST_PARTY_PEOPLE) {
      assert.ok(
        p.name.trim().includes(" "),
        `allowlist entries are FULL names ("${p.name}")`
      );
      assert.ok(
        !/[–—]/.test(p.name) && !/[–—]/.test(p.role),
        `no em/en dash in FIRST_PARTY_PEOPLE entry "${p.name}"`
      );
    }

    // The live specimens first, then the shapes around them.
    const alone = clearFirstPartyPeople("Adam Radulovic");
    assert.deepEqual(alone.cleared, ["Adam Radulovic"], "the CEO's name clears");
    assert.ok(!alone.holds, "a finding that is ONLY the CEO's name clears");
    assert.ok(
      !clearFirstPartyPeople("CEO Adam Radulovic").holds,
      "a role title before the name is residue, not another person"
    );
    assert.ok(
      !clearFirstPartyPeople("Adam Radulovic (CEO)").holds,
      "a parenthetical role after the name is residue too"
    );
    assert.ok(
      !clearFirstPartyPeople('"introduced XL.net CEO Adam Radulovic"').holds,
      "the row 859ba29b specimen clears whole: XL.net is itself a never-hit"
    );
    assert.ok(
      !clearFirstPartyPeople("adam radulovic").holds,
      "matching is case-insensitive"
    );
    assert.ok(!clearFirstPartyPeople("Leo Netter").holds, "the persona clears");
    assert.ok(
      !clearFirstPartyPeople("Tron Netter").holds,
      "the public agent persona clears"
    );
    assert.ok(
      !clearFirstPartyPeople("Troy Netter").holds,
      "the legacy alias clears"
    );

    // A finding that ALSO names someone else holds, on the remainder only.
    const mixed = clearFirstPartyPeople("Adam Radulovic; Jane Doe");
    assert.deepEqual(mixed.cleared, ["Adam Radulovic"]);
    assert.ok(mixed.holds, "Jane Doe still holds the card");
    assert.equal(
      mixed.remainder,
      "Jane Doe",
      "and the hold shows ONLY the remainder"
    );

    // "Adam" alone is NOT cleared: a bare first name is ambiguous (any Adam
    // could be a client contact), the credit lane already handles first
    // names, and ambiguity holds. Whole-name matching only.
    const bare = clearFirstPartyPeople("Adam");
    assert.deepEqual(bare.cleared, [], "a bare first name never clears");
    assert.ok(bare.holds);
    assert.equal(bare.remainder, "Adam", "an untouched finding passes through");
    assert.ok(
      clearFirstPartyPeople("Adam Radulovich").holds &&
        clearFirstPartyPeople("Adam Radulovich").cleared.length === 0,
      "whole-name boundary: Radulovich is not Radulovic"
    );
    const untouched = clearFirstPartyPeople("Jane Doe of Acme");
    assert.ok(untouched.holds && untouched.cleared.length === 0);
    assert.equal(untouched.remainder, "Jane Doe of Acme");

    // Held-reason parsing: "(after first-party clearing)" rides the same
    // parenthetical slot friendlyHeldReason already grants adjudication.
    assert.ok(
      friendlyHeldReason(
        "disclosure checklist hit:\npersonal_names (after first-party clearing): Jane Doe"
      )?.startsWith("A person's name:"),
      "friendly label still applies after the clearing parenthetical"
    );

    // ---- source pins ----
    const panelSrcFp = readFileSync("src/lib/work/panel.ts", "utf8");
    assert.ok(
      /const neverHits = `Never hits under any item: \$\{sctx\.neverHitNames\.join[\s\S]{0,600}?FIRST_PARTY_PEOPLE\.map/.test(
        panelSrcFp
      ),
      "panel.ts's neverHits sentence interpolates FIRST_PARTY_PEOPLE with their roles"
    );
    const stripAt = panelSrcFp.indexOf("clearFirstPartyPeople(");
    const holdAt = panelSrcFp.indexOf("disclosure checklist hit");
    assert.ok(
      stripAt !== -1 && holdAt !== -1 && stripAt < holdAt,
      "the deterministic strip runs BEFORE the disclosure hold is composed"
    );
    assert.ok(
      /item === "personal_names"/.test(panelSrcFp),
      "the strip is scoped to personal_names; org-name adjudication is untouched"
    );
    const scopeSrcFp = readFileSync("src/lib/work/scope.ts", "utf8");
    assert.equal(
      (scopeSrcFp.match(/FIRST_PARTY_PEOPLE\.map\(\(p\) => p\.name\)/g) ?? [])
        .length,
      2,
      "scope.ts folds the people into neverHitNames for BOTH lanes"
    );

    // ---- placements survival on re-runs (peer requirement 2026-08-30):
    // TEAM_CARD_PLACEMENTS keys bays on the SLUG, and a slug-changing
    // retitle silently drops a placed card back into the From the Team run,
    // so the rerun script must consult placements.ts before the confirm
    // prompt. ----
    const rerunSrc = readFileSync("scripts/work-panel-rerun.ts", "utf8");
    assert.ok(
      /from "\.\.\/src\/lib\/work\/placements"/.test(rerunSrc),
      "work-panel-rerun.ts imports placements.ts"
    );
    assert.ok(
      rerunSrc.includes("TEAM_CARD_PLACEMENTS") &&
        rerunSrc.includes("--keep-position"),
      "the rerun script checks TEAM_CARD_PLACEMENTS and offers --keep-position"
    );
    const warnAt = rerunSrc.indexOf("this card is PLACED");
    const promptAt = rerunSrc.indexOf("Type yes:");
    assert.ok(
      warnAt !== -1 && promptAt !== -1 && warnAt < promptAt,
      "the placement warning prints BEFORE the confirm prompt"
    );
  }

  // ═══ §5.16 ops re-run flags: --no-notify + --keep-position (2026-08-30,
  // OPS-RERUN seat). Owner directive ("present tense this and other cards
  // that remain", "with no notify on those 26 past tense fixes"): re-running
  // the ~26-37 published cards whose TOOL copy is past tense (house rule
  // corrected in 39257b2) must neither re-fire the publish emails nor move
  // the cards. Pinned DB-free: panel.ts routes every outcome mail through
  // local consts that no-op under notify: false, finishPublished restores a
  // captured published_at + display_rank only when handed one, and the
  // script's argv rules are pure functions in scripts/lib/work-rerun-ops.ts. ═══
  {
    const [{ readFileSync: readRr, readdirSync: rrDir }, { join: rrJoin }] =
      await Promise.all([import("node:fs"), import("node:path")]);
    const {
      firstSentence,
      parseRerunArgs,
      rerunPlanLine,
      summaryFirstSentence,
    } = await import("./lib/work-rerun-ops");

    // 1) The default is preserved at EVERY call site: nothing outside the
    // ops script passes a notify/keep* override to kickPanel, so absent
    // means mail on and a fresh published_at, today's behaviour byte for
    // byte. The walk fails loud if a new caller appears with an override.
    const walkRr = (dir: string): string[] =>
      rrDir(dir, { withFileTypes: true }).flatMap((e) => {
        if (e.name === "node_modules" || e.name.startsWith(".")) return [];
        const p = rrJoin(dir, e.name);
        if (e.isDirectory()) return walkRr(p);
        return /\.tsx?$/.test(e.name) ? [p] : [];
      });
    const rrCallers = [...walkRr("src"), ...walkRr("scripts")].filter(
      (p) =>
        !/[-.]tests?\.ts$/.test(p) &&
        !p.endsWith("src/lib/work/panel.ts") &&
        !p.endsWith("scripts/work-panel-rerun.ts") &&
        /kickPanel\s*\(/.test(readRr(p, "utf8"))
    );
    for (const known of [
      "src/app/api/work/submissions/route.ts",
      "src/app/api/work/submissions/[id]/retry/route.ts",
      "src/app/api/work/submissions/[id]/rerun/route.ts",
      "src/app/api/work/submissions/[id]/update/route.ts",
      "src/lib/work/email-intake.ts",
      "src/lib/work/queue-drain.ts",
    ])
      assert.ok(
        rrCallers.some((p) => p.endsWith(known)),
        `the kickPanel call-site walk still sees ${known}`
      );
    for (const p of rrCallers) {
      const src = readRr(p, "utf8");
      for (const m of src.matchAll(/kickPanel\(([^)]*)\)/g))
        assert.ok(
          !/notify|keepPublishedAt|keepDisplayRank/.test(m[1]),
          `${p} passes a notify/keep override to kickPanel; only scripts/work-panel-rerun.ts may`
        );
    }

    // 2) panel.ts: runPanel stays module-private (nothing outside the file
    // can hand it options), both kick lanes thread opts, and the
    // suppression seam covers all four outcome notify functions plus the
    // update pair, with an explicit === false guard so undefined mails.
    const panelRr = readRr("src/lib/work/panel.ts", "utf8");
    assert.ok(
      !/export (?:async )?function runPanel\b/.test(panelRr),
      "runPanel is module-private"
    );
    assert.equal(
      (panelRr.match(/runPanel\(id, attemptId, brainCap, opts\)/g) ?? []).length,
      2,
      "both kick lanes thread opts into runPanel"
    );
    assert.ok(
      /const silent = opts\.notify === false;/.test(panelRr),
      "the seam guard is an explicit === false (absent/undefined = mail on)"
    );
    assert.ok(
      panelRr.includes("[work] rerun: notifications suppressed for ${id}"),
      "the one suppression log line exists"
    );
    const seamFrom = panelRr.indexOf("--no-notify suppression seam");
    const seamTo = panelRr.indexOf("end --no-notify seam");
    assert.ok(seamFrom > 0 && seamTo > seamFrom, "the seam block is delimited");
    const seamRr = panelRr.slice(seamFrom, seamTo);
    for (const fn of [
      "notifyPublished",
      "deliverArchiveRetention",
      "notifyHeld",
      "notifyUpdateAutoPublished",
      "notifyUpdateConflictHeld",
      "notifyUpdatePending",
    ])
      assert.ok(
        new RegExp(`const ${fn}: typeof ${fn}Mail = silent`).test(seamRr),
        `the suppression seam covers ${fn}`
      );
    // A direct alias call outside the seam would bypass suppression: each
    // alias appears exactly three times (the import rename, the seam's
    // typeof, the seam's else branch).
    for (const alias of [
      "notifyPublishedMail",
      "deliverArchiveRetentionMail",
      "notifyHeldMail",
      "notifyUpdateAutoPublishedMail",
      "notifyUpdateConflictHeldMail",
      "notifyUpdatePendingMail",
    ]) {
      // Retention is the one non-mail-only function: its silent branch must
      // still CALL the real function (with { silent: true }, which clears
      // row bytea without sending; 2026-08-30 refutation), so its alias
      // legitimately appears a fourth time INSIDE the seam. Everything else
      // stays at import + seam type + notify-on assignment = 3, and any
      // extra occurrence is a bypass.
      const expected = alias === "deliverArchiveRetentionMail" ? 4 : 3;
      assert.equal(
        (panelRr.match(new RegExp(alias, "g")) ?? []).length,
        expected,
        `${alias}: import + seam only; an extra occurrence is a bypass`
      );
    }
    assert.ok(
      panelRr.includes("deliverArchiveRetentionMail(r, { silent: true })"),
      "the silent retention branch still clears row bytea (calls the real function silenced)"
    );
    assert.ok(
      readFileSync("src/lib/work/notify.ts", "utf8").includes(
        "opts?: { silent?: boolean }"
      ),
      "deliverArchiveRetention takes the silent option"
    );
    // The failure alert is suppressed by the same flag, via the
    // module-scope set kickPanel arms only after a successful claim.
    assert.equal(
      (panelRr.match(/silentAttempts\.add\(attemptId\)/g) ?? []).length,
      2,
      "both kick lanes arm the silent set"
    );
    assert.ok(
      /opts\?\.notify === false\) silentAttempts\.add/.test(panelRr),
      "the set is armed only on an explicit notify: false"
    );
    assert.ok(
      /silentAttempts\.has\(attemptId\)/.test(panelRr),
      "failRun consults the silent set before notifyPanelFailed"
    );
    assert.ok(
      /silentAttempts\.delete\(attemptId\)/.test(panelRr),
      "the run's settlement clears the set"
    );

    // 3) finishPublished: keep is opt-in with now() as the default stamp,
    // and display_rank is written only on the keep path.
    const dbRr = readRr("src/lib/work/db.ts", "utf8");
    assert.ok(
      /publishedAt: keep \? keep\.publishedAt : new Date\(\),/.test(dbRr),
      "finishPublished stamps now() unless handed a captured published_at"
    );
    assert.ok(
      /\.\.\.\(keep \? \{ displayRank: keep\.displayRank \} : \{\}\),/.test(dbRr),
      "display_rank is restored only on the keep path"
    );

    // 4) The script: argv goes through the pure parser, both flags are
    // documented in the header, keep-position and no-notify ride ONLY
    // behind their flags, and the summary says "No email was sent".
    const scriptRr = readRr("scripts/work-panel-rerun.ts", "utf8");
    const headerRr = scriptRr.slice(0, scriptRr.indexOf("async function main"));
    for (const flag of ["--no-notify", "--keep-position"])
      assert.ok(headerRr.includes(flag), `the header comment documents ${flag}`);
    assert.ok(
      /parseRerunArgs\(process\.argv\.slice\(2\)\)/.test(scriptRr),
      "argv goes through the pure parser"
    );
    assert.ok(
      /\.\.\.\(noNotify \? \{ notify: false \} : \{\}\)/.test(scriptRr),
      "notify: false rides only behind --no-notify"
    );
    assert.ok(
      /\.\.\.\(keepPosition[\s\S]{0,140}?keepPublishedAt: origPublishedAt/.test(
        scriptRr
      ),
      "keepPublishedAt rides only behind --keep-position (opt-in, never a default)"
    );
    assert.ok(
      scriptRr.includes("No email was sent"),
      "the console summary states the suppression in words"
    );
    const planAtRr = scriptRr.indexOf("rerunPlanLine(");
    const promptAtRr = scriptRr.indexOf("Type yes:");
    assert.ok(
      planAtRr !== -1 && promptAtRr !== -1 && planAtRr < promptAtRr,
      "the dry plan line prints BEFORE the confirm prompt"
    );
    assert.ok(
      /summaryFirstSentence\(after\.cardJson\)/.test(scriptRr),
      "the script prints the new summary first sentence after publish"
    );

    // 5) parseRerunArgs: flags, combinations, refusals.
    const rrUid = "2d17baef-3130-425c-8689-69617b6811c3";
    assert.ok(!parseRerunArgs([]).ok, "an id is required");
    assert.ok(!parseRerunArgs(["not-a-uuid"]).ok, "a non-uuid is refused");
    {
      const d = parseRerunArgs([rrUid]);
      if (!d.ok) assert.fail(`the bare-id parse refused: ${d.error}`);
      assert.equal(d.args.noNotify, false, "--no-notify is opt-in");
      assert.equal(d.args.keepPosition, false, "--keep-position is opt-in");
      assert.equal(d.args.title, null);
      assert.equal(d.args.retitleOnly, false);
      assert.equal(d.args.yes, false);
    }
    {
      const d = parseRerunArgs([
        rrUid,
        "--no-notify",
        "--keep-position",
        "--title",
        "Better Name",
        "--yes",
      ]);
      if (!d.ok) assert.fail(`the combined parse refused: ${d.error}`);
      assert.ok(
        d.args.noNotify && d.args.keepPosition && d.args.title === "Better Name",
        "both flags combine with each other and with --title"
      );
    }
    {
      const d = parseRerunArgs([rrUid, "--frobnicate"]);
      assert.ok(
        !d.ok && /unknown flag --frobnicate/.test(d.error),
        "an unknown flag is refused by name, never ignored"
      );
    }
    assert.ok(!parseRerunArgs([rrUid, "--title"]).ok, "--title needs a value");
    assert.ok(
      !parseRerunArgs([rrUid, "--title", "A", "--title", "B"]).ok,
      "--title twice is refused"
    );
    assert.ok(
      !parseRerunArgs([rrUid, "--retitle-only"]).ok,
      "--retitle-only requires --title"
    );
    assert.ok(
      !parseRerunArgs([rrUid, "--retitle-only", "--title", "T", "--no-notify"])
        .ok,
      "--no-notify on the retitle branch is refused, not ignored"
    );
    {
      // --retitle-only WITH --keep-position is the stay-put assertion the
      // placements guard enforces (the script dies on a slug-changing
      // retitle under it), so the parse accepts the combination.
      const d = parseRerunArgs([rrUid, "--retitle-only", "--title", "T", "--keep-position"]);
      assert.ok(d.ok, "--keep-position combines with --retitle-only (slug guard)");
    }
    assert.ok(!parseRerunArgs([rrUid, rrUid]).ok, "a second positional is refused");

    // 6) The plan line names all three side effects in every combination.
    for (const noNotify of [false, true])
      for (const keepPosition of [false, true])
        for (const slugChanges of [false, true]) {
          const line = rerunPlanLine({
            noNotify,
            keepPosition,
            slugChanges,
            publishedAt: new Date("2026-07-12T00:00:00Z"),
            displayRank: 3,
            slug: "ticket-reply-composer",
          });
          assert.ok(
            /emails:/.test(line) && /position:/.test(line) && /slug:/.test(line),
            "the plan line covers all three side effects"
          );
          assert.ok(
            noNotify ? /NONE will be sent/.test(line) : /WILL send/.test(line),
            "the emails verdict is stated either way"
          );
          assert.ok(
            keepPosition ? /KEPT/.test(line) : /WILL move/.test(line),
            "the position verdict is stated either way"
          );
          assert.ok(
            slugChanges
              ? /NEW slug/.test(line)
              : /WILL NOT change/.test(line),
            "the slug verdict is stated either way"
          );
          assert.ok(!/[–—]/.test(line), "no em or en dashes in the plan line");
        }
    assert.ok(
      /none yet/.test(
        rerunPlanLine({
          noNotify: false,
          keepPosition: false,
          slugChanges: false,
          publishedAt: null,
          displayRank: null,
          slug: null,
        })
      ),
      "a never-published row's plan says the slug is minted fresh"
    );

    // 7) The tense line the operator reads: first sentences, before/after.
    assert.equal(
      firstSentence(
        "Ticket Reply Composer was a helpdesk app. It drafted replies."
      ),
      "Ticket Reply Composer was a helpdesk app.",
      "the first sentence stops at the first terminator"
    );
    assert.equal(
      firstSentence("No terminator at all"),
      "No terminator at all",
      "a summary with no terminator comes back whole"
    );
    assert.equal(
      summaryFirstSentence(
        JSON.stringify({ summary: "It drafts replies. More detail follows." })
      ),
      "It drafts replies."
    );
    assert.equal(
      summaryFirstSentence(null),
      null,
      "a held row's nulled cardJson reads as no stored copy"
    );
    assert.equal(summaryFirstSentence("{not json"), null, "junk bytes read as none");
    assert.equal(
      summaryFirstSentence(JSON.stringify({ title: "x" })),
      null,
      "a card with no summary reads as none"
    );

    // 8) No em or en dashes in the re-run lane's sources.
    for (const src of [scriptRr, readRr("scripts/lib/work-rerun-ops.ts", "utf8")])
      assert.ok(!/[–—]/.test(src), "no em or en dashes in the re-run lane");
  }

  console.log("work-tests: all assertions passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
