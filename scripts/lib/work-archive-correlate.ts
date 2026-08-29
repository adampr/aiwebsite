// Pure correlation helpers for the §5.16 external-recovery lane
// (scripts/work-archive-correlate.ts): given the facts a DB scan reports
// (what each work_submissions row RECORDS about its original upload and
// standalone doc, what the work_archive_files ledger holds) and an index of
// the files in a folder of recovered material, decide per slot whether the
// original is still on-box, admin-deleted (final), or missing, and for the
// missing ones which local file (if any) IS the original.
//
// Deliberately DB-free and filesystem-free: test:correlate unit-tests every
// rule here without a database, and the script stays a thin walker around
// them. The only imports are the pure name/path rules the store itself uses
// (archive-naming.ts), so rel_path predictions can never drift from what
// storeArchiveFilesAt actually mints, plus jszip for the bounded SKILL.md
// name sniff (a Buffer in, a string out, never throws).
//
// PROVENANCE RULES, the reason this module exists:
//   - a recorded sha256 is the only originality claim; a local file
//     "recovers" a slot only when it hashes to that sha;
//   - a SCREENED copy (`<name>.screened.<ext>`, the retention email's
//     Gmail-safe rewrite of a package) is a different byte stream by
//     construction, so it can NEVER satisfy a recorded sha; the tool says
//     the original is not in the folder and never proposes --force;
//   - a row with no recorded sha can only be name+bytes matched, which is
//     disclosed as unverifiable, never claimed as the original;
//   - admin cleanup is FINAL: a deleted ledger row at the slot's rel_path is
//     reported, and no import is proposed (work:import refuses it anyway).

import JSZip from "jszip";
import {
  sanitizeStoredName,
  storedRelPath,
} from "../../src/lib/work/archive-naming";

/** package = slot 00, md = slot 01, ALWAYS (same values as
 * scripts/lib/work-archive-ops.ts; defined here so this module has no
 * dependency on the write-lane helpers). */
export const PACKAGE_SLOT = 0;
export const MD_SLOT = 1;

/** Default stored names when a row records none (mirrors work:backfill). */
export const DEFAULT_PACKAGE_NAME = "upload.zip";
export const DEFAULT_MD_NAME = "SKILL.md";

// ---------------------------------------------------------------------------
// Names and armor
// ---------------------------------------------------------------------------

/** `<name>.b64.txt`: the retention email's base64 armor wrapper
 * (retention-encoding.ts toDeliverableAttachment). */
export function isArmorName(name: string): boolean {
  return /\.b64\.txt$/i.test(name);
}

/** The name the armor restores to (`x.skill.b64.txt` -> `x.skill`). A
 * non-armor name comes back unchanged. */
export function unarmoredName(name: string): string {
  return name.replace(/\.b64\.txt$/i, "");
}

/** `<name>.screened.<ext>`: a Gmail-safe REWRITE of a package, never the
 * original bytes. */
export function isScreenedName(name: string): boolean {
  return /\.screened\./i.test(name);
}

/** The name a screened copy was derived from (`x.screened.skill` ->
 * `x.skill`), for name matching only; the bytes are not the original. */
export function unscreenedName(name: string): string {
  return name.replace(/\.screened\./i, ".");
}

/**
 * Decode the 76-column base64 armor the encoder emits (any line width and
 * any whitespace is accepted: the operator may have re-wrapped it). Returns
 * null when the text is not clean base64: a character outside the base64
 * alphabet after stripping whitespace, padding anywhere but the end, or a
 * length that is not a multiple of 4, or nothing left at all (an empty
 * decode is never a recovered artifact, so the encoder's lone trailing
 * newline for an empty input is null too).
 */
