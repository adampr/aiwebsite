#!/usr/bin/env -S npx tsx
// Tests for the /work COUNTS reconciliation (src/lib/work/counts.ts, owner
// directive 2026-09-28): the page shows exhibits + team cards while every
// DB-derived count sees only the team lane. What THIS file makes
// edit-visible: the composition formula (total = exhibits + team), the
// static lane (15, snapshot-pinned), the byte-exact public sentence at
// input 129, and the call-site wiring. The team count itself is NOT pinned:
// composeWorkCounts(129) is a pure function-output pin, so the live DB
// count moves 129 -> 130 at the next publish with no edit here and the
// page follows through the one formula, which is the point. Also
// source-pins the wiring: page.tsx composes the one counts value (exactly
// one call), the registry renders the one reconciliation line (exactly
// once), the pager totals from the same value.
// Run: npm run test:workcounts (tsx, no DB).

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { composeWorkCounts, workCountsLine } from "../src/lib/work/counts";
import staticTitles from "../src/lib/work/static-titles.json";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, "..", rel), "utf8");

let n = 0;
const test = (name: string, fn: () => void) => {
  fn();
  n++;
  console.log(`ok - ${name}`);
};

// ------------------------------------------------------------ composition

test("today's numbers, pinned by design: 15 exhibits + 129 team = 144", () => {
  assert.deepStrictEqual(composeWorkCounts(129), {
    exhibits: 15,
    team: 129,
    total: 144,
  });
});

test("snapshot shape: static-titles.json holds 15 exhibits in 5 bays", () => {
  assert.strictEqual(staticTitles.exhibits.length, 15);
  assert.strictEqual(staticTitles.bays.length, 5);
});

test("total is exhibits + team at every team count, exhibits never move", () => {
  for (const team of [0, 1, 42, 129, 500]) {
    const c = composeWorkCounts(team);
    assert.strictEqual(c.exhibits, staticTitles.exhibits.length);
    assert.strictEqual(c.team, team);
    assert.strictEqual(c.total, c.exhibits + c.team);
  }
});

// ------------------------------------------------------- the public line

test("reconciliation line, byte-pinned", () => {
  assert.strictEqual(
    workCountsLine(composeWorkCounts(129)),
    "144 works · 129 team-submitted, published from the live database · 15 built into the page"
  );
});

test("line shape: starts with the total, names both components, middot-separated", () => {
  const c = composeWorkCounts(129);
  const line = workCountsLine(c);
  assert.ok(line.startsWith(`${c.total} works`), "opens with `<total> works`");
  assert.ok(line.includes(`${c.team} `), "names the team count");
  assert.ok(line.includes(`${c.exhibits} `), "names the exhibit count");
  assert.ok(line.includes("database"), "says where the team count lives");
  assert.strictEqual(line.split(" · ").length, 3, "two middot separators");
});

test("line carries no em dash, no en dash, no spaced hyphen-as-dash", () => {
  const line = workCountsLine(composeWorkCounts(129));
  assert.ok(!/[\u2013\u2014]/.test(line), "no em or en dash");
  assert.ok(!/\s-\s/.test(line), "no hyphen used as a dash");
});

// ---------------------------------------------------- source invariants

test("source: counts.ts is pure (no DB import, no React)", () => {
  const src = read("src/lib/work/counts.ts");
  assert.ok(src.includes('from "./static-titles.json"'), "exhibits from the snapshot");
  assert.ok(!/from "\.\/db"|from "react"|drizzle/.test(src), "no DB, no React");
});

test("source: page.tsx composes THE counts once and feeds registry + pager from it", () => {
  const src = read("src/app/work/page.tsx");
  assert.ok(
    src.includes("const counts = composeWorkCounts(team.length)"),
    "one composition, from the one guarded fetch"
  );
  assert.ok(
    src.includes("<WorkRegistry placed={placed} run={run} counts={counts} />"),
    "registry takes the composed counts"
  );
  assert.ok(src.includes("<WorkPager counts={counts} />"), "pager takes the composed counts");
  assert.ok(!src.includes("staticCount="), "no side-channel static count survives");
  assert.strictEqual(
    (src.match(/composeWorkCounts\(/g) ?? []).length,
    1,
    "exactly ONE composeWorkCounts() call in page.tsx (the import carries no paren)"
  );
});

test("source: registry.tsx renders workCountsLine(counts) and keeps no local total arithmetic", () => {
  const src = read("src/app/work/registry.tsx");
  assert.ok(src.includes("{workCountsLine(counts)}"), "the foot line is THE helper's string");
  assert.strictEqual(
    (src.match(/workCountsLine\(counts\)/g) ?? []).length,
    1,
    "exactly ONE workCountsLine(counts) render in registry.tsx"
  );
  assert.ok(src.includes("String(counts.total)"), "width derives from counts.total");
  assert.ok(
    !src.includes("exhibits.length +"),
    "no local exhibits-plus-team arithmetic survives"
  );
});

test("source: pager.tsx totals from counts.total and keeps its fail-open DOM check", () => {
  const src = read("src/app/work/pager.tsx");
  assert.ok(src.includes("const total = counts.total"), "total is counts.total");
  assert.ok(
    src.includes("panels.length !== total"),
    "the mount-time panel-count check still gates the island"
  );
});

console.log(`\n${n} counts tests passed`);
