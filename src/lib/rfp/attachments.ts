// The supporting-documents library and a proposal's picks (ARCHITECTURE.md
// §5.17.23, round 35).
//
// PURE and CLIENT-SAFE: no imports at all, no Buffer (Uint8Array only), no
// lookbehind regexes. The workspace's Attachments pane, the library page,
// the routes, the CLI and the renderers all read the SAME contract from
// here, so what the server stores is exactly what every surface parses.
//
// The frozen shapes:
//   rfp_proposals.attachments_json
//     {"picks":[{"docId","n","title","confidentialConfirmed"?:{"by","at"}}],
//      "map"?:{"<requirementId>": n | 0 | {"ns":[n...],"section"?:"<label>"}},
//      "pickedAt"?:"<ISO>"}
//   n is 1-based pick order, dense, renumbered on every write; title is
//   denormalized at pick time; map's 0 means "explicitly not included", the
//   object form maps one request to several picks and/or to the section of
//   this response that answers it (a single pick with no section is always
//   stored as the bare n, so the legacy n | 0 values read forever);
//   pickedAt is stamped by every {op:"set"} write that changes the picks.
//   The model's only citation form is the literal token {{att:N}}; the
//   renderer resolves it (furniture.ts resolveAttTokens) and strips an N that
//   is not picked, at ONE choke point. The brain never sees a library byte:
//   only "Attachment N: <title>" lines.

/** The library's document kinds (rfp_library_documents.kind). */
export const LIBRARY_KINDS = [
  "certification",
  "report",
  "procedure",
  "template",
  "sample",
  "agreement",
] as const;
export type LibraryKind = (typeof LIBRARY_KINDS)[number];
export function isLibraryKind(v: unknown): v is LibraryKind {
  return typeof v === "string" && (LIBRARY_KINDS as readonly string[]).includes(v);
}

/** Per-file cap, in bytes ("32 MB" in every message). */
export const LIBRARY_MAX_BYTES = 32_000_000;
export const LIBRARY_MAX_COPY = "32 MB";
/** The longest library title (and so the longest denormalized pick title). */
export const LIBRARY_TITLE_MAX = 120;
/** The most documents one proposal may pick. */
export const ATTACHMENTS_MAX = 30;
/** The submission package's cap on the attachments' total bytes (U3): over
 *  it the zip export refuses with 413 before reading a byte. */
export const PACKAGE_ATTACHMENTS_MAX_BYTES = 120_000_000;
export const PACKAGE_ATTACHMENTS_MAX_COPY = "120 MB";

export const MEDIA_PDF = "application/pdf";
export const MEDIA_DOCX =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export type LibraryMedia = typeof MEDIA_PDF | typeof MEDIA_DOCX;

/** The file extension a stored media type exports under ("pdf" | "docx"). */
export function extForMedia(media: string): "pdf" | "docx" | null {
  return media === MEDIA_PDF ? "pdf" : media === MEDIA_DOCX ? "docx" : null;
}

// ---- magic-first validation ------------------------------------------------

const ascii = (buf: Uint8Array, at: number, len: number): string => {
  let s = "";
  for (let i = at; i < at + len && i < buf.length; i++) s += String.fromCharCode(buf[i]!);
  return s;
};
const u16 = (b: Uint8Array, at: number): number => b[at]! | (b[at + 1]! << 8);
const u32 = (b: Uint8Array, at: number): number =>
  (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16)) + b[at + 3]! * 0x1000000;

/**
 * The zip's central-directory entry names, or null when the archive's end
 * record or directory does not parse (truncated, zip64, garbage). Reads the
 * end-of-central-directory record (searched back from the end over the
 * maximum comment length) and walks the directory it points at; never
 * inflates anything. At most 10,000 names.
 */
