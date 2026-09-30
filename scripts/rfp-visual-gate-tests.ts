/**
 * Visual blocks through the gate and the exporters (ARCHITECTURE.md §5.17).
 *
 *   npm run test:rfpvisualgate
 *
 * Pure, no server, no DB. Pins the adapter and the emitters in both directions:
 * a prose-only record resolves EXACTLY as it did before visuals existed (ids,
 * ordinals, hash input); every fixture visual lifts into a content-model block
 * the zod schema accepts, at its interleave position, with every visible string
 * in the validators' scan surface; the gate is the backstop behind the sanitizer
 * (a "$500" or an em dash smuggled past it is caught by B7 / D1, an unknown cite
 * by A5); D4 reads a stated headcount and never the high end of the client-size
 * range; and both files carry every block, in flow order, with the ornaments
 * loaded the same way as the existing ones (a missing file is a clean ENOENT).
 */

import { isDeepStrictEqual } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { blockSchema } from "../src/lib/rfp/content-model/schema";
import {
  blockTextSpans,
  canonicalJson,
  resolvedTextSpans,
  type Block,
} from "../src/lib/rfp/content-model";
import { runGate } from "../src/lib/rfp/validators/gate";
import { prospectHeadcount } from "../src/lib/rfp/validators/rules-d";
import { resolveDraft, runDraftGate } from "../src/lib/rfp/resolve-draft";
import {
  buildExportView,
  renderRfpDocx,
  renderRfpPdf,
  type ExportFlowItem,
} from "../src/lib/rfp/export";
import { loadRfpExportAssets } from "../src/lib/rfp/export-assets";
import {
  DRAFT_BLOCK_KINDS,
  buildAboutBlocks,
  interleave,
  sanitizeStoredBlocks,
  type DraftBlock,
} from "../src/lib/rfp/draft-blocks";
import {
  sections as fixtureSections,
  stretchTimelineBlock,
  type FixtureSection,
} from "./fixtures/rfp-visual-fixture";
import { buildFixtureGateInput, withTimeline } from "./rfp-render-fixture";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (!ok) failures++;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${label}${ok || detail === undefined ? "" : `\n     ${JSON.stringify(detail)}`}`
  );
}

const proseOnly = (secs: FixtureSection[]): FixtureSection[] =>
  secs.map((s) => {
    const { blocks: _blocks, ...rest } = s;
    return rest;
  });

/* ---- 0. Ornaments: a missing file is the same clean ENOENT ---------------- */
// Before any render (the loader caches), from a directory with no public/brand.
{
  const cwd = process.cwd();
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "rfp-assets-"));
  process.chdir(empty);
  let err: unknown = null;
  try {
    loadRfpExportAssets();
  } catch (e) {
    err = e;
  } finally {
    process.chdir(cwd);
    fs.rmSync(empty, { recursive: true, force: true });
  }
  check(
    "assets: missing brand dir throws ENOENT (fonts and ornaments alike)",
    err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT",
    err instanceof Error ? err.message : err
  );
  const assets = loadRfpExportAssets();
  check(
    "assets: three badge marks, three step dots, one step rule, all PNG",
    [...assets.images.badgeMarks, ...assets.images.stepDots, assets.images.stepRule].every(
      (b) => b.subarray(1, 4).toString() === "PNG"
    )
  );
}

/* ---- 1. Legacy: a prose-only record resolves exactly as before ------------ */
{
  const legacy = proseOnly(fixtureSections);
  const { resolved } = resolveDraft(buildFixtureGateInput(legacy));
  // The pre-visuals adapter, restated: one ProseBlock per paragraph, id by
  // paragraph index, ordinal = index, the section's cites and generatedBy.
  const expected = legacy
    .filter((s) => s.label !== "__letter")
    .map((sec) => ({
      id: `sec_${sec.label.replace(/[^a-zA-Z0-9]+/g, "_")}`,
      blocks: sec.paragraphs.map((text, i) => ({
        kind: "prose",
        id: `b_${sec.label.replace(/[^a-zA-Z0-9]+/g, "_")}_${i}`,
        sectionId: `sec_${sec.label.replace(/[^a-zA-Z0-9]+/g, "_")}`,
        ordinal: i,
        cites: sec.cites,
        generatedBy: sec.generatedBy,
        editedByHuman: sec.generatedBy === "human",
        text,
      })),
    }));
  check(
    "legacy: prose-only sections resolve to the pre-visuals block list, key for key",
    isDeepStrictEqual(
      resolved.sections.map((s) => ({ id: s.id, blocks: s.blocks })),
      expected
    ),
    resolved.sections[0]?.blocks[0]
  );
  // `blocks: []` and an absent key are the same record to the adapter.
  const withEmpty = legacy.map((s) => (s.label === "__letter" ? s : { ...s, blocks: [] }));
  const a = resolveDraft(buildFixtureGateInput(legacy)).resolved;
  const b = resolveDraft(buildFixtureGateInput(withEmpty)).resolved;
  check("legacy: `blocks: []` resolves byte-identically to no key", canonicalJson(a) === canonicalJson(b));
  // A prose-only section keeps its ids even when a sibling section has visuals.
  const mixed = resolveDraft(buildFixtureGateInput(withTimeline(fixtureSections))).resolved;
  const five = mixed.sections.find((s) => s.structureLabel === "5.")!;
  check(
    "legacy: the prose-only section beside visual ones keeps b_<label>_<i> ids and ordinals",
    isDeepStrictEqual(
      five.blocks.map((x) => [x.id, x.ordinal]),
      [
        ["b_5__0", 0],
        ["b_5__1", 1],
      ]
    ),
    five.blocks.map((x) => [x.id, x.ordinal])
  );
}

/* ---- 2. Lifting: every fixture block, at its interleave position ---------- */
const input = buildFixtureGateInput(withTimeline(fixtureSections));
const { resolved, requirements, coverage, factsById, knowledge } = resolveDraft(input);
const storedBlocks: { label: string; block: DraftBlock }[] = [];
for (const s of input.sections)
  for (const b of sanitizeStoredBlocks(s.blocks, s.paragraphs.length)) storedBlocks.push({ label: s.label, block: b });
check("fixture: every v1 kind and the timeline are present", isDeepStrictEqual(
  [...new Set(storedBlocks.map((x) => x.block.kind))].sort(),
  [...DRAFT_BLOCK_KINDS].sort()
));
{
  const lifted = resolved.sections.flatMap((s) => s.blocks.filter((b) => b.kind !== "prose"));
  check("lift: one content-model block per stored visual", lifted.length === storedBlocks.length, [lifted.length, storedBlocks.length]);
  for (const { label, block } of storedBlocks) {
    const id = `bv_${label.replace(/[^a-zA-Z0-9]+/g, "_")}_${block.id}`;
    const got = lifted.find((b) => b.id === id);
    const parsed = got ? blockSchema.safeParse(got) : null;
    check(`lift: ${block.kind} ${block.id} -> ${id} passes blockSchema`, !!parsed && parsed.success, parsed && !parsed.success ? parsed.error.issues : undefined);
    if (!got) continue;
    const { id: _id, after: _after, origin: _origin, ...body } = block;
    const { id: _gid, sectionId: _sid, ordinal: _ord, editedByHuman, ...gotBody } = got;
    check(`lift: ${id} body, cites and generatedBy are the stored ones; editedByHuman false`,
      isDeepStrictEqual(gotBody, body) && editedByHuman === false, { gotBody, body });
  }
  // Ordinal = flow index, and the flow is interleave's, section by section.
  for (const sec of input.sections) {
    if (sec.label === "__letter") continue;
    const flow = interleave(sec.paragraphs, sanitizeStoredBlocks(sec.blocks, sec.paragraphs.length));
    const rs = resolved.sections.find((s) => s.structureLabel === sec.label)!;
    const want = flow.map((f, i) =>
      f.type === "p"
        ? { kind: "prose", id: `b_${sec.label.replace(/[^a-zA-Z0-9]+/g, "_")}_${f.index}`, ordinal: i }
        : { kind: f.block.kind, id: `bv_${sec.label.replace(/[^a-zA-Z0-9]+/g, "_")}_${f.block.id}`, ordinal: i }
    );
    check(`order: section ${sec.label} resolves in interleave order with ordinal = flow index`,
      isDeepStrictEqual(rs.blocks.map((b) => ({ kind: b.kind, id: b.id, ordinal: b.ordinal })), want),
      rs.blocks.map((b) => [b.kind, b.id, b.ordinal]));
  }
  const three = resolved.sections.find((s) => s.structureLabel === "3.")!;
  check("order: two blocks at `after: 0` open section 3 in stored order, prose ids unchanged",
    isDeepStrictEqual(three.blocks.map((b) => b.id), ["bv_3__v_0000a003", "b_3__0", "bv_3__v_0000a004", "b_3__1"]),
    three.blocks.map((b) => b.id));
  const six = resolved.sections.find((s) => s.structureLabel === "6.")!;
  check("order: a block at `after: paragraphs.length` closes section 6",
    six.blocks[six.blocks.length - 1]?.id === `bv_6__${stretchTimelineBlock.id}`, six.blocks.map((b) => b.id));
}

/* ---- 3. Scan surface: every visible string of every block --------------- */
{
  const spans = resolvedTextSpans(resolved);
  for (const { label, block } of storedBlocks) {
    const id = `bv_${label.replace(/[^a-zA-Z0-9]+/g, "_")}_${block.id}`;
    const mine = spans.filter((s) => s.blockId === id).map((s) => s.text);
    const strings = visibleStrings(block);
    const missing = strings.filter((t) => !mine.includes(t));
    check(`spans: ${block.kind} ${block.id} puts all ${strings.length} strings in the scan surface`, missing.length === 0, missing);
  }
  const lifted = resolved.sections.flatMap((s) => s.blocks);
  check("spans: blockTextSpans covers the fields draft-blocks renders (no silent field)",
    lifted.every((b) => b.kind === "prose" || blockTextSpans(b).length > 0));
}

function visibleStrings(b: DraftBlock): string[] {
  switch (b.kind) {
    case "stat-tiles": return b.tiles.flatMap((t) => [t.value, t.label, ...(t.note ? [t.note] : [])]);
    case "fact-grid": return b.pairs.flatMap((p) => [p.label, p.value]);
    case "badge-strip": return b.badges.flatMap((x) => [x.label, ...(x.note ? [x.note] : [])]);
    case "table": return [...(b.caption ? [b.caption] : []), ...b.columns.map((c) => c.header), ...b.rows.flat()];
    case "callout": return [...(b.title ? [b.title] : []), b.body];
    case "cards": return b.cards.flatMap((c) => [c.title, c.body, ...(c.footnote ? [c.footnote] : [])]);
    case "timeline": return b.steps.flatMap((s) => [s.label, s.title, s.body]);
  }
}

/* ---- 4. The gate on the fixture, and as the backstop behind the sanitizer  */
{
  const gate = runDraftGate(input);
  const fromVisuals = gate.violations.filter((v) => v.locator.blockId?.startsWith("bv_"));
  check("gate: the fixture's visual blocks raise no violation at all", fromVisuals.length === 0,
    fromVisuals.map((v) => [v.ruleId, v.locator.blockId, v.message]));
  check("gate: no BLOCK anywhere in the fixture (a WARN may remain)", gate.violations.every((v) => v.severity !== "block"),
    gate.violations.map((v) => [v.ruleId, v.severity, v.message.slice(0, 90)]));
  // The two-up onsite cards carry the second half of the onsite policy: A4
  // reads visual text (prose-only, the same fixture trips A4).
  const proseGate = runDraftGate(buildFixtureGateInput(proseOnly(fixtureSections)));
  check("gate: A4 reads the cards (fires on the prose-only fixture, not on the visual one)",
    proseGate.violations.some((v) => v.ruleId === "A4") && !gate.violations.some((v) => v.ruleId === "A4"));

  const ctx = { proposal: resolved, knowledge, rateCard: input.rateCard, requirements, coverage, factsById,
    statesHeadcountOnly: false, supportedUserSplitConfirmed: true };
  const mutate = (edit: (b: Block) => void) => {
    const copy = structuredClone(resolved);
    const tiles = copy.sections.find((s) => s.structureLabel === "3.")!.blocks.find((b) => b.id === "bv_3__v_0000a003")!;
    edit(tiles);
    return runGate({ ...ctx, proposal: copy });
  };
  // Past the sanitizer (which would have dropped both): the gate still catches them.
  const b7 = mutate((b) => { if (b.kind === "stat-tiles") b.tiles[0].value = "$500"; });
  check("backstop: a \"$500\" inside a tile is a B7 BLOCK located on the visual block",
    b7.violations.some((v) => v.ruleId === "B7" && v.severity === "block" && v.locator.blockId === "bv_3__v_0000a003"),
    b7.violations.map((v) => [v.ruleId, v.severity, v.locator.blockId]));
  const d1 = mutate((b) => { if (b.kind === "stat-tiles") b.tiles[1].label = "Issues resolved \u2014 remotely"; });
  check("backstop: an em dash inside a tile label is a D1 violation located on the visual block",
    d1.violations.some((v) => v.ruleId === "D1" && v.locator.blockId === "bv_3__v_0000a003"),
    d1.violations.map((v) => [v.ruleId, v.severity, v.locator.blockId]));
  const table = structuredClone(resolved);
  const tb = table.sections.find((s) => s.structureLabel === "2.")!.blocks.find((b) => b.id === "bv_2__v_0000a001")!;
  if (tb.kind === "table") tb.rows[3][2] = "Managed EDR at $12 per seat.";
  const b7t = runGate({ ...ctx, proposal: table });
  check("backstop: currency in a table cell is a B7 BLOCK located on the table block",
    b7t.violations.some((v) => v.ruleId === "B7" && v.severity === "block" && v.locator.blockId === "bv_2__v_0000a001"),
    b7t.violations.map((v) => [v.ruleId, v.locator.blockId]));

  // A5: an llm block citing a fact the corpus does not hold.
  const badCite: FixtureSection[] = withTimeline(fixtureSections).map((s) =>
    s.label === "1."
      ? { ...s, blocks: s.blocks!.map((b) => ({ ...b, cites: ["fact_does_not_exist_v9"] })) }
      : s
  );
  const a5 = runDraftGate(buildFixtureGateInput(badCite));
  check("A5: an llm visual citing an unknown fact is a BLOCK located on bv_1__v_0000a005",
    a5.violations.some((v) => v.ruleId === "A5" && v.severity === "block" && v.locator.blockId === "bv_1__v_0000a005"),
    a5.violations.map((v) => [v.ruleId, v.locator.blockId]));
  // A5 on a system block: the sanitizer guarantees non-empty cites, and the
  // ids must still exist; a system block with a dead cite is caught too.
  const badSystem: FixtureSection[] = withTimeline(fixtureSections).map((s) =>
    s.label === "4." ? { ...s, blocks: s.blocks!.map((b) => ({ ...b, cites: ["fact_gone_v1"] })) } : s
  );
  const a5s = runDraftGate(buildFixtureGateInput(badSystem));
  check("A5: a system visual citing an unknown fact is a BLOCK too",
    a5s.violations.filter((v) => v.ruleId === "A5" && v.locator.blockId?.startsWith("bv_4__")).length === 2,
    a5s.violations.map((v) => [v.ruleId, v.locator.blockId]));
}

/* ---- 4b. D4 reads the prospect's headcount, never the high end of a range  */
{
  check("D4: a bare range is not a headcount", prospectHeadcount("XL.net serves organizations of 15 to 250 employees.") === null);
  check('D4: "your 40 users" is 40', prospectHeadcount("We priced this for your 40 users.") === 40);
  check('D4: "15 to 250 employees and your 230 users" is 230', prospectHeadcount("Organizations of 15 to 250 employees and your 230 users.") === 230);
  check("D4: nothing stated is null", prospectHeadcount("A flat monthly fee.") === null);
  // Through the gate: the About grid ("15 to 250 employees") on a proposal with
  // no quote and no headcount in the prose raises no D4 fit warning; a stated
  // 230 users does, and names 230.
  const fid = (key: string) => knowledge.facts.find((f) => f.key === key)!.id;
  const aboutOnly: FixtureSection[] = [
    fixtureSections.find((s) => s.label === "__letter")!,
    {
      label: "4.",
      title: "Vendor Qualifications",
      paragraphs: ["XL.net Inc. is a managed IT services provider."],
      cites: [fid("company.identity")],
      generatedBy: "llm",
      gaps: [],
      updatedAt: fixtureSections[1].updatedAt,
      blocks: buildAboutBlocks(knowledge.facts).map((b, i) => ({ ...b, id: `v_0000d00${i}` })),
    },
  ];
  const noQuote = buildFixtureGateInput(aboutOnly, { quote: null });
  (noQuote.proposal as { pricingJson: string | null }).pricingJson = null;
  const g1 = runDraftGate(noQuote);
  check("D4: About grid, no quote, no prose headcount raises no fit warning",
    !g1.violations.some((v) => v.ruleId === "D4" && /near the edge/.test(v.message)),
    g1.violations.filter((v) => v.ruleId === "D4").map((v) => v.message));
  const stated = aboutOnly.map((s) => (s.label === "4." ? { ...s, paragraphs: [...s.paragraphs, "We serve organizations of 15 to 250 employees and have sized this for your 230 users."] } : s));
  const withStated = buildFixtureGateInput(stated, { quote: null });
  (withStated.proposal as { pricingJson: string | null }).pricingJson = null;
  const g2 = runDraftGate(withStated);
  check("D4: a stated 230 users at the range's edge warns, naming 230",
    g2.violations.some((v) => v.ruleId === "D4" && /about 230,/.test(v.message)),
    g2.violations.filter((v) => v.ruleId === "D4").map((v) => v.message));
}

/* ---- 5. Export view: the flow is interleave's ----------------------------- */
const view = buildExportView(resolved, input.rateCard);
{
  for (const sec of input.sections) {
    if (sec.label === "__letter") continue;
    const flow = interleave(sec.paragraphs, sanitizeStoredBlocks(sec.blocks, sec.paragraphs.length));
    const vs = view.sections.find((s) => s.label === sec.label)!;
    const want = flow.map((f) => (f.type === "p" ? ["p", f.text] : ["block", f.block.kind, f.block.id]));
    const got = vs.flow.map((f: ExportFlowItem) =>
      f.type === "p" ? ["p", f.text] : ["block", f.block.kind, f.block.id.replace(/^bv_[^_]*__/, "")]
    );
    check(`view: section ${sec.label} flow equals interleave order`, isDeepStrictEqual(got, want), { got, want });
    check(`view: section ${sec.label} paragraphs are the flow's prose, in order`,
      isDeepStrictEqual(vs.paragraphs, flow.filter((f) => f.type === "p").map((f) => (f.type === "p" ? f.text : ""))));
  }
}

