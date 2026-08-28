#!/usr/bin/env -S npx tsx
// Re-decide the KIND of every historical /work submission from the package
// that was actually uploaded (owner directive 2026-08-28: "go back over all
// the submits as some were mislabeled as CoWork but were Claude Code").
//
// Until this round the kind was a radio button on the form and a "Kind:" line
// in an email, so it recorded what the submitter believed rather than what
// they sent. Three of the 85 production rows were filed as CoWork Skills
// while the package was a Claude Code program: an architecture document here,
// a package.json and a start.bat there, a Run.cmd launcher in the third. Each
// carried a SKILL.md somewhere in its tree, which is exactly why a human
// reading their own upload called it a Skill. src/lib/work/classify.ts is now
// the single ladder that decides, on the upload path and here, and this
// script walks the history through the same function so the old rows and the
// new ones carry labels that mean the same thing.
//
// THE DATABASE IS ENOUGH, and that is the whole reason this is cheap. Every
// row keeps file_manifest_json (the full path list of the archive walk) and
// corpus_files_json (the text that was fed to the panel), published rows
// included, because those two columns are the evidence the card was written
// from. So a verdict is reachable with no archive bytes, no on-disk archive
// store, and no zip parse: nothing is inflated, nothing is downloaded, and a
// row whose original was already cleared after its retention email classifies
// exactly like one that still holds its blob.
//
// INTAKE PARITY is the contract, not an optimisation. The signals are rebuilt
// the way inspectArchive builds them, and where the stored record cannot say
// what the walk saw, this script declines rather than improvises:
//   - packageName is archive_name. A row that somehow lost its name passes ""
//     and not null: null is classify.ts's "there is no package at all" (the
//     bare-document rung, which short-circuits the entire ladder to skill),
//     and an unnamed package is a different fact from no package. This
//     mirrors inspectArchive's own `opts.packageName ?? ""`.
//   - paths excludes every entry holding "!/". Those are inner-archive
//     entries, recorded only after the lazy inner open, and the classifier
//     at intake runs strictly BEFORE that open. Feeding them back in would
//     let this script reach a verdict intake could never have reached, on
//     evidence the decision itself was supposed to authorize. No production
//     row carries such a path today; the filter is the contract anyway.
//   - innerArchivePaths uses walkLevel's own collection rule (a .skill or
//     .zip at depth <= 1), NOT classify.ts's wider .skill/.ski/.zip test.
//     walkLevel is what fills that array, and it never collects a .ski, so a
//     .ski wrapper cannot fire the wrapped_skill_package rung at intake and
//     must not fire it here either. A depth <= 1 .ski is instead DISCLOSED on
//     the row, because it is the one place where the two modules' extension
//     lists differ and a human should look at that package.
//   - texts is corpus_files_json minus the same "!/" entries.
//
// Where the stored evidence is provably PARTIAL the row is reported but not
// written unless --allow-partial says otherwise. Two cases exist, both real:
// the manifest is capped at WORK_CAPS.manifestMaxEntries when it is stored
// while the classifier at intake read the uncapped list, and the corpus drops
// text past its own byte budget. A missing path or a missing SKILL.md text
// can move the verdict in either direction (a lost .claude entry turns a
// program into a Skill; a lost SKILL.md text drops the front-matter rung and
// lets program_source decide), so a partial row is a question for a person
// with the original in hand, not a row to flip on a prefix.
//
// WHAT --apply WRITES, and nothing else:
//   1. kind = the computed kind.
//   2. The reviewed document's text moves to the column the new kind names
//      (architecture_text for a program, skill_md_text for a Skill), because
//      that is the write-time convention every other row in the table obeys.
//      Today it is inert: panel.ts:94 coalesces the two columns. It is done
//      anyway so a future reader that keys off kind does not find NULL in the
//      column its own label points at. The move falsifies nothing about the
//      submission: the document's real filename stays recorded in
//      corpus_files_json and in the card's docPath, so "architecture_text"
//      here never claims the file was named architecture.md.
//
// THIS SCRIPT CORRECTS THE LABEL, NOT THE REVIEW. It does not touch card_json
// or panel_transcript_json: the card was written from the documents that were
// actually submitted, and those documents did not change because the badge on
// them was wrong. Re-reviewing a card is a separate, deliberate, expensive act
// with its own consequences (fresh published_at, re-fired notification emails,
// an overwritten transcript), and it has its own lever: npm run work:rerun.
// It does not touch md_name/md_sha256/md_bytes/md_data either: those record
// the fact that a second file WAS uploaded and retained, the on-disk archive
// store's slot 01 ledger reconciles against them, and a Skill that turns out
// to be a program did not stop having shipped that file. corpus_files_json is
// left alone for the same reason: it is the evidence record of what the panel
// read.
//
// updated_at is deliberately NOT bumped. On this table it is a retention
// timer, not an audit field: sweepExpiredWork deletes non-published rows
// whose updated_at is older than 30 days, so bumping it here would silently
// grant every failed and received row another month of life because an
// operator fixed a badge. The row's clock is the row's business.
//
// WHAT MOVES WHEN A LABEL FLIPS, so nobody has to guess: /work's public cards
// are rendered from card_json and never read this column, so no published page
// changes. kind is what /admin/work prints in the row's badge, what the
// submitter's own status view reports, what the update lane pins (an update to
// a Code program must itself be a program package), and what the panel is told
// the submission is if a card is ever re-reviewed. That last one is the point:
// a re-run of a mislabelled row used to be told the wrong thing about its own
// documents.
//
// A row with a LIVE panel run is left alone and listed: that run reads kind
// while it writes the card, and a label that changes underneath it would put a
// Skill's badge on a program's copy. Retry after it finishes.
//
// Runs ON THE PROD VM, in its own process, because DATABASE_URL resolves only
// there. Refuses to run as root: npx tsx writes its cache inside the deploy
// user's checkout, and a root-owned cache file there breaks the next deploy
// build for the user the site actually runs as, which is a miserable thing to
// debug days later next to a one-line label fix.
//
// Concurrency: no advisory lock is taken (nothing but two columns on one row
// is written). Each row is written in its own transaction whose WHERE clause
// re-states the kind the scan read, so a row that changed underneath this run
// (an admin, an approved update swap) is reported as raced instead of being
// overwritten.
//
// Usage:
//   npm run work:reclassify -- [--apply] [--id <uuid>] [--allow-partial]
//
//   (no flags)        classify every row and print the report, write nothing
//   --apply           write the disagreements (dry run is the default)
//   --id <uuid>       act on one row only, for a spot check
//   --allow-partial   also write rows whose stored evidence is partial
//                     (PARTIAL EVIDENCE below); off by default on purpose
//
// Idempotent: a second run finds every row agreeing with its stored kind and
// writes nothing. Exit 0 when the run completed, 1 when a row failed to
// classify or a write failed or raced.

