// Mail-provider attachment policy for the §5.16 retention email.
//
// Google's "File types blocked in Gmail" list applies to the type "when
// found within archives (like .zip or .tgz files)", and it is enforced on
// the DECODED content of a base64 text attachment: on 2026-08-06 an
// armored package carrying a .ps1 and a .sh bounced 552-5.7.0, and the
// SAME package with those two entries removed delivered. So the retention
// mail screens entries against this policy and sends a copy that complies,
// naming every removal. Nothing here exists to defeat a scanner: the screen
// removes content rather than hiding it.
//
// Pure module, ZERO imports (Buffer is a global), mirroring
// secret-patterns.ts: an external policy list deserves its own dated file.
// Re-read the source page and bump LIST_RETRIEVED whenever a retention
// bounce is observed.

/** Source: https://support.google.com/mail/answer/6590, retrieved this date. */
export const LIST_RETRIEVED = "2026-08-06";

/** Google's published blocked list, lowercase, no leading dot. */
export const GMAIL_BLOCKED_EXT: ReadonlySet<string> = new Set([
  "ade", "adp", "apk", "appx", "appxbundle", "bat", "cab", "chm", "cmd",
  "com", "cpl", "diagcab", "diagcfg", "diagpkg", "dll", "dmg", "ex", "ex_",
  "exe", "hta", "img", "ins", "iso", "isp", "jar", "jnlp", "js", "jse",
  "lib", "lnk", "mde", "mjs", "msc", "msi", "msix", "msixbundle", "msp",
  "mst", "nsh", "pif", "ps1", "scr", "sct", "shb", "sys", "vb", "vbe",
  "vbs", "vhd", "vxd", "wsc", "wsf", "wsh", "xll",
]);

/** NOT published by Google. Evidence and family closure only: the observed
 * bounce carried a `.sh` alongside the `.ps1` and the two were removed
 * together, so neither is exonerated; the PowerShell siblings share the
 * published `.ps1`'s semantics. Deliberately ABSENT: `.py`, `.rb`, `.go`,
 * `.sql`, `.html`, `.css` and other source that Google does not block and
 * that a work package exists to carry. Widening this set silently thins
 * every future retention copy, so it needs evidence, not caution. */
export const PRECAUTION_BLOCKED_EXT: ReadonlySet<string> = new Set([
  "sh", "bash", "zsh", "ksh", "csh", "command",
  "psm1", "ps1xml", "psd1", "psc1", "ps2", "ps2xml",
  "reg", "scf", "shs", "url", "inf", "gadget", "appref-ms",
]);

/** Containers whose contents this screen cannot enumerate, and whose
 * contents the provider's policy still reaches. Removed with a truthful
 * reason rather than passed through uncertified. */
export const UNSCREENABLE_CONTAINER_EXT: ReadonlySet<string> = new Set([
  "gz", "tgz", "bz2", "tbz", "tbz2", "xz", "txz", "lz", "lzma", "zst",
  "7z", "rar", "arj", "ace", "tar",
]);

export type EntryVerdict =
  | "blocked_type"
  | "blocked_type_precaution"
  | "unscreenable_container"
  | "executable_content"
  | null;

/** Final extension of the basename, lowercased, no dot. Empty when the
 * basename has none (a dotfile like `.gitignore` has none). */
export function finalExt(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

export function blockedByName(path: string): EntryVerdict {
  const ext = finalExt(path);
  if (!ext) return null;
  if (GMAIL_BLOCKED_EXT.has(ext)) return "blocked_type";
  if (PRECAUTION_BLOCKED_EXT.has(ext)) return "blocked_type_precaution";
  if (UNSCREENABLE_CONTAINER_EXT.has(ext)) return "unscreenable_container";
  return null;
}

/** Content screen for what no name list can catch: a shebang script under
 * any name, and native executables (ELF, Mach-O, PE/MZ, Java class). Reads
 * a handful of leading bytes; never parses, never throws. */
export function blockedByBytes(data: Buffer): EntryVerdict {
  if (data.length >= 2 && data[0] === 0x23 && data[1] === 0x21)
    return "executable_content"; // #!
  if (data.length >= 4) {
    const b = data;
    const elf = b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46;
    const pe = b[0] === 0x4d && b[1] === 0x5a; // MZ
    const classFile =
      b[0] === 0xca && b[1] === 0xfe && b[2] === 0xba && b[3] === 0xbe;
    const machO =
      (b[0] === 0xfe && b[1] === 0xed && b[2] === 0xfa) ||
      (b[0] === 0xcf && b[1] === 0xfa && b[2] === 0xed && b[3] === 0xfe);
    if (elf || pe || classFile || machO) return "executable_content";
  }
  return null;
}

/** Owner-facing reason text. Plain, no em dashes, states the mechanism
 * without asserting which specific rule the provider applied. */
export function verdictReason(v: Exclude<EntryVerdict, null>): string {
  switch (v) {
    case "blocked_type":
      return "file type the mail provider blocks inside archives";
    case "blocked_type_precaution":
      return "script type withheld after the 2026-08-06 bounce";
    case "unscreenable_container":
      return "nested archive whose contents cannot be screened";
    case "executable_content":
      return "contents are an executable or a shebang script";
  }
}
