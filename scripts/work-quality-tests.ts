// Tests for the §5.16 quality backfill lane (scripts/work-quality-backfill.ts
// + scripts/lib/work-quality-ops.ts, 2026-09-18): argv rules, candidate
// selection, the budget reserve, exit codes, the plan and log lines, and
// SOURCE PINS on the parts the compile cannot see: the db.ts write predicate
// (published + quality_json IS NULL unless forced, NO updated_at), the
// panel.ts exports the script reuses (so the assessor prompt stays the
// panel's own), and the script's gate order and abstinence (no claim, no
// heartbeat, no panel_runs spend, no publish or notify primitive).
//
// NO DATABASE, no brain, no network: the ops module is pure and this file
// imports nothing DB-backed. Run: npm run test:workquality.
//
// NO EM DASHES in any of the three lane files, asserted below (site rule).

import assert from "node:assert";
import { readFileSync } from "node:fs";
import {
  CALLS_PER_CARD,
  QUALITY_BACKFILL_USAGE,
  backfillAdmits,
  backfillPlanLine,
  cardsThatFit,
  exitCodeFor,
  parseQualityBackfillArgs,
  planCandidates,
  rowLogLine,
  summarize,
  summaryLine,
  type BackfillRow,
  type RowOutcome,
} from "./lib/work-quality-ops";

const uid = (n: number) => `2d17baef-3130-425c-8689-${String(n).padStart(12, "0")}`;

// ---- 1) argv -------------------------------------------------------------
{
  const d = parseQualityBackfillArgs([]);
  if (!d.ok) assert.fail(`the bare parse refused: ${d.error}`);
  assert.deepEqual(
    d.args,
    { id: null, apply: false, force: false, yes: false },
    "no flags = dry run over every candidate, no force, prompt on"
  );
  const all = parseQualityBackfillArgs(["--id", uid(1).toUpperCase(), "--apply", "--force", "--yes"]);
  if (!all.ok) assert.fail(`the combined parse refused: ${all.error}`);
  assert.deepEqual(all.args, { id: uid(1), apply: true, force: true, yes: true });
  assert.equal(all.args.id, all.args.id?.toLowerCase(), "the id is lowercased");
  assert.ok(!parseQualityBackfillArgs(["--id"]).ok, "--id needs a value");
  assert.ok(
    !parseQualityBackfillArgs(["--id", "--apply"]).ok,
    "--id followed by a flag is a dropped value, refused (the flag is not swallowed)"
  );
  assert.ok(!parseQualityBackfillArgs(["--id", "not-a-uuid"]).ok, "--id must be a uuid");
  assert.ok(!parseQualityBackfillArgs(["--id", uid(1), "--id", uid(2)]).ok, "--id twice is refused");
  assert.ok(!parseQualityBackfillArgs(["--aply"]).ok, "an unknown flag is refused by name");
  assert.ok(!parseQualityBackfillArgs([uid(1)]).ok, "a stray positional is refused (the id rides --id)");
  assert.ok(QUALITY_BACKFILL_USAGE.includes("--apply") && QUALITY_BACKFILL_USAGE.includes("--force"));
}

