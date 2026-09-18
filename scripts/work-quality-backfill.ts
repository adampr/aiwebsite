#!/usr/bin/env -S npx tsx
// Quality BACKFILL for published /work cards (§5.16, owner ruling
// 2026-09-18: the panel's quality assessment is shown on the public /work
// card). Every card published before the quality round has quality_json
// NULL, so its card carries no score line. This script assesses those rows
// from the documents they were reviewed from, WITHOUT re-running the panel
// and WITHOUT touching the card: no claim, no heartbeat, no panel_runs
// spend, no email, no change to card_json / status / slug / published_at /
// display_rank / updated_at. Runs ON THE PROD VM in its own process
// (DATABASE_URL and the brain resolve only there); refuses to run as root.
//
// NOTHING IS RE-IMPLEMENTED. The documents come from panel.ts corpusOf and
// are framed by panel.ts docsBlock with the manifest from panel.ts
// manifestOf, so the assessor sees byte for byte what a panel run's quality
// assessor sees; the prompts are quality.ts qualityAssessorPrompts /
// qualityRefuterPrompts with panel.ts's own UNTRUSTED_FRAME; every call goes
// through panel.ts callPanelBrain, so the privacy envelope is the panel's
// (buildWorkEnvelope: memoryMode do_not_store, no requester, no groupName)
// and the spend lands in the one ledger, work_usage brain_calls against
// workBrainDailyCap; quality.ts reconcileQuality resolves the pair in code
// with quoteInCorpus as the only arbiter of evidence, exactly as mid-run.
//
// THE WRITE is db.ts setQualityAssessmentPublished: UPDATE quality_json
// WHERE id AND status = 'published' AND (--force ? true : quality_json IS
// NULL). It sets no other column, above all NOT updated_at (an assessment
// of the same documents is not a change to the card; the sitemap lastmod
// and retention semantics must not move). A row that left published
// meanwhile, or that the panel / another backfill assessed meanwhile, takes
// nothing and is reported as skipped.
//
// GATES, in order, all before any spend: not root; argv; WORK_QUALITY_ENABLED
// (the same kill switch that skips the two stages in the panel; =0 refuses
// here too); BRAIN_STUB unset (brainHealthy would lie); the deploy marker
// via deployBlocksPanel({ strict: true }), i.e. refuse for the WHOLE deploy
// (this is a short-lived process, so the phase-aware gate's process-start
// test cannot help it; deploy-window.ts says script callers keep the wide
// rule, and work:rerun does the same through deployInProgress()); brain
// health once. Then, before EACH card, today's usage is re-read and the card
// runs only when its two calls plus one whole panel worst case
// (WORK_CAPS.brainCallsWorstCasePerRun) still fit under the cap: the
// backfill never eats the headroom a live panel run was admitted on. The
// first budget refusal, from that reserve or from callPanelBrain itself,
// stops the loop (refused:budget); nothing retries a ledger refusal.
//
// Sequential, oldest published_at first, one console line per row:
//   [work-quality] <id> <title> -> assessed|unusable:<why>|skipped:<why>|refused:<reason>
// After the loop, if anything was written, revalidateWorkPage() (panel.ts:
// its loopback layer works from a detached process on the VM) so /work shows
// the new lines without waiting out the 300 s ISR floor.
//
// Usage:
//   npm run work:quality -- [--id <uuid>] [--apply] [--force] [--yes]
//
//   --id       consider only that row (must be published with a card)
//   --apply    write; the default is a DRY RUN (lists candidates, spends
//              nothing, writes nothing)
//   --force    re-assess rows that already carry an assessment
//   --yes      skip the confirm prompt
//
// Exit codes: 0 every candidate assessed or legitimately skipped (or a dry
// run); 1 a preflight refusal (root, argv, kill switch, deploy, brain
// health, --id names no published card); 2 at least one row unusable
// (re-invoke later; assessed rows are no longer candidates); 3 stopped on a
// budget refusal (the rest waits for tomorrow's ledger). The pure rules
// (argv, candidate selection, the reserve, exit codes) live in
// scripts/lib/work-quality-ops.ts, pinned DB-free by test:workquality.
//
// TOP-LEVEL IMPORTS ONLY (deploys run npm ci under live jobs). The env
// side-effect import must stay first.

