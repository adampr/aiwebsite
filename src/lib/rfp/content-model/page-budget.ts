/**
 * Page budget constants and measurement types.
 *
 * DOMAIN-RULES D5 / RENDERING.md: usable content height is (11in - 2 x margin) x 96px = 883px at
 * the template's 0.9in margin, on a 6.7in column. The running footer sits inside the margin band
 * and does not consume content height.
 *
 * Measured empirically, not derived: an 878px block fits on one page, an 885px block splits.
 * Target 860px so a later one-line correction does not cost a page.
 *
 * The measurement itself lives in the render service (it needs a browser). This module holds the
 * numbers both sides agree on, so the drafting layer can budget against the same figures the
 * measurer reports.
 */

export const PX_PER_INCH = 96;
export const PAGE_HEIGHT_IN = 11;
export const PAGE_WIDTH_IN = 8.5;
export const DEFAULT_MARGIN_IN = 0.9;

/** (11 - 2 x 0.9) x 96 = 883. */
export const USABLE_CONTENT_HEIGHT_PX = Math.round(
  (PAGE_HEIGHT_IN - 2 * DEFAULT_MARGIN_IN) * PX_PER_INCH,
);

/** 6.7in at the default margin. */
export const CONTENT_WIDTH_IN = PAGE_WIDTH_IN - 2 * DEFAULT_MARGIN_IN;
export const CONTENT_WIDTH_PX = Math.round(CONTENT_WIDTH_IN * PX_PER_INCH);

/**
 * Target height, below the hard budget, so a one-line correction later does not cost a page. Two
 * single-line corrections on one real build each pushed the document from 25 to 26 pages.
 */
export const TARGET_BLOCK_HEIGHT_PX = 860;

/** Empirically: 878 fits, 885 splits. Anything between is the tight band. */
export const OBSERVED_FITS_PX = 878;
export const OBSERVED_SPLITS_PX = 885;

/** Full-page blocks (cover, dividers, back cover) are height:8.55in and always fit. */
export const FULL_PAGE_BLOCK_HEIGHT_PX = Math.round(8.55 * PX_PER_INCH);

/**
 * The dense type scale, from the 46-page build that needed it. Worth roughly 20% of document
 * height. Chosen once at document level from projected length, never as a per-page fix, and
 * shrinking further than this is the wrong move: trim prose instead.
 */
export type DensityMode = "default" | "dense";

export type DensityScale = {
  bodyFontSizePx: number;
  bodyLineHeight: number;
  tableFontSizePx: number;
  tableCellPadding: string;
  tilePadding: string;
  tileBodyFontSizePx: number;
  paragraphMarginBottomPx: number;
  gridMarginBottomPx: number;
  gridGapPx: number;
  h2FontSizePx: number;
  sectionLabelMarginBottomPx: number;
};

export const DENSITY_SCALES: Record<DensityMode, DensityScale> = {
  default: {
    bodyFontSizePx: 15,
    bodyLineHeight: 1.68,
    tableFontSizePx: 13,
    tableCellPadding: "12px 14px",
    tilePadding: "22px 20px",
    tileBodyFontSizePx: 13,
    paragraphMarginBottomPx: 14,
    gridMarginBottomPx: 18,
    gridGapPx: 16,
    h2FontSizePx: 28,
    sectionLabelMarginBottomPx: 12,
  },
  dense: {
    bodyFontSizePx: 13.5,
    bodyLineHeight: 1.45,
    tableFontSizePx: 11.5,
    tableCellPadding: "7px 10px",
    tilePadding: "11px 15px",
    tileBodyFontSizePx: 12.5,
    paragraphMarginBottomPx: 10,
    gridMarginBottomPx: 11,
    gridGapPx: 11,
    h2FontSizePx: 25,
    sectionLabelMarginBottomPx: 7,
  },
};

export type BlockMeasurement = {
  blockId: string;
  kind: string;
  heightPx: number;
  status: "ok" | "tight" | "over";
  /** How far over the hard budget, when over. */
  overByPx: number;
};

export type PageBudgetReport = {
  density: DensityMode;
  budgetPx: number;
  targetPx: number;
  measurements: BlockMeasurement[];
  projectedPageCount: number;
  overBlocks: BlockMeasurement[];
};

export function classifyHeight(heightPx: number): BlockMeasurement["status"] {
  if (heightPx > USABLE_CONTENT_HEIGHT_PX) return "over";
  if (heightPx > TARGET_BLOCK_HEIGHT_PX) return "tight";
  return "ok";
}

export function measureBlockHeight(blockId: string, kind: string, heightPx: number): BlockMeasurement {
  const status = classifyHeight(heightPx);
  return {
    blockId,
    kind,
    heightPx,
    status,
    overByPx: status === "over" ? heightPx - USABLE_CONTENT_HEIGHT_PX : 0,
  };
}

/**
 * Rough words-per-page guidance from RENDERING.md, used by the drafting layer as a length
 * constraint so sections are composed to fit rather than trimmed to fit.
 */
export const WORDS_PER_PROSE_PAGE = { min: 450, max: 500 } as const;

export function proseWordBudget(availableHeightPx: number): number {
  const fraction = availableHeightPx / USABLE_CONTENT_HEIGHT_PX;
  return Math.max(0, Math.floor(WORDS_PER_PROSE_PAGE.max * fraction));
}
