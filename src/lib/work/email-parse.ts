// Email intake for team work submissions (§5.16): the PURE pieces. Subject,
// body, and attachment-shape parsing live here with no node/DB imports so
// scripts/work-tests.ts exercises every branch (governance approval.ts
// pattern). NO EM DASHES in any string (site rule).

import { sanitizeHeaderValue } from "@/lib/governance/approval";
import { WORK_CAPS, type WorkKind } from "./config";

export const ARCHIVE_RE = /\.(zip|skill)$/i;
export const MD_RE = /\.(md|mdx|markdown)$/i;

/** Appended to every validation-failure reply so the fix never needs a
 * second round trip. */
export const FORMAT_REMINDER = [
  `How email submissions work:`,
  `- Subject: the card title (${WORK_CAPS.titleMinChars} to ${WORK_CAPS.titleMaxChars} characters).`,
  `- Body: your one-paragraph description (${WORK_CAPS.blurbMinChars} to ${WORK_CAPS.blurbMaxChars} characters): what it does, who uses it, what it replaced.`,
  `- Attach ONE package: a .skill or .zip for a CoWork Skill (plus its SKILL.md as a second attachment if the package does not carry it), or a .zip for a Code program (must contain an architecture doc).`,
  `- Optional body lines: "Kind: CoWork Skill" or "Kind: Code program" (otherwise inferred from the attachments), and "Credit: <first name>" for a public credit (otherwise the card credits the XL.net team).`,
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
    const directive = /^\s*(kind|credit)\s*:\s*(.*)$/i.exec(line);
    if (directive) {
      const value = directive[2].trim();
      if (directive[1].toLowerCase() === "kind") {
        const mapped = KIND_VALUES[value.toLowerCase()] ?? null;
        if (mapped) kind = mapped;
        else kindRaw = value.slice(0, 60);
      } else {
        credit = value.slice(0, 60);
      }
      continue;
    }
    kept.push(line);
  }
  const blurb = kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { blurb, kind, kindRaw, credit };
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

/** Kind resolution: an explicit Kind: line wins; else a .skill package or a
 * standalone .md attachment means CoWork Skill; a bare .zip is a program. */
export function inferKind(
  packageName: string,
  hasMd: boolean,
  override: WorkKind | null
): WorkKind {
  if (override) return override;
  if (/\.skill$/i.test(packageName) || hasMd) return "skill";
  return "program";
}
