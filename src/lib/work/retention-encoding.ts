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
