/**
 * Round-32 cover, letterhead and closing render tests (ARCHITECTURE.md §5.17.20).
 *
 *   npm run test:rfpcoverletter
 *
 * No database, no brain, no network. Pins the RENDER half of the round:
 *   - furniture.ts: cover title (narrative headline, brief only), the cover
 *     lede with its Attention clause and the semibold split, the letterhead's
 *     postal lines, the thesis guard and the closing fallback
 *   - resolve-draft: every new piece is ABSENT when its stored field is, so a
 *     document without them resolves and hashes as before
 *   - the gate over the round-32 fixture (scripts/rfp-render-fixture.ts
 *     buildR32GateInput) and over pricing scenarios: the B series, D1 and no
 *     rule at all fires on the new furniture (the pricing paragraph's figures
 *     are the engine's own, rule B7's sanctioned set)
 *   - one spec: the docx XML and the PDF text both carry the cover headline,
 *     the Attention lede, the postal lines, the pricing paragraph (placed
 *     before the last drafted paragraph), the thesis
 *     and "Confidential"; a model-authored timeline / ledger / three-up cards
 *     reach the emitters as exactly the bodies a system-built one does
 *
 * Round 33 (§5.17.21), thematic parts on brief documents:
 *   - ONE kicker spec: the workspace's secKicker and export-assets'
 *     sectionKicker are furniture.ts sectionKicker itself (21 legacy cases
 *     pinned), and the part-relative variant the files print equals what the
 *     workspace computes through the same documentParts call
 *   - the brief sheet sequence in both files: cover, letter, per part its
 *     divider (title, dek only when stored), the Investment sheet opening
 *     part 4, its sections; an empty part has no divider; a long section's
 *     PDF overflow reads "SECTION 1.3 · CONTINUED"
 *   - a REAL RFP is byte-identical: under a frozen clock the visual
 *     fixture's docx bytes and PDF page texts are pinned to the values the
 *     pre-round-33 emitters (66a5e8e6) produced
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import {
  buildFixtureGateInput,
  buildR32GateInput,
  buildR33GateInput,
  R33_PARTS,
  r32Blocks,
  R32_ADDRESS,
  R32_CLIENT,
  R32_CONTACT,
  R32_HEADLINE,
  R32_THESIS,
} from "./rfp-render-fixture";
import { resolveDraft, runDraftGate } from "../src/lib/rfp/resolve-draft";
import { buildExportView, renderRfpDocx, renderRfpPdf, type ExportVisual } from "../src/lib/rfp/export";
import { FURNITURE_FOOT_RIGHT, loadRfpExportAssets, sectionKicker as assetsSectionKicker } from "../src/lib/rfp/export-assets";
import { resolvedTextSpans } from "../src/lib/rfp/content-model";
import { LETTER_LABEL } from "../src/lib/rfp/letter";
import {
  CLOSING_HEADLINE,
  closingHeadline,
  coverLede,
  coverLedeParts,
  coverTitle,
  FOOT_LEFT_BASE,
  FOOT_LEFT_MAX,
  letterAddresseeLines,
  letterParagraphsWithPricing,
  letterThesis,
  pageFootLeft,
  pricingParagraphIndex,
  recipientAddressLines,
  RFP_COVER_TITLE,
  documentParts,
  sectionKicker,
  sheetKicker,
  submittedByLine,
} from "../src/lib/rfp/furniture";
import { buildQuote, EMPTY_QUOTE_INPUTS, letterPricingParagraph, partPricingDek } from "../src/lib/rfp/quote";
import { serializePartsJson } from "../src/lib/rfp/outline";
import { RATE_CARD } from "../src/lib/rfp/seed/rate-card";
import type { Violation } from "../src/lib/rfp/content-model";
import { COMPANY_SIGNATURE } from "../src/lib/rfp/signature";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `\n     got ${a}\n     want ${e}`}`);
}

// ---- furniture.ts ----------------------------------------------------------------

check(
  "cover title: a brief prints its stored headline",
  coverTitle({ intakeForm: "brief", who: "Acme", proposalHeadline: "  Managed IT for a  Design Studio " }),
  "Managed IT for a Design Studio"
);
check(
  "cover title: a brief with no headline keeps today's title",
  [coverTitle({ intakeForm: "brief", who: "Acme", proposalHeadline: null }), coverTitle({ intakeForm: "brief", who: null, proposalHeadline: "" })],
  ["Proposal for Acme", "Proposal"]
);
check(
  "cover title: a real RFP never takes a headline (rule C4 territory)",
  coverTitle({ intakeForm: "rfp", who: "Acme", proposalHeadline: "Managed IT for Acme" }),
  RFP_COVER_TITLE
);

const noContact = { contactName: null, contactTitle: null };
check(
  "cover lede: no contact is byte-identical to before (rfp composed by the emitters, brief fixed)",
  [coverLede({ intakeForm: "rfp", who: "Acme", ...noContact }), coverLede({ intakeForm: "brief", who: "Acme", ...noContact })],
  [undefined, "Prepared by XL.net for your review."]
);
check(
  "cover lede: Attention clause on an RFP, a brief, a name alone, no client",
  [
    coverLede({ intakeForm: "rfp", who: "Acme", contactName: "Dana Whitfield", contactTitle: "CTO" }),
    coverLede({ intakeForm: "brief", who: "Curioso", contactName: "Mario Dunson", contactTitle: "Studio Manager" }),
    coverLede({ intakeForm: "brief", who: "Curioso", contactName: "Mario Dunson", contactTitle: null }),
    coverLede({ intakeForm: "brief", who: "Acme", contactName: "Pat Lee", contactTitle: "Director, Acme Inc." }),
    coverLede({ intakeForm: "brief", who: null, contactName: "Pat Lee", contactTitle: "CTO" }),
    coverLede({ intakeForm: "rfp", who: null, contactName: "Pat Lee", contactTitle: "CTO" }),
  ],
  [
    "Prepared for Acme, Attention: Dana Whitfield, CTO, in response to the Request for Proposal.",
    "Prepared for Curioso, Attention: Mario Dunson, Studio Manager.",
    "Prepared for Curioso, Attention: Mario Dunson.",
    "Prepared for Acme, Attention: Pat Lee, Director, Acme Inc.",
    "Prepared by XL.net for your review.",
    "Prepared in response to the Request for Proposal, Attention: Pat Lee, CTO.",
  ]
);
check(
  "lede parts: the client stays semibold through the Attention clause; old forms unchanged",
  [
    coverLedeParts("Curioso", "Prepared for Curioso, Attention: Mario Dunson, Studio Manager."),
    coverLedeParts("Acme", undefined),
    coverLedeParts("", undefined),
    coverLedeParts("Acme", "Prepared by XL.net for your review."),
  ],
  [
    { before: "Prepared for ", strong: "Curioso", after: ", Attention: Mario Dunson, Studio Manager." },
    { before: "Prepared for ", strong: "Acme", after: " in response to the Request for Proposal." },
    { before: "Prepared in response to the Request for Proposal.", strong: "", after: "" },
    { before: "Prepared by XL.net for your review.", strong: "", after: "" },
  ]
);
check(
  "address lines: collapsed, empties dropped, names already printed dropped, capped at 5",
  recipientAddressLines(" 1821 W Hubbard  Street, Suite 305\n\nCurioso\nChicago, IL 60622\nM: 773.358.0477\na\nb\nc", [
    "Mario Dunson",
    "Studio Manager",
    "Curioso",
  ]),
  ["1821 W Hubbard Street, Suite 305", "Chicago, IL 60622", "M: 773.358.0477", "a", "b"]
);
check("address lines: none stored, none printed", [recipientAddressLines(null, []), recipientAddressLines("", [])], [[], []]);
check(
  "thesis guard: kept when furniture-shaped, dropped (never repaired) otherwise",
  [
    letterThesis("  Because our fee is flat,  we prevent issues. "),
    letterThesis("We cut tickets 80% in a year."),
    letterThesis("Pay $0 more."),
    letterThesis("A dash \u2014 here."),
    letterThesis(42),
    letterThesis("x".repeat(121)),
    letterThesis(""),
    letterThesis("A dash \u2013 here, en this time."),
    letterThesis("Prevention <beats> repair."),
    letterThesis("Preve\u0301\u0301\u0301ntion pays."),
  ],
  ["Because our fee is flat, we prevent issues.", null, null, null, null, null, null, null, null, null]
);
// Round-32 fixes F7: the letterhead's two-line addressee, the cover's role,
// the running footer's client.
check(
  "addressee lines: name, title beneath, client; none stored is byte-identical",
  [
    letterAddresseeLines({ contactName: "Mario Dunson", contactTitle: "Studio Manager", clientName: "Curioso" }),
    letterAddresseeLines({ contactName: "Mario Dunson", contactTitle: null, clientName: "Curioso" }),
    letterAddresseeLines({ contactName: "Mario Dunson", contactTitle: "Studio Manager", clientName: null }),
    letterAddresseeLines({ contactName: null, contactTitle: "ignored", clientName: " Curioso " }),
    letterAddresseeLines({ contactName: "  ", contactTitle: null, clientName: null }),
  ],
  [["Mario Dunson", "Studio Manager", "Curioso"], ["Mario Dunson", "Curioso"], ["Mario Dunson", "Studio Manager"], ["Curioso"], ["the client"]]
);
check(
  "submitted-by line: the signer with the signature's role, the name alone without one",
  [submittedByLine("Adam Radulovic", "CEO"), submittedByLine("Pat Lee", ""), submittedByLine("Pat Lee", null)],
  ["Adam Radulovic, CEO", "Pat Lee", "Pat Lee"]
);
check(
  "page foot: the base extended with for <who>; the base alone with no one named",
  [pageFootLeft("Curioso"), pageFootLeft(null), pageFootLeft("  ")],
  [`${FOOT_LEFT_BASE} for Curioso`, FOOT_LEFT_BASE, FOOT_LEFT_BASE]
);
check(
  "page foot: a name that would pass FOOT_LEFT_MAX drops to the base (never cut, never under Confidential)",
  [
    pageFootLeft("Larkmoor Valley Housing Cooperative"),
    pageFootLeft("The Greater Metropolitan Consolidated Housing Authority of Larkmoor Valley"),
    pageFootLeft("x".repeat(FOOT_LEFT_MAX - `${FOOT_LEFT_BASE} for `.length)).length,
  ],
  [
    `${FOOT_LEFT_BASE} for Larkmoor Valley Housing Cooperative`,
    FOOT_LEFT_BASE,
    FOOT_LEFT_MAX,
  ]
);
check(
  "pricing placement: before the LAST drafted paragraph with 2 or more, after the body with fewer",
  [
    [0, 1, 2, 4].map(pricingParagraphIndex),
    letterParagraphsWithPricing([], "P"),
    letterParagraphsWithPricing(["a"], "P"),
    letterParagraphsWithPricing(["a", "b"], "P"),
    letterParagraphsWithPricing(["a", "b", "c", "d"], "P"),
    letterParagraphsWithPricing(["a", "b"], null),
  ],
  [[0, 1, 1, 3], ["P"], ["a", "P"], ["a", "P", "b"], ["a", "b", "c", "P", "d"], ["a", "b"]]
);
check(
  "closing: the thesis, else the flat-fee line",
  [closingHeadline(R32_THESIS), closingHeadline(undefined), closingHeadline("Two 2s")],
  [R32_THESIS, CLOSING_HEADLINE, CLOSING_HEADLINE]
);

// ---- resolve-draft: absent fields stay absent ------------------------------------

{
  // The visual fixture with NO quote and no round-32 field: the letter, the
  // cover and the back cover carry no new key.
  const plain = resolveDraft(buildFixtureGateInput(undefined, { quote: null })).resolved;
  check(
    "absent: letter keys, cover lede, back-cover subhead are exactly the pre-round set",
    [Object.keys(plain.letter).sort(), "lede" in plain.cover, plain.backCover.subhead],
    [["addressee", "body", "closing", "dateLabel", "salutation", "signature"], false, null]
  );
  const view = buildExportView(plain, RATE_CARD);
  check(
    "absent: the view prints no address, no pricing paragraph, the flat-fee closing",
    [view.letter.address, view.letter.pricingParagraph, view.closing.headline, view.coverTitle],
    [[], null, CLOSING_HEADLINE, RFP_COVER_TITLE]
  );
}

// ---- the round-32 fixture: resolved furniture ------------------------------------

const r32Input = buildR32GateInput();
const r32 = resolveDraft(r32Input).resolved;
const r32View = buildExportView(r32, RATE_CARD);
const R32_PRICING =
  "The pricing is straightforward: 60 fully managed users at $247 per user per month, $14,820 per month in total. Onboarding is a one-time fee of $14,820.";
const R32_LEDE = `Prepared for ${R32_CLIENT}, Attention: ${R32_CONTACT.name}, ${R32_CONTACT.title}.`;
check("r32: the narrative headline is the cover title", r32.cover.title, R32_HEADLINE);
check("r32: the lede carries the Attention clause", r32.cover.lede, R32_LEDE);
check(
  "r32: the recipient block (name, title beneath, client, then the postal lines)",
  [r32.letter.addressee, r32.letter.address, r32.letter.salutation],
  [[R32_CONTACT.name, R32_CONTACT.title, R32_CLIENT], R32_ADDRESS, `Dear ${R32_CONTACT.name},`]
);
check("r32: the system pricing paragraph", r32.letter.pricingParagraph, R32_PRICING);
check(
  "r32: the pricing paragraph is never part of the drafted body",
  r32.letter.body.some((p) => p.includes("$")),
  false
);
check("r32: the thesis is the closing's big line", [r32.backCover.subhead, r32View.closing.headline], [R32_THESIS, R32_THESIS]);
check(
  "r32: the submitted-by columns read XL.net Inc. and the letter's signer",
  [r32View.preparedBy, r32View.contactEmail],
  [r32.letter.signature.name, r32.letter.signature.email]
);
const R32_SUBMITTED = submittedByLine(r32.letter.signature.name, r32.letter.signature.title);
const R32_FOOT = pageFootLeft(r32View.clientName);
check("r32: the signer carries the role the signature prints", [R32_SUBMITTED, R32_FOOT], ["Adam Radulovic, CEO", `${FOOT_LEFT_BASE} for ${R32_CLIENT}`]);

// ---- the gate: nothing fires on the new furniture --------------------------------

const NEW_FIELDS = /^(?:address\[\d+\]|pricingParagraph|lede|title|subhead)$/;
function gateReport(label: string, input: ReturnType<typeof buildR32GateInput>) {
  const gate = runDraftGate(input);
  const all: Violation[] = gate.violations;
  check(`${label}: no B-series violation`, all.filter((v) => v.ruleId.startsWith("B")).map((v) => `${v.ruleId} ${v.message}`), []);
  check(`${label}: no D1 (em dash)`, all.filter((v) => v.ruleId === "D1").map((v) => v.message), []);
  check(
    `${label}: no finding located on the round-32 furniture`,
    all
      .filter((v) => !v.locator.sectionId && !v.locator.blockId && typeof v.locator.field === "string" && NEW_FIELDS.test(v.locator.field))
      .map((v) => `${v.ruleId} ${v.locator.field}`),
    []
  );
  return gate;
}
{
  const gate = gateReport("r32 fixture", r32Input);
  check(
    "r32 fixture: no blocking finding at all",
    gate.violations.filter((v) => v.severity === "block").map((v) => `${v.ruleId} ${v.message}`),
    []
  );
}
for (const [label, over] of [
  ["minimum", { fullyManagedUsers: 10 }],
  ["paid add-ons + datto + scanning", { fullyManagedUsers: 40, securePlusComputers: 40, dattoRetention: "1yr" as const, vulnScanSessionsPerYear: 2 }],
  ["two views (B4)", { fullyManagedUsers: 20, statesHeadcountOnly: true, m365OnlyUsers: 5 }],
] as const) {
  const quote = buildQuote(
    RATE_CARD,
    { ...EMPTY_QUOTE_INPUTS, securePlusComputers: 0, dattoRetention: "none", vulnScanSessionsPerYear: 0, includeOnboarding: true, ...over },
    "p_r32"
  ).quote;
  const input = buildR32GateInput({
    quote,
    statesHeadcountOnly: "statesHeadcountOnly" in over,
    supportedUserSplitConfirmed: !("statesHeadcountOnly" in over),
  });
  check(`${label}: the paragraph is present and is the helper's`, resolveDraft(input).resolved.letter.pricingParagraph, letterPricingParagraph(quote, RATE_CARD.minimumFullyManagedUsers));
  gateReport(`${label}`, input);
}

// ---- render parity: model-authored kinds reach the emitters as system ones -------

{
  const blocks = r32Blocks();
  // The block minus its BlockBase envelope (id, place, cites, provenance):
  // what an emitter actually draws.
  const ENVELOPE = new Set(["id", "sectionId", "ordinal", "cites", "generatedBy", "editedByHuman"]);
  const bodyOf = (b: ExportVisual) =>
    Object.fromEntries(Object.entries(b).filter(([k]) => !ENVELOPE.has(k)));
  const flowBlocks = (input: ReturnType<typeof buildR32GateInput>) =>
    buildExportView(resolveDraft(input).resolved, RATE_CARD)
      .sections.flatMap((s) => s.flow)
      .flatMap((f) => (f.type === "block" ? [f.block] : []));
  const asSystem = buildR32GateInput();
  asSystem.sections = asSystem.sections.map((s) => ({
    ...s,
    blocks: s.blocks?.map((b) => ({ ...b, generatedBy: "system" as const })),
  }));
  check(
    "parity: model-authored timeline / ledger / cards / callout bodies equal their system-built twins",
    flowBlocks(r32Input).map(bodyOf),
    flowBlocks(asSystem).map(bodyOf)
  );
  check(
    "parity: the fixture carries a model timeline, a ledger, three-up cards and an editorial callout",
    flowBlocks(r32Input).map((b) => (b.kind === "cards" ? `cards:${b.cards.length}` : b.kind)),
    ["timeline", "callout", "cards:3", "fact-grid", "timeline"]
  );
  check("parity: the editorial callout keeps its title", blocks.criticalCallout.kind === "callout" ? blocks.criticalCallout.title : null, "Critical issues skip the queue");
}

// ---- one spec: both files carry the furniture ------------------------------------

async function docxText(view: typeof r32View): Promise<string> {
  const zip = await JSZip.loadAsync(await renderRfpDocx(view));
  const parts = await Promise.all(
    Object.keys(zip.files)
      .filter((n) => /^word\/(?:document|footer\d*)\.xml$/.test(n))
      .map((n) => zip.file(n)!.async("string"))
  );
  // Text runs only, joined: a paragraph's runs read as one string.
  return parts
    .join("\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}
async function pdfText(view: typeof r32View): Promise<{ pages: string[] }> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await getDocument({ data: new Uint8Array(await renderRfpPdf(view)), disableFontFace: true, useSystemFonts: false }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    pages.push(
      content.items
        .map((it) => ("str" in it ? it.str + (it.hasEOL ? " " : "") : ""))
        .join("")
        .replace(/\s+/g, " ")
    );
  }
  return { pages };
}
const squash = (s: string) => s.replace(/\s+/g, " ").toLowerCase();
/** Each PDF page's text items (one per drawn line), for line checks. */
async function pdfItems(view: typeof r32View): Promise<{ str: string; y: number }[][]> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await getDocument({ data: new Uint8Array(await renderRfpPdf(view)), disableFontFace: true, useSystemFonts: false }).promise;
  const pages: { str: string; y: number }[][] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    pages.push(content.items.flatMap((it) => ("str" in it ? [{ str: it.str, y: it.transform[5] as number }] : [])));
  }
  return pages;
}
/** A docx's images in DOCUMENT order, each as a hash of the bytes its
 *  r:embed resolves to (rels Id -> Target -> media file). Names and ids
 *  are process-counter noise; the bytes are what a reader sees. */