// ---- 2) candidate selection ---------------------------------------------
{
  const rows: BackfillRow[] = [
    { id: uid(1), title: "A", companyId: null, publishedAt: new Date("2026-07-01"), qualityJson: null },
    { id: uid(2), title: "B", companyId: null, publishedAt: new Date("2026-08-01"), qualityJson: "{}" },
    { id: uid(3), title: "C", companyId: "co", publishedAt: null, qualityJson: null },
  ];
  const bulk = planCandidates(rows, { id: null, force: false });
  assert.deepEqual(bulk.candidates.map((r) => r.id), [uid(1), uid(3)], "IS NULL rows only, stored order kept, company lane included");
  assert.deepEqual(bulk.alreadyAssessed.map((r) => r.id), [uid(2)], "the assessed row is reported, not selected");
  const forced = planCandidates(rows, { id: null, force: true });
  assert.deepEqual(forced.candidates.map((r) => r.id), [uid(1), uid(2), uid(3)], "--force re-admits assessed rows");
  assert.deepEqual(forced.alreadyAssessed, [], "nothing is 'already assessed' under --force");
  const one = planCandidates(rows, { id: uid(2), force: false });
  assert.deepEqual(one.candidates, [], "--id on an assessed row without --force selects nothing");
  assert.deepEqual(one.alreadyAssessed.map((r) => r.id), [uid(2)], "...and says why");
  const oneForced = planCandidates(rows, { id: uid(2), force: true });
  assert.deepEqual(oneForced.candidates.map((r) => r.id), [uid(2)]);
  const none = planCandidates(rows, { id: uid(9), force: true });
  assert.deepEqual(none, { candidates: [], alreadyAssessed: [] }, "an unknown id is simply out of view");
}

// ---- 3) the budget reserve ----------------------------------------------
{
  assert.equal(CALLS_PER_CARD, 2, "assessor + refuter, one dispatch each");
  const reserve = 20;
  assert.equal(backfillAdmits({ usedCalls: 0, cap: 8000, reserveCalls: reserve }), true);
  assert.equal(
    backfillAdmits({ usedCalls: 8000 - reserve - 2, cap: 8000, reserveCalls: reserve }),
    true,
    "exact fit admits (the card's 2 calls plus one panel worst case still fit)"
  );
  assert.equal(
    backfillAdmits({ usedCalls: 8000 - reserve - 1, cap: 8000, reserveCalls: reserve }),
    false,
    "one call short of the reserve refuses: a live run keeps its admitted headroom"
  );
  assert.equal(cardsThatFit({ usedCalls: 0, cap: 8000, reserveCalls: reserve }), 3990);
  assert.equal(cardsThatFit({ usedCalls: 7977, cap: 8000, reserveCalls: reserve }), 1);
  assert.equal(cardsThatFit({ usedCalls: 7979, cap: 8000, reserveCalls: reserve }), 0);
  assert.equal(cardsThatFit({ usedCalls: 9000, cap: 8000, reserveCalls: reserve }), 0, "never negative");
}

// ---- 4) outcomes, summary, exit codes, lines -----------------------------
{
  const outcomes: RowOutcome[] = [
    { kind: "assessed" },
    { kind: "skipped", why: "assessed meanwhile" },
    { kind: "unusable", why: "assessor_timeout" },
    { kind: "assessed" },
    { kind: "refused", reason: "budget" },
  ];
  const s = summarize(outcomes);
  assert.deepEqual(s, { assessed: 2, unusable: 1, skipped: 1, refused: 1 });
  assert.equal(summaryLine(s), "[work-quality] summary: 2 assessed, 1 unusable, 1 skipped, 1 refused");
  assert.equal(exitCodeFor(s), 3, "a budget stop wins the exit code");
  assert.equal(exitCodeFor({ assessed: 1, unusable: 1, skipped: 0, refused: 0 }), 2, "unusable rows exit 2");
  assert.equal(exitCodeFor({ assessed: 3, unusable: 0, skipped: 2, refused: 0 }), 0, "skips are not failures");
  assert.equal(exitCodeFor({ assessed: 0, unusable: 0, skipped: 0, refused: 0 }), 0, "nothing to do is clean");
  assert.equal(
    exitCodeFor({ assessed: 3, unusable: 0, skipped: 0, refused: 0 }, true),
    3,
    "a refuter-side budget hit on the last candidate still exits 3 (no next row carries the refused line)"
  );

  const lineRe = /^\[work-quality\] [0-9a-f-]{36} .+ -> (assessed|unusable:.+|skipped:.+|refused:.+)$/;
  for (const o of outcomes)
    assert.ok(lineRe.test(rowLogLine(uid(1), "Ticket Notes", o)), `log line shape: ${rowLogLine(uid(1), "Ticket Notes", o)}`);
  assert.equal(rowLogLine(uid(1), "T", { kind: "assessed" }), `[work-quality] ${uid(1)} T -> assessed`);
  assert.equal(rowLogLine(uid(1), "T", { kind: "refused", reason: "budget" }), `[work-quality] ${uid(1)} T -> refused:budget`);

  const plan = backfillPlanLine({
    candidates: 3,
    alreadyAssessed: 5,
    apply: false,
    force: false,
    usedCalls: 100,
    cap: 8000,
    reserveCalls: 20,
  });
  assert.ok(plan.startsWith("plan: DRY RUN"), "a dry run says so first");
  assert.ok(plan.includes("3 candidate card(s) x 2 brain calls = 6"), "spend is counted in calls");
  assert.ok(plan.includes("100/8000 used") && plan.includes("20 reserved"), "ledger state and reserve are stated");
  assert.ok(plan.includes("5 already-assessed row(s) untouched"), "the force-off arm names what is left alone");
  assert.ok(plan.includes("never touched: card_json, status, slug, published_at, display_rank, updated_at"));
  const applyForce = backfillPlanLine({
    candidates: 1,
    alreadyAssessed: 0,
    apply: true,
    force: true,
    usedCalls: 0,
    cap: 8000,
    reserveCalls: 20,
  });
  assert.ok(applyForce.startsWith("plan: APPLY") && applyForce.includes("force: ON"));
}

