// Word-friendly downloads (§5.12): stored markdown -> .docx (docx npm) and
// .zip of .docx + README (jszip), generated on demand at download time and
// streamed, never stored, zero AI calls, so downloads work through every
// outage and budget cap. Markdown is parsed through the same sanitizing
// parser the doc pane uses (defense in depth: HTML stripped again here).

import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import JSZip from "jszip";
import type { GovernanceDoc, GovernanceKind } from "./types";
import { placeholderSectionMap, stubDetermined } from "./blueprints";
import type { Block, Inline } from "./markdown";
import { parseMarkdown } from "./markdown";
import {
  normalizeSectionBlocks,
  sectionTitleText,
  type NumberingStyle,
} from "./numbering";
import {
  DOCUMENT_DISCLAIMER,
  DOC_FOOTER,
  DRAFT_WATERMARK,
  KIND_LABELS,
  fileSlug,
} from "./config";
import { standardsDate } from "./standards";

function inlineRuns(inline: Inline[]): (TextRun | ExternalHyperlink)[] {
  return inline.map((x) => {
    switch (x.t) {
      case "bold":
        return new TextRun({ text: x.text, bold: true });
      case "italic":
        return new TextRun({ text: x.text, italics: true });
      case "code":
        return new TextRun({ text: x.text, font: "Consolas" });
      case "link":
        return new ExternalHyperlink({
          link: x.href,
          children: [new TextRun({ text: x.text, style: "Hyperlink" })],
        });
      default:
        return new TextRun({ text: x.text });
    }
  });
}

// Section titles are HEADING_1; normalized inner heading levels (1-4 from
// normalizeSectionBlocks) demote below them, mirroring the doc pane.
const INNER_HEADING = {
  1: HeadingLevel.HEADING_2,
  2: HeadingLevel.HEADING_3,
  3: HeadingLevel.HEADING_4,
  4: HeadingLevel.HEADING_5,
} as const;

function blockToDocx(block: Block, orderedRef: () => string): (Paragraph | Table)[] {
  switch (block.t) {
    case "heading":
      return [
        new Paragraph({
          heading: INNER_HEADING[block.level],
          children: inlineRuns(block.inline),
        }),
      ];
    case "paragraph":
      return [
        new Paragraph({ children: inlineRuns(block.inline), spacing: { after: 160 } }),
      ];
    case "list": {
      // Each ordered list gets its OWN concrete numbering instance: the docx
      // package creates one counter per reference, so a shared reference
      // makes every later list continue counting (4, 5, ...) in Word.
      const reference = block.ordered ? orderedRef() : null;
      return block.items.map(
        (item) =>
          new Paragraph({
            children: inlineRuns(item),
            ...(reference
              ? { numbering: { reference, level: 0 } }
              : { bullet: { level: 0 } }),
            spacing: { after: 60 },
          })
      );
    }
    case "table": {
      const mkRow = (cells: Inline[][], header: boolean) =>
        new TableRow({
          tableHeader: header,
          children: cells.map(
            (c) =>
              new TableCell({
                children: [
                  new Paragraph({
                    children: header
                      ? [
                          new TextRun({
                            text: c.map((x) => x.text).join(""),
                            bold: true,
                          }),
                        ]
                      : inlineRuns(c),
                  }),
                ],
              })
          ),
        });
      return [
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [mkRow(block.header, true), ...block.rows.map((r) => mkRow(r, false))],
        }),
        new Paragraph({ text: "" }),
      ];
    }
  }
}

