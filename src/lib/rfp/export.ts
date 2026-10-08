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
  TableLayoutType,
  TableRow,
  TabStopType,
  TextRun,
  TextWrappingType,
  VerticalAlign,
  VerticalPositionRelativeFrom,
  WidthType,
} from "docx";
import JSZip from "jszip";
import PDFDocument from "pdfkit";
import {
  formatMoney,
  type Block,
  type PricingIllustration,
  type PricingQuote,
  type RateCard,
  type ResolvedProposal,
} from "./content-model";
import {
  badgeMarkIndex,
  dividerHead,
  FURNITURE_CLOSING_HEADLINE,
  FURNITURE_CLOSING_WEB,
  FURNITURE_COVER_KICKER,
  furnitureDividers,
  FURNITURE_FOOT_LEFT,
  FURNITURE_FOOT_RIGHT,
  FURNITURE_MINIMUM_CAPTION,
  FURNITURE_SUBMITTED_BY,
  FURNITURE_TABLE_HEAD,
  loadRfpExportAssets,
  sectionKicker,
  stepDotIndex,
} from "./export-assets";
import { DRAFT_BLOCK_KINDS, tableColumnFractions, type DraftBlockKind } from "./draft-blocks";
import { TILE_FIT, tileValuePx } from "./tile-fit";
import { COMPANY_SIGNATURE, SIGNATURE_COLORS } from "./signature";
import { minimumSentence, quantityLabel } from "./quote";

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
const TINT = "EEF0FB"; // tile / callout wash
const NAVY_LEDE = "D9DFF7";
const NAVY_LABEL = "9FB6F0";
const NAVY_RULE = "6365D4"; // 25% white over the navy field, precomposed
const h = (c: string) => `#${c.toLowerCase()}`;

/** A visual block as the emitters receive it: the content-model variant of
 *  one of the kinds a drafted section can store (draft-blocks.ts). */
export type ExportVisual = Extract<Block, { kind: DraftBlockKind }>;

/** One section's body in reading order: THE ordering resolve-draft took from
 *  `interleave`, so screen, PDF and Word place every block identically. */
export type ExportFlowItem =
  | { type: "p"; text: string }
  | { type: "block"; block: ExportVisual };

const isVisual = (b: Block): b is ExportVisual =>
  (DRAFT_BLOCK_KINDS as readonly string[]).includes(b.kind);