import "./lib/governance-env";
import { createInterface } from "node:readline/promises";
import { brainHealthy } from "../src/lib/governance/brain";
import { WORK_CAPS, workBrainDailyCap, workQualityEnabled } from "../src/lib/work/config";
import {
  qualityBackfillRows,
  readTodayWorkUsage,
  setQualityAssessmentPublished,
  submissionById,
} from "../src/lib/work/db";
import { deployBlocksPanel } from "../src/lib/work/deploy-window";
import {
  UNTRUSTED_FRAME,
  callPanelBrain,
  corpusOf,
  docsBlock,
  manifestOf,
  revalidateWorkPage,
} from "../src/lib/work/panel";
import {
  qualityAssessorPrompts,
  qualityRefuterPrompts,
  reconcileQuality,
} from "../src/lib/work/quality";
import {
  CALLS_PER_CARD,
  QUALITY_BACKFILL_USAGE,
  backfillAdmits,
  backfillPlanLine,
  exitCodeFor,
  parseQualityBackfillArgs,
  planCandidates,
  rowLogLine,
  summarize,
  summaryLine,
  type RowOutcome,
} from "./lib/work-quality-ops";

function die(msg: string, code = 1): never {
  console.error(`[work-quality] ${msg}`);
  process.exit(code);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 200) : String(err);
}

