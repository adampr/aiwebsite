// Pure decision + parsing helpers for the §5.16 EXHIBIT retention lane
// (scripts/work-exhibit-retain.ts, npm run work:retain). Deliberately
// DB-free and disk-free, exactly like scripts/lib/work-archive-ops.ts:
// scripts/work-exhibit-tests.ts pins every rule here without a database,
// and the script stays a thin wrapper around the archive-store seam.
//
// Context: /work renders TWO lanes. Lane A is work_submissions (the "From
// the Team" section), whose accepted uploads the store already retains.
// Lane B is the 26 hand-authored exhibit cards of src/app/work/page.tsx
// (bays 01 to 05), which have NO database row, no bytea and no ledger
// trace, so their own packages were retained NOWHERE. This lane files
// them under exhibits/<slug>/<NN>-<name> with a null-submission ledger
// row, which needs no schema change (see storeExhibitArchive).
//
// The slot constants come from work-archive-ops so the two lanes can
// never disagree about which NN a package or a document occupies, and
// ledgerSlot is reused verbatim so an exhibit rel_path is read the same
// way an import gate reads a submission one.

import { sanitizeStoredName } from "../../src/lib/work/archive-naming";
import {
  MD_SLOT,
  PACKAGE_SLOT,
  ledgerSlot,
} from "./work-archive-ops";

export { MD_SLOT, PACKAGE_SLOT, ledgerSlot };

/** The exhibit lane's two slots, named for what they hold here: the
 * source package at 00 and the optional accompanying document at 01. Same
 * numbers as the submission lane's package/md by construction. */
export const EXHIBIT_PACKAGE_SLOT = PACKAGE_SLOT;
export const EXHIBIT_DOC_SLOT = MD_SLOT;

/**
 * Title normalization for the exact-match gate. A DELIBERATE pure copy of
 * normalizeTitle in src/lib/work/db.ts (which is not imported here because
 * that module pulls in the drizzle client and the whole work_submissions
 * surface, and this file must stay runnable with no DATABASE_URL). The
 * tests read db.ts as TEXT and assert the two implementations are the
 * same expression, so the copy cannot drift silently.
 */
export function normalizeExhibitTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ").toLowerCase();
}

/** One candidate exhibit from src/lib/work/static-titles.json. */
export type ExhibitCandidate = {
  title: string;
  /** The card's anchor id and bay, when the snapshot carries them; shown
   * in output only, never part of any decision. */
  id?: string;
  bay?: string;
};

export type ExhibitTitleMatch =
  | { ok: true; exhibit: ExhibitCandidate }
  | { ok: false; error: string };

/** Candidates worth naming back to an operator who mistyped a title:
 * anything whose normalized form contains, or is contained by, the input,
 * plus anything sharing a word of three or more characters. Ordered by
 * the snapshot's own order so the output is stable; capped. */
export function nearExhibitTitles(
  input: string,
  candidates: ExhibitCandidate[],
  limit = 5
): ExhibitCandidate[] {
  const norm = normalizeExhibitTitle(input);
  if (norm === "") return candidates.slice(0, limit);
  const words = new Set(norm.split(" ").filter((w) => w.length >= 3));
  const near = candidates.filter((c) => {
    const n = normalizeExhibitTitle(c.title);
    if (n.includes(norm) || norm.includes(n)) return true;
    return n.split(" ").some((w) => w.length >= 3 && words.has(w));
  });
  return near.slice(0, limit);
}

/**
 * The exhibit gate: --exhibit must be an EXACT normalizeTitle match
 * against the static-titles snapshot of src/app/work/page.tsx. Exact,
 * because a near match is exactly how one exhibit's package would end up
 * filed under another exhibit's slug, and nothing downstream would ever
 * notice. Whitespace and case are the only forgiveness (that is what
 * normalizeTitle is), and a refusal names the near matches so the
 * operator can copy one.
 */