import "dotenv/config";
import { and, asc, eq, sql } from "drizzle-orm";
import { db, schema } from "../src/lib/db";
import { isUuid } from "../src/lib/governance/db";
import { WORK_CAPS, type WorkKind } from "../src/lib/work/config";
import {
  classifyWorkKind,
  kindVerdictSentence,
  type KindRule,
  type KindVerdict,
} from "../src/lib/work/classify";

const S = schema.workSubmissions;

const USAGE =
  "Usage: npm run work:reclassify -- [--apply] [--id <uuid>] [--allow-partial]";

function usage(msg: string): never {
  console.error(`${msg}\n\n${USAGE}`);
  process.exit(1);
}

function die(msg: string): never {
  console.error(`[work-reclassify] ${msg}`);
  process.exit(1);
}

/** walkLevel's inner-archive test, copied rather than imported: extract.ts
 * keeps it private, and importing extract.ts would drag jszip into a script
 * that never opens an archive. If that regex ever widens, this one has to
 * widen with it or the two lanes stop agreeing about what a wrapper is. */
const INNER_ARCHIVE_EXT = /\.(skill|zip)$/i;
/** The extension classify.ts would accept as an inner Skill but walkLevel
 * never collects. Disclosure only; see the header. */
const SKI_EXT = /\.ski$/i;
const SKILL_DOC = /^skill\.md$/i;
const depthOf = (p: string): number => p.split("/").length - 1;
const baseOf = (p: string): string => p.split("/").pop() || "";

interface ScanRow {
  id: string;
  title: string;
  status: string;
  kind: string;
  createdAt: Date;
  archiveName: string | null;
  parentId: string | null;
  panelHeartbeatAt: Date | null;
  fileManifestJson: string | null;
  corpusFilesJson: string | null;
  hasArchText: boolean;
  hasSkillText: boolean;
}

