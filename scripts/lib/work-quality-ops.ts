// Pure argv parsing + decisions for the §5.16 quality backfill lane
// (scripts/work-quality-backfill.ts, `npm run work:quality`). Deliberately
// DB-free and brain-free (the work-rerun-ops.ts pattern): test:workquality
// pins every branch here without a database, and the script stays a thin
// sequential loop around corpusOf/docsBlock/callPanelBrain (panel.ts), the
// quality prompt builders + reconcileQuality (quality.ts) and the one write
// helper setQualityAssessmentPublished (db.ts).
//
//   --id <uuid>   consider only that row (it must be published with a card)
//   --apply       write; the default is a DRY RUN that lists candidates,
//                 makes no brain call and writes no submission row
//   --force       re-assess rows that already carry an assessment (default:
//                 quality_json IS NULL rows only, which is also the write
//                 predicate without --force)
//   --yes         skip the confirm prompt (work:rerun precedent)
//
// Unknown flags and stray positionals are refused by name (a typo like
// --aply silently ignored would turn a real run into a dry run, which is the
// safe direction, but --forse ignored would skip every row the operator
// meant to re-assess and report success).

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const QUALITY_BACKFILL_USAGE =
  "usage: npm run work:quality -- [--id <uuid>] [--apply] [--force] [--yes]";

/** Brain calls one card costs: the assessor and the refuter, one dispatch
 * each, no recovery (the two quality stages are unarmed in the panel too). */
export const CALLS_PER_CARD = 2;

export type QualityBackfillArgs = {
  /** Submission uuid, lowercased, or null for every candidate. */
  id: string | null;
  apply: boolean;
  force: boolean;
  yes: boolean;
};

export type QualityBackfillArgsParse =
  | { ok: true; args: QualityBackfillArgs }
  | { ok: false; error: string };

export function parseQualityBackfillArgs(
  argv: string[]
): QualityBackfillArgsParse {
  let id: string | null = null;
  let apply = false;
  let force = false;
  let yes = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") apply = true;
    else if (a === "--force") force = true;
    else if (a === "--yes") yes = true;
    else if (a === "--id") {
      const v = argv[i + 1];
      if (v === undefined) return { ok: false, error: "--id needs a value" };
      // A following flag is a dropped value, not an id (work-rerun-ops
      // precedent): refusing beats swallowing the flag it would have eaten.
      if (v.startsWith("--"))
        return { ok: false, error: `--id needs a value; got the flag ${v}` };
      if (id !== null) return { ok: false, error: "--id given twice" };
      if (!UUID_RE.test(v.trim()))
        return { ok: false, error: `--id must be a submission uuid; got ${v}` };
      id = v.trim().toLowerCase();
      i++;
    } else if (a.startsWith("--"))
      return { ok: false, error: `unknown flag ${a}` };
    else return { ok: false, error: `unexpected argument ${a}` };
  }
  return { ok: true, args: { id, apply, force, yes } };
}

/** The light row projection qualityBackfillRows (db.ts) returns. */
export interface BackfillRow {
  id: string;
  title: string;
  companyId: string | null;
  publishedAt: Date | null;
  qualityJson: string | null;
}

/** Candidate selection, in the rows' stored order (oldest publish first).
 * Without --force a row already carrying an assessment is NOT a candidate
 * (the write predicate would refuse it anyway; this keeps the plan honest
 * about what will be spent). `alreadyAssessed` is what --force would add
 * back, reported so the operator sees why a bulk run has fewer rows than
 * /work has cards. With --id, every row but that one is simply out of
 * view. */
export function planCandidates<T extends BackfillRow>(
  rows: T[],
  opts: { id: string | null; force: boolean }
): { candidates: T[]; alreadyAssessed: T[] } {
  const inView =
    opts.id === null ? rows : rows.filter((r) => r.id === opts.id);
  if (opts.force) return { candidates: inView, alreadyAssessed: [] };
  return {
    candidates: inView.filter((r) => r.qualityJson === null),
    alreadyAssessed: inView.filter((r) => r.qualityJson !== null),
  };
}

/** THE BUDGET RESERVE. The backfill spends work_usage brain_calls through
 * callPanelBrain, the same ledger a live panel run spends, and a panel run
 * is admitted on the promise that its worst case (brainCallsWorstCasePerRun)
 * still fits, so it can finish out of reserved headroom. A backfill that
 * ate that headroom mid-run would make a live run's later stages hit budget
 * refusals it never planned for. So before each card the script re-reads
 * today's usage and proceeds only when the card's own calls PLUS one whole
 * panel worst case still fit under the cap: the backfill always leaves room
 * for one live run and stops (refused:budget) before it would not. */
