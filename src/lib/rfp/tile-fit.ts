/**
 * Stat-tile values set on ONE line, on the screen and in both files (ARCHITECTURE.md §5.17).
 *
 * A stat is a figure ("98.15%", ">99%", "4.8 years"); a figure broken over two lines stops
 * reading as one. So every surface sizes a tile row the same way: ONE size for the whole row (the
 * tiles read as a set), the largest size up to the design size at which the row's widest value
 * fits its tile. The screen does it in CSS from `tileFitEm` (the tile is a size container), the
 * Word and PDF emitters from `tileValuePx`. Nothing sets a floor at render time: a stored value
 * too wide for its tile gets smaller, never a second line.
 *
 * The floor lives in the draft contract instead: `valueFitsTile` refuses a value that would not
 * fit the narrowest tile any file lays out (four across) at `TILE_FIT.floorPx`, so words that are
 * not the figure go in the label, and a new value never needs to shrink below the floor.
 *
 * Widths come from Archivo Bold's own advance table (below), not from a canvas or a font file at
 * run time, so this module is pure, runs identically on the server and in the browser, and needs
 * no layout pass. Kerning is not applied: for Archivo Bold it moves none of the figures measured
 * (2026-09-30), and an unkerned sum is never narrower than the set text in any case that matters
 * here. Client-safe: no Node imports, no lookbehinds.
 */

/** One spec for the value's size. px are CSS px on the ~648px sheet (export.ts's VIS unit). */
export const TILE_FIT = {
  /** The design size: a value this size or smaller when its row allows. */
  designPx: 32,
  /** The draft contract's floor: a NEW value must fit the narrowest file tile at this size. */
  floorPx: 18,
  /** The files' content width in px (US Letter less 0.875in margins: 9720 twips / 486pt). */
  sheetPx: 648,
  /** Gutter between tiles in the files (export.ts VIS.gap). */
  gapPx: 16,
  /** Tile padding on each side in the files (export.ts VIS.tile.pad). */
  padPx: 18,
  /** Most tiles a row carries (draft-blocks LIMITS.tiles[1]); the files never wrap a row. */
  maxPerRow: 4,
  /**
   * Share of the tile's inner width a value may take. The 2% of air absorbs sub-pixel rounding
   * in Word and pdfkit (either wraps a run that overflows its cell by a hair).
   */
  slack: 0.98,
} as const;

/** Inner width of one tile when a row of `n` tiles spans the files' sheet. */
export function fileTileInnerPx(n: number): number {
  const k = Math.max(1, Math.floor(n));
  return (TILE_FIT.sheetPx - TILE_FIT.gapPx * (k - 1)) / k - TILE_FIT.padPx * 2;
}

/** The narrowest tile the files lay out: four across. 114px. */
export const NARROWEST_TILE_INNER_PX = fileTileInnerPx(TILE_FIT.maxPerRow);

/** The widest value, in em, the draft contract admits (about 6.2em: "$1,250,000" fits, "99.9% uptime" does not). */
export const MAX_VALUE_EM = (NARROWEST_TILE_INNER_PX * TILE_FIT.slack) / TILE_FIT.floorPx;