interface Rebuilt {
  paths: string[];
  innerArchivePaths: string[];
  texts: { path: string; text: string }[];
  /** Evidence the stored record cannot supply, in the operator's words. A
   * non-empty list withholds the write unless --allow-partial. */
  gaps: string[];
  /** Facts worth printing that do not withhold anything. */
  notes: string[];
  /** SKILL.md files the manifest lists but the corpus carries no text for.
   * Whether that is a HOLE depends on which rung ended up deciding, so the
   * judgement is made in main() once the verdict exists; see gapForVerdict. */
  unbackedSkillDocs: string[];
}

/** Rebuild the classifier's inputs from the row, or say why the row cannot be
 * classified at all. Never guesses: a row with no readable manifest is listed
 * as unclassifiable, because every rung of the ladder is a path test and a
 * missing path list would land on the default rung and call the package a
 * program on the strength of nothing. */
function rebuild(row: ScanRow): Rebuilt | { unclassifiable: string } {
  if (!row.fileManifestJson)
    return { unclassifiable: "file_manifest_json is NULL (nothing to classify from)" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.fileManifestJson);
  } catch {
    return { unclassifiable: "file_manifest_json is not valid JSON" };
  }
  if (!Array.isArray(parsed))
    return { unclassifiable: "file_manifest_json is not an array" };
  const allPaths = parsed
    .map((e) =>
      e && typeof e === "object" && typeof (e as { path?: unknown }).path === "string"
        ? ((e as { path: string }).path)
        : null
    )
    .filter((p): p is string => p !== null);
  if (allPaths.length === 0)
    return {
      unclassifiable:
        parsed.length === 0
          ? "file_manifest_json is an empty array (intake refuses an empty archive, so this record is not usable)"
          : "file_manifest_json holds no entries with a string path",
    };

  const notes: string[] = [];
  const gaps: string[] = [];

  // Outer level only: see the header on why an inner path must not vote.
  const paths = allPaths.filter((p) => !p.includes("!/"));
  const innerDropped = allPaths.length - paths.length;
  if (innerDropped > 0)
    notes.push(
      `${innerDropped} inner-archive path(s) ignored: the classifier runs before the inner open`
    );
  if (paths.length === 0)
    return { unclassifiable: "every manifest path is an inner-archive path" };

  // Stored manifests are sliced to the cap; the classifier at intake read the
  // uncapped list. A row sitting exactly on the cap may therefore be a prefix
  // of what was really in the archive, and there is no stored bit that says
  // which. Treated as partial evidence rather than resolved either way.
  if (allPaths.length >= WORK_CAPS.manifestMaxEntries)
    gaps.push(
      `the manifest sits on the ${WORK_CAPS.manifestMaxEntries}-entry storage cap, so the path list may be a prefix of the real archive`
    );

  let texts: { path: string; text: string }[] = [];
  if (row.corpusFilesJson) {
    try {
      const corpus = JSON.parse(row.corpusFilesJson) as unknown;
      if (Array.isArray(corpus))
        texts = corpus
          .filter(
            (f): f is { path: string; text: string } =>
              !!f &&
              typeof f === "object" &&
              typeof (f as { path?: unknown }).path === "string" &&
              typeof (f as { text?: unknown }).text === "string"
          )
          .filter((f) => !f.path.includes("!/"));
      else notes.push("corpus_files_json is not an array; classified on paths alone");
    } catch {
      notes.push("corpus_files_json is not valid JSON; classified on paths alone");
    }
  }

  // A SKILL.md the corpus carries no text for (dropped past the corpus byte
  // budget, or lost with an unreadable column). Collected here, judged after
  // the verdict: the front-matter rung is the only one that reads text.
  const unbackedSkillDocs = paths.filter(
    (p) =>
      SKILL_DOC.test(baseOf(p)) &&
      depthOf(p) <= 1 &&
      !texts.some((t) => t.path === p)
  );

  const innerArchivePaths = paths.filter(
    (p) => INNER_ARCHIVE_EXT.test(baseOf(p)) && depthOf(p) <= 1
  );
  const ski = paths.filter((p) => SKI_EXT.test(baseOf(p)) && depthOf(p) <= 1);
  if (ski.length > 0)
    notes.push(
      `holds ${ski[0]} at depth <= 1: walkLevel does not collect .ski as an inner archive, so the wrapped-Skill rung cannot see it (worth a human look)`
    );

  return { paths, innerArchivePaths, texts, gaps, notes, unbackedSkillDocs };
}

