/**
 * Zod schemas for the block vocabulary.
 *
 * Two jobs. First, the JSON round-trip guarantee: a fixture must serialize and parse back
 * unchanged, which is phase 1's acceptance test. Second, they are the schema handed to the model
 * in phase 5, so drafting emits blocks rather than free markup. Anything a validator later has to
 * check is better rejected here, at the boundary.
 */

import { z } from "zod";
import { BLOCK_KINDS, type Block } from "./blocks";

const blockBaseShape = {
  id: z.string().min(1),
  sectionId: z.string().min(1),
  ordinal: z.number().int().nonnegative(),
  cites: z.array(z.string()),
  generatedBy: z.enum(["llm", "human", "system"]),
  editedByHuman: z.boolean(),
};

export const proseBlockSchema = z.object({
  ...blockBaseShape,
  kind: z.literal("prose"),
  text: z.string(),
});

export const headingBlockSchema = z.object({
  ...blockBaseShape,
  kind: z.literal("heading"),
  level: z.union([z.literal(2), z.literal(3)]),
  text: z.string(),
});

export const listBlockSchema = z.object({
  ...blockBaseShape,
  kind: z.literal("list"),
  style: z.enum(["bullet", "number"]),
  items: z.array(z.string()),
});

export const statTileRowBlockSchema = z.object({
  ...blockBaseShape,
  kind: z.literal("stat-tiles"),
  tiles: z
    .array(
      z.object({
        value: z.string(),
        label: z.string(),
        note: z.string().optional(),
      }),
    )
    .min(2)
    .max(6),
});

export const brandedTableBlockSchema = z.object({
  ...blockBaseShape,
  kind: z.literal("table"),
  caption: z.string().nullable(),
  columns: z.array(z.object({ header: z.string(), align: z.enum(["left", "right", "center"]) })).min(1),
  rows: z.array(z.array(z.string())),
  emphasizeLastRow: z.boolean(),
});

export const factGridBlockSchema = z.object({
  ...blockBaseShape,
  kind: z.literal("fact-grid"),
  pairs: z.array(z.object({ label: z.string(), value: z.string() })),
});

export const calloutBlockSchema = z.object({
  ...blockBaseShape,
  kind: z.literal("callout"),
  title: z.string().nullable(),
  body: z.string(),
  tone: z.enum(["neutral", "emphasis"]),
});

export const pullQuoteBlockSchema = z.object({
  ...blockBaseShape,
  kind: z.literal("pull-quote"),
  text: z.string(),
  attribution: z.string().nullable(),
});

export const timelineBlockSchema = z.object({
  ...blockBaseShape,
  kind: z.literal("timeline"),
  steps: z.array(z.object({ label: z.string(), title: z.string(), body: z.string() })),
});

export const cardsBlockSchema = z.object({
  ...blockBaseShape,
  kind: z.literal("cards"),
  cards: z.array(
    z.object({ title: z.string(), body: z.string(), footnote: z.string().optional() }),
  ),
});

export const dividerPageBlockSchema = z.object({
  ...blockBaseShape,
  kind: z.literal("divider"),
  numeral: z.string(),
  title: z.string(),
  subtitle: z.string().nullable(),
});

export const imageBlockSchema = z.object({
  ...blockBaseShape,
  kind: z.literal("image"),
  assetKey: z.string(),
  altText: z.string(),
  widthPx: z.number().positive(),
  heightPx: z.number().positive(),
});

export const pageBreakBlockSchema = z.object({
  ...blockBaseShape,
  kind: z.literal("page-break"),
});

export const footnoteBlockSchema = z.object({
  ...blockBaseShape,
  kind: z.literal("footnote"),
  text: z.string(),
});

export const badgeStripBlockSchema = z.object({
  ...blockBaseShape,
  kind: z.literal("badge-strip"),
  badges: z.array(z.object({ label: z.string(), note: z.string().optional() })).min(1),
});