function zipEntryNames(buf: Uint8Array): string[] | null {
  const EOCD = 22;
  if (buf.length < EOCD + 4) return null;
  let eocd = -1;
  for (let i = buf.length - EOCD; i >= Math.max(0, buf.length - EOCD - 0xffff); i--)
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  if (eocd < 0) return null;
  const entries = u16(buf, eocd + 10);
  const size = u32(buf, eocd + 12);
  const offset = u32(buf, eocd + 16);
  if (entries === 0xffff || size === 0xffffffff || offset === 0xffffffff) return null;
  if (offset + size > eocd) return null;
  const names: string[] = [];
  let at = offset;
  for (let n = 0; n < Math.min(entries, 10_000); n++) {
    if (at + 46 > offset + size) return null;
    if (!(buf[at] === 0x50 && buf[at + 1] === 0x4b && buf[at + 2] === 0x01 && buf[at + 3] === 0x02))
      return null;
    const nameLen = u16(buf, at + 28);
    const extraLen = u16(buf, at + 30);
    const commentLen = u16(buf, at + 32);
    if (at + 46 + nameLen > offset + size) return null;
    names.push(ascii(buf, at + 46, nameLen));
    at += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

/**
 * What a library file IS, from its bytes alone (a filename is a claim, not a
 * fact): a PDF starts "%PDF-"; a Word .docx is a zip (local-header magic
 * "PK\x03\x04") whose central directory names "[Content_Types].xml" and at
 * least one "word/" part (so a .xlsx or .pptx, also OOXML zips, is refused).
 * Anything else is null. Never throws.
 */
export function sniffLibraryFile(
  buf: Uint8Array
): { media: LibraryMedia; ext: "pdf" | "docx" } | null {
  try {
    if (!(buf instanceof Uint8Array) || buf.length < 5) return null;
    if (ascii(buf, 0, 5) === "%PDF-") return { media: MEDIA_PDF, ext: "pdf" };
    if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
      const names = zipEntryNames(buf);
      if (
        names &&
        names.includes("[Content_Types].xml") &&
        names.some((n) => n.startsWith("word/"))
      )
        return { media: MEDIA_DOCX, ext: "docx" };
    }
    return null;
  } catch {
    return null;
  }
}

/** The one refusal for a file that is not a PDF or a Word .docx. */
export const LIBRARY_TYPE_REFUSAL =
  "Upload a PDF or a Word .docx. Other file types cannot be attached to a proposal.";

// ---- title, kind and date screens ------------------------------------------

/**
 * A library title as stored: whitespace collapsed to one line, 2 to 120
 * characters, at least one letter, and REFUSED (null, never cut or
 * repaired) when it carries an em dash or horizontal bar (rule D1), a
 * control character, an invisible format character (\p{Cf}: a bidi
 * override, a zero-width space or joiner, a soft hyphen), a fence-token run
 * of angle brackets, or a curly brace (so no title can ever spell a citation
 * token). The same title is the zip entry, the sheet row and the prompt
 * label.
 */
export function screenLibraryTitle(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > LIBRARY_TITLE_MAX * 4) return null;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw)) return null;
  if (/\p{Cf}/u.test(raw)) return null;
  const t = raw.replace(/\s+/g, " ").trim();
  if (t.length < 2 || t.length > LIBRARY_TITLE_MAX) return null;
  if (!/\p{L}/u.test(t)) return null;
  if (/[\u2014\u2015{}]/.test(t) || /<{3,}|>{3,}/.test(t)) return null;
  return t;
}

/** A filename as a starting title for the library form: the extension
 *  dropped, a package prefix ("Attachment 3 - ", "00 - ") dropped (the
 *  package numbers each document itself, so a title that kept it would
 *  print "Attachment 1 - Attachment 3 - ..."), underscores spaced, one
 *  line, at most LIBRARY_TITLE_MAX. Only a suggestion; the person edits it
 *  before saving, and the route still screens it. */
export function titleFromFilename(name: string): string {
  return String(name ?? "")
    .replace(/\.[A-Za-z0-9]{1,5}$/, "")
    .replace(/^\s*(?:attachment\s+\d{1,3}|00)\s*[-\u2013]\s*/i, "")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, LIBRARY_TITLE_MAX);
}

/** "YYYY-MM-DD" naming a real calendar date, else null. */
export function screenAsOf(raw: unknown): string | null {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const [y, m, d] = raw.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d && y >= 1990 && y <= 2100
    ? raw
    : null;
}