/** The one evidence gap that only exists in the light of the verdict.
 *
 * A SKILL.md with no stored text is harmless on most rungs: rungs 1 to 5 never
 * read text at all, and the rung that does (skill_document) either fired or was
 * overtaken by a rung that outranks it. It matters in exactly two places, both
 * BELOW the front-matter rung and both landing on "program": program_source and
 * default_program. Reaching either means skill_document was tried and missed,
 * and with the document's text absent there is no way to tell whether it missed
 * because the front matter was not there or because the text was not stored.
 * That is a question for whoever holds the original package.
 *
 * Written as a rule test rather than a generic "some text is missing" so a
 * correct flip is never withheld for evidence the ladder did not consult: the
 * first cut withheld a .skill package's flip over a SKILL.md text that rung 3
 * had already made irrelevant. */
function gapForVerdict(built: Rebuilt, verdict: KindVerdict): string | null {
  if (built.unbackedSkillDocs.length === 0) return null;
  if (verdict.rule !== "program_source" && verdict.rule !== "default_program")
    return null;
  return `${built.unbackedSkillDocs[0]} has no text in corpus_files_json, so the Skill front-matter rung that sits directly above the ${verdict.rule} rung could not be evaluated`;
}

interface Verdicted {
  row: ScanRow;
  verdict: KindVerdict;
  agrees: boolean;
  gaps: string[];
  notes: string[];
  /** A panel run is live on this row right now. */
  busy: boolean;
}

function label(row: ScanRow): string {
  return `${row.id}  ${row.createdAt.toISOString().slice(0, 10)}  [${row.status}]`;
}

/** The sentence an operator can act on, not the one the driver volunteers.
 * A failed write arrives as a DrizzleQueryError whose own message is the SQL
 * text, and the fact that matters (a permission denial, the constraint that
 * refused) sits one level down in `cause`; a bare err.message truncated to a
 * couple of hundred characters is therefore all query and no reason. The chain
 * is walked innermost-first and both ends are printed. */
function errMessage(err: unknown): string {
  const chain: string[] = [];
  let cur: unknown = err;
  while (cur instanceof Error && chain.length < 4) {
    chain.push(cur.message.replace(/\s+/g, " ").trim());
    cur = (cur as { cause?: unknown }).cause;
  }
  if (chain.length === 0) return "unknown error";
  const inner = chain[chain.length - 1];
  const outer = chain[0];
  return (inner === outer ? outer : `${inner} [${outer}]`).slice(0, 300);
}

/** Which column the doc text ends up in, in the operator's words. */
function moveSentence(to: WorkKind, row: ScanRow): string {
  if (to === "program")
    return row.hasSkillText
      ? "skill_md_text moves to architecture_text"
      : "no skill_md_text to move (architecture_text left as it is)";
  return row.hasArchText
    ? "architecture_text moves to skill_md_text"
    : "no architecture_text to move (skill_md_text left as it is)";
}

/** One row, one transaction. The WHERE clause re-states the kind the scan
 * read, so this is a conditional update and not a read-then-write: a row an
 * admin or an approved update swap changed in the meantime reports as raced
 * and keeps whatever it now holds.
 *
 * COALESCE and not a bare assignment: on a row whose text already sits in the
 * destination column (a legacy row, or a half-applied earlier attempt), a
 * bare `architecture_text = skill_md_text` would write NULL over the only copy
 * of the reviewed document. Postgres evaluates every right-hand side against
 * the OLD row, so the two assignments below stay consistent with each other. */
async function applyRow(
  row: ScanRow,
  computed: WorkKind
): Promise<"updated" | "raced"> {
  return db.transaction(async (tx) => {
    const done = await tx
      .update(S)
      .set(
        computed === "program"
          ? {
              kind: computed,
              architectureText: sql`coalesce(${S.skillMdText}, ${S.architectureText})`,
              skillMdText: null,
            }
          : {
              kind: computed,
              skillMdText: sql`coalesce(${S.architectureText}, ${S.skillMdText})`,
              architectureText: null,
            }
      )
      .where(and(eq(S.id, row.id), eq(S.kind, row.kind)))
      .returning({ id: S.id });
    return done.length === 1 ? "updated" : "raced";
  });
}