export function decodeArmor(text: string): Buffer | null {
  const compact = text.replace(/\s+/g, "");
  if (compact.length === 0 || compact.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return null;
  return Buffer.from(compact, "base64");
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

export type RowFacts = {
  id: string;
  title: string;
  status: string;
  /** ISO date or timestamp text; the script formats it, this module only
   * echoes it. */
  createdAt: string;
  archiveName: string | null;
  archiveSha256: string | null;
  archiveBytes: number | null;
  mdName: string | null;
  mdSha256: string | null;
  mdBytes: number | null;
  /** archive_data is not null (existence bit; the blob is never read). */
  hasArchive: boolean;
  /** md_data is not null. */
  hasMd: boolean;
};

export type LedgerFacts = {
  relPath: string;
  fileName: string;
  bytes: number;
  sha256: string;
  deleted: boolean;
};

/** One file in the recovered folder (or a decoded armor copy of one). */
export type LocalEntry = {
  /** Absolute or operator-relative path; used verbatim in commands. */
  path: string;
  bytes: number;
  sha256: string;
  /** "file": a regular file as found. "decoded-armor": the bytes a
   * `.b64.txt` decoded to, written under `<dir>/.decoded/`. */
  source: "file" | "decoded-armor";
  /** The armor file a decoded entry came from (source "decoded-armor"). */
  armorPath?: string;
};

/** sha256 -> every local entry with those bytes. */
export type LocalIndex = Map<string, LocalEntry[]>;

/** The basename of a local entry, reduced by the store's own name rule so
 * it compares against a row's sanitized recorded name. */
export function localName(entry: LocalEntry): string {
  return sanitizeStoredName(basename(entry.path));
}

function basename(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i === -1 ? path : path.slice(i + 1);
}

// ---------------------------------------------------------------------------
// Slot coverage
// ---------------------------------------------------------------------------

export type SlotVerdict =
  /** The row still holds the bytea: nothing to recover (work:backfill
   * stores it). */
  | "row-bytes"
  /** A LIVE ledger row holds this slot: sha-equal to the recorded sha, or
   * (no sha recorded) live at the slot's minted rel_path. */
  | "store-live"
  /** A LIVE ledger row sits at the slot's minted rel_path but hashes to
   * something OTHER than the recorded sha (a forced import, a differing
   * backfill): the store holds the wrong bytes. The folder is still
   * searched for the true original, but no import is proposed: the
   * per-slot ledger gate of work:import refuses a slot with a live row,
   * so the wrong store file must be deleted in the console first. */
  | "store-mismatch"
  /** Only admin-DELETED ledger rows stand at this slot: cleanup is FINAL,
   * never recoverable by script. */
  | "admin-deleted"
  /** No bytea, no ledger trace: the original exists only off-box. */
  | "missing";

export type SlotCoverage = {
  slot: number;
  /** The recorded name, or the slot's default when the row recorded none. */
  name: string;
  sha256: string | null;
  bytes: number | null;
  relPath: string;
  verdict: SlotVerdict;
  /** Disclosure beside the verdict (the sha-equal live file sitting under
   * another rel_path; the sha the mismatched store file actually has). */
  note: string | null;
};

/** The slots a row RECORDS: 00 when archive_name or archive_sha256 is
 * stamped, 01 when md_name or md_sha256 is. A row that records neither
 * has no slot to cover (and nothing this tool can say about it). */
export function recordedSlots(row: RowFacts): number[] {
  const slots: number[] = [];
  if (row.archiveName || row.archiveSha256) slots.push(PACKAGE_SLOT);
  if (row.mdName || row.mdSha256) slots.push(MD_SLOT);
  return slots;
}

/**
 * Per recorded slot: is the original still on-box? Order of evidence:
 * bytea present -> row-bytes; a live ledger row hashing to the recorded
 * sha -> store-live (noted when it sits under another rel_path); a live
 * row at the slot's minted rel_path -> store-live when no sha is
 * recorded, store-mismatch when the recorded sha differs; only deleted
 * rows at the rel_path or with the recorded sha -> admin-deleted; else
 * missing.
 */
export function slotCoverage(row: RowFacts, ledger: LedgerFacts[]): SlotCoverage[] {
  return recordedSlots(row).map((slot) => {
    const pkg = slot === PACKAGE_SLOT;
    const name = (pkg ? row.archiveName : row.mdName) ?? (pkg ? DEFAULT_PACKAGE_NAME : DEFAULT_MD_NAME);
    const sha256 = pkg ? row.archiveSha256 : row.mdSha256;
    const bytes = pkg ? row.archiveBytes : row.mdBytes;
    const relPath = storedRelPath(row.id, slot, name);
    const base = { slot, name, sha256, bytes, relPath };
    if (pkg ? row.hasArchive : row.hasMd)
      return { ...base, verdict: "row-bytes" as const, note: null };
    const live = ledger.filter((l) => !l.deleted);
    const bySha = sha256 ? live.find((l) => l.sha256 === sha256) : undefined;
    if (bySha)
      return {
        ...base,
        verdict: "store-live" as const,
        note:
          bySha.relPath === relPath
            ? null
            : `the sha-equal live file sits at ${bySha.relPath}, not the slot's minted path`,
      };
    const atPath = live.find((l) => l.relPath === relPath);
    if (atPath) {
      if (sha256 === null) return { ...base, verdict: "store-live" as const, note: null };
      return {
        ...base,
        verdict: "store-mismatch" as const,
        note: `the live store file at this slot hashes to ${atPath.sha256}, not the recorded ${sha256} (a forced import or a differing backfill)`,
      };
    }
    const deletedHere = ledger.some(
      (l) => l.deleted && (l.relPath === relPath || (sha256 !== null && l.sha256 === sha256))
    );
    if (deletedHere) return { ...base, verdict: "admin-deleted" as const, note: null };
    return { ...base, verdict: "missing" as const, note: null };
  });
}

// ---------------------------------------------------------------------------
// Recovery planning
// ---------------------------------------------------------------------------

export type RecoveryVerdict =
  /** A local file hashes to the recorded sha: it IS the original. */
  | "recoverable"
  /** The row records no sha; a non-screened local file has the same
   * sanitized name AND byte count. Import proceeds without verification
   * (work:import says so), so the operator must look at the file first. */
  | "unverifiable-name-match"
  /** The only name-matching local files are screened copies: a screened
   * copy can never satisfy the recorded sha, the original is NOT in this
   * folder, and no --force is ever proposed. */
  | "screened-only"
  /** Nothing in the folder matches. */
  | "unrecovered";

export type SlotRecovery = SlotCoverage & {
  /** What the FOLDER holds for this slot (independent of whether an
   * import can run right now). */
  recovery: RecoveryVerdict;
  /** The chosen local entry (recoverable or unverifiable-name-match). */
  file: LocalEntry | null;
  /** The `--file <path>` / `--md <path>` flag for the chosen entry, only
   * when it may ride an import command right now; null otherwise. */
  flag: string | null;
  /** True only when the slot is recoverable AND work:import would accept
   * it as things stand: the slot is missing (not store-mismatch) and the
   * row holds no bytea in any slot. Everything else is printed with its
   * reason and counts toward exit 2. */
  ready: boolean;
  /** Why the slot is not ready (empty when ready). */
  reason: string;
};

export type RowRecovery = {
  row: RowFacts;
  /** Every recorded slot with its coverage. */
  slots: SlotCoverage[];
  /** The missing and store-mismatch slots with their recovery verdict. */
  open: SlotRecovery[];
  /** Ready-to-run import command covering ONLY the ready slots (never
   * --force, never --yes: the operator confirms), or null when no slot is
   * ready. */
  command: string | null;
};

/** Plain file before a decoded armor copy, then the shortest path, then
 * lexicographic: a stable pick when duplicates exist. */
export function preferLocal(a: LocalEntry, b: LocalEntry): number {
  if (a.source !== b.source) return a.source === "file" ? -1 : 1;
  return a.path.length - b.path.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/** Quote a path for a POSIX shell only when it needs it (spaces and
 * parentheses are common in browser-downloaded names). */
export function shellQuote(path: string): string {
  if (/^[A-Za-z0-9._\/:=@%+,-]+$/.test(path)) return path;
  return `'${path.replace(/'/g, "'\\''")}'`;
}

export function slotFlag(slot: number, path: string): string {
  return `${slot === MD_SLOT ? "--md" : "--file"} ${shellQuote(path)}`;
}

export function importCommand(id: string, flags: string[]): string {
  return `npm run work:import -- ${id} ${flags.join(" ")}`;
}

function allEntries(localIndex: LocalIndex): LocalEntry[] {
  const out: LocalEntry[] = [];
  for (const entries of localIndex.values()) out.push(...entries);
  return out;
}

/** Local entries whose (unscreened) sanitized name equals the slot's
 * sanitized recorded name. */
function nameMatches(cov: SlotCoverage, entries: LocalEntry[]): LocalEntry[] {
  const want = sanitizeStoredName(cov.name);
  return entries.filter((e) => {
    const n = localName(e);
    return n === want || (isScreenedName(n) && sanitizeStoredName(unscreenedName(n)) === want);
  });
}

/** What the folder holds for one slot, before any import-eligibility
 * question: the sha rung, the name+bytes rung (no recorded sha), the
 * screened-only disclosure, or nothing. */
export function searchFolder(
  cov: SlotCoverage,
  localIndex: LocalIndex
): { recovery: RecoveryVerdict; file: LocalEntry | null; reason: string } {
  if (cov.sha256) {
    const hits = [...(localIndex.get(cov.sha256) ?? [])].sort(preferLocal);
    if (hits.length > 0) return { recovery: "recoverable", file: hits[0], reason: "" };
  }
  const byName = nameMatches(cov, allEntries(localIndex));
  const screened = byName.filter((e) => isScreenedName(localName(e)));
  const plain = byName.filter((e) => !isScreenedName(localName(e))).sort(preferLocal);
  if (cov.sha256 === null) {
    const sized = plain.filter((e) => cov.bytes !== null && e.bytes === cov.bytes);
    if (sized.length > 0) {
      const file = sized[0];
      return {
        recovery: "unverifiable-name-match",
        file,
        reason:
          `the row records no sha256; ${file.path} (${file.bytes} bytes) has the same sanitized name and byte count, ` +
          `which proves nothing about originality. Open the file and check it by eye before importing; ` +
          `work:import will proceed without hash verification.`,
      };
    }
  }
  if (plain.length === 0 && screened.length > 0)
    return {
      recovery: "screened-only",
      file: null,
      reason:
        `only screened copies match by name (${screened.map((e) => e.path).join(", ")}); ` +
        `a screened copy is a Gmail-safe rewrite, never the original bytes, so it can never satisfy the recorded sha256. ` +
        `The original is NOT in this folder.`,
    };
  const differing = plain.length > 0
    ? ` A same-named local file exists (${plain.map((e) => `${e.path}, ${e.bytes} bytes`).join("; ")}) but its bytes differ: not the original.`
    : "";
  return {
    recovery: "unrecovered",
    file: null,
    reason: cov.sha256
      ? `no local file hashes to the recorded sha256 ${cov.sha256}.${differing}`
      : `the row records no sha256 and no non-screened local file matches its sanitized name and byte count (${cov.bytes ?? "unknown"} bytes).${differing}`,
  };
}

/**
 * One missing or store-mismatch slot: the folder search, then the two
 * import-eligibility gates work:import applies before it would accept the
 * file. A store-mismatch slot never rides a command (its live ledger row
 * refuses the slot; the wrong store file must go first). A row that still
 * holds bytea in ANY slot never rides a command either (work:import
 * refuses byte-holding rows whole; work:backfill stores the row's own
 * bytes first). In both cases a recoverable file is still NAMED, because
 * knowing the true original is in the folder is the point.
 */
export function planSlotRecovery(
  cov: SlotCoverage,
  localIndex: LocalIndex,
  rowHoldsBytes = false
): SlotRecovery {
  const found = searchFolder(cov, localIndex);
  const base = { ...cov, recovery: found.recovery, file: found.file };
  const original = found.recovery === "recoverable" && found.file ? ` The true original IS in this folder: ${found.file.path}.` : "";
  if (cov.verdict === "store-mismatch")
    return {
      ...base,
      flag: null,
      ready: false,
      reason:
        `the store holds a live file at this slot whose sha256 differs from the recorded one; ` +
        `work:import refuses a slot with a live ledger row, so delete the wrong store file in the /admin/work#storage console first, then re-run this tool.` +
        (original || ` ${found.reason}`),
    };
  if (rowHoldsBytes)
    return {
      ...base,
      flag: null,
      ready: false,
      reason:
        `the row still holds bytea in another slot; work:import refuses byte-holding rows: ` +
        `run npm run work:backfill first, then re-run this tool.` +
        (original || ` ${found.reason}`),
    };
  if (found.recovery === "recoverable" && found.file)
    return { ...base, flag: slotFlag(cov.slot, found.file.path), ready: true, reason: "" };
  return {
    ...base,
    flag: found.recovery === "unverifiable-name-match" && found.file ? slotFlag(cov.slot, found.file.path) : null,
    ready: false,
    reason: found.reason,
  };
}

/**
 * The whole folder against the whole table. Every row comes back (so the
 * script can count the complete ones); rows with a missing or mismatched
 * slot carry the per-slot verdicts and an import command over the READY
 * slots only.
 */
export function planRecovery(
  rows: RowFacts[],
  ledgerByRowId: Map<string, LedgerFacts[]>,
  localIndex: LocalIndex
): RowRecovery[] {
  return rows.map((row) => {
    const slots = slotCoverage(row, ledgerByRowId.get(row.id) ?? []);
    const holdsBytes = row.hasArchive || row.hasMd;
    const open = slots
      .filter((s) => s.verdict === "missing" || s.verdict === "store-mismatch")
      .map((s) => planSlotRecovery(s, localIndex, holdsBytes));
    const flags = open.filter((m) => m.ready && m.flag).map((m) => m.flag as string);
    return {
      row,
      slots,
      open,
      command: flags.length > 0 ? importCommand(row.id, flags) : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Unmatched local files
// ---------------------------------------------------------------------------

export type UnmatchedGroup = {
  sha256: string;
  bytes: number;
  /** Every local entry with these bytes, best path first. */
  entries: LocalEntry[];
};

/** Every sha256 a row records or the ledger holds (deleted rows included:
 * a local copy of an admin-deleted file is still "known", not a candidate
 * that was never submitted). */
export function knownShas(rows: RowFacts[], allLedger: LedgerFacts[]): Set<string> {
  const known = new Set<string>();
  for (const r of rows) {
    if (r.archiveSha256) known.add(r.archiveSha256);
    if (r.mdSha256) known.add(r.mdSha256);
  }
  for (const l of allLedger) known.add(l.sha256);
  return known;
}

/**
 * Local entries whose bytes correspond to NO submission: not a recorded
 * row sha, not a ledger sha. Grouped by sha so duplicates list together.
 * An armor source file is hidden whenever its decoded copy is indexed
 * (matched or not): the decoded copy is the artifact, the armor is its
 * transport, and listing both would double-count. An armor that could
 * not be decoded has no decoded entry and stays listed as itself.
 */
export function unmatchedLocal(
  localIndex: LocalIndex,
  rows: RowFacts[],
  allLedger: LedgerFacts[]
): UnmatchedGroup[] {
  const known = knownShas(rows, allLedger);
  const decodedFrom = new Set<string>();
  for (const e of allEntries(localIndex))
    if (e.source === "decoded-armor" && e.armorPath) decodedFrom.add(e.armorPath);
  const groups: UnmatchedGroup[] = [];
  for (const [sha256, entries] of localIndex) {
    if (known.has(sha256)) continue;
    const kept = entries.filter((e) => !(e.source === "file" && decodedFrom.has(e.path))).sort(preferLocal);
    if (kept.length === 0) continue;
    groups.push({ sha256, bytes: kept[0].bytes, entries: kept });
  }
  return groups.sort((a, b) => preferLocal(a.entries[0], b.entries[0]));
}

// ---------------------------------------------------------------------------
// Bounded SKILL.md name sniff
// ---------------------------------------------------------------------------

/** Read cap for any text the sniff parses. */
export const SNIFF_TEXT_CAP = 64 * 1024;

/** `name:` out of a leading YAML front-matter block, or null. Only the
 * front matter is consulted (an "author:\n  name:" nested key never
 * matches: the line must start at column 0). */
export function frontmatterName(text: string): string | null {
  const t = text.slice(0, SNIFF_TEXT_CAP).replace(/^\uFEFF/, "");
  const m = t.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!m) return null;
  const n = m[1].match(/^name:[ \t]*(.+?)[ \t]*$/m);
  if (!n) return null;
  return n[1].replace(/^["']|["']$/g, "").trim() || null;
}

/** PK\x03\x04: a local zip header, the shape every .skill/.zip starts with. */
export function isZipMagic(data: Buffer): boolean {
  return data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04;
}

/**
 * Best-effort `name:` for an unmatched local file: a bare `.md` reads its
 * own front matter; a zip container (by magic, so `.skill`, `.zip` and a
 * renamed zip all count) reads the FIRST `SKILL.md` at depth <= 2 (at most
 * two directories above it), capped at SNIFF_TEXT_CAP bytes. Never throws:
 * a bad zip, an encrypted entry or a non-text file yields null.
 */
export async function sniffSkillName(name: string, data: Buffer): Promise<string | null> {
  try {
    if (isZipMagic(data)) {
      const zip = await JSZip.loadAsync(data);
      const paths = Object.keys(zip.files)
        .filter((p) => !zip.files[p].dir && /(^|\/)SKILL\.md$/i.test(p))
        .filter((p) => p.split("/").length <= 3)
        .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
      if (paths.length === 0) return null;
      const buf = await zip.files[paths[0]].async("nodebuffer");
      return frontmatterName(buf.subarray(0, SNIFF_TEXT_CAP).toString("utf8"));
    }
    if (/\.(md|markdown)$/i.test(name))
      return frontmatterName(data.subarray(0, SNIFF_TEXT_CAP).toString("utf8"));
    return null;
  } catch {
    return null;
  }
}
