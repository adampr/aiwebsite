/**
 * Regenerate (or check) the Archivo Bold advance table in src/lib/rfp/tile-fit.ts.
 *
 *   npm run rfp:tile-metrics            # rewrite the generated block from the vendored TTF
 *   npm run rfp:tile-metrics -- --check # exit 1 if the block differs from the TTF
 *
 * Reads public/brand/fonts/Archivo-Bold.ttf, the face both exports embed. Covers printable ASCII,
 * Latin-1, and the punctuation and symbols a stat plausibly carries; a code point the face has no
 * glyph for is left out, so tile-fit charges it the widest advance instead.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FONT = path.join(root, "public/brand/fonts/Archivo-Bold.ttf");
const TARGET = path.join(root, "src/lib/rfp/tile-fit.ts");
const BEGIN = "// BEGIN GENERATED ARCHIVO_BOLD_ADVANCE";
const END = "// END GENERATED ARCHIVO_BOLD_ADVANCE";

/** Every code point the table covers, in order. */
export function coveredCodePoints(): number[] {
  const cps: number[] = [];
  const range = (a: number, b: number) => {
    for (let c = a; c <= b; c++) cps.push(c);
  };
  range(0x20, 0x7e); // printable ASCII
  range(0xa0, 0xff); // Latin-1 supplement (NBSP, currency, ±, ×, ½, accented letters)
  range(0x2010, 0x2027); // dashes, quotes, bullet, ellipsis
  cps.push(0x2030, 0x2032, 0x2033, 0x20ac, 0x2122, 0x2190, 0x2191, 0x2192, 0x2193);
  cps.push(0x2212, 0x2248, 0x2260, 0x2264, 0x2265);
  return cps;
}

type Face = {
  unitsPerEm: number;
  hasGlyphForCodePoint(cp: number): boolean;
  glyphForCodePoint(cp: number): { advanceWidth: number };
};

// fontkit (pdfkit's own font reader) ships no type declarations; this is the slice used here.
const fontkit = createRequire(import.meta.url)("fontkit") as { openSync(file: string): Face };

export function readAdvances(): Map<number, number> {
  const face = fontkit.openSync(FONT);
  const out = new Map<number, number>();
  for (const cp of coveredCodePoints()) {
    if (!face.hasGlyphForCodePoint(cp)) continue;
    out.set(cp, Math.round((face.glyphForCodePoint(cp).advanceWidth * 1000) / face.unitsPerEm));
  }
  return out;
}

function renderBlock(adv: Map<number, number>): string {
  const entries = [...adv].map(([cp, w]) => `0x${cp.toString(16).padStart(4, "0")}: ${w}`);
  const lines: string[] = [];
  for (let i = 0; i < entries.length; i += 8) lines.push(`  ${entries.slice(i, i + 8).join(", ")},`);
  return [
    BEGIN,
    "// prettier-ignore",
    "const ADVANCE: Readonly<Record<number, number>> = {",
    ...lines,
    "};",
    END,
  ].join("\n");
}

function main(): void {
  const check = process.argv.includes("--check");
  const src = fs.readFileSync(TARGET, "utf8");
  const a = src.indexOf(BEGIN);
  const b = src.indexOf(END);
  if (a < 0 || b < a) {
    console.error(`rfp:tile-metrics: markers not found in ${path.relative(root, TARGET)}`);
    process.exit(2);
  }
  const next = src.slice(0, a) + renderBlock(readAdvances()) + src.slice(b + END.length);
  if (check) {
    if (next !== src) {
      console.error("rfp:tile-metrics: the advance table in tile-fit.ts does not match Archivo-Bold.ttf; run npm run rfp:tile-metrics");
      process.exit(1);
    }
    console.log("rfp:tile-metrics: table matches Archivo-Bold.ttf");
    return;
  }
  fs.writeFileSync(TARGET, next);
  console.log(`rfp:tile-metrics: wrote ${readAdvances().size} advances to ${path.relative(root, TARGET)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
