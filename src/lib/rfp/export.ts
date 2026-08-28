// RFP response emitters: one resolved view, two formats (§5.17.1).
//
// Both emitters consume the SAME ResolvedProposal built by resolve-draft, so
// cross-format parity is structural (rule C2's premise): an emitter renders,
// it never decides. Neither does arithmetic — every pricing figure below is
// read from the stored PricingQuote the engine computed, formatted by
// formatMoney, and nothing else in either format prints a currency amount.
//
// FIDELITY (owner directive 2026-08-27): the downloaded file must read as
// the SAME designed document the workspace shows on screen — same page
// sequence (cover → cover letter → divider 01 → one sheet per section →
// divider 02 → investment → navy closing), same ornaments (arc-mark corner
// circles, ghost outline numerals, accent bars, three-square colophon),
// same palette, same faces. The on-screen sheet spec is .rfpdoc in
// globals.css; sizes there are CSS px against a ~648px content box, and both
// emitters map px → pt at the print identity 0.75 (96dpi), so relative
// proportions match the screen exactly.
//
// FONTS: real OFL TTFs of Archivo (500/600/700) and Source Serif 4
// (400/600/italic) are vendored under public/brand/fonts and embedded in
// BOTH formats — pdfkit registers them directly; docx 9.x embeds them via
// the Document `fonts` option, so the .docx carries the faces even on a
// machine with neither installed. The old Georgia/Arial mapping is gone.
//
// PDF pages are buffered so footers and continuation kickers are stamped
// AFTER the content flow ends. Stamping from a `pageAdded` handler mutated
// the live flow state mid-paragraph (font, size, x/y), which silently
// rendered the rest of an auto-paginated section at 8pt — never go back to
// that.
//
// NO DRAFT MARKING, by owner ruling 2026-08-28: the downloaded file never
// says DRAFT or WORKING DRAFT anywhere (no cover line, no corner mark, no
// footer prefix, no -DRAFT filename). What is still outstanding is said in
// the WORKSPACE (the export notice reads the x-rfp-* headers), never in the
// file a prospect might end up holding.

import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  HeightRule,
  HorizontalPositionAlign,
  HorizontalPositionRelativeFrom,
  ImageRun,
  LineRuleType,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TabStopType,
  TextRun,
  TextWrappingType,
  VerticalPositionRelativeFrom,
  WidthType,
} from "docx";
import JSZip from "jszip";
import PDFDocument from "pdfkit";
import {
  formatMoney,
  type PricingIllustration,
  type PricingQuote,
  type RateCard,
  type ResolvedProposal,
} from "./content-model";
import {
  dividerHead,
  FURNITURE_CLOSING_HEADLINE,
  FURNITURE_CLOSING_WEB,
  FURNITURE_COVER_KICKER,
  FURNITURE_DIVIDERS,
  FURNITURE_FOOT_LEFT,
  FURNITURE_FOOT_RIGHT,
  FURNITURE_MINIMUM_CAPTION,
  FURNITURE_SUBMITTED_BY,
  FURNITURE_TABLE_HEAD,
  loadRfpExportAssets,
  sectionKicker,
} from "./export-assets";
import { COMPANY_SIGNATURE, SIGNATURE_COLORS } from "./signature";

// The .rfpdoc palette (globals.css). Bare hex for docx; "#"-prefixed for pdfkit.
const INK = "15163B";
const NAVY = "2F31C5";
const BLUE = "3D7FD9";
const BODY = "31324C";
const MUTED = "5B5D78";
const FAINT = "8A8CA6";
const FOOTGRAY = "767892"; // the screen's AA-checked pagefoot gray
const HAIR = "E3E4EF";
const ZEBRA = "F9FAFD";
const GHOST_FILL = "EEF0FB";
const NAVY_LEDE = "D9DFF7";
const NAVY_LABEL = "9FB6F0";
const NAVY_RULE = "6365D4"; // 25% white over the navy field, precomposed
const h = (c: string) => `#${c.toLowerCase()}`;

export type ExportView = {
  coverTitle: string;
  clientName: string;
  proposalTitle: string;
  dateLabel: string;
  preparedBy: string;
  contactEmail: string;
  /** Cover meta phone line under the email; "" when the signer has none. */
  contactPhone: string;
  /** The cover letter: drafted last as a summary of the sections, closed by
   *  the standard XL.net signature block (per-person lines from resolved). */
  letter: {
    addressee: string[];
    salutation: string;
    body: string[];
    closing: string;
    signature: {
      name: string;
      title: string;
      email: string;
      phone: string;
      fax: string;
      linkedinUrl: string;
    };
  };
  /** kicker replicates the workspace's secKicker ("Section 3" / "IV" / a
   *  pre-worded label verbatim), so screen and file agree on the eyebrow. */
  sections: { label: string; kicker: string; title: string; paragraphs: string[] }[];
  pricing: PricingQuote | null;
  minimumSentence: string | null;
  /** The navy closing sheet's copy, mirrored from the workspace sheet. */
  closing: { headline: string; lede: string };
};

/** The one place presentation-level pricing sentences are authored. */
export function buildExportView(
  resolved: ResolvedProposal,
  rateCard: RateCard
): ExportView {
  const quote = resolved.pricing;
  const anyMinimum = quote?.illustrations.some((i) => i.minimumApplied) ?? false;
  const clientName = resolved.cover.clientName;
  return {
    coverTitle: resolved.cover.title,
    clientName,
    proposalTitle: resolved.proposal.title,
    dateLabel: resolved.cover.dateLabel,
    preparedBy: resolved.letter.signature.name,
    contactEmail: resolved.letter.signature.email,
    contactPhone: resolved.letter.signature.phone,
    letter: {
      addressee: resolved.letter.addressee,
      salutation: resolved.letter.salutation,
      body: resolved.letter.body,
      closing: resolved.letter.closing,
      signature: resolved.letter.signature,
    },
    sections: resolved.sections.map((s) => ({
      label: s.structureLabel,
      kicker: sectionKicker(s.structureLabel),
      title: s.title,
      paragraphs: s.blocks
        .filter((b) => b.kind === "prose")
        .map((b) => (b.kind === "prose" ? b.text : "")),
    })),
    pricing: quote,
    minimumSentence: anyMinimum
      ? `Where fewer than ${rateCard.minimumFullyManagedUsers} users are fully managed, the fully managed line is billed at the monthly minimum of ${formatMoney(rateCard.minimumMonthlyFee, { cents: "always" })} rather than the per-user product.`
      : null,
    closing: {
      headline: FURNITURE_CLOSING_HEADLINE,
      // The workspace guards the fragment: no client, no " with X".
      lede: clientName
        ? `We welcome the opportunity to discuss this proposal with ${clientName}.`
        : "We welcome the opportunity to discuss this proposal.",
    },
  };
}

/** Screen parity: the workspace table renders via fmtCents, which ALWAYS
 *  prints cents ("$3,705.00"); every quote-derived figure matches it. */
const money = (m: Parameters<typeof formatMoney>[0]) =>
  formatMoney(m, { cents: "always" });

/** "#1f497d" → "1F497D" (docx wants bare uppercase hex). */
const hex = (c: string) => c.replace("#", "").toUpperCase();

/** "847.242.1299 ph | fax 847.686.0201", degrading with what is known. */
export function signaturePhoneLine(sig: ExportView["letter"]["signature"]): string | null {
  if (!sig.phone) return null;
  return sig.fax ? `${sig.phone} ph | fax ${sig.fax}` : `${sig.phone} ph`;
}

/** The cover lede, split so emitters can set the client semibold. The
 *  workspace guards the fragment: no client, no " for X" (and no double
 *  space). */
