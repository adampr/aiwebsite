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
  Footer,
  Header,
  HeadingLevel,
  LevelFormat,
  Packer,
  PageNumber,
  Paragraph,
  Tab,
  Table,
  TableCell,
  TableRow,
  TabStopType,
  TextRun,
  WidthType,
} from "docx";
import JSZip from "jszip";
import type { GovernanceDoc, GovernanceKind } from "./types";
import { placeholderSectionMap, stubDetermined } from "./blueprints";
import {
  PAGE_TOKEN,
  PAGES_TOKEN,
  TITLE_TOKEN,
  type SampleFrame,
} from "./letterhead";
import { planOutline } from "./outline";
import type { Block, Inline, ListFormat } from "./markdown";
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
  PAGE_PROVENANCE_DRAFT,
  PAGE_PROVENANCE_FINAL,
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

// The docx package's default heading styles carry NO paragraph spacing (only
// run color/size), so without explicit values inner headings sit flush
// against the text above. Stepped ladder below the section H1's 280/120;
// before ~= 2x after keeps each heading attached to the content it heads.
const INNER_HEADING_SPACING = {
  1: { before: 240, after: 120 },
  2: { before: 200, after: 100 },
  3: { before: 160, after: 80 },
  4: { before: 160, after: 80 },
} as const;

/** Per-list Word numbering config (round 19): level-0 format + literal
 * start (docx 9.7.1 copies levels[0].start into a w:startOverride on the
 * concrete instance - level 0 only, read POSITIONALLY, so level 0 must stay
 * first in the levels array), plus one optional level-1 config for ordered
 * subs. The first ordered sub's format/start wins for the whole list; later
 * mismatched subs coerce (pinned) - and a non-1 sub start applies to every
 * sibling sub-list of the reference (w:start on the abstract level is the
 * restart value; Word restarts level 1 whenever level 0 fires). */
interface OrderedNumCfg {
  format: ListFormat;
  start: number;
  sub: { format: ListFormat; start: number } | null;
}

function blockToDocx(
  block: Block,
  orderedRef: (cfg: OrderedNumCfg) => string,
  // Round 18b: sections nested under a skeleton bucket demote their inner
  // headings one Word level so the navigation-pane outline stays strict
  // (bucket H1, section H2, inner H3...).
  headingShift: 0 | 1 = 0
): (Paragraph | Table)[] {
  switch (block.t) {
    case "heading": {
      const lvl = Math.min(block.level + headingShift, 4) as 1 | 2 | 3 | 4;
      return [
        new Paragraph({
          heading: INNER_HEADING[lvl],
          children: inlineRuns(block.inline),
          spacing: INNER_HEADING_SPACING[lvl],
          keepNext: true,
        }),
      ];
    }
    case "paragraph":
      return [
        new Paragraph({ children: inlineRuns(block.inline), spacing: { after: 160 } }),
      ];
    case "list": {
      // Each ordered list gets its OWN concrete numbering instance: the docx
      // package creates one counter per reference, so a shared reference
      // makes every later list continue counting in Word. Round 19: the
      // instance starts at the model's literal first number ("4. x" after a
      // paragraph split renders 4, 5, ... - the count is never lost), letter
      // formats render as real Word upperLetter/lowerLetter numbering, and
      // ONE sub level nests at level 1 (restarting per parent item).
      const paras: Paragraph[] = [];
      const item = (children: Inline[], num: object) =>
        paras.push(
          new Paragraph({
            children: inlineRuns(children),
            ...num,
            spacing: { after: 60 },
          })
        );
      if (block.ordered) {
        const firstSub = block.items.find((it) => it.sub?.ordered)?.sub;
        const reference = orderedRef({
          format: block.format ?? "decimal",
          start: block.start ?? 1,
          sub: firstSub
            ? {
                format: firstSub.format ?? "decimal",
                start: firstSub.start ?? 1,
              }
            : null,
        });
        for (const it of block.items) {
          item(it.inline, { numbering: { reference, level: 0 } });
          for (const si of it.sub?.items ?? [])
            item(
              si,
              it.sub!.ordered
                ? { numbering: { reference, level: 1 } }
                : { bullet: { level: 1 } }
            );
        }
      } else {
        for (const it of block.items) {
          item(it.inline, { bullet: { level: 0 } });
          if (!it.sub) continue;
          if (it.sub.ordered) {
            // Per sub-RUN reference: the parent bullet never fires level 0,
            // so sharing one reference would make the SECOND ordered sub
            // continue counting instead of restarting (critic amendment).
            const subRef = orderedRef({
              format: "decimal",
              start: 1,
              sub: {
                format: it.sub.format ?? "decimal",
                start: it.sub.start ?? 1,
              },
            });
            for (const si of it.sub.items)
              item(si, { numbering: { reference: subRef, level: 1 } });
          } else {
            for (const si of it.sub.items) item(si, { bullet: { level: 1 } });
          }
        }
      }
      return paras;
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

/* ------------------------------------------------------------------ *
 * Sample letterhead (§5.12 round 17): stored header/footer text -> real
 * Word page headers/footers. Host-owned and render-time only, exactly like
 * numbering: the letterhead never rides a prompt and the model never sees
 * it. {{PAGE}}/{{PAGES}} become live fields, {{TITLE}} becomes each
 * document's own title. With no stored letterhead the output is
 * byte-identical to pre-round-17 files.
 * ------------------------------------------------------------------ */

/** One letterhead line -> TextRun children: tokens to fields, tabs to real
 * tabs (the paragraph supplies center/right tab stops). */
function frameChildren(
  line: string,
  docTitle: string
): (string | Tab | (typeof PageNumber)[keyof typeof PageNumber])[] {
  const out: (string | Tab | (typeof PageNumber)[keyof typeof PageNumber])[] =
    [];
  // Split on the three tokens and tab, keeping delimiters.
  const parts = line.split(
    /(\{\{PAGE\}\}|\{\{PAGES\}\}|\{\{TITLE\}\}|\t)/
  );
  for (const part of parts) {
    if (!part) continue;
    if (part === PAGE_TOKEN) out.push(PageNumber.CURRENT);
    else if (part === PAGES_TOKEN) out.push(PageNumber.TOTAL_PAGES);
    else if (part === TITLE_TOKEN) out.push(docTitle);
    else if (part === "\t") out.push(new Tab());
    else out.push(part);
  }
  return out;
}

function frameParagraph(line: string, docTitle: string): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({
        children: frameChildren(line, docTitle),
        size: 18,
        color: "444444",
      }),
    ],
    // Center/right stops make tab-separated letterhead segments land where
    // Word's own header layout puts them (half and full text width for the
    // default letter geometry the renderer uses).
    ...(line.includes("\t")
      ? {
          tabStops: [
            { type: TabStopType.CENTER, position: 4513 },
            { type: TabStopType.RIGHT, position: 9026 },
          ],
        }
      : {}),
  });
}