/* ---- 6. Both files carry every block string ------------------------------- */
async function files() {
  const pdf = await renderRfpPdf(view);
  const docx = await renderRfpDocx(view);
  check("pdf: renders with visuals (non-trivial size)", pdf.length > 50_000, pdf.length);
  const zip = await JSZip.loadAsync(docx);
  const xml = await zip.file("word/document.xml")!.async("string");
  const unesc = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  const text = unesc(xml.replace(/<[^>]+>/g, "\u0001"));
  for (const { block } of storedBlocks) {
    const strings = visibleStrings(block);
    const missing = strings.filter((t) => !text.includes(t) && !text.includes(t.toUpperCase()));
    check(`docx: ${block.kind} ${block.id} carries all ${strings.length} strings`, missing.length === 0, missing);
  }
  check("docx: every atomic block row is marked cantSplit", (xml.match(/<w:cantSplit\/>/g) ?? []).length >= 20, (xml.match(/<w:cantSplit\/>/g) ?? []).length);
  check("docx: table blocks repeat their head row (tblHeader) beside the Investment table's",
    (xml.match(/<w:tblHeader\/>/g) ?? []).length === 3, (xml.match(/<w:tblHeader\/>/g) ?? []).length);
  const media = Object.keys(zip.files).filter((f) => f.startsWith("word/media/"));
  check("docx: badge marks and step dots are embedded as media", media.length >= 5 + 3 + 3 + 1, media.length);
  // The plain-TTF font swap survives the visual tables (export-assets parity).
  check("docx: embedded fonts stay plain TTF", Object.keys(zip.files).some((f) => f.startsWith("word/fonts/") && f.endsWith(".ttf")));
}

files().then(() => {
  console.log(failures === 0 ? "\nall visual gate checks passed" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
});
