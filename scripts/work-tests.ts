// Tests for the team work submission pipeline's pure pieces (§5.16):
// archive inspection (required-doc rule, zip hardening, secret scan) and the
// deterministic card lint. Run: npm run test:work (tsx, no DB, no brain).

import assert from "node:assert";
import JSZip from "jszip";
import {
  inspectArchive,
  inspectBareMd,
  proseLength,
} from "../src/lib/work/extract";
import { lintCard, slugForTitle, wordCount } from "../src/lib/work/lint";
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
  const skillMissing = await inspectArchive(
    await zipOf({ "myskill/readme.md": PROSE }),
    "skill"
  );
  assert.ok(!skillMissing.ok && skillMissing.code === "missing_skill_doc");

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

  console.log("work-tests: all assertions passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