// ---- 5) source pins ------------------------------------------------------
{
  const dbSrc = readFileSync("src/lib/work/db.ts", "utf8");
  const at = dbSrc.indexOf("export async function setQualityAssessmentPublished");
  assert.ok(at > 0, "db.ts exports setQualityAssessmentPublished");
  const body = dbSrc.slice(at, dbSrc.indexOf("\nexport ", at + 1));
  assert.ok(body.includes('eq(S.status, "published")'), "the write is published-gated");
  assert.ok(body.includes("isNull(S.qualityJson)"), "...and IS NULL-gated");
  assert.ok(/opts\.force \? \[\] : \[isNull\(S\.qualityJson\)\]/.test(body), "force lifts only the IS NULL arm");
  assert.ok(body.includes(".set({ qualityJson })"), "quality_json is the ONLY column written");
  assert.ok(!body.includes("updatedAt"), "NO updated_at bump (retention + sitemap lastmod semantics)");
  assert.ok(!/sql`/.test(body), "typed operators only, no raw sql fragment");
  const readAt = dbSrc.indexOf("export async function qualityBackfillRows");
  assert.ok(readAt > 0, "db.ts exports qualityBackfillRows");
  const readBody = dbSrc.slice(readAt, dbSrc.indexOf("\nasync function uniqueSlug", readAt));
  assert.ok(
    readBody.includes('eq(S.status, "published")') && readBody.includes("isNotNull(S.cardJson)"),
    "candidates are published rows with a card copy"
  );
  assert.ok(readBody.includes("asc(S.publishedAt)"), "oldest publish first");
  assert.ok(!readBody.includes("inScope("), "all lanes: a company row's line renders on its own page");

  const panelSrc = readFileSync("src/lib/work/panel.ts", "utf8");
  for (const name of [
    "export function corpusOf(",
    "export function docsBlock(",
    "export function manifestOf(",
    "export const UNTRUSTED_FRAME",
    "export async function callPanelBrain(",
    "export async function revalidateWorkPage(",
  ])
    assert.ok(panelSrc.includes(name), `panel.ts exports ${name}`);
  assert.equal(
    (panelSrc.match(/\(\$\{m\.bytes\} bytes\)/g) ?? []).length,
    1,
    "the FILE LISTING line is built in exactly one place (manifestOf), never a copied expression"
  );
  const innerAt = panelSrc.indexOf("async function runPanelInner");
  const inner = panelSrc.slice(innerAt);
  assert.ok(inner.includes("const manifest = manifestOf(row);"), "runPanelInner builds its manifest through manifestOf");
  assert.ok(inner.includes("const corpus = corpusOf(row);"), "runPanelInner reads its corpus through corpusOf");

  const script = readFileSync("scripts/work-quality-backfill.ts", "utf8");
  const header = script.slice(0, script.indexOf("async function main"));
  for (const flag of ["--id", "--apply", "--force", "--yes"])
    assert.ok(header.includes(flag), `the header documents ${flag}`);
  assert.ok(
    /^import "\.\/lib\/governance-env";/m.test(script) &&
      script.indexOf('import "./lib/governance-env";') < script.indexOf("import {"),
    "the .env side-effect import comes first"
  );
  assert.ok(/process\.getuid\(\) === 0/.test(script), "refuses to run as root");
  assert.ok(/parseQualityBackfillArgs\(process\.argv\.slice\(2\)\)/.test(script), "argv goes through the pure parser");
  const order = [
    "workQualityEnabled(process.env)",
    "backfillPlanLine(",
    "process.env.BRAIN_STUB",
    "deployBlocksPanel({ strict: true })",
    "await brainHealthy()",
    "Type yes:",
    "backfillAdmits(",
    "qualityAssessorPrompts(UNTRUSTED_FRAME, docs)",
    "callPanelBrain(",
    "qualityRefuterPrompts(UNTRUSTED_FRAME, docs,",
    "reconcileQuality(",
    "setQualityAssessmentPublished(",
    "await revalidateWorkPage()",
    "exitCodeFor(",
  ];
  // Over main's body only: the header comment names several of these too.
  const mainBody = script.slice(script.indexOf("async function main"));
  let last = -1;
  for (const needle of order) {
    const i = mainBody.indexOf(needle);
    assert.ok(i > last, `script order: ${needle} comes after the previous gate/step (found at ${i}, previous at ${last})`);
    last = i;
  }
  assert.ok(
    mainBody.indexOf("await revalidateWorkPage()") > mainBody.lastIndexOf("callPanelBrain("),
    "revalidation happens after the loop, never per row"
  );
  assert.ok(/if \(written > 0\)[\s\S]{0,300}await revalidateWorkPage\(\)/.test(script), "...and only when something was written");
  assert.ok(
    !script.includes("alsoRecordRoadmap"),
    "the backfill never charges a client's roadmap admission ledger: work_usage is its only ledger (refuter finding, 2026-09-18)"
  );
  for (const banned of [
    /\bkickPanel\b/,
    /\bclaimPanel\(/,
    /\bheartbeat\(/,
    /\bsetQualityAssessment\(/,
    /"panel_runs"/,
    /\btrySpendWork\(/,
    /\bfinish[A-Z]\w*\(/,
    /\bfailPanel\(/,
    /\bnotify[A-Z]\w*\(/,
    /\.set\(/,
    /\bholdPublishedForRerun\(/,
  ])
    assert.ok(!banned.test(script), `the script never touches ${banned}: not a panel run, never the card, never mail`);
  assert.ok(
    script.includes('reason === "budget"') && script.includes("break;"),
    "the loop stops on a budget refusal"
  );

  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts["work:quality"], "tsx scripts/work-quality-backfill.ts", "npm run work:quality is wired");
  assert.equal(pkg.scripts["test:workquality"], "tsx scripts/work-quality-tests.ts", "npm run test:workquality is wired");

  // Built from char codes so this file's own source stays ASCII.
  const dashRe = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);
  for (const f of [
    "scripts/work-quality-backfill.ts",
    "scripts/lib/work-quality-ops.ts",
    "scripts/work-quality-tests.ts",
  ])
    assert.ok(!dashRe.test(readFileSync(f, "utf8")), `no em or en dashes in ${f}`);
}

console.log("work-quality-tests: all assertions passed.");
