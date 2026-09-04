#!/usr/bin/env -S npx tsx
// Tests for the /work team-card PLACEMENTS (src/lib/work/placements.ts,
// owner directive 2026-08-29): the pure splitter (placed vs run, unknown-bay
// fallback, order preservation, empty input), the sequence arithmetic (map
// driven, never row driven), and a STRIPE PARITY WALK over the REAL page
// source: page.tsx is scanned ONCE for the ordered token stream of
// `<section id="..." className="...">`, `<PlacedCards bay="NN"` and
// `<CommunitySection`, that stream is checked for shape (every PlacedCards
// slot follows its bay's last static and precedes the next bay's first,
// CommunitySection last), and then walked for strict lightline/plain
// alternation from #brain in three DB states: the placed row published, the
// placed row absent (one seam per odd-count bay, inside the bay it left;
// today two), and DB down or empty. Run: npm run test:placements (tsx, no DB).

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PublishedCard } from "../src/lib/work/db";
import {
  TEAM_CARD_PLACEMENTS,
  sequencePositions,
  splitPlacements,
} from "../src/lib/work/placements";
import staticTitles from "../src/lib/work/static-titles.json";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, "..", rel), "utf8");

function card(slug: string): PublishedCard {
  return {
    id: `id-${slug}`,
    slug,
    card: {
      title: slug,
      categoryBadge: "Skill",
      summary: "",
      body: [],
      facets: [],
      footerLine: [],
    },
    submitterName: null,
    publishedAt: new Date("2026-08-29T00:00:00Z"),
    docPath: "",
    timeSavedMinutes: null,
  };
}

const BAYS = staticTitles.bays.map((b) => b.n);
const EXHIBITS = staticTitles.exhibits;
const countIn = (bay: string) => EXHIBITS.filter((e) => e.bay === bay).length;
let n = 0;
const test = (name: string, fn: () => void) => {
  fn();
  n++;
  console.log(`ok - ${name}`);
};

// ---------------------------------------------------------------- splitter

test("seeded placements: Rescue Mirror + XLAnt + XLing -> bay 03, MyCoach -> bay 02", () => {
  assert.strictEqual(TEAM_CARD_PLACEMENTS["team-client-site-rescue-mirror"], "03");
  assert.strictEqual(TEAM_CARD_PLACEMENTS["team-mycoach"], "02");
  assert.strictEqual(TEAM_CARD_PLACEMENTS["team-xlant"], "03");
  assert.strictEqual(TEAM_CARD_PLACEMENTS["team-xling"], "03");
  assert.ok(BAYS.includes("02"), "bay 02 exists in static-titles.json");
  assert.ok(BAYS.includes("03"), "bay 03 exists in static-titles.json");
});

test("split: placed slug lands in its bay, everything else in the run", () => {
  const cards = [card("team-a"), card("team-client-site-rescue-mirror"), card("team-b")];
  const { placed, run } = splitPlacements(cards, BAYS);
  assert.deepStrictEqual([...placed.keys()], ["03"]);
  assert.deepStrictEqual(placed.get("03")!.map((c) => c.slug), [
    "team-client-site-rescue-mirror",
  ]);
  assert.deepStrictEqual(run.map((c) => c.slug), ["team-a", "team-b"]);
});

test("split: empty input -> no placed keys, empty run", () => {
  const { placed, run } = splitPlacements([], BAYS);
  assert.strictEqual(placed.size, 0);
  assert.deepStrictEqual(run, []);
});

test("split: order inside both lanes is the input (publishedCards) order", () => {
  const cards = [card("z"), card("y"), card("x"), card("w")];
  const { placed, run } = splitPlacements(cards, BAYS, { y: "04", w: "04", z: "01" });
  assert.deepStrictEqual(placed.get("04")!.map((c) => c.slug), ["y", "w"]);
  assert.deepStrictEqual(placed.get("01")!.map((c) => c.slug), ["z"]);
  assert.deepStrictEqual(run.map((c) => c.slug), ["x"]);
});