export function backfillAdmits(opts: {
  usedCalls: number;
  cap: number;
  reserveCalls: number;
}): boolean {
  return opts.usedCalls + CALLS_PER_CARD + opts.reserveCalls <= opts.cap;
}

/** How many cards today's remaining budget can take under the reserve;
 * printed in the plan so a dry run says how far a real run would get. */
export function cardsThatFit(opts: {
  usedCalls: number;
  cap: number;
  reserveCalls: number;
}): number {
  const room = opts.cap - opts.reserveCalls - opts.usedCalls;
  return room <= 0 ? 0 : Math.floor(room / CALLS_PER_CARD);
}

/** One row's terminal outcome in the loop. `refused` is always a budget
 * refusal and always the LAST outcome: the loop stops on it. */
export type RowOutcome =
  | { kind: "assessed" }
  | { kind: "unusable"; why: string }
  | { kind: "skipped"; why: string }
  | { kind: "refused"; reason: string };

/** The one console line per row the spec asks for:
 * `[work-quality] <id> <title> -> assessed|unusable:<why>|skipped:<why>|refused:<reason>`. */
export function rowLogLine(id: string, title: string, outcome: RowOutcome): string {
  const tail =
    outcome.kind === "assessed"
      ? "assessed"
      : outcome.kind === "refused"
        ? `refused:${outcome.reason}`
        : `${outcome.kind}:${outcome.why}`;
  return `[work-quality] ${id} ${title} -> ${tail}`;
}

export interface BackfillSummary {
  assessed: number;
  unusable: number;
  skipped: number;
  refused: number;
}

export function summarize(outcomes: RowOutcome[]): BackfillSummary {
  const s: BackfillSummary = { assessed: 0, unusable: 0, skipped: 0, refused: 0 };
  for (const o of outcomes) s[o.kind]++;
  return s;
}

export function summaryLine(s: BackfillSummary): string {
  return `[work-quality] summary: ${s.assessed} assessed, ${s.unusable} unusable, ${s.skipped} skipped, ${s.refused} refused`;
}

/** Exit codes, in the work:rerun family (0 clean, small integers by class so
 * a batch driver can tell them apart):
 *   0  every candidate was assessed or legitimately skipped (or a dry run)
 *   2  at least one candidate was unusable (assessor call failed for a
 *      non-budget reason, no document, reconciliation returned nothing);
 *      re-invoke later, completed rows are not candidates any more
 *   3  the loop stopped on a budget refusal; the remaining candidates wait
 *      for tomorrow's ledger (or a raised WORK_BRAIN_DAILY_CAP)
 * A preflight refusal (root, kill switch, deploy, brain health, bad argv)
 * exits 1 from the script before any row is touched and never reaches
 * here. A skip is not a failure: the row was either assessed by someone
 * else meanwhile or left published under the loop, and both are the
 * predicate doing its job. */
export function exitCodeFor(
  s: BackfillSummary,
  /** The ledger wall was hit on the LAST candidate's refuter call: that
   * row is stored (uncontested) and no next row exists to carry a refused
   * outcome, so the summary alone would read as clean. */
  budgetHit = false
): 0 | 2 | 3 {
  if (s.refused > 0 || budgetHit) return 3;
  if (s.unusable > 0) return 2;
  return 0;
}

/** The plan line printed BEFORE the confirm prompt (work:rerun precedent):
 * what will be spent, against what, and what will and will not be
 * written. */
export function backfillPlanLine(opts: {
  candidates: number;
  alreadyAssessed: number;
  apply: boolean;
  force: boolean;
  usedCalls: number;
  cap: number;
  reserveCalls: number;
}): string {
  const fit = cardsThatFit(opts);
  const mode = opts.apply
    ? "APPLY: quality_json is written on each assessed row (status must still be published)"
    : "DRY RUN: no brain call, no submission write (today's work_usage ledger row is bootstrapped, idempotently)";
  const spend = `spend: ${opts.candidates} candidate card(s) x ${CALLS_PER_CARD} brain calls = ${opts.candidates * CALLS_PER_CARD} of ${Math.max(0, opts.cap - opts.usedCalls)} left today (${opts.usedCalls}/${opts.cap} used, ${opts.reserveCalls} reserved for one live panel run, so ${fit} card(s) fit now)`;
  const force = opts.force
    ? "force: ON, rows with an assessment are re-assessed and overwritten"
    : `force: off, ${opts.alreadyAssessed} already-assessed row(s) untouched`;
  const untouched =
    "never touched: card_json, status, slug, published_at, display_rank, updated_at";
  return `plan: ${mode} | ${spend} | ${force} | ${untouched}`;
}
