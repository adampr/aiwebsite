// RFP intake composition: several files plus pasted text become the ONE
// rawText the single readRfp() call sees (ARCHITECTURE.md §5.17).
//
// CLIENT-SAFE on purpose: no node imports, no lookbehind regexes. The /rfp/new
// form imports the caps so choose-time refusals mirror the server exactly.
//
// Pure functions only, unit-tested by scripts/rfp-intake-tests.ts.

export const RFP_MAX_FILES = 8;
export const RFP_MAX_TOTAL_BYTES = 8_000_000; // mirrors the route's MAX_BYTES
export const RFP_MAX_CHARS = 120_000; // combined cap, mirrors MAX_CHARS
/**
 * The server's 8 MB cap is checked against Content-Length, which also counts
 * the multipart framing and the pasted text. The form budgets this allowance
 * on top of file bytes + text bytes so a selection it accepts cannot 413 at
 * the precheck.
 */
export const RFP_UPLOAD_ENVELOPE_BYTES = 16_384;

/**
 * How long the background read may wait on the brain. The answer is a JSON
 * restatement of every requirement, so its length (and time) scales with the
 * RFP: ~8k chars in 30-40 s for a small one, 31-40k chars in 129-152 s for
 * the AISC RFP that a 120 s budget failed three times on 2026-09-30.
 */
export const RFP_READ_BUDGET_MS = 8 * 60_000;

/**
 * A document still "reading" this long after its last stamp has no live
 * reader (a restart or deploy dropped the background task), so it may be
 * read again. Budget plus a margin for the semaphore wait and the writes.
 */
export const RFP_READ_STALE_MS = RFP_READ_BUDGET_MS + 2 * 60_000;

/**
 * An attacker-chosen filename headed for operator-voice text (a composed
 * header line or an error message). Only this function's output may appear
 * there: strip to [A-Za-z0-9 ._-], collapse whitespace runs to one space,
 * trim, slice(0,120). Empty result falls back to "attachment".
 */
export function sanitizeSourceName(name: string): string {
  const safe = name
    .replace(/[^A-Za-z0-9 ._-]+/g, "")
    .replace(/ +/g, " ")
    .trim()
    .slice(0, 120);
  return safe === "" ? "attachment" : safe;
}

export type RfpIntakePart =
  | { kind: "file"; name: string; text: string } // name RAW here; compose sanitizes
  | { kind: "paste"; text: string };

/**
 * Combine parts into the one rawText the reader sees.
 *
 * Exactly one part returns its text byte-identical to today's single-source
 * behavior: no header, sliced at RFP_MAX_CHARS. With more than one part each
 * gets a header line (header + "\n" + text, parts joined by "\n\n"):
 *
 *   ===== ATTACHED FILE 1 OF 2: proposal.pdf =====
 *   ===== PASTED TEXT =====
 *
 * The numbering counts FILES only; the paste part carries no number. Headers
 * use only "=" and ASCII words, never angle brackets (fence posture) and
 * never em dashes. `truncated` is true when the slice cut anything.
 */
export function composeRfpParts(parts: RfpIntakePart[]): {
  text: string;
  truncated: boolean;
} {
  if (parts.length === 0) return { text: "", truncated: false };
  if (parts.length === 1) {
    const only = parts[0]!;
    return {
      text: only.text.slice(0, RFP_MAX_CHARS),
      truncated: only.text.length > RFP_MAX_CHARS,
    };
  }
  const nFiles = parts.filter((p) => p.kind === "file").length;
  let fileNo = 0;
  const joined = parts
    .map((p) => {
      const header =
        p.kind === "file"
          ? `===== ATTACHED FILE ${++fileNo} OF ${nFiles}: ${sanitizeSourceName(p.name)} =====`
          : "===== PASTED TEXT =====";
      return `${header}\n${p.text}`;
    })
    .join("\n\n");
  return {
    text: joined.slice(0, RFP_MAX_CHARS),
    truncated: joined.length > RFP_MAX_CHARS,
  };
}

// Prefix match, not full-line: the RFP_MAX_CHARS slice can cut the final
// header mid-line, and a truncated header still carries the filename.
const INTAKE_HEADER_RE = /^===== (?:ATTACHED FILE \d+ OF \d+:|PASTED TEXT)/;

/**
 * Remove the composed header lines before the text is used as EVIDENCE.
 *
 * The headers embed attacker-chosen filenames, and the downstream grounding
 * and detector corpora (stated-staff grounding, rfpTitle grounding,
 * staffMentions, the references keyword scans) treat every line of rawText as
 * the client's document: a file named "Acme RFP 350 users.pdf" would
 * otherwise ground a staff count deterministically. Stripping is
 * REMOVAL-ONLY, whole lines only, so a quote that grounds in the stripped
 * text always grounded in what the model saw; a forged header line inside a
 * part's own text is stripped too, which only ever shrinks the corpus.
 */
export function stripIntakeHeaders(text: string): string {
  if (!text.includes("===== ")) return text;
  return text
    .split("\n")
    .filter((line) => !INTAKE_HEADER_RE.test(line))
    .join("\n");
}