test("split: a placement naming a bay static-titles.json lacks falls back to the run", () => {
  const cards = [card("team-typo"), card("team-ok")];
  const { placed, run } = splitPlacements(cards, BAYS, { "team-typo": "09", "team-ok": "02" });
  assert.deepStrictEqual([...placed.keys()], ["02"]);
  assert.deepStrictEqual(run.map((c) => c.slug), ["team-typo"]);
});

test("split: prototype keys are not placements", () => {
  const { placed, run } = splitPlacements([card("constructor"), card("toString")], BAYS);
  assert.strictEqual(placed.size, 0);
  assert.strictEqual(run.length, 2);
});

// ------------------------------------------------------------- positions

test("positions: counted from the MAP (known bays only), never from rows", () => {
  const { placedStart, runFirst } = sequencePositions(EXHIBITS, BAYS);
  const upTo03 = countIn("01") + countIn("02") + countIn("03");
  // bay 03's start counts the ONE bay-02 map entry ahead of it; bay 04's
  // counts all four placements (one in 02, three in 03).
  assert.strictEqual(placedStart.get("03"), upTo03 + 1 + 1);
  assert.strictEqual(placedStart.get("04"), upTo03 + 4 + countIn("04") + 1);
  assert.strictEqual(runFirst, EXHIBITS.length + 4 + 1);
  assert.deepStrictEqual([...placedStart.keys()], BAYS);
  // Today's numbers, stated so a change to either side is a visible edit.
  // By hand: statics per bay are 1 + 8 + 2 + 2 + 3 = 16 (the #morning-brief
  // exhibit retired 2026-09-04), placements 1 in 02 + 3 in 03, so the run
  // starts at 16 + 4 + 1 = 21.
  assert.strictEqual(EXHIBITS.length, 16);
  assert.strictEqual(placedStart.get("02"), 10);
  assert.strictEqual(placedStart.get("03"), 13);
  assert.strictEqual(placedStart.get("04"), 18);
  assert.strictEqual(runFirst, 21);
});

test("positions: an entry naming an unknown bay counts zero, matching its fallback to the run", () => {
  const withTypo = { ...TEAM_CARD_PLACEMENTS, "team-typo": "09" };
  assert.deepStrictEqual(
    sequencePositions(EXHIBITS, BAYS, withTypo),
    sequencePositions(EXHIBITS, BAYS)
  );
});

test("positions: an empty map -> the run starts right after the last static", () => {
  const { runFirst } = sequencePositions(EXHIBITS, BAYS, {});
  assert.strictEqual(runFirst, EXHIBITS.length + 1);
});

// ------------------------------------------------------ parity walk

const PLAIN = "panel rise";
const LIGHT = "panel panel--lightline rise";
/** The ONE rule CommunityCard applies to its `index` (work-card.tsx). */
const classAt = (position: number) => (position % 2 === 0 ? PLAIN : LIGHT);

type Token =
  | { kind: "static"; id: string; cls: string }
  | { kind: "placed"; bay: string }
  | { kind: "run" };