function coverLedeParts(clientName: string): {
  before: string;
  strong: string;
  after: string;
} {
  return clientName
    ? {
        before: "Prepared for ",
        strong: clientName,
        after: " in response to the Request for Proposal.",
      }
    : {
        before: "Prepared in response to the Request for Proposal.",
        strong: "",
        after: "",
      };
}

function illustrationRows(ill: PricingIllustration): string[][] {
  return ill.lines.map((l) => [
    l.label,
    String(l.quantity),
    l.unitPrice.cents === 0 ? "" : money(l.unitPrice),
    money(l.lineTotal),
  ]);
}

/* ======================================================================== */
/* Word                                                                     */
/* ======================================================================== */

// Embedded families, referenced by the names inside the vendored TTFs so
// Word/LibreOffice match the fontTable entries exactly. Archivo Bold keeps
// the family name "Archivo" (its own name table does), so a reader who HAS
// Archivo installed still gets a true bold; the others use their static
// subfamily names.
const AR_BOLD = "Archivo";
const AR_MED = "Archivo Medium";
const AR_SEMI = "Archivo SemiBold";
const SERIF = "Source Serif 4";
const SERIF_SEMI = "Source Serif 4 SemiBold";
const SERIF_ITAL = "Source Serif 4 Italic";

// Page geometry: US Letter, margins ~0.875in (the sheet's 8cqw padding at
// print scale). All in twips (pt * 20).
const DXA_CONTENT = 12240 - 2 * 1260;

/** px at the screen's 96dpi → docx half-points. */
const px2hp = (px: number) => Math.round(px * 1.5);
/** px → twips. */
const px2tw = (px: number) => Math.round(px * 15);
/** letterspacing in em at a px size → twips of character spacing. */
const ls2tw = (em: number, px: number) => Math.round(em * px * 15);

const spacerX = (twips: number) =>
  new Paragraph({
    children: [],
    spacing: { line: Math.max(twips, 20), lineRule: LineRuleType.EXACT },
  });

const NO_BORDERS = {
  top: { style: BorderStyle.NONE, size: 0 },
  bottom: { style: BorderStyle.NONE, size: 0 },
  left: { style: BorderStyle.NONE, size: 0 },
  right: { style: BorderStyle.NONE, size: 0 },
  insideHorizontal: { style: BorderStyle.NONE, size: 0 },
  insideVertical: { style: BorderStyle.NONE, size: 0 },
} as const;

/** The 64x4 accent bar (48x3pt at print scale), as a one-cell shaded table. */
const barTable = (color: string) =>
  new Table({
    width: { size: 960, type: WidthType.DXA },
    borders: NO_BORDERS,
    rows: [
      new TableRow({
        height: { value: 60, rule: HeightRule.EXACT },
        children: [
          new TableCell({
            shading: { fill: color },
            margins: { top: 0, bottom: 0, left: 0, right: 0 },
            children: [new Paragraph({ children: [] })],
          }),
        ],
      }),
    ],
  });

/** Kicker caps: Archivo Medium, brand blue, wide tracking. */
const kickerPar = (
  text: string,
  opts: {
    px?: number;
    ls?: number;
    color?: string;
    before?: number;
    after?: number;
    pageBreakBefore?: boolean;
  } = {}
) =>
  new Paragraph({
    pageBreakBefore: opts.pageBreakBefore,
    children: [
      new TextRun({
        text: text.toUpperCase(),
        font: AR_MED,
        size: px2hp(opts.px ?? 11),
        characterSpacing: ls2tw(opts.ls ?? 0.2, opts.px ?? 11),
        color: opts.color ?? BLUE,
      }),
    ],
    spacing: { before: opts.before ?? 0, after: opts.after ?? 60 },
  });

/** Serif body paragraph at the sheet's 15px/1.68. */
const bodyPar = (text: string, opts: { px?: number; after?: number } = {}) => {
  const px = opts.px ?? 15;
  return new Paragraph({
    children: [
      new TextRun({ text, font: SERIF, size: px2hp(px), color: BODY }),
    ],
    spacing: {
      line: px2tw(px * 1.68),
      lineRule: LineRuleType.AT_LEAST,
      after: opts.after ?? 180,
    },
  });
};

/** The submitted-by / contact grid along a sheet's bottom edge. */
const metaGrid = (
  cols: { label: string; lines: string[] }[],
  palette: { rule: string; label: string; value: string; shade?: string }
) =>
  new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: NO_BORDERS,
    rows: [
      new TableRow({
        children: cols.map(
          (c) =>
            new TableCell({
              shading: palette.shade ? { fill: palette.shade } : undefined,
              borders: {
                top: { style: BorderStyle.SINGLE, size: 6, color: palette.rule },
              },
              margins: { top: 260, bottom: 0, left: 0, right: 200 },
              children: [
                new Paragraph({
                  children: [
                    new TextRun({
                      text: c.label.toUpperCase(),
                      font: AR_MED,
                      size: px2hp(10),
                      characterSpacing: ls2tw(0.18, 10),
                      color: palette.label,
                    }),
                  ],
                  spacing: { after: 90 },
                }),
                ...c.lines.map(
                  (line) =>
                    new Paragraph({
                      children: [
                        new TextRun({
                          text: line,
                          font: SERIF,
                          size: px2hp(14),
                          color: palette.value,
                        }),
                      ],
                      spacing: {
                        line: px2tw(14 * 1.5),
                        lineRule: LineRuleType.AT_LEAST,
                      },
                    })
                ),
              ],
            })
        ),
      }),
    ],
  });