/**
 * ONE validation for a library upload, shared by the route and the CLI so
 * both refuse exactly the same files. Size first (an over-cap file is never
 * sniffed), then the magic, then the fields. Every message is fixed copy
 * naming no byte and no filename.
 */
export function validateLibraryUpload(input: {
  bytes: Uint8Array;
  title: unknown;
  kind: unknown;
  confidential?: unknown;
  redactedSample?: unknown;
  asOf?: unknown;
}):
  | {
      ok: true;
      value: {
        title: string;
        kind: LibraryKind;
        media: LibraryMedia;
        ext: "pdf" | "docx";
        confidential: boolean;
        redactedSample: boolean;
        asOf: string | null;
      };
    }
  | { ok: false; status: 400 | 413; code: string; message: string } {
  const bad = (message: string) => ({ ok: false as const, status: 400 as const, code: "invalid_request", message });
  if (!(input.bytes instanceof Uint8Array) || input.bytes.length === 0) return bad("The file is empty.");
  if (input.bytes.length > LIBRARY_MAX_BYTES)
    return { ok: false, status: 413, code: "too_large", message: `That file is over ${LIBRARY_MAX_COPY}.` };
  const sniffed = sniffLibraryFile(input.bytes);
  if (!sniffed) return bad(LIBRARY_TYPE_REFUSAL);
  const title = screenLibraryTitle(input.title);
  if (title === null)
    return bad(
      `Give the document a title of 2 to ${LIBRARY_TITLE_MAX} characters on one line, with no em dash and no curly braces.`
    );
  if (!isLibraryKind(input.kind)) return bad(`Choose a kind: ${LIBRARY_KINDS.join(", ")}.`);
  const flag = (v: unknown): boolean | null =>
    v === undefined || v === null || v === "" || v === false || v === "false" || v === "0"
      ? false
      : v === true || v === "true" || v === "1" || v === "on"
        ? true
        : null;
  const confidential = flag(input.confidential);
  const redactedSample = flag(input.redactedSample);
  if (confidential === null || redactedSample === null) return bad("Mark confidential and redacted sample as true or false.");
  let asOf: string | null = null;
  if (input.asOf !== undefined && input.asOf !== null && input.asOf !== "") {
    asOf = screenAsOf(input.asOf);
    if (asOf === null) return bad("Give the as-of date as YYYY-MM-DD.");
  }
  return {
    ok: true,
    value: { title, kind: input.kind, media: sniffed.media, ext: sniffed.ext, confidential, redactedSample, asOf },
  };
}

// ---- the citation token ------------------------------------------------------

/**
 * The ONLY form in which model text may cite an attachment: {{att:N}}, N 1 to
 * 99, no spaces. The screens exempt exactly this token from number grounding
 * (its N is a reference, not a claim); the renderer resolves or strips it.
 */
export const ATT_TOKEN_SOURCE = "\\{\\{att:([1-9][0-9]?)\\}\\}";
/** Text with every citation token replaced by a space: what the number
 *  grounding of a screened field reads. */
export function withoutAttTokens(s: string): string {
  return String(s ?? "").replace(new RegExp(ATT_TOKEN_SOURCE, "g"), " ");
}

/**
 * The renderer's tolerant reading of the token (case and inner spaces
 * forgiven, 1 to 3 digits), the same source as furniture.ts ATT_TOKEN's
 * (the cover-letter tests pin the two equal). The remap below rewrites
 * exactly what the renderer would resolve.
 */
export const ATT_TOKEN_LOOSE_SOURCE = "\\{\\{\\s*att\\s*:\\s*(\\d{1,3})\\s*\\}\\}";

/** Every string leaf of a JSON value through `f`; the same object back
 *  (by identity, at every level) when nothing changes. */