async function main(): Promise<void> {
  if (typeof process.getuid === "function" && process.getuid() === 0)
    die(
      "Refusing to run as root: npx tsx caches inside the deploy user's checkout, and a root-owned cache file there breaks the next build for the user the site runs as. Run this as the deploy user."
    );

  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const allowPartial = argv.includes("--allow-partial");
  const idIdx = argv.indexOf("--id");
  const onlyId = idIdx >= 0 ? (argv[idIdx + 1] ?? "") : null;
  const unknown = argv.filter(
    (a, i) =>
      a !== "--apply" &&
      a !== "--allow-partial" &&
      a !== "--id" &&
      !(idIdx >= 0 && i === idIdx + 1)
  );
  if (unknown.length > 0) usage(`Unknown argument: ${unknown[0]}`);
  if (idIdx >= 0 && !isUuid(onlyId ?? "")) usage("--id needs a submission uuid");

  console.log(`Mode:   ${apply ? "LIVE (--apply)" : "DRY RUN (no writes)"}`);
  console.log(`Scope:  ${onlyId ? `one row (${onlyId})` : "every submission row"}`);
  console.log(
    `Writes: kind, and the reviewed document's text into the column the new kind names. Nothing else: not card_json, not corpus_files_json, not md_*, not updated_at.`
  );

  const base = db
    .select({
      id: S.id,
      title: S.title,
      status: S.status,
      kind: S.kind,
      createdAt: S.createdAt,
      archiveName: S.archiveName,
      parentId: S.parentId,
      panelHeartbeatAt: S.panelHeartbeatAt,
      fileManifestJson: S.fileManifestJson,
      corpusFilesJson: S.corpusFilesJson,
      // Existence bits only: the doc columns are moved by SQL inside the
      // transaction, so their text never needs to travel to this process.
      hasArchText: sql<boolean>`${S.architectureText} is not null`,
      hasSkillText: sql<boolean>`${S.skillMdText} is not null`,
    })
    .from(S);
  const rows: ScanRow[] = onlyId
    ? await base.where(eq(S.id, onlyId))
    : await base.orderBy(asc(S.createdAt));
  if (onlyId && rows.length === 0) die(`no submission row ${onlyId}`);

  const agree: Verdicted[] = [];
  const disagree: Verdicted[] = [];
  const unclassifiable: string[] = [];
  const failed: string[] = [];
  const byRule = new Map<KindRule, { total: number; disagree: number }>();

  for (const row of rows) {
    // Per-row try/catch: one unreadable record never stops the walk, which is
    // the whole point of a script that runs against 85 rows of history.
    try {
      const built = rebuild(row);
      if ("unclassifiable" in built) {
        unclassifiable.push(`${label(row)} "${row.title}": ${built.unclassifiable}`);
        continue;
      }
      const verdict = classifyWorkKind({
        // "" and never null on a row that HAS a manifest: null is the ladder's
        // "there is no package at all" and would answer skill before any file
        // was looked at. inspectArchive passes the same empty string for the
        // same reason.
        packageName: row.archiveName ?? "",
        paths: built.paths,
        innerArchivePaths: built.innerArchivePaths,
        texts: built.texts,
      });
      const gaps = [...built.gaps];
      const textGap = gapForVerdict(built, verdict);
      if (textGap) gaps.push(textGap);
      const tally = byRule.get(verdict.rule) ?? { total: 0, disagree: 0 };
      const agrees = verdict.kind === row.kind;
      tally.total++;
      if (!agrees) tally.disagree++;
      byRule.set(verdict.rule, tally);
      const busy =
        row.status === "running" &&
        row.panelHeartbeatAt !== null &&
        Date.now() - row.panelHeartbeatAt.getTime() < WORK_CAPS.panelStaleMs;
      const v: Verdicted = {
        row,
        verdict,
        agrees,
        gaps,
        notes: built.notes,
        busy,
      };
      (agrees ? agree : disagree).push(v);
    } catch (err) {
      failed.push(`${label(row)} "${row.title}": ${errMessage(err)}`);
    }
  }

  console.log(`\n=== DISAGREEMENTS (${disagree.length}) ===`);
  if (disagree.length === 0) console.log("  (none: every row's label matches its package)");
  for (const v of disagree) {
    console.log(`\n  ${label(v.row)}  ${v.row.kind} -> ${v.verdict.kind}`);
    console.log(`    title:    "${v.row.title}"`);
    console.log(
      `    package:  ${v.row.archiveName ?? "(no archive_name)"}  (${v.verdict.rule})`
    );
    for (const r of v.verdict.reasons) console.log(`    because:  ${r}`);
    console.log(`    receipt:  ${kindVerdictSentence(v.verdict)}`);
    console.log(`    write:    kind='${v.verdict.kind}', ${moveSentence(v.verdict.kind, v.row)}`);
    if (v.row.parentId)
      console.log(
        `    lineage:  this row is an update of ${v.row.parentId}; kind is a property of the CARD, so check that row's label too (nothing here changes it)`
      );
    for (const n of v.notes) console.log(`    note:     ${n}`);
    for (const g of v.gaps) console.log(`    PARTIAL:  ${g}`);
    if (v.busy) console.log(`    BUSY:     a panel run is live on this row right now`);
  }

  console.log(`\n=== AGREEMENTS (${agree.length}) ===`);
  for (const v of agree) {
    const flags = [
      ...(v.gaps.length > 0 ? ["PARTIAL"] : []),
      ...(v.notes.length > 0 ? ["note"] : []),
    ];
    console.log(
      `  ${label(v.row)}  ${v.row.kind.padEnd(7)} ${v.verdict.rule.padEnd(21)} ${v.verdict.reasons[0] ?? ""}${flags.length ? `  [${flags.join(", ")}]` : ""}`
    );
    for (const n of v.notes) console.log(`      note: ${n}`);
    for (const g of v.gaps) console.log(`      PARTIAL: ${g}`);
  }

  if (unclassifiable.length > 0) {
    console.log(
      `\n=== UNCLASSIFIABLE (${unclassifiable.length}) === no readable path list; never guessed, nothing written`
    );
    for (const u of unclassifiable) console.log(`  ${u}`);
  }

  console.log(`\nBy rule (${agree.length + disagree.length} classified):`);
  for (const [rule, t] of [...byRule.entries()].sort((a, b) => b[1].total - a[1].total))
    console.log(
      `  ${rule.padEnd(21)} ${String(t.total).padStart(3)}  (${t.total - t.disagree} agree, ${t.disagree} disagree)`
    );
  console.log(
    `\nVerdict: ${agree.length} of ${rows.length} rows agree with their stored kind, ` +
      `${disagree.length} disagree, ${unclassifiable.length} unclassifiable, ${failed.length} failed to classify.`
  );

  // ── Write pass ───────────────────────────────────────────────────
  // Runs after the WHOLE report, not interleaved with it: the disagreements
  // have to be readable as one block before a single row changes, which is how
  // the 2026-08-28 pass was reviewed by hand. The partition below is computed
  // in both modes, so a dry run prints the exact decision the live run will
  // make and a withheld row is withheld for a stated reason.
  const withheld: string[] = [];
  const toWrite: Verdicted[] = [];
  for (const v of disagree) {
    if (v.gaps.length > 0 && !allowPartial)
      withheld.push(
        `${label(v.row)} "${v.row.title}": ${v.gaps[0]}. Check the original package, then re-run with --allow-partial (or fix the row) if the verdict is right.`
      );
    else if (v.busy)
      withheld.push(
        `${label(v.row)} "${v.row.title}": a panel run is live on this row; that run reads kind as it writes the card. Retry when it finishes.`
      );
    else toWrite.push(v);
  }

  let updated = 0;
  if (apply)
    for (const v of toWrite) {
      try {
        const res = await applyRow(v.row, v.verdict.kind);
        if (res === "updated") {
          updated++;
          console.log(
            `[apply] ${v.row.id} ${v.row.kind} -> ${v.verdict.kind}: updated (${moveSentence(v.verdict.kind, v.row)})`
          );
        } else {
          failed.push(
            `${label(v.row)} "${v.row.title}": stored kind is no longer '${v.row.kind}' (an admin or an update swap changed it under this run); nothing written, re-run to re-read it`
          );
        }
      } catch (err) {
        failed.push(
          `${label(v.row)} "${v.row.title}": write failed: ${errMessage(err)}`
        );
      }
    }

  console.log(
    apply
      ? `\nTally: ${updated} updated, ${withheld.length} skipped, ${failed.length} failed.`
      : `\nTally: ${toWrite.length} would be updated, ${withheld.length} would be skipped, ${failed.length} failed. Nothing was written; pass --apply to write.`
  );
  if (withheld.length > 0) {
    console.log(
      `\nNOT WRITTEN (deliberate; the stored evidence does not settle these on its own):`
    );
    for (const w of withheld) console.log(`  ${w}`);
  }
  if (failed.length > 0) {
    console.log(`\nFAILED (fix the named cause and re-run; completed rows are skipped):`);
    for (const f of failed) console.log(`  ${f}`);
    process.exit(1);
  }
  if (apply && updated > 0)
    console.log(
      `\nA re-run now finds every row agreeing with its stored kind. The cards themselves are untouched: to re-review one, npm run work:rerun -- <uuid>.`
    );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
