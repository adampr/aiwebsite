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
 * Widths come from Archivo Bold's own advance table (below), every glyph the face carries, not
 * from a canvas or a font file at run time, so this module is pure, runs identically on the server
 * and in the browser, and needs no layout pass. A character outside the table is one Archivo
 * cannot set: it is charged a fallback face's width, and the draft contract refuses it.
 *
 * Kerning is not applied. It moves none of the real figures, but Archivo Bold does kern a hyphen
 * or dash next to a digit up to 0.04em WIDER per pair, and pdfkit and the browser apply it (Word
 * does not). The slack absorbs it in an ordinary figure ("5-50 hrs" four across runs 0.03px into
 * the PDF tile's padding); a run of digit-dash pairs can go further ("0-0-0-0-0-0" 4.3px, still
 * inside the 18px padding), and neither renderer can make a second line of it: the screen value
 * is nowrap and the PDF value is set with lineBreak off.
 * Client-safe: no imports, no lookbehinds.
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

// Archivo Bold advance widths in 1/1000 em (unitsPerEm is 1000), keyed by code point, for every
// real glyph in public/brand/fonts/Archivo-Bold.ttf (v2.001, the face both files embed). Google Fonts'
// Archivo 700, which the screen loads, has identical advances for every printable ASCII character
// (measured 2026-09-30); the glyphs its subsets do not serve reach the screen from this same TTF
// (globals.css, the unicode-range Archivo face). Regenerate with `npm run rfp:tile-metrics`;
// test:rfptilefit re-reads the font through pdfkit (the PDF emitter's own measurer) and fails if
// this table drifts.
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
  0x00f9: 601, 0x00fa: 601, 0x00fb: 601, 0x00fc: 601, 0x00fd: 547, 0x00fe: 608, 0x00ff: 547, 0x0100: 724,
  0x0101: 580, 0x0102: 724, 0x0103: 580, 0x0104: 724, 0x0105: 580, 0x0106: 733, 0x0107: 573, 0x0108: 733,
  0x0109: 573, 0x010a: 733, 0x010b: 573, 0x010c: 733, 0x010d: 573, 0x010e: 739, 0x010f: 608, 0x0110: 739,
  0x0111: 608, 0x0112: 683, 0x0113: 584, 0x0114: 683, 0x0115: 584, 0x0116: 683, 0x0117: 584, 0x0118: 683,
  0x0119: 584, 0x011a: 683, 0x011b: 584, 0x011c: 802, 0x011d: 607, 0x011e: 802, 0x011f: 607, 0x0120: 802,
  0x0121: 607, 0x0122: 802, 0x0123: 607, 0x0124: 754, 0x0125: 602, 0x0126: 754, 0x0127: 602, 0x0128: 301,
  0x0129: 267, 0x012a: 301, 0x012b: 267, 0x012c: 301, 0x012d: 267, 0x012e: 301, 0x012f: 267, 0x0130: 301,
  0x0131: 267, 0x0132: 904, 0x0133: 531, 0x0134: 603, 0x0135: 264, 0x0136: 725, 0x0137: 570, 0x0138: 570,
  0x0139: 591, 0x013a: 267, 0x013b: 591, 0x013c: 267, 0x013d: 591, 0x013e: 267, 0x013f: 591, 0x0140: 267,
  0x0141: 591, 0x0142: 267, 0x0143: 754, 0x0144: 602, 0x0145: 754, 0x0146: 602, 0x0147: 754, 0x0148: 602,
  0x0149: 602, 0x014a: 754, 0x014b: 601, 0x014c: 793, 0x014d: 613, 0x014e: 793, 0x014f: 613, 0x0150: 793,
  0x0151: 613, 0x0152: 1202, 0x0153: 965, 0x0154: 730, 0x0155: 380, 0x0156: 730, 0x0157: 380, 0x0158: 730,
  0x0159: 380, 0x015a: 679, 0x015b: 556, 0x015c: 679, 0x015d: 556, 0x015e: 679, 0x015f: 556, 0x0160: 679,
  0x0161: 556, 0x0162: 641, 0x0163: 342, 0x0164: 641, 0x0165: 342, 0x0166: 641, 0x0167: 342, 0x0168: 748,
  0x0169: 601, 0x016a: 748, 0x016b: 601, 0x016c: 748, 0x016d: 601, 0x016e: 748, 0x016f: 601, 0x0170: 748,
  0x0171: 601, 0x0172: 748, 0x0173: 601, 0x0174: 964, 0x0175: 798, 0x0176: 699, 0x0177: 547, 0x0178: 699,
  0x0179: 653, 0x017a: 519, 0x017b: 653, 0x017c: 519, 0x017d: 653, 0x017e: 519, 0x017f: 324, 0x018f: 773,
  0x0192: 599, 0x019d: 754, 0x01a0: 793, 0x01a1: 613, 0x01af: 748, 0x01b0: 601, 0x01c4: 1382, 0x01c5: 1258,
  0x01c6: 1128, 0x01c7: 1174, 0x01c8: 855, 0x01c9: 531, 0x01ca: 1357, 0x01cb: 1018, 0x01cc: 866, 0x01cd: 724,
  0x01ce: 580, 0x01cf: 301, 0x01d0: 267, 0x01d1: 793, 0x01d2: 613, 0x01d3: 748, 0x01d4: 601, 0x01d5: 748,
  0x01d6: 601, 0x01d7: 748, 0x01d8: 601, 0x01d9: 748, 0x01da: 601, 0x01db: 748, 0x01dc: 601, 0x01e6: 802,
  0x01e7: 607, 0x01ea: 793, 0x01eb: 613, 0x01fa: 724, 0x01fb: 580, 0x01fc: 1004, 0x01fd: 920, 0x01fe: 793,
  0x01ff: 613, 0x0200: 724, 0x0201: 580, 0x0202: 724, 0x0203: 580, 0x0204: 683, 0x0205: 584, 0x0206: 683,
  0x0207: 584, 0x0208: 301, 0x0209: 267, 0x020a: 301, 0x020b: 267, 0x020c: 793, 0x020d: 613, 0x020e: 793,
  0x020f: 613, 0x0210: 730, 0x0211: 380, 0x0212: 730, 0x0213: 380, 0x0214: 748, 0x0215: 601, 0x0216: 748,
  0x0217: 601, 0x0218: 679, 0x0219: 556, 0x021a: 641, 0x021b: 342, 0x022a: 793, 0x022b: 613, 0x022c: 793,
  0x022d: 613, 0x0230: 793, 0x0231: 613, 0x0232: 699, 0x0233: 547, 0x0237: 264, 0x0259: 599, 0x0272: 602,
  0x02b9: 220, 0x02ba: 409, 0x02bc: 133, 0x02c6: 349, 0x02c7: 349, 0x02c9: 478, 0x02d8: 325, 0x02d9: 127,
  0x02da: 204, 0x02db: 196, 0x02dc: 357, 0x02dd: 414, 0x0300: 0, 0x0301: 0, 0x0302: 0, 0x0303: 0,
  0x0304: 0, 0x0306: 0, 0x0307: 0, 0x0308: 0, 0x0309: 0, 0x030a: 0, 0x030b: 0, 0x030c: 0,
  0x030f: 0, 0x0311: 0, 0x0312: 0, 0x0313: 0, 0x031b: 0, 0x0323: 0, 0x0324: 0, 0x0326: 0,
  0x0327: 0, 0x0328: 0, 0x032e: 0, 0x0331: 0, 0x0335: 0, 0x0336: 0, 0x0337: 0, 0x0338: 0,
  0x0394: 762, 0x03a9: 834, 0x03bc: 605, 0x03c0: 754, 0x1e24: 754, 0x1e25: 602, 0x1e62: 679, 0x1e63: 556,
  0x1e6c: 641, 0x1e6d: 342, 0x1e80: 964, 0x1e81: 798, 0x1e82: 964, 0x1e83: 798, 0x1e84: 964, 0x1e85: 798,
  0x1e9e: 820, 0x1ea0: 724, 0x1ea1: 580, 0x1ea2: 724, 0x1ea3: 580, 0x1ea4: 724, 0x1ea5: 580, 0x1ea6: 724,
  0x1ea7: 580, 0x1ea8: 724, 0x1ea9: 580, 0x1eaa: 724, 0x1eab: 580, 0x1eac: 724, 0x1ead: 580, 0x1eae: 724,
  0x1eaf: 580, 0x1eb0: 724, 0x1eb1: 580, 0x1eb2: 724, 0x1eb3: 580, 0x1eb4: 724, 0x1eb5: 580, 0x1eb6: 724,
  0x1eb7: 580, 0x1eb8: 683, 0x1eb9: 584, 0x1eba: 683, 0x1ebb: 584, 0x1ebc: 683, 0x1ebd: 584, 0x1ebe: 683,
  0x1ebf: 584, 0x1ec0: 683, 0x1ec1: 584, 0x1ec2: 683, 0x1ec3: 584, 0x1ec4: 683, 0x1ec5: 584, 0x1ec6: 683,
  0x1ec7: 584, 0x1ec8: 301, 0x1ec9: 267, 0x1eca: 301, 0x1ecb: 267, 0x1ecc: 793, 0x1ecd: 613, 0x1ece: 793,
  0x1ecf: 613, 0x1ed0: 793, 0x1ed1: 613, 0x1ed2: 793, 0x1ed3: 613, 0x1ed4: 793, 0x1ed5: 613, 0x1ed6: 793,
  0x1ed7: 613, 0x1ed8: 793, 0x1ed9: 613, 0x1eda: 793, 0x1edb: 613, 0x1edc: 793, 0x1edd: 613, 0x1ede: 793,
  0x1edf: 613, 0x1ee0: 793, 0x1ee1: 613, 0x1ee2: 793, 0x1ee3: 613, 0x1ee4: 748, 0x1ee5: 601, 0x1ee6: 748,
  0x1ee7: 601, 0x1ee8: 748, 0x1ee9: 601, 0x1eea: 748, 0x1eeb: 601, 0x1eec: 748, 0x1eed: 601, 0x1eee: 748,
  0x1eef: 601, 0x1ef0: 748, 0x1ef1: 601, 0x1ef2: 699, 0x1ef3: 547, 0x1ef4: 699, 0x1ef5: 547, 0x1ef6: 699,
  0x1ef7: 547, 0x1ef8: 699, 0x1ef9: 547, 0x2009: 211, 0x2010: 600, 0x2011: 333, 0x2013: 500, 0x2014: 1000,
  0x2015: 848, 0x2017: 518, 0x2018: 280, 0x2019: 280, 0x201a: 280, 0x201c: 488, 0x201d: 488, 0x201e: 488,
  0x2020: 599, 0x2021: 599, 0x2022: 441, 0x2026: 973, 0x2030: 1021, 0x2032: 168, 0x2033: 342, 0x2039: 357,
  0x203a: 357, 0x203e: 434, 0x2044: 167, 0x2052: 484, 0x2070: 371, 0x2074: 371, 0x2075: 371, 0x2076: 371,
  0x2077: 371, 0x2078: 371, 0x2079: 371, 0x207f: 414, 0x2080: 371, 0x2081: 371, 0x2082: 371, 0x2083: 371,
  0x2084: 371, 0x2085: 371, 0x2086: 371, 0x2087: 371, 0x2088: 371, 0x2089: 371, 0x2099: 414, 0x20a1: 733,
  0x20a3: 642, 0x20a4: 599, 0x20a6: 794, 0x20a7: 727, 0x20a9: 969, 0x20ab: 608, 0x20ac: 599, 0x20ad: 725,
  0x20b1: 727, 0x20b2: 796, 0x20b5: 733, 0x20b9: 622, 0x20ba: 597, 0x20bc: 740, 0x20bd: 705, 0x2105: 928,
  0x2113: 487, 0x2116: 1167, 0x2117: 772, 0x2122: 1001, 0x2126: 834, 0x212e: 600, 0x2190: 1000, 0x2191: 500,
  0x2192: 1000, 0x2193: 500, 0x2194: 1000, 0x2195: 500, 0x21a8: 500, 0x2202: 513, 0x2205: 619, 0x2206: 762,
  0x220f: 823, 0x2211: 713, 0x2212: 641, 0x2215: 132, 0x2219: 339, 0x221a: 549, 0x221e: 713, 0x221f: 979,
  0x2229: 717, 0x222b: 272, 0x2248: 641, 0x2260: 641, 0x2261: 603, 0x2264: 641, 0x2265: 641, 0x2302: 602,
  0x2310: 641, 0x2320: 602, 0x2321: 603, 0x25ca: 588, 0x27e8: 562, 0x27e9: 562, 0xfb01: 591, 0xfb02: 591,
  0xfeff: 0,
};
// END GENERATED ARCHIVO_BOLD_ADVANCE