/** Page header: the sample's lines, plus a per-page DRAFT marker on draft
 * exports (page 1's watermark never reaches page 3 of a printout). */
function frameHeader(
  headerText: string,
  docTitle: string,
  draft: boolean
): Header {
  const children = headerText
    .split("\n")
    .filter(Boolean)
    .map((l) => frameParagraph(l, docTitle));
  if (draft)
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: "DRAFT", bold: true, size: 16, color: "B45309" }),
        ],
        alignment: AlignmentType.RIGHT,
      })
    );
  return new Header({ children });
}

/** Page footer: the sample's lines plus the provenance line. The
 * provenance line is renderer-appended from config, never stored, so
 * stored sample lines can never displace it (a letterheaded page without
 * it would read as a human-authored document). */
function frameFooter(
  footerText: string | null,
  docTitle: string,
  draft: boolean
): Footer {
  const children = (footerText ?? "")
    .split("\n")
    .filter(Boolean)
    .map((l) => frameParagraph(l, docTitle));
  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: draft ? PAGE_PROVENANCE_DRAFT : PAGE_PROVENANCE_FINAL,
          size: 14,
          color: "777777",
        }),
      ],
    })
  );
  return new Footer({ children });
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
    // The sample's stored letterhead (round 17); empty/null strings mean
    // no adopted frame and the output stays byte-identical to pre-17.
    letterhead?: SampleFrame | null;
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
  const numRefs: { reference: string; cfg: OrderedNumCfg }[] = [];
  const orderedRef = (cfg: OrderedNumCfg) => {
    const reference = `gov-num-${numRefs.length}`;
    numRefs.push({ reference, cfg });
    return reference;
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

  // Skeleton adoption (round 18b): with an adopted outline the export
  // renders the sample's skeleton (bucket H1, nested sections H2, inner
  // headings one level deeper), sharing the SAME plan the doc pane renders
  // from so the two can never disagree. plan null = today's flat document.
  const plan = planOutline(doc, opts.numbering ?? null);
  const rows: {
    section: (typeof doc.sections)[number] | null;
    label: string;
    nested: boolean;
    innerBase: string | null;
    flatIndex: number;
  }[] = [];
  if (!plan)
    doc.sections.forEach((section, si) =>
      rows.push({
        section,
        label: sectionTitleText(si + 1, section.title, opts.numbering ?? null),
        nested: false,
        innerBase: null,
        flatIndex: si + 1,
      })
    );
  else {
    const byId = new Map(doc.sections.map((x, i) => [x.id, { x, i }]));
    for (const e of plan) {
      if (e.sectionId === null) {
        rows.push({
          section: null,
          label: e.label,
          nested: false,
          innerBase: null,
          flatIndex: 0,
        });
        continue;
      }
      const rec = byId.get(e.sectionId);
      if (!rec) continue;
      rows.push({
        section: rec.x,
        label: e.label,
        nested: !e.top,
        innerBase: e.innerBase,
        flatIndex: rec.i + 1,
      });
    }
  }
  for (const row of rows) {
    children.push(
      new Paragraph({
        heading: row.nested ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_1,
        children: [new TextRun({ text: row.label })],
        spacing: row.nested
          ? { before: 240, after: 100 }
          : { before: 280, after: 120 },
        keepNext: true,
      })
    );
    if (!row.section) continue;
    const section = row.section;
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
      continue;
    }
    for (const block of normalizeSectionBlocks(
      parseMarkdown(section.markdown),
      row.flatIndex,
      opts.numbering ?? null,
      row.innerBase
    ))
      children.push(...blockToDocx(block, orderedRef, row.nested ? 1 : 0));
  }

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

  // Adopted letterhead (round 17): any non-empty stored line puts a real
  // header/footer on every page. A footer (with the provenance line) renders
  // whenever ANY letterhead renders: a letterheaded page must carry its
  // AI provenance on the page itself, not only in the body's final line.
  const lhHeader = opts.letterhead?.header || null;
  const lhFooter = opts.letterhead?.footer || null;
  const framed = Boolean(lhHeader || lhFooter);
  const lvlFormat = (f: ListFormat) =>
    f === "upperLetter"
      ? LevelFormat.UPPER_LETTER
      : f === "lowerLetter"
        ? LevelFormat.LOWER_LETTER
        : LevelFormat.DECIMAL;
  const document = new Document({
    numbering: {
      // One config per ordered list encountered above, so every list
      // restarts (at its own literal start) instead of sharing a
      // document-wide counter. Level 0 MUST be first in the array: docx
      // 9.7.1 reads levels[0].start positionally for the w:startOverride on
      // the concrete instance. Level-1 start rides the abstract w:start
      // (explicit - ECMA-376 defaults absent w:start to 0) and the 720/360
      // indent ladder matches the package's default bullet levels so bullet
      // and ordered subs align.
      config: numRefs.map(({ reference, cfg }) => ({
        reference,
        levels: [
          {
            level: 0,
            format: lvlFormat(cfg.format),
            text: "%1.",
            alignment: AlignmentType.START,
            start: cfg.start,
            style: { paragraph: { indent: { left: 720, hanging: 360 } } },
          },
          {
            level: 1,
            format: lvlFormat(cfg.sub?.format ?? "decimal"),
            text: "%2.",
            alignment: AlignmentType.START,
            start: cfg.sub?.start ?? 1,
            style: { paragraph: { indent: { left: 1440, hanging: 360 } } },
          },
        ],
      })),
    },
    sections: [
      {
        ...(framed
          ? {
              ...(lhHeader
                ? {
                    headers: {
                      default: frameHeader(lhHeader, doc.title, opts.draft),
                    },
                  }
                : {}),
              footers: {
                default: frameFooter(lhFooter, doc.title, opts.draft),
              },
            }
          : {}),
        children,
      },
    ],
  });
  return Packer.toBuffer(document);
}