export type ExportView = {
  coverTitle: string;
  clientName: string;
  /** The resolved cover lede, when it is not the RFP form (§5.17.17). */
  coverLede?: string;
  /** The two part dividers, worded for the document's intake form. */
  dividers: ReturnType<typeof furnitureDividers>;
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
  sections: {
    label: string;
    kicker: string;
    title: string;
    /** The section's prose alone, in order (what `flow` carries as "p"). */
    paragraphs: string[];
    /** Prose and visual blocks together, in document order. Emitters render
     *  THIS; a prose-only section's flow is its paragraphs and nothing else. */
    flow: ExportFlowItem[];
  }[];
  pricing: PricingQuote | null;
  minimumSentence: string | null;
  /** The card's minimum fully managed block, for the quantity cell ("Up to 15"). */
  minimumUsers: number;
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
    ...(resolved.cover.lede ? { coverLede: resolved.cover.lede } : {}),
    dividers: furnitureDividers(resolved.intakeForm ?? "rfp"),
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
      flow: s.blocks.flatMap((b): ExportFlowItem[] =>
        b.kind === "prose"
          ? [{ type: "p", text: b.text }]
          : isVisual(b)
            ? [{ type: "block", block: b }]
            : []
      ),
    })),
    pricing: quote,
    minimumUsers: rateCard.minimumFullyManagedUsers,
    // Authored in quote.ts so the workspace's Investment sheet prints the
    // same sentence (screen = file, §5.17.5).
    minimumSentence: anyMinimum
      ? minimumSentence(
          rateCard.minimumFullyManagedUsers,
          rateCard.minimumMonthlyFee.cents
        )
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
 *  space). A resolved lede (a brief's) is printed whole. */
function coverLedeParts(
  clientName: string,
  lede?: string
): {
  before: string;
  strong: string;
  after: string;
} {
  if (lede) return { before: lede, strong: "", after: "" };
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

function illustrationRows(ill: PricingIllustration, minimumUsers: number): string[][] {
  return ill.lines.map((l) => [
    l.label,
    // Screen parity: the workspace table prints the same helper, so a line
    // at the monthly minimum reads "Up to 15" in both, never a count that
    // does not multiply to the flat fee.
    quantityLabel(l, ill, minimumUsers),
    l.unitPrice.cents === 0 ? "" : money(l.unitPrice),
    money(l.lineTotal),
  ]);
}

/* ======================================================================== */
/* Visual blocks: one spec, two emitters                                    */
/* ======================================================================== */

// Every number is CSS px on the ~648px sheet (the same unit .rfpdoc uses),
// mapped px -> pt at 0.75 by the PDF and px -> twips at 15 by Word, so the
// two files and the screen share one set of measurements. Colors are the
// palette constants above. Change a value here and both emitters move.
const VIS = {
  /** Gutter between tiles, badges, cards and timeline steps. */
  gap: 16,
  /** Extra air above a block that follows a paragraph, and the air below
   *  every block (the paragraph rhythm is ~19px of clear space). */
  before: 6,
  after: 22,
  tile: {
    pad: 18,
    rule: 3, // navy top rule
    // Archivo Bold, navy. The whole row steps down from this until its widest
    // value fits one line (tile-fit.ts tileValuePx); there is no render floor
    // (the 18px floor is the draft contract's, valueFitsTile, for NEW values).
    valuePx: TILE_FIT.designPx,
    valueLh: 1.1,
    labelGap: 8,
    labelPx: 10.5, // Archivo Medium caps, muted
    labelLs: 0.12,
    labelLh: 1.5,
    noteGap: 4,
    notePx: 10, // Archivo Medium caps, muted (the screen's .rfpdoc-tile-note)
    noteLs: 0.08,
    noteLh: 1.5,
  },
  fact: {
    colGap: 32,
    padY: 11,
    labelShare: 0.42, // of one column, gutter included
    gutter: 12,
    labelPx: 9.5, // Archivo Medium caps, muted
    labelLs: 0.1,
    labelLh: 1.3,
    valuePx: 14, // serif, ink, right-aligned
    valueLh: 1.4,
  },
  badge: {
    // One or two badges stretch across the width, as the screen's grid does.
    padY: 14,
    padX: 16,
    mark: 14, // the rotated 10px square's box
    markGap: 10,
    labelPx: 13, // Archivo Bold, ink
    labelLh: 1.25,
    noteGap: 3,
    notePx: 9.5, // Archivo Medium caps, muted
    noteLs: 0.12,
    noteLh: 1.4,
  },
  callout: {
    // tone "neutral": 3px blue left rule, 14px body in BODY; tone "emphasis":
    // 4px navy rule, 15px body in INK (the screen's .rfpdoc-callout--emphasis).
    rule: 3,
    ruleEmphasis: 4,
    padY: 16,
    padX: 20,
    titlePx: 10.5, // Archivo SemiBold caps, navy
    titleLs: 0.16,
    titleLh: 1.4,
    titleGap: 6,
    bodyPx: 14, // serif
    bodyPxEmphasis: 15,
    bodyLh: 1.6,
  },
  card: {
    padY: 18,
    padX: 20,
    titlePx: 10.5, // Archivo SemiBold caps, navy
    titleLs: 0.16,
    titleLh: 1.4,
    titleGap: 8,
    bodyPx: 13.5, // serif
    bodyLh: 1.55,
    footGap: 8,
    footPx: 12, // serif italic, muted
    footLh: 1.4,
  },
  table: {
    captionPx: 10.5, // Archivo SemiBold caps, navy
    captionLs: 0.16,
    captionLh: 1.4,
    captionGap: 8,
    // Rows are the Investment table's own: 11px caps head on navy, 13.5px
    // serif body, 12px/14px cell padding, zebra, hairlines.
  },
  timeline: {
    perRowMax: 4, // five or six steps wrap to rows of four (4+1, 4+2), as the screen's 118px grid does on a sheet
    rowGap: 18,
    dot: 12,
    ruleGap: 4,
    labelGap: 10,
    labelPx: 10, // Archivo SemiBold caps, navy
    labelLs: 0.14,
    labelLh: 1.4,
    titleGap: 5,
    titlePx: 14, // Archivo Bold, ink
    titleLh: 1.25,
    bodyGap: 5,
    bodyPx: 12.5, // serif, muted
    bodyLh: 1.5,
  },
} as const;

/** Badge mark / timeline dot colors, in asset order (export-assets). */
const MARK_COLORS = [NAVY, BLUE, INK] as const;

/** Fact-grid pairs in reading order, two to a row (the screen's 2-col grid). */
function factRows<T>(pairs: readonly T[]): [T, T | null][] {
  const rows: [T, T | null][] = [];
  for (let i = 0; i < pairs.length; i += 2) rows.push([pairs[i], pairs[i + 1] ?? null]);
  return rows;
}

/** Timeline steps chunked into rows of at most perRowMax, each step keeping its overall index. */
function timelineRows<T>(steps: readonly T[]): { step: T; index: number }[][] {
  const per = Math.max(1, Math.min(steps.length, VIS.timeline.perRowMax));
  const rows: { step: T; index: number }[][] = [];
  steps.forEach((step, index) => {
    if (index % per === 0) rows.push([]);
    rows[rows.length - 1].push({ step, index });
  });
  return rows;
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
/** A table block of at most this many rows stays on one page in both files
 *  (a reference card is four). Longer tables break between rows. */
const SHORT_TABLE_ROWS = 6;

/** px at the screen's 96dpi → docx half-points. */
const px2hp = (px: number) => Math.round(px * 1.5);
/** px → twips. */
const px2tw = (px: number) => Math.round(px * 15);
/** letterspacing in em at a px size → twips of character spacing. */
const ls2tw = (em: number, px: number) => Math.round(em * px * 15);
/** One stat tile's cell width in whole twips when a row of `n` spans the sheet. */
const docxTileTw = (n: number) => Math.floor((DXA_CONTENT - px2tw(VIS.gap) * (n - 1)) / n);

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
        const lede = coverLedeParts(view.clientName, view.coverLede);
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
    const d = view.dividers[which]!;
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

  // The branded table cell: navy head with white caps, zebra body, hairline
  // row rules, ink-ruled total rows. The Investment table and every table
  // block draw with it, so the two cannot drift apart.
  const tcell = (
    text: string,
    opts: {
      head?: boolean;
      strong?: boolean;
      right?: boolean;
      center?: boolean;
      zebra?: boolean;
      total?: boolean;
      /** Twips. Table blocks pin their columns; the Investment table does not. */
      width?: number;
      /** Keep this cell's paragraph on the page of the next one. Set on every
       *  row but the last of a short table, so Word never splits it. */
      keepNext?: boolean;
    } = {}
  ) =>
    new TableCell({
      ...(opts.width !== undefined
        ? { width: { size: opts.width, type: WidthType.DXA } }
        : {}),
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
      // The screen's 12px/14px cell padding (.rfpdoc td), the pdf's CELL_PY/CELL_PX.
      margins: { top: 180, bottom: 180, left: 210, right: 210 },
      children: [
        new Paragraph({
          ...(opts.keepNext ? { keepNext: true } : {}),
          alignment: opts.right
            ? AlignmentType.RIGHT
            : opts.center
              ? AlignmentType.CENTER
              : AlignmentType.LEFT,
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

  /* ---- Visual blocks (spec: VIS) ---------------------------------------- */
  // Everything is a table: Word has no tile, card or callout, but a shaded
  // or bordered cell IS one, and a row marked cantSplit never breaks across
  // a page, which is what keeps these blocks atomic the way the PDF's are.
  const hairB = { style: BorderStyle.SINGLE, size: 6, color: HAIR } as const;
  const tinyPar = () =>
    new Paragraph({ children: [], spacing: { line: 20, lineRule: LineRuleType.EXACT } });
  const vRun = (
    text: string,
    font: string,
    px: number,
    color: string,
    extra: { bold?: boolean; italics?: boolean } = {}
  ) => new TextRun({ text, font, size: px2hp(px), color, ...extra });
  const vCaps = (text: string, px: number, ls: number, color: string, font: string = AR_MED) =>
    new TextRun({
      text: text.toUpperCase(),
      font,
      size: px2hp(px),
      characterSpacing: ls2tw(ls, px),
      color,
    });
  const vPar = (
    runs: (TextRun | ImageRun)[],
    o: { px: number; lh: number; after?: number; right?: boolean; keepNext?: boolean }
  ) =>
    new Paragraph({
      alignment: o.right ? AlignmentType.RIGHT : AlignmentType.LEFT,
      keepNext: o.keepNext,
      children: runs,
      spacing: {
        after: px2tw(o.after ?? 0),
        line: px2tw(o.px * o.lh),
        lineRule: LineRuleType.AT_LEAST,
      },
    });
  const vCell = (
    width: number,
    content: (Paragraph | Table)[],
    o: {
      fill?: string;
      borders?: Partial<Record<"top" | "bottom" | "left" | "right", { style: (typeof BorderStyle)[keyof typeof BorderStyle]; size: number; color?: string }>>;
      margins?: { top?: number; bottom?: number; left?: number; right?: number };
      middle?: boolean;
    } = {}
  ) =>
    new TableCell({
      width: { size: width, type: WidthType.DXA },
      shading: o.fill ? { fill: o.fill } : undefined,
      borders: { ...NO_BORDERS, ...o.borders },
      margins: { top: 0, bottom: 0, left: 0, right: 0, ...o.margins },
      verticalAlign: o.middle ? VerticalAlign.CENTER : undefined,
      children: content.length ? content : [tinyPar()],
    });
  const vTable = (columnWidths: number[], rows: TableRow[]) =>
    new Table({
      width: { size: columnWidths.reduce((a, x) => a + x, 0), type: WidthType.DXA },
      layout: TableLayoutType.FIXED,
      borders: NO_BORDERS,
      columnWidths,
      rows,
    });
  const atomicRow = (cells: TableCell[]) => new TableRow({ cantSplit: true, children: cells });

  const visualDocx = (b: ExportVisual): (Paragraph | Table)[] => {
    const gap = px2tw(VIS.gap);
    switch (b.kind) {
      case "stat-tiles": {
        const T = VIS.tile;
        const n = b.tiles.length;
        const w = docxTileTw(n);
        const valuePx = tileValuePx(
          b.tiles.map((t) => t.value),
          STAT_TILE_GEOMETRY.innerPx("docx", n)
        );
        const widths: number[] = [];
        const cells: TableCell[] = [];
        b.tiles.forEach((t, i) => {
          if (i > 0) {
            widths.push(gap);
            cells.push(vCell(gap, []));
          }
          widths.push(w);
          cells.push(
            vCell(
              w,
              [
                // Half-points floored, not rounded (px2hp): an odd px (25 -> 37.5)
                // would otherwise set a third of a px LARGER than the size the
                // row was fitted at, and Word wraps a run wider than its cell.
                vPar([new TextRun({ text: t.value, font: AR_BOLD, size: Math.floor(valuePx * 1.5), color: NAVY, bold: true })], {
                  px: valuePx,
                  lh: T.valueLh,
                  after: T.labelGap,
                }),
                vPar([vCaps(t.label, T.labelPx, T.labelLs, MUTED)], {
                  px: T.labelPx,
                  lh: T.labelLh,
                  after: t.note ? T.noteGap : 0,
                }),
                ...(t.note
                  ? [vPar([vCaps(t.note, T.notePx, T.noteLs, MUTED)], { px: T.notePx, lh: T.noteLh })]
                  : []),
              ],
              {
                fill: TINT,
                borders: { top: { style: BorderStyle.SINGLE, size: T.rule * 6, color: NAVY } },
                margins: {
                  top: px2tw(T.pad),
                  bottom: px2tw(T.pad),
                  left: px2tw(T.pad),
                  right: px2tw(T.pad),
                },
              }
            )
          );
        });
        return [vTable(widths, [atomicRow(cells)])];
      }
      case "fact-grid": {
        const F = VIS.fact;
        const colGap = px2tw(F.colGap);
        const half = Math.floor((DXA_CONTENT - colGap) / 2);
        const labelW = Math.round(half * F.labelShare);
        const valueW = half - labelW;
        const pair = (p: { label: string; value: string } | null, first: boolean) => {
          if (!p) return [vCell(labelW, []), vCell(valueW, [])];
          const borders = { bottom: hairB, ...(first ? { top: hairB } : {}) };
          return [
            vCell(
              labelW,
              [vPar([vCaps(p.label, F.labelPx, F.labelLs, MUTED)], { px: F.labelPx, lh: F.labelLh })],
              {
                borders,
                // The label sits on the value's first line, not the cell top.
                margins: { top: px2tw(F.padY + 3), bottom: px2tw(F.padY), right: px2tw(F.gutter) },
              }
            ),
            vCell(
              valueW,
              [vPar([vRun(p.value, SERIF, F.valuePx, INK)], { px: F.valuePx, lh: F.valueLh, right: true })],
              { borders, margins: { top: px2tw(F.padY), bottom: px2tw(F.padY) } }
            ),
          ];
        };
        return [
          vTable(
            [labelW, valueW, colGap, labelW, valueW],
            factRows(b.pairs).map(([l, r], i) =>
              atomicRow([...pair(l, i === 0), vCell(colGap, []), ...pair(r, i === 0)])
            )
          ),
        ];
      }
      case "badge-strip": {
        const B = VIS.badge;
        const n = b.badges.length;
        const slotW = Math.floor((DXA_CONTENT - gap * (n - 1)) / n);
        const markW = px2tw(B.padX + B.mark + B.markGap);
        const textW = slotW - markW;
        const widths: number[] = [];
        const cells: TableCell[] = [];
        b.badges.forEach((badge, i) => {
          if (i > 0) {
            widths.push(gap);
            cells.push(vCell(gap, []));
          }
          widths.push(markW, textW);
          cells.push(
            // The mark and the text are two cells of one bordered box, so the
            // mark centers on the label + note pair the way the PDF draws it.
            vCell(
              markW,
              [
                new Paragraph({
                  children: [png(assets.images.badgeMarks[badgeMarkIndex(i)], B.mark, B.mark)],
                  spacing: { line: px2tw(B.mark), lineRule: LineRuleType.AT_LEAST },
                }),
              ],
              {
                borders: { top: hairB, bottom: hairB, left: hairB },
                margins: { top: px2tw(B.padY), bottom: px2tw(B.padY), left: px2tw(B.padX) },
                middle: true,
              }
            ),
            vCell(
              textW,
              [
                vPar([vRun(badge.label, AR_BOLD, B.labelPx, INK, { bold: true })], {
                  px: B.labelPx,
                  lh: B.labelLh,
                  after: badge.note ? B.noteGap : 0,
                }),
                ...(badge.note
                  ? [vPar([vCaps(badge.note, B.notePx, B.noteLs, MUTED)], { px: B.notePx, lh: B.noteLh })]
                  : []),
              ],
              {
                borders: { top: hairB, bottom: hairB, right: hairB },
                margins: { top: px2tw(B.padY), bottom: px2tw(B.padY), right: px2tw(B.padX) },
                middle: true,
              }
            )
          );
        });
        return [vTable(widths, [atomicRow(cells)])];
      }
      case "callout": {
        const C = VIS.callout;
        const emphasis = b.tone === "emphasis";
        const bodyPx = emphasis ? C.bodyPxEmphasis : C.bodyPx;
        return [
          vTable(
            [DXA_CONTENT],
            [
              atomicRow([
                vCell(
                  DXA_CONTENT,
                  [
                    ...(b.title
                      ? [
                          vPar([vCaps(b.title, C.titlePx, C.titleLs, NAVY, AR_SEMI)], {
                            px: C.titlePx,
                            lh: C.titleLh,
                            after: C.titleGap,
                          }),
                        ]
                      : []),
                    vPar([vRun(b.body, SERIF, bodyPx, emphasis ? INK : BODY)], { px: bodyPx, lh: C.bodyLh }),
                  ],
                  {
                    fill: TINT,
                    borders: {
                      left: emphasis
                        ? { style: BorderStyle.SINGLE, size: C.ruleEmphasis * 6, color: NAVY }
                        : { style: BorderStyle.SINGLE, size: C.rule * 6, color: BLUE },
                    },
                    margins: {
                      top: px2tw(C.padY),
                      bottom: px2tw(C.padY),
                      left: px2tw(C.padX),
                      right: px2tw(C.padX),
                    },
                  }
                ),
              ]),
            ]
          ),
        ];
      }
      case "cards": {
        const K = VIS.card;
        const n = Math.max(1, b.cards.length);
        const w = Math.floor((DXA_CONTENT - gap * (n - 1)) / n);
        const widths: number[] = [];
        const cells: TableCell[] = [];
        b.cards.forEach((card, i) => {
          if (i > 0) {
            widths.push(gap);
            cells.push(vCell(gap, []));
          }
          widths.push(w);
          cells.push(
            vCell(
              w,
              [
                vPar([vCaps(card.title, K.titlePx, K.titleLs, NAVY, AR_SEMI)], {
                  px: K.titlePx,
                  lh: K.titleLh,
                  after: K.titleGap,
                }),
                vPar([vRun(card.body, SERIF, K.bodyPx, BODY)], {
                  px: K.bodyPx,
                  lh: K.bodyLh,
                  after: card.footnote ? K.footGap : 0,
                }),
                ...(card.footnote
                  ? [
                      vPar([vRun(card.footnote, SERIF_ITAL, K.footPx, MUTED, { italics: true })], {
                        px: K.footPx,
                        lh: K.footLh,
                      }),
                    ]
                  : []),
              ],
              {
                borders: { top: hairB, bottom: hairB, left: hairB, right: hairB },
                margins: {
                  top: px2tw(K.padY),
                  bottom: px2tw(K.padY),
                  left: px2tw(K.padX),
                  right: px2tw(K.padX),
                },
              }
            )
          );
        });
        return [vTable(widths, [atomicRow(cells)])];
      }
      case "table": {
        const fr = tableColumnFractions(b);
        const widths = fr.map((f) => Math.round(f * DXA_CONTENT));
        // Rounding residue lands on the last column so the grid is the page width.
        widths[widths.length - 1] += DXA_CONTENT - widths.reduce((a, x) => a + x, 0);
        const align = (c: number) => ({
          right: b.columns[c].align === "right",
          center: b.columns[c].align === "center",
          width: widths[c],
        });
        const last = b.rows.length - 1;
        // A short table (a reference card is four rows) stays whole: every
        // row's paragraphs keep with the next row, the last row's do not.
        // A long table still breaks between rows under its repeated head.
        const whole = b.rows.length > 0 && b.rows.length <= SHORT_TABLE_ROWS;
        return [
          ...(b.caption
            ? [
                vPar([vCaps(b.caption, VIS.table.captionPx, VIS.table.captionLs, NAVY, AR_SEMI)], {
                  px: VIS.table.captionPx,
                  lh: VIS.table.captionLh,
                  after: VIS.table.captionGap,
                  keepNext: true,
                }),
              ]
            : []),
          new Table({
            width: { size: DXA_CONTENT, type: WidthType.DXA },
            layout: TableLayoutType.FIXED,
            borders: NO_BORDERS,
            columnWidths: widths,
            rows: [
              // The head row repeats on every page the table reaches.
              new TableRow({
                tableHeader: true,
                cantSplit: true,
                children: b.columns.map((col, c) =>
                  tcell(col.header, { head: true, keepNext: whole, ...align(c) })
                ),
              }),
              ...b.rows.map(
                (r, i) =>
                  new TableRow({
                    cantSplit: true,
                    children: b.columns.map((_, c) =>
                      tcell(r[c] ?? "", {
                        strong: c === 0,
                        zebra: i % 2 === 1 && !(b.emphasizeLastRow && i === last),
                        total: b.emphasizeLastRow && i === last,
                        keepNext: whole && i < last,
                        ...align(c),
                      })
                    ),
                  })
              ),
            ],
          }),
        ];
      }
      case "timeline": {
        const L = VIS.timeline;
        const rows = timelineRows(b.steps);
        const per = rows[0]?.length ?? 1;
        const colW = Math.floor((DXA_CONTENT - gap * (per - 1)) / per);
        // Each column but the last carries the gutter as its right margin, so
        // the connector can run to the column's own edge.
        const widths = Array.from({ length: per }, (_, c) => (c < per - 1 ? colW + gap : colW));
        return [
          vTable(
            widths,
            rows.map((row, ri) =>
              atomicRow(
                widths.map((w, c) => {
                  const cell = row[c];
                  if (!cell) return vCell(w, []);
                  const { step, index } = cell;
                  const joins = c < row.length - 1;
                  return vCell(
                    w,
                    [
                      new Paragraph({
                        children: [
                          png(assets.images.stepDots[stepDotIndex(index, b.steps.length)], L.dot, L.dot),
                          ...(joins
                            ? [
                                new TextRun({ text: " ", size: 8 }),
                                png(assets.images.stepRule, Math.floor(colW / 15) - L.dot - 8, L.dot),
                              ]
                            : []),
                        ],
                        spacing: {
                          after: px2tw(L.labelGap),
                          line: px2tw(L.dot),
                          lineRule: LineRuleType.AT_LEAST,
                        },
                      }),
                      vPar([vCaps(step.label, L.labelPx, L.labelLs, NAVY, AR_SEMI)], {
                        px: L.labelPx,
                        lh: L.labelLh,
                        after: L.titleGap,
                      }),
                      vPar([vRun(step.title, AR_BOLD, L.titlePx, INK, { bold: true })], {
                        px: L.titlePx,
                        lh: L.titleLh,
                        after: L.bodyGap,
                      }),
                      vPar([vRun(step.body, SERIF, L.bodyPx, MUTED)], { px: L.bodyPx, lh: L.bodyLh }),
                    ],
                    {
                      margins: {
                        top: ri > 0 ? px2tw(L.rowGap) : 0,
                        right: c < per - 1 ? gap : 0,
                      },
                    }
                  );
                })
              )
            )
          ),
        ];
      }
      default: {
        const unhandled: never = b;
        throw new Error(`Unhandled visual block: ${JSON.stringify(unhandled)}`);
      }
    }
  };

  /** One section's body: prose as before, each visual with its own air. */
  const sectionFlow = (flowItems: ExportFlowItem[]) => {
    let prev: "head" | "p" | "block" = "head";
    for (const item of flowItems) {
      if (item.type === "p") children.push(bodyPar(item.text));
      else {
        if (prev === "p") children.push(spacerX(px2tw(VIS.before)));
        // The spacer also keeps two adjacent tables from fusing into one.
        children.push(...visualDocx(item.block), spacerX(px2tw(VIS.after)));
      }
      prev = item.type;
    }
  };

  dividerSheet(0);
  for (const sec of view.sections) {
    secHead(sec.kicker, sec.title);
    sectionFlow(sec.flow);
  }
  // Divider 02 announces the Investment part; with no quote there is no
  // part to announce, so both are omitted together (same rule as the PDF).
  if (view.pricing) {
    dividerSheet(1);
    secHead("Pricing", "Investment");

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
            ...illustrationRows(ill, view.minimumUsers).map(
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
/** One stat tile's width in pt when a row of `n` spans the sheet. */
const pdfTileW = (n: number) => (CW - pt(VIS.gap) * (n - 1)) / n;

/**
 * The stat-tile row geometry both files lay out, in px. Each emitter sizes a
 * row's values from `innerPx` (a tile less its padding, measured the way that
 * emitter measures the tile), so this is what tile-fit's arithmetic has to
 * match: test:rfptilefit pins every field to TILE_FIT and fileTileInnerPx.
 */
export const STAT_TILE_GEOMETRY = {
  sheetPx: { docx: DXA_CONTENT / 15, pdf: CW / 0.75 },
  gapPx: VIS.gap,
  padPx: VIS.tile.pad,
  designPx: VIS.tile.valuePx,
  innerPx: (format: "docx" | "pdf", n: number): number =>
    (format === "docx" ? docxTileTw(n) / 15 : pdfTileW(n) / 0.75) - VIS.tile.pad * 2,
} as const;

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
    // A brief's cover title already names the client ("Proposal for X").
    info: {
      Title: view.coverTitle.startsWith("Proposal for ")
        ? view.coverTitle
        : `${view.clientName}: ${view.coverTitle}`,
      Author: "XL.net",
    },
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
    const lede = coverLedeParts(view.clientName, view.coverLede);
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
    const d = view.dividers[which]!;
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


  /* ---- The branded table -------------------------------------------------
     Navy head band with white letterspaced caps, zebra body rows,
     emphasized first column, hairline row rules, ink-ruled total rows. Row
     backgrounds paint BEFORE the text (height measured first). One factory
     serves the Investment sheet and every table block: `cols` are point
     widths, `aligns` per column, `stepDown(i)` names the columns whose text
     never character-wraps mid-figure (the size steps down until the string
     fits its column on one line). measure() sets no ink, so a caller may
     measure, make room, then paint at doc.y. */
  type RowOpts = { head?: boolean; zebra?: boolean; total?: boolean };
  type RowMeasure = { rowH: number; cellSizes: number[]; csp: number };
  const brandedTable = (
    cols: number[],
    aligns: ("left" | "right" | "center")[],
    o: { stepDown: (i: number) => boolean }
  ) => {
    const colX = cols.map((_, i) => PAGE.margin + cols.slice(0, i).reduce((a, w) => a + w, 0));
    const CELL_PX = pt(14); // 14px side padding
    const CELL_PY = pt(12); // 12px vertical padding
    const cellFont = (i: number, opts: RowOpts) =>
      opts.head
        ? "Archivo-SemiBold"
        : i === 0 || opts.total
          ? "Serif-SemiBold"
          : "Serif";
    const measure = (cells: string[], opts: RowOpts = {}): RowMeasure => {
      const size = opts.head ? pt(11) : pt(13.5);
      const csp = opts.head ? 0.1 * size : 0;
      const cellSizes = cells.map((c, i) => {
        if (opts.head || i === 0 || !c || !o.stepDown(i)) return size;
        let sz = size;
        doc.font(cellFont(i, opts));
        while (
          sz > 6.5 &&
          doc.fontSize(sz).widthOfString(c) > cols[i] - CELL_PX * 2
        )
          sz -= 0.5;
        return sz;
      });
      let maxH = 0;
      cells.forEach((c, i) => {
        doc.font(cellFont(i, opts)).fontSize(cellSizes[i]);
        maxH = Math.max(
          maxH,
          doc.heightOfString(opts.head ? c.toUpperCase() : c || " ", {
            width: cols[i] - CELL_PX * 2,
            characterSpacing: csp,
          })
        );
      });
      return { rowH: maxH + CELL_PY * 2, cellSizes, csp };
    };
    const paint = (cells: string[], opts: RowOpts, m: RowMeasure) => {
      const y = doc.y;
      const { rowH, cellSizes, csp } = m;
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
          .font(cellFont(i, opts))
          .fontSize(cellSizes[i])
          .fillColor(
            opts.head ? "#ffffff" : i === 0 || opts.total ? h(INK) : h(BODY)
          )
          .text(opts.head ? c.toUpperCase() : c, colX[i] + CELL_PX, y + CELL_PY, {
            width: cols[i] - CELL_PX * 2,
            align: aligns[i],
            characterSpacing: csp,
          });
      });
      doc.fillColor("black");
      doc.x = PAGE.margin;
      doc.y = y + rowH;
      if (!opts.head && !opts.total) hairline(PAGE.margin, doc.y, PAGE.margin + CW);
    };
    return { measure, paint };
  };

  /* ---- Visual blocks (spec: VIS) ----------------------------------------
     Every block is measured first, given room with ensureRoom, then drawn at
     explicit coordinates: pdfkit's auto-pagination never runs inside one.
     Tiles, badges, a callout, cards and a timeline row are atomic; a table
     paginates row by row with its head row repeated; a fact grid breaks
     between rows only when it cannot fit a page whole. */
  type TextSpec = {
    text: string;
    font: string;
    px: number;
    lh: number;
    color: string;
    ls?: number;
    upper?: boolean;
    align?: "left" | "right" | "center";
    /** Set on one line, never wrapped: pdfkit wraps only when handed a width,
     *  so a oneLine spec is drawn and measured without one (left-aligned). */
    oneLine?: boolean;
  };
  const setSpec = (t: TextSpec) => {
    const size = pt(t.px);
    doc.font(t.font).fontSize(size);
    return {
      csp: (t.ls ?? 0) * size,
      gap: Math.max(0, size * t.lh - doc.currentLineHeight()),
      str: t.upper ? t.text.toUpperCase() : t.text,
    };
  };
  /** pdfkit's wrap options for a spec: a width to wrap at, or none at all. */
  const wrapAt = (t: TextSpec, width: number) =>
    t.oneLine ? { lineBreak: false as const } : { width };
  /** Height of the ink box (heightOfString counts a trailing lineGap; dropped). */
  const textH = (t: TextSpec, width: number) => {
    const { csp, gap, str } = setSpec(t);
    return doc.heightOfString(str, { ...wrapAt(t, width), characterSpacing: csp, lineGap: gap }) - gap;
  };
  const textAt = (t: TextSpec, x: number, y: number, width: number) => {
    const { csp, gap, str } = setSpec(t);
    doc.fillColor(t.color).text(str, x, y, {
      ...wrapAt(t, width),
      characterSpacing: csp,
      lineGap: gap,
      align: t.align ?? "left",
    });
  };
  const capsSpec = (
    text: string,
    px: number,
    ls: number,
    color: string,
    lh: number,
    font: string = "Archivo-Medium"
  ): TextSpec => ({
    text,
    font,
    px,
    lh,
    color,
    ls,
    upper: true,
  });
  const boxStroke = (x: number, y: number, w: number, hgt: number) =>
    doc.rect(x, y, w, hgt).lineWidth(0.75).strokeColor(h(HAIR)).stroke();
  /** The badge mark: a rotated square filling a `box`-px square's diagonal. */
  const badgeMark = (cx: number, cy: number, box: number, color: string) => {
    const r = pt(box) / 2;
    doc
      .moveTo(cx, cy - r)
      .lineTo(cx + r, cy)
      .lineTo(cx, cy + r)
      .lineTo(cx - r, cy)
      .closePath()
      .fill(color);
  };
  const G = pt(VIS.gap);

  const visualPdf = (b: ExportVisual) => {
    const x0 = PAGE.margin;
    switch (b.kind) {
      case "stat-tiles": {
        const T = VIS.tile;
        const n = b.tiles.length;
        const w = pdfTileW(n);
        const inner = w - pt(T.pad) * 2;
        const valuePx = tileValuePx(b.tiles.map((t) => t.value), STAT_TILE_GEOMETRY.innerPx("pdf", n));
        // oneLine: the size above already fits; if that arithmetic were ever
        // off, the figure runs a hair past its tile rather than onto a second line.
        const specs = b.tiles.map((t) => ({
          value: { text: t.value, font: "Archivo-Bold", px: valuePx, lh: T.valueLh, color: h(NAVY), oneLine: true } as TextSpec,
          label: capsSpec(t.label, T.labelPx, T.labelLs, h(MUTED), T.labelLh),
          note: t.note ? capsSpec(t.note, T.notePx, T.noteLs, h(MUTED), T.noteLh) : null,
        }));
        const heights = specs.map(
          (sp) =>
            pt(T.pad) * 2 +
            textH(sp.value, inner) +
            pt(T.labelGap) +
            textH(sp.label, inner) +
            (sp.note ? pt(T.noteGap) + textH(sp.note, inner) : 0)
        );
        const blockH = Math.max(...heights);
        ensureRoom(blockH);
        const y0 = doc.y;
        specs.forEach((sp, i) => {
          const x = x0 + i * (w + G);
          doc.rect(x, y0, w, blockH).fill(h(TINT));
          doc.rect(x, y0, w, pt(T.rule)).fill(h(NAVY));
          let y = y0 + pt(T.pad);
          textAt(sp.value, x + pt(T.pad), y, inner);
          y += textH(sp.value, inner) + pt(T.labelGap);
          textAt(sp.label, x + pt(T.pad), y, inner);
          if (sp.note) {
            y += textH(sp.label, inner) + pt(T.noteGap);
            textAt(sp.note, x + pt(T.pad), y, inner);
          }
        });
        doc.y = y0 + blockH;
        break;
      }
      case "fact-grid": {
        const F = VIS.fact;
        const half = (CW - pt(F.colGap)) / 2;
        const labelW = half * F.labelShare;
        const valueW = half - labelW;
        const rows = factRows(b.pairs).map(([l, r]) =>
          [l, r].map((p) =>
            p
              ? {
                  label: capsSpec(p.label, F.labelPx, F.labelLs, h(MUTED), F.labelLh),
                  value: { text: p.value, font: "Serif", px: F.valuePx, lh: F.valueLh, color: h(INK), align: "right" } as TextSpec,
                }
              : null
          )
        );
        const rowHs = rows.map(
          (row) =>
            pt(F.padY) * 2 +
            Math.max(
              ...row.map((p) =>
                p ? Math.max(textH(p.label, labelW - pt(F.gutter)), textH(p.value, valueW)) : 0
              )
            )
        );
        const total = rowHs.reduce((a, v) => a + v, 0);
        // Whole when it fits a page; otherwise row by row, never mid-row.
        if (total <= FOOT_LIMIT - PAGE.margin) ensureRoom(total);
        rows.forEach((row, ri) => {
          ensureRoom(rowHs[ri]);
          const y = doc.y;
          row.forEach((p, c) => {
            if (!p) return;
            const cx = x0 + c * (half + pt(F.colGap));
            if (ri === 0) hairline(cx, y, cx + half);
            // The label sits on the value's first line.
            textAt(p.label, cx, y + pt(F.padY) + pt(3), labelW - pt(F.gutter));
            textAt(p.value, cx + labelW, y + pt(F.padY), valueW);
            hairline(cx, y + rowHs[ri], cx + half);
          });
          doc.y = y + rowHs[ri];
        });
        break;
      }
      case "badge-strip": {
        const B = VIS.badge;
        const n = b.badges.length;
        const slotW = (CW - G * (n - 1)) / n;
        const textX = pt(B.padX + B.mark + B.markGap);
        const textW = slotW - textX - pt(B.padX);
        const specs = b.badges.map((badge) => ({
          label: { text: badge.label, font: "Archivo-Bold", px: B.labelPx, lh: B.labelLh, color: h(INK) } as TextSpec,
          note: badge.note ? capsSpec(badge.note, B.notePx, B.noteLs, h(MUTED), B.noteLh) : null,
        }));
        const heights = specs.map(
          (sp) => pt(B.padY) * 2 + textH(sp.label, textW) + (sp.note ? pt(B.noteGap) + textH(sp.note, textW) : 0)
        );
        const blockH = Math.max(...heights);
        ensureRoom(blockH);
        const y0 = doc.y;
        specs.forEach((sp, i) => {
          const x = x0 + i * (slotW + G);
          boxStroke(x, y0, slotW, blockH);
          badgeMark(x + pt(B.padX) + pt(B.mark) / 2, y0 + blockH / 2, B.mark, h(MARK_COLORS[badgeMarkIndex(i)]));
          const contentH = heights[i] - pt(B.padY) * 2;
          let y = y0 + (blockH - contentH) / 2;
          textAt(sp.label, x + textX, y, textW);
          if (sp.note) {
            y += textH(sp.label, textW) + pt(B.noteGap);
            textAt(sp.note, x + textX, y, textW);
          }
        });
        doc.y = y0 + blockH;
        break;
      }
      case "callout": {
        const C = VIS.callout;
        const emphasis = b.tone === "emphasis";
        const rule = emphasis ? C.ruleEmphasis : C.rule;
        const innerX = pt(rule) + pt(C.padX);
        const innerW = CW - innerX - pt(C.padX);
        const title = b.title ? capsSpec(b.title, C.titlePx, C.titleLs, h(NAVY), C.titleLh, "Archivo-SemiBold") : null;
        const body: TextSpec = {
          text: b.body,
          font: "Serif",
          px: emphasis ? C.bodyPxEmphasis : C.bodyPx,
          lh: C.bodyLh,
          color: h(emphasis ? INK : BODY),
        };
        const titleH = title ? textH(title, innerW) + pt(C.titleGap) : 0;
        const blockH = pt(C.padY) * 2 + titleH + textH(body, innerW);
        ensureRoom(blockH);
        const y0 = doc.y;
        doc.rect(x0, y0, CW, blockH).fill(h(TINT));
        doc.rect(x0, y0, pt(rule), blockH).fill(h(emphasis ? NAVY : BLUE));
        if (title) textAt(title, x0 + innerX, y0 + pt(C.padY), innerW);
        textAt(body, x0 + innerX, y0 + pt(C.padY) + titleH, innerW);
        doc.y = y0 + blockH;
        break;
      }
      case "cards": {
        const K = VIS.card;
        const n = Math.max(1, b.cards.length);
        const w = (CW - G * (n - 1)) / n;
        const inner = w - pt(K.padX) * 2;
        const specs = b.cards.map((card) => ({
          title: capsSpec(card.title, K.titlePx, K.titleLs, h(NAVY), K.titleLh, "Archivo-SemiBold"),
          body: { text: card.body, font: "Serif", px: K.bodyPx, lh: K.bodyLh, color: h(BODY) } as TextSpec,
          foot: card.footnote
            ? ({ text: card.footnote, font: "Serif-Italic", px: K.footPx, lh: K.footLh, color: h(MUTED) } as TextSpec)
            : null,
        }));
        const heights = specs.map(
          (sp) =>
            pt(K.padY) * 2 +
            textH(sp.title, inner) +
            pt(K.titleGap) +
            textH(sp.body, inner) +
            (sp.foot ? pt(K.footGap) + textH(sp.foot, inner) : 0)
        );
        const blockH = Math.max(...heights);
        ensureRoom(blockH);
        const y0 = doc.y;
        specs.forEach((sp, i) => {
          const x = x0 + i * (w + G);
          boxStroke(x, y0, w, blockH);
          let y = y0 + pt(K.padY);
          textAt(sp.title, x + pt(K.padX), y, inner);
          y += textH(sp.title, inner) + pt(K.titleGap);
          textAt(sp.body, x + pt(K.padX), y, inner);
          if (sp.foot) {
            y += textH(sp.body, inner) + pt(K.footGap);
            textAt(sp.foot, x + pt(K.padX), y, inner);
          }
        });
        doc.y = y0 + blockH;
        break;
      }
      case "table": {
        const fr = tableColumnFractions(b);
        const cols = fr.map((f) => f * CW);
        const tbl = brandedTable(cols, b.columns.map((c) => c.align), { stepDown: () => false });
        const heads = b.columns.map((c) => c.header);
        const headM = tbl.measure(heads, { head: true });
        const caption = b.caption
          ? capsSpec(b.caption, VIS.table.captionPx, VIS.table.captionLs, h(NAVY), VIS.table.captionLh, "Archivo-SemiBold")
          : null;
        const captionH = caption ? textH(caption, CW) + pt(VIS.table.captionGap) : 0;
        const firstM = tbl.measure(b.rows[0] ?? heads, { zebra: false });
        const last = b.rows.length - 1;
        const rowOpts = (i: number): RowOpts => ({
          zebra: i % 2 === 1,
          total: b.emphasizeLastRow && i === last,
        });
        // A short table (a reference card is four rows) never splits: every
        // row is measured up front and the whole table moves to the next
        // page when it does not fit here. One taller than a page falls back
        // to the row loop below, like a long table.
        const wholeH =
          b.rows.length > 0 && b.rows.length <= SHORT_TABLE_ROWS
            ? captionH +
              headM.rowH +
              b.rows.reduce((sum, r, i) => sum + tbl.measure(r, rowOpts(i)).rowH, 0)
            : null;
        // Otherwise caption, head and first row start together.
        ensureRoom(
          wholeH !== null && wholeH <= FOOT_LIMIT - PAGE.margin
            ? wholeH
            : captionH + headM.rowH + firstM.rowH
        );
        if (caption) {
          textAt(caption, x0, doc.y, CW);
          doc.y += captionH;
        }
        tbl.paint(heads, { head: true }, headM);
        b.rows.forEach((r, i) => {
          const opts = rowOpts(i);
          const m = tbl.measure(r, opts);
          if (doc.y + m.rowH > FOOT_LIMIT) {
            // A row never splits; the head row repeats on the new page.
            doc.addPage();
            doc.x = PAGE.margin;
            doc.y = PAGE.margin;
            tbl.paint(heads, { head: true }, headM);
          }
          tbl.paint(r, opts, m);
        });
        break;
      }
      case "timeline": {
        const L = VIS.timeline;
        const rows = timelineRows(b.steps);
        const per = rows[0]?.length ?? 1;
        const colW = (CW - G * (per - 1)) / per;
        rows.forEach((row, ri) => {
          const specs = row.map(({ step, index }) => ({
            index,
            label: capsSpec(step.label, L.labelPx, L.labelLs, h(NAVY), L.labelLh, "Archivo-SemiBold"),
            title: { text: step.title, font: "Archivo-Bold", px: L.titlePx, lh: L.titleLh, color: h(INK) } as TextSpec,
            body: { text: step.body, font: "Serif", px: L.bodyPx, lh: L.bodyLh, color: h(MUTED) } as TextSpec,
          }));
          const labelH = Math.max(...specs.map((sp) => textH(sp.label, colW)));
          const titleH = Math.max(...specs.map((sp) => textH(sp.title, colW)));
          const bodyH = Math.max(...specs.map((sp) => textH(sp.body, colW)));
          const rowH =
            (ri > 0 ? pt(L.rowGap) : 0) +
            pt(L.dot) + pt(L.labelGap) + labelH + pt(L.titleGap) + titleH + pt(L.bodyGap) + bodyH;
          ensureRoom(rowH);
          const y0 = doc.y + (ri > 0 ? pt(L.rowGap) : 0);
          specs.forEach((sp, c) => {
            const x = x0 + c * (colW + G);
            const r = pt(L.dot) / 2;
            doc.circle(x + r, y0 + r, r).fill(h(MARK_COLORS[stepDotIndex(sp.index, b.steps.length)]));
            if (c < row.length - 1) hairline(x + pt(L.dot) + pt(L.ruleGap), y0 + r, x + colW + G - pt(L.ruleGap));
            let y = y0 + pt(L.dot) + pt(L.labelGap);
            textAt(sp.label, x, y, colW);
            y += labelH + pt(L.titleGap);
            textAt(sp.title, x, y, colW);
            y += titleH + pt(L.bodyGap);
            textAt(sp.body, x, y, colW);
          });
          doc.y = doc.y + rowH;
        });
        break;
      }
      default: {
        const unhandled: never = b;
        throw new Error(`Unhandled visual block: ${JSON.stringify(unhandled)}`);
      }
    }
    doc.fillColor("black");
    doc.x = PAGE.margin;
  };

  dividerSheet(0);
  for (const sec of view.sections) {
    beginSheet(sec.kicker);
    secHead(sec.kicker, sec.title);
    let prev: "head" | "p" | "block" = "head";
    for (const item of sec.flow) {
      if (item.type === "p") {
        ensureRoom(40);
        flow(item.text, { px: 15, lh: 1.68 });
        doc.moveDown(0.65);
      } else {
        if (prev === "p") doc.y += pt(VIS.before);
        visualPdf(item.block);
        doc.y += pt(VIS.after);
      }
      prev = item.type;
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
    // The quantity column is 66pt, not 50: "Up to 15" (the fully managed
    // line at the monthly minimum) must set at the full body size, and at
    // 50pt the step-down guard below shrank that one cell to about 70%.
    const table = brandedTable([CW - 226, 66, 70, 90], ["left", "right", "right", "right"], {
      stepDown: (i) => i > 0,
    });
    const row = (
      cells: string[],
      opts: { head?: boolean; zebra?: boolean; total?: boolean } = {}
    ) => {
      ensureRoom(30);
      table.paint(cells, opts, table.measure(cells, opts));
    };

    for (const ill of view.pricing.illustrations) {
      ensureRoom(120);
      doc.x = PAGE.margin;
      doc.font("Archivo-Bold").fontSize(pt(15)).fillColor(h(INK)).text(ill.label, { width: CW });
      doc.moveDown(0.15);
      flow(ill.basis, { px: 14, lh: 1.5, color: h(MUTED) });
      doc.moveDown(0.5);

      row([...FURNITURE_TABLE_HEAD], { head: true });
      illustrationRows(ill, view.minimumUsers).forEach((r, i) => row(r, { zebra: i % 2 === 1 }));
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