async function main(): Promise<void> {
  if (typeof process.getuid === "function" && process.getuid() === 0)
    die(
      "Refusing to run as root: run this as the deploy user the site runs as (the work:submit precedent), so it loads the site's own .env and leaves no root-owned files behind."
    );

  const parsed = parseQualityBackfillArgs(process.argv.slice(2));
  if (!parsed.ok) die(`${parsed.error}\n${QUALITY_BACKFILL_USAGE}`);
  const { id, apply, force, yes } = parsed.args;

  // Kill switch first: it costs nothing and it is the one gate whose answer
  // the operator can change from here (.env + pm2 restart --update-env).
  if (!workQualityEnabled(process.env))
    die(
      "WORK_QUALITY_ENABLED=0 (quality kill switch): the panel skips its quality stages under it and this backfill refuses under it too; flip it on first."
    );

  const cap = workBrainDailyCap(process.env);
  const reserveCalls = WORK_CAPS.brainCallsWorstCasePerRun;

  console.log(`Mode:    ${apply ? "APPLY" : "DRY RUN (no spend, no writes)"}`);
  console.log(`Scope:   ${id ?? "every published card with a card copy, all lanes"}`);
  console.log(`Force:   ${force ? "on (re-assess assessed rows)" : "off (quality_json IS NULL rows only)"}`);
  console.log(`Ledger:  work_usage brain_calls, cap ${cap}/day, ${reserveCalls} reserved for one live panel run`);
  console.log("");

  const rows = await qualityBackfillRows();
  const plan = planCandidates(rows, { id, force });
  if (id !== null && plan.candidates.length === 0 && plan.alreadyAssessed.length === 0) {
    const row = await submissionById(id);
    die(
      row
        ? `${id} is not a published card with a card copy (status ${row.status}${row.cardJson ? "" : ", no card_json"}); only published rows are backfilled.`
        : `no submission ${id}`
    );
  }

  console.log(
    `[work-quality] ${rows.length} published row(s) with a card copy; ${plan.candidates.length} candidate(s)${force ? " (force)" : `, ${plan.alreadyAssessed.length} already assessed`}.`
  );
  for (const r of plan.candidates)
    console.log(
      `  ${r.id}  ${r.publishedAt ? r.publishedAt.toISOString().slice(0, 10) : "----------"}  ${r.companyId ? "company" : "public "}  ${r.title}`
    );
  if (id !== null && plan.candidates.length === 0) {
    console.log(
      `[work-quality] ${id} already carries an assessment; pass --force to re-assess it. Nothing to do.`
    );
    console.log(summaryLine({ assessed: 0, unusable: 0, skipped: 1, refused: 0 }));
    process.exit(0);
  }

  const usage = await readTodayWorkUsage();
  console.log(
    `[work-quality] ${backfillPlanLine({
      candidates: plan.candidates.length,
      alreadyAssessed: plan.alreadyAssessed.length,
      apply,
      force,
      usedCalls: usage.brainCalls,
      cap,
      reserveCalls,
    })}`
  );

  // ── Preflight (mirrors the panel's admission gates; a refusal here costs
  //    nothing and writes nothing) ──────────────────────────────────────
  if (process.env.BRAIN_STUB)
    die("BRAIN_STUB is set in this environment; brainHealthy would lie. Unset it first.");
  if (deployBlocksPanel({ strict: true }))
    die("deploy in progress (marker fresh): wait it out and retry");
  if (!(await brainHealthy())) die("brain health check failed");

  if (plan.candidates.length === 0) {
    console.log(`[work-quality] nothing to do.`);
    console.log(summaryLine({ assessed: 0, unusable: 0, skipped: 0, refused: 0 }));
    process.exit(0);
  }
  if (!apply) {
    console.log(
      `\nDRY RUN: every gate passed. No brain call was made and no submission row was written (the usage read above only bootstraps today's work_usage ledger row, idempotently, as panel admission does). Re-run with --apply to assess the ${plan.candidates.length} candidate(s) above.`
    );
    process.exit(0);
  }

  if (!yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(
      `\n[work-quality] ASSESS ${plan.candidates.length} published card(s) (${plan.candidates.length * CALLS_PER_CARD} brain calls, quality_json only${force ? ", overwriting existing assessments" : ""})? Type yes: `
    );
    rl.close();
    if (answer.trim().toLowerCase() !== "yes") die("aborted", 0);
  }

  // ── The loop: sequential, oldest first, stop on the first budget refusal ──
  const outcomes: RowOutcome[] = [];
  let written = 0;
  // Set when the REFUTER call of a row hit the cap: that row is still stored
  // (uncontested, as in the panel), so the refusal belongs to the next
  // candidate, which gets its refused line after the loop. The reserve
  // pre-check and an assessor refusal mark the current row instead.
  let refuterBudgetStop: string | null = null;
  const finish = (rowId: string, title: string, o: RowOutcome) => {
    outcomes.push(o);
    console.log(rowLogLine(rowId, title, o));
  };
  for (const c of plan.candidates) {
    try {
      // The reserve, re-read per card: a live panel run may have started
      // since the last card, and its admitted headroom is not ours to eat.
      const now = await readTodayWorkUsage();
      if (!backfillAdmits({ usedCalls: now.brainCalls, cap, reserveCalls })) {
        finish(c.id, c.title, {
          kind: "refused",
          reason: `budget (${now.brainCalls}/${cap} used today, ${reserveCalls} reserved for a live run)`,
        });
        break;
      }
      // The full row is read only now (the candidate list is a light
      // projection), and the run-time state is re-checked: the predicate
      // on the write is what protects the row, this just avoids spending
      // two calls on a row the write would then refuse.
      const row = await submissionById(c.id);
      if (!row || row.status !== "published" || !row.cardJson) {
        finish(c.id, c.title, {
          kind: "skipped",
          why: row ? `no longer published (status ${row.status})` : "row vanished",
        });
        continue;
      }
      if (!force && row.qualityJson !== null) {
        finish(c.id, c.title, { kind: "skipped", why: "assessed meanwhile" });
        continue;
      }
      const corpus = corpusOf(row);
      if (corpus.length === 0) {
        finish(c.id, c.title, { kind: "unusable", why: "no_document" });
        continue;
      }
      const docs = docsBlock(corpus, row.blurb, manifestOf(row));
      const sessionId = `work_${row.id}`;
      // NO roadmap dual-record here, unlike the panel's own calls: this is
      // XL.net ops spend on already-published cards, not client activity,
      // and roadmap_usage is the ledger admitCompanyRun gates client runs
      // on (an exact 60 x 20 fit), so charging it would let our backfill
      // cost a client an admission. work_usage is the only ledger.
      const qa = qualityAssessorPrompts(UNTRUSTED_FRAME, docs);
      const assessorRes = await callPanelBrain(
        sessionId,
        qa.system,
        qa.user,
        cap
      );
      if (!assessorRes.ok) {
        if (assessorRes.reason === "budget") {
          finish(c.id, c.title, { kind: "refused", reason: "budget" });
          break;
        }
        finish(c.id, c.title, {
          kind: "unusable",
          why: `assessor_${assessorRes.reason}`,
        });
        continue;
      }

      // The refuter tolerates null exactly as in the panel: a failed call
      // leaves an UNCONTESTED assessment. A budget refusal here still ends
      // the loop after this row is stored, so the ledger is never probed
      // twice against a wall that does not move.
      const qr = qualityRefuterPrompts(UNTRUSTED_FRAME, docs, assessorRes.value);
      const refuterRes = await callPanelBrain(
        sessionId,
        qr.system,
        qr.user,
        cap
      );
      const refuterBudget = !refuterRes.ok && refuterRes.reason === "budget";
      if (!refuterRes.ok)
        console.log(
          `[work-quality] ${c.id} refuter call failed (${refuterRes.reason}); the assessment is stored uncontested`
        );

      const assessment = reconcileQuality(
        assessorRes.value,
        refuterRes.ok ? refuterRes.value : null,
        corpus.map((f) => f.text).join("\n")
      );
      if (!assessment) {
        finish(c.id, c.title, { kind: "unusable", why: "reconcile_empty" });
      } else {
        const wrote = await setQualityAssessmentPublished(
          row.id,
          JSON.stringify(assessment),
          { force }
        );
        if (wrote) {
          written++;
          finish(c.id, c.title, { kind: "assessed" });
        } else {
          finish(c.id, c.title, {
            kind: "skipped",
            why: "write refused (row left published, or assessed meanwhile)",
          });
        }
      }
      if (refuterBudget) {
        refuterBudgetStop = "budget (the previous row's refuter call hit the cap)";
        break;
      }
    } catch (err) {
      finish(c.id, c.title, { kind: "unusable", why: `crash: ${errMessage(err)}` });
    }
  }
  if (refuterBudgetStop !== null && outcomes.length < plan.candidates.length) {
    const next = plan.candidates[outcomes.length];
    finish(next.id, next.title, { kind: "refused", reason: refuterBudgetStop });
  }
  // A refuter-side refusal on the LAST candidate has no next row to carry
  // the refused line, so the flag itself feeds the exit code and the note
  // below: the ledger wall was hit either way.
  const budgetHit = refuterBudgetStop !== null;

  if (written > 0) {
    console.log(
      `[work-quality] ${written} row(s) written; revalidating /work (both layers best-effort; the 300 s ISR floor is the fallback)`
    );
    await revalidateWorkPage();
  }

  const summary = summarize(outcomes);
  console.log(summaryLine(summary));
  // Rows after the refused one never got a line; say how many.
  const notReached = plan.candidates.length - outcomes.length;
  if (summary.refused > 0 || budgetHit)
    console.log(
      `[work-quality] stopped on a budget refusal; ${summary.refused} candidate(s) refused and ${notReached} more not reached. Re-invoke tomorrow (or raise WORK_BRAIN_DAILY_CAP); assessed rows are no longer candidates.`
    );
  else if (summary.unusable > 0)
    console.log(
      `[work-quality] ${summary.unusable} row(s) could not be assessed (see the unusable lines above); re-invoke later, assessed rows are no longer candidates.`
    );
  process.exit(exitCodeFor(summary, budgetHit));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
