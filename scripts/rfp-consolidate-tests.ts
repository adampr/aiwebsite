/**
 * Whole-document consolidation scan tests (ARCHITECTURE.md §5.17.16).
 *
 *   npm run test:rfpconsolidate
 *
 * Pure, no server, no DB. Pins the deterministic duplicate scan the
 * consolidation review turn feeds on (normalization, the 0.5 containment
 * threshold on word 8-gram shingles, cross-section-only pairing, the letter
 * and short-paragraph exclusions, cluster ordering and the cap of 12) and
 * the two prompt-line builders' whole-line budget behavior.
 */

import {
  CONSOLIDATE_INSTRUCTION,
  findDuplicateClusters,
  formatDuplicateFindings,
  requirementLines,
  type DuplicateCluster,
} from "../src/lib/rfp/consolidate";
import { LETTER_LABEL } from "../src/lib/rfp/letter";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `\n     got ${a}\n     want ${e}`}`
  );
}

/** n distinct words sharing a stem, joined: "s1 s2 ... sn". */
const words = (stem: string, n: number, from = 1): string =>
  Array.from({ length: n }, (_, i) => `${stem}${from + i}`).join(" ");

const sec = (
  label: string,
  paragraphs: string[]
): { label: string; title: string; paragraphs: string[] } => ({
  label,
  title: `Title ${label}`,
  paragraphs,
});

// Filler paragraphs long enough to enter the scan but sharing no shingles.
const fillerA = words("fillera", 20);
const fillerB = words("fillerb", 20);

// ---- CONSOLIDATE_INSTRUCTION ------------------------------------------------

check(
  "instruction has no em dash",
  CONSOLIDATE_INSTRUCTION.includes(String.fromCharCode(0x2014)),
  false
);
check(
  "instruction is at least 3 chars",
  CONSOLIDATE_INSTRUCTION.length >= 3,
  true
);
check(
  "instruction adds nothing new",
  CONSOLIDATE_INSTRUCTION.includes("add nothing new."),
  true
);

// ---- verbatim cross-section duplicate ---------------------------------------

const dup = words("dup", 19);
{
  const clusters = findDuplicateClusters([
    sec("A", [dup, fillerA]),
    sec("B", [fillerB, dup]),
  ]);
  check("verbatim cross-section dup: one cluster", clusters.length, 1);
  check("dup cluster labels in document order", clusters[0]?.labels, [
    "A",
    "B",
  ]);
  check(
    "dup cluster members",
    clusters[0]?.members.map((m) => `${m.label}:${m.paragraph}`),
    ["A:0", "B:1"]
  );
  check(
    "cluster excerpt is the first member's original text",
    clusters[0]?.excerpt,
    dup.slice(0, 160)
  );
}

// ---- same-section duplicate is NOT reported ---------------------------------

check(
  "same-section dup not reported",
  findDuplicateClusters([sec("A", [dup, dup]), sec("B", [fillerB])]).length,
  0
);

// ---- letter excluded --------------------------------------------------------

check(
  "letter excluded from the scan",
  findDuplicateClusters([
    sec(LETTER_LABEL, [dup]),
    sec("A", [dup, fillerA]),
  ]).length,
  0
);

// ---- <12-word paragraphs skipped --------------------------------------------

const eleven = words("shorty", 11);
const twelve = words("dozen", 12);
check(
  "11-word paragraphs skipped",
  findDuplicateClusters([sec("A", [eleven]), sec("B", [eleven])]).length,
  0
);
check(
  "12-word paragraphs scanned",
  findDuplicateClusters([sec("A", [twelve]), sec("B", [twelve])]).length,
  1
);

// ---- threshold boundary: containment over min(|A|,|B|) ----------------------

// base has 19 words -> 12 shingles. A paragraph sharing its first 13 words
// shares 6 shingles (6/12 = 0.5, duplicate); sharing only the first 12 words
// shares 5 (5/12 < 0.5, not a duplicate).
{
  const base = words("bnd", 19);
  const atHalf = `${words("bnd", 13)} ${words("pad", 6)}`;
  const below = `${words("bnd", 12)} ${words("pad", 7)}`;
  check(
    "containment exactly 0.5 is a duplicate",
    findDuplicateClusters([sec("A", [base]), sec("B", [atHalf])]).length,
    1
  );
  check(
    "containment below 0.5 is not",
    findDuplicateClusters([sec("A", [base]), sec("B", [below])]).length,
    0
  );
}

// ---- normalization: NFKC, case, punctuation ---------------------------------

{
  // Same sentence: one copy carries caps, commas and an NFKC-foldable
  // ligature ("conﬁrm" vs "confirm"); normalization must equate them.
  const plain =
    "our team will confirm every backup job and report the result each morning without fail";
  const fancy =
    "Our team, will conﬁrm every backup job, and report the result each morning without fail.";
  const clusters = findDuplicateClusters([
    sec("A", [fancy, fillerA]),
    sec("B", [plain]),
  ]);
  check("NFKC + case + punctuation normalize equal", clusters.length, 1);
  check(
    "excerpt keeps the ORIGINAL un-normalized text",
    clusters[0]?.excerpt,
    fancy.slice(0, 160)
  );
  check(
    "member excerpt also original",
    clusters[0]?.members[1]?.excerpt,
    plain.slice(0, 160)
  );
}

// ---- cluster merge across 3 sections, largest first -------------------------

{
  const trio = words("trio", 19);
  const pair = words("pair", 19);
  const clusters = findDuplicateClusters([
    sec("A", [pair, trio]),
    sec("B", [trio, fillerB]),
    sec("C", [trio, pair]),
  ]);
  check("two clusters found", clusters.length, 2);
  check("largest cluster first", clusters[0]?.members.length, 3);
  check("3-section cluster labels", clusters[0]?.labels, ["A", "B", "C"]);
  check("2-member cluster second", clusters[1]?.members.length, 2);
  check("2-member cluster labels", clusters[1]?.labels, ["A", "C"]);
}

// ---- cap at 12 clusters ------------------------------------------------------

{
  const sections: { label: string; title: string; paragraphs: string[] }[] =
    [];
  for (let k = 1; k <= 14; k++) {
    const p = words(`cap${k}x`, 19);
    sections.push(sec(`S${k}a`, [p]));
    sections.push(sec(`S${k}b`, [p]));
  }
  check(
    "at most 12 clusters",
    findDuplicateClusters(sections).length,
    12
  );
}

// ---- determinism -------------------------------------------------------------

{
  const build = () =>
    findDuplicateClusters([
      sec("A", [dup, words("beta", 19), fillerA]),
      sec("B", [words("beta", 19), dup]),
      sec("C", [dup]),
    ]);
  check("two runs return identical output", build(), build());
}

// ---- scale: 80 sections x 12 paragraphs stays fast ---------------------------

{
  const sections = Array.from({ length: 80 }, (_, s) =>
    sec(
      `SC${s}`,
      Array.from({ length: 12 }, (_, p) =>
        // Every 10th section repeats one shared paragraph; the rest unique.
        p === 0 && s % 10 === 0 ? words("shared", 19) : words(`u${s}x${p}q`, 19)
      )
    )
  );
  const started = Date.now();
  const clusters = findDuplicateClusters(sections);
  const ms = Date.now() - started;
  check("scale run finds the shared cluster", clusters.length, 1);
  check("scale run cluster size", clusters[0]?.members.length, 8);
  check("scale run under 2000ms", ms < 2000, true);
}

// ---- formatDuplicateFindings --------------------------------------------------

const cluster = (labels: string[], excerpt: string): DuplicateCluster => ({
  labels,
  members: labels.map((l, i) => ({ label: l, paragraph: i, excerpt })),
  excerpt,
});

check(
  "findings line format",
  formatDuplicateFindings(
    [cluster(["A", "B"], "shared text")],
    (l) => `T-${l}`
  ),
  '- The same passage appears in T-A, T-B: "shared text"'
);
check(
  "findings joins lines with newline",
  formatDuplicateFindings(
    [cluster(["A", "B"], "one"), cluster(["C", "D", "E"], "two")],
    (l) => l
  ),
  '- The same passage appears in A, B: "one"\n- The same passage appears in C, D, E: "two"'
);
check("findings empty input", formatDuplicateFindings([], (l) => l), "");

{
  // 15 lines of ~205 chars overflow 2400: whole trailing lines drop.
  const long = "x".repeat(160);
  const many = Array.from({ length: 15 }, () => cluster(["A", "B"], long));
  const out = formatDuplicateFindings(many, (l) => l);
  check("findings capped at 2400", out.length <= 2400, true);
  const lines = out.split("\n");
  check("findings dropped whole lines only", lines.length < 15, true);
  check(
    "every kept findings line is complete",
    lines.every(
      (l) => l.startsWith("- The same passage appears in ") && l.endsWith('"')
    ),
    true
  );
}

// ---- requirementLines ----------------------------------------------------------

const req = (
  structureLabel: string,
  text: string,
  mandatory: boolean
): { structureLabel: string; text: string; kind: string; mandatory: boolean } => ({
  structureLabel,
  text,
  kind: "question",
  mandatory,
});

check(
  "requirement line format",
  requirementLines([req("4.2", "Describe your help desk.", true)]),
  "- [4.2] Describe your help desk."
);
check(
  "mandatory first, stable within groups",
  requirementLines([
    req("n1", "optional one", false),
    req("m1", "must one", true),
    req("n2", "optional two", false),
    req("m2", "must two", true),
  ]),
  "- [m1] must one\n- [m2] must two\n- [n1] optional one\n- [n2] optional two"
);
check(
  "requirement text sliced to 200",
  requirementLines([req("L", "y".repeat(250), true)]),
  `- [L] ${"y".repeat(200)}`
);
check("requirementLines empty input", requirementLines([]), "");

{
  const ten = Array.from({ length: 10 }, (_, i) =>
    req(`R${i}`, "z".repeat(50), i < 5)
  );
  const out = requirementLines(ten, 200);
  check("budget respected", out.length <= 200, true);
  const lines = out.split("\n");
  const tail = lines[lines.length - 1];
  const m = /^- \(and (\d+) more requirements\)$/.exec(tail);
  check("cut block ends with the tail line", m !== null, true);
  check(
    "tail count accounts for every hidden requirement",
    (lines.length - 1) + Number(m?.[1] ?? -1),
    10
  );
  check(
    "default budget shows everything small",
    requirementLines(ten).split("\n").length,
    10
  );
}

// ---- refuter round additions (2026-09-30) --------------------------------------

{
  // A first line that alone overflows the cap yields "", never a cut line.
  const one: DuplicateCluster = {
    labels: ["A"],
    members: [{ label: "A", paragraph: 0, excerpt: "e" }],
    excerpt: "e",
  };
  check(
    "first findings line over the cap yields empty",
    formatDuplicateFindings([one], () => "t".repeat(3000)),
    ""
  );
}

{
  // Equal member counts: the pair with more total shingle mass sorts first.
  const clusters = findDuplicateClusters([
    sec("C", [words("x", 12)]),
    sec("D", [words("x", 12)]),
    sec("E", [words("y", 30)]),
    sec("F", [words("y", 30)]),
  ]);
  check("tie on member count breaks on total shingles", [
    clusters.map((c) => c.labels),
    clusters.length,
  ], [
    [
      ["E", "F"],
      ["C", "D"],
    ],
    2,
  ]);
}

{
  // Two members in one section joined through a third elsewhere: labels
  // dedupe while every member is reported.
  const dup = words("q", 20);
  const clusters = findDuplicateClusters([
    sec("A", [dup, dup]),
    sec("B", [dup]),
  ]);
  check("cluster labels dedupe within a section", [
    clusters.length,
    clusters[0]?.labels,
    clusters[0]?.members.length,
  ], [1, ["A", "B"], 3]);
}

// ---- verdict -------------------------------------------------------------------

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);
