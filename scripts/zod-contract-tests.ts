/**
 * zod contract tests (ARCHITECTURE.md §5.17 RFP content model).
 *
 *   npm run test:zod
 *
 * Pure, no network. src/lib/rfp/content-model/schema.ts is the only host
 * file that imports zod; parseBlock/parseBlocks call `.parse()` (throws) and
 * the tests and draft paths call `.safeParse().success`. It relies on zod to:
 *   1. accept a well-formed block of every shape used here through the
 *      `kind` discriminated union, and reject an unknown `kind`;
 *   2. reject an empty `id` / `sectionId` (`z.string().min(1)`), a negative or
 *      fractional `ordinal`, and arrays outside their `.min()/.max()` bounds
 *      (stat-tiles 2..6);
 *   3. throw from `.parse()` immediately with a ZodError, and report
 *      `success: false` with readable issues from `.safeParse()`;
 *   4. strip unknown keys from an object (the default, non-strict mode).
 * Zod 4.5 made string lengths count code points (an astral id still has
 * length >= 1) and 4.6 builds safeParse errors lazily (pinned by reading
 * `.error.issues` after the parse). Added by the 2026-10-24 dependency round
 * (zod 4.4.3 -> 4.6.7, GHSA-mrhx-c7xc-m3w5; zod is now a declared dependency).
 */
import { isDeepStrictEqual } from "node:util";
import { ZodError } from "zod";
import { blockSchema, parseBlock, parseBlocks } from "../src/lib/rfp/content-model/schema";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = isDeepStrictEqual(actual, expected);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `\n     got  ${JSON.stringify(actual)}\n     want ${JSON.stringify(expected)}`}`);
}

const base = { id: "blk_1", sectionId: "sec_1", ordinal: 0, cites: [], generatedBy: "llm", editedByHuman: false };
const prose = { ...base, kind: "prose", text: "Hello." };
const tile = (n: number) => ({ value: String(n), label: `L${n}` });
const tiles = (n: number) => ({ ...base, kind: "stat-tiles", tiles: Array.from({ length: n }, (_, i) => tile(i)) });

check("prose accepted", blockSchema.safeParse(prose).success, true);
check("heading accepted", blockSchema.safeParse({ ...base, kind: "heading", level: 2, text: "H" }).success, true);
check("list accepted", blockSchema.safeParse({ ...base, kind: "list", style: "bullet", items: ["a"] }).success, true);
check("unknown kind rejected", blockSchema.safeParse({ ...base, kind: "nope", text: "x" }).success, false);
check("heading level 4 rejected", blockSchema.safeParse({ ...base, kind: "heading", level: 4, text: "H" }).success, false);
check("empty id rejected", blockSchema.safeParse({ ...prose, id: "" }).success, false);
check("empty sectionId rejected", blockSchema.safeParse({ ...prose, sectionId: "" }).success, false);
check("astral one-character id accepted", blockSchema.safeParse({ ...prose, id: "\u{1F600}" }).success, true);
check("negative ordinal rejected", blockSchema.safeParse({ ...prose, ordinal: -1 }).success, false);
check("fractional ordinal rejected", blockSchema.safeParse({ ...prose, ordinal: 1.5 }).success, false);
check("stat-tiles: 1 rejected, 2 and 6 accepted, 7 rejected",
  [1, 2, 6, 7].map((n) => blockSchema.safeParse(tiles(n)).success), [false, true, true, false]);

const parsed = parseBlock({ ...prose, extra: "dropped" });
check("parse strips unknown keys", "extra" in parsed, false);
check("parse returns the block's fields", [parsed.kind, parsed.id], ["prose", "blk_1"]);
check("parseBlocks parses an array", parseBlocks([prose, prose]).length, 2);

let thrown: unknown = null;
try { parseBlock({ ...prose, id: "" }); } catch (e) { thrown = e; }
check("parse throws a ZodError", thrown instanceof ZodError, true);
const bad = blockSchema.safeParse({ ...prose, id: "" });
check("safeParse failure carries an issue at path id", bad.success ? null : bad.error.issues.map((i) => i.path.join(".")), ["id"]);

console.log(failures === 0 ? "zod contract: all checks passed" : `zod contract: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
