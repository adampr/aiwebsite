/**
 * The block vocabulary — a CLOSED set.
 *
 * DATA-MODEL.md: "Emitters implement exactly these variants and nothing else; a new content shape
 * requires adding a variant here first and implementing it in all three emitters, which is the
 * point. An open-ended 'html' escape hatch would reintroduce every drift bug this design exists to
 * prevent, so there is not one."
 *
 * Note what is absent: no color, no font size, no padding, no className. A CalloutBlock says
 * *this is a callout*; the HTML emitter knows callouts are wash-background with a 4px left border
 * and the docx emitter knows they are a one-cell table with a left border of size 24.
 */

export type BlockKind = Block["kind"];

export type BlockBase = {
  id: string;
  sectionId: string;
  ordinal: number;
  /** Fact.id[] — every factual claim in this block. The C1 staleness query joins on this. */
  cites: string[];
  generatedBy: "llm" | "human" | "system";
  editedByHuman: boolean;
};

/**
 * Plain text. Inline emphasis is deliberately unsupported in v1: it is the single most common
 * source of markup leaking between formats, and the reference proposal does not use it.
 */
export type ProseBlock = BlockBase & { kind: "prose"; text: string };

export type HeadingBlock = BlockBase & { kind: "heading"; level: 2 | 3; text: string };

export type ListBlock = BlockBase & {
  kind: "list";
  style: "bullet" | "number";
  items: string[];
};

export type StatTile = { value: string; label: string; note?: string };

export type StatTileRowBlock = BlockBase & {
  kind: "stat-tiles";
  /**
   * 2 to 6. The grid is three columns wide and wraps, so this is a tile GRID rather than strictly
   * a row: DATA-MODEL.md says "2-4 per row" and the reference proposal's incident-response block
   * carries six (the ISO 27001 phases) across two rows. The emitter owns the column count.
   */
  tiles: StatTile[];
};

export type TableColumn = { header: string; align: "left" | "right" | "center" };

export type BrandedTableBlock = BlockBase & {
  kind: "table";
  caption: string | null;
  columns: TableColumn[];
  rows: string[][];
  /** Totals row gets the emphasis treatment in every emitter. */
  emphasizeLastRow: boolean;
};

export type FactGridBlock = BlockBase & {
  kind: "fact-grid";
  pairs: { label: string; value: string }[];
};

export type CalloutBlock = BlockBase & {
  kind: "callout";
  title: string | null;
  body: string;
  tone: "neutral" | "emphasis";
};

export type PullQuoteBlock = BlockBase & {
  kind: "pull-quote";
  text: string;
  attribution: string | null;
};

export type TimelineBlock = BlockBase & {
  kind: "timeline";
  steps: { label: string; title: string; body: string }[];
};

export type CardsBlock = BlockBase & {
  kind: "cards";
  cards: { title: string; body: string; footnote?: string }[];
};

export type DividerPageBlock = BlockBase & {
  kind: "divider";
  /** "03" */
  numeral: string;
  title: string;
  subtitle: string | null;
};

export type ImageBlock = BlockBase & {
  kind: "image";
  assetKey: string;
  altText: string;
  /** Intrinsic dimensions; emitters scale. */
  widthPx: number;
  heightPx: number;
};

export type PageBreakBlock = BlockBase & { kind: "page-break" };

/**
 * A de-emphasised qualifier attached to the content above it: "Resolution targets exclude time
 * waiting on third-party vendors, hardware replacement, or client input."
 *
 * Added during the phase-1 transcription of the CHF proposal, where it appears twice. It is not
 * prose (it is fine print, and rendering it as body text overstates it) and it is not a callout
 * (a callout draws the eye; this deliberately does not). Modelling it as either would have been
 * the escape hatch the closed set exists to prevent.
 */
export type FootnoteBlock = BlockBase & { kind: "footnote"; text: string };

/**
 * The certification badge strip: hairline-bordered chips with a rotated-square accent, carrying
 * ISO 27001:2022, SOC 2 Type 2, CMMC Level 1.
 *
 * Listed as its own recurring element in the template's design system, and the only archetype in
 * the reference proposal that no original variant could express. Stat tiles carry a number and a
 * label; cards carry a title and a body; a badge is a credential and an optional qualifier.
 */
export type BadgeStripBlock = BlockBase & {
  kind: "badge-strip";
  badges: { label: string; note?: string }[];
};