export const blockSchema = z.discriminatedUnion("kind", [
  proseBlockSchema,
  headingBlockSchema,
  listBlockSchema,
  statTileRowBlockSchema,
  brandedTableBlockSchema,
  factGridBlockSchema,
  calloutBlockSchema,
  pullQuoteBlockSchema,
  timelineBlockSchema,
  cardsBlockSchema,
  dividerPageBlockSchema,
  imageBlockSchema,
  pageBreakBlockSchema,
  footnoteBlockSchema,
  badgeStripBlockSchema,
]);

/**
 * Meta-guarantee: the discriminated union covers exactly the closed set in blocks.ts. If a variant
 * is added there and not here, this throws at import time rather than failing silently when the
 * drafting layer tries to validate a block it cannot describe.
 */
const schemaKinds = new Set(blockSchema.options.map((o) => o.shape.kind.value));
for (const kind of BLOCK_KINDS) {
  if (!schemaKinds.has(kind)) {
    throw new Error(`blockSchema is missing a variant for block kind "${kind}"`);
  }
}
if (schemaKinds.size !== BLOCK_KINDS.length) {
  throw new Error(
    `blockSchema has ${schemaKinds.size} variants but BLOCK_KINDS has ${BLOCK_KINDS.length}`,
  );
}

export const sectionSchema = z.object({
  id: z.string().min(1),
  proposalId: z.string().min(1),
  structureLabel: z.string(),
  title: z.string(),
  ordinal: z.number().int().nonnegative(),
  parentId: z.string().nullable(),
  blocks: z.array(blockSchema),
  reviewState: z.enum(["generated", "edited", "approved"]),
});

export function parseBlock(value: unknown): Block {
  return blockSchema.parse(value) as Block;
}

export function parseBlocks(value: unknown): Block[] {
  return z.array(blockSchema).parse(value) as Block[];
}

/**
 * The JSON Schema handed to the model in phase 5. Kept deliberately narrow: no id, sectionId,
 * ordinal or editedByHuman, because those are assigned by the system, not chosen by the drafter.
 */
export const draftedBlockSchema = z.discriminatedUnion("kind", [
  proseBlockSchema.omit({ ...omitKeys() }).extend({ kind: z.literal("prose") }),
  headingBlockSchema.omit({ ...omitKeys() }).extend({ kind: z.literal("heading") }),
  listBlockSchema.omit({ ...omitKeys() }).extend({ kind: z.literal("list") }),
  statTileRowBlockSchema.omit({ ...omitKeys() }).extend({ kind: z.literal("stat-tiles") }),
  brandedTableBlockSchema.omit({ ...omitKeys() }).extend({ kind: z.literal("table") }),
  factGridBlockSchema.omit({ ...omitKeys() }).extend({ kind: z.literal("fact-grid") }),
  calloutBlockSchema.omit({ ...omitKeys() }).extend({ kind: z.literal("callout") }),
  pullQuoteBlockSchema.omit({ ...omitKeys() }).extend({ kind: z.literal("pull-quote") }),
  timelineBlockSchema.omit({ ...omitKeys() }).extend({ kind: z.literal("timeline") }),
  cardsBlockSchema.omit({ ...omitKeys() }).extend({ kind: z.literal("cards") }),
  dividerPageBlockSchema.omit({ ...omitKeys() }).extend({ kind: z.literal("divider") }),
  imageBlockSchema.omit({ ...omitKeys() }).extend({ kind: z.literal("image") }),
  pageBreakBlockSchema.omit({ ...omitKeys() }).extend({ kind: z.literal("page-break") }),
  footnoteBlockSchema.omit({ ...omitKeys() }).extend({ kind: z.literal("footnote") }),
  badgeStripBlockSchema.omit({ ...omitKeys() }).extend({ kind: z.literal("badge-strip") }),
]);

function omitKeys() {
  return {
    id: true,
    sectionId: true,
    ordinal: true,
    generatedBy: true,
    editedByHuman: true,
  } as const;
}

export type DraftedBlock = z.infer<typeof draftedBlockSchema>;