/**
 * Download filenames derive from each doc's STORED title (letterhead/H1),
 * falling back to the immutable slug, so the saved file always matches the
 * document it contains: pre-rename projects keep ai-usage-policy.docx, new
 * ones get ai-acceptable-use-policy.docx. Deduped within a set so two docs
 * with colliding titles cannot overwrite each other inside a zip.
 */
export function docFileNames(
  docs: GovernanceDoc[],
  suffix: string
): Map<string, string> {
  const used = new Set<string>();
  const out = new Map<string, string>();
  for (const d of docs) {
    const base = fileSlug(d.title, d.slug);
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base}-${i}`;
    used.add(name);
    out.set(d.slug, `${name}${suffix}.docx`);
  }
  return out;
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
  const names = docFileNames(opts.docs, opts.draft ? "-draft" : "");
  for (const d of opts.docs)
    lines.push(`- ${d.title}${d.stub ? " (determination only)" : ""} (${names.get(d.slug)})`);
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
  letterhead?: SampleFrame | null;
}): Promise<Buffer> {
  const zip = new JSZip();
  const suffix = opts.draft ? "-draft" : "";
  const names = docFileNames(opts.docs, suffix);
  for (const doc of opts.docs) {
    const buf = await renderDocx(doc, {
      draft: opts.draft,
      kind: opts.kind,
      numbering: opts.numbering ?? null,
      letterhead: opts.letterhead ?? null,
    });
    zip.file(names.get(doc.slug)!, buf);
  }
  zip.file("README.txt", readmeText(opts));
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }) as Promise<Buffer>;
}