function mapStringLeaves(v: unknown, f: (s: string) => string): unknown {
  if (typeof v === "string") return f(v);
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map((x) => {
      const y = mapStringLeaves(x, f);
      if (y !== x) changed = true;
      return y;
    });
    return changed ? out : v;
  }
  if (v && typeof v === "object") {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const y = mapStringLeaves(x, f);
      if (y !== x) changed = true;
      out[k] = y;
    }
    return changed ? out : v;
  }
  return v;
}

/**
 * Citations follow their documents (T2, §5.17.23): every {{att:N}} in every
 * string of a stored sectionsJson (paragraphs, answers, every block string,
 * titles, the letter) rewritten through `renumber` (old n -> new n). An N
 * the old picks did not carry, or a pick the write removes, becomes
 * {{att:0}}, which no pick ever carries, so it strips at render exactly as
 * it did before the write (it never starts citing a document added later).
 * Returns the new JSON and how many tokens changed, or null when nothing
 * changes (or the column does not parse, which is then left as it is).
 */
export function remapSectionsAttTokens(
  sectionsJson: string | null | undefined,
  renumber: ReadonlyMap<number, number>
): { json: string; changed: number } | null {
  if (typeof sectionsJson !== "string" || !/\{\{\s*att/i.test(sectionsJson)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(sectionsJson);
  } catch {
    return null;
  }
  let changed = 0;
  const re = new RegExp(ATT_TOKEN_LOOSE_SOURCE, "gi");
  const next = mapStringLeaves(parsed, (s) =>
    s.includes("{{")
      ? s.replace(re, (m, digits: string) => {
          const to = renumber.get(Number(digits)) ?? 0;
          const out = `{{att:${to}}}`;
          if (out !== m) changed++;
          return out;
        })
      : s
  );
  if (next === parsed || changed === 0) return null;
  return { json: JSON.stringify(next), changed };
}

// ---- the stored picks ------------------------------------------------------

export type AttachmentPick = {
  docId: string;
  n: number;
  title: string;
  /** Present only for a confidential document confirmed on THIS proposal. */
  confidentialConfirmed?: { by: string; at: string };
};
/**
 * One requirement's mapping (X1, frozen): a picked n, 0 ("Not included"),
 * or {ns, section?} for a request answered by several picks and/or by a
 * section of this response (section is a structure label). Canonical form:
 * a single pick with no section is stored as the bare n; ns is ascending,
 * each n once, and never empty without a section.
 */
export type AttachmentMapValue = number | { ns: number[]; section?: string };

/** The parsed column. `map` is always an object here ({} when none);
 *  pickedAt is the ISO time of the last {op:"set"} write that changed the
 *  picks, absent when none recorded one. */
export type ProposalAttachments = {
  picks: AttachmentPick[];
  map: Record<string, AttachmentMapValue>;
  pickedAt?: string;
};

/** The longest section label a mapping may name. */
const MAP_SECTION_MAX = 40;

/**
 * One stored map value, normalized (never throws): `translate` takes a
 * stored n to the n it now has (null drops it). 0 stays 0; a bare n or an
 * {ns, section} object keeps its translated numbers (ascending, once each)
 * and a non-empty section label of at most 40 characters; the canonical
 * form comes back (a lone n as the bare number), or null when nothing is
 * left (the request reads as unmapped).
 */
export function normalizeMapValue(
  v: unknown,
  translate: (n: number) => number | null
): AttachmentMapValue | null {
  const int = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x);
  if (int(v)) {
    if (v === 0) return 0;
    return v > 0 ? translate(v) : null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  try {
    const o = v as { ns?: unknown; section?: unknown };
    const ns = [
      ...new Set(
        (Array.isArray(o.ns) ? o.ns.slice(0, ATTACHMENTS_MAX * 2) : [])
          .filter((x): x is number => int(x) && x > 0)
          .map((x) => translate(x))
          .filter((x): x is number => x !== null && x > 0)
      ),
    ].sort((a, b) => a - b);
    const sec = typeof o.section === "string" ? o.section.replace(/\s+/g, " ").trim() : "";
    const section = sec && sec.length <= MAP_SECTION_MAX && !/[{}<>]/.test(sec) ? sec : "";
    if (!section) return ns.length === 0 ? null : ns.length === 1 ? ns[0]! : { ns };
    return { ns, section };
  } catch {
    return null;
  }
}

/** The pick numbers a map value names ([] for 0 and for a section only). */
export function mapValueNs(v: AttachmentMapValue | undefined | null): number[] {
  if (typeof v === "number") return v > 0 ? [v] : [];
  return v && Array.isArray(v.ns) ? v.ns : [];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);
const isIso = (v: unknown): v is string =>
  typeof v === "string" && v.length <= 40 && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v));

