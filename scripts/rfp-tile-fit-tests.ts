/**
 * Stat-tile one-line fit tests (ARCHITECTURE.md §5.17).
 *
 *   npm run test:rfptilefit
 *
 * Pure, no server. Pins src/lib/rfp/tile-fit.ts to the font and to the files: the advance table is
 * the vendored Archivo Bold (read twice, through fontkit as the generator reads it and through
 * pdfkit as the PDF emitter measures it); every real stat row sets on ONE line in every tile width
 * either file lays out, at the largest size up to the design size; the draft contract admits the
 * figure and refuses the figure-plus-words; and the geometry the emitters actually lay out is the
 * geometry tile-fit assumes. The rows below are production values from a real draft (XL.net's own
 * figures; the client is not named anywhere in the repo).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import PDFDocument from "pdfkit";
import {
  MAX_VALUE_EM,
  NARROWEST_TILE_INNER_PX,
  TILE_FIT,
  fileTileInnerPx,
  tileFitEm,
  tileValuePx,
  valueEm,
  valueFitsTile,
} from "../src/lib/rfp/tile-fit";
import { STAT_TILE_GEOMETRY } from "../src/lib/rfp/export";
import { LIMITS } from "../src/lib/rfp/draft-blocks";
import { coveredCodePoints, readAdvances } from "./rfp-tile-metrics";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = isDeepStrictEqual(actual, expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `\n     got  ${JSON.stringify(actual)}\n     want ${JSON.stringify(expected)}`}`
  );
}
const yes = (label: string, v: unknown) => check(label, !!v, true);
const no = (label: string, v: unknown) => check(label, !!v, false);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FONT = path.join(root, "public/brand/fonts/Archivo-Bold.ttf");
const hex = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;

/** Real rows from the reported draft: each row shares one size. */
const REAL_ROWS: string[][] = [
  ["92%", "98.15%", ">99%"],
  ["73", "92%", "98.15%", ">80%"],
  [">99%", ">70%", "99.9%", "98.15%"],
  ["73", "92%", "4.8 years", ">80%"],
  ["47", "73", "92%", ">99%"],
];
const FORMATS = ["docx", "pdf"] as const;

// The PDF emitter's own measurer: pdfkit on the vendored face. widthOfString runs fontkit's layout,
// so a multi-character string comes back KERNED, exactly as the PDF sets it. Measured at 1000pt so
// the result reads directly in 1/1000 em. The document is never written; its page only gives the
// line breaker somewhere to stand.
const measurer = new PDFDocument({ size: "LETTER" });
measurer.registerFont("Archivo-Bold", FONT);
measurer.font("Archivo-Bold").fontSize(1000);
const pdfkitEm = (s: string) => measurer.widthOfString(s) / 1000;

// ---- (a) the table is the TTF (the `rfp:tile-metrics --check` equivalent) --------------------
{
  const src = fs.readFileSync(path.join(root, "src/lib/rfp/tile-fit.ts"), "utf8");
  const block = /\/\/ BEGIN GENERATED ARCHIVO_BOLD_ADVANCE([\s\S]*?)\/\/ END GENERATED ARCHIVO_BOLD_ADVANCE/.exec(src)?.[1] ?? "";
  const inSource = [...block.matchAll(/0x([0-9a-f]{4}): (\d+)/g)].map((m) => [parseInt(m[1], 16), Number(m[2])]);
  const fromFont = [...readAdvances()];
  yes("the generated block is present", inSource.length > 0);
  check("the advance table in tile-fit.ts equals Archivo-Bold.ttf, entry for entry, in order", inSource, fromFont);
  check("unitsPerEm is 1000, so the table is exact (no rounding in it)", fromFont.every(([, w]) => Number.isInteger(w)), true);
}