export async function renderRfpDocx(view: ExportView): Promise<Buffer> {
  const assets = loadRfpExportAssets();
  const children: (Paragraph | Table)[] = [];

  const png = (data: Buffer, wPx: number, hPx: number, extra: Partial<ConstructorParameters<typeof ImageRun>[0]> = {}) =>
    new ImageRun({
      type: "png",
      data,
      transformation: { width: wPx, height: hPx },
      ...extra,
    } as ConstructorParameters<typeof ImageRun>[0]);

  /* ---- Page 1: the arc-mark cover -------------------------------------- */
  // The corner ornament Word cannot draw: the pre-rendered quarter-circle
  // pair, floated behind the text at the page's top-right corner.
  children.push(
    new Paragraph({
      children: [
        png(assets.images.arcCorner, 308, 308, {
          floating: {
            horizontalPosition: {
              relative: HorizontalPositionRelativeFrom.PAGE,
              align: HorizontalPositionAlign.RIGHT,
            },
            verticalPosition: {
              relative: VerticalPositionRelativeFrom.PAGE,
              offset: 0,
            },
            behindDocument: true,
            wrap: { type: TextWrappingType.NONE },
          },
        }),
        png(assets.images.logo, 65, 56),
      ],
      spacing: {
        line: px2tw(60),
        lineRule: LineRuleType.AT_LEAST,
        after: 200,
      },
    }),
    spacerX(2100),
    kickerPar(FURNITURE_COVER_KICKER, { px: 12, ls: 0.24, after: 260 }),
    new Paragraph({
      children: [
        new TextRun({
          text: view.coverTitle,
          font: AR_BOLD,
          bold: true,
          size: px2hp(50),
          color: INK,
        }),
      ],
      indent: { right: 1600 }, // the corner ornament owns the top-right
      spacing: {
        line: px2tw(50 * 1.1),
        lineRule: LineRuleType.AT_LEAST,
        after: 320,
      },
    }),
    barTable(NAVY),
    new Paragraph({
      children: (() => {
        const lede = coverLedeParts(view.clientName);
        return [
          new TextRun({ text: lede.before, font: SERIF, size: px2hp(18), color: MUTED }),
          ...(lede.strong
            ? [
                new TextRun({
                  text: lede.strong,
                  font: SERIF_SEMI,
                  size: px2hp(18),
                  color: INK,
                }),
                new TextRun({
                  text: lede.after,
                  font: SERIF,
                  size: px2hp(18),
                  color: MUTED,
                }),
              ]
            : []),
        ];
      })(),
      indent: { right: 2400 },
      spacing: {
        before: 320,
        line: px2tw(18 * 1.55),
        lineRule: LineRuleType.AT_LEAST,
        after: 120,
      },
    }),
    spacerX(4200),
    metaGrid(
      [
        { label: "Submitted by", lines: [FURNITURE_SUBMITTED_BY, view.preparedBy] },
        {
          label: "Contact",
          lines: [view.contactEmail, ...(view.contactPhone ? [view.contactPhone] : [])],
        },
        { label: "Date", lines: [view.dateLabel] },
      ],
      { rule: HAIR, label: FAINT, value: INK }
    )
  );

  /* ---- Page 2: the cover letter ---------------------------------------- */
  const sig = view.letter.signature;
  const phoneLine = signaturePhoneLine(sig);
  const serifRun = (
    text: string,
    opts: { font?: string; px?: number; color?: string; italics?: boolean } = {}
  ) =>
    new TextRun({
      text,
      font: opts.font ?? SERIF,
      size: px2hp(opts.px ?? 14),
      color: opts.color ?? BODY,
      italics: opts.italics,
    });
  const letterPar = (
    runs: (TextRun | ExternalHyperlink)[],
    opts: { before?: number; after?: number; lh?: number; px?: number } = {}
  ) =>
    new Paragraph({
      children: runs,
      spacing: {
        before: opts.before ?? 0,
        after: opts.after ?? 40,
        line: px2tw((opts.px ?? 14) * (opts.lh ?? 1.55)),
        lineRule: LineRuleType.AT_LEAST,
      },
    });
  const sigLink = (text: string, url: string, color: string, semibold = false) =>
    new ExternalHyperlink({
      link: url,
      children: [
        new TextRun({
          text,
          font: semibold ? SERIF_SEMI : SERIF,
          size: px2hp(14),
          color,
          underline: {},
        }),
      ],
    });

  children.push(
    // The letter page's header: logo left, kicker right, over the navy rule.
    new Paragraph({ children: [], pageBreakBefore: true, spacing: { line: 20, lineRule: LineRuleType.EXACT } }),
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: NO_BORDERS,
      rows: [
        new TableRow({
          children: [
            new TableCell({
              borders: { bottom: { style: BorderStyle.SINGLE, size: 12, color: NAVY } },
              margins: { top: 0, bottom: 210, left: 0, right: 0 },
              children: [
                new Paragraph({
                  children: [png(assets.images.logo, 47, 40)],
                  spacing: { line: px2tw(42), lineRule: LineRuleType.AT_LEAST },
                }),
              ],
            }),
            new TableCell({
              borders: { bottom: { style: BorderStyle.SINGLE, size: 12, color: NAVY } },
              margins: { top: 0, bottom: 210, left: 0, right: 0 },
              children: [
                new Paragraph({
                  alignment: AlignmentType.RIGHT,
                  children: [
                    new TextRun({
                      text: "Cover Letter".toUpperCase(),
                      font: AR_MED,
                      size: px2hp(11),
                      characterSpacing: ls2tw(0.2, 11),
                      color: BLUE,
                    }),
                  ],
                }),
              ],
            }),
          ],
        }),
      ],
    }),
    spacerX(390),
    letterPar([serifRun(view.dateLabel)]),
    ...view.letter.addressee.map((line) =>
      letterPar([serifRun(line, { font: SERIF_SEMI, color: INK })], { before: 220 })
    ),
    letterPar([serifRun(view.letter.salutation)], { before: 260, after: 200 }),
    ...view.letter.body.map((p) => letterPar([serifRun(p)], { after: 180 })),
    letterPar([serifRun(view.letter.closing, { color: hex(SIGNATURE_COLORS.person) })], {
      before: 260,
      after: 200,
    }),
    // The standard XL.net signature block; the source does NOT bold the name.
    letterPar([
      serifRun(sig.name + (sig.linkedinUrl ? " " : ""), {
        color: hex(SIGNATURE_COLORS.person),
      }),
      ...(sig.linkedinUrl
        ? [sigLink("{LinkedIn}", sig.linkedinUrl, hex(SIGNATURE_COLORS.link))]
        : []),
    ]),
    ...(sig.title
      ? [letterPar([serifRun(sig.title, { color: hex(SIGNATURE_COLORS.person) })])]
      : []),
    letterPar([
      serifRun(phoneLine ?? sig.email, { color: hex(SIGNATURE_COLORS.contact) }),
    ]),
    letterPar(
      [sigLink(COMPANY_SIGNATURE.name, COMPANY_SIGNATURE.url, hex(SIGNATURE_COLORS.link), true)],
      { before: 180 }
    ),
    letterPar([
      serifRun(COMPANY_SIGNATURE.tagline.orange, {
        font: SERIF_SEMI,
        color: hex(SIGNATURE_COLORS.taglineOrange),
      }),
      serifRun(COMPANY_SIGNATURE.tagline.navy, {
        font: SERIF_SEMI,
        color: hex(SIGNATURE_COLORS.taglineNavy),
      }),
    ]),
    ...COMPANY_SIGNATURE.articles.map((a) =>
      letterPar(
        [sigLink(a.title, a.url, hex(SIGNATURE_COLORS.taglineNavy), true)],
        { before: 120 }
      )
    )
  );

  /* ---- Part dividers + sections + investment --------------------------- */
  const dividerSheet = (which: 0 | 1) => {
    const d = FURNITURE_DIVIDERS[which];
    children.push(
      kickerPar(dividerHead(view.clientName), {
        px: 11,
        ls: 0.2,
        color: FOOTGRAY,
        pageBreakBefore: true,
        after: 0,
      }),
      spacerX(2500),
      // The ghost numeral: pre-rendered outline PNG (Word has no text-stroke).
      new Paragraph({
        children: [
          png(which === 0 ? assets.images.num01 : assets.images.num02, 179, 163),
        ],
        spacing: { line: px2tw(166), lineRule: LineRuleType.AT_LEAST, after: 420 },
      }),
      barTable(BLUE),
      new Paragraph({
        children: [
          new TextRun({
            text: d.title,
            font: AR_BOLD,
            bold: true,
            size: px2hp(42),
            color: INK,
          }),
        ],
        indent: { right: 1400 },
        spacing: {
          before: 420,
          line: px2tw(42 * 1.15),
          lineRule: LineRuleType.AT_LEAST,
          after: 300,
        },
      }),
      new Paragraph({
        children: [new TextRun({ text: d.deck, font: SERIF, size: px2hp(16), color: MUTED })],
        indent: { right: 3000 },
        spacing: { line: px2tw(16 * 1.6), lineRule: LineRuleType.AT_LEAST },
      }),
      spacerX(3100),
      // The three-square colophon: navy, blue, hairline gray.
      new Table({
        width: { size: 810, type: WidthType.DXA },
        borders: NO_BORDERS,
        columnWidths: [150, 180, 150, 180, 150],
        rows: [
          new TableRow({
            height: { value: 150, rule: HeightRule.EXACT },
            children: [NAVY, "", BLUE, "", HAIR].map(
              (fill) =>
                new TableCell({
                  shading: fill ? { fill } : undefined,
                  margins: { top: 0, bottom: 0, left: 0, right: 0 },
                  children: [new Paragraph({ children: [] })],
                })
            ),
          }),
        ],
      })
    );
  };

  const secHead = (kicker: string, title: string) => {
    children.push(
      kickerPar(kicker, { pageBreakBefore: true, after: 80 }),
      new Paragraph({
        children: [
          new TextRun({
            text: title,
            font: AR_BOLD,
            bold: true,
            size: px2hp(28),
            color: INK,
          }),
        ],
        spacing: {
          line: px2tw(28 * 1.2),
          lineRule: LineRuleType.AT_LEAST,
          after: 260,
        },
      })
    );
  };

  dividerSheet(0);
  for (const sec of view.sections) {
    secHead(sec.kicker, sec.title);
    for (const p of sec.paragraphs) children.push(bodyPar(p));
  }
  // Divider 02 announces the Investment part; with no quote there is no
  // part to announce, so both are omitted together (same rule as the PDF).
  if (view.pricing) {
    dividerSheet(1);
    secHead("Pricing", "Investment");

    const tcell = (
      text: string,
      opts: { head?: boolean; strong?: boolean; right?: boolean; zebra?: boolean; total?: boolean } = {}
    ) =>
      new TableCell({
        shading: opts.head
          ? { fill: NAVY }
          : opts.zebra
            ? { fill: ZEBRA }
            : undefined,
        borders: opts.head
          ? NO_BORDERS
          : opts.total
            ? {
                ...NO_BORDERS,
                top: { style: BorderStyle.SINGLE, size: 12, color: INK },
              }
            : {
                ...NO_BORDERS,
                bottom: { style: BorderStyle.SINGLE, size: 6, color: HAIR },
              },
        margins: { top: 135, bottom: 135, left: 160, right: 160 },
        children: [
          new Paragraph({
            alignment: opts.right ? AlignmentType.RIGHT : AlignmentType.LEFT,
            children: [
              opts.head
                ? new TextRun({
                    text: text.toUpperCase(),
                    font: AR_SEMI,
                    size: px2hp(11),
                    characterSpacing: ls2tw(0.1, 11),
                    color: "FFFFFF",
                  })
                : new TextRun({
                    text,
                    font: opts.strong || opts.total ? SERIF_SEMI : SERIF,
                    size: px2hp(13.5),
                    color: opts.strong || opts.total ? INK : BODY,
                  }),
            ],
          }),
        ],
      });

    for (const ill of view.pricing.illustrations) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: ill.label,
              font: AR_BOLD,
              bold: true,
              size: px2hp(15),
              color: INK,
            }),
          ],
          spacing: { before: 300, after: 60 },
        }),
        new Paragraph({
          children: [new TextRun({ text: ill.basis, font: SERIF, size: px2hp(14), color: MUTED })],
          spacing: { after: 180 },
        }),
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          borders: NO_BORDERS,
          columnWidths: [4680, 1240, 1800, 2000],
          rows: [
            new TableRow({
              tableHeader: true,
              children: [
                tcell(FURNITURE_TABLE_HEAD[0], { head: true }),
                tcell(FURNITURE_TABLE_HEAD[1], { head: true, right: true }),
                tcell(FURNITURE_TABLE_HEAD[2], { head: true, right: true }),
                tcell(FURNITURE_TABLE_HEAD[3], { head: true, right: true }),
              ],
            }),
            ...illustrationRows(ill).map(
              (r, i) =>
                new TableRow({
                  children: [
                    tcell(r[0], { strong: true, zebra: i % 2 === 1 }),
                    tcell(r[1], { right: true, zebra: i % 2 === 1 }),
                    tcell(r[2], { right: true, zebra: i % 2 === 1 }),
                    tcell(r[3], { right: true, zebra: i % 2 === 1 }),
                  ],
                })
            ),
            new TableRow({
              children: [
                tcell("Monthly total", { total: true }),
                tcell("", { total: true }),
                tcell("", { total: true }),
                tcell(money(ill.monthlyTotal), { total: true, right: true }),
              ],
            }),
            new TableRow({
              children: [
                tcell("Annual total", { total: true }),
                tcell("", { total: true }),
                tcell("", { total: true }),
                tcell(money(ill.annualTotal), { total: true, right: true }),
              ],
            }),
          ],
        }),
        ...(ill.minimumApplied
          ? [
              new Paragraph({
                children: [
                  new TextRun({
                    text: FURNITURE_MINIMUM_CAPTION,
                    font: SERIF_ITAL,
                    italics: true,
                    size: px2hp(13),
                    color: MUTED,
                  }),
                ],
                spacing: { before: 120, after: 120 },
              }),
            ]
          : []),
        spacerX(200)
      );
    }
    if (view.minimumSentence)
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: view.minimumSentence,
              font: SERIF_ITAL,
              italics: true,
              size: px2hp(13),
              color: MUTED,
            }),
          ],
          spacing: { before: 120, after: 120 },
        })
      );
    for (const pt of view.pricing.passThroughItems)
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: `${pt.label}: `,
              font: SERIF_SEMI,
              size: px2hp(14),
              color: INK,
            }),
            new TextRun({ text: pt.detail, font: SERIF, size: px2hp(14), color: MUTED }),
          ],
          spacing: { after: 120 },
        })
      );
    for (const note of view.pricing.notes)
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: note,
              font: SERIF_ITAL,
              italics: true,
              size: px2hp(13),
              color: MUTED,
            }),
          ],
          spacing: { after: 120 },
        })
      );
  }

  /* ---- The navy closing sheet ------------------------------------------ */
  children.push(
    new Paragraph({ children: [], pageBreakBefore: true, spacing: { line: 20, lineRule: LineRuleType.EXACT } }),
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: NO_BORDERS,
      rows: [
        new TableRow({
          height: { value: 13000, rule: HeightRule.EXACT },
          children: [
            new TableCell({
              shading: { fill: NAVY },
              margins: { top: 600, bottom: 600, left: 600, right: 600 },
              children: [
                new Paragraph({
                  children: [png(assets.images.logoWhiteWordmark, 117, 104)],
                  spacing: { line: px2tw(110), lineRule: LineRuleType.AT_LEAST, after: 200 },
                }),
                spacerX(1700),
                new Paragraph({
                  children: [
                    new TextRun({
                      text: view.closing.headline,
                      font: AR_BOLD,
                      bold: true,
                      size: px2hp(42),
                      color: "FFFFFF",
                    }),
                  ],
                  indent: { right: 1000 },
                  spacing: {
                    line: px2tw(42 * 1.15),
                    lineRule: LineRuleType.AT_LEAST,
                    after: 420,
                  },
                }),
                barTable(BLUE),
                new Paragraph({
                  children: [
                    new TextRun({
                      text: view.closing.lede,
                      font: SERIF,
                      size: px2hp(16),
                      color: NAVY_LEDE,
                    }),
                  ],
                  indent: { right: 3400 },
                  spacing: {
                    before: 360,
                    line: px2tw(16 * 1.6),
                    lineRule: LineRuleType.AT_LEAST,
                  },
                }),
                spacerX(2300),
                metaGrid(
                  [
                    { label: "Contact", lines: [view.preparedBy] },
                    { label: "Email", lines: [view.contactEmail] },
                    { label: "Web", lines: [FURNITURE_CLOSING_WEB] },
                  ],
                  { rule: NAVY_RULE, label: NAVY_LABEL, value: "FFFFFF", shade: NAVY }
                ),
              ],
            }),
          ],
        }),
      ],
    })
  );

  /* ---- Assemble --------------------------------------------------------- */
  const footRun = (text: string, color = FOOTGRAY) =>
    new TextRun({
      text: text.toUpperCase(),
      font: AR_MED,
      size: px2hp(9),
      characterSpacing: ls2tw(0.14, 9),
      color,
    });

  const document = new Document({
    styles: {
      default: {
        document: { run: { font: SERIF, size: px2hp(15), color: BODY } },
      },
    },
    fonts: [
      { name: AR_BOLD, data: assets.fonts.archivoBold },
      { name: AR_MED, data: assets.fonts.archivoMedium },
      { name: AR_SEMI, data: assets.fonts.archivoSemiBold },
      { name: SERIF, data: assets.fonts.serifRegular },
      { name: SERIF_SEMI, data: assets.fonts.serifSemiBold },
      { name: SERIF_ITAL, data: assets.fonts.serifItalic },
    ],
    sections: [
      {
        properties: {
          page: {
            margin: { top: 1260, bottom: 1260, left: 1260, right: 1260, footer: 620 },
          },
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                tabStops: [{ type: TabStopType.RIGHT, position: DXA_CONTENT }],
                border: {
                  top: { style: BorderStyle.SINGLE, size: 6, color: HAIR, space: 4 },
                },
                children: [
                  footRun(FURNITURE_FOOT_LEFT),
                  new TextRun({ children: ["\t"] }),
                  footRun(FURNITURE_FOOT_RIGHT),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });
  const packed = await Packer.toBuffer(document);
  return embedPlainFonts(packed, {
    [AR_BOLD]: assets.fonts.archivoBold,
    [AR_MED]: assets.fonts.archivoMedium,
    [AR_SEMI]: assets.fonts.archivoSemiBold,
    [SERIF]: assets.fonts.serifRegular,
    [SERIF_SEMI]: assets.fonts.serifSemiBold,
    [SERIF_ITAL]: assets.fonts.serifItalic,
  });
}

/**
 * Swap the packer's ECMA-obfuscated .odttf font parts for the plain TTFs.
 *
 * docx 9.x embeds fonts in the obfuscated form Word writes. Word reads
 * both forms, but LibreOffice (verified against 25.2: pdffonts on its
 * conversion showed DejaVu fallbacks for the .odttf package and the real
 * faces for the plain-TTF one) only honors UNobfuscated embedded fonts —
 * the same form LibreOffice's own .docx export writes, which Word opens
 * fine. application/x-font-ttf is one of ECMA-376's listed font part
 * content types, so the swapped package stays valid. jszip is docx's own
 * dependency; no new package.
 */
async function embedPlainFonts(
  packed: Buffer,
  byName: Record<string, Buffer>
): Promise<Buffer> {
  const zip = await JSZip.loadAsync(packed);
  const ftFile = zip.file("word/fontTable.xml");
  const relsFile = zip.file("word/_rels/fontTable.xml.rels");
  const ctFile = zip.file("[Content_Types].xml");
  if (!ftFile || !relsFile || !ctFile) return packed; // nothing embedded
  const ftXml = await ftFile.async("string");
  const relsXml = await relsFile.async("string");
  const rels = new Map<string, string>();
  for (const m of relsXml.matchAll(
    /<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g
  ))
    rels.set(m[1], m[2]);
  for (const m of ftXml.matchAll(/<w:font w:name="([^"]+)">([\s\S]*?)<\/w:font>/g)) {
    const data = byName[m[1]];
    const rid = m[2].match(/<w:embedRegular[^>]*r:id="([^"]+)"/)?.[1];
    const target = rid ? rels.get(rid) : undefined;
    if (!data || !target || !target.endsWith(".odttf")) continue;
    zip.remove(`word/${target}`);
    zip.file(`word/${target.replace(/\.odttf$/, ".ttf")}`, data);
  }
  zip.file("word/fontTable.xml", ftXml.replace(/ w:fontKey="\{[^}]+\}"/g, ""));
  zip.file("word/_rels/fontTable.xml.rels", relsXml.replace(/\.odttf/g, ".ttf"));
  const ct = await ctFile.async("string");
  zip.file(
    "[Content_Types].xml",
    ct.replace(
      /<Default [^>]*Extension="odttf"[^>]*\/>/,
      '<Default ContentType="application/x-font-ttf" Extension="ttf"/>'
    )
  );
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  }) as Promise<Buffer>;
}