/**
 * Width charged for a character the table does not carry, i.e. one Archivo has no glyph for: it
 * is set from a fallback face (on the screen, in Word) or as a missing-glyph box (in the PDF).
 * 1.5em is wider than Archivo's own widest glyph (1.382em, U+01C4) and than a colour emoji
 * (about 1.25em in Noto Color Emoji), so such a character is never under-measured. Only a stored
 * value can carry one: `valueFitsTile` refuses it in a new value.
 */
const FALLBACK_ADVANCE = 1500;

/**
 * Width of `text` set in Archivo Bold, in em. Every character counts, whitespace included, exactly
 * as stored: every writer collapses whitespace before a value is stored, the files set what is
 * stored, and a no-break space is as wide on screen as in the table (CSS collapses only ASCII
 * whitespace), so nothing is ever measured narrower than it sets.
 */
export function valueEm(text: string): number {
  let units = 0;
  for (const ch of text) units += ADVANCE[ch.codePointAt(0) ?? 0] ?? FALLBACK_ADVANCE;
  return units / 1000;
}

/** True when Archivo carries a glyph for every character of `text` (the table measures it exactly). */
function archivoSets(text: string): boolean {
  // A combining mark is never a figure's own character, and the screen sets one after a digit
  // wider than its zero advance (the digit and the mark come from different font subsets).
  if (/\p{M}/u.test(text)) return false;
  for (const ch of text) if (ADVANCE[ch.codePointAt(0) ?? 0] === undefined) return false;
  return true;
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
 * size, and Archivo carries every character of it. A model or server-built tile whose value fails
 * this is not written; the words that are not the figure belong in the label. A character Archivo
 * cannot set (an emoji, a check mark, CJK) is never part of a figure: the PDF would draw a box, and
 * a fallback face's width is only an estimate.
 */
export function valueFitsTile(value: string): boolean {
  // The renderers' own arithmetic, so the contract and the files can never disagree at the edge.
  return archivoSets(value) && tileValuePx([value], NARROWEST_TILE_INNER_PX) >= TILE_FIT.floorPx;
}
