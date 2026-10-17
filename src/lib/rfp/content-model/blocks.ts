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

/**
 * The questionnaire response matrix (§5.17.22): one row per client item ID, in the client's own
 * order, each with a verdict pill, a short bold subject and the explanation. HOST-built, never
 * model-authored as a block: resolve-draft lifts a questionnaire section's stored `answers` into
 * ONE of these in requirement ordinal order (rule C4). `rateNote` is SYSTEM-composed at lift time
 * from the answer's rate-card codes (quote.ts rateNoteFor), never model text.
 */
export type MatrixVerdict = "yes" | "partial" | "no" | "na";
export type ResponseMatrixRow = {
  ref: string;
  verdict: MatrixVerdict;
  subject: string;
  explanation: string;
  rateNote?: string;
};
export type ResponseMatrixBlock = BlockBase & {
  kind: "response-matrix";
  rows: ResponseMatrixRow[];
};

/**
 * The client's own words, answered (§5.17.22): per entry a numbered circle, "What you told us"
 * with the client's line quoted VERBATIM (`said`, kept only when it is a substring of the fenced
 * source; `saidBy` only when it sits beside the quote there), XL.net's answer, and an optional
 * "What you will see" callout. The only lane that prints client text as a quote: the §5.17.7
 * testimonial pull-quote ban stands.
 */
/** `title` (optional, <= 60) is the entry's bold sub-head in XL.net's voice ("Too much customer
 *  oversight"), screened at write like a matrix subject. */
export type ClientEchoEntry = { title?: string; said: string; saidBy?: string; answer: string; willSee?: string };
export type ClientEchoBlock = BlockBase & {
  kind: "client-echo";
  entries: ClientEchoEntry[];
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
  | BadgeStripBlock
  | ResponseMatrixBlock
  | ClientEchoBlock;

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
  "response-matrix",
  "client-echo",
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
    // Round 34 (§5.17.22). Field names are the locator scheme the D-series
    // rules and findingSig read: `rows[i].<field>` / `entries[i].<field>`,
    // `i` the index in the stored array. The pill's printed word is
    // `rows[i].verdict` (matrixVerdictLabel), a fixed vocabulary; `rateNote`
    // is system text from the rate card (rule B7 sanctions it by field).
    // Total over hostile stored shapes: a null or non-object row or entry,
    // or a non-string field, yields no span for it rather than a throw
    // (one throw here would turn every text rule into a validator error).
    case "response-matrix":
      return (Array.isArray(block.rows) ? block.rows : []).flatMap((row, i) => {
        if (!row || typeof row !== "object") return [];
        return [
          ...spanIf(`rows[${i}].ref`, row.ref),
          ...spanIf(`rows[${i}].verdict`, typeof row.verdict === "string" ? matrixVerdictLabel(row.verdict) : ""),
          ...spanIf(`rows[${i}].subject`, row.subject),
          ...spanIf(`rows[${i}].explanation`, row.explanation),
          ...(row.rateNote ? spanIf(`rows[${i}].rateNote`, row.rateNote) : []),
        ];
      });
    case "client-echo":
      return (Array.isArray(block.entries) ? block.entries : []).flatMap((entry, i) => {
        if (!entry || typeof entry !== "object") return [];
        return [
          ...(entry.title ? spanIf(`entries[${i}].title`, entry.title) : []),
          ...spanIf(`entries[${i}].said`, entry.said),
          ...(entry.saidBy ? spanIf(`entries[${i}].saidBy`, entry.saidBy) : []),
          ...spanIf(`entries[${i}].answer`, entry.answer),
          ...(entry.willSee ? spanIf(`entries[${i}].willSee`, entry.willSee) : []),
        ];
      });
    default:
      return assertNeverBlock(block);
  }
}

/** One span when `text` is a string (a non-string stored value has none). */
function spanIf(field: string, text: unknown): { field: string; text: string }[] {
  return typeof text === "string" ? [{ field, text }] : [];
}

/** The word a verdict pill prints, on every surface. An unknown value (a
 *  corrupt stored row, rule D9's case) prints nothing rather than a guess. */
export function matrixVerdictLabel(verdict: string): string {
  switch (verdict) {
    case "yes":
      return "Yes";
    case "partial":
      return "Partial";
    case "no":
      return "No";
    case "na":
      return "N/A";
    default:
      return "";
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