function disclaimerParagraphs(): Paragraph[] {
  const text = DOCUMENT_DISCLAIMER.replace("{standards_date}", standardsDate());
  return text.split("\n").map(
    (line, i) =>
      new Paragraph({
        children: [
          new TextRun({
            text: line,
            bold: i === 0,
            size: i === 0 ? 28 : 20,
            color: "444444",
          }),
        ],
        spacing: { after: 100 },
      })
  );
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** One governance document -> .docx buffer. Pure and AI-free: the
 * placeholder detection below is an exact string comparison against the
 * blueprint, so downloads keep working through every outage and cap. */
export async function renderDocx(
  doc: GovernanceDoc,
  opts: {
    draft: boolean;
    kind: GovernanceKind;
    // The format sample's detected numbering style (round 15b); null =
    // decimal default. Derived by the caller from the stored sample text.
    numbering?: NumberingStyle | null;
  }
): Promise<Buffer> {
  // Sections still holding scaffold text render an explicit notice instead
  // of the template body: a customer must never mistake scaffolding for
  // drafted governance content, in draft or (belt and braces: rows confirmed
  // before this shipped) final output.
  const placeholderIds = new Set(
    placeholderSectionMap(opts.kind, [doc])[doc.slug] ?? []
  );
  const children: (Paragraph | Table)[] = [];
  const numRefs: string[] = [];
  const orderedRef = () => {
    const r = `gov-num-${numRefs.length}`;
    numRefs.push(r);
    return r;
  };

  if (opts.draft)
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: DRAFT_WATERMARK.replace("{date}", today()),
            bold: true,
            color: "B45309",
          }),
        ],
        alignment: AlignmentType.CENTER,
        border: {
          bottom: { style: BorderStyle.SINGLE, size: 4, color: "B45309" },
        },
        spacing: { after: 240 },
      })
    );

  children.push(...disclaimerParagraphs());
  children.push(new Paragraph({ text: "", pageBreakBefore: false, spacing: { after: 240 } }));
  children.push(
    new Paragraph({
      heading: HeadingLevel.TITLE,
      children: [new TextRun({ text: doc.title })],
      pageBreakBefore: true,
    })
  );
  if (doc.stub)
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            // Truthful in both stub states: before a determination is
            // recorded, this document holds only planning outlines.
            text: stubDetermined(doc)
              ? "This document is intentionally brief: based on your answers it records a determination rather than a full procedure."
              : "This document activates only if your answers show it applies. No determination has been recorded yet; its sections below are planning outlines, not drafted content.",
            italics: true,
          }),
        ],
        spacing: { after: 200 },
      })
    );

  doc.sections.forEach((section, si) => {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [
          new TextRun({
            text: sectionTitleText(si + 1, section.title, opts.numbering ?? null),
          }),
        ],
        spacing: { before: 280, after: 120 },
      })
    );
    if (placeholderIds.has(section.id)) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: "This section has not been drafted yet. Answer or revise in your project to draft it; do not rely on this section.",
              italics: true,
              color: "B45309",
            }),
          ],
          spacing: { after: 160 },
        })
      );
      return;
    }
    for (const block of normalizeSectionBlocks(
      parseMarkdown(section.markdown),
      si + 1,
      opts.numbering ?? null
    ))
      children.push(...blockToDocx(block, orderedRef));
  });

  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: DOC_FOOTER.replace("{date}", today()),
          size: 16,
          color: "777777",
        }),
      ],
      spacing: { before: 400 },
    })
  );

  const document = new Document({
    numbering: {
      // One config per ordered list encountered above, so every list
      // restarts at 1 instead of sharing a document-wide counter.
      config: numRefs.map((reference) => ({
        reference,
        levels: [
          {
            level: 0,
            format: "decimal",
            text: "%1.",
            alignment: AlignmentType.START,
          },
        ],
      })),
    },
    sections: [{ children }],
  });
  return Packer.toBuffer(document);
}

export function readmeText(opts: {
  kind: GovernanceKind;
  domain: string;
  draft: boolean;
  docs: GovernanceDoc[];
  reviewSummary: string | null;
  openConfirmCount: number;
  skippedCount: number;
}): string {
  const lines: string[] = [];
  lines.push(`${KIND_LABELS[opts.kind].name} for ${opts.domain}`);
  lines.push(`Generated ${today()} by the ai.xl.net governance assistant.`);
  if (opts.draft) lines.push(`STATUS: DRAFT. This set was downloaded before final confirmation.`);
  lines.push("");
  lines.push("Contents:");
  for (const d of opts.docs)
    lines.push(`- ${d.title}${d.stub ? " (determination only)" : ""} (${d.slug}.docx)`);
  lines.push("");
  lines.push("Gaps and next steps:");
  lines.push(
    `- Open [TO CONFIRM] items in the drafts: ${opts.openConfirmCount}. Search each document for "[TO CONFIRM" and resolve them.`
  );
  lines.push(`- Questions skipped during drafting: ${opts.skippedCount}.`);
  const undrafted = Object.entries(placeholderSectionMap(opts.kind, opts.docs))
    .flatMap(([slug, secs]) => secs.map((s) => `${slug}#${s}`));
  if (undrafted.length)
    lines.push(
      `- Sections not yet drafted (marked inside the documents): ${undrafted.length}. ${undrafted.join(", ")}.`
    );
  const stubs = opts.docs.filter((d) => d.stub);
  if (stubs.length)
    lines.push(
      `- Documents kept as determinations rather than full procedures: ${stubs.map((d) => d.slug).join(", ")}.`
    );
  // Draft READMEs only: the stored summary is review-workbench guidance
  // (since reopen it can literally say "confirm again below"), which has no
  // place in a FINAL deliverable. The documents are the deliverable.
  if (opts.reviewSummary && opts.draft) {
    lines.push("");
    lines.push("Assistant's review summary:");
    lines.push(opts.reviewSummary);
  }
  lines.push("");
  lines.push(DOCUMENT_DISCLAIMER.replace("{standards_date}", standardsDate()));
  return lines.join("\n");
}

/** Whole project -> .zip buffer (one .docx per doc + README.txt). */
export async function renderZip(opts: {
  kind: GovernanceKind;
  domain: string;
  draft: boolean;
  docs: GovernanceDoc[];
  reviewSummary: string | null;
  openConfirmCount: number;
  skippedCount: number;
  numbering?: NumberingStyle | null;
}): Promise<Buffer> {
  const zip = new JSZip();
  const suffix = opts.draft ? "-draft" : "";
  for (const doc of opts.docs) {
    const buf = await renderDocx(doc, {
      draft: opts.draft,
      kind: opts.kind,
      numbering: opts.numbering ?? null,
    });
    zip.file(`${fileSlug(doc.slug)}${suffix}.docx`, buf);
  }
  zip.file("README.txt", readmeText(opts));
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }) as Promise<Buffer>;
}