/**
 * Tolerant read of rfp_proposals.attachments_json. Never throws. null,
 * non-JSON, a non-object or a missing `picks` reads as no picks. A pick is
 * kept only with a uuid docId (each docId once, first wins) and a title that
 * still passes screenLibraryTitle; a well-formed confidentialConfirmed
 * ({by, at} non-empty strings) is kept, any other is dropped (the document
 * then reads as unconfirmed). Kept picks are ordered by their stored n
 * (missing or junk n after every numbered one, in array order) and
 * RENUMBERED 1..k densely; at most ATTACHMENTS_MAX. A map entry is kept only
 * for a uuid key whose value normalizes (normalizeMapValue: 0, a stored n of
 * a kept pick, or {ns, section?} keeping the ns of kept picks), each n
 * translated to that pick's new n. pickedAt is kept only as an ISO time.
 */
export function readProposalAttachments(raw: unknown): ProposalAttachments {
  const none: ProposalAttachments = { picks: [], map: {} };
  let o: unknown = raw;
  try {
    if (typeof raw === "string") o = JSON.parse(raw);
  } catch {
    return none;
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return none;
  try {
    const rawPicks = (o as { picks?: unknown }).picks;
    const held: { pick: AttachmentPick; storedN: number | null; i: number }[] = [];
    const seen = new Set<string>();
    if (Array.isArray(rawPicks))
      rawPicks.slice(0, 200).forEach((p, i) => {
        try {
          if (!p || typeof p !== "object" || Array.isArray(p)) return;
          const r = p as Record<string, unknown>;
          if (!isId(r.docId)) return;
          const docId = r.docId.toLowerCase();
          if (seen.has(docId)) return;
          const title = screenLibraryTitle(r.title);
          if (title === null) return;
          seen.add(docId);
          const c = r.confidentialConfirmed as Record<string, unknown> | undefined;
          const confirmed =
            c && typeof c === "object" && !Array.isArray(c) &&
            typeof c.by === "string" && c.by.trim() && c.by.length <= 320 &&
            typeof c.at === "string" && c.at.trim() && c.at.length <= 40
              ? { by: c.by, at: c.at }
              : null;
          const storedN = typeof r.n === "number" && Number.isInteger(r.n) && r.n >= 1 ? r.n : null;
          held.push({ pick: { docId, n: 0, title, ...(confirmed ? { confidentialConfirmed: confirmed } : {}) }, storedN, i });
        } catch {
          // A hostile getter: that pick is simply not kept.
        }
      });
    held.sort((a, b) => {
      if (a.storedN !== null && b.storedN !== null && a.storedN !== b.storedN) return a.storedN - b.storedN;
      if ((a.storedN === null) !== (b.storedN === null)) return a.storedN === null ? 1 : -1;
      return a.i - b.i;
    });
    const kept = held.slice(0, ATTACHMENTS_MAX);
    const newNByStored = new Map<number, number>();
    const picks = kept.map((h, idx) => {
      if (h.storedN !== null && !newNByStored.has(h.storedN)) newNByStored.set(h.storedN, idx + 1);
      return { ...h.pick, n: idx + 1 };
    });
    const map: Record<string, AttachmentMapValue> = {};
    const rawMap = (o as { map?: unknown }).map;
    if (rawMap && typeof rawMap === "object" && !Array.isArray(rawMap))
      for (const [k, v] of Object.entries(rawMap as Record<string, unknown>).slice(0, 2000)) {
        if (!isId(k)) continue;
        const value = normalizeMapValue(v, (n) => newNByStored.get(n) ?? null);
        if (value !== null) map[k.toLowerCase()] = value;
      }
    const pickedAt = (o as { pickedAt?: unknown }).pickedAt;
    return { picks, map, ...(isIso(pickedAt) ? { pickedAt } : {}) };
  } catch {
    return none;
  }
}

/**
 * The column value for a state: NULL when there is nothing to store (no
 * picks, no mapping), so a proposal that never picked anything, or picked
 * and cleared, stores exactly what a pre-round row holds. `map` is written
 * only when non-empty, `pickedAt` only when set (after the picks and the
 * map). Picks are written renumbered 1..k in their order.
 */
export function serializeProposalAttachments(state: ProposalAttachments): string | null {
  const picks = state.picks.map((p, i) => ({
    docId: p.docId,
    n: i + 1,
    title: p.title,
    ...(p.confidentialConfirmed ? { confidentialConfirmed: { by: p.confidentialConfirmed.by, at: p.confidentialConfirmed.at } } : {}),
  }));
  const mapKeys = Object.keys(state.map);
  if (picks.length === 0 && mapKeys.length === 0) return null;
  return JSON.stringify({
    picks,
    ...(mapKeys.length ? { map: state.map } : {}),
    ...(state.pickedAt ? { pickedAt: state.pickedAt } : {}),
  });
}

/** The library facts a pick decision needs (never bytes). */
export type LibraryDocMeta = {
  id: string;
  title: string;
  kind: string;
  media: string;
  confidential: boolean;
  redactedSample: boolean;
  asOf: string | null;
  retired: boolean;
};

/** A library row as every route returns it (never bytes). Dates are ISO
 *  strings; asOf is "YYYY-MM-DD" or null; ext is "pdf" | "docx". */
export type LibraryDocumentWire = {
  id: string;
  title: string;
  kind: string;
  media: string;
  ext: "pdf" | "docx" | null;
  confidential: boolean;
  redactedSample: boolean;
  asOf: string | null;
  retired: boolean;
  retiredAt: string | null;
  createdAt: string;
  createdBy: string;
  sizeBytes: number;
};

export function libraryWire(r: LibraryDocMeta & {
  retiredAt: Date | null;
  createdAt: Date;
  createdBy: string;
  sizeBytes: number;
}): LibraryDocumentWire {
  return {
    id: r.id,
    title: r.title,
    kind: r.kind,
    media: r.media,
    ext: extForMedia(r.media),
    confidential: r.confidential,
    redactedSample: r.redactedSample,
    asOf: r.asOf,
    retired: r.retiredAt !== null,
    retiredAt: r.retiredAt ? r.retiredAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    createdBy: r.createdBy,
    sizeBytes: r.sizeBytes,
  };
}

/** GET (and every successful POST) of /api/rfp/proposals/[id]/attachments.
 *  `docs` holds the library row of every picked document that still has
 *  one (retired rows included, flagged). */
export type ProposalAttachmentsResponse = {
  rev: number;
  picks: AttachmentPick[];
  map: Record<string, AttachmentMapValue>;
  docs: Record<string, LibraryDocumentWire>;
  /** The last picks-changing write's time (absent when none recorded). */
  pickedAt?: string;
  /** POST {op:"set"} only: how many citation tokens in the stored sections
   *  the same write renumbered (T2). Non-zero means the sections changed
   *  too, so the workspace re-reads them. */
  retargeted?: number;
};

export type SetPicksResult =
  | {
      ok: true;
      state: ProposalAttachments;
      added: number;
      removed: number;
      confirmed: number;
      /** The pick list (membership or order) differs from `current`. */
      changed: boolean;
      /** Every old n -> its new n, 0 for a removed pick: the citation
       *  remap the same write applies to the stored sections (T2). */
      renumber: Map<number, number>;
    }
  | { ok: false; status: 400 | 404 | 409; code: string; message: string };

/**
 * The POST {op:"set"} decision, pure. `docIds` is the new pick order.
 *   - each id at most once (400), at most ATTACHMENTS_MAX (400);
 *   - an id already picked on this proposal is kept even when its library
 *     row has since retired (its bytes still export); any NEW id must name a
 *     live library row (404 naming nothing: the id is unknown or retired);
 *   - a kept pick keeps its denormalized title and any confirmation; a new
 *     pick takes the library title at this moment;
 *   - every confidential document must carry a confirmation: one already
 *     recorded on its pick, or `confirm` naming it now (recorded as
 *     {by: actor, at: now}); otherwise 409 naming the document's TITLE;
 *   - `confirm` may name only ids in `docIds` (400);
 *   - picks are renumbered 1..k in the given order, and every map entry
 *     follows its DOCUMENT to its new number (a removed pick leaves the
 *     entry's other numbers and section; an entry left with nothing is
 *     unmapped; 0 stays 0);
 *   - pickedAt becomes `now` when the pick list changes (membership or
 *     order), else stays as it was, so a re-sent identical list is a no-op.
 */
export function planSetPicks(input: {
  current: ProposalAttachments;
  docIds: unknown;
  confirm: unknown;
  library: LibraryDocMeta[];
  actor: string;
  now: string;
}): SetPicksResult {
  const bad = (message: string): SetPicksResult => ({ ok: false, status: 400, code: "invalid_request", message });
  if (!Array.isArray(input.docIds) || !input.docIds.every(isId))
    return bad("Send the picked documents as a list of library ids.");
  const ids = (input.docIds as string[]).map((s) => s.toLowerCase());
  if (new Set(ids).size !== ids.length) return bad("The same document is picked twice.");
  if (ids.length > ATTACHMENTS_MAX) return bad(`A proposal carries at most ${ATTACHMENTS_MAX} attachments.`);
  if (input.confirm !== undefined && (!Array.isArray(input.confirm) || !input.confirm.every(isId)))
    return bad("Send the confirmed documents as a list of library ids.");
  const confirm = new Set(((input.confirm as string[] | undefined) ?? []).map((s) => s.toLowerCase()));
  for (const c of confirm) if (!ids.includes(c)) return bad("A confirmation names a document that is not picked.");

  const byId = new Map(input.library.map((d) => [d.id.toLowerCase(), d]));
  const before = new Map(input.current.picks.map((p) => [p.docId, p]));
  let confirmed = 0;
  const picks: AttachmentPick[] = [];
  for (const id of ids) {
    const prior = before.get(id);
    const doc = byId.get(id);
    if (!prior && (!doc || doc.retired))
      return { ok: false, status: 404, code: "not_found", message: "A picked document is not in the library. Reload the list." };
    let confirmation = prior?.confidentialConfirmed;
    if (doc?.confidential && !confirmation) {
      if (!confirm.has(id))
        return {
          ok: false,
          status: 409,
          code: "confidential_unconfirmed",
          message: `"${prior?.title ?? doc.title}" is confidential. Confirm it may be shared with this client before attaching it.`,
        };
      confirmation = { by: input.actor, at: input.now };
      confirmed++;
    }
    picks.push({
      docId: id,
      n: picks.length + 1,
      title: prior?.title ?? doc!.title,
      ...(doc?.confidential && confirmation ? { confidentialConfirmed: confirmation } : {}),
    });
  }
  const newN = new Map(picks.map((p) => [p.docId, p.n]));
  const oldDoc = new Map(input.current.picks.map((p) => [p.n, p.docId]));
  const translate = (n: number): number | null => newN.get(oldDoc.get(n) ?? "") ?? null;
  const map: Record<string, AttachmentMapValue> = {};
  for (const [req, v] of Object.entries(input.current.map)) {
    const moved = normalizeMapValue(v, translate);
    if (moved !== null) map[req] = moved;
  }
  const renumber = new Map(input.current.picks.map((p) => [p.n, newN.get(p.docId) ?? 0]));
  const changed =
    ids.length !== input.current.picks.length || ids.some((id, i) => input.current.picks[i]?.docId !== id);
  const added = ids.filter((id) => !before.has(id)).length;
  // Stamped only on an ADDITION: a reorder or a removal renumbers every
  // stored citation in the same write (remapSectionsAttTokens), so only a
  // new pick can leave an earlier draft uncited and earn the pane's
  // redraft note.
  const pickedAt = added > 0 ? input.now : input.current.pickedAt;
  return {
    ok: true,
    state: { picks, map, ...(pickedAt ? { pickedAt } : {}) },
    added,
    removed: input.current.picks.filter((p) => !newN.has(p.docId)).length,
    confirmed,
    changed,
    renumber,
  };
}

export type SetMapResult =
  | { ok: true; state: ProposalAttachments; mapped: number; notIncluded: number }
  | { ok: false; status: 400; code: string; message: string };

/**
 * The POST {op:"map"} decision, pure: MERGES `map` into the stored mapping.
 * Every key must be one of `requirementIds` (this document's requirements);
 * every value is a picked n (1..picks.length), 0 ("Not included"), null
 * (clears the entry back to unmapped) or {ns: [picked n...], section?:
 * "<label>"} where every n is picked and section is one of `sectionLabels`
 * (this document's structure); the object is stored canonically
 * (normalizeMapValue: a lone n bare, {ns: []} with no section clears).
 * Anything else is 400 and nothing changes. At most 500 entries per request.
 */
export function planSetMap(input: {
  current: ProposalAttachments;
  map: unknown;
  requirementIds: string[];
  sectionLabels?: string[];
}): SetMapResult {
  const bad = (message: string): SetMapResult => ({ ok: false, status: 400, code: "invalid_request", message });
  const m = input.map;
  if (!m || typeof m !== "object" || Array.isArray(m)) return bad("Send the mapping as an object of requirement ids.");
  const entries = Object.entries(m as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 500) return bad("Send between 1 and 500 mapping entries.");
  const reqs = new Set(input.requirementIds.map((r) => r.toLowerCase()));
  const picked = (n: unknown): n is number =>
    typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= input.current.picks.length;
  const labels = new Set(input.sectionLabels ?? []);
  const next: Record<string, AttachmentMapValue> = { ...input.current.map };
  for (const [k, v] of entries) {
    const key = k.toLowerCase();
    if (!isId(k) || !reqs.has(key)) return bad("A mapping names a requirement this RFP does not have.");
    if (v === null) delete next[key];
    else if (v === 0 || picked(v)) next[key] = v;
    else if (v && typeof v === "object" && !Array.isArray(v)) {
      const o = v as { ns?: unknown; section?: unknown };
      const keys = Object.keys(o);
      if (keys.some((x) => x !== "ns" && x !== "section") || !Array.isArray(o.ns) || o.ns.length > ATTACHMENTS_MAX || !o.ns.every(picked))
        return bad("Map a requirement to picked attachment numbers.");
      if (o.section !== undefined && (typeof o.section !== "string" || !labels.has(o.section)))
        return bad("A mapping names a section this response does not have.");
      const value = normalizeMapValue(o, (n) => n);
      if (value === null) delete next[key];
      else next[key] = value;
    } else return bad("Map a requirement to a picked attachment number, 0 for not included, or null to clear it.");
  }
  const vals = Object.values(next);
  return {
    ok: true,
    state: { ...input.current, map: next },
    mapped: vals.filter((v) => v !== 0).length,
    notIncluded: vals.filter((v) => v === 0).length,
  };
}

/** The titles of confidential picks with no recorded confirmation: an
 *  export must refuse (or omit) these. Empty when every one is confirmed. */
export function unconfirmedConfidential(
  picks: AttachmentPick[],
  docs: Pick<LibraryDocMeta, "id" | "confidential">[]
): string[] {
  const conf = new Set(docs.filter((d) => d.confidential).map((d) => d.id.toLowerCase()));
  return picks.filter((p) => conf.has(p.docId) && !p.confidentialConfirmed).map((p) => p.title);
}

/** The labels the drafter, questionnaire and revise asks carry: n and title
 *  only, in pick order. */
export function attachmentLabels(state: ProposalAttachments): { n: number; title: string }[] {
  return state.picks.map((p) => ({ n: p.n, title: p.title }));
}
