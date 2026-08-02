// RFP response emitters: one resolved view, two formats (§5.17.1).
//
// Both emitters consume the SAME ResolvedProposal built by resolve-draft, so
// cross-format parity is structural (rule C2's premise): an emitter renders,
// it never decides. Neither does arithmetic — every pricing figure below is
// read from the stored PricingQuote the engine computed, formatted by
// formatMoney, and nothing else in either format prints a currency amount.
//
// .docx comes from the `docx` package (same as governance's emitter). PDF
// comes from pdfkit with the built-in font metrics: no Chromium, which is
// what kept PDF deferred until now — the single PM2 fork serving the public
// site must not carry a browser.
//
// STYLE: the Proposal Studio handoff's own docx mapping (RENDERING.md §2):
// Georgia stands in for Source Serif 4 and Arial for Archivo, with the
// identical hex palette — ink #15163B, navy #2F31C5, blue #3D7FD9, muted
// #5B5D78, hairline #E3E4EF, zebra #F9FAFD. The branded table (navy thead,
// white caps, alternating rows) is the centerpiece device. Vendoring OFL
// TTFs of the real faces for pdfkit is declared deferred work.

import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  HeightRule,
  Packer,
  PageNumber,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import PDFDocument from "pdfkit";
import {
  formatMoney,
  type PricingIllustration,
  type PricingQuote,
  type RateCard,
  type ResolvedProposal,
} from "./content-model";

const INK = "15163B";
const NAVY = "2F31C5";
const BLUE = "3D7FD9";
const MUTED = "5B5D78";
const ZEBRA = "F9FAFD";

export type ExportView = {
  /** True when the compliance gate, open questions, or pricing are
   *  unresolved: the file downloads anyway (owner directive: the current
   *  state is always downloadable) and SAYS what it is. */
  draft: boolean;
  coverTitle: string;
  clientName: string;
  proposalTitle: string;
  dateLabel: string;
  preparedBy: string;
  contactEmail: string;
  sections: { label: string; title: string; paragraphs: string[] }[];
  pricing: PricingQuote | null;
  minimumSentence: string | null;
};

/** The one place presentation-level pricing sentences are authored. */
export function buildExportView(
  resolved: ResolvedProposal,
  rateCard: RateCard,
  draft: boolean
): ExportView {
  const quote = resolved.pricing;
  const anyMinimum = quote?.illustrations.some((i) => i.minimumApplied) ?? false;
  return {
    draft,
    coverTitle: resolved.cover.title,
    clientName: resolved.cover.clientName,
    proposalTitle: resolved.proposal.title,
    dateLabel: resolved.cover.dateLabel,
    preparedBy: resolved.letter.signature.name,
    contactEmail: resolved.letter.signature.email,
    sections: resolved.sections.map((s) => ({
      label: s.structureLabel,
      title: s.title,
      paragraphs: s.blocks
        .filter((b) => b.kind === "prose")
        .map((b) => (b.kind === "prose" ? b.text : "")),
    })),
    pricing: quote,
    minimumSentence: anyMinimum
      ? `Where fewer than ${rateCard.minimumFullyManagedUsers} users are fully managed, the fully managed line is billed at the monthly minimum of ${formatMoney(rateCard.minimumMonthlyFee)} rather than the per-user product.`
      : null,
  };
}

const money = (m: Parameters<typeof formatMoney>[0]) => formatMoney(m);

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

const cell = (
  text: string,
  opts: { bold?: boolean; right?: boolean; head?: boolean; shade?: string } = {}
) =>
  new TableCell({
    children: [
      new Paragraph({
        alignment: opts.right ? AlignmentType.RIGHT : AlignmentType.LEFT,
        children: [
          new TextRun({
            text: opts.head ? text.toUpperCase() : text,
            bold: (opts.bold ?? false) || (opts.head ?? false),
            size: opts.head ? 17 : 20,
            font: opts.head ? "Arial" : "Georgia",
            color: opts.head ? "FFFFFF" : INK,
          }),
        ],
      }),
    ],
    shading: opts.head
      ? { fill: NAVY }
      : opts.shade
        ? { fill: opts.shade }
        : undefined,
    margins: { top: 70, bottom: 70, left: 120, right: 120 },
  });

const kicker = (text: string) =>
  new Paragraph({
    children: [
      new TextRun({
        text: text.toUpperCase().split("").join("\u200a"),
        bold: true,
        size: 16,
        font: "Arial",
        color: BLUE,
      }),
    ],
    spacing: { after: 60 },
  });

