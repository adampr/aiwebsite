// Mail-safe encoding for the §5.16 owner retention email's attachments.
//
// Gmail (the ADMIN_EMAIL provider) enforces its blocked-file-type list
// INSIDE archive attachments and content-sniffs beyond the documented list:
// a .ps1 inside a submitted .zip bounced the whole retention email on
// 2026-08-06 (552-5.7.0 ContentRejected), and two .skill packages bounced
// the same way on 2026-08-03, back when the bounce destroyed the only copy.
// Renaming the outer file does not help (Gmail sniffs), and mirroring the
// blocked-extension list would fail open on every type Google adds. So the
// rule INVERTS the screen: only text-named files whose bytes also look like
// text attach as-is; everything else (archives, anything unknown, binaries
// under a text name) attaches as a base64 text file, `<name>.b64.txt`,
// which no provider unpacks. A misclassified text file gets wrapped
// harmlessly; nothing misclassified can bounce.
//
// Filenames are submitter-controlled (web upload name, email MIME
// filename) and reach this seam raw, so every name is reduced to
// `[A-Za-z0-9._-]` before it enters the mail: the body quotes names inside
// a shell one-liner the owner is told to paste, and an unsanitized name
// there is command injection in the owner's terminal (refutation-panel
// probe, 2026-08-06). The true stored name stays on the row.
//
// Pure module, ZERO imports (Buffer is a global): scripts/work-tests.ts
// imports it directly (tsx, no DB, no brain).

/** Names eligible to attach unwrapped (final extension only). Eligibility,
 * not authority: the bytes must ALSO pass the looksBinary screen, because
 * stored names are truncated to 200 chars at intake, so a long zip name
 * can end `.md` after truncation (refutation-panel probe). */
export const MAIL_SAFE_TEXT_EXT = /\.(md|mdx|markdown|txt)$/i;

export type RetentionAttachment = {
  /** Filename in the outgoing mail (sanitized; `<name>.b64.txt` when encoded). */
  attachedName: string;
  /** Byte size of the attached payload (the wrapper, when encoded). */
  attachedBytes: number;
  /** Resend `content` field: base64 of the attached payload. */
  contentBase64: string;
  encoded: boolean;
  /** Sanitized name the decode one-liner restores to. */
  originalName: string;
  originalBytes: number;
};

/** Reduce a submitter-controlled filename to shell-inert, header-inert
 * characters. Anything else (quotes, `$`, backticks, whitespace, newlines,
 * non-ASCII) collapses to `_`; leading dot/dash stripped so the result is
 * never hidden or option-like. */
export function mailSafeName(name: string): string {
  const safe = name
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._-]+/, "")
    .slice(0, 200);
  return safe || "upload";
}

/** Same reduction for an in-archive path printed in the mail. Keeps `/`
 * so the tree is still readable; everything else outside
 * `[A-Za-z0-9._/-]` collapses. Entry paths are submitter-controlled and
 * `normalizePath` (extract.ts) permits quotes, `$`, backticks and
 * NEWLINES, so an unsanitized path printed beside the decode one-liner
 * would forge body lines (refutation panel, 2026-08-06). */
export function mailSafePath(path: string): string {
  const safe = path
    .replace(/[^A-Za-z0-9._/-]+/g, "_")
    .replace(/^[/.]+/, "")
    .slice(0, 200);
  return safe || "entry";
}

/** Cheap, total binary sniff: zip magic (PK\x03\x04 / PK\x05\x06 /
 * PK\x07\x08 covers .zip, .skill and any zip under a text name) or a NUL
 * byte in the first 8 KB. Never parses, never throws; text with no NULs
 * passes. Wrong in the safe direction only: odd text encodings armor. */
export function looksBinary(data: Buffer): boolean {
  if (
    data.length >= 4 &&
    data[0] === 0x50 &&
    data[1] === 0x4b &&
    (data[2] === 0x03 || data[2] === 0x05 || data[2] === 0x07)
  ) {
    return true;
  }
  const n = Math.min(data.length, 8192);
  for (let i = 0; i < n; i++) if (data[i] === 0) return true;
  return false;
}

/** 76-column lines + trailing newline: the shape `base64` emits and both
 * `openssl base64 -d` (macOS and Linux) and GNU `base64 --decode` accept. */
function wrap76(b64: string): string {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join("\n") + "\n";
}

/** Ceiling on the SUM of prepared attachment payloads (contentBase64
 * lengths) one retention email may carry: headroom under Resend's 40 MB
 * whole-message cap for the JSON envelope and body text. With the 100 MB
 * upload cap (2026-08-19) a package can never be forced to fit, so the
 * email attaches what fits and names where the rest lives (the archive
 * store) instead of bouncing or silently attaching nothing. */