export type Block =
  | ProseBlock
  | HeadingBlock
  | ListBlock
  | StatTileRowBlock
  | BrandedTableBlock
  | FactGridBlock
  | CalloutBlock
  | PullQuoteBlock
  | TimelineBlock
  | CardsBlock
  | DividerPageBlock
  | ImageBlock
  | PageBreakBlock
  | FootnoteBlock
  | BadgeStripBlock;

/**
 * The complete set of block kinds, as a runtime value.
 *
 * Emitters assert exhaustiveness against this. If a variant is added above and an emitter does not
 * handle it, `assertNeverBlock` fails at compile time and the emitter's coverage test fails at
 * runtime — which is the mechanism that stops a new variant shipping in one format only.
 */
export const BLOCK_KINDS = [
  "prose",
  "heading",
  "list",
  "stat-tiles",
  "table",
  "fact-grid",
  "callout",
  "pull-quote",
  "timeline",
  "cards",
  "divider",
  "image",
  "page-break",
  "footnote",
  "badge-strip",
] as const satisfies readonly BlockKind[];

/** Compile-time exhaustiveness guard for emitter and validator switches. */
export function assertNeverBlock(block: never): never {
  throw new Error(`Unhandled block variant: ${JSON.stringify(block)}`);
}

/**
 * Every human-readable string a block puts in front of a client, flattened.
 *
 * This is the surface the style and business-term validators scan. Centralising it means a new
 * block variant cannot quietly introduce text that rule A1 never looks at — the one way a
 * "month-to-month" could survive the gate again.
 */
export function blockTextSpans(block: Block): { field: string; text: string }[] {
  switch (block.kind) {
    case "prose":
      return [{ field: "text", text: block.text }];
    case "heading":
      return [{ field: "text", text: block.text }];
    case "list":
      return block.items.map((text, i) => ({ field: `items[${i}]`, text }));
    case "stat-tiles":
      return block.tiles.flatMap((tile, i) => [
        { field: `tiles[${i}].value`, text: tile.value },
        { field: `tiles[${i}].label`, text: tile.label },
        ...(tile.note ? [{ field: `tiles[${i}].note`, text: tile.note }] : []),
      ]);
    case "table":
      return [
        ...(block.caption ? [{ field: "caption", text: block.caption }] : []),
        ...block.columns.map((c, i) => ({ field: `columns[${i}].header`, text: c.header })),
        ...block.rows.flatMap((row, r) =>
          row.map((cell, c) => ({ field: `rows[${r}][${c}]`, text: cell })),
        ),
      ];
    case "fact-grid":
      return block.pairs.flatMap((pair, i) => [
        { field: `pairs[${i}].label`, text: pair.label },
        { field: `pairs[${i}].value`, text: pair.value },
      ]);
    case "callout":
      return [
        ...(block.title ? [{ field: "title", text: block.title }] : []),
        { field: "body", text: block.body },
      ];
    case "pull-quote":
      return [
        { field: "text", text: block.text },
        ...(block.attribution ? [{ field: "attribution", text: block.attribution }] : []),
      ];
    case "timeline":
      return block.steps.flatMap((step, i) => [
        { field: `steps[${i}].label`, text: step.label },
        { field: `steps[${i}].title`, text: step.title },
        { field: `steps[${i}].body`, text: step.body },
      ]);
    case "cards":
      return block.cards.flatMap((card, i) => [
        { field: `cards[${i}].title`, text: card.title },
        { field: `cards[${i}].body`, text: card.body },
        ...(card.footnote ? [{ field: `cards[${i}].footnote`, text: card.footnote }] : []),
      ]);
    case "divider":
      return [
        { field: "numeral", text: block.numeral },
        { field: "title", text: block.title },
        ...(block.subtitle ? [{ field: "subtitle", text: block.subtitle }] : []),
      ];
    case "image":
      return [{ field: "altText", text: block.altText }];
    case "page-break":
      return [];
    case "footnote":
      return [{ field: "text", text: block.text }];
    case "badge-strip":
      return block.badges.flatMap((badge, i) => [
        { field: `badges[${i}].label`, text: badge.label },
        ...(badge.note ? [{ field: `badges[${i}].note`, text: badge.note }] : []),
      ]);
    default:
      return assertNeverBlock(block);
  }
}

/** Whole visible text of a block, newline-joined. Used by the parity and em-dash scans. */
export function blockPlainText(block: Block): string {
  return blockTextSpans(block)
    .map((span) => span.text)
    .join("\n");
}

/** Full-page blocks occupy a page on their own and never share one. */
export function isFullPageBlock(block: Block): boolean {
  return block.kind === "divider";
}