export async function renderRfpDocx(view: ExportView): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [];

  children.push(
    kicker("XL.net Proposal"),
    new Paragraph({
      children: [
        new TextRun({
          text: view.coverTitle,
          bold: true,
          size: 56,
          font: "Arial",
          color: INK,
        }),
      ],
      spacing: { after: 120 },
    }),
    ...(view.draft
      ? [
          new Paragraph({
            children: [
              new TextRun({
                text: "WORKING DRAFT · not for delivery",
                bold: true,
                size: 20,
                font: "Arial",
                color: "B45309",
              }),
            ],
            spacing: { after: 120 },
          }),
        ]
      : []),
    new Paragraph({
      children: [
        new TextRun({
          text: view.clientName,
          bold: true,
          size: 28,
          font: "Arial",
          color: INK,
        }),
      ],
      spacing: { after: 60 },
    }),
    new Paragraph({
      children: [
        new TextRun({
          text: `${view.dateLabel} · Prepared by ${view.preparedBy}, XL.net · ${view.contactEmail}`,
          size: 20,
          font: "Georgia",
          color: MUTED,
        }),
      ],
      spacing: { after: 200 },
    }),
    // The 64x4 navy accent rule, as a one-cell shaded table.
    new Table({
      width: { size: 900, type: WidthType.DXA },
      borders: {
        top: { style: BorderStyle.NONE, size: 0 },
        bottom: { style: BorderStyle.NONE, size: 0 },
        left: { style: BorderStyle.NONE, size: 0 },
        right: { style: BorderStyle.NONE, size: 0 },
        insideHorizontal: { style: BorderStyle.NONE, size: 0 },
        insideVertical: { style: BorderStyle.NONE, size: 0 },
      },
      rows: [
        new TableRow({
          height: { value: 60, rule: HeightRule.EXACT },
          children: [
            new TableCell({
              shading: { fill: NAVY },
              children: [new Paragraph({ children: [] })],
            }),
          ],
        }),
      ],
    }),
    new Paragraph({ children: [], spacing: { after: 240 } })
  );

  for (const sec of view.sections) {
    children.push(
      kicker(sec.label ? `Section ${sec.label}` : "Section"),
      new Paragraph({
        children: [
          new TextRun({
            text: sec.title,
            bold: true,
            size: 30,
            font: "Arial",
            color: INK,
          }),
        ],
        border: {
          bottom: { style: BorderStyle.SINGLE, size: 12, color: NAVY },
        },
        spacing: { before: 60, after: 160 },
      })
    );
    for (const p of sec.paragraphs)
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: p, size: 22, font: "Georgia", color: "31324C" }),
          ],
          spacing: { after: 160, line: 330 },
        })
      );
  }

  if (view.pricing) {
    children.push(
      kicker("Pricing"),
      new Paragraph({
        children: [
          new TextRun({
            text: "Investment",
            bold: true,
            size: 30,
            font: "Arial",
            color: INK,
          }),
        ],
        border: {
          bottom: { style: BorderStyle.SINGLE, size: 12, color: NAVY },
        },
        spacing: { before: 60, after: 160 },
      })
    );
    for (const ill of view.pricing.illustrations) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: ill.label,
              bold: true,
              size: 24,
              font: "Arial",
              color: INK,
            }),
          ],
          spacing: { before: 200, after: 80 },
        }),
        new Paragraph({
          children: [
            new TextRun({ text: ill.basis, size: 20, font: "Georgia", color: MUTED }),
          ],
          spacing: { after: 120 },
        })
      );
      const rows = [
        new TableRow({
          tableHeader: true,
          children: [
            cell("Service", { head: true }),
            cell("Qty", { head: true, right: true }),
            cell("Unit price", { head: true, right: true }),
            cell("Monthly", { head: true, right: true }),
          ],
        }),
        ...illustrationRows(ill).map(
          (r, i) =>
            new TableRow({
              children: [
                cell(r[0], { bold: true, shade: i % 2 ? ZEBRA : undefined }),
                cell(r[1], { right: true, shade: i % 2 ? ZEBRA : undefined }),
                cell(r[2], { right: true, shade: i % 2 ? ZEBRA : undefined }),
                cell(r[3], { right: true, shade: i % 2 ? ZEBRA : undefined }),
              ],
            })
        ),
        new TableRow({
          children: [
            cell("Monthly total", { bold: true }),
            cell(""),
            cell(""),
            cell(money(ill.monthlyTotal), { bold: true, right: true }),
          ],
        }),
        new TableRow({
          children: [
            cell("Annual total", { bold: true }),
            cell(""),
            cell(""),
            cell(money(ill.annualTotal), { bold: true, right: true }),
          ],
        }),
      ];
      children.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows,
        })
      );
    }
    if (view.minimumSentence)
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: view.minimumSentence,
              size: 20,
              font: "Georgia",
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
              bold: true,
              size: 20,
              font: "Arial",
              color: INK,
            }),
            new TextRun({ text: pt.detail, size: 20, font: "Georgia", color: "31324C" }),
          ],
          spacing: { after: 80 },
        })
      );
    for (const note of view.pricing.notes)
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: note, size: 20, font: "Georgia", color: "31324C" }),
          ],
          spacing: { after: 80 },
        })
      );
  }

  const document = new Document({
    styles: {
      default: {
        document: { run: { font: "Georgia" } },
      },
    },
    sections: [
      {
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({
                    text: view.draft ? "DRAFT · XL.net · " : "XL.net · ",
                    size: 16,
                    font: "Arial",
                    color: "8A8CA6",
                  }),
                  new TextRun({
                    children: [PageNumber.CURRENT],
                    size: 16,
                    color: "777777",
                  }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });
  return Packer.toBuffer(document);
}

/* ======================================================================== */
/* PDF                                                                      */
/* ======================================================================== */

const PAGE = { width: 612, height: 792, margin: 64 };
const CONTENT_W = PAGE.width - PAGE.margin * 2;

export async function renderRfpPdf(view: ExportView): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "LETTER",
    margins: {
      top: PAGE.margin,
      bottom: PAGE.margin,
      left: PAGE.margin,
      right: PAGE.margin,
    },
    info: { Title: `${view.clientName}: ${view.coverTitle}`, Author: "XL.net" },
    // Pages are buffered so the corner draft mark can be stamped AFTER the
    // content flow ends. Stamping from a `pageAdded` handler mutated the
    // live flow state mid-paragraph (font, size, x/y), which silently
    // rendered the rest of an auto-paginated section at 8pt.
    bufferPages: true,
  });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) =>
    doc.on("end", () => resolve(Buffer.concat(chunks)))
  );

  const ensureRoom = (needed: number) => {
    if (doc.y + needed > PAGE.height - PAGE.margin) doc.addPage();
  };

  const KICK = (t: string) => {
    doc
      .font("Helvetica-Bold")
      .fontSize(8)
      .fillColor("#3d7fd9")
      .text(t.toUpperCase(), { characterSpacing: 1.6 });
    doc.fillColor("black");
  };
  const SECHEAD = (kickText: string, title: string) => {
    ensureRoom(70);
    KICK(kickText);
    doc.moveDown(0.15);
    doc.font("Helvetica-Bold").fontSize(15).fillColor("#15163b").text(title);
    const y = doc.y + 4;
    doc
      .moveTo(PAGE.margin, y)
      .lineTo(PAGE.width - PAGE.margin, y)
      .lineWidth(1.5)
      .strokeColor("#2f31c5")
      .stroke();
    doc.fillColor("black");
    doc.y = y + 12;
    doc.x = PAGE.margin;
  };

  KICK("XL.net Proposal");
  doc.moveDown(0.2);
  doc.font("Helvetica-Bold").fontSize(24).fillColor("#15163b").text(view.coverTitle);
  doc.fillColor("black").moveDown(0.3);
  if (view.draft) {
    doc
      .font("Helvetica-Bold")
      .fontSize(10)
      .fillColor("#b45309")
      .text("WORKING DRAFT · not for delivery");
    doc.fillColor("black");
    doc.moveDown(0.3);
  }
  doc.font("Helvetica-Bold").fontSize(14).fillColor("#15163b").text(view.clientName);
  doc.fillColor("black").moveDown(0.3);
  doc
    .font("Times-Roman")
    .fontSize(10)
    .fillColor("#5b5d78")
    .text(
      `${view.dateLabel} · Prepared by ${view.preparedBy}, XL.net · ${view.contactEmail}`
    );
  doc.fillColor("black").moveDown(0.6);
  doc.rect(PAGE.margin, doc.y, 64, 4).fill("#2f31c5");
  doc.fillColor("black");
  doc.y += 24;
  doc.x = PAGE.margin;

  for (const sec of view.sections) {
    SECHEAD(sec.label ? `Section ${sec.label}` : "Section", sec.title);
    doc.font("Times-Roman").fontSize(11).fillColor("#31324c");
    for (const p of sec.paragraphs) {
      ensureRoom(40);
      doc.text(p, { width: CONTENT_W, lineGap: 2.5 });
      doc.moveDown(0.6);
    }
    doc.fillColor("black");
    doc.moveDown(0.4);
  }

  if (view.pricing) {
    SECHEAD("Pricing", "Investment");

    // Table columns: service | qty | unit price | monthly
    const cols = [CONTENT_W - 220, 50, 80, 90];
    const colX = [
      PAGE.margin,
      PAGE.margin + cols[0],
      PAGE.margin + cols[0] + cols[1],
      PAGE.margin + cols[0] + cols[1] + cols[2],
    ];

    // The handoff's branded table: navy head band with white caps, zebra
    // body rows, first column emphasized. Row backgrounds are painted
    // BEFORE the text of each row (height measured first).
    const row = (
      cells: string[],
      opts: { bold?: boolean; head?: boolean; zebra?: boolean } = {}
    ) => {
      ensureRoom(24);
      const y = doc.y;
      const font = opts.head || opts.bold ? "Helvetica-Bold" : "Times-Roman";
      const size = opts.head ? 8 : 9.5;
      doc.font(font).fontSize(size);
      let maxH = 0;
      cells.forEach((c, i) => {
        const w = cols[i] - 12;
        maxH = Math.max(
          maxH,
          doc.heightOfString(opts.head ? c.toUpperCase() : c, { width: w })
        );
      });
      const pad = 5;
      if (opts.head) {
        doc
          .rect(PAGE.margin, y - pad, CONTENT_W, maxH + pad * 2)
          .fill("#2f31c5");
      } else if (opts.zebra) {
        doc
          .rect(PAGE.margin, y - pad, CONTENT_W, maxH + pad * 2)
          .fill("#f9fafd");
      }
      cells.forEach((c, i) => {
        const w = cols[i] - 12;
        doc
          .font(i === 0 && !opts.head ? "Helvetica-Bold" : font)
          .fontSize(size)
          .fillColor(opts.head ? "#ffffff" : i === 0 ? "#15163b" : "#31324c")
          .text(opts.head ? c.toUpperCase() : c, colX[i] + 6, y, {
            width: w,
            align: i === 0 ? "left" : "right",
            ...(opts.head ? { characterSpacing: 0.8 } : {}),
          });
      });
      doc.fillColor("black");
      doc.x = PAGE.margin;
      doc.y = y + maxH + pad + 4;
    };

    for (const ill of view.pricing.illustrations) {
      ensureRoom(100);
      doc.font("Helvetica-Bold").fontSize(11).fillColor("#15163b").text(ill.label);
      doc.fillColor("black").moveDown(0.2);
      doc
        .font("Times-Roman")
        .fontSize(9.5)
        .fillColor("#5b5d78")
        .text(ill.basis, { width: CONTENT_W });
      doc.fillColor("black").moveDown(0.5);

      row(["Service", "Qty", "Unit price", "Monthly"], { head: true });
      illustrationRows(ill).forEach((r, i) => row(r, { zebra: i % 2 === 1 }));
      doc
        .moveTo(PAGE.margin, doc.y - 2)
        .lineTo(PAGE.width - PAGE.margin, doc.y - 2)
        .lineWidth(1.2)
        .strokeColor("#15163b")
        .stroke();
      row(["Monthly total", "", "", money(ill.monthlyTotal)], { bold: true });
      row(["Annual total", "", "", money(ill.annualTotal)], { bold: true });
      doc.moveDown(0.8);
    }

    doc.font("Times-Roman").fontSize(9.5).fillColor("#5b5d78");
    if (view.minimumSentence) {
      ensureRoom(30);
      doc.text(view.minimumSentence, { width: CONTENT_W });
      doc.moveDown(0.5);
    }
    doc.fillColor("black").fontSize(10);
    for (const pt of view.pricing.passThroughItems) {
      ensureRoom(24);
      doc
        .font("Helvetica-Bold")
        .fillColor("#15163b")
        .text(`${pt.label}: `, { continued: true });
      doc
        .font("Times-Roman")
        .fillColor("#31324c")
        .text(pt.detail, { width: CONTENT_W });
      doc.fillColor("black").moveDown(0.3);
    }
    for (const note of view.pricing.notes) {
      ensureRoom(30);
      doc
        .font("Times-Roman")
        .fillColor("#31324c")
        .text(note, { width: CONTENT_W });
      doc.fillColor("black").moveDown(0.3);
    }
  }

  // Stamp the corner mark on every page AFTER the flow is finished, so it
  // cannot disturb the text state the content was written with.
  if (view.draft) {
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc
        .font("Helvetica-Bold")
        .fontSize(8)
        .fillColor("#b45309")
        .text("WORKING DRAFT", PAGE.width - PAGE.margin - 90, 24, {
          width: 90,
          align: "right",
        });
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
  return `${base || "rfp-response"}-response${view.draft ? "-DRAFT" : ""}.${format}`;
}