export function matchExhibitTitle(
  input: string,
  candidates: ExhibitCandidate[]
): ExhibitTitleMatch {
  const norm = normalizeExhibitTitle(input);
  if (norm === "")
    return { ok: false, error: "--exhibit needs a non-empty exhibit title" };
  const hits = candidates.filter(
    (c) => normalizeExhibitTitle(c.title) === norm
  );
  if (hits.length === 1) return { ok: true, exhibit: hits[0] };
  if (hits.length > 1)
    return {
      ok: false,
      error:
        `${JSON.stringify(input)} matches ${hits.length} exhibit cards in the snapshot ` +
        `(${hits.map((h) => JSON.stringify(h.title)).join(", ")}). ` +
        `Two cards with one title cannot be told apart by title; fix the snapshot or the page first.`,
    };
  const near = nearExhibitTitles(input, candidates);
  return {
    ok: false,
    error:
      `${JSON.stringify(input)} is not an exhibit card title on /work.\n` +
      `The exhibit lane files under the card's EXACT title (case and inner spacing are forgiven, nothing else).\n` +
      (near.length > 0
        ? `Did you mean:\n${near.map((c) => `  ${JSON.stringify(c.title)}${c.bay ? `  (bay ${c.bay})` : ""}`).join("\n")}`
        : `No card title resembles it. The full list is the "exhibits" array of src/lib/work/static-titles.json.`),
  };
}

export type RetainArgs = {
  exhibit: string;
  /** The source package (slot 00). Required: an exhibit with only a
   * document has nothing to retain. */
  file: string;
  /** An accompanying document (slot 01), optional. */
  doc: string | null;
  dryRun: boolean;
  yes: boolean;
};

export type RetainParse =
  | { ok: true; args: RetainArgs }
  | { ok: false; error: string };

/** work:retain argv contract, pure so the refusal shapes are pinned:
 * --exhibit and --file are required and take a value, --doc optional,
 * --dry-run/--yes booleans, no positionals, anything else refused (a
 * typo'd flag must never be silently swallowed). */
export function parseRetainArgs(argv: string[]): RetainParse {
  let exhibit: string | null = null;
  let file: string | null = null;
  let doc: string | null = null;
  let dryRun = false;
  let yes = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--yes") yes = true;
    else if (a === "--exhibit" || a === "--file" || a === "--doc") {
      const v = argv[i + 1];
      // A value that itself looks like a flag is a missing value, not a
      // value: "--file --dry-run" must not store a file called --dry-run.
      if (v === undefined || v.startsWith("--"))
        return { ok: false, error: `${a} needs a value` };
      if (a === "--exhibit") {
        if (exhibit !== null) return { ok: false, error: "--exhibit given twice" };
        exhibit = v;
      } else if (a === "--file") {
        if (file !== null) return { ok: false, error: "--file given twice" };
        file = v;
      } else {
        if (doc !== null) return { ok: false, error: "--doc given twice" };
        doc = v;
      }
      i++;
    } else if (a.startsWith("--"))
      return { ok: false, error: `unknown flag ${a}` };
    else return { ok: false, error: `unexpected argument ${a}` };
  }
  if (exhibit === null) return { ok: false, error: "--exhibit is required" };
  if (file === null)
    return {
      ok: false,
      error: "--file is required (the exhibit's source package)",
    };
  return { ok: true, args: { exhibit, file, doc, dryRun, yes } };
}

export type ExhibitLedgerFact = {
  relPath: string;
  fileName: string;
  bytes: number;
  sha256: string;
  deleted: boolean;
  deletedAt: string | null;
};

export type PlannedExhibitFile = {
  slot: number;
  /** "package" / "document", for messages. */
  label: string;
  /** The name the file will be stored under (pre-sanitize). */
  name: string;
  bytes: number;
  sha256: string;
};

export type ExhibitSlotAction =
  /** Nothing occupies this slot: write it. */
  | "store"
  /** A LIVE ledger row at this slot has the SAME sha256: already
   * retained, byte-identical. Skipped, never rewritten. */
  | "skip-sha-match"
  /** A LIVE ledger row at this slot holds DIFFERENT bytes, or the slot
   * was admin-deleted (retired permanently). Refuses the whole run. */
  | "refuse";

export type ExhibitSlotPlan = PlannedExhibitFile & {
  action: ExhibitSlotAction;
  /** Present for skip-sha-match and refuse: the sentence the script
   * prints. */
  reason?: string;
};

export type ExhibitPlan =
  | { ok: true; plan: ExhibitSlotPlan[] }
  | { ok: false; error: string };

