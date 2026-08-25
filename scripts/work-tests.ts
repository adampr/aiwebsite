// Tests for the team work submission pipeline's pure pieces (§5.16):
// archive inspection (required-doc rule, zip hardening, secret scan) and the
// deterministic card lint. Run: npm run test:work (tsx, no DB, no brain).

import assert from "node:assert";
import JSZip from "jszip";
import {
  hasSkillFrontmatter,
  inspectArchive,
  inspectBareMd,
  mergeSkillCorpus,
  nonZipMessage,
  proseLength,
} from "../src/lib/work/extract";
import {
  isNoneFound,
  lintCard,
  quoteInCorpus,
  slugForTitle,
  wordCount,
} from "../src/lib/work/lint";
import { friendlyHeldReason } from "../src/lib/work/view";
import { isFreshDate } from "../src/lib/governance/approval";
import {
  archiveDeclaredNames,
  docDeclaredNames,
  inferKind,
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
  TITLE_KIND_PREFIX_RE,
  WORK_CAPS,
  formatByteSize,
  nextStorageReportDueMs,
} from "../src/lib/work/config";
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

  const secretFile = await inspectArchive(
    await zipOf({ "architecture.md": PROSE, ".env": "X=1" }),
    "program"
  );
  assert.ok(!secretFile.ok && secretFile.code === "secrets_detected");
  assert.deepEqual(!secretFile.ok && secretFile.paths, [".env"]);

  // Fixture assembled at runtime so the repo's own pre-commit secrets gate
  // (which scans staged literals) does not trip on a deliberately fake key.
  const fakeSecretLine = ["API", "KEY"].join("_") + '="abcdefgh12345678"';
  const secretContent = await inspectArchive(
    await zipOf({
      "architecture.md": PROSE,
      "notes.md": fakeSecretLine,
    }),
    "program"
  );
  assert.ok(!secretContent.ok && secretContent.code === "secrets_detected");

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
    { card: { ...goodCard(), title: "Log Analyzer" }, frees: ["title"] }, // static collision
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
      "numbers; no HTML or markdown markup; plain factual prose; past tense for " +
      "anything that ran; every claim must be supported by the submitted " +
      "documents; claims must not outrun the evidence.",
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
  assert.ok(!dirty.ok && dirty.code === "secrets_detected", "inner secret rejected");
  assert.ok(
    !dirty.ok && dirty.paths?.some((p) => p === "my-skill.skill!/.env"),
    "inner secret path is prefixed"
  );

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

  assert.equal(inferKind("OUTAGE_1.SKI", false, null), "skill");
  assert.equal(inferKind("tool.skill", false, null), "skill");
  assert.equal(inferKind("tool.zip", true, null), "skill");
  assert.equal(inferKind("tool.zip", false, null), "program");
  assert.equal(inferKind("tool.skill", true, "program"), "program", "explicit kind wins");

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
      /text:\s*withTronSignature\(opts\.text\)/.test(intakeSrc),
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
    assert.ok(
      island.includes("{canListAll &&\n                  isMine(r) &&"),
      "Withdraw matches the DELETE route's predicate and never targets a stranger's row"
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

    // Content-Length precheck in BOTH upload routes, before formData().
    for (const lane of [
      "src/app/api/work/submissions/route.ts",
      "src/app/api/work/submissions/[id]/update/route.ts",
    ]) {
      const src = readFileSync(lane, "utf8");
      const clAt = src.indexOf('req.headers.get("content-length")');
      const formAt = src.indexOf("await req.formData()");
      assert.ok(
        clAt > 0 && formAt > clAt,
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
      "import refuses on ANY ledger row, deleted included (cleanup is final)"
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

  console.log("work-tests: all assertions passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
