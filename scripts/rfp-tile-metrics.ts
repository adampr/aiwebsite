/**
 * Regenerate (or check) the Archivo Bold advance table in src/lib/rfp/tile-fit.ts.
 *
 *   npm run rfp:tile-metrics            # rewrite the generated block from the vendored TTF
 *   npm run rfp:tile-metrics -- --check # exit 1 if the block differs from the TTF
 *
 * Reads public/brand/fonts/Archivo-Bold.ttf, the face both exports embed, and tables EVERY code
 * point it carries a glyph for (not a hand-picked subset: the face has glyphs wider than anything
 * a subset would hold, U+01C4 at 1382). A character outside the table is one Archivo cannot set,
 * so tile-fit charges it a fallback face's width and the draft contract refuses it.
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

type Face = {
  unitsPerEm: number;
  characterSet: number[];
  glyphForCodePoint(cp: number): { id: number; advanceWidth: number };
};

// fontkit is pdfkit's own font reader (resolved through pdfkit, so it is the copy the PDF emitter
// measures with); it ships no type declarations, and this is the slice used here.
const requireFromPdfkit = createRequire(createRequire(import.meta.url).resolve("pdfkit"));
const fontkit = requireFromPdfkit("fontkit") as { openSync(file: string): Face };

/** Archivo Bold's advance for every code point it carries, in 1/1000 em, by code point. */
export function readAdvances(): Map<number, number> {
  const face = fontkit.openSync(FONT);
  const out = new Map<number, number>();
  for (const cp of [...face.characterSet].sort((a, b) => a - b)) {
    if (cp < 0x20) continue; // control characters never render
    const glyph = face.glyphForCodePoint(cp);
    // Not glyphs: cmap format 4's closing segment maps U+FFFF to .notdef (the missing-glyph box),
    // and U+E0FF, U+EFFD, U+F000 are empty private-use placeholders.
    if (glyph.id === 0 || (cp >= 0xe000 && cp <= 0xf8ff)) continue;
    out.set(cp, Math.round((glyph.advanceWidth * 1000) / face.unitsPerEm));
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
