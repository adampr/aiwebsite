// Email intake for team work submissions (§5.16): the PURE pieces. Subject,
// body, and attachment-shape parsing live here with no node/DB imports so
// scripts/work-tests.ts exercises every branch (governance approval.ts
// pattern). NO EM DASHES in any string (site rule).

import { sanitizeHeaderValue } from "@/lib/governance/approval";
import { WORK_CAPS, type WorkKind } from "./config";

// ".ski" accepted alongside ".skill": Windows/Outlook forwarding chains
// rename attachments to DOS 8.3 short names (real inbounds 2026-07-30:
// "OUTAGE_1.SKI", "SD-DAI~1.SKI"), truncating the extension. The filename is
// only the TRIGGER; the downloaded bytes still pass the zip magic check and
// the full inspectArchive hardening, so the looser match adds no exposure.
export const ARCHIVE_RE = /\.(zip|skill|ski)$/i;
export const MD_RE = /\.(md|mdx|markdown)$/i;

/** Appended to every validation-failure reply so the fix never needs a
 * second round trip. */
export const FORMAT_REMINDER = [
  `How email submissions work:`,
  `- Subject: the card title (${WORK_CAPS.titleMinChars} to ${WORK_CAPS.titleMaxChars} characters). A "Title:" or "Skill Name:" line in the body overrides the subject, so a forwarded email with a generic subject can still name the card.`,
  `- Body: your one-paragraph description (${WORK_CAPS.blurbMinChars} to ${WORK_CAPS.blurbMaxChars} characters): what it does, who uses it, what it replaced.`,
  `- Attach ONE package: a .skill or .zip for a CoWork Skill (plus its SKILL.md as a second attachment if the package does not carry it), or a .zip for a Code program (must contain an architecture doc).`,
  `- Optional body lines: "Title: <card title>" (or "Skill Name:"; overrides the subject, first one wins), "Kind: CoWork Skill" or "Kind: Code program" (otherwise inferred from the attachments), and "Credit: <first name>" for a public credit (otherwise the card credits the XL.net team).`,
  ``,
  `The web form at https://ai.xl.net/work/submit does the same thing with inline errors.`,
].join("\n");

/** Subject -> candidate card title: reply/forward prefixes stripped
 * (repeatedly, any nesting), whitespace collapsed. Validation happens at the
 * call site against WORK_CAPS. */
export function titleFromSubject(subjectRaw: string): string {
  let s = sanitizeHeaderValue(subjectRaw, 200);
  for (let i = 0; i < 8; i++) {
    const next = s.replace(/^(re|fw|fwd)\s*(\[\d+\])?\s*:\s*/i, "");
    if (next === s) break;
    s = next;
  }
  return s.trim();
}

export interface ParsedBody {
  blurb: string;
  /** Explicit card title from a "Title:"/"Skill Name:" body line, or null
   * when absent. Overrides the subject at the call site (owner report
   * 2026-07-31: the first real forwarded submission published under its
   * subject, "skill to our work", while the body named the tool). */
  title: string | null;
  /** Recognized Kind: override, or null when absent. */
  kind: WorkKind | null;
  /** Raw value of an unrecognized Kind: line (reply names it), else null. */
  kindRaw: string | null;
  /** Raw value of a Credit: line (validated at the call site), else null. */
  credit: string | null;
}

const KIND_VALUES: Record<string, WorkKind> = {
  skill: "skill",
  "cowork skill": "skill",
  program: "program",
  "code program": "program",
};

/** Label variants that name the card. Kept tight: only labels that
 * unambiguously mean "this is the tool's name" lift out of the blurb;
 * anything else ("Description:", "Relation to Role:") stays prose. Bare
 * "Name:" is deliberately ABSENT: it is a standard contact-block field
 * ("Name: Jane Doe") and would title the card after the sender (panel
 * critic finding 2026-07-31). Bare "Title:" stays because the format
 * reminder teaches it; the signature job-title collision ("Title: Senior
 * Systems Engineer") is mitigated by first-match-wins plus the receipt
 * email echoing the chosen title. */
const TITLE_LABELS = new Set([
  "title",
  "card title",
  "skill name",
  "program name",
  "tool name",
]);

/** One directive line. Gmail renders a bolded label as
 * "*Skill Name: *Outage Checker": emphasis markers hug the label and can
 * land after the colon, so the matcher tolerates * and _ around both the
 * label and the value. Gmail rich-text conversion can also emit U+00A0
 * inside the label, which must still match (else the original
 * subject-fallback bug silently returns). The label is capped at 15
 * characters so ordinary prose with a long lead-in
 * ("Relation to Role: ...") never matches. */