// ---- (b) valueEm agrees with pdfkit, per code point and per real row ------------------------
{
  const advances = readAdvances();
  const off: string[] = [];
  const under: string[] = [];
  for (const cp of coveredCodePoints()) {
    const ch = String.fromCodePoint(cp);
    // valueEm collapses and trims whitespace as the renderers read a value, so a space is
    // measured between two digits; a lone one would be trimmed to nothing.
    const table = /\s/.test(ch) ? valueEm(`1${ch}1`) - valueEm("11") : valueEm(ch);
    const pdf = pdfkitEm(ch);
    if (!advances.has(cp)) {
      // No glyph in the face: tile-fit charges the widest advance, never less than what is set.
      if (table < pdf) under.push(`${hex(cp)} table ${table} < pdfkit ${pdf}`);
      continue;
    }
    // A default-ignorable character (the soft hyphen) is set at zero width by fontkit; the table
    // keeps its advance, which over-measures, the safe side. draft-blocks strips format
    // characters from every value before one is stored, so none reaches a tile anyway.
    if (cp === 0x00ad) {
      if (table < pdf) under.push(`${hex(cp)} table ${table} < pdfkit ${pdf}`);
      continue;
    }
    if (Math.abs(table - pdf) > 0.001) off.push(`${hex(cp)} table ${table} pdfkit ${pdf}`);
  }
  check("every covered code point: valueEm equals pdfkit's width within 0.001em", off, []);
  check("no code point is ever under-measured", under, []);
  check("the table covers every printable ASCII character", Array.from({ length: 0x7f - 0x20 }, (_, i) => 0x20 + i).filter((cp) => !advances.has(cp)), []);

  const kernedWider: string[] = [];
  for (const row of REAL_ROWS)
    for (const v of row) if (pdfkitEm(v) > valueEm(v) + 1e-9) kernedWider.push(`${v}: kerned ${pdfkitEm(v)} > table ${valueEm(v)}`);
  check("every real value: the kerned width pdfkit sets is never wider than the table's sum", kernedWider, []);
  check('"98.15%" is 3.662em (the reported value)', valueEm("98.15%"), 3.662);
}

// ---- (c) every real row fits one line, in every tile width both files lay out ----------------
{
  const notOneLine: string[] = [];
  const notLargest: string[] = [];
  const not32: string[] = [];
  const wrapsInPdfkit: string[] = [];
  const docxOver: string[] = [];
  for (const row of REAL_ROWS) {
    for (const n of [2, 3, 4]) {
      for (const format of FORMATS) {
        const inner = STAT_TILE_GEOMETRY.innerPx(format, n);
        const px = tileValuePx(row, inner);
        const where = `[${row.join(", ")}] ${n}-up ${format} (inner ${inner.toFixed(2)}px) at ${px}px`;
        for (const v of row) {
          // Both measures: the table's sum and the kerned width pdfkit actually sets.
          const w = Math.max(valueEm(v), pdfkitEm(v)) * px;
          if (w > inner) notOneLine.push(`${where}: ${v} is ${w.toFixed(2)}px`);
          // pdfkit's own line breaker, handed the tile's width, keeps it on one line too (the
          // emitter no longer hands it one, so this is the belt behind lineBreak: false).
          measurer.fontSize(px * 0.75);
          const lines = Math.round(measurer.heightOfString(v, { width: inner * 0.75 }) / measurer.currentLineHeight(true));
          measurer.fontSize(1000);
          if (lines !== 1) wrapsInPdfkit.push(`${where}: ${v} breaks into ${lines} lines`);
        }
        // Word sets whole half-points, floored by the emitter, so never above the fitted size.
        if (Math.floor(px * 1.5) / 1.5 > px) docxOver.push(where);
        const fitsAt = (p: number) => row.every((v) => valueEm(v) * p <= inner * TILE_FIT.slack);
        if (px < TILE_FIT.designPx && fitsAt(px + 1)) notLargest.push(`${where}: ${px + 1}px also fits`);
        if (fitsAt(TILE_FIT.designPx) && px !== TILE_FIT.designPx) not32.push(where);
      }
    }
  }
  check("every real row sets on one line at the size tileValuePx returns (table and kerned widths)", notOneLine, []);
  check("pdfkit's line breaker keeps every real value on one line at that size and width", wrapsInPdfkit, []);
  check("the size is the largest that fits, never a step lower", notLargest, []);
  check("a row that fits at the design size is set at 32px", not32, []);
  check("Word's half-point size never exceeds the fitted px", docxOver, []);

  // The reported case, pinned: four across, the row that carried 98.15%.
  const reported = REAL_ROWS[1];
  for (const format of FORMATS) {
    const px = tileValuePx(reported, STAT_TILE_GEOMETRY.innerPx(format, 4));
    check(`the reported 4-up row sizes to 30px in the ${format}`, px, 30);
  }
  check("2-up leaves every real row at the design size", REAL_ROWS.every((r) => tileValuePx(r, fileTileInnerPx(2)) === 32), true);
  check('"4.8 years" steps its 4-up row down to 25px', tileValuePx(REAL_ROWS[3], NARROWEST_TILE_INNER_PX), 25);
  check("tileFitEm is the widest value over the slack", tileFitEm(REAL_ROWS[3]), valueEm("4.8 years") / TILE_FIT.slack);
  check("an empty row cannot blow the size up", tileValuePx([], NARROWEST_TILE_INNER_PX), TILE_FIT.designPx);
  check("a stored value too wide for any sane size still gets a size, never 0", tileValuePx(["W".repeat(200)], NARROWEST_TILE_INNER_PX), 1);
}