/**
 * The per-SLOT gate, mirroring importSlotRefusal's semantics exactly (see
 * the comments on allArchiveFilesForSubmission and deleteStoredArchive)
 * with ONE addition, the sha-match skip that makes a re-run idempotent:
 *
 *   - no ledger row at the slot            -> store
 *   - LIVE row, same sha256                -> skip (already retained; a
 *     re-run of the same command is a no-op and says so)
 *   - LIVE row, different sha256           -> REFUSE. The store already
 *     manages a different file at that slot; replacing it is a deletion
 *     plus a write, and this script does not delete.
 *   - ADMIN-DELETED row at the slot        -> REFUSE, permanently. Admin
 *     cleanup is final for the scripted lanes: work_archive_rel_path_uq
 *     is a FULL unique index covering deleted rows, so re-filing the very
 *     same name would collide at the insert (and the collision handler
 *     unlinks the fresh file), while a differently-named file would
 *     quietly resurrect a slot an admin deliberately emptied. Manual SQL
 *     is the only override and is deliberately not offered.
 *   - a rel_path in the slug directory with no NN- prefix -> refuse the
 *     whole run: storeExhibitArchive cannot have written it, so the
 *     ledger looks tampered or hand-edited.
 *
 * A refusal anywhere refuses the RUN, not just the slot: an exhibit's
 * package and document are handed over together, and a half-filed
 * exhibit is the state hardest to reason about later.
 */
export function planExhibitSlots(
  ledger: ExhibitLedgerFact[],
  planned: PlannedExhibitFile[]
): ExhibitPlan {
  const malformed = ledger.filter((l) => ledgerSlot(l.relPath) === null);
  if (malformed.length > 0)
    return {
      ok: false,
      error:
        `ledger row(s) without a NN- slot prefix under this exhibit: ` +
        malformed.map((l) => l.relPath).join(", ") +
        `\nstoreExhibitArchive never writes such a rel_path, so this ledger looks tampered or hand-edited. ` +
        `Refusing to retain anything for this exhibit until a human inspects the ledger.`,
    };
  const plan = planned.map((p): ExhibitSlotPlan => {
    const nn = String(p.slot).padStart(2, "0");
    const at = ledger.filter((l) => ledgerSlot(l.relPath) === p.slot);
    const gone = at.find((l) => l.deleted);
    if (gone)
      return {
        ...p,
        action: "refuse",
        reason:
          `slot ${nn} was ADMIN-DELETED (${gone.relPath}${gone.deletedAt ? `, ${gone.deletedAt.slice(0, 10)}` : ""}): ` +
          `cleanup is final for the scripted lanes and that slot is retired permanently. This script will not re-file it.`,
      };
    const live = at.find((l) => !l.deleted);
    if (!live) return { ...p, action: "store" };
    if (live.sha256 === p.sha256)
      return {
        ...p,
        action: "skip-sha-match",
        reason:
          `slot ${nn} already holds this exact file (${live.relPath}, sha256 ${live.sha256}): nothing to do.` +
          (live.fileName === sanitizeStoredName(p.name)
            ? ""
            : ` NOTE: it is stored under the name ${live.fileName}, not ${sanitizeStoredName(p.name)}; the bytes are identical, so this run leaves it alone.`),
      };
    return {
      ...p,
      action: "refuse",
      reason:
        `slot ${nn} is held by a live ledger row with DIFFERENT bytes (${live.relPath}, ${live.bytes} bytes, sha256 ${live.sha256}).\n` +
        `    the file offered here is ${p.bytes} bytes, sha256 ${p.sha256}.\n` +
        `    Refusing: this script never replaces a stored file. Deleting the existing one in /admin/work#storage retires that slot ` +
        `permanently (the rel_path unique index covers deleted rows), so decide deliberately rather than by re-running.`,
    };
  });
  return { ok: true, plan };
}

/** The refusal message for a plan, or null when the run may proceed. */
export function exhibitPlanRefusal(plan: ExhibitSlotPlan[]): string | null {
  const refusals = plan.filter((p) => p.action === "refuse");
  if (refusals.length === 0) return null;
  return refusals
    .map((p) => `  ${p.label}: ${p.reason ?? "refused"}`)
    .join("\n");
}
