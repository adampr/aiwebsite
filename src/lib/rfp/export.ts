// RFP response emitters: one resolved view, two formats (§5.17.1).
//
// Both emitters consume the SAME ResolvedProposal built by resolve-draft, so
// cross-format parity is structural (rule C2's premise): an emitter renders,
// it never decides. Neither does arithmetic — every pricing figure below is
// read from the stored PricingQuote the engine computed, formatted by
// formatMoney, and nothing else in either format prints a currency amount.
//
// .docx comes from the `docx` package (same as governance's emitter). PDF
// comes from pdfkit with the built-in Helvetica metrics: no Chromium, which
// is what kept PDF deferred until now — the single PM2 fork serving the
// public site must not carry a browser.

import {
  AlignmentType,
  Document,
  Footer,
  HeadingLevel,
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

export type ExportView = {
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
  rateCard: RateCard
): ExportView {
  const quote = resolved.pricing;
  const anyMinimum = quote?.illustrations.some((i) => i.minimumApplied) ?? false;
  return {
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

const cell = (text: string, opts: { bold?: boolean; right?: boolean } = {}) =>
  new TableCell({
    children: [
      new Paragraph({
        alignment: opts.right ? AlignmentType.RIGHT : AlignmentType.LEFT,
        children: [new TextRun({ text, bold: opts.bold ?? false, size: 20 })],
      }),
    ],
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
  });

export async function renderRfpDocx(view: ExportView): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [];

  children.push(
    new Paragraph({
      heading: HeadingLevel.TITLE,
      children: [new TextRun({ text: view.coverTitle })],
      spacing: { after: 120 },
    }),
    new Paragraph({
      children: [
        new TextRun({ text: view.clientName, bold: true, size: 28 }),
      ],
      spacing: { after: 60 },
    }),
    new Paragraph({
      children: [
        new TextRun({
          text: `${view.dateLabel} · Prepared by ${view.preparedBy}, XL.net · ${view.contactEmail}`,
          size: 20,
          color: "555555",
        }),
      ],
      spacing: { after: 400 },
    })
  );

  for (const sec of view.sections) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [
          new TextRun({
            text: sec.label ? `${sec.label}  ${sec.title}` : sec.title,
          }),
        ],
        spacing: { before: 320, after: 120 },
      })
    );
    for (const p of sec.paragraphs)
      children.push(
        new Paragraph({
          children: [new TextRun({ text: p, size: 22 })],
          spacing: { after: 160 },
        })
      );
  }

  if (view.pricing) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun({ text: "Investment" })],
        spacing: { before: 320, after: 120 },
      })
    );
    for (const ill of view.pricing.illustrations) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          children: [new TextRun({ text: ill.label })],
          spacing: { before: 200, after: 80 },
        }),
        new Paragraph({
          children: [new TextRun({ text: ill.basis, size: 20, color: "555555" })],
          spacing: { after: 120 },
        })
      );
      const rows = [
        new TableRow({
          children: [
            cell("Service", { bold: true }),
            cell("Quantity", { bold: true, right: true }),
            cell("Unit price", { bold: true, right: true }),
            cell("Monthly", { bold: true, right: true }),
          ],
        }),
        ...illustrationRows(ill).map(
          (r) =>
            new TableRow({
              children: [
                cell(r[0]),
                cell(r[1], { right: true }),
                cell(r[2], { right: true }),
                cell(r[3], { right: true }),
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
            new TextRun({ text: view.minimumSentence, size: 20, color: "555555" }),
          ],
          spacing: { before: 120, after: 120 },
        })
      );
    for (const pt of view.pricing.passThroughItems)
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: `${pt.label}: `, bold: true, size: 20 }),
            new TextRun({ text: pt.detail, size: 20 }),
          ],
          spacing: { after: 80 },
        })
      );
    for (const note of view.pricing.notes)
      children.push(
        new Paragraph({
          children: [new TextRun({ text: note, size: 20 })],
          spacing: { after: 80 },
        })
      );
  }

  const document = new Document({
    styles: {
      default: {
        document: { run: { font: "Calibri" } },
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
                  new TextRun({ text: "XL.net · ", size: 16, color: "777777" }),
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
  });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) =>
    doc.on("end", () => resolve(Buffer.concat(chunks)))
  );

  const ensureRoom = (needed: number) => {
    if (doc.y + needed > PAGE.height - PAGE.margin) doc.addPage();
  };

  doc.font("Helvetica-Bold").fontSize(22).text(view.coverTitle);
  doc.moveDown(0.3);
  doc.font("Helvetica-Bold").fontSize(14).text(view.clientName);
  doc.moveDown(0.3);
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor("#555555")
    .text(
      `${view.dateLabel} · Prepared by ${view.preparedBy}, XL.net · ${view.contactEmail}`
    );
  doc.fillColor("black").moveDown(1.5);

  for (const sec of view.sections) {
    ensureRoom(60);
    doc
      .font("Helvetica-Bold")
      .fontSize(13)
      .text(sec.label ? `${sec.label}  ${sec.title}` : sec.title);
    doc.moveDown(0.4);
    doc.font("Helvetica").fontSize(10.5);
    for (const p of sec.paragraphs) {
      ensureRoom(40);
      doc.text(p, { width: CONTENT_W, lineGap: 2 });
      doc.moveDown(0.6);
    }
    doc.moveDown(0.4);
  }

  if (view.pricing) {
    ensureRoom(80);
    doc.font("Helvetica-Bold").fontSize(13).text("Investment");
    doc.moveDown(0.5);

    // Table columns: service | qty | unit price | monthly
    const cols = [CONTENT_W - 220, 50, 80, 90];
    const colX = [
      PAGE.margin,
      PAGE.margin + cols[0],
      PAGE.margin + cols[0] + cols[1],
      PAGE.margin + cols[0] + cols[1] + cols[2],
    ];

    const row = (cells: string[], bold = false) => {
      ensureRoom(24);
      const y = doc.y;
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9);
      let maxH = 0;
      cells.forEach((c, i) => {
        const w = cols[i] - 8;
        doc.text(c, colX[i], y, {
          width: w,
          align: i === 0 ? "left" : "right",
        });
        maxH = Math.max(maxH, doc.heightOfString(c, { width: w }));
      });
      doc.x = PAGE.margin;
      doc.y = y + maxH + 6;
    };

    for (const ill of view.pricing.illustrations) {
      ensureRoom(90);
      doc.font("Helvetica-Bold").fontSize(11).text(ill.label);
      doc.moveDown(0.2);
      doc
        .font("Helvetica")
        .fontSize(9)
        .fillColor("#555555")
        .text(ill.basis, { width: CONTENT_W });
      doc.fillColor("black").moveDown(0.5);

      row(["Service", "Qty", "Unit price", "Monthly"], true);
      doc
        .moveTo(PAGE.margin, doc.y - 3)
        .lineTo(PAGE.width - PAGE.margin, doc.y - 3)
        .lineWidth(0.5)
        .strokeColor("#999999")
        .stroke();
      for (const r of illustrationRows(ill)) row(r);
      doc
        .moveTo(PAGE.margin, doc.y - 3)
        .lineTo(PAGE.width - PAGE.margin, doc.y - 3)
        .lineWidth(0.5)
        .strokeColor("#999999")
        .stroke();
      row(["Monthly total", "", "", money(ill.monthlyTotal)], true);
      row(["Annual total", "", "", money(ill.annualTotal)], true);
      doc.moveDown(0.8);
    }

    doc.font("Helvetica").fontSize(9).fillColor("#555555");
    if (view.minimumSentence) {
      ensureRoom(30);
      doc.text(view.minimumSentence, { width: CONTENT_W });
      doc.moveDown(0.5);
    }
    doc.fillColor("black").fontSize(9.5);
    for (const pt of view.pricing.passThroughItems) {
      ensureRoom(24);
      doc.font("Helvetica-Bold").text(`${pt.label}: `, { continued: true });
      doc.font("Helvetica").text(pt.detail, { width: CONTENT_W });
      doc.moveDown(0.3);
    }
    for (const note of view.pricing.notes) {
      ensureRoom(30);
      doc.font("Helvetica").text(note, { width: CONTENT_W });
      doc.moveDown(0.3);
    }
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
