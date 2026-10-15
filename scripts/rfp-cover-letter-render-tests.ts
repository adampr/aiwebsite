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
 */

import JSZip from "jszip";
import {
  buildFixtureGateInput,
  buildR32GateInput,
  r32Blocks,
  R32_ADDRESS,
  R32_CLIENT,
  R32_CONTACT,
  R32_HEADLINE,
  R32_THESIS,
} from "./rfp-render-fixture";
import { resolveDraft, runDraftGate } from "../src/lib/rfp/resolve-draft";
import { buildExportView, renderRfpDocx, renderRfpPdf, type ExportVisual } from "../src/lib/rfp/export";
import { FURNITURE_FOOT_RIGHT } from "../src/lib/rfp/export-assets";
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
  submittedByLine,
} from "../src/lib/rfp/furniture";
import { buildQuote, EMPTY_QUOTE_INPUTS, letterPricingParagraph } from "../src/lib/rfp/quote";
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

  console.log(failures === 0 ? "\nALL COVER/LETTER RENDER TESTS PASSED" : `\n*** ${failures} FAILURE(S) ***`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