const DIRECTIVE_RE =
  /^\s*[*_]{0,2}\s*([A-Za-z][A-Za-z \u00A0]{0,14}?)\s*[*_]{0,2}\s*:\s*(.*)$/;

function directiveValue(raw: string): string {
  return raw.replace(/^[\s*_\u00A0]+/, "").replace(/[\s*_\u00A0]+$/, "");
}

/** Gmail's "On <date> <name> <addr> wrote:" attribution, including the
 * hard-wrapped form: real Gmail plain text wraps long attributions across
 * 2-3 lines, breaking before "wrote:" (panel finding 2026-07-30), so the
 * check joins up to three lines before matching. A prose line starting with
 * "On " that never reaches a "wrote:" line is kept. */
function isQuoteAttribution(lines: string[], i: number): boolean {
  if (!/^On\s/.test(lines[i])) return false;
  let joined = "";
  for (let j = i; j < Math.min(i + 3, lines.length); j++) {
    joined += (j > i ? " " : "") + lines[j];
    if (/wrote:\s*$/.test(lines[j]))
      return /^On [\s\S]{0,300}wrote:\s*$/.test(joined.trim());
  }
  return false;
}

/** Email body -> description + directive lines. The body is cut at the first
 * quoted-history or signature marker (plain-text conventions: "-- ", "> ",
 * "On ... wrote:" including Gmail's wrapped form, Outlook dividers), then
 * "Kind:" / "Credit:" lines are lifted out; the rest is the blurb. */
export function parseSubmissionBody(raw: string): ParsedBody {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const kept: string[] = [];
  let title: string | null = null;
  let kind: WorkKind | null = null;
  let kindRaw: string | null = null;
  let credit: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (
      /^--\s*$/.test(line) ||
      /^\s*>/.test(line) ||
      isQuoteAttribution(lines, i) ||
      /^_{6,}\s*$/.test(line) ||
      /^-{3,}\s*Original Message\s*-{3,}\s*$/i.test(line) ||
      /^-{4,}\s*Forwarded message\s*-{4,}/i.test(line) ||
      /^From:\s+\S/.test(line)
    )
      break;
    const directive = DIRECTIVE_RE.exec(line);
    if (directive) {
      const label = directive[1]
        .replace(/\u00A0/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      const value = directiveValue(directive[2]).trim();
      if (label === "kind") {
        const mapped = KIND_VALUES[value.toLowerCase()] ?? null;
        if (mapped) kind = mapped;
        else kindRaw = value.slice(0, 60);
        continue;
      }
      if (label === "credit") {
        credit = value.slice(0, 60);
        continue;
      }
      if (TITLE_LABELS.has(label)) {
        // FIRST match wins (unlike Kind/Credit): a signature job-title
        // line ("Title: Senior Systems Engineer") late in the body must
        // not silently beat an explicit "Skill Name:" line above it
        // (panel critic finding 2026-07-31). An empty value ("Title:"
        // alone) is ignored so the subject stays authoritative rather
        // than failing length validation on "".
        if (value && title === null) title = value.slice(0, 200);
        continue;
      }
      // Unrecognized label: ordinary prose, stays in the blurb.
    }
    kept.push(line);
  }
  const blurb = kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { blurb, title, kind, kindRaw, credit };
}

export interface AttachmentMeta {
  id: string;
  filename: string | null;
  size: number;
}

/** Split attachments into package/doc candidates by filename (inline
 * signature images match neither and fall away). */
export function pickAttachments(atts: AttachmentMeta[]): {
  archives: AttachmentMeta[];
  mds: AttachmentMeta[];
} {
  return {
    archives: atts.filter((a) => ARCHIVE_RE.test(a.filename ?? "")),
    mds: atts.filter((a) => MD_RE.test(a.filename ?? "")),
  };
}

/** Kind resolution: an explicit Kind: line wins; else a .skill/.ski package
 * or a standalone .md attachment means CoWork Skill; a bare .zip is a
 * program. */
export function inferKind(
  packageName: string,
  hasMd: boolean,
  override: WorkKind | null
): WorkKind {
  if (override) return override;
  if (/\.(skill|ski)$/i.test(packageName) || hasMd) return "skill";
  return "program";
}
