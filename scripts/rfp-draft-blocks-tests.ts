/**
 * Visual-block contract tests (ARCHITECTURE.md §5.17).
 *
 *   npm run test:rfpblocks
 *
 * Pure, no server. Pins src/lib/rfp/draft-blocks.ts in both directions: the grounding must refuse
 * a number (or a ">" decoration) the fact does not state, and it must not refuse the figures the
 * facts DO state; a malformed model visual must never throw or fail a section; a stored block must
 * round-trip untouched; and a legacy record with no `blocks` key must flow as paragraphs only.
 */

import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import {
  DRAFT_BLOCK_KINDS,
  LIMITS,
  PARAGRAPH_CAP,
  buildAboutBlocks,
  buildOnboardingTimeline,
  buildServiceStatsBlock,
  draftBlockSummary,
  groundValue,
  hasCurrency,
  interleave,
  newBlockId,
  parseModelVisuals,
  pickAboutSection,
  reanchorBlocks,
  sanitizeStoredBlocks,
  tableColumnFractions,
  type DraftBlock,
  type GroundFact,
} from "../src/lib/rfp/draft-blocks";
import {
  VISUALS_ACTIONS,
  applyVisualsOp,
  finishDraftVisuals,
  isVisualsAction,
  keptBlocks,
  landDraftBlocks,
  pickServiceStatsSection,
  toGroundFacts,
  withBlocks,
} from "../src/lib/rfp/draft-blocks-ops";
import { blockSchema } from "../src/lib/rfp/content-model/schema";
import { buildReferencesBlock } from "../src/lib/rfp/draft-blocks";
import { NARROWEST_TILE_INNER_PX, TILE_FIT, tileValuePx, valueFitsTile } from "../src/lib/rfp/tile-fit";
import { referenceCardTable, referencesBlockStrings } from "../src/lib/rfp/references-block";
import {
  facts,
  referencesBlock,
  requirements as fixtureRequirements,
  sections as fixtureSections,
  stretchTimelineBlock,
  structure as fixtureStructure,
} from "./fixtures/rfp-visual-fixture";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = isDeepStrictEqual(actual, expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `\n     got  ${JSON.stringify(actual)}\n     want ${JSON.stringify(expected)}`}`
  );
}
const yes = (label: string, v: unknown) => check(label, !!v, true);
const no = (label: string, v: unknown) => check(label, !!v, false);

const fid = (key: string) => facts.find((f) => f.key === key)!.id;
const fact = (key: string) => facts.find((f) => f.key === key)!;
const ctx = (paragraphCount = 3, sectionCites: string[] = []) => ({ facts, paragraphCount, sectionCites });
const allStrings = (v: unknown): string[] =>
  typeof v === "string"
    ? [v]
    : Array.isArray(v)
      ? v.flatMap(allStrings)
      : v && typeof v === "object"
        ? Object.values(v).flatMap(allStrings)
        : [];
const bodyText = (b: DraftBlock): string[] => {
  const { id: _id, cites: _cites, generatedBy: _g, origin: _o, kind: _k, ...rest } = b;
  return allStrings(rest);
};
const words = (s: string) => s.toLowerCase().match(/[a-z0-9]+(?:\.[0-9]+)?/g) ?? [];

// ---- source hygiene: the module ships to the browser ------------------------
const src = readFileSync(new URL("../src/lib/rfp/draft-blocks.ts", import.meta.url), "utf8");
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
no("no lookbehind regex in the module", /\(\?<[=!]/.test(code));
no("no value import from staff-count", /from\s+["']\.\/staff-count["']/.test(code));
// The value imports allowed are references-block.ts and tile-fit.ts, each pure and client-safe by
// its own contract (and checked for lookbehinds here too, since they ship in the same bundle).
check(
  "every import is type-only, except the references-block and tile-fit contracts",
  (code.match(/^import (?!type )[\s\S]*?from\s+["'][^"']+["']/gm) ?? []).filter((s) => !/from\s+["']\.\/(?:references-block|tile-fit)["']/.test(s)),
  []
);
const refsSrc = readFileSync(new URL("../src/lib/rfp/references-block.ts", import.meta.url), "utf8");
no("no lookbehind regex in references-block", /\(\?<[=!]/.test(refsSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")));
check("references-block imports types only", (refsSrc.match(/^import (?!type )/gm) ?? []).length, 0);
const fitSrc = readFileSync(new URL("../src/lib/rfp/tile-fit.ts", import.meta.url), "utf8");
no("no lookbehind regex in tile-fit", /\(\?<[=!]/.test(fitSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")));
check("tile-fit imports nothing", (fitSrc.match(/^import /gm) ?? []).length, 0);

// ---- groundValue -------------------------------------------------------------
no('">92%" against "retention is 92%"', groundValue(">92%", "XL.net's client retention rate is 92%."));
yes('"92%" against "retention is 92%"', groundValue("92%", "XL.net's client retention rate is 92%."));
yes('">99%" against "More than 99% of calls"', groundValue(">99%", "More than 99% of calls are answered live by a human"));
yes('"99%+" against "More than 99% of calls"', groundValue("99%+", "More than 99% of calls are answered live"));
no('"99%+" against "is 99%"', groundValue("99%+", "The rate is 99%."));
yes('">70%" against "is above 70%"', groundValue(">70%", "First-contact resolution is above 70%."));
no("a number absent from the fact", groundValue("95%", "XL.net's client retention rate is 92%."));
no("a digit inside a larger number is not that number", groundValue("9%", "Roughly 99.9% of issues"));
no('"99%" is not "99.9%"', groundValue("99%", "Roughly 99.9% of issues are resolved remotely."));
yes('"99.9%" grounds', groundValue("99.9%", "Roughly 99.9% of issues are resolved remotely."));
yes("thousands separator in the value", groundValue("20,000", "roughly 20000 nationwide"));
yes("thousands separator in the fact", groundValue("20000", "vetted technicians, roughly 20,000 nationwide"));
yes("separators on both sides", groundValue("2,000+", "more than 2,000 SentinelOne licenses"));
no('"20" does not ground against "20,000"', groundValue("20", "roughly 20,000 nationwide"));
no("percent does not ground against a bare number", groundValue("73%", "XL.net has 73 active client accounts."));
no("bare number does not ground against a percent", groundValue("92", "retention rate is 92%."));
yes('"percent" spelled out is a percent', groundValue("92 percent", "retention rate is 92%."));
yes("bare number grounds against a bare number", groundValue("73", "XL.net has 73 active client accounts."));
no('the "2" of "P2" is not the quantity 2', groundValue("2", "P2 High 1 hour"));
yes('"P2" grounds against "P2"', groundValue("P2 High", "P2 High 1 hour and 8 business hours"));
yes('"24/7/365" grounds', groundValue("24/7/365", "a true 24/7/365 live service desk"));
yes('"<2 hours" against "within 2 hours"', groundValue("<2 hours", "targeted to arrive onsite within 2 hours"));
no('"<2 hours" against "is 2 hours"', groundValue("<2 hours", "the window is 2 hours"));
no('"more than 92%" in words needs the fact to say so', groundValue("more than 92%", "retention rate is 92%."));
yes("no digits is vacuously grounded", groundValue("Certified", "anything"));
yes("unit glued to the number", groundValue("15 minutes", "P1 Critical 15-minute response"));

// Numerals that are not ASCII digits, number words, glued suffixes (refute-e).
yes("fullwidth digits are the digits they are (NFKC)", groundValue("１２００ devices", "we manage 1200 devices"));
no("fullwidth digits still have to ground", groundValue("１２００ devices", "P1 Critical 15-minute response"));
no("an Arabic-Indic numeral never grounds", groundValue("٤٧ engineers", "XL.net has 47 full-time employees"));
yes("a superscript is its digit", groundValue("within ³ hours", "onsite within 3 hours"));
no("a superscript digit has to ground", groundValue("³ hour resolution", "P1 Critical 15-minute response"));
yes("a number word grounds word for word", groundValue("a three-year term", "XL.net offers a three-year term."));
no('"three" is not "3"', groundValue("a three-year term", "XL.net offers a 3-year term."));
no('"3" is not "three"', groundValue("a 3-year term", "XL.net offers a three-year term."));
no("twelve months needs the fact to say twelve", groundValue("twelve months notice", "90 days notice"));
yes("an ordinal word grounds word for word", groundValue("first-contact resolution", "First-contact resolution is above 70%."));
no("an ordinal word has to ground", groundValue("the second business day", "P1 Critical 15-minute response"));
yes("letters glued after a number match the same glued token", groundValue("24k", "roughly 24k tickets a year"));
no('"24k" is not "24"', groundValue("24k", "24 hours"));
no('"3x" is not "3"', groundValue("3x faster", "3 hours"));
no('"2nd" is not "2"', groundValue("2nd", "2 users"));
yes('"2nd" grounds against "2nd"', groundValue("2nd line", "2nd line support"));
yes("a roman numeral is letters, not a number", groundValue("Tier IV datacenter", "anything"));
// Figures the About set and the service tiles rely on must still ground.
yes('"24/7/365" still grounds', groundValue("24/7/365", "a true 24/7/365 live service desk"));
yes('"99.9%" still grounds', groundValue("99.9%", "Roughly 99.9% of issues are resolved remotely."));
yes('"4.8 years" still grounds', groundValue("4.8 years", "The average client tenure is 4.8 years."));
yes('"15 to 250 employees" still grounds', groundValue("15 to 250 employees", "serves organizations of 15 to 250 employees"));
{
  // Every About value and every service tile grounds against the seed facts through the new rules.
  const aboutOk = buildAboutBlocks(facts).flatMap((b) => (b.kind === "fact-grid" ? b.pairs.map((p) => p.value) : b.kind === "badge-strip" ? b.badges.map((x) => x.label) : []));
  check("about values still ground under number words and suffixes", aboutOk.length, 12);
  const tiles = buildServiceStatsBlock(facts);
  check("service tiles still build", tiles?.kind === "stat-tiles" && tiles.tiles.length, 3);
}

// ---- hasCurrency -------------------------------------------------------------
yes("$ sign", hasCurrency("$2,000,000 in cover"));
yes("USD", hasCurrency("2 million USD"));
yes("dollars", hasCurrency("two million dollars"));
yes("other currency signs", hasCurrency("€40") && hasCurrency("£40") && hasCurrency("¥40"));
no("plain text", hasCurrency("Cyber liability through Beazley MediaTech"));
no('"percent" is not "cent"', hasCurrency("92 percent retention"));
yes("euros", hasCurrency("About 15 euros a ticket"));
yes("cents", hasCurrency("4 cents a ticket"));
yes("bucks", hasCurrency("five bucks"));
yes("pence", hasCurrency("ten pence"));
yes("currency codes", ["CHF 5", "5 JPY", "INR 5", "MXN 5"].every(hasCurrency));
yes("a number priced per unit is a rate", ["15 per user per month", "20 per seat", "25 per computer per month", "5 per device", "3 per endpoint", "100 per month", "1200 per year"].every(hasCurrency));
no("a unit with no number before it is not a rate", hasCurrency("billed per user per month"));
no("a count of things per period is not a rate", hasCurrency("4 scan sessions per year"));
no("the About figures are not money", ["24/7/365", "99.9%", "4.8 years", "15 to 250 employees", "47 full-time employees"].some(hasCurrency));

// ---- parseModelVisuals: garbage never throws ----------------------------------
const garbage: unknown[] = [
  null,
  undefined,
  "visuals",
  42,
  {},
  { kind: "stats" },
  [null, 1, "x", [], [[[]]]],
  [{ kind: "table", columns: "no", rows: 7 }],
  [{ kind: "table", columns: [{}, []], rows: [[{}], null] }],
  [{ kind: "stats", tiles: [null, 1, { fact: {} }, { fact: "nope", value: "1", label: "x" }] }],
  [{ kind: "pull-quote", text: "A client said so", attribution: "Somebody" }],
  [{ kind: "image", assetKey: "x" }, { kind: 7 }, { kind: "html", body: "<b>" }],
  [{ kind: "callout", body: { nested: { deeper: ["x"] } } }],
  [{ kind: "cards", cards: [{ title: 1, body: 2 }] }],
  Array.from({ length: 50 }, (_, i) => ({ kind: "stats", junk: i })),
  [{ kind: "callout", cites: [fid("book.retention")], body: "x".repeat(200000) }],
  [{ kind: "table", cites: [fid("book.retention")], columns: ["a", "b"], rows: [["y".repeat(100000), "z"]] }],
];
let threw = 0;
let leaked = 0;
for (const g of garbage) {
  try {
    const r = parseModelVisuals(g, ctx());
    if (r.blocks.length || r.degraded.length) leaked++;
  } catch {
    threw++;
  }
}
check("garbage never throws", threw, 0);
check("garbage yields no block and no prose", leaked, 0);
try {
  // A hostile context must not throw either.
  parseModelVisuals([{ kind: "callout", body: "x" }], { facts: null, paragraphCount: NaN, sectionCites: null } as never);
  check("hostile ctx does not throw", true, true);
} catch {
  check("hostile ctx does not throw", false, true);
}
check(
  "50 junk items: reasons recorded, scan bounded",
  parseModelVisuals(garbage[14], ctx()).dropped.length <= 13,
  true
);

// ---- stat tiles: the tile-drop and block-drop rules ---------------------------
const desk = fid("operations.service-desk-hours");
const fcr = fid("book.first-contact-resolution");
const retention = fid("book.retention");
const stats = parseModelVisuals(
  [
    {
      kind: "stats",
      after: 1,
      tiles: [
        { fact: desk, value: ">99%", label: "Calls answered live" },
        { fact: retention, value: ">92%", label: "Client retention" }, // decoration the fact does not carry
        { fact: desk, value: "99.9%", label: "Resolved remotely" },
        { fact: "fact_made_up", value: "100%", label: "Invented" }, // unknown fact
        { fact: fcr, value: ">70%", label: "First-contact resolution" },
        { fact: retention, value: "92%", label: "Top 5 provider" }, // digit in the label the fact lacks
      ],
    },
  ],
  ctx()
);
check("ungrounded tiles dropped, grounded kept", stats.blocks.map((b) => (b.kind === "stat-tiles" ? b.tiles : null)), [
  [
    { value: ">99%", label: "Calls answered live" },
    { value: "99.9%", label: "Resolved remotely" },
    { value: ">70%", label: "First-contact resolution" },
  ],
]);
check("tile block cites exactly the facts its tiles came from", stats.blocks[0]?.cites, [desk, fcr]);
check("tile block is llm, anchored where asked", [stats.blocks[0]?.generatedBy, stats.blocks[0]?.after], ["llm", 1]);
yes("tile block id shape", /^v_[0-9a-f]{8}$/.test(stats.blocks[0]?.id ?? ""));

const oneTile = parseModelVisuals(
  [{ kind: "stats", tiles: [{ fact: retention, value: "92%", label: "Client retention" }, { fact: retention, value: "97%", label: "Made up" }] }],
  ctx()
);
check("fewer than two grounded tiles drops the block", [oneTile.blocks.length, oneTile.dropped], [0, [{ kind: "stats", reason: "fewer-than-two-grounded-tiles" }]]);

const negTile = parseModelVisuals(
  [{ kind: "stats", tiles: [{ fact: fid("contract.multi-year"), value: "0", label: "Multi-year discounts" }, { fact: retention, value: "92%", label: "Client retention" }] }],
  ctx()
);
check("a negative fact never backs a tile", negTile.blocks.length, 0);

const limitTiles = parseModelVisuals(
  [
    {
      kind: "stats",
      tiles: [
        { fact: retention, value: "92%", label: "Client retention" },
        { fact: fid("book.active-clients"), value: "73", label: "Active clients" },
        { fact: fid("company.headcount"), value: "47", label: "Full-time employees" },
        { fact: fid("book.tenure"), value: "4.8 years", label: "Average client tenure" },
        { fact: fid("book.tenure"), value: "3.0 years", label: "Median tenure" },
        { fact: fid("book.tenure"), value: "4.8 years average client tenure", label: "Too long a value" },
        { fact: fid("book.tenure"), value: "4.8 hours", label: "Wrong unit" },
      ],
    },
  ],
  ctx()
);
check("at most LIMITS.tiles[1] tiles", limitTiles.blocks[0]?.kind === "stat-tiles" && limitTiles.blocks[0].tiles.length, LIMITS.tiles[1]);
const wrongUnit = parseModelVisuals(
  [{ kind: "stats", tiles: [{ fact: fid("book.tenure"), value: "4.8 hours", label: "Tenure" }, { fact: fid("book.tenure"), value: "4.8 yrs", label: "Tenure" }, { fact: retention, value: "92%", label: "Client retention" }] }],
  ctx()
);
check(
  "a unit the fact does not use drops the tile; a short form of its unit does not",
  wrongUnit.blocks[0]?.kind === "stat-tiles" && wrongUnit.blocks[0].tiles.map((t) => t.value),
  ["4.8 yrs", "92%"]
);

// ---- stat tiles: a value is the figure alone (tile-fit.ts valueFitsTile) -----------
{
  const deskText = fact("operations.service-desk-hours").statement;
  // Both wide values are GROUNDED, so what skips them below is the width and nothing else.
  yes('"More than 99%" grounds against the desk fact', groundValue("More than 99%", deskText));
  yes('"99.9% remotely" grounds against the desk fact', groundValue("99.9% remotely", deskText));
  no('"More than 99%" does not fit a four-across tile at the floor', valueFitsTile("More than 99%"));
  no('"99.9% remotely" does not fit a four-across tile at the floor', valueFitsTile("99.9% remotely"));

  const wide = parseModelVisuals(
    [
      {
        kind: "stats",
        after: 1,
        tiles: [
          { fact: desk, value: "More than 99%", label: "Calls answered live" },
          { fact: desk, value: "99.9%", label: "Resolved remotely" },
          { fact: fcr, value: ">70%", label: "First-contact resolution" },
        ],
      },
    ],
    ctx()
  );
  check("a too-wide model tile is skipped like an ungrounded one; the figures stay", [wide.blocks.map((b) => (b.kind === "stat-tiles" ? b.tiles : null)), wide.dropped], [
    [[{ value: "99.9%", label: "Resolved remotely" }, { value: ">70%", label: "First-contact resolution" }]],
    [],
  ]);

  const sunk = parseModelVisuals(
    [
      {
        kind: "stats",
        tiles: [
          { fact: desk, value: "More than 99%", label: "Calls answered live" },
          { fact: desk, value: "99.9% remotely", label: "Issues resolved" },
          { fact: retention, value: "92%", label: "Client retention" },
        ],
      },
    ],
    ctx()
  );
  check("width that leaves fewer than two tiles drops the block with its own reason", [sunk.blocks.length, sunk.dropped], [0, [{ kind: "stats", reason: "value-too-wide" }]]);
  const notWidth = parseModelVisuals(
    [{ kind: "stats", tiles: [{ fact: desk, value: "More than 99%", label: "Calls answered live" }, { fact: retention, value: "97%", label: "Made up" }] }],
    ctx()
  );
  check("one wide tile and one ungrounded is still an ungrounded drop (width alone did not sink it)", notWidth.dropped, [{ kind: "stats", reason: "fewer-than-two-grounded-tiles" }]);
  const fin = finishDraftVisuals(
    [{ kind: "stats", tiles: [{ fact: desk, value: "More than 99%", label: "Calls answered live" }, { fact: desk, value: "99.9% remotely", label: "Issues resolved" }] }],
    ["One.", "Two."],
    facts,
    []
  );
  check("finish: a block sunk by width is a drop, never prose and never a section failure", [fin.blocks, fin.paragraphs, fin.stats], [[], ["One.", "Two."], { returned: 1, kept: 0, degraded: 0, dropped: 1 }]);

  // The server-built tiles pass the same width check: a fact whose figure grew past a quarter
  // tile loses that tile rather than writing it.
  const seeded = buildServiceStatsBlock(facts);
  yes("every seed service tile fits a four-across tile at the floor", seeded?.kind === "stat-tiles" && seeded.tiles.every((t) => valueFitsTile(t.value)));
  const grown = facts.map((f) =>
    f.key === "operations.service-desk-hours"
      ? { ...f, statement: "More than 99.999999% of calls are answered live by a human. Roughly 99.9% of issues are resolved remotely." }
      : f
  );
  const g = buildServiceStatsBlock(grown);
  check(
    "service stats: a too-wide value is never built, the rest still are",
    g?.kind === "stat-tiles" && g.tiles.map((t) => t.value),
    ["99.9%", ">70%"]
  );
  no('the grown figure (">99.999999%") would have been too wide', valueFitsTile(">99.999999%"));
  yes('and it is within the character limit, so width is what refuses it', ">99.999999%".length <= LIMITS.tileValue);

  // A STORED value wider than the contract predates it: the read keeps it (the renderers shrink
  // it onto one line), so an existing draft never loses the block.
  const legacy = {
    kind: "stat-tiles",
    tiles: [
      { value: "More than 99%", label: "Calls answered live" },
      { value: "99.9% remotely", label: "Issues resolved" },
      { value: ">70%", label: "First-contact resolution" },
      { value: "24/7/365", label: "Live service desk" },
    ],
    id: "v_0000e001",
    after: 1,
    cites: [desk, fcr],
    generatedBy: "llm",
  };
  check("stored: a legacy too-wide tile value round-trips through sanitizeStoredBlocks", sanitizeStoredBlocks([legacy], 2), [legacy]);
  check("stored: and survives an edit's keptBlocks", keptBlocks({ label: "3.", paragraphs: ["a", "b"], blocks: [legacy] }, 2), [legacy]);
}

// ---- tables ------------------------------------------------------------------
const sla = fid("operations.sla-targets");
const goodTable = {
  kind: "table",
  after: 2,
  cites: [sla, "fact_unknown"],
  caption: "Service level targets",
  columns: ["Priority", "Response", "Target resolution"],
  rows: [
    ["P1 Critical", "15 minutes", "4 hours"],
    ["P2 High", "1 hour", "8 business hours"],
  ],
};
const t1 = parseModelVisuals([goodTable], ctx());
check("grounded table lands with the content-model body", t1.blocks.map(({ id: _id, ...b }) => b), [
  {
    kind: "table",
    caption: "Service level targets",
    columns: [
      { header: "Priority", align: "left" },
      { header: "Response", align: "left" },
      { header: "Target resolution", align: "left" },
    ],
    rows: goodTable.rows,
    emphasizeLastRow: false,
    after: 2,
    cites: [sla],
    generatedBy: "llm",
  },
]);
const t2 = parseModelVisuals([{ ...goodTable, rows: [["P1 Critical", "10 minutes", "4 hours"]] }], ctx());
check("a cell number the cited facts lack drops the table", [t2.blocks.length, t2.degraded.length, t2.dropped], [0, 0, [{ kind: "table", reason: "ungrounded" }]]);
const t3 = parseModelVisuals([{ ...goodTable, cites: ["fact_unknown"] }], ctx(3, [sla]));
check("no known cites degrades to prose, rows joined with a middot", [t3.blocks.length, t3.degraded], [
  0,
  ["P1 Critical · 15 minutes · 4 hours", "P2 High · 1 hour · 8 business hours"],
]);
const t4 = parseModelVisuals([{ ...goodTable, rows: [["P1 Critical", "15 minutes"], ["P2 High", "1 hour", "8 business hours"]] }], ctx());
check("ragged rows are malformed: degraded, not a block", [t4.blocks.length, t4.degraded.length], [0, 2]);
const t5 = parseModelVisuals([{ ...goodTable, columns: ["Only one"], rows: [["P1 Critical"]] }], ctx());
check("one column is under LIMITS.tableCols: degraded", [t5.blocks.length, t5.degraded], [0, ["P1 Critical"]]);
const manyRows = Array.from({ length: 15 }, () => ["P1 Critical", "15 minutes", "4 hours"]);
const t6 = parseModelVisuals([{ ...goodTable, rows: manyRows }], ctx(3));
check("15 rows is over LIMITS.tableRows, and 15 paragraphs do not fit: dropped whole", [t6.blocks.length, t6.degraded.length, t6.dropped[0]?.reason], [0, 0, "no-room-for-prose"]);
const t7 = parseModelVisuals([{ ...goodTable, rows: manyRows.slice(0, 14) }], ctx());
check("14 rows is inside the limit", t7.blocks[0]?.kind === "table" && t7.blocks[0].rows.length, 14);
const t8 = parseModelVisuals([{ ...goodTable, rows: [["P1 Critical", "x".repeat(LIMITS.cell + 1), "4 hours"]] }], ctx());
check("a cell over LIMITS.cell is refused, never cut", [t8.blocks.length, t8.degraded.length], [0, 0]);
const t9 = parseModelVisuals([{ ...goodTable, cites: [] }], ctx(PARAGRAPH_CAP, [sla]));
check("degraded prose never exceeds the paragraph cap", [t9.degraded.length, t9.dropped[0]?.reason], [0, "no-room-for-prose"]);

// ---- callout, cards, currency, em dash, after, limits --------------------------
const term = fid("contract.term");
const c1 = parseModelVisuals(
  [{ kind: "callout", after: 99, cites: [term], title: "No lock-in — ever", body: "A revolving 90-day term — we keep earning it." }],
  ctx(4)
);
check("em dashes are replaced in every field", c1.blocks.map((b) => (b.kind === "callout" ? [b.title, b.body, b.tone] : null)), [
  ["No lock-in, ever", "A revolving 90-day term, we keep earning it.", "neutral"],
]);
check("`after` beyond the end clamps to the paragraph count", c1.blocks[0]?.after, 4);
check(
  "`after` negative, fractional, missing, non-numeric",
  [-3, 1.9, undefined, "2"].map((after) => parseModelVisuals([{ kind: "callout", after, cites: [term], body: "A 90-day term." }], ctx(4)).blocks[0]?.after),
  [0, 1, 4, 4]
);
const c2 = parseModelVisuals([{ kind: "callout", cites: [term], body: "The term is 60 days." }], ctx());
check("callout with an ungrounded number is dropped", [c2.blocks.length, c2.degraded.length, c2.dropped[0]?.reason], [0, 0, "ungrounded"]);
const c3 = parseModelVisuals([{ kind: "callout", cites: ["nope"], body: "We have to keep earning it." }], ctx());
check("callout with no known cites degrades to its body", [c3.blocks.length, c3.degraded], [0, ["We have to keep earning it."]]);
const longBody = `${"We keep earning it. ".repeat(40)}`.trim();
const c4 = parseModelVisuals([{ kind: "callout", cites: [term], body: longBody }], ctx());
check("callout body over LIMITS.calloutBody degrades to prose", [c4.blocks.length, c4.degraded.length, longBody.length > LIMITS.calloutBody], [0, 1, true]);

const cyber = fid("compliance.cyber-insurance");
for (const [name, visual] of [
  ["callout", { kind: "callout", cites: [cyber], body: "XL.net carries $2,000,000 in cyber liability." }],
  ["table cell", { ...goodTable, rows: [["P1 Critical", "15 minutes", "2,000,000 dollars"]] }],
  ["tile", { kind: "stats", tiles: [{ fact: cyber, value: "$2,000,000", label: "Cyber cover" }, { fact: retention, value: "92%", label: "Retention" }, { fact: desk, value: "99.9%", label: "Remote" }] }],
  ["cards", { kind: "cards", cites: [cyber], cards: [{ title: "Cover", body: "2,000,000 USD" }, { title: "Carrier", body: "Beazley MediaTech" }] }],
] as const) {
  const r = parseModelVisuals([visual], ctx());
  check(`currency drops the whole block (${name})`, [r.blocks.length, r.degraded.length, r.dropped[0]?.reason], [0, 0, "currency"]);
}

const onsite = fid("onsite.billing");
const cardPair = [
  { title: "Reactive onsite", body: "Included in the flat fee, with no hourly charge." },
  { title: "Project work", body: "Charged through a fixed-fee Statement of Work." },
];
const k1 = parseModelVisuals([{ kind: "cards", after: 0, cites: [onsite], cards: cardPair }], ctx());
check("two cards land", k1.blocks.map((b) => (b.kind === "cards" ? b.cards : null)), [cardPair]);
const k2 = parseModelVisuals([{ kind: "cards", cites: [onsite], cards: [...cardPair, cardPair[0]] }], ctx());
check('three cards are not two-up: degraded as "title: body"', [k2.blocks.length, k2.degraded[0]], [0, "Reactive onsite: Included in the flat fee, with no hourly charge."]);

const four = parseModelVisuals(
  Array.from({ length: 5 }, () => ({ kind: "callout", cites: [term], body: "We have to keep earning it." })),
  ctx()
);
check("at most LIMITS.modelVisuals blocks kept", [four.blocks.length, four.dropped.map((d) => d.reason)], [LIMITS.modelVisuals, ["over-limit", "over-limit"]]);
check("kept blocks have distinct ids", new Set(four.blocks.map((b) => b.id)).size, LIMITS.modelVisuals);
yes("newBlockId shape", /^v_[0-9a-f]{8}$/.test(newBlockId()));

// ---- negative facts, normalization on the way in and out (refute-e) --------------
{
  const neg: GroundFact = { id: "f_neg", key: "contract.three-year", statement: "XL.net does not offer a three-year term.", detail: null, polarity: "negative" };
  const pos: GroundFact = { id: "f_pos", key: "contract.term", statement: "The term is a revolving 90-day agreement.", detail: null, polarity: "affirmative" };
  const c = { facts: [neg, pos], paragraphCount: 2, sectionCites: [] as string[] };
  const t1 = parseModelVisuals([{ kind: "table", after: 0, cites: ["f_neg"], columns: ["Term", "Offered"], rows: [["three-year", "No"]] }], c);
  check("a negative fact's numbers never ground a table cell", [t1.blocks.length, t1.dropped[0]?.reason], [0, "ungrounded"]);
  const t2 = parseModelVisuals([{ kind: "callout", after: 0, cites: ["f_neg", "f_pos"], title: null, body: "A revolving 90-day agreement, never a three-year one." }], c);
  check("a negative cite stays on the block while its numbers do not count", [t2.blocks.length, t2.dropped[0]?.reason], [0, "ungrounded"]);
  const t3 = parseModelVisuals([{ kind: "callout", after: 0, cites: ["f_neg", "f_pos"], title: null, body: "A revolving 90-day agreement." }], c);
  check("the affirmative cite grounds; both cites are kept", [t3.blocks.length, t3.blocks[0]?.cites], [1, ["f_neg", "f_pos"]]);
  const t4 = parseModelVisuals([{ kind: "cards", after: 0, cites: ["f_neg"], cards: [{ title: "Term", body: "Three-year available." }, { title: "Other", body: "Ask us." }] }], c);
  check("cards: a negative fact's number word does not ground", [t4.blocks.length, t4.dropped[0]?.reason], [0, "ungrounded"]);

  // The cleaner: NFKC, format characters out, Unicode spaces plain (the pdf italic face crashes on U+200B / U+2009).
  const zw = parseModelVisuals([{ kind: "callout", after: 0, cites: ["f_pos"], title: "Te​rm", body: "A revolving 90-day agree​ment." }], c);
  check("clean: zero-width and thin spaces never reach a block", zw.blocks.map((b) => (b.kind === "callout" ? [b.title, b.body] : null)), [["Term", "A revolving 90-day agreement."]]);
  const fw = parseModelVisuals([{ kind: "table", after: 0, cites: ["f_pos"], columns: ["Term", "Days"], rows: [["Revolving", "９０-day"]] }], c);
  check("clean: fullwidth digits are stored as ASCII and ground as such", fw.blocks.map((b) => (b.kind === "table" ? b.rows : null)), [[["Revolving", "90-day"]]]);
  const stored = sanitizeStoredBlocks(
    [
      { kind: "stat-tiles", tiles: [{ value: "９９.９%", label: "a​b", note: "n o t\u0007e" }, { value: "2", label: "b" }], id: "v_00000001", after: 0, cites: ["f"], generatedBy: "llm" },
      { kind: "cards", cards: [{ title: "a", body: "b", footnote: "f​oot" }, { title: "c", body: "d" }], id: "v_00000002", after: 0, cites: ["f"], generatedBy: "llm" },
    ],
    1
  );
  check(
    "stored: strings come back normalized (no zero-width, thin or non-breaking space, no control, ASCII digits)",
    stored.map((b) => (b.kind === "stat-tiles" ? b.tiles[0] : b.kind === "cards" ? b.cards[0].footnote : null)),
    [{ value: "99.9%", label: "ab", note: "n o te" }, "foot"]
  );
  check("stored: a tab and a newline survive normalization", sanitizeStoredBlocks([{ kind: "callout", title: null, body: "a\tb\nc", tone: "neutral", id: "v_00000003", after: 0, cites: ["f"], generatedBy: "llm" }], 0)[0]?.kind === "callout" && (sanitizeStoredBlocks([{ kind: "callout", title: null, body: "a\tb\nc", tone: "neutral", id: "v_00000003", after: 0, cites: ["f"], generatedBy: "llm" }], 0)[0] as { body: string }).body, "a\tb\nc");
}

// ---- sanitizeStoredBlocks ------------------------------------------------------
const fixtureBlocks = fixtureSections.flatMap((s) => s.blocks ?? []);
for (const s of fixtureSections) {
  if (!s.blocks) continue;
  const stored = JSON.parse(JSON.stringify(s.blocks));
  check(`stored blocks round-trip deep-equal (section ${s.label})`, sanitizeStoredBlocks(stored, s.paragraphs.length), s.blocks);
}
check("the stretch timeline round-trips too", sanitizeStoredBlocks([stretchTimelineBlock], 0), [stretchTimelineBlock]);
check(
  "the fixture carries every v1 kind",
  ["stat-tiles", "fact-grid", "badge-strip", "table", "callout", "cards"].filter((k) => !fixtureBlocks.some((b) => b.kind === k)),
  []
);
yes("the fixture has a 14-row table", fixtureBlocks.some((b) => b.kind === "table" && b.rows.length === 14));
{
  // The render fixture exercises the one-line fit both ways (tile-fit.ts).
  const rows = fixtureBlocks.flatMap((b) => (b.kind === "stat-tiles" ? [b.tiles.map((t) => t.value)] : []));
  yes(
    "the fixture has a four-across row of admissible values that steps down from the design size",
    rows.some((r) => r.length === 4 && r.every(valueFitsTile) && tileValuePx(r, NARROWEST_TILE_INNER_PX) < TILE_FIT.designPx)
  );
  yes("the fixture has a stored legacy row with a value past the contract", rows.some((r) => r.length === 4 && !r.every(valueFitsTile)));
}
check("the fixture has no currency and no em dash anywhere", allStrings(fixtureSections).filter((s) => hasCurrency(s) || s.includes("—")), []);
{
  // Lifting into the content model is adding BlockBase fields and nothing else. The references
  // block is the exception (it lifts into tables; the visual gate tests pin that lift).
  const bad: string[] = [];
  for (const b of [...fixtureBlocks, stretchTimelineBlock]) {
    if (b.kind === "references") continue;
    const { after: _after, origin: _origin, ...body } = b;
    const lifted = { ...body, sectionId: "sec_x", ordinal: 0, editedByHuman: false };
    if (!blockSchema.safeParse(lifted).success) bad.push(b.id);
  }
  check("every fixture block lifts into a content-model Block", bad, []);
}

const valid = fixtureBlocks[0];
for (const [name, raw] of [
  ["null", null],
  ["a string", "blocks"],
  ["an object", { 0: valid }],
  ["junk entries", [null, 1, "x", [], {}, { kind: "table" }]],
  ["unknown kind", [{ ...valid, kind: "pull-quote" }]],
  ["bad id", [{ ...valid, id: "b_1._0" }]],
  ["empty cites", [{ ...valid, cites: [] }]],
  ["non-string cite", [{ ...valid, cites: [1] }]],
  ["generatedBy human", [{ ...valid, generatedBy: "human" }]],
  ["unknown origin", [{ ...valid, origin: "elsewhere" }]],
  ["after not a number", [{ ...valid, after: "1" }]],
  ["one tile", [{ kind: "stat-tiles", tiles: [{ value: "1", label: "x" }], id: "v_00000001", after: 0, cites: ["f"], generatedBy: "llm" }]],
  ["five tiles", [{ kind: "stat-tiles", tiles: Array.from({ length: 5 }, () => ({ value: "1", label: "x" })), id: "v_00000001", after: 0, cites: ["f"], generatedBy: "llm" }]],
  ["tile value over the limit", [{ kind: "stat-tiles", tiles: [{ value: "1".repeat(LIMITS.tileValue + 1), label: "x" }, { value: "1", label: "x" }], id: "v_00000001", after: 0, cites: ["f"], generatedBy: "llm" }]],
  ["three cards", [{ kind: "cards", cards: [cardPair[0], cardPair[0], cardPair[0]], id: "v_00000001", after: 0, cites: ["f"], generatedBy: "llm" }]],
  ["ragged table", [{ kind: "table", caption: null, columns: [{ header: "a", align: "left" }, { header: "b", align: "left" }], rows: [["1"]], emphasizeLastRow: false, id: "v_00000001", after: 0, cites: ["f"], generatedBy: "llm" }]],
  ["15-row table", [{ kind: "table", caption: null, columns: [{ header: "a", align: "left" }, { header: "b", align: "left" }], rows: Array.from({ length: 15 }, () => ["1", "2"]), emphasizeLastRow: false, id: "v_00000001", after: 0, cites: ["f"], generatedBy: "llm" }]],
  ["table align junk", [{ kind: "table", caption: null, columns: [{ header: "a", align: "justify" }, { header: "b", align: "left" }], rows: [["1", "2"]], emphasizeLastRow: false, id: "v_00000001", after: 0, cites: ["f"], generatedBy: "llm" }]],
  ["callout without a tone", [{ kind: "callout", title: null, body: "x", id: "v_00000001", after: 0, cites: ["f"], generatedBy: "llm" }]],
  ["callout body over the limit", [{ kind: "callout", title: null, body: "x".repeat(LIMITS.calloutBody + 1), tone: "neutral", id: "v_00000001", after: 0, cites: ["f"], generatedBy: "llm" }]],
  ["currency in a stored block", [{ kind: "callout", title: null, body: "It costs $5.", tone: "neutral", id: "v_00000001", after: 0, cites: ["f"], generatedBy: "llm" }]],
  ["five badges", [{ kind: "badge-strip", badges: Array.from({ length: 5 }, () => ({ label: "x" })), id: "v_00000001", after: 0, cites: ["f"], generatedBy: "system" }]],
  ["one fact pair", [{ kind: "fact-grid", pairs: [{ label: "a", value: "b" }], id: "v_00000001", after: 0, cites: ["f"], generatedBy: "system" }]],
] as const) {
  let got: unknown;
  try {
    got = sanitizeStoredBlocks(raw, 3);
  } catch (e) {
    got = `threw ${String(e)}`;
  }
  check(`stored: ${name} is dropped without throwing`, got, []);
}
check("stored: a bad neighbour does not take a good block with it", sanitizeStoredBlocks([null, valid, { ...valid, id: "x" }], 9), [valid]);
check("stored: a repeated id keeps the first only", sanitizeStoredBlocks([valid, { ...valid }], 9).length, 1);
check("stored: `after` clamps to the paragraphs that exist", sanitizeStoredBlocks([{ ...valid, after: 40 }, { ...valid, id: "v_000000ff", after: -2 }], 2).map((b) => b.after), [2, 0]);
check(
  "stored: at most LIMITS.blocksPerSection",
  sanitizeStoredBlocks(Array.from({ length: 9 }, (_, i) => ({ ...valid, id: `v_0000000${i}` })), 3).length,
  LIMITS.blocksPerSection
);
check("stored: optional tile note survives", sanitizeStoredBlocks([{ kind: "stat-tiles", tiles: [{ value: "1", label: "a", note: "n" }, { value: "2", label: "b" }], id: "v_00000001", after: 0, cites: ["f"], generatedBy: "llm" }], 1)[0], {
  kind: "stat-tiles",
  tiles: [{ value: "1", label: "a", note: "n" }, { value: "2", label: "b" }],
  id: "v_00000001",
  after: 0,
  cites: ["f"],
  generatedBy: "llm",
});

// ---- the references block: the one kind stored without cites ---------------------
{
  const stored = JSON.parse(JSON.stringify(referencesBlock));
  check("references: a two-entry block round-trips deep-equal with cites []", sanitizeStoredBlocks([stored], 1), [referencesBlock]);
  check("references: the fixture block cites nothing, is system-built, origin references", [referencesBlock.cites, referencesBlock.generatedBy, referencesBlock.origin], [[], "system", "references"]);
  const entries = referencesBlock.kind === "references" ? referencesBlock.references : [];
  const withEntry = (patch: Partial<(typeof entries)[number]>, at = 1) =>
    sanitizeStoredBlocks([{ ...stored, references: entries.map((e, i) => (i === at ? { ...e, ...patch } : e)) }], 1);
  check("references: an entry without an organization drops the whole block", withEntry({ organization: "" }), []);
  check("references: an entry without a contact name drops the whole block", withEntry({ contactName: "  " }), []);
  check("references: an entry with neither phone nor email drops the whole block", withEntry({ phone: "", email: "" }), []);
  check("references: an entry with a phone and no email is kept", withEntry({ phone: "312-555-0199", email: "" }).length, 1);
  check("references: a malformed email drops the whole block", withEntry({ email: "not-an-email" }), []);
  check("references: no entries at all is not a block", sanitizeStoredBlocks([{ ...stored, references: [] }], 1), []);
  check("references: a non-array `references` is not a block", sanitizeStoredBlocks([{ ...stored, references: { 0: entries[0] } }], 1), []);
  check("references: an empty cites array is accepted ONLY for this kind", sanitizeStoredBlocks([{ ...stored, kind: "callout", title: null, body: "x", tone: "neutral" }], 1), []);
  check("references: a non-empty cites array is still accepted", sanitizeStoredBlocks([{ ...stored, cites: ["f"] }], 1).map((b) => b.cites), [["f"]]);
  check("references: a non-array cites is still refused", sanitizeStoredBlocks([{ ...stored, cites: "none" }], 1), []);
  check("references: generatedBy human is refused like every kind", sanitizeStoredBlocks([{ ...stored, generatedBy: "human" }], 1), []);
  check("references: `after` clamps like every kind", sanitizeStoredBlocks([{ ...stored, after: 9 }], 0)[0]?.after, 0);
  // The currency screen is for MODEL text. A references block is person-supplied, and real
  // organization names and surnames read as money to it; the block must survive every read.
  for (const [what, patch] of [
    ["an organization named like a county", { organization: "Bucks County Free Library" }],
    ["an organization named like a currency", { organization: "Dollar Bank" }],
    ["a contact surnamed like a coin", { contactName: "Jordan Pence" }],
    ["a school district's number", { organization: "School District USD 259" }],
    ["a relevance naming CAD", { relevance: "Architecture, CAD workloads" }],
    ["a currency sign in a name", { organization: "$5 Pizza" }],
  ] as const) {
    const kept = withEntry(patch);
    check(`references: ${what} SURVIVES the round-trip`, kept.length === 1 && kept[0].kind === "references" ? kept[0].references[1] : null, { ...entries[1], ...patch });
    yes(`references: ${what} does trip hasCurrency (so the exemption is what keeps it)`, referencesBlockStrings([{ ...entries[1], ...patch }]).some(hasCurrency));
  }
  check("references: every other kind still drops on currency", sanitizeStoredBlocks([{ kind: "callout", title: null, body: "Dollar Bank", tone: "neutral", id: "v_00000002", after: 0, cites: ["f"], generatedBy: "llm" }], 1), []);
  check("references: the card strings are what the screen reads", referencesBlockStrings(entries).filter(hasCurrency), []);
  yes("references: the card strings carry every entry field the card shows", ["Reference 1", "Reference 2", "Northwind Clinic", "Alex Rivera, COO", "312-555-0142 · a.rivera@example.org", "p.natarajan@example.org"].every((s) => referencesBlockStrings(entries).includes(s)));
  check("references: summary text", [draftBlockSummary(referencesBlock), draftBlockSummary({ ...referencesBlock, references: entries.slice(0, 1) } as DraftBlock)], ["Client references · 2 references", "Client references · 1 reference"]);
  const built = buildReferencesBlock(entries, 3);
  check("references: buildReferencesBlock envelope", [built.kind, built.after, built.cites, built.generatedBy, built.origin, /^v_[0-9a-f]{8}$/.test(built.id)], ["references", 3, [], "system", "references", true]);
  check("references: what buildReferencesBlock stores reads back untouched", sanitizeStoredBlocks(JSON.parse(JSON.stringify([built])), 3), [built]);
  // The model never authors one: the kind is refused by name, whatever the payload.
  const fromModel = parseModelVisuals([{ kind: "references", after: 0, cites: [fid("book.retention")], references: entries }], ctx());
  check("references: parseModelVisuals refuses the kind", [fromModel.blocks.length, fromModel.degraded.length, fromModel.dropped], [0, 0, [{ kind: "references", reason: "unknown-kind" }]]);
  // Write paths carry it like any stored block, and the visuals op never builds one.
  check("references: keptBlocks re-anchors it to the new paragraph count", keptBlocks({ label: "7.", paragraphs: ["a"], blocks: [stored] }, 0)?.map((b) => [b.kind, b.after]), [["references", 0]]);
  no("references: not a VISUALS_ACTIONS member", isVisualsAction("references"));
  const removed = applyVisualsOp([{ label: "7.", title: "R", paragraphs: ["a"], cites: [], generatedBy: "human" as const, updatedAt: "then", blocks: [referencesBlock] }], { label: "7.", action: "remove", blockId: referencesBlock.id }, [], "now");
  check("references: the remove action deletes it by id like any block", removed.ok && [removed.removed, "blocks" in removed.section], [1, false]);
  // Removing the references takes the ANSWER back: stamp cleared, composed intro stripped.
  {
    const INTRO = "The following comparable client references are provided.";
    const ETIQ = "Out of respect for our clients' time, we ask that references be called as a final step before contract rather than earlier in the evaluation.";
    const other: DraftBlock = { kind: "callout", title: null, body: "kept", tone: "neutral", id: "v_00000003", after: 2, cites: ["f"], generatedBy: "llm" };
    const rec = { label: "7.", title: "R", paragraphs: ["a", `${INTRO} ${ETIQ}`], cites: [], generatedBy: "human" as const, gaps: [], updatedAt: "then", referencesAnswered: true, blocks: [other, { ...referencesBlock, after: 2 }] };
    const out = applyVisualsOp([rec], { label: "7.", action: "remove", blockId: referencesBlock.id }, [], "now");
    check("references remove: flagged, stamp cleared, intro stripped, the other block re-anchored",
      out.ok && [out.removedReferences, "referencesAnswered" in out.section, out.section.paragraphs, out.section.blocks?.map((b) => [b.id, b.after])],
      [true, false, ["a"], [["v_00000003", 1]]]);
    const folded = applyVisualsOp([{ ...rec, paragraphs: ["a", `Last words. ${INTRO}`] }], { label: "7.", action: "remove", blockId: referencesBlock.id }, [], "now");
    check("references remove: an intro folded onto a paragraph is cut off it", folded.ok && folded.section.paragraphs, ["a", "Last words."]);
    const rewritten = applyVisualsOp([{ ...rec, paragraphs: ["a", "Our own words about these clients."] }], { label: "7.", action: "remove", blockId: referencesBlock.id }, [], "now");
    check("references remove: a paragraph the person rewrote stays", rewritten.ok && rewritten.section.paragraphs, ["a", "Our own words about these clients."]);
    const plain = applyVisualsOp([rec], { label: "7.", action: "remove", blockId: "v_00000003" }, [], "now");
    check("references remove: removing ANOTHER block leaves the stamp, the paragraphs and the result shape alone",
      plain.ok && ["removedReferences" in plain, plain.section.referencesAnswered, plain.section.paragraphs, plain.section.blocks?.length],
      [false, true, rec.paragraphs, 1]);
  }
}

// ---- interleave / reanchor -----------------------------------------------------
const blk = (id: string, after: number): DraftBlock => ({ kind: "callout", title: null, body: id, tone: "neutral", id, after, cites: ["f"], generatedBy: "llm" });
const shape = (paragraphs: string[], blocks: DraftBlock[] | undefined) =>
  interleave(paragraphs, blocks).map((i) => (i.type === "p" ? `p${i.index}` : i.block.id));
check("after 0 opens the section", shape(["a", "b"], [blk("x", 0)]), ["x", "p0", "p1"]);
check("mid anchor", shape(["a", "b", "c"], [blk("x", 2)]), ["p0", "p1", "x", "p2"]);
check("end anchor", shape(["a", "b"], [blk("x", 2)]), ["p0", "p1", "x"]);
check("several at one anchor keep stored order", shape(["a", "b"], [blk("z", 1), blk("x", 1), blk("y", 1), blk("w", 0)]), ["w", "p0", "z", "x", "y", "p1"]);
check("an anchor past the end renders last, never vanishes", shape(["a"], [blk("x", 7), blk("y", -1)]), ["y", "p0", "x"]);
check("blocks with no paragraphs at all", shape([], [blk("x", 0), blk("y", 3)]), ["x", "y"]);
check("paragraph items carry their text and index", interleave(["a", "b"], undefined), [
  { type: "p", index: 0, text: "a" },
  { type: "p", index: 1, text: "b" },
]);
const legacy = fixtureSections.find((s) => s.label === "5.")!;
no("the legacy fixture record has no blocks key", "blocks" in legacy);
check(
  "a legacy record flows as paragraphs only",
  interleave(legacy.paragraphs, sanitizeStoredBlocks((legacy as { blocks?: unknown }).blocks, legacy.paragraphs.length)).map((i) => i.type),
  legacy.paragraphs.map(() => "p")
);
check("reanchor: undefined stays undefined", reanchorBlocks(undefined, 3), undefined);
check("reanchor: empty becomes undefined, so the key stays absent", reanchorBlocks([], 3), undefined);
check("reanchor: clamps to the new paragraph count", reanchorBlocks([blk("x", 5), blk("y", 1), blk("z", 0)], 2)?.map((b) => b.after), [2, 1, 0]);
{
  const before = [blk("x", 5)];
  const after = reanchorBlocks(before, 1)!;
  check("reanchor: does not mutate its input, keeps everything else", [before[0].after, { ...after[0], after: 5 }], [5, before[0]]);
}

// ---- pickAboutSection ----------------------------------------------------------
const eight = [
  { label: "1.", title: "Overview" },
  { label: "2.", title: "Scope of Services" },
  { label: "3.", title: "Service, Privacy & Security Expectations" },
  { label: "4.", title: "Vendor Qualifications" },
  { label: "5.", title: "Contract & Pricing" },
  { label: "6.", title: "What to Submit" },
  { label: "7.", title: "Evaluation" },
  { label: "8.", title: "Schedule & Submission" },
];
check("the eight-section structure picks Vendor Qualifications", pickAboutSection(eight, []), "4.");
check(
  "requirement noise elsewhere does not outvote the title",
  pickAboutSection(eight, [
    { structureLabel: "6.", text: "Include a company profile." },
    { structureLabel: "6.", text: "Include your firm's history." },
  ]),
  "4."
);
check("Company Information", pickAboutSection([{ label: "A", title: "Introduction" }, { label: "B", title: "Company Information" }, { label: "C", title: "Pricing" }], []), "B");
check("About Us", pickAboutSection([{ label: "I", title: "About Us" }], []), "I");
check("nothing suitable is null", pickAboutSection([{ label: "1", title: "Overview" }, { label: "2", title: "Scope of Work" }, { label: "3", title: "Background" }, { label: "4", title: "Pricing" }], []), null);
check("empty / hostile input is null", [pickAboutSection([], []), pickAboutSection(null as never, null as never)], [null, null]);
check(
  "three matching requirements carry an untitled section",
  pickAboutSection(
    [{ label: "1", title: "Overview" }, { label: "2", title: "Response Items" }],
    [
      { structureLabel: "2", text: "Provide a description of your business." },
      { structureLabel: "2", text: "Provide your company history and years in operation." },
      { structureLabel: "2", text: "Describe vendor qualifications relevant to this work." },
    ]
  ),
  "2"
);
check(
  "two matching requirements are under the threshold",
  pickAboutSection([{ label: "2", title: "Response Items" }], [
    { structureLabel: "2", text: "Provide a description of your business." },
    { structureLabel: "2", text: "Provide your company history." },
  ]),
  null
);
check("a tie goes to the first in structure order", pickAboutSection([{ label: "x", title: "Company Profile" }, { label: "y", title: "Vendor Qualifications" }], []), "x");
check("a reserved label never qualifies", pickAboutSection([{ label: "__letter", title: "About Us" }], []), null);
check("the fixture structure picks its qualifications section", pickAboutSection(fixtureStructure, fixtureRequirements), "4.");

// ---- buildAboutBlocks ----------------------------------------------------------
const about = buildAboutBlocks(facts);
const grid = about.find((b) => b.kind === "fact-grid");
const badges = about.find((b) => b.kind === "badge-strip");
check("about = fact grid then badge strip", about.map((b) => [b.kind, b.after, b.generatedBy, b.origin]), [
  ["fact-grid", 0, "system", "about"],
  ["badge-strip", 0, "system", "about"],
]);
check("about grid rows", grid?.kind === "fact-grid" && grid.pairs, [
  { label: "Founded", value: "2009" },
  { label: "Headquarters", value: "Chicago metropolitan area, Illinois" },
  { label: "Team", value: "47 full-time employees" },
  { label: "Active clients", value: "73" },
  { label: "Client retention", value: "92%" },
  { label: "Average client tenure", value: "4.8 years" },
  { label: "Organizations we serve", value: "15 to 250 employees" },
  { label: "Service desk", value: "24/7/365 live service desk" },
  { label: "Insurance", value: "Technology errors and omissions alongside cyber liability · Beazley MediaTech" },
]);
check("about badges", badges?.kind === "badge-strip" && badges.badges, [
  { label: "ISO 27001:2022" },
  { label: "SOC 2 Type 2", note: "Audited annually" },
  { label: "CMMC Level 1" },
]);
check("about: no currency anywhere", about.flatMap(bodyText).filter(hasCurrency), []);
yes("about: cites are non-empty and all known", about.every((b) => b.cites.length > 0 && b.cites.every((c) => facts.some((f) => f.id === c))));
{
  // Every VALUE is literal fact text: each of its tokens appears in a statement the block cites,
  // and its numbers ground through the same gate a model tile passes.
  const loose: string[] = [];
  for (const b of about) {
    const cited = b.cites.map((c) => facts.find((f) => f.id === c)!.statement).join(" ");
    const have = new Set(words(cited));
    const values = b.kind === "fact-grid" ? b.pairs.map((p) => p.value) : b.kind === "badge-strip" ? b.badges.flatMap((x) => [x.label, x.note ?? ""]) : [];
    for (const v of values) {
      if (!words(v).every((w) => have.has(w)) || !groundValue(v, cited)) loose.push(v);
    }
  }
  check("about: every value is literal, grounded fact text", loose, []);
}
{
  const without = (key: string) => facts.filter((f) => f.key !== key);
  const negated = (key: string): GroundFact[] => facts.map((f) => (f.key === key ? { ...f, polarity: "negative" } : f));
  const labels = (fs: GroundFact[]) => {
    const g = buildAboutBlocks(fs).find((b) => b.kind === "fact-grid");
    return g?.kind === "fact-grid" ? g.pairs.map((p) => p.label) : [];
  };
  const badgeLabels = (fs: GroundFact[]) => {
    const g = buildAboutBlocks(fs).find((b) => b.kind === "badge-strip");
    return g?.kind === "badge-strip" ? g.badges.map((p) => p.label) : null;
  };
  no("a retired (absent) fact omits its row", labels(without("book.retention")).includes("Client retention"));
  no("a negative fact omits its row", labels(negated("company.headcount")).includes("Team"));
  check("one fact backing two rows omits both", labels(without("company.founded")).filter((l) => l === "Founded" || l === "Headquarters"), []);
  no(
    "a reworded fact drops its row rather than guessing",
    labels(facts.map((f) => (f.key === "book.retention" ? { ...f, statement: "Nearly all clients renew." } : f))).includes("Client retention")
  );
  check("a negated certification loses its badge", badgeLabels(negated("compliance.cmmc")), ["ISO 27001:2022", "SOC 2 Type 2"]);
  check("no certifications, no badge strip", badgeLabels(facts.filter((f) => !/^compliance\.(iso-27001|soc-2|cmmc)$/.test(f.key))), null);
  check("no facts at all, no blocks", buildAboutBlocks([]), []);
  const underscored = facts.map((f) => ({ ...f, key: f.key.replace(/[-.]/g, "_") }));
  check("keys match across - _ .", labels(underscored).length, 9);
  check(
    "the insurance row never carries the figure, even if the statement moves it",
    buildAboutBlocks(facts.map((f) => (f.key === "compliance.cyber-insurance" ? { ...f, statement: "The product covers technology errors and omissions alongside cyber liability through Beazley $2,000,000." } : f)))
      .flatMap(bodyText)
      .filter(hasCurrency),
    []
  );
}

// ---- buildServiceStatsBlock / buildOnboardingTimeline ----------------------------
const svc = buildServiceStatsBlock(facts);
check("service stats tiles", svc?.kind === "stat-tiles" && svc.tiles, [
  { value: ">99%", label: "Calls answered live" },
  { value: "99.9%", label: "Issues resolved remotely" },
  { value: ">70%", label: "First-contact resolution" },
]);
check("service stats envelope", svc && [svc.after, svc.generatedBy, svc.origin, svc.cites], [0, "system", "service-stats", [desk, fcr]]);
{
  const plain = facts.map((f) => (f.key === "book.first-contact-resolution" ? { ...f, statement: "First-contact resolution is 70%." } : f));
  const b = buildServiceStatsBlock(plain);
  check('no ">" unless the fact says above / more than', b?.kind === "stat-tiles" && b.tiles[2], { value: "70%", label: "First-contact resolution" });
  check("fewer than two tiles is null", buildServiceStatsBlock(facts.filter((f) => f.key !== "operations.service-desk-hours")), null);
  check("no facts is null", buildServiceStatsBlock([]), null);
}
check("timeline steps come from the four phase facts", stretchTimelineBlock.kind === "timeline" && stretchTimelineBlock.steps.map((s) => [s.label, s.title]), [
  ["Step 1", "Pre-onboarding"],
  ["Step 2", "Onboarding day"],
  ["Step 3", "First 30 days"],
  ["Step 4", "Day 31 to 90 and beyond"],
]);
check(
  "timeline bodies are the facts' own sentences",
  stretchTimelineBlock.kind === "timeline" && stretchTimelineBlock.steps.every((s, i) => {
    const st = fact(["onboarding.pre-onboarding", "onboarding.onboarding-day", "onboarding.first-30-days", "onboarding.days-31-90"][i]).statement;
    return st.toLowerCase().endsWith(s.body.toLowerCase());
  }),
  true
);
check("timeline with one phase fact is null", buildOnboardingTimeline(facts.filter((f) => !f.key.startsWith("onboarding.") || f.key === "onboarding.onboarding-day")), null);

// ---- tableColumnFractions / draftBlockSummary -----------------------------------
for (const b of fixtureBlocks) {
  if (b.kind !== "table") continue;
  const fr = tableColumnFractions(b);
  check(`fractions sum to 1 (${b.caption})`, [fr.length, Math.abs(fr.reduce((a, x) => a + x, 0) - 1) < 1e-9, fr.every((f) => f >= 0.1)], [b.columns.length, true, true]);
}
{
  const matrix = fixtureBlocks.find((b) => b.kind === "table" && b.rows.length === 14)!;
  const fr = matrix.kind === "table" ? tableColumnFractions(matrix) : [];
  yes("the long-text column gets the most room", fr[2] > fr[0] && fr[2] > fr[1]);
  const five = tableColumnFractions({
    kind: "table",
    caption: null,
    columns: ["a", "b", "c", "d", "e"].map((header) => ({ header, align: "left" as const })),
    rows: [["x", "y", "z".repeat(200), "w", "v"]],
    emphasizeLastRow: false,
  });
  check("five columns: sums to 1, none starved", [Math.abs(five.reduce((a, x) => a + x, 0) - 1) < 1e-9, Math.min(...five) >= 0.1], [true, true]);
  // The reference card: two columns, no caption, a blank second header. Pinned to the template's
  // one-third label column whatever the cells hold, so every card lines up on every surface.
  for (const entry of referencesBlock.kind === "references" ? referencesBlock.references : [])
    check(`reference card fractions are fixed (${entry.organization})`, tableColumnFractions(referenceCardTable({ ...entry, relevance: "x".repeat(110) }, 1)), [0.3333, 0.6667]);
  check("a captioned two-column table with a blank second header is NOT pinned", tableColumnFractions({ kind: "table", caption: "c", columns: [{ header: "aaaaaa", align: "left" }, { header: "", align: "left" }], rows: [], emphasizeLastRow: false }), [0.5, 0.5]);
  check("a stored table cannot take the card shape: an empty header is refused", sanitizeStoredBlocks([{ kind: "table", caption: null, columns: [{ header: "Reference 1", align: "left" }, { header: "", align: "left" }], rows: [["a", "b"]], emphasizeLastRow: false, id: "v_00000004", after: 0, cites: ["f"], generatedBy: "llm" }], 1), []);
  check("a model table cannot take the card shape either", parseModelVisuals([{ kind: "table", after: 0, cites: [fid("book.retention")], caption: null, columns: ["Reference 1", ""], rows: [["a", "b"]] }], ctx()).blocks.length, 0);
  check("equal columns split evenly", tableColumnFractions({ kind: "table", caption: null, columns: [{ header: "aaaaaa", align: "left" }, { header: "bbbbbb", align: "left" }], rows: [], emphasizeLastRow: false }), [0.5, 0.5]);
}
check("summaries", [...fixtureBlocks, stretchTimelineBlock].map(draftBlockSummary), [
  "Callout · No lock-in",
  "Stat tiles · 4 figures",
  "Table · How each service is delivered",
  "Cards · Reactive onsite visits / Moves, adds and project work",
  "Stat tiles · 4 figures",
  "Service stats · 3 figures",
  "Table · Suggested service level targets",
  "Company snapshot · 9 facts",
  "Certifications · ISO 27001:2022, SOC 2 Type 2, CMMC Level 1",
  "Callout · XL.net becomes accountable for support as soon as it holds valid cred…",
  "Client references · 2 references",
  "Timeline · 4 steps",
]);
check("an uncaptioned table is summarized by its shape", draftBlockSummary({ kind: "table", caption: null, columns: [{ header: "a", align: "left" }, { header: "b", align: "left" }], rows: [["1", "2"]], emphasizeLastRow: false, id: "v_00000001", after: 0, cites: ["f"], generatedBy: "llm" }), "Table · 2 columns, 1 row");
check("no summary carries an em dash", [...fixtureBlocks, stretchTimelineBlock].map(draftBlockSummary).filter((s) => s.includes("—")), []);
check("kinds are the closed set", [...DRAFT_BLOCK_KINDS], ["stat-tiles", "fact-grid", "badge-strip", "table", "callout", "cards", "timeline", "references"]);

// ---------------------------------------------------------------------------
// Server placement and write-path helpers (draft-blocks-ops.ts)
// ---------------------------------------------------------------------------
{
  const woccStructure = [
    { label: "1.", title: "Overview" },
    { label: "2.", title: "Scope of Services" },
    { label: "3.", title: "Service, Privacy & Security Expectations" },
    { label: "4.", title: "Vendor Qualifications" },
    { label: "5.", title: "Contract & Pricing" },
  ];
  check("service stats: the fixture's service section", pickServiceStatsSection(fixtureStructure, fixtureRequirements), "3.");
  check("service stats: no title or ask speaks to the service desk", pickServiceStatsSection(woccStructure, []), null);
  check(
    "service stats: two asks carry a section whose title does not",
    pickServiceStatsSection(woccStructure, [
      { structureLabel: "2.", text: "Describe your help desk." },
      { structureLabel: "2.", text: "State your response times." },
      { structureLabel: "5.", text: "Describe ongoing support costs." },
    ]),
    "2."
  );
  check("service stats: bare 'support' is not evidence", pickServiceStatsSection(woccStructure, [{ structureLabel: "5.", text: "Describe support." }, { structureLabel: "5.", text: "Support terms." }]), null);
  check("service stats: a reserved label never qualifies", pickServiceStatsSection([{ label: "__letter", title: "Service desk" }], []), null);

  check(
    "toGroundFacts: live rows only, negatives kept with their polarity",
    toGroundFacts([
      { id: "a", key: "k.a", statement: "A.", detail: null, polarity: "affirmative", retiredInKb: null },
      { id: "b", key: "k.b", statement: "B.", detail: "d", polarity: "negative" },
      { id: "c", key: "k.c", statement: "C.", detail: null, polarity: "affirmative", retiredInKb: 7 },
    ]),
    [
      { id: "a", key: "k.a", statement: "A.", detail: null, polarity: "affirmative" },
      { id: "b", key: "k.b", statement: "B.", detail: "d", polarity: "negative" },
    ]
  );

  // The drafter's visuals against the paragraphs the section keeps.
  const paras = ["One.", "Two.", "Three."];
  const goodStats = {
    kind: "stats",
    after: 1,
    tiles: [
      { fact: fid("book.retention"), value: "92%", label: "Client retention" },
      { fact: fid("book.active-clients"), value: "73", label: "Active clients" },
    ],
  };
  const fin = finishDraftVisuals([goodStats, { kind: "stats", after: 0, tiles: [{ fact: fid("book.retention"), value: "97%", label: "Made up" }] }], paras, facts, []);
  check("finish: a grounded visual is kept, an invented one dropped, prose untouched", [fin.blocks.length, fin.blocks[0]?.after, fin.paragraphs, fin.stats], [1, 1, paras, { returned: 2, kept: 1, degraded: 0, dropped: 1 }]);
  const degr = finishDraftVisuals([{ kind: "callout", after: 0, cites: [], title: "", body: "We answer the phone." }], paras, facts, []);
  check("finish: an uncited callout lands as prose at the end", [degr.blocks, degr.paragraphs, degr.stats], [[], [...paras, "We answer the phone."], { returned: 1, kept: 0, degraded: 1, dropped: 0 }]);
  const full = Array.from({ length: PARAGRAPH_CAP }, (_, i) => `P${i}.`);
  const noRoom = finishDraftVisuals([{ kind: "callout", after: 0, cites: [], title: "", body: "We answer the phone." }], full, facts, []);
  check("finish: degraded prose never passes the paragraph cap", [noRoom.paragraphs.length, noRoom.stats.degraded, noRoom.stats.dropped], [PARAGRAPH_CAP, 0, 1]);
  check("finish: no visuals key is no blocks and no change", finishDraftVisuals(undefined, paras, facts, []), { paragraphs: paras, blocks: [], stats: { returned: 0, kept: 0, degraded: 0, dropped: 0 } });
  check("finish: garbage never throws", finishDraftVisuals("nope", paras, facts, []).blocks, []);

  // Landing a fresh draft.
  const base = { structure: fixtureStructure, requirements: fixtureRequirements, sharedFacts: facts };
  const about = landDraftBlocks({ ...base, label: "4.", paragraphCount: 3, modelBlocks: fin.blocks, sections: [] });
  check("land: the about section opens with grid + badges, the model block after them", [about.blocks.map((b) => [b.kind, b.origin ?? null, b.generatedBy, b.after]), about.about, about.serviceStats], [[["fact-grid", "about", "system", 0], ["badge-strip", "about", "system", 0], ["stat-tiles", null, "llm", 1]], 2, 0]);
  const svc = landDraftBlocks({ ...base, label: "3.", paragraphCount: 3, modelBlocks: [], sections: [] });
  check("land: the service section gets the tiles after its first paragraph", svc.blocks.map((b) => [b.kind, b.origin, b.after]), [["stat-tiles", "service-stats", 1]]);
  check("land: an empty section anchors the tiles at 0", landDraftBlocks({ ...base, label: "3.", paragraphCount: 0, modelBlocks: [], sections: [] }).blocks[0]?.after, 0);
  check("land: an ordinary section keeps only the model's blocks", landDraftBlocks({ ...base, label: "2.", paragraphCount: 3, modelBlocks: fin.blocks, sections: [] }).blocks, fin.blocks);
  check("land: nothing at all is an empty list (the key stays absent)", landDraftBlocks({ ...base, label: "2.", paragraphCount: 3, modelBlocks: [], sections: [] }).blocks, []);
  const held = [{ label: "1.", paragraphs: ["x"], blocks: about.blocks }];
  check("land: another section holds the snapshot, so it is not built twice", landDraftBlocks({ ...base, label: "4.", paragraphCount: 3, modelBlocks: [], sections: held }).blocks, []);
  check("land: a redraft of the holder itself rebuilds it", landDraftBlocks({ ...base, label: "4.", paragraphCount: 3, modelBlocks: [], sections: [{ label: "4.", paragraphs: ["x"], blocks: about.blocks }] }).about, 2);
  check("land: retired facts build nothing", landDraftBlocks({ ...base, sharedFacts: [], label: "4.", paragraphCount: 3, modelBlocks: [], sections: [] }).blocks, []);
  check("land: the letter never gets a system block", landDraftBlocks({ ...base, structure: [{ label: "__letter", title: "About the company" }], label: "__letter", paragraphCount: 3, modelBlocks: [], sections: [] }).blocks, []);
  const sysTiles = buildServiceStatsBlock(facts)!;
  const echo: DraftBlock = { ...sysTiles, id: newBlockId(), generatedBy: "llm", origin: undefined };
  delete echo.origin;
  check("land: a model tile block that repeats the system tiles is dropped", landDraftBlocks({ ...base, label: "3.", paragraphCount: 3, modelBlocks: [echo], sections: [] }).blocks.length, 1);
  const six: DraftBlock[] = Array.from({ length: 6 }, () => ({ kind: "callout" as const, title: null, body: "Text.", tone: "neutral" as const, id: newBlockId(), after: 2, cites: [fid("book.retention")], generatedBy: "llm" as const }));
  const capped = landDraftBlocks({ ...base, label: "4.", paragraphCount: 3, modelBlocks: six, sections: [] });
  check("land: the cap trims the model's blocks, never the system's", [capped.blocks.length, capped.blocks.filter((b) => b.generatedBy === "system").length, capped.trimmed], [LIMITS.blocksPerSection, 2, 2]);
  check("land: a block anchored past the paragraphs is clamped", landDraftBlocks({ ...base, label: "2.", paragraphCount: 1, modelBlocks: [{ ...six[0], after: 9 }], sections: [] }).blocks[0].after, 1);

  // What an edit keeps.
  const rec = { label: "4.", paragraphs: ["a", "b", "c"], blocks: [{ ...six[0], after: 3 }, null, { kind: "nope" }] as unknown };
  check("kept: valid blocks survive, re-anchored to the shorter text", keptBlocks(rec, 1)?.map((b) => [b.id, b.after]), [[six[0].id, 1]]);
  check("kept: no blocks is undefined", keptBlocks({ label: "x", paragraphs: [] }, 3), undefined);
  check("withBlocks: the key is absent when there are none", JSON.stringify(withBlocks({ label: "x", paragraphs: ["a"], blocks: [six[0]] }, undefined)), '{"label":"x","paragraphs":["a"]}');
  check("withBlocks: a prose-only record is byte-identical", JSON.stringify(withBlocks({ label: "x", paragraphs: ["a"] }, [])), '{"label":"x","paragraphs":["a"]}');
  check("withBlocks: blocks are set", withBlocks({ label: "x" }, [six[0]]).blocks, [six[0]]);

  // The "visuals" op.
  const NOW = "2026-09-30T16:00:00.000Z";
  type Rec = { label: string; title: string; paragraphs: string[]; cites: string[]; generatedBy: "llm" | "human"; updatedAt: string; blocks?: DraftBlock[] };
  const mk = (label: string, blocks?: DraftBlock[]): Rec => ({ label, title: "T", paragraphs: ["a", "b"], cites: ["c1"], generatedBy: "llm", updatedAt: "then", ...(blocks ? { blocks } : {}) });
  const doc = [mk("1."), mk("4."), mk("__letter")];
  check("op: action names are the closed set", [...VISUALS_ACTIONS].map(isVisualsAction).concat(isVisualsAction("table"), isVisualsAction(undefined)), [true, true, true, true, false, false]);

  const a1 = applyVisualsOp(doc, { label: "4.", action: "about" }, facts, NOW);
  yes("op about: lands", a1.ok);
  if (a1.ok) {
    check("op about: grid + badges open the section; cites, author and text untouched", [a1.section.blocks?.map((b) => [b.kind, b.origin, b.after, b.generatedBy]), a1.section.cites, a1.section.generatedBy, a1.section.paragraphs, a1.section.updatedAt, a1.added, a1.removed], [[["fact-grid", "about", 0, "system"], ["badge-strip", "about", 0, "system"]], ["c1"], "llm", ["a", "b"], NOW, 2, 0]);
    check("op about: other records are the same objects", [a1.sections[0] === doc[0], a1.sections[2] === doc[2], a1.sections.length], [true, true, 3]);
    no("op about: the input is not mutated", "blocks" in doc[1]);
    const a2 = applyVisualsOp(a1.sections, { label: "4.", action: "about" }, facts, NOW);
    check("op about: a second call replaces, never duplicates", a2.ok && [a2.section.blocks?.length, a2.added, a2.removed], [2, 2, 2]);
    const elsewhere = applyVisualsOp(a1.sections, { label: "1.", action: "about" }, facts, NOW);
    check("op about: refused while another section holds it", elsewhere.ok ? null : [elsewhere.status, elsewhere.code, elsewhere.message], [409, "conflict", "The company snapshot is already on section 4.. Remove it there first."]);
    const s1 = applyVisualsOp(a1.sections, { label: "4.", action: "service-stats" }, facts, NOW);
    check("op stats: appended after the first paragraph; may live on two sections", s1.ok && s1.section.blocks?.map((b) => [b.origin, b.after]), [["about", 0], ["about", 0], ["service-stats", 1]]);
    const s2 = applyVisualsOp(a1.sections, { label: "1.", action: "service-stats" }, facts, NOW);
    yes("op stats: no single-holder rule", s2.ok);
    if (s1.ok) {
      const moved = s1.sections.map((s) => (s.label === "4." ? { ...s, blocks: s.blocks!.map((b) => (b.origin === "service-stats" ? { ...b, after: 2 } : b)) } : s));
      const again = applyVisualsOp(moved, { label: "4.", action: "service-stats" }, facts, NOW);
      check("op stats: a refresh keeps the slot and the anchor", again.ok && again.section.blocks?.map((b) => [b.origin, b.after]), [["about", 0], ["about", 0], ["service-stats", 2]]);
      const gridId = s1.section.blocks![0].id;
      const r1 = applyVisualsOp(s1.sections, { label: "4.", action: "remove", blockId: gridId }, [], NOW);
      check("op remove: one block by id, no facts needed", r1.ok && [r1.section.blocks?.map((b) => b.kind), r1.removed, r1.added], [["badge-strip", "stat-tiles"], 1, 0]);
      const r404 = applyVisualsOp(s1.sections, { label: "4.", action: "remove", blockId: "v_00000000" }, [], NOW);
      check("op remove: an unknown id is a 404", r404.ok ? null : [r404.status, r404.code], [404, "not_found"]);
      check("op remove: a missing id is a 404", (() => { const r = applyVisualsOp(s1.sections, { label: "4.", action: "remove" }, [], NOW); return r.ok ? null : r.status; })(), 404);
      check("op remove: a block on another section is not reachable", (() => { const r = applyVisualsOp(s1.sections, { label: "1.", action: "remove", blockId: gridId }, [], NOW); return r.ok ? null : r.status; })(), 404);
    }
    const last = applyVisualsOp([mk("4.", [a1.section.blocks![1]])], { label: "4.", action: "remove", blockId: a1.section.blocks![1].id }, [], NOW);
    check("op remove: the last block leaves no blocks key", last.ok && "blocks" in last.section, false);
  }
  const t1 = applyVisualsOp(doc, { label: "1.", action: "onboarding" }, facts, NOW);
  check("op onboarding: the timeline lands", t1.ok && t1.section.blocks?.map((b) => [b.kind, b.origin, b.after]), [["timeline", "onboarding", 1]]);
  for (const action of ["about", "service-stats", "onboarding"] as const) {
    const r = applyVisualsOp(doc, { label: "4.", action }, [], NOW);
    check(`op ${action}: no facts is a 422 with a message, nothing written`, r.ok ? null : [r.status, r.code, r.message.length > 20, r.message.includes("—")], [422, "no_facts", true, false]);
  }
  check("op: the letter is refused", (() => { const r = applyVisualsOp(doc, { label: "__letter", action: "about" }, facts, NOW); return r.ok ? null : [r.status, r.code]; })(), [400, "invalid_request"]);
  check("op: an unknown label is a 404", (() => { const r = applyVisualsOp(doc, { label: "9.", action: "about" }, facts, NOW); return r.ok ? null : [r.status, r.code]; })(), [404, "not_found"]);
  const fullSection = [mk("4.", six.slice(0, 5).map((b) => ({ ...b, after: 1 })))];
  check("op: the per-section cap refuses rather than silently dropping", (() => { const r = applyVisualsOp(fullSection, { label: "4.", action: "about" }, facts, NOW); return r.ok ? null : [r.status, r.code]; })(), [409, "too_many"]);
  yes("op: one more still fits under the cap", applyVisualsOp(fullSection, { label: "4.", action: "service-stats" }, facts, NOW).ok);
  const everything = applyVisualsOp(doc, { label: "4.", action: "about" }, facts, NOW);
  check("op: what it stores reads back untouched", everything.ok && sanitizeStoredBlocks(JSON.parse(JSON.stringify(everything.section.blocks)), 2), everything.ok && everything.section.blocks);
}

console.log(failures === 0 ? "\nall draft-block tests passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
