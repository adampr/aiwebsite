// Tests for the team work submission pipeline's pure pieces (§5.16):
// archive inspection (required-doc rule, zip hardening, secret scan) and the
// deterministic card lint. Run: npm run test:work (tsx, no DB, no brain).

import assert from "node:assert";
import JSZip from "jszip";
import {
  inspectArchive,
  inspectBareMd,
  mergeSkillCorpus,
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
  senderIdentityTokens,
  stripKindPrefix,
  titleFromSubject,
  validateInferredTitle,
  validateWeakTitle,
} from "../src/lib/work/email-parse";
import {
  HOUSE_RULES,
  TITLE_KIND_PREFIX_RE,
} from "../src/lib/work/config";
import staticTitles from "../src/lib/work/static-titles.json";

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
    supersededAt: null,
    slug: null,
    publishedAt: null,
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
  for (const s of [tronSignature(), FORM_POINTER])
    assert.ok(!/—|–/.test(s), "no em or en dash in outbound constants");

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

  console.log("work-tests: all assertions passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