/** Scan page.tsx ONCE for the ordered token stream the walk is built on. */
function scanPage(): Token[] {
  const page = read("src/app/work/page.tsx");
  const re =
    /<section id="([^"]+)" className="(panel[^"]*)">|<PlacedCards bay="(\d\d)"|<CommunitySection\b/g;
  const tokens: Token[] = [];
  for (const m of page.matchAll(re)) {
    if (m[1]) tokens.push({ kind: "static", id: m[1], cls: m[2] });
    else if (m[3]) tokens.push({ kind: "placed", bay: m[3] });
    else tokens.push({ kind: "run" });
  }
  return tokens;
}

test("token stream: every PlacedCards slot sits between its bay's last static and the next bay's first; CommunitySection is last", () => {
  const tokens = scanPage();
  const statics = tokens.filter((t) => t.kind === "static") as { id: string }[];
  assert.strictEqual(statics.length, EXHIBITS.length, "every exhibit scraped exactly once");
  assert.deepStrictEqual(statics.map((s) => s.id), EXHIBITS.map((e) => e.id), "static order == snapshot order");
  const bayOf = new Map(EXHIBITS.map((e) => [e.id, e.bay]));
  const slots = tokens.filter((t) => t.kind === "placed") as { bay: string }[];
  assert.deepStrictEqual(slots.map((s) => s.bay), BAYS, "one slot per bay, in bay order");
  tokens.forEach((t, i) => {
    if (t.kind !== "placed") return;
    const prev = tokens[i - 1];
    assert.ok(prev && prev.kind === "static", `slot ${t.bay} follows a static`);
    assert.strictEqual(bayOf.get(prev.id), t.bay, `slot ${t.bay} follows its own bay's last static`);
    const next = tokens[i + 1];
    if (next && next.kind === "static") {
      assert.notStrictEqual(bayOf.get(next.id), t.bay, `slot ${t.bay} precedes the NEXT bay's first static`);
    } else {
      assert.ok(next && next.kind === "run" && t.bay === BAYS[BAYS.length - 1], "only the last bay's slot is followed by the run");
    }
  });
  assert.strictEqual(tokens[tokens.length - 1].kind, "run", "CommunitySection is the last token");
  assert.strictEqual(tokens.filter((t) => t.kind === "run").length, 1);
});

/** Render the token stream for a given set of published cards, exactly as
 * page.tsx does: statics keep their literal class, placed cards take
 * classAt(placedStart + i), the run takes classAt(runFirst + i). */
function render(published: PublishedCard[]): { id: string; cls: string }[] {
  const tokens = scanPage();
  const { placed, run } = splitPlacements(published, BAYS);
  const { placedStart, runFirst } = sequencePositions(EXHIBITS, BAYS);
  const out: { id: string; cls: string }[] = [];
  for (const t of tokens) {
    if (t.kind === "static") out.push({ id: t.id, cls: t.cls });
    else if (t.kind === "placed")
      (placed.get(t.bay) ?? []).forEach((c, i) =>
        out.push({ id: c.slug, cls: classAt(placedStart.get(t.bay)! + i) })
      );
    else run.forEach((c, i) => out.push({ id: c.slug, cls: classAt(runFirst + i) }));
  }
  return out;
}

/** Every adjacent pair with the SAME class, as "a->b". */
const seams = (seq: { id: string; cls: string }[]) =>
  seq.flatMap((row, i) => (i > 0 && seq[i - 1].cls === row.cls ? [`${seq[i - 1].id}->${row.id}`] : []));

test("parity walk, published: statics + placed card + run alternate strictly from #brain", () => {
  const seq = render([...Object.keys(TEAM_CARD_PLACEMENTS).map(card), card("r1"), card("r2"), card("r3")]);
  assert.strictEqual(seq.length, EXHIBITS.length + Object.keys(TEAM_CARD_PLACEMENTS).length + 3);
  assert.strictEqual(seq[0].id, "brain");
  seq.forEach((row, i) =>
    assert.strictEqual(row.cls, classAt(i + 1), `#${row.id} at global position ${i + 1} should be "${classAt(i + 1)}", is "${row.cls}"`)
  );
  assert.deepStrictEqual(seams(seq), []);
  const my = seq.findIndex((r) => r.id === "team-mycoach");
  assert.strictEqual(my + 1, 10);
  assert.strictEqual(seq[my - 1].id, "your-ai-roadmap");
  assert.strictEqual(seq[my + 1].id, "qbr-machine");
  const at = seq.findIndex((r) => r.id === "team-client-site-rescue-mirror");
  assert.strictEqual(at + 1, 13, "bay 03's placed list starts at 13");
  assert.strictEqual(seq[at - 1].id, "onboarding-toolkit");
  assert.strictEqual(seq[at + 1].id, "team-xlant");
  assert.strictEqual(seq[at + 2].id, "team-xling");
  assert.strictEqual(seq[at + 3].id, "lakehouse");
  assert.strictEqual(seq[20].id, "r1");
  assert.strictEqual(seq[20].cls, LIGHT, "run starts at 21, lightline");
});

test("parity walk, placed rows unpublished: one seam per odd-count bay's exit, today two; the run seam holds", () => {
  // BOTH placed bays now hold ODD counts (one card in 02, three in 03),
  // so each bay's exit double-stripes: bay 02's into bay 03 and bay 03's
  // into bay 04. The two odd shifts cancel by bay 04, so bays 04-05 and
  // the "From the Team" seam hold.
  const seq = render([card("r1"), card("r2")]);
  assert.deepStrictEqual(seams(seq), [
    "your-ai-roadmap->qbr-machine",
    "onboarding-toolkit->lakehouse",
  ]);
  const r1 = seq.findIndex((r) => r.id === "r1");
  assert.strictEqual(r1 + 1, 17, "run follows the 16 statics directly");
  assert.strictEqual(seq[r1 - 1].id, "autotask-ci-intake");
  assert.notStrictEqual(seq[r1 - 1].cls, seq[r1].cls, "the From the Team seam does not double-stripe");
});

test("parity walk, DB down or empty: statics only, the same two seams and nothing else", () => {
  const seq = render([]);
  assert.strictEqual(seq.length, EXHIBITS.length);
  assert.deepStrictEqual(seams(seq), [
    "your-ai-roadmap->qbr-machine",
    "onboarding-toolkit->lakehouse",
  ]);
});

// ---------------------------------------------------- source invariants

test("source: community.tsx renders the run at firstPosition + i", () => {
  const src = read("src/app/work/community.tsx");
  assert.ok(src.includes("index={firstPosition + i}"), "run offset is the computed global position");
  assert.ok(!/index=\{i(?: \+ 1)?\}/.test(src), "no literal offset survives");
});

test("source: page.tsx computes positions from the map and hands the run to CommunitySection", () => {
  const src = read("src/app/work/page.tsx");
  assert.ok(src.includes("sequencePositions(exhibits, bayNumbers)"), "positions take no `placed` argument");
  assert.ok(src.includes("<CommunitySection cards={run} firstPosition={positions.runFirst} />"));
  assert.ok(!src.includes("<CommunitySection cards={team}"), "the run, never the whole fetch");
});

test("source: the pager scopes the divider check to the divider's own run", () => {
  const src = read("src/app/work/pager.tsx");
  assert.ok(
    src.includes(`'[data-team-divider] ~ section.panel[id][data-work-card="team"]:not([hidden])'`),
    "divider visibility keys on following siblings, not the whole page"
  );
});

test("source: work-card.tsx placed badge is opt-in and reads From the Team", () => {
  const src = read("src/components/work-card.tsx");
  assert.ok(src.includes("placed = false"));
  assert.ok(src.includes(`{placed && <span className="badge badge--light">From the Team</span>}`));
});

test("source: page.tsx renders a placed card at its global position with the badge", () => {
  const src = read("src/app/work/page.tsx");
  assert.ok(
    src.includes("<CommunityCard key={item.id} item={item} index={first + i} placed />"),
    "placed cards take placedStart + i and the placed badge"
  );
});

test("source: registry.tsx orders placed rows after their bay's statics and the run last in 05", () => {
  const src = read("src/app/work/registry.tsx");
  const statics = src.indexOf(".filter((e) => e.bay === bay.n)");
  const placed = src.indexOf("placed.get(bay.n)");
  const run = src.indexOf('bay.n === "05"');
  assert.ok(statics >= 0 && placed >= 0 && run >= 0, "all three row sources present");
  assert.ok(statics < placed && placed < run, "statics, then placed rows, then the bay-05 run");
});

console.log(`\n${n} placements tests passed`);