// Archivo Bold advance widths in 1/1000 em (unitsPerEm is 1000), keyed by code point, read from
// public/brand/fonts/Archivo-Bold.ttf (v2.001, the face both files embed). Google Fonts' Archivo
// 700, which the screen loads, has identical advances for every printable ASCII character
// (measured 2026-09-30). Regenerate with `npm run rfp:tile-metrics`; test:rfptilefit re-reads the
// font through pdfkit (the PDF emitter's own measurer) and fails if this table drifts.
// BEGIN GENERATED ARCHIVO_BOLD_ADVANCE
// prettier-ignore
const ADVANCE: Readonly<Record<number, number>> = {
  0x0020: 196, 0x0021: 301, 0x0022: 456, 0x0023: 600, 0x0024: 556, 0x0025: 973, 0x0026: 764, 0x0027: 253,
  0x0028: 364, 0x0029: 364, 0x002a: 407, 0x002b: 641, 0x002c: 307, 0x002d: 333, 0x002e: 307, 0x002f: 300,
  0x0030: 595, 0x0031: 596, 0x0032: 596, 0x0033: 596, 0x0034: 597, 0x0035: 595, 0x0036: 596, 0x0037: 596,
  0x0038: 596, 0x0039: 595, 0x003a: 335, 0x003b: 335, 0x003c: 641, 0x003d: 641, 0x003e: 641, 0x003f: 613,
  0x0040: 1001, 0x0041: 724, 0x0042: 722, 0x0043: 733, 0x0044: 739, 0x0045: 683, 0x0046: 622, 0x0047: 802,
  0x0048: 754, 0x0049: 301, 0x004a: 603, 0x004b: 725, 0x004c: 591, 0x004d: 872, 0x004e: 754, 0x004f: 793,
  0x0050: 681, 0x0051: 793, 0x0052: 730, 0x0053: 679, 0x0054: 641, 0x0055: 748, 0x0056: 694, 0x0057: 964,
  0x0058: 706, 0x0059: 699, 0x005a: 653, 0x005b: 350, 0x005c: 300, 0x005d: 350, 0x005e: 641, 0x005f: 518,
  0x0060: 228, 0x0061: 580, 0x0062: 608, 0x0063: 573, 0x0064: 608, 0x0065: 584, 0x0066: 325, 0x0067: 607,
  0x0068: 602, 0x0069: 267, 0x006a: 264, 0x006b: 570, 0x006c: 267, 0x006d: 891, 0x006e: 602, 0x006f: 613,
  0x0070: 608, 0x0071: 608, 0x0072: 380, 0x0073: 556, 0x0074: 342, 0x0075: 601, 0x0076: 547, 0x0077: 798,
  0x0078: 572, 0x0079: 547, 0x007a: 519, 0x007b: 393, 0x007c: 253, 0x007d: 393, 0x007e: 641, 0x00a0: 196,
  0x00a1: 301, 0x00a2: 597, 0x00a3: 599, 0x00a4: 597, 0x00a5: 595, 0x00a6: 253, 0x00a7: 598, 0x00a8: 326,
  0x00a9: 772, 0x00aa: 398, 0x00ab: 576, 0x00ac: 641, 0x00ad: 333, 0x00ae: 772, 0x00af: 307, 0x00b0: 400,
  0x00b1: 641, 0x00b2: 371, 0x00b3: 371, 0x00b4: 228, 0x00b5: 605, 0x00b6: 616, 0x00b7: 333, 0x00b8: 237,
  0x00b9: 371, 0x00ba: 393, 0x00bb: 576, 0x00bc: 887, 0x00bd: 887, 0x00be: 887, 0x00bf: 613, 0x00c0: 724,
  0x00c1: 724, 0x00c2: 724, 0x00c3: 724, 0x00c4: 724, 0x00c5: 724, 0x00c6: 1004, 0x00c7: 733, 0x00c8: 683,
  0x00c9: 683, 0x00ca: 683, 0x00cb: 683, 0x00cc: 301, 0x00cd: 301, 0x00ce: 301, 0x00cf: 301, 0x00d0: 739,
  0x00d1: 754, 0x00d2: 793, 0x00d3: 793, 0x00d4: 793, 0x00d5: 793, 0x00d6: 793, 0x00d7: 641, 0x00d8: 793,
  0x00d9: 748, 0x00da: 748, 0x00db: 748, 0x00dc: 748, 0x00dd: 699, 0x00de: 697, 0x00df: 634, 0x00e0: 580,
  0x00e1: 580, 0x00e2: 580, 0x00e3: 580, 0x00e4: 580, 0x00e5: 580, 0x00e6: 920, 0x00e7: 573, 0x00e8: 584,
  0x00e9: 584, 0x00ea: 584, 0x00eb: 584, 0x00ec: 267, 0x00ed: 267, 0x00ee: 267, 0x00ef: 267, 0x00f0: 626,
  0x00f1: 602, 0x00f2: 613, 0x00f3: 613, 0x00f4: 613, 0x00f5: 613, 0x00f6: 613, 0x00f7: 641, 0x00f8: 613,
  0x00f9: 601, 0x00fa: 601, 0x00fb: 601, 0x00fc: 601, 0x00fd: 547, 0x00fe: 608, 0x00ff: 547, 0x2010: 600,
  0x2011: 333, 0x2013: 500, 0x2014: 1000, 0x2015: 848, 0x2017: 518, 0x2018: 280, 0x2019: 280, 0x201a: 280,
  0x201c: 488, 0x201d: 488, 0x201e: 488, 0x2020: 599, 0x2021: 599, 0x2022: 441, 0x2026: 973, 0x2030: 1021,
  0x2032: 168, 0x2033: 342, 0x20ac: 599, 0x2122: 1001, 0x2190: 1000, 0x2191: 500, 0x2192: 1000, 0x2193: 500,
  0x2212: 641, 0x2248: 641, 0x2260: 641, 0x2264: 641, 0x2265: 641,
};
// END GENERATED ARCHIVO_BOLD_ADVANCE

/**
 * Width charged for a character the table does not carry: the widest advance in it, so an
 * unknown glyph (or one the browser takes from a fallback face) is never under-measured.
 */
const FALLBACK_ADVANCE = Object.values(ADVANCE).reduce((m, v) => Math.max(m, v), 0) || 1000;

/** Width of `text` set in Archivo Bold, in em. Whitespace is collapsed as the renderers collapse it. */
export function valueEm(text: string): number {
  const s = text.replace(/\s+/g, " ").trim();
  let units = 0;
  for (const ch of s) units += ADVANCE[ch.codePointAt(0) ?? 0] ?? FALLBACK_ADVANCE;
  return units / 1000;
}

/**
 * The em width a tile's inner width must hold for this row: the widest value, plus the slack.
 * The screen divides the tile's inner width (100cqi) by this; the files divide their measured
 * inner width by it. Never below 1em, so an empty or one-character row cannot blow the size up.
 */
export function tileFitEm(values: readonly string[]): number {
  const widest = values.reduce((m, v) => Math.max(m, valueEm(v)), 0);
  return Math.max(1, widest / TILE_FIT.slack);
}

/**
 * The size, in whole px, every value in a stat-tile row sets at in the files: the design size,
 * stepped down until the widest value fits `innerWidthPx`. No floor (see the module comment);
 * never below 1px.
 */
export function tileValuePx(values: readonly string[], innerWidthPx: number): number {
  const fit = Math.floor(innerWidthPx / tileFitEm(values));
  return Math.max(1, Math.min(TILE_FIT.designPx, fit));
}

/**
 * The draft contract: true when `value` fits one line of the narrowest file tile at the floor
 * size. A model or server-built tile whose value fails this is not written; the words that are
 * not the figure belong in the label.
 */
export function valueFitsTile(value: string): boolean {
  // The renderers' own arithmetic, so the contract and the files can never disagree at the edge.
  return tileValuePx([value], NARROWEST_TILE_INNER_PX) >= TILE_FIT.floorPx;
}
