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
  inferKind,
  parseSubmissionBody,
  pickAttachments,
  stripKindPrefix,
  titleFromSubject,
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

  console.log("work-tests: all assertions passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