export const RETENTION_ATTACH_TOTAL_MAX = 35_000_000;

/** Why a file was left out of the retention email. tooBigAlone: its
 * prepared payload exceeds the threshold by itself, so no ordering could
 * ever attach it ("exceeds what mail providers accept" is truthful only
 * here). budgetSpent: it would fit alone, but the files that attached
 * already use the space this email can carry. */
export type AttachmentOmission = "tooBigAlone" | "budgetSpent";

/** Attach-if-fits partition for the retention email, SMALLEST-FIRST: the
 * small files (a 500 KB SKILL.md beside a 90 MB package) always win a seat
 * before the big ones spend the budget. Files attach whole or not at all
 * (never truncated). Both result lists come back in input-index order,
 * each omission carrying its reason. Pure so scripts/work-tests.ts can pin
 * it without composing mail. */
export function partitionAttachmentsBySize(
  preparedSizes: number[],
  threshold: number = RETENTION_ATTACH_TOTAL_MAX
): { attach: number[]; omit: { index: number; reason: AttachmentOmission }[] } {
  const order = preparedSizes
    .map((size, index) => ({ size, index }))
    .sort((a, b) => a.size - b.size || a.index - b.index);
  const attach: number[] = [];
  const omit: { index: number; reason: AttachmentOmission }[] = [];
  let total = 0;
  for (const { size, index } of order) {
    if (size > threshold) omit.push({ index, reason: "tooBigAlone" });
    else if (size >= 0 && total + size <= threshold) {
      attach.push(index);
      total += size;
    } else omit.push({ index, reason: "budgetSpent" });
  }
  attach.sort((a, b) => a - b);
  omit.sort((a, b) => a.index - b.index);
  return { attach, omit };
}

/**
 * The EXACT contentBase64.length toDeliverableAttachment would produce for
 * a file of rawBytes, WITHOUT building the strings. This is what the
 * partition runs on, so a file that cannot attach is never screened or
 * encoded at all (a 100 MB package would otherwise cost ~750 MB of
 * transient strings plus an event-loop stall on the publish path).
 *
 * Derivation, mirrored line for line against the encoder:
 * - raw text attach: content = base64(data), length 4*ceil(n/3).
 * - armored: b64 = 4*ceil(n/3) chars; wrap76 joins ceil(b64/76) lines with
 *   "\n" and appends one trailing "\n", so the wrapper payload is
 *   b64 + max(1, ceil(b64/76)) bytes (the empty input still emits the lone
 *   trailing newline); content = base64(payload), length 4*ceil(payload/3).
 * Pinned equal to the real encoder's output length in scripts/work-tests.ts
 * across every rounding boundary; measured armored ratio ~1.8012.
 */
export function predictArmoredLength(
  rawBytes: number,
  willArmor: boolean
): number {
  const n = Math.max(0, Math.floor(rawBytes));
  const b64 = 4 * Math.ceil(n / 3);
  if (!willArmor) return b64;
  const payload = b64 + Math.max(1, Math.ceil(b64 / 76));
  return 4 * Math.ceil(payload / 3);
}

/** Would toDeliverableAttachment armor this file? Cheap (name test plus
 * the 8 KB looksBinary sniff); feeds predictArmoredLength. */
export function willArmorFile(f: { name: string; data: Buffer }): boolean {
  return !(MAIL_SAFE_TEXT_EXT.test(f.name) && !looksBinary(f.data));
}

/** One line of plaintext: control characters collapse to spaces, runs of
 * whitespace collapse, ends trimmed. For submitter-controlled strings
 * (row.title) interpolated into labeled plaintext email lines, where an
 * embedded newline would forge body lines. Shared with the §5.16 storage
 * report (Seat 2). */
export function oneLine(s: string): string {
  return s
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Total function: never throws (empty, corrupt and encrypted archives all
 * take the same encode path). */
export function toDeliverableAttachment(f: {
  name: string;
  data: Buffer;
}): RetentionAttachment {
  const safeName = mailSafeName(f.name);
  if (MAIL_SAFE_TEXT_EXT.test(f.name) && !looksBinary(f.data)) {
    return {
      attachedName: safeName,
      attachedBytes: f.data.length,
      contentBase64: f.data.toString("base64"),
      encoded: false,
      originalName: safeName,
      originalBytes: f.data.length,
    };
  }
  const payload = Buffer.from(wrap76(f.data.toString("base64")), "utf8");
  return {
    attachedName: `${safeName}.b64.txt`,
    attachedBytes: payload.length,
    contentBase64: payload.toString("base64"),
    encoded: true,
    originalName: safeName,
    originalBytes: f.data.length,
  };
}