async function docxEmbeds(buf: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(buf);
  const rels = await zip.file("word/_rels/document.xml.rels")!.async("string");
  const target = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[0])?.[1];
    const t = /\bTarget="([^"]+)"/.exec(m[0])?.[1];
    if (id && t) target.set(id, t);
  }
  const xml = await zip.file("word/document.xml")!.async("string");
  const out: string[] = [];
  for (const m of xml.matchAll(/r:embed="([^"]+)"/g)) {
    const t = target.get(m[1]!);
    const f = t ? zip.file(`word/${t.replace(/^\/?word\//, "")}`) : null;
    out.push(f ? sha256(await f.async("nodebuffer")).slice(0, 16) : `missing:${m[1]}`);
  }
  return out;
}
/** Every media file's bytes, hashed, sorted (the set a reader can see). */
async function docxMediaSet(buf: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  const names = Object.keys(zip.files).filter((n) => n.startsWith("word/media/") && !zip.files[n]!.dir);
  const hashes = await Promise.all(names.map(async (n) => sha256(await zip.file(n)!.async("nodebuffer"))));
  return sha256(hashes.sort().join("\n"));
}

// ---- round 33: ONE kicker spec (§5.17.21) ---------------------------------------

check("kicker: export-assets' sectionKicker IS furniture's (one function, no replica)", assetsSectionKicker === sectionKicker, true);
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  const ws = readFileSync(path.resolve(here, "..", "src/app/rfp/r/[id]/workspace.tsx"), "utf8");
  check(
    "kicker: the workspace's secKicker is furniture's sectionKicker, and no local copy of the rule remains",
    [ws.includes("const secKicker = sectionKicker;"), ws.includes("M{0,4}(CM|CD|D?C{0,3})")],
    [true, false]
  );
}
// The 21 legacy cases: every real-RFP kicker byte-identical to the rule
// both surfaces ran before round 33.
const LEGACY_KICKERS: [string, string][] = [
  ["8", "Section 8"],
  ["3.1", "Section 3.1"],
  ["IV", "Section IV"],
  ["III", "Section III"],
  ["VII", "Section VII"],
  ["F.", "Section F."],
  ["4.2", "Section 4.2"],
  ["A", "Section A"],
  ["June 8th, 2026:", "June 8th, 2026:"],
  ["June 19 2026:", "June 19 2026:"],
  ["Current IT Provider Issues (Entiva)", "Current IT Provider Issues (Entiva)"],
  ["Next Steps", "Next Steps"],
  ["Section 4", "Section 4"],
  ["mix III words", "mix III words"],
  ["", "Section"],
  ["   ", "Section"],
  ["MMMM", "Section MMMM"],
  ["IIX", "IIX"],
  ["1", "Section 1"],
  ["10", "Section 10"],
  [" 2.4 ", "Section 2.4"],
];
check(
  "kicker: 21 legacy cases, and sheetKicker without parts is sectionKicker",
  LEGACY_KICKERS.map(([l]) => [sectionKicker(l), sheetKicker(l, null)]),
  LEGACY_KICKERS.map(([, k]) => [k, k])
);