// ---- (d) the contract's edges --------------------------------------------------------------
{
  for (const v of ["98.15%", "4.8 years", "$1,250,000", ">99%", "99.9%", "24/7/365", "15 minutes"])
    yes(`valueFitsTile admits the figure "${v}"`, valueFitsTile(v));
  for (const v of ["99.9% uptime", "$1,250,000/yr", "More than 99%", "4.8 years average"])
    no(`valueFitsTile refuses figure-plus-words "${v}"`, valueFitsTile(v));
  check("MAX_VALUE_EM is the narrowest tile at the floor, less the slack", MAX_VALUE_EM, (114 * TILE_FIT.slack) / TILE_FIT.floorPx);

  // The boundary: the widest string one character can reach from a base below MAX_VALUE_EM, and
  // the narrowest one past it. Admitted exactly at the edge still renders at the floor or above,
  // in every tile of every file; one step past is refused.
  const base = "1".repeat(10);
  const chars = [...readAdvances().keys()].map((cp) => String.fromCodePoint(cp)).filter((c) => !/\s/.test(c));
  const cands = chars.map((c) => base + c);
  const inside = cands.filter((s) => valueEm(s) <= MAX_VALUE_EM).sort((a, b) => valueEm(b) - valueEm(a))[0];
  const outside = cands.filter((s) => valueEm(s) > MAX_VALUE_EM).sort((a, b) => valueEm(a) - valueEm(b))[0];
  yes(`boundary strings found (${valueEm(inside)}em <= ${MAX_VALUE_EM.toFixed(4)}em < ${valueEm(outside)}em)`, inside && outside);
  yes("the widest admissible value is admitted", valueFitsTile(inside));
  no("the narrowest value past the edge is refused", valueFitsTile(outside));
  const below: string[] = [];
  for (const n of [1, 2, 3, 4])
    for (const format of FORMATS) {
      const px = tileValuePx([inside], STAT_TILE_GEOMETRY.innerPx(format, n));
      if (px < TILE_FIT.floorPx) below.push(`${n}-up ${format}: ${px}px`);
    }
  check("the value at the boundary never renders below floorPx, in any tile of either file", below, []);
  check("the value past the edge would set below the floor four across", tileValuePx([outside], NARROWEST_TILE_INNER_PX) < TILE_FIT.floorPx, true);

  // The same both ways over many strings (a seeded generator, so a failure reproduces).
  let seed = 20260930;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const alphabet = "0123456789.,%$+<>/-~xkKMWm yearsdhoupti";
  const disagree: string[] = [];
  for (let i = 0; i < 4000; i++) {
    const len = 1 + Math.floor(rand() * 16);
    let s = "";
    for (let k = 0; k < len; k++) s += alphabet[Math.floor(rand() * alphabet.length)];
    const floor = Math.min(...[1, 2, 3, 4].flatMap((n) => FORMATS.map((f) => tileValuePx([s], STAT_TILE_GEOMETRY.innerPx(f, n)))));
    if (valueFitsTile(s) !== floor >= TILE_FIT.floorPx) disagree.push(`${JSON.stringify(s)} fits=${valueFitsTile(s)} smallest=${floor}px`);
  }
  check("valueFitsTile(v) holds exactly when v sets at the floor or above in every file tile (4000 strings)", disagree.slice(0, 5), []);
}

// ---- (e) the geometry the emitters lay out is the geometry tile-fit assumes -----------------
{
  check("Word's content width is 648px (DXA_CONTENT 9720 twips)", STAT_TILE_GEOMETRY.sheetPx.docx, TILE_FIT.sheetPx);
  check("the PDF's content width is 648px (CW 486pt)", STAT_TILE_GEOMETRY.sheetPx.pdf, TILE_FIT.sheetPx);
  check("the tile gutter is VIS.gap, 16px", STAT_TILE_GEOMETRY.gapPx, TILE_FIT.gapPx);
  check("the tile padding is VIS.tile.pad, 18px", STAT_TILE_GEOMETRY.padPx, TILE_FIT.padPx);
  check("the design size is VIS.tile.valuePx, 32px", STAT_TILE_GEOMETRY.designPx, TILE_FIT.designPx);
  check("a row carries at most TILE_FIT.maxPerRow tiles (LIMITS.tiles)", LIMITS.tiles[1], TILE_FIT.maxPerRow);
  check("the narrowest tile is 114px inside", NARROWEST_TILE_INNER_PX, 114);
  const mismatch: string[] = [];
  for (const n of [1, 2, 3, 4])
    for (const format of FORMATS) {
      const got = STAT_TILE_GEOMETRY.innerPx(format, n);
      if (Math.abs(got - fileTileInnerPx(n)) > 1e-9) mismatch.push(`${n}-up ${format}: ${got} vs ${fileTileInnerPx(n)}`);
    }
  check("each emitter's tile inner width equals fileTileInnerPx, 1 to 4 across", mismatch, []);
}

console.log(failures === 0 ? "\nall tile-fit tests passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