/* ======================================================================== */
/* PDF                                                                      */
/* ======================================================================== */

// US Letter in points; margins are the sheet's 8cqw padding at print scale
// (84px → 63pt), so the page IS the on-screen sheet at full size. The
// bottom margin additionally reserves the pagefoot band: content may flow
// down to FOOT_LIMIT and never into the footer.
const PAGE = { width: 612, height: 792, margin: 63 };
const CW = PAGE.width - PAGE.margin * 2;
const FOOT_RULE_Y = 714;
const FOOT_TEXT_Y = 720;
const FOOT_LIMIT = 687; // rule minus the sheet's 2.25rem padding-top

/** px at the screen's 96dpi → pt. */
const pt = (px: number) => px * 0.75;

export async function renderRfpPdf(view: ExportView): Promise<Buffer> {
  const assets = loadRfpExportAssets();
  const doc = new PDFDocument({
    size: "LETTER",
    margins: {
      top: PAGE.margin,
      bottom: PAGE.height - FOOT_LIMIT,
      left: PAGE.margin,
      right: PAGE.margin,
    },
    info: { Title: `${view.clientName}: ${view.coverTitle}`, Author: "XL.net" },
    bufferPages: true,
  });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) =>
    doc.on("end", () => resolve(Buffer.concat(chunks)))
  );

  // The screen faces, embedded for real (pdffonts must show them).
  doc.registerFont("Archivo-Bold", assets.fonts.archivoBold);
  doc.registerFont("Archivo-Medium", assets.fonts.archivoMedium);
  doc.registerFont("Archivo-SemiBold", assets.fonts.archivoSemiBold);
  doc.registerFont("Serif", assets.fonts.serifRegular);
  doc.registerFont("Serif-SemiBold", assets.fonts.serifSemiBold);
  doc.registerFont("Serif-Italic", assets.fonts.serifItalic);

  // Which buffered page each sheet starts on, so the stamping pass can put
  // a quiet "· continued" kicker on overflow pages only.
  const sheetStarts: { page: number; cont: string | null }[] = [];
  const pageIndex = () => {
    const r = doc.bufferedPageRange();
    return r.start + r.count - 1;
  };
  const beginSheet = (cont: string | null, first = false) => {
    if (!first) doc.addPage();
    sheetStarts.push({ page: pageIndex(), cont });
    doc.x = PAGE.margin;
    doc.y = PAGE.margin;
  };

  const ensureRoom = (needed: number) => {
    if (doc.y + needed > FOOT_LIMIT) {
      doc.addPage();
      doc.x = PAGE.margin;
      doc.y = PAGE.margin;
    }
  };

  /** Letterspaced caps (the kicker/metalabel/runner voice). Always a single
   *  unbroken line: lineBreak stays FALSE so a stamp near the page bottom
   *  can never trigger pdfkit's auto-pagination (the footer band sits below
   *  the bottom margin by design). Right alignment is measured by hand for
   *  the same reason. */
  const caps = (
    text: string,
    x: number,
    y: number,
    opts: {
      px?: number;
      ls?: number;
      color?: string;
      font?: string;
      width?: number;
      align?: "left" | "right";
    } = {}
  ) => {
    const size = pt(opts.px ?? 11);
    const csp = (opts.ls ?? 0.2) * size;
    const upper = text.toUpperCase();
    doc.font(opts.font ?? "Archivo-Medium").fontSize(size).fillColor(opts.color ?? h(BLUE));
    let tx = x;
    if (opts.align === "right" && opts.width !== undefined) {
      // widthOfString counts a trailing characterSpacing; drop it.
      const w = doc.widthOfString(upper, { characterSpacing: csp }) - csp;
      tx = x + opts.width - w;
    }
    doc.text(upper, tx, y, { characterSpacing: csp, lineBreak: false });
  };

  /** Flowing text at a screen px size and line-height. */
  const flow = (
    text: string,
    opts: {
      px?: number;
      lh?: number;
      font?: string;
      color?: string;
      width?: number;
      continued?: boolean;
      link?: string;
      underline?: boolean;
    } = {}
  ) => {
    const size = pt(opts.px ?? 15);
    doc.font(opts.font ?? "Serif").fontSize(size).fillColor(opts.color ?? h(BODY));
    const gap = Math.max(0, size * (opts.lh ?? 1.68) - doc.currentLineHeight());
    doc.text(text, {
      width: opts.width ?? CW,
      lineGap: gap,
      continued: opts.continued ?? false,
      ...(opts.link !== undefined ? { link: opts.link } : {}),
      underline: opts.underline ?? false,
    });
  };

  const hairline = (x1: number, y: number, x2: number) => {
    doc.moveTo(x1, y).lineTo(x2, y).lineWidth(0.75).strokeColor(h(HAIR)).stroke();
  };

  const bar = (x: number, y: number, color: string) => {
    doc.rect(x, y, pt(64), pt(4)).fill(color);
  };

  /** The submitted-by / contact grid along a sheet's bottom edge.
   *  Returns the y of its top rule. */
  const metaGridPdf = (
    x: number,
    width: number,
    bottom: number,
    cols: { label: string; lines: string[] }[],
    palette: { rule: () => void; label: string; value: string }
  ): number => {
    const gap = pt(24);
    const colW = (width - gap * 2) / 3;
    const labelH = pt(10);
    const lineH = pt(14) * 1.5;
    const maxLines = Math.max(...cols.map((c) => c.lines.length));
    const contentH = labelH + pt(6) + maxLines * lineH;
    const top = bottom - contentH;
    const ruleY = top - pt(22);
    doc.save();
    palette.rule();
    doc.moveTo(x, ruleY).lineTo(x + width, ruleY).lineWidth(0.75).stroke();
    doc.restore();
    cols.forEach((c, i) => {
      const cx = x + i * (colW + gap);
      caps(c.label, cx, top, { px: 10, ls: 0.18, color: palette.label });
      let y = top + labelH + pt(6);
      for (const line of c.lines) {
        doc
          .font("Serif")
          .fontSize(pt(14))
          .fillColor(palette.value)
          .text(line, cx, y, { width: colW, lineBreak: false });
        y += lineH;
      }
    });
    return ruleY;
  };

  /* ---- Page 1: the arc-mark cover -------------------------------------- */
  beginSheet(null, true);
  {
    const fx = PAGE.margin;
    const fy = PAGE.margin;
    const fw = CW;
    const fh = FOOT_LIMIT - PAGE.margin; // the sheet's inner frame
    const pad = pt(40);
    const ix = fx + pad;
    const iw = fw - pad * 2;

    // Corner ornament: concentric circles clipped to the frame, centered on
    // its top-right corner (globals.css ::before/::after, 95% and 72%).
    doc.save();
    doc.rect(fx, fy, fw, fh).clip();
    doc.circle(fx + fw, fy, fw * 0.475).fill(h(NAVY));
    doc.circle(fx + fw, fy, fw * 0.36).lineWidth(1.5).stroke(h(BLUE));
    doc.restore();
    // The hairline frame itself.
    doc.rect(fx, fy, fw, fh).lineWidth(0.75).strokeColor(h(HAIR)).stroke();

    // Logo, top-left inside the frame.
    doc.image(assets.images.logo, ix, fy + pad, { height: pt(56) });

    // Bottom: the submitted-by grid.
    const metaRuleY = metaGridPdf(
      ix,
      iw,
      fy + fh - pad,
      [
        { label: "Submitted by", lines: [FURNITURE_SUBMITTED_BY, view.preparedBy] },
        {
          label: "Contact",
          lines: [view.contactEmail, ...(view.contactPhone ? [view.contactPhone] : [])],
        },
        { label: "Date", lines: [view.dateLabel] },
      ],
      {
        rule: () => doc.strokeColor(h(HAIR)),
        label: h(FAINT),
        value: h(INK),
      }
    );

    // Middle: kicker / title / bar / lede, centered in the leftover space
    // (the sheet's justify-between).
    const titleW = iw * 0.86;
    const ledeW = Math.min(pt(544), iw);
    doc.font("Archivo-Bold").fontSize(pt(50));
    const titleH = doc.heightOfString(view.coverTitle, {
      width: titleW,
      lineGap: Math.max(0, pt(50) * 1.1 - doc.currentLineHeight()),
    });
    doc.font("Serif").fontSize(pt(18));
    const lede = coverLedeParts(view.clientName);
    const ledeText = lede.before + lede.strong + lede.after;
    const ledeH = doc.heightOfString(ledeText, {
      width: ledeW,
      lineGap: Math.max(0, pt(18) * 1.55 - doc.currentLineHeight()),
    });
    const blockH = pt(12) + pt(20) + titleH + pt(28) + pt(4) + pt(24) + ledeH;
    const regionTop = fy + pad + pt(56);
    const regionBottom = metaRuleY;
    let y = regionTop + Math.max(pt(24), (regionBottom - regionTop - blockH) / 2);

    caps(FURNITURE_COVER_KICKER, ix, y, { px: 12, ls: 0.24, width: iw * 0.76 });
    y += pt(12) + pt(20);
    doc.font("Archivo-Bold").fontSize(pt(50)).fillColor(h(INK));
    doc.text(view.coverTitle, ix, y, {
      width: titleW,
      lineGap: Math.max(0, pt(50) * 1.1 - doc.currentLineHeight()),
    });
    y += titleH + pt(28);
    bar(ix, y, h(NAVY));
    y += pt(4) + pt(24);
    doc.x = ix;
    doc.y = y;
    flow(lede.before, {
      px: 18,
      lh: 1.55,
      color: h(MUTED),
      width: ledeW,
      continued: Boolean(lede.strong),
    });
    if (lede.strong) {
      flow(lede.strong, {
        px: 18,
        lh: 1.55,
        font: "Serif-SemiBold",
        color: h(INK),
        width: ledeW,
        continued: true,
      });
      flow(lede.after, {
        px: 18,
        lh: 1.55,
        color: h(MUTED),
        width: ledeW,
      });
    }
  }

  /* ---- Page 2: the cover letter ---------------------------------------- */
  beginSheet("Cover Letter");
  {
    const x = PAGE.margin;
    // Page head: small logo left, kicker right, over the navy rule.
    doc.image(assets.images.logo, x, PAGE.margin, { height: pt(40) });
    caps("Cover Letter", x, PAGE.margin + pt(14), {
      px: 11,
      ls: 0.2,
      width: CW,
      align: "right",
    });
    const ruleY = PAGE.margin + pt(40) + pt(14);
    doc.moveTo(x, ruleY).lineTo(x + CW, ruleY).lineWidth(1.5).strokeColor(h(NAVY)).stroke();
    doc.x = x;
    doc.y = ruleY + pt(26);

    const LW = Math.min(pt(640), CW);
    flow(view.dateLabel, { px: 14, lh: 1.55, width: LW });
    doc.moveDown(0.9);
    for (const line of view.letter.addressee)
      flow(line, { px: 14, lh: 1.55, font: "Serif-SemiBold", color: h(INK), width: LW });
    doc.moveDown(1.1);
    flow(view.letter.salutation, { px: 14, lh: 1.55, width: LW });
    doc.moveDown(0.8);
    for (const p of view.letter.body) {
      ensureRoom(40);
      flow(p, { px: 14, lh: 1.55, width: LW });
      doc.moveDown(0.8);
    }
    // The signature block never splits across a page break.
    ensureRoom(180);
    flow(view.letter.closing, { px: 14, lh: 1.6, color: SIGNATURE_COLORS.person, width: LW });
    doc.moveDown(1.1);
    const sig = view.letter.signature;
    // The source signature does NOT bold the name.
    flow(sig.name + (sig.linkedinUrl ? " " : ""), {
      px: 14,
      lh: 1.6,
      color: SIGNATURE_COLORS.person,
      width: LW,
      continued: Boolean(sig.linkedinUrl),
    });
    if (sig.linkedinUrl)
      flow("{LinkedIn}", {
        px: 14,
        lh: 1.6,
        color: SIGNATURE_COLORS.link,
        width: LW,
        link: sig.linkedinUrl,
        underline: true,
      });
    if (sig.title)
      flow(sig.title, { px: 14, lh: 1.6, color: SIGNATURE_COLORS.person, width: LW });
    flow(signaturePhoneLine(sig) ?? sig.email, {
      px: 14,
      lh: 1.6,
      color: SIGNATURE_COLORS.contact,
      width: LW,
    });
    doc.moveDown(0.7);
    flow(COMPANY_SIGNATURE.name, {
      px: 14,
      lh: 1.6,
      font: "Serif-SemiBold",
      color: SIGNATURE_COLORS.link,
      width: LW,
      link: COMPANY_SIGNATURE.url,
      underline: true,
    });
    flow(COMPANY_SIGNATURE.tagline.orange, {
      px: 14,
      lh: 1.6,
      font: "Serif-SemiBold",
      color: SIGNATURE_COLORS.taglineOrange,
      width: LW,
      continued: true,
    });
    flow(COMPANY_SIGNATURE.tagline.navy, {
      px: 14,
      lh: 1.6,
      font: "Serif-SemiBold",
      color: SIGNATURE_COLORS.taglineNavy,
      width: LW,
    });
    doc.moveDown(0.4);
    for (const a of COMPANY_SIGNATURE.articles)
      flow(a.title, {
        px: 14,
        lh: 1.6,
        font: "Serif-SemiBold",
        color: SIGNATURE_COLORS.taglineNavy,
        width: LW,
        link: a.url,
        underline: true,
      });
  }

  /* ---- Divider sheets --------------------------------------------------- */
  const dividerSheet = (which: 0 | 1) => {
    const d = FURNITURE_DIVIDERS[which];
    beginSheet(null);
    const x = PAGE.margin;
    caps(dividerHead(view.clientName), x, PAGE.margin, {
      px: 11,
      ls: 0.2,
      color: h(FOOTGRAY),
    });

    // The three-square colophon at the bottom edge.
    const sq = pt(10);
    const sqY = FOOT_LIMIT - sq;
    ([h(NAVY), h(BLUE), h(HAIR)] as const).forEach((c, i) => {
      doc.rect(x + i * (sq + pt(12)), sqY, sq, sq).fill(c);
    });

    // The centered body: ghost numeral, bar, title, deck.
    doc.font("Archivo-Bold").fontSize(pt(150));
    const numH = doc.currentLineHeight();
    const titleW = CW * 0.86;
    doc.fontSize(pt(42));
    const titleH = doc.heightOfString(d.title, {
      width: titleW,
      lineGap: Math.max(0, pt(42) * 1.15 - doc.currentLineHeight()),
    });
    const deckW = Math.min(pt(560), CW);
    doc.font("Serif").fontSize(pt(16));
    const deckH = doc.heightOfString(d.deck, {
      width: deckW,
      lineGap: Math.max(0, pt(16) * 1.6 - doc.currentLineHeight()),
    });
    const blockH = numH + pt(28) + pt(4) + pt(28) + titleH + pt(20) + deckH;
    const regionTop = PAGE.margin + pt(20);
    let y = regionTop + Math.max(0, (sqY - pt(20) - regionTop - blockH) / 2);

    // The ghost numeral: near-white fill with the navy outline (the
    // screen's -webkit-text-stroke device, drawn with the real stroke).
    doc
      .font("Archivo-Bold")
      .fontSize(pt(150))
      .fillColor(h(GHOST_FILL))
      .strokeColor(h(NAVY))
      .lineWidth(1.5)
      .text(d.num, x, y, { lineBreak: false, fill: true, stroke: true });
    y += numH + pt(28);
    bar(x, y, h(BLUE));
    y += pt(4) + pt(28);
    doc.font("Archivo-Bold").fontSize(pt(42)).fillColor(h(INK));
    doc.text(d.title, x, y, {
      width: titleW,
      lineGap: Math.max(0, pt(42) * 1.15 - doc.currentLineHeight()),
    });
    y += titleH + pt(20);
    doc.font("Serif").fontSize(pt(16)).fillColor(h(MUTED));
    doc.text(d.deck, x, y, {
      width: deckW,
      lineGap: Math.max(0, pt(16) * 1.6 - doc.currentLineHeight()),
    });
  };

  /* ---- Section sheets --------------------------------------------------- */
  const secHead = (kicker: string, title: string) => {
    const x = PAGE.margin;
    caps(kicker, x, PAGE.margin, { px: 11, ls: 0.2 });
    doc.x = x;
    doc.y = PAGE.margin + pt(11) + pt(6);
    doc.font("Archivo-Bold").fontSize(pt(28)).fillColor(h(INK));
    doc.text(title, {
      width: CW,
      lineGap: Math.max(0, pt(28) * 1.2 - doc.currentLineHeight()),
    });
    doc.moveDown(0.55);
  };

  dividerSheet(0);
  for (const sec of view.sections) {
    beginSheet(sec.kicker);
    secHead(sec.kicker, sec.title);
    for (const p of sec.paragraphs) {
      ensureRoom(40);
      flow(p, { px: 15, lh: 1.68 });
      doc.moveDown(0.65);
    }
  }
  /* ---- Investment ------------------------------------------------------- */
  // Divider 02 announces the Investment part; with no quote there is no
  // part to announce, so both are omitted together (same rule as the docx).
  if (view.pricing) {
    dividerSheet(1);
    beginSheet("Investment");
    secHead("Pricing", "Investment");

    // Table columns: service | qty | unit | monthly (screen column heads).
    const cols = [CW - 210, 50, 70, 90];
    const colX = [
      PAGE.margin,
      PAGE.margin + cols[0],
      PAGE.margin + cols[0] + cols[1],
      PAGE.margin + cols[0] + cols[1] + cols[2],
    ];
    const CELL_PX = pt(14); // 14px side padding
    const CELL_PY = pt(12); // 12px vertical padding

    // The branded table: navy head band with white letterspaced caps, zebra
    // body rows, emphasized first column, hairline row rules, ink-ruled
    // total rows. Row backgrounds paint BEFORE the text (height measured
    // first).
    const row = (
      cells: string[],
      opts: { head?: boolean; zebra?: boolean; total?: boolean } = {}
    ) => {
      ensureRoom(30);
      const y = doc.y;
      const size = opts.head ? pt(11) : pt(13.5);
      const csp = opts.head ? 0.1 * size : 0;
      const cellFont = (i: number) =>
        opts.head
          ? "Archivo-SemiBold"
          : i === 0 || opts.total
            ? "Serif-SemiBold"
            : "Serif";
      // A number never character-wraps mid-figure: numeric columns step the
      // size down until the string fits its column on one line.
      const cellSizes = cells.map((c, i) => {
        if (opts.head || i === 0 || !c) return size;
        let s = size;
        doc.font(cellFont(i));
        while (
          s > 6.5 &&
          doc.fontSize(s).widthOfString(c) > cols[i] - CELL_PX * 2
        )
          s -= 0.5;
        return s;
      });
      let maxH = 0;
      cells.forEach((c, i) => {
        doc.font(cellFont(i)).fontSize(cellSizes[i]);
        maxH = Math.max(
          maxH,
          doc.heightOfString(opts.head ? c.toUpperCase() : c || " ", {
            width: cols[i] - CELL_PX * 2,
            characterSpacing: csp,
          })
        );
      });
      const rowH = maxH + CELL_PY * 2;
      if (opts.head) {
        doc.rect(PAGE.margin, y, CW, rowH).fill(h(NAVY));
      } else if (opts.zebra && !opts.total) {
        doc.rect(PAGE.margin, y, CW, rowH).fill(h(ZEBRA));
      }
      if (opts.total) {
        doc
          .moveTo(PAGE.margin, y)
          .lineTo(PAGE.margin + CW, y)
          .lineWidth(1.5)
          .strokeColor(h(INK))
          .stroke();
      }
      cells.forEach((c, i) => {
        doc
          .font(cellFont(i))
          .fontSize(cellSizes[i])
          .fillColor(
            opts.head ? "#ffffff" : i === 0 || opts.total ? h(INK) : h(BODY)
          )
          .text(opts.head ? c.toUpperCase() : c, colX[i] + CELL_PX, y + CELL_PY, {
            width: cols[i] - CELL_PX * 2,
            align: i === 0 ? "left" : "right",
            characterSpacing: csp,
          });
      });
      doc.fillColor("black");
      doc.x = PAGE.margin;
      doc.y = y + rowH;
      if (!opts.head && !opts.total) hairline(PAGE.margin, doc.y, PAGE.margin + CW);
    };

    for (const ill of view.pricing.illustrations) {
      ensureRoom(120);
      doc.x = PAGE.margin;
      doc.font("Archivo-Bold").fontSize(pt(15)).fillColor(h(INK)).text(ill.label, { width: CW });
      doc.moveDown(0.15);
      flow(ill.basis, { px: 14, lh: 1.5, color: h(MUTED) });
      doc.moveDown(0.5);

      row([...FURNITURE_TABLE_HEAD], { head: true });
      illustrationRows(ill).forEach((r, i) => row(r, { zebra: i % 2 === 1 }));
      row(["Monthly total", "", "", money(ill.monthlyTotal)], { total: true });
      row(["Annual total", "", "", money(ill.annualTotal)], { total: true });
      if (ill.minimumApplied) {
        doc.moveDown(0.4);
        ensureRoom(30);
        flow(FURNITURE_MINIMUM_CAPTION, {
          px: 13,
          lh: 1.5,
          font: "Serif-Italic",
          color: h(MUTED),
        });
      }
      doc.moveDown(1.1);
    }

    if (view.minimumSentence) {
      ensureRoom(34);
      flow(view.minimumSentence, { px: 13, lh: 1.5, font: "Serif-Italic", color: h(MUTED) });
      doc.moveDown(0.6);
    }
    for (const ptI of view.pricing.passThroughItems) {
      ensureRoom(28);
      flow(`${ptI.label}: `, {
        px: 14,
        lh: 1.5,
        font: "Serif-SemiBold",
        color: h(INK),
        continued: true,
      });
      flow(ptI.detail, { px: 14, lh: 1.5, color: h(MUTED) });
      doc.moveDown(0.4);
    }
    for (const note of view.pricing.notes) {
      ensureRoom(28);
      flow(note, { px: 13, lh: 1.5, font: "Serif-Italic", color: h(MUTED) });
      doc.moveDown(0.4);
    }
  }

  /* ---- The navy closing sheet ------------------------------------------ */
  beginSheet(null);
  {
    const fx = PAGE.margin;
    const fy = PAGE.margin;
    const fw = CW;
    const fh = FOOT_LIMIT - PAGE.margin;
    const pad = pt(40);
    const ix = fx + pad;
    const iw = fw - pad * 2;

    doc.rect(fx, fy, fw, fh).fill(h(NAVY));
    doc.image(assets.images.logoWhiteWordmark, ix, fy + pad, { height: pt(104) });

    const metaRuleY = metaGridPdf(
      ix,
      iw,
      fy + fh - pad,
      [
        { label: "Contact", lines: [view.preparedBy] },
        { label: "Email", lines: [view.contactEmail] },
        { label: "Web", lines: [FURNITURE_CLOSING_WEB] },
      ],
      {
        rule: () => doc.strokeColor("#ffffff").strokeOpacity(0.25),
        label: h(NAVY_LABEL),
        value: "#ffffff",
      }
    );
    doc.strokeOpacity(1);

    const headW = Math.min(pt(544), iw);
    const ledeW = Math.min(pt(416), iw);
    doc.font("Archivo-Bold").fontSize(pt(42));
    const headH = doc.heightOfString(view.closing.headline, {
      width: headW,
      lineGap: Math.max(0, pt(42) * 1.15 - doc.currentLineHeight()),
    });
    doc.font("Serif").fontSize(pt(16));
    const ledeH = doc.heightOfString(view.closing.lede, {
      width: ledeW,
      lineGap: Math.max(0, pt(16) * 1.6 - doc.currentLineHeight()),
    });
    const blockH = headH + pt(28) + pt(4) + pt(24) + ledeH;
    const regionTop = fy + pad + pt(104);
    let y = regionTop + Math.max(pt(24), (metaRuleY - regionTop - blockH) / 2);

    doc.font("Archivo-Bold").fontSize(pt(42)).fillColor("#ffffff");
    doc.text(view.closing.headline, ix, y, {
      width: headW,
      lineGap: Math.max(0, pt(42) * 1.15 - doc.currentLineHeight()),
    });
    y += headH + pt(28);
    bar(ix, y, h(BLUE));
    y += pt(4) + pt(24);
    doc.font("Serif").fontSize(pt(16)).fillColor(h(NAVY_LEDE));
    doc.text(view.closing.lede, ix, y, {
      width: ledeW,
      lineGap: Math.max(0, pt(16) * 1.6 - doc.currentLineHeight()),
    });
  }

  /* ---- Stamping pass: pagefoot on EVERY page, continuation kickers on
     overflow pages. All AFTER the flow so nothing can disturb the text
     state the content was written with. ---- */
  {
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      // The handoff's per-sheet footer: hairline, running title, mark.
      hairline(PAGE.margin, FOOT_RULE_Y, PAGE.margin + CW);
      caps(FURNITURE_FOOT_LEFT, PAGE.margin, FOOT_TEXT_Y, {
        px: 9,
        ls: 0.14,
        color: h(FOOTGRAY),
      });
      caps(FURNITURE_FOOT_RIGHT, PAGE.margin, FOOT_TEXT_Y, {
        px: 9,
        ls: 0.14,
        color: h(FOOTGRAY),
        width: CW,
        align: "right",
      });
      // Overflow pages carry their sheet's kicker, quietly.
      const owner = [...sheetStarts].reverse().find((s) => s.page <= i);
      if (owner && owner.page < i && owner.cont) {
        caps(`${owner.cont} · continued`, PAGE.margin, pt(40), {
          px: 9,
          ls: 0.18,
          color: h(FAINT),
        });
      }
    }
    doc.flushPages();
  }

  doc.end();
  return done;
}

export function exportFileName(view: ExportView, format: "docx" | "pdf"): string {
  const base = (view.clientName || view.proposalTitle || "rfp-response")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${base || "rfp-response"}-response.${format}`;
}
