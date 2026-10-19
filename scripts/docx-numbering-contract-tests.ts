/**
 * docx numbering contract tests (ARCHITECTURE.md governance export).
 *
 *   npm run test:docxnumbering
 *
 * Pure, no network. src/lib/governance/docx.ts renderDocx gives every
 * ordered list its OWN numbering reference (gov-num-N) with two levels and
 * relies on the docx package to:
 *   1. write one concrete w:num per reference, each pointing at its own
 *      w:abstractNum (so a later list never continues an earlier list's count);
 *   2. copy level 0's `start` into a w:lvlOverride/w:startOverride on that
 *      concrete w:num (the literal first number: "4. x" renders 4, 5, ...);
 *   3. write level 1's `start` as the abstract level's w:start (the restart
 *      value Word uses each time level 0 fires).
 * docx 9.12.0 (#3768) also writes a startOverride for EVERY configured level
 * of a concrete instance; this test accepts a level-1 override only when it
 * equals the level's own start (the rendering is then unchanged) and prints
 * which shape the installed docx writes. This mirrors renderDocx's config
 * shape (level 0 first, explicit level-1 start) without needing a
 * GovernanceDoc. Added by the 2026-10-19 dependency round 2 (docx 9.11.0 ->
 * 9.12.0).
 */
import { isDeepStrictEqual } from "node:util";
import JSZip from "jszip";
import { AlignmentType, Document, LevelFormat, Packer, Paragraph } from "docx";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = isDeepStrictEqual(actual, expected);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `\n     got  ${JSON.stringify(actual)}\n     want ${JSON.stringify(expected)}`}`);
}

const cfgs = [
  { reference: "gov-num-0", start: 4, subStart: 3 },
  { reference: "gov-num-1", start: 1, subStart: 1 },
];

async function main() {
  const doc = new Document({
    numbering: {
      config: cfgs.map((c) => ({
        reference: c.reference,
        levels: [
          { level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.START, start: c.start },
          { level: 1, format: LevelFormat.LOWER_LETTER, text: "%2.", alignment: AlignmentType.START, start: c.subStart },
        ],
      })),
    },
    sections: [
      {
        children: cfgs.flatMap((c) => [
          new Paragraph({ text: `${c.reference} a`, numbering: { reference: c.reference, level: 0 } }),
          new Paragraph({ text: `${c.reference} a.i`, numbering: { reference: c.reference, level: 1 } }),
          new Paragraph({ text: `${c.reference} b`, numbering: { reference: c.reference, level: 0 } }),
        ]),
      },
    ],
  });
  const zip = await JSZip.loadAsync(await Packer.toBuffer(doc));
  const numberingXml = (await zip.file("word/numbering.xml")?.async("string")) ?? "";
  const documentXml = (await zip.file("word/document.xml")?.async("string")) ?? "";

  // abstractNumId -> { ilvl -> w:start }
  const abstracts = new Map<string, Map<string, string>>();
  for (const m of numberingXml.matchAll(/<w:abstractNum\b[^>]*w:abstractNumId="(\d+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/g)) {
    const lv = new Map<string, string>();
    for (const l of m[2].matchAll(/<w:lvl\b[^>]*w:ilvl="(\d+)"[^>]*>([\s\S]*?)<\/w:lvl>/g)) {
      const s = /<w:start w:val="(\d+)"/.exec(l[2]);
      if (s) lv.set(l[1], s[1]);
    }
    abstracts.set(m[1], lv);
  }
  // numId -> { abstractNumId, overrides: ilvl -> startOverride }
  const nums = new Map<string, { abs: string; overrides: Record<string, string> }>();
  for (const m of numberingXml.matchAll(/<w:num\b[^>]*w:numId="(\d+)"[^>]*>([\s\S]*?)<\/w:num>/g)) {
    const abs = /<w:abstractNumId w:val="(\d+)"/.exec(m[2])?.[1] ?? "";
    const overrides: Record<string, string> = {};
    for (const o of m[2].matchAll(/<w:lvlOverride w:ilvl="(\d+)">\s*<w:startOverride w:val="(\d+)"/g)) overrides[o[1]] = o[2];
    nums.set(m[1], { abs, overrides });
  }
  // numIds the document's paragraphs use, in order of first use
  const used: string[] = [];
  for (const m of documentXml.matchAll(/<w:numId w:val="(\d+)"/g)) if (!used.includes(m[1])) used.push(m[1]);

  check("two lists use two distinct concrete w:num ids", used.length, 2);
  const absIds = used.map((id) => nums.get(id)?.abs);
  check("each concrete w:num points at its own abstractNum", new Set(absIds).size, 2);
  cfgs.forEach((c, i) => {
    const n = nums.get(used[i]);
    const abs = abstracts.get(n?.abs ?? "");
    check(`${c.reference}: level 0 startOverride = ${c.start}`, n?.overrides["0"], String(c.start));
    check(`${c.reference}: abstract level 0 w:start = ${c.start}`, abs?.get("0"), String(c.start));
    check(`${c.reference}: abstract level 1 w:start = ${c.subStart}`, abs?.get("1"), String(c.subStart));
    const l1 = n?.overrides["1"];
    check(`${c.reference}: a level-1 startOverride, if written, equals the level's own start`, l1 === undefined || l1 === String(c.subStart), true);
    console.log(`info ${c.reference}: overrides written ${JSON.stringify(n?.overrides)}`);
  });

  console.log(failures === 0 ? "docx numbering contract: all checks passed" : `docx numbering contract: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
