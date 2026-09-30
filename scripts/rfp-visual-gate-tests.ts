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
  REFERENCES_INTRO_SENTENCE,
  referenceCardTable,
  referencesBlockStrings,
} from "../src/lib/rfp/references-block";
import { REFERENCE_ETIQUETTE_SENTENCE } from "../src/lib/rfp/references-ask";
import {
  applyReferencesAnswer,
  carryReferencesBlock,
  referencesOtherText,
} from "../src/lib/rfp/references-answer";
import {
  referencesBlock,
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
/** How many content-model blocks one stored visual lifts into: one, or a table per reference. */
const liftCount = (b: DraftBlock): number => (b.kind === "references" ? b.references.length : 1);
{
  const lifted = resolved.sections.flatMap((s) => s.blocks.filter((b) => b.kind !== "prose"));
  const wantCount = storedBlocks.reduce((n, x) => n + liftCount(x.block), 0);
  check("lift: one content-model block per stored visual (a table per reference)", lifted.length === wantCount, [lifted.length, wantCount]);
  for (const { label, block } of storedBlocks) {
    const id = `bv_${label.replace(/[^a-zA-Z0-9]+/g, "_")}_${block.id}`;
    if (block.kind === "references") {
      // No content-model kind of its own: N tables, ids _1.._N, human-authored, uncited.
      const cards = block.references.map((_, i) => lifted.find((b) => b.id === `${id}_${i + 1}`));
      check(`lift: references ${block.id} -> ${cards.length} table blocks, every one passing blockSchema`,
        cards.length === block.references.length && cards.every((c) => !!c && c.kind === "table" && blockSchema.safeParse(c).success),
        cards.map((c) => c && [c.id, c.kind]));
      check(`lift: ${id}_n bodies are referenceCardTable(entry, n); generatedBy human, cites [], editedByHuman true`,
        cards.every((c, i) => {
          if (!c) return false;
          const { id: _gid, sectionId: _sid, ordinal: _ord, cites, generatedBy, editedByHuman, ...body } = c;
          return isDeepStrictEqual(body, referenceCardTable(block.references[i], i + 1)) && generatedBy === "human" && isDeepStrictEqual(cites, []) && editedByHuman === true;
        }),
        cards);
      continue;
    }
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
  // A references block expands into its tables in place, so ordinals after it
  // are consecutive over the EXPANDED flow; a section without one is unchanged.
  for (const sec of input.sections) {
    if (sec.label === "__letter") continue;
    const flow = interleave(sec.paragraphs, sanitizeStoredBlocks(sec.blocks, sec.paragraphs.length));
    const rs = resolved.sections.find((s) => s.structureLabel === sec.label)!;
    const sl = sec.label.replace(/[^a-zA-Z0-9]+/g, "_");
    const want = flow
      .flatMap((f) =>
        f.type === "p"
          ? [{ kind: "prose", id: `b_${sl}_${f.index}` }]
          : f.block.kind === "references"
            ? f.block.references.map((_, n) => ({ kind: "table", id: `bv_${sl}_${f.block.id}_${n + 1}` }))
            : [{ kind: f.block.kind, id: `bv_${sl}_${f.block.id}` }]
      )
      .map((x, i) => ({ ...x, ordinal: i }));
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
  const seven = resolved.sections.find((s) => s.structureLabel === "7.")!;
  check("order: the references section is its paragraph, then Reference 1 and Reference 2 at ordinals 1 and 2",
    isDeepStrictEqual(seven.blocks.map((b) => [b.id, b.ordinal]), [["b_7__0", 0], [`bv_7__${referencesBlock.id}_1`, 1], [`bv_7__${referencesBlock.id}_2`, 2]]),
    seven.blocks.map((b) => [b.id, b.ordinal]));
}

/* ---- 2b. References: the cards, proposal.references and the gate ---------- */
{
  const seven = resolved.sections.find((s) => s.structureLabel === "7.")!;
  const cards = seven.blocks.filter((b) => b.kind === "table");
  check("references: exactly two table blocks for the two-entry block, ids ending _1 and _2",
    cards.length === 2 && cards[0].id.endsWith("_1") && cards[1].id.endsWith("_2"), cards.map((c) => c.id));
  check("references: the cards are human-authored and cite nothing",
    cards.every((c) => c.generatedBy === "human" && c.cites.length === 0 && c.editedByHuman === true));
  check("references: the head row reads Reference N beside a blank cell, the four template rows follow",
    cards.every((c, i) => c.kind === "table" && isDeepStrictEqual(c.columns.map((x) => x.header), [`Reference ${i + 1}`, ""]) && c.rows.length === 4 && c.caption === null),
    cards);
  const spans = resolvedTextSpans(resolved);
  const cellText = cards.flatMap((c) => (c.kind === "table" ? c.rows.flat() : []));
  const missing = cellText.filter((t) => !spans.some((s) => s.blockId?.startsWith(`bv_7__${referencesBlock.id}_`) && s.text === t));
  check("references: every card cell is in resolvedTextSpans under its table's id", missing.length === 0, missing);
  check("references: proposal.references carries one Reference per lifted entry, in order",
    resolved.references.length === 2 &&
      resolved.references[0].id === "ref_typed_1" &&
      resolved.references[1].id === "ref_fixture_harbor" &&
      resolved.references[0].organization === "Northwind Clinic" &&
      resolved.references[1].contactPhone === null &&
      resolved.references[1].contactEmail === "p.natarajan@example.org" &&
      resolved.references[0].segment === "Healthcare, multi-site",
    resolved.references);
  const gate = runDraftGate(input);
  const onCards = gate.violations.filter((v) => v.locator.blockId?.startsWith(`bv_7__${referencesBlock.id}_`));
  check("references: no A5 (or any) violation lands on the cards", onCards.length === 0, onCards.map((v) => [v.ruleId, v.message]));
  check("references: D3 sees the references and is satisfied by the section's etiquette sentence",
    !gate.violations.some((v) => v.ruleId === "D3"), gate.violations.filter((v) => v.ruleId === "D3").map((v) => v.message));
  // Without the etiquette sentence D3 BLOCKs on proposal.references alone,
  // which is the reason the adapter populates it.
  const bare = withTimeline(fixtureSections).map((s) =>
    s.label === "7." ? { ...s, paragraphs: ["Two comparable clients follow."] } : s
  );
  const bareGate = runDraftGate(buildFixtureGateInput(bare));
  check("references: with the etiquette sentence removed, D3 is a BLOCK",
    bareGate.violations.some((v) => v.ruleId === "D3" && v.severity === "block"),
    bareGate.violations.filter((v) => v.ruleId === "D3").map((v) => v.message));
  // The section carrying the block resolves the same with the key absent as
  // with `blocks: []` (the legacy contract holds for it too), and a fixture
  // without any references block has NO proposal.references.
  const without = resolveDraft(buildFixtureGateInput(withTimeline(fixtureSections).filter((s) => s.label !== "7."))).resolved;
  check("references: a proposal with no references block has an empty proposal.references", without.references.length === 0);
}

/* ---- 2c. References: the route's own composition through the gate -------- */
// The fixture's section 7 is built by applyReferencesAnswer (the function the
// references route calls) from a section the drafter left EMPTY: generatedBy
// "llm", no cites, no paragraphs. These checks answer it again here, so the
// gate verdict is pinned on the composition and not on a hand-written record.
{
  const others = withTimeline(fixtureSections).filter((s) => s.label !== "7.");
  const emptyLlm: FixtureSection = { label: "7.", title: "References", paragraphs: [], cites: [], gaps: [], generatedBy: "llm", updatedAt: "2026-09-30T15:00:00.000Z" };
  const entries = referencesBlock.kind === "references" ? referencesBlock.references : [];
  const otherText = referencesOtherText("Fixture proposal", others, -1, emptyLlm);
  const answered = applyReferencesAnswer(emptyLlm, otherText, entries).section;
  check("answer: an empty llm section lands human, with the intro and the etiquette",
    answered.generatedBy === "human" && answered.paragraphs.length === 1 && answered.paragraphs[0].startsWith(REFERENCES_INTRO_SENTENCE) && answered.paragraphs[0].endsWith(REFERENCE_ETIQUETTE_SENTENCE),
    [answered.generatedBy, answered.paragraphs]);
  const gate = runDraftGate(buildFixtureGateInput([...others, answered]));
  const on7 = gate.violations.filter((v) => v.locator.sectionId === "sec_7_" || v.locator.blockId?.includes("_7__"));
  check("answer: an llm, no-cites, empty section answered through the route's composition has no A5 violation",
    !on7.some((v) => v.ruleId === "A5"), on7.filter((v) => v.ruleId === "A5").map((v) => v.message));
  check("answer: and no D3 violation anywhere",
    !gate.violations.some((v) => v.ruleId === "D3"), gate.violations.filter((v) => v.ruleId === "D3").map((v) => v.message));
  check("answer: nothing at all lands on the answered section", on7.length === 0, on7.map((v) => [v.ruleId, v.message]));
  // The control: the same landing left "llm" with no cites is exactly the A5
  // BLOCK the human stamp exists to prevent.
  const asLlm = runDraftGate(buildFixtureGateInput([...others, { ...answered, generatedBy: "llm" }]));
  check("answer: left as llm, the system-written intro is an A5 BLOCK (the control)",
    asLlm.violations.some((v) => v.ruleId === "A5" && v.severity === "block" && v.locator.blockId === "b_7__0"),
    asLlm.violations.filter((v) => v.ruleId === "A5").map((v) => v.locator));
  check("answer: the fixture's own section 7 is this same composition",
    isDeepStrictEqual(
      { ...fixtureSections.find((s) => s.label === "7.")!, blocks: undefined, updatedAt: "" },
      { ...answered, blocks: undefined, updatedAt: "" }
    ));

  // A redraft carries the block: fresh prose with no etiquette in it must not
  // BLOCK on D3, and an empty redraft must not BLOCK on A5.
  const stored = answered.blocks!.find((b) => b.origin === "references")!;
  const factId = others.find((s) => s.label === "6.")!.cites[0];
  const carry = carryReferencesBlock({ paragraphs: ["The clients below are comparable in size and sector."], blocks: undefined, carried: stored, otherText });
  const redrafted: FixtureSection = { ...emptyLlm, paragraphs: carry.paragraphs, cites: [factId], generatedBy: carry.human ? "human" : "llm", referencesAnswered: true, blocks: carry.blocks };
  const redraftGate = runDraftGate(buildFixtureGateInput([...others, redrafted]));
  check("redraft carry: D3 does not BLOCK after a redraft",
    !redraftGate.violations.some((v) => v.ruleId === "D3"), redraftGate.violations.filter((v) => v.ruleId === "D3").map((v) => v.message));
  const lifted = resolveDraft(buildFixtureGateInput([...others, redrafted])).resolved.sections.find((x) => x.structureLabel === "7.")!;
  check("redraft carry: the cards close the section, after the intro",
    isDeepStrictEqual(lifted.blocks.map((b) => b.kind), ["prose", "prose", "table", "table"]), lifted.blocks.map((b) => b.kind));
  const emptyCarry = carryReferencesBlock({ paragraphs: [], blocks: undefined, carried: stored, otherText });
  const emptyRedraft: FixtureSection = { ...emptyLlm, paragraphs: emptyCarry.paragraphs, generatedBy: emptyCarry.human ? "human" : "llm", referencesAnswered: true, blocks: emptyCarry.blocks };
  const emptyGate = runDraftGate(buildFixtureGateInput([...others, emptyRedraft]));
  check("redraft carry: an empty redraft lands human, with no A5 and no D3",
    emptyRedraft.generatedBy === "human" && !emptyGate.violations.some((v) => (v.ruleId === "A5" && v.locator.blockId?.includes("_7__")) || v.ruleId === "D3"),
    emptyGate.violations.filter((v) => v.ruleId === "A5" || v.ruleId === "D3").map((v) => [v.ruleId, v.locator]));

  // Names that read as money to the currency screen still reach the page.
  const money = applyReferencesAnswer(emptyLlm, otherText, [
    { ...entries[0], organization: "Dollar Bank", contactName: "Jordan Pence" },
    { ...entries[1], organization: "Bucks County Free Library", relevance: "Architecture, CAD workloads" },
  ]).section;
  const moneyResolved = resolveDraft(buildFixtureGateInput([...others, JSON.parse(JSON.stringify(money))])).resolved;
  const moneyCards = moneyResolved.sections.find((x) => x.structureLabel === "7.")!.blocks.filter((b) => b.kind === "table");
  check("currency-looking names: both cards survive the stored round-trip and resolve",
    moneyCards.length === 2 && moneyResolved.references.map((r) => r.organization).join("|") === "Dollar Bank|Bucks County Free Library",
    [moneyCards.length, moneyResolved.references.map((r) => r.organization)]);
  const moneyGate = runDraftGate(buildFixtureGateInput([...others, JSON.parse(JSON.stringify(money))]));
  const moneyOnCards = moneyGate.violations.filter((v) => v.locator.blockId?.includes("_7__"));
  check("currency-looking names: the gate raises nothing on the cards", moneyOnCards.length === 0, moneyOnCards.map((v) => [v.ruleId, v.severity]));
}

/* ---- 3. Scan surface: every visible string of every block --------------- */
{
  const spans = resolvedTextSpans(resolved);
  for (const { label, block } of storedBlocks) {
    const id = `bv_${label.replace(/[^a-zA-Z0-9]+/g, "_")}_${block.id}`;
    // A references block's strings are spread over its `${id}_n` tables.
    const mine = spans
      .filter((s) => (block.kind === "references" ? s.blockId?.startsWith(`${id}_`) : s.blockId === id))
      .map((s) => s.text);
    const strings = visibleStrings(block).filter((t) => t !== "");
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
    case "references": return referencesBlockStrings(b.references);
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
    // The export view sees the lifted flow, where a references block is its tables.
    const want = flow.flatMap((f) =>
      f.type === "p"
        ? [["p", f.text]]
        : f.block.kind === "references"
          ? f.block.references.map((_, n) => ["block", "table", `${f.block.id}_${n + 1}`])
          : [["block", f.block.kind, f.block.id]]
    );
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
    const strings = visibleStrings(block).filter((t) => t !== "");
    const missing = strings.filter((t) => !text.includes(t) && !text.includes(t.toUpperCase()));
    check(`docx: ${block.kind} ${block.id} carries all ${strings.length} strings`, missing.length === 0, missing);
  }
  check("docx: every atomic block row is marked cantSplit", (xml.match(/<w:cantSplit\/>/g) ?? []).length >= 20, (xml.match(/<w:cantSplit\/>/g) ?? []).length);
  // Two fixture tables, two reference cards, the Investment table.
  check("docx: table blocks and the reference cards repeat their head row (tblHeader) beside the Investment table's",
    (xml.match(/<w:tblHeader\/>/g) ?? []).length === 5, (xml.match(/<w:tblHeader\/>/g) ?? []).length);
  const media = Object.keys(zip.files).filter((f) => f.startsWith("word/media/"));
  check("docx: badge marks and step dots are embedded as media", media.length >= 5 + 3 + 3 + 1, media.length);
  // The plain-TTF font swap survives the visual tables (export-assets parity).
  check("docx: embedded fonts stay plain TTF", Object.keys(zip.files).some((f) => f.startsWith("word/fonts/") && f.endsWith(".ttf")));
}

files().then(() => {
  console.log(failures === 0 ? "\nall visual gate checks passed" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
});