// ---- round 33: the part resolution every surface shares -------------------------

const R33_KICKERS: Record<string, string> = {
  "1": "Section 1.1",
  "2": "Section 1.2",
  "3": "Section 1.3",
  "7": "Section 1.4",
  "10": "Section 1.5",
  "4": "Section 2.1",
  "5": "Section 2.2",
  "6": "Section 3.1",
  // The Investment sheet is part 4's first numbered sheet ("Section 4.1").
  "8": "Section 4.2",
};
/** The omit-3 twin: part 4 renders THIRD, so it prints "03" and "Section
 *  3.x" (display position, round 33 F5). */
const R33_OMIT_KICKERS: Record<string, string> = { ...R33_KICKERS, "8": "Section 3.2" };
/** The system-composed pricing dek both r33 documents print on the
 *  pricing part's divider (quote.ts partPricingDek, F7). */
const R33_PRICING_DEK =
  "60 fully managed users at $247 per user per month, $14,820 per month in total, itemized on the Investment page.";
/** What the workspace doc pane computes (workspace.tsx docParts): the same
 *  documentParts call over the stored sections less the letter, with the
 *  same pricing dek call. */
function workspaceParts(input: ReturnType<typeof buildR33GateInput>) {
  return documentParts({
    intakeForm: input.doc.intakeForm,
    structure: input.structure,
    drafted: input.sections.filter((s) => s.label !== LETTER_LABEL),
    partsJson: input.proposal.partsJson,
    pricingPresent: input.quote !== null,
    pricingDek: partPricingDek(input.quote, RATE_CARD.minimumFullyManagedUsers),
  });
}
const r33Input = buildR33GateInput();
const r33 = resolveDraft(r33Input).resolved;
const r33View = buildExportView(r33, RATE_CARD);
const r33OmitInput = buildR33GateInput({ omitPart3: true });
const r33OmitView = buildExportView(resolveDraft(r33OmitInput).resolved, RATE_CARD);
{
  check(
    "parts: the four parts, stored titles and deks (part 4: the system pricing dek), pricing in part 4",
    r33View.parts?.map((p) => [p.n, p.title, p.dek, p.labels, p.holdsPricing, p.position, p.pricingKicker]),
    R33_PARTS.map((p) => [p.n, p.title, p.n === 4 ? R33_PRICING_DEK : p.dek, ({ 1: ["1", "2", "3", "7", "10"], 2: ["4", "5"], 3: ["6"], 4: ["8"] } as Record<number, string[]>)[p.n], p.n === 4, p.n, p.n === 4 ? "Section 4.1" : null])
  );
  check("F7: the pricing dek is the helper's, one sentence, whole dollars, no term", [partPricingDek(r33Input.quote, RATE_CARD.minimumFullyManagedUsers), /month to month|notice|90-day|revolving/i.test(R33_PRICING_DEK), /\.00\b/.test(R33_PRICING_DEK), R33_PRICING_DEK.split(/[.!?](?:\s|$)/).filter(Boolean).length], [R33_PRICING_DEK, false, false, 1]);
  check("F7: the stored part-4 dek is kept as the fallback (no quote, section 8 drafted)", buildExportView(resolveDraft(buildR33GateInput({}, { quote: null })).resolved, RATE_CARD).parts?.find((p) => p.n === 4)?.dek, R33_PARTS[3]!.dek);
  // F7 across the quote shapes: one sentence, every figure the engine's
  // (the gate's B7 scans part spans), never a term.
  for (const [label, over] of [
    ["minimum", { fullyManagedUsers: 10 }],
    ["paid add-ons", { fullyManagedUsers: 40, securePlusComputers: 40, dattoRetention: "1yr" as const, vulnScanSessionsPerYear: 2 }],
    ["two views (B4)", { fullyManagedUsers: 20, statesHeadcountOnly: true, m365OnlyUsers: 5 }],
  ] as const) {
    const quote = buildQuote(
      RATE_CARD,
      { ...EMPTY_QUOTE_INPUTS, securePlusComputers: 0, dattoRetention: "none", vulnScanSessionsPerYear: 0, includeOnboarding: true, ...over },
      "p_r33"
    ).quote;
    const input = buildR33GateInput({}, { quote, statesHeadcountOnly: "statesHeadcountOnly" in over, supportedUserSplitConfirmed: !("statesHeadcountOnly" in over) });
    const dek = resolveDraft(input).resolved.parts?.find((p) => p.holdsPricing)?.dek ?? null;
    const shape =
      label === "minimum"
        ? /^Up to 15 fully managed users at the monthly minimum, \$[\d,]+ per month in total, itemized on the Investment page\.$/
        : label === "two views (B4)"
          ? /^Priced two ways, \$[\d,]+(?:\.\d\d)? or \$[\d,]+(?:\.\d\d)? per month, until the real split of users is confirmed\.$/
          : /^40 fully managed users at \$247 per user per month, \$[\d,]+ per month in total, itemized on the Investment page\.$/;
    check(`F7 ${label}: the pricing part's dek is the helper's sentence`, [dek === partPricingDek(quote, RATE_CARD.minimumFullyManagedUsers), shape.test(dek ?? ""), (dek ?? "").length <= 160], [true, true, true]);
    check(`F7 ${label}: no B7 (or any) finding on the part spans`, runDraftGate(input).violations.filter((v) => v.ruleId === "B7" || /^part\[/.test(String(v.locator.field ?? ""))).map((v) => `${v.ruleId} ${v.message}`), []);
  }
  check("F7: no quote, nothing to state", partPricingDek(null, 15), null);
  check(
    "parts: the files' kickers are part-relative (labels untouched)",
    r33View.sections.map((s) => [s.label, s.kicker]),
    r33View.sections.map((s) => [s.label, R33_KICKERS[s.label]])
  );
  const ws = workspaceParts(r33Input);
  check(
    "parts: the workspace's kicker for every drafted sheet equals the files' (one spec)",
    r33View.sections.map((s) => sheetKicker(s.label, ws)),
    r33View.sections.map((s) => s.kicker)
  );
  check(
    "parts: the workspace resolves the same parts the files print",
    ws?.parts.map((p) => [p.n, p.title, p.dek, p.labels]),
    r33View.parts?.map((p) => [p.n, p.title, p.dek, p.labels])
  );
  check(
    "parts: an empty part is omitted (section 6 removed: no part 3), an unstored dek is null",
    r33OmitView.parts?.map((p) => [p.n, p.dek === null]),
    [[1, false], [2, true], [4, false]]
  );
  check(
    "parts: an omitted part leaves no gap: the pricing part prints 3 (Section 3.1 Investment, 8 is 3.2)",
    [r33OmitView.sections.map((s) => s.kicker), r33OmitView.parts?.map((p) => [p.n, p.position, p.pricingKicker])],
    [r33OmitView.sections.map((s) => R33_OMIT_KICKERS[s.label]), [[1, 1, null], [2, 2, null], [4, 3, "Section 3.1"]]]
  );
  check(
    "parts: no parts_json renders the static titles, no deks",
    buildExportView(resolveDraft(buildR33GateInput({}, { proposal: { ...r33Input.proposal, partsJson: null } })).resolved, RATE_CARD).parts?.map((p) => [p.title, p.dek]),
    [["How We Support You", null], ["Security and Infrastructure", null], ["Onboarding and Transition", null], ["Pricing and Agreement Terms", R33_PRICING_DEK]]
  );
  // S4: stale overrides.
  check(
    "S4: a stored dek naming a figure the part's CURRENT text no longer states reads null at render (screen too)",
    (() => {
      const stale = serializePartsJson([...R33_PARTS.slice(0, 2), { n: 3, title: "Your First Months With Us", dek: "Onboarding day is December 11, 2026, with the whole studio." }, R33_PARTS[3]!]);
      const input = buildR33GateInput({}, { proposal: { ...r33Input.proposal, partsJson: stale } });
      const withDate = buildR33GateInput({}, {
        proposal: { ...r33Input.proposal, partsJson: stale },
        sections: r33Input.sections.map((s) => (s.label === "6" ? { ...s, paragraphs: [...s.paragraphs, "Onboarding day is December 11, 2026."] } : s)),
      });
      return [
        resolveDraft(input).resolved.parts?.find((p) => p.n === 3)?.dek,
        workspaceParts(input)?.parts.find((p) => p.n === 3)?.dek,
        resolveDraft(withDate).resolved.parts?.find((p) => p.n === 3)?.dek,
      ];
    })(),
    [null, null, "Onboarding day is December 11, 2026, with the whole studio."]
  );
  check(
    "S4: a pricing-only part 4 ignores its stored title (and prints the pricing dek)",
    buildExportView(resolveDraft(buildR33GateInput({}, {
      proposal: { ...r33Input.proposal, partsJson: serializePartsJson([...R33_PARTS.slice(0, 3), { n: 4, title: "Old Part Four", dek: "A stale dek from before." }]) },
      sections: r33Input.sections.filter((s) => s.label !== "8"),
    })).resolved, RATE_CARD).parts?.find((p) => p.n === 4),
    { n: 4, title: "Pricing and Agreement Terms", dek: R33_PRICING_DEK, labels: [], holdsPricing: true, position: 4, pricingKicker: "Section 4.1" }
  );
  {
    const ws = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src/app/rfp/r/[id]/workspace.tsx"), "utf8");
    check(
      "workspace: the doc pane passes the same pricing dek, numerals by position, the file's Investment kicker, full-width part titles",
      [ws.includes("pricingDek: partPricingDek(pricing, minimumUsers),"), ws.includes("num={partNumeral(sheet.num)}"), ws.includes('kicker: inFile?.pricingKicker ?? "Pricing"'), ws.includes("<div className=\"rfpdoc-kicker\">{sheet.kicker}</div>"), ws.includes("fullWidthTitle\n")],
      [true, true, true, true, true]
    );
  }
  check(
    "parts: a brief with no quote and section 8 undrafted has no part 4",
    buildExportView(
      resolveDraft(buildR33GateInput({}, { quote: null, sections: r33Input.sections.filter((s) => s.label !== "8") })).resolved,
      RATE_CARD
    ).parts?.map((p) => p.n),
    [1, 2, 3]
  );
  check(
    "parts: the part titles and deks are in the gate's scan surface",
    resolvedTextSpans(r33).filter((sp) => sp.location === "parts").length,
    8
  );
  const gate = runDraftGate(r33Input);
  check("parts: the r33 fixture has no blocking finding", gate.violations.filter((v) => v.severity === "block").map((v) => `${v.ruleId} ${v.message}`), []);
  // A real RFP: no parts anywhere.
  const rfp = resolveDraft(buildFixtureGateInput()).resolved;
  const rfpView = buildExportView(rfp, RATE_CARD);
  check(
    "real RFP: no parts key on the resolved proposal, null on the view, label kickers, no part spans",
    ["parts" in rfp, rfpView.parts, rfpView.sections.every((s) => s.kicker === sectionKicker(s.label)), resolvedTextSpans(rfp).some((sp) => sp.location === "parts")],
    [false, null, true, false]
  );
}

/** Render under a frozen clock (the date label, the PDF's CreationDate, the
 *  docx core dates and zip entry times all read it), restored after. */
async function withFrozenClock<T>(fn: () => Promise<T>): Promise<T> {
  const RealDate = Date;
  const FIXED = RealDate.UTC(2026, 9, 16, 12, 0, 0);
  class FrozenDate extends RealDate {
    constructor(...a: unknown[]) {
      if (a.length === 0) super(FIXED);
      else super(...(a as [string]));
    }
    static now() {
      return FIXED;
    }
  }
  (globalThis as { Date: DateConstructor }).Date = FrozenDate as unknown as DateConstructor;
  try {
    return await fn();
  } finally {
    (globalThis as { Date: DateConstructor }).Date = RealDate;
  }
}
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
/** The REAL-RFP fixture's Word XML (document, footers, styles, numbering)
 *  under the frozen clock, with the ids docx numbers from process-wide
 *  counters blanked (a test that rendered other documents first shifts
 *  them; the raw bytes are equal only in a fresh process). Round 33 proved
 *  the RAW docx and PDF bytes of this fixture equal to the pre-round-33
 *  emitters' (66a5e8e6) by rendering both trees in fresh processes; this pin
 *  keeps that true. A change here means a real RFP's file changed: re-pin
 *  only after proving the change is intended (a docx upgrade, a deliberate
 *  design change). */
const RFP_DOCX_XML_SHA256 = "d28b22242b330c3fc9844915adbb13bebeee2daee16377e808222c3dc9ee5964";
/** The same fixture's PDF page count and its page texts' hash. */
const RFP_PDF_PAGES = 14;
const RFP_PDF_TEXT_SHA256 = "24ae08520975dbaabfcd2f1689c8b1299a44482f324ae25b939a277db4d9a6ff";
/** The same fixture's docx images in document order (each r:embed resolved
 *  through the rels to its media bytes) and its media set, both computed
 *  from 66a5e8e6's emitters (round-33 fix S5). */
const RFP_DOCX_EMBEDS_SHA256 = "e3ba42153d8f92bff04d155755c2c678df3ff6e5461fb2e982bfc6e05ea8f997";
const RFP_DOCX_MEDIA_SHA256 = "b0c00797a4a7b62d27c1706f97ee744bd189af2f27a9b1c60b0376f3af054855";

/** The last line of the signature block (its last article title). */
const R32_SIG_LAST = COMPANY_SIGNATURE.articles[COMPANY_SIGNATURE.articles.length - 1]?.title ?? COMPANY_SIGNATURE.name;
/** The fixture PDF's page count, pinned so a layout change that adds a page
 *  shows here. 10 = cover, letter (two pages: see the F2 note in §5.17.20),
 *  divider, sections, investment divider and sheet, closing. */
const R32_PDF_PAGES = 10;

async function main() {
  const docx = squash(await docxText(r32View));
  const { pages } = await pdfText(r32View);
  const pdf = squash(pages.join(" "));
  const must = [
    R32_HEADLINE,
    R32_LEDE,
    ...R32_ADDRESS,
    R32_PRICING,
    R32_THESIS,
    "Managed IT Services Proposal",
    "Submitted by",
    R32_SUBMITTED,
    R32_FOOT,
    FURNITURE_FOOT_RIGHT,
  ];
  check("docx carries every piece of round-32 furniture", must.filter((m) => !docx.includes(squash(m))), []);
  // pdfkit's letterspaced caps extract one glyph at a time ("C O N F I D E N
  // T I A L"), so the PDF is compared with all whitespace removed.
  const bare = (s: string) => s.replace(/\s+/g, "").toLowerCase();
  const pdfBare = bare(pdf);
  check("pdf carries every piece of round-32 furniture", must.filter((m) => !pdfBare.includes(bare(m))), []);
  check(
    "pdf: Confidential on every page",
    pages.filter((p) => !bare(p).includes("confidential")).length,
    0
  );
  check(
    "pdf: the running footer names the client on every page (F7)",
    pages.filter((p) => !bare(p).includes(bare(R32_FOOT))).length,
    0
  );
  // F2: the signature block asks for its MEASURED height, never a fixed
  // 180pt: it is always whole on one page, and a letter that fits with the
  // block's real height stays on one page.
  const letterSpan = (ps: string[]) => {
    const dear = ps.findIndex((p) => squash(p).includes(squash(`Dear ${R32_CONTACT.name},`)));
    const regards = ps.findIndex((p, i) => i >= dear && squash(p).includes("regards,"));
    const last = ps.findIndex((p, i) => i >= dear && bare(p).includes(bare(R32_SIG_LAST)));
    return { dear, regards, last };
  };
  const full = letterSpan(pages);
  check("pdf: the signature block is never split (Regards and its last line on one page)", [full.dear >= 0, full.last - full.regards], [true, 0]);
  check("pdf: total page count pinned (fixture)", pages.length, R32_PDF_PAGES);
  {
    // The same letter with a two-line postal block sits where the old fixed
    // 180pt reserve broke the page and the measured block does not.
    const shorter = buildExportView(
      resolveDraft(buildR32GateInput({ doc: { ...r32Input.doc, clientAddress: R32_ADDRESS.slice(0, 2).join("\n") } })).resolved,
      RATE_CARD
    );
    const span = letterSpan((await pdfText(shorter)).pages);
    check("pdf: a letter that fits by its measured signature height is ONE page (F2)", [span.dear >= 0, span.regards - span.dear, span.last - span.dear], [true, 0, 0]);
  }
  // The letterhead: the text just above the salutation (the cover's
  // Attention lede also names the contact, so the search is scoped).
  const letterhead = (t: string) => {
    const dear = t.indexOf(squash(`Dear ${R32_CONTACT.name},`));
    return dear < 0 ? "" : t.slice(t.lastIndexOf(squash(r32.letter.dateLabel), dear), dear);
  };
  check(
    "docx + pdf: name, then the title on its own line, then the client, then the postal lines (F7)",
    [docx, pdf].map((t) => {
      const head = letterhead(t);
      const name = head.indexOf(squash(R32_CONTACT.name));
      const title = head.indexOf(squash(R32_CONTACT.title), name);
      const client = head.indexOf(squash(R32_CLIENT), title);
      const first = head.indexOf(squash(R32_ADDRESS[0]), client);
      return name >= 0 && name < title && title < client && client < first && !head.includes(squash(`${R32_CONTACT.name}, ${R32_CONTACT.title}`));
    }),
    [true, true]
  );
  check(
    "one spec: the pricing paragraph sits after the next-to-last drafted paragraph and before the last, in both files",
    [docx, pdf].map((t) => {
      const n = r32.letter.body.length;
      const before = t.indexOf(squash(r32.letter.body[n - 2]));
      const price = t.indexOf(squash(R32_PRICING));
      const last = t.indexOf(squash(r32.letter.body[n - 1]));
      const regards = t.indexOf("regards,");
      return before >= 0 && before < price && price < last && last < regards;
    }),
    [true, true]
  );
  check(
    "one spec: the thesis is the closing sheet's line (last page of the pdf)",
    squash(pages[pages.length - 1]).includes(squash(R32_THESIS)),
    true
  );

  // ---- round 33: the brief sheet sequence, both files ---------------------------
  {
    const { pages: p33 } = await pdfText(r33View);
    const bp = p33.map(bare);
    const at = (needle: string, from = 0) => bp.findIndex((p, i) => i >= from && p.includes(bare(needle)));
    const divider = (n: number) => {
      const part = r33View.parts!.find((p) => p.n === n)!;
      return at(`0${part.position}${part.title}`);
    };
    const d = [1, 2, 3, 4].map(divider);
    const sec = (label: string) => at(`${R33_KICKERS[label]}${r33View.sections.find((s) => s.label === label)!.title}`);
    // F3: the Investment sheet is part 4's first numbered sheet.
    const investment = at("Section 4.1Investment");
    check(
      "pdf: cover, letter, then each part's divider before its sections, Investment opening part 4",
      [
        d.every((x, i) => x > 0 && (i === 0 || x > d[i - 1]!)),
        [sec("1"), sec("2"), sec("3"), sec("7"), sec("10")].every((x) => x > d[0]! && x < d[1]!),
        [sec("4"), sec("5")].every((x) => x > d[1]! && x < d[2]!),
        sec("6") > d[2]! && sec("6") < d[3]!,
        d[3]! < investment && investment < sec("8"),
        sec("8") < p33.length - 1,
      ],
      [true, true, true, true, true, true]
    );
    check(
      "pdf: each divider prints its stored dek; the pricing part prints the system pricing dek instead",
      [...R33_PARTS.map((p) => bp[divider(p.n)]?.includes(bare(p.n === 4 ? R33_PRICING_DEK : p.dek)) ?? false), bp.some((p) => p.includes(bare(R33_PARTS[3]!.dek)))],
      [true, true, true, true, false]
    );
    check("pdf: no Investment sheet keeps the legacy Pricing kicker on a brief", bp.some((p) => p.includes(bare("PricingInvestment"))), false);
    // F2: a part title runs the full content width ("Pricing and Agreement
    // Terms" on one line; it wrapped at the legacy 86% measure).
    {
      const items = await pdfItems(r33View);
      const page = items[divider(4)] ?? [];
      check("pdf F2: the part-4 divider title is ONE line at full width", page.some((it) => it.str.trim() === "Pricing and Agreement Terms"), true);
    }
    check(
      "pdf: the long section overflows onto a SECTION 1.3 · CONTINUED page, and no sheet prints a bare label kicker",
      [bp.some((p) => p.includes(bare("SECTION 1.3 · CONTINUED"))), bp.some((p) => /section\d+(?![.\d])/.test(p))],
      [true, false]
    );
    check("pdf: no legacy brief divider (The Proposal / 02 Investment)", [bp.some((p) => p.includes(bare("01The Proposal"))), bp.some((p) => p.includes(bare("02Investment")))], [false, false]);

    const { pages: pOmit } = await pdfText(r33OmitView);
    const bo = pOmit.map(bare);
    const p2 = r33OmitView.parts!.find((p) => p.n === 2)!;
    check(
      "pdf (omit) F5: no part 3 divider; the pricing part prints 03 (positional), Section 3.1 Investment, Section 3.2 Agreement Terms; 16 pages",
      [
        bo.some((p) => p.includes(bare(R33_PARTS[2]!.title))),
        bo.some((p) => p.includes(bare(`01${R33_PARTS[0]!.title}`))),
        bo.some((p) => p.includes(bare(`02${p2.title}`))),
        bo.some((p) => p.includes(bare(`03${R33_PARTS[3]!.title}`))),
        bo.some((p) => p.includes(bare(`04${R33_PARTS[3]!.title}`))),
        bo.some((p) => p.includes(bare("Section 3.1Investment"))),
        bo.some((p) => p.includes(bare("Section 3.2Agreement Terms"))),
        pOmit.length,
      ],
      [false, true, true, true, false, true, true, 16]
    );
    check(
      "pdf (omit): part 2's divider has no dek line (only its runner, numeral, title and footer)",
      bo.find((p) => p.includes(bare(`02${p2.title}`)))?.replace(bare(`02${p2.title}`), "").replace(bare(`XL.net · Proposal for ${R32_CLIENT}`), "").replace(bare(R32_FOOT), "").replace("confidential", ""),
      ""
    );

    const dx = squash(await docxText(r33View));
    const order = [
      ...R33_PARTS.flatMap((p) => [squash(p.title), squash(p.n === 4 ? R33_PRICING_DEK : p.dek)]),
    ];
    const idx = (t: string, from = 0) => dx.indexOf(t, from);
    // From the END of the pricing dek (it says "the Investment page" itself).
    const iDiv4 = idx(squash(R33_PRICING_DEK)) + R33_PRICING_DEK.length;
    check(
      "docx: the four dividers (title then dek) in order, Section 4.1 Investment opening part 4 before Section 4.2",
      [
        order.every((t, i) => idx(t) >= 0 && (i === 0 || idx(t) > idx(order[i - 1]!))),
        idx(squash("Section 4.1"), iDiv4) > iDiv4 && idx(squash("Section 4.1"), iDiv4) < idx("investment", iDiv4) && idx("investment", iDiv4) < idx(squash("Section 4.2"), iDiv4),
        idx(squash("Section 1.4")) < idx(squash("Section 1.5")) && idx(squash("Section 1.5")) < idx(squash("Section 2.1")),
        dx.includes(squash(R33_PARTS[3]!.dek)),
      ],
      [true, true, true, false]
    );
    const r33Docx = await renderRfpDocx(r33View);
    const docxRels = Object.keys((await JSZip.loadAsync(r33Docx)).files).filter((n) => n.startsWith("word/media/"));
    check("docx: four numeral images (01-04) beside the cover ornaments", docxRels.length >= 4, true);
    {
      // F5 + S5's discipline: which numeral PNG each divider embeds, by its
      // bytes, in document order.
      const assets = loadRfpExportAssets();
      const numHash = [assets.images.num01, assets.images.num02, assets.images.num03, assets.images.num04].map((b) => sha256(b).slice(0, 16));
      const numerals = async (buf: Buffer) =>
        (await docxEmbeds(buf)).map((h) => numHash.indexOf(h)).filter((i) => i >= 0).map((i) => `0${i + 1}`);
      check("docx F5: the numerals by bytes (four parts; omit-3: 01 02 03)", [await numerals(r33Docx), await numerals(await renderRfpDocx(r33OmitView))], [["01", "02", "03", "04"], ["01", "02", "03"]]);
      const xml = await (await JSZip.loadAsync(r33Docx)).file("word/document.xml")!.async("string");
      const titlePar = (t: string) => xml.slice(Math.max(0, xml.lastIndexOf("<w:p>", xml.indexOf(`>${t}<`))), xml.indexOf(`>${t}<`));
      check(
        "docx F2/F4: part titles have no right indent (full width); each part divider holds title + dek in one fixed-minimum-height cell",
        [/w:right="1400"/.test(titlePar("Pricing and Agreement Terms")), (xml.match(/<w:trHeight w:val="4047" w:hRule="atLeast"\/>/g) ?? []).length],
        [false, 4]
      );
    }
  }

  // ---- round 33: a REAL RFP is byte-identical -------------------------------------
  {
    const pinned = await withFrozenClock(async () => {
      const input = buildFixtureGateInput();
      const view = buildExportView(resolveDraft(input).resolved, input.rateCard);
      const zip = await JSZip.loadAsync(await renderRfpDocx(view));
      const names = Object.keys(zip.files)
        .filter((n) => /^word\/(?:document|footer\d*|header\d*|styles|numbering)\.xml$/.test(n))
        .sort();
      const xml = (await Promise.all(names.map((n) => zip.file(n)!.async("string")))).join("\n");
      const docx = xml.replace(/\b(w:id|id|r:id|r:embed|name|w:rsid\w*)="[^"]*"/g, '$1=""');
      const { pages: rp } = await pdfText(view);
      const buf = await renderRfpDocx(view);
      return {
        docx: sha256(docx),
        pages: rp.length,
        text: sha256(rp.join("\n")),
        embeds: sha256((await docxEmbeds(buf)).join("|")),
        media: await docxMediaSet(buf),
      };
    });
    check(
      "real RFP: Word XML, PDF page count and PDF page texts equal the pre-round-33 emitters' (frozen clock)",
      [pinned.docx, pinned.pages, pinned.text],
      [RFP_DOCX_XML_SHA256, RFP_PDF_PAGES, RFP_PDF_TEXT_SHA256]
    );
    // S5: the XML pin blanks r:embed, so it alone cannot see WHICH image a
    // divider shows; these two can (a swapped divider numeral fails here).
    check(
      "real RFP: the docx images in document order (embed -> target -> bytes) and the media set equal 66a5e8e6's",
      [pinned.embeds, pinned.media],
      [RFP_DOCX_EMBEDS_SHA256, RFP_DOCX_MEDIA_SHA256]
    );
  }

  console.log(failures === 0 ? "\nALL COVER/LETTER RENDER TESTS PASSED" : `\n*** ${failures} FAILURE(S) ***`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
