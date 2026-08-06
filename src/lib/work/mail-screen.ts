// Screens an uploaded package so the §5.16 retention email can be
// delivered instead of bounced.
//
// Evidence (2026-08-06, real sends to the owner's mailbox): an armored
// package containing scripts/export_salesforce_schema.ps1 and .sh bounced
// 552-5.7.0 ContentRejected; the same package with those two entries
// removed delivered; the row's SKILL.md alone delivered. The provider
// decodes base64 text attachments and applies its blocked-type policy to
// what is inside, so base64 armor alone cannot carry a package that
// contains a blocked type.
//
// The screen is a BLOCKLIST, not an allowlist: everything the provider's
// published policy (plus the evidence-driven precaution set in
// blocked-types.ts) does not name is KEPT. An allowlist would silently
// strip most of a real package and make the partial the normal outcome.
//
// FALLBACK RULE (normative): every failure path returns the ORIGINAL
// package for armoring, never "attach nothing". A copy that may bounce is
// an alarm; zero bytes is a silent loss, and since 2026-08-04 a bounce
// destroys nothing (the row keeps the bytes permanently).

import { createHash } from "node:crypto";
import JSZip from "jszip";
import { WORK_CAPS } from "./config";
import {
  blockedByBytes,
  blockedByName,
  verdictReason,
  type EntryVerdict,
} from "./blocked-types";
import { mailSafePath } from "./retention-encoding";

export type RemovedEntry = {
  /** Sanitized for display; never the raw submitter string. */
  path: string;
  /** The archive's DECLARED uncompressed size, not a measured one. */
  declaredBytes: number;
  reason: string;
};

export type ScreenResult =
  | { kind: "original"; note?: string }
  | {
      kind: "screened";
      zip: Buffer;
      sha256: string;
      kept: number;
      total: number;
      removed: RemovedEntry[];
    };

/** Wall-clock budget: this runs on the publish path inside the single web
 * process, after the row is already published. Blowing it degrades to the
 * original rather than delaying the response further. */
const SCREEN_BUDGET_MS = 10_000;
const TOTAL_INFLATE_MAX = 64_000_000;

function readmeFor(
  originalName: string,
  originalBytes: number,
  originalSha: string | null,
  removed: RemovedEntry[]
): string {
  return [
    `THIS IS NOT THE ORIGINAL PACKAGE.`,
    ``,
    `It is a screened copy of ${mailSafePath(originalName)} (${originalBytes} bytes,`,
    `SHA-256 ${originalSha ?? "n/a"}), rebuilt for email delivery with the`,
    `entries below removed. The mail provider refuses a whole message when it`,
    `finds one of these types inside an archive attachment.`,
    ``,
    `Removed:`,
    ...removed.map(
      (r) => `  ${r.path} (${r.declaredBytes} bytes declared, ${r.reason})`
    ),
    ``,
    `The complete package, including everything listed above, is stored on the`,
    `submission row in the site database. That stored copy is the only complete`,
    `one; nothing was deleted from it.`,
  ].join("\n");
}

/**
 * Total function: never throws. Returns the original for every failure,
 * cap breach, or clean package.
 */
export async function screenPackageForMail(
  name: string,
  data: Buffer,
  originalSha: string | null
): Promise<ScreenResult> {
  const started = Date.now();
  try {
    const zip = await JSZip.loadAsync(data);
    const entries = Object.values(zip.files).filter((e) => !e.dir);
    if (entries.length === 0 || entries.length > WORK_CAPS.zipMaxEntries) {
      return { kind: "original", note: "unscreened" };
    }
    // First pass: name verdicts are free, so a package with no name hits
    // and no readable content hits is returned untouched (the common case).
    const nameVerdicts = new Map<string, EntryVerdict>();
    for (const e of entries) nameVerdicts.set(e.name, blockedByName(e.name));

    const out = new JSZip();
    const removed: RemovedEntry[] = [];
    let kept = 0;
    let inflated = 0;
    for (const e of entries) {
      if (Date.now() - started > SCREEN_BUDGET_MS)
        return { kind: "original", note: "budget" };
      const declared =
        (e as unknown as { _data?: { uncompressedSize?: number } })._data
          ?.uncompressedSize ?? 0;
      const nameVerdict = nameVerdicts.get(e.name) ?? null;
      if (nameVerdict) {
        removed.push({
          path: mailSafePath(e.name),
          declaredBytes: declared,
          reason: verdictReason(nameVerdict),
        });
        continue;
      }
      inflated += declared;
      if (inflated > TOTAL_INFLATE_MAX)
        return { kind: "original", note: "budget" };
      let buf: Buffer;
      try {
        buf = await e.async("nodebuffer");
      } catch {
        return { kind: "original", note: "unscreened" };
      }
      const byteVerdict = blockedByBytes(buf);
      if (byteVerdict) {
        removed.push({
          path: mailSafePath(e.name),
          declaredBytes: buf.length,
          reason: verdictReason(byteVerdict),
        });
        continue;
      }
      out.file(e.name, buf);
      kept++;
    }
    if (removed.length === 0) return { kind: "original" };

    out.file(
      "_SCREENED-COPY-README.txt",
      readmeFor(name, data.length, originalSha, removed)
    );
    const rebuilt = await out.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
    });
    return {
      kind: "screened",
      zip: rebuilt,
      sha256: createHash("sha256").update(rebuilt).digest("hex"),
      kept,
      total: entries.length,
      removed,
    };
  } catch {
    return { kind: "original", note: "unscreened" };
  }
}
