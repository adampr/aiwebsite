// Email intake for team work submissions (§5.16): the PURE pieces. Subject,
// body, and attachment-shape parsing live here with no node/DB imports so
// scripts/work-tests.ts exercises every branch (governance approval.ts
// pattern). NO EM DASHES in any string (site rule).

import { sanitizeHeaderValue } from "@/lib/governance/approval";
import { TITLE_KIND_PREFIX_RE, WORK_CAPS, type WorkKind } from "./config";
import { stringViolations } from "./lint";
import {
  nameKey,
  SLUG_SHAPE_RE,
  splitMachineEcho,
  stripMachineEcho,
} from "./names";

// Re-exported so intake and tests keep a single import surface; the
// definitions moved to names.ts (lint.ts needs them too, and this file
// already imports FROM lint.ts).
export { nameKey, splitMachineEcho, stripMachineEcho } from "./names";

// ".ski" accepted alongside ".skill": Windows/Outlook forwarding chains
// rename attachments to DOS 8.3 short names (real inbounds 2026-07-30:
// "OUTAGE_1.SKI", "SD-DAI~1.SKI"), truncating the extension. The filename is
// only the TRIGGER; the downloaded bytes still pass the zip magic check and
// the full inspectArchive hardening, so the looser match adds no exposure.
export const ARCHIVE_RE = /\.(zip|skill|ski)$/i;
export const MD_RE = /\.(md|mdx|markdown)$/i;

/** One-line alternative-channel pointer for rejection replies (2026-08-03
 * natural-email round: the old seven-bullet FORMAT_REMINDER buried each
 * reject's targeted fix under a wall of rules, which is what the owner's
 * bounced email showed). Every reject branch carries its own fix; this only
 * offers the form, with no parity claim (the email band is deliberately
 * wider than the form's). Suppressed on wait-class rejects where the form
 * would hit the same wall. */
export const FORM_POINTER =
  "If the form is easier, you can also submit at https://ai.xl.net/work/submit.";

/** Subject -> candidate card title: reply/forward prefixes stripped
 * (repeatedly, any nesting), whitespace collapsed. Validation happens at the
 * call site against WORK_CAPS. 2026-07-31 additions, all conservative:
 * zero-width characters go FIRST (ECMAScript \s includes U+FEFF, so
 * sanitizeHeaderValue's \s+ collapse would turn a mid-word BOM into a
 * space before a later strip could see it); leading bracket tags up to 40
 * chars ([EXTERNAL], [EXT], list tags) unwrap interleaved with Re/Fwd; one
 * trailing 1-3 digit "(n)" copy counter drops ("(2024)" and mid-title
 * parentheticals are kept). The "Title:" body line is the escape hatch for
 * any intended title that looks like a transport artifact. */
export function titleFromSubject(subjectRaw: string): string {
  let s = sanitizeHeaderValue(
    subjectRaw.replace(/[\u200B-\u200D\u2060\uFEFF]/g, ""),
    200
  );
  for (let i = 0; i < 8; i++) {
    const next = s
      .replace(/^(re|fw|fwd)\s*(\[\d+\])?\s*:\s*/i, "")
      .replace(/^\[[^\[\]]{1,40}\]\s*/, "");
    if (next === s) break;
    s = next.trim();
  }
  return s.replace(/\s*\(\d{1,3}\)\s*$/, "").trim();
}

/** Mail clients that send an empty Subject header often send a PLACEHOLDER
 * instead, and until 2026-07-31 those published verbatim: "(no subject)" is
 * 12 characters and cleared the 4-60 gate, so the card title became the
 * client's stand-in text. A denylist Set, not a regex: the regex shapes tried
 * during the panel round classified the ordinary word "subject" as a
 * placeholder while missing "(none)". A locale not enumerated here simply
 * keeps the old behavior rather than inventing new behavior. Deliberately
 * ABSENT: "fwd"/"fw"/"re"/"forward" (titleFromSubject already strips those as
 * transport prefixes) and "test" (a submitter may legitimately want a card
 * called Test, and rejecting that would break a path that works today). */
const PLACEHOLDER_SUBJECT_KEYS = new Set([
  "no subject",
  "nosubject",
  "none",
  "no title",
  "untitled",
  "no topic",
  "sin asunto",
  "kein betreff",
  "ohne betreff",
  "sans objet",
  "aucun objet",
  "senza oggetto",
  "sem assunto",
  "geen onderwerp",
  "无主题",
  "無主題",
  "제목 없음",
  "без темы",
  "brak tematu",
  "automatic reply",
  "out of office",
]);

/** True when a subject carries no author intent. MUST be run against BOTH the
 * raw header and the transport-stripped value: real forwards arrive as
 * "Fwd: (no subject)" and "[EXTERNAL] (no subject)", which only reduce to the
 * bare placeholder after titleFromSubject (panel critic finding 2026-07-31 —
 * screening the raw header alone left the bug live). */
export function isPlaceholderSubject(subject: string): boolean {
  const key = subject
    .replace(/^[\s([<{"'*`]+/, "")
    .replace(/[\s)\]>}"'*`]+$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return PLACEHOLDER_SUBJECT_KEYS.has(key);
}

/** Strip leading category/kind prefixes from a SUBJECT-DERIVED title
 * ("Claude Skill: Slack Knowledge Assistant" published as a card title,
 * 2026-07-31). Subject lines are transport surfaces, so the strip is
 * silent; authored titles (the form field, a "Title:" body line) are
 * rejected with instructions instead, at their call sites. Repeats to
 * unwrap nesting ("Claude Skill: Skill: X"); an over-strip to under 4
 * chars fails the existing length gate with its instructive message. */
export function stripKindPrefix(title: string): string {
  let s = title.trim();
  for (let i = 0; i < 3; i++) {
    const next = s.replace(TITLE_KIND_PREFIX_RE, "");
    if (next === s) break;
    s = next.trim();
  }
  return s;
}

export interface ParsedBody {
  blurb: string;
  /** Value of a strong update directive ("Update Card:" family), or null.
   * The line is lifted out of the blurb; resolution against published cards
   * happens at the call site. Bare "Update:" is deliberately NOT a
   * directive: it is one of the most common prose line-openers in exactly
   * this correspondence genre, and a matcher on it silently converts an
   * ordinary status line into a replacement proposal (refutation FATAL
   * class, 2026-08-03; same reasoning as bare "Name:" above). */
  updateTarget: string | null;
  /** Explicit card title from a "Title:"/"Skill Name:" body line, or null
   * when absent. Overrides the subject at the call site (owner report
   * 2026-07-31: the first real forwarded submission published under its
   * subject, "skill to our work", while the body named the tool). */
  title: string | null;
  /** Recognized Kind: override, or null when absent. */
  kind: WorkKind | null;
  /** Raw value of an unrecognized Kind: line (receipt notes that the
   * attachments decided; the line stays in the blurb), else null. */
  kindRaw: string | null;
  /** Raw value of a Kind: line honored via fuzzyKind (an inference, so the
   * receipt discloses it; the line stays in the blurb), else null. */
  kindInferred: string | null;
  /** Lifted Credit: value; by construction always matches CREDIT_RE, so it
   * can never bounce downstream. Null when absent or non-name-shaped. */
  credit: string | null;
  /** Raw value of a Credit: line that was NOT name-shaped (stays in the
   * blurb as prose; the receipt notes the card credits the team), else
   * null. */
  creditIgnored: string | null;
  /** WEAK title candidates in body order, at most one per source. These are
   * NOT titles: they still have to be corroborated by the package or
   * confirmed by the model. The lines they come from stay in the blurb. */
  titleCandidates: { value: string; source: "name-line" | "first-line" }[];
}

const KIND_VALUES: Record<string, WorkKind> = {
  skill: "skill",
  "cowork skill": "skill",
  "claude skill": "skill",
  program: "program",
  "code program": "program",
};

/** Fuzzy Kind: disambiguation for label-like values ("a skill", "Claude
 * skill thing", "skill."). Deliberately narrow (2026-08-03 refutation
 * round): only short values (at most 3 words and 30 chars), never values
 * carrying a negator ("not a skill" must not lift skill), and only when
 * exactly ONE side matches. Returns null for everything else; the caller
 * keeps the line in the blurb and discloses in the receipt either way. */
export function fuzzyKind(value: string): WorkKind | null {
  const v = value.trim();
  if (!v || v.length > 30 || v.split(/\s+/).length > 3) return null;
  if (/\b(?:not?|non|never|isn'?t)\b/i.test(v)) return null;
  const hasSkill = /\bskills?\b/i.test(v);
  const hasProgram = /\bprograms?\b|\bcode\b/i.test(v);
  if (hasSkill === hasProgram) return null;
  return hasSkill ? "skill" : "program";
}

/** The public-credit shape (byte-equal to the intake and web-route accept
 * gate): a single first name, ASCII letters, 2-20 chars. The parser lifts
 * ONLY values that will be accepted, so an email Credit: line can never
 * bounce a submission; everything else stays in the blurb as prose and the
 * receipt notes it (refutation round 2026-08-03: "Credit: Jane Doe" used to
 * lift into a guaranteed reject, the closer-to-correct-the-harsher-the-
 * outcome inversion). */
export const CREDIT_RE = /^[A-Za-z][A-Za-z'-]{1,19}$/;

/** Label variants that name the card. Kept tight: only labels that
 * unambiguously mean "this is the tool's name" lift out of the blurb;
 * anything else ("Description:", "Relation to Role:") stays prose. Bare
 * "Name:" is deliberately ABSENT and STAYS absent: it is a standard
 * contact-block field ("Name: Jane Doe") and would title the card after the
 * sender (panel critic finding 2026-07-31). It is served instead by the weak
 * NAME_LABELS candidate path below, which cannot title a card on its own.
 * Bare "Title:" stays because the format
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

/** Strong update-directive labels (§5.16 admin-mediated updates). Multiword
 * only: bare "update"/"updates" stays prose (see ParsedBody.updateTarget).
 * All fit DIRECTIVE_RE's 15-char label cap. */
const UPDATE_LABELS = new Set([
  "update card",
  "updates card",
  "card update",
  "replace card",
]);

/** Subject rung for updates: "Update: <title>" / "Update - <title>". The
 * separator is REQUIRED so a card legitimately named "Update Broadcaster"
 * never matches. Run against titleFromSubject output at the call site. */
export const UPDATE_SUBJECT_RE = /^updates?\s*(?::|\s[-·]\s)\s*(.+)$/i;

/** WEAK name labels (2026-07-31 owner directive: a human wrote "Name: Patching
 * Visualizer" with no subject line and got a form-validation lecture). These
 * never lift a line out of the blurb and never set ParsedBody.title; they only
 * emit a CANDIDATE, which must then be corroborated by the package's own
 * declared name or confirmed by a brain call before it can title a card. That
 * indirection is what lets bare "Name:" be useful without reinstating the
 * contact-block bug TITLE_LABELS still guards against. */
const NAME_LABELS = new Set(["name", "skill", "tool", "called", "app", "script"]);

/** Labels whose presence near a line marks the neighborhood as a contact or
 * signature block rather than a description of a tool. Used two ways: to
 * suppress a weak name candidate, and to suppress a BARE "Title:" strong
 * directive (the signature job-title bug: with no directive above it,
 * "Title: Senior Systems Engineer" in an uncut signature titled the card). */
const CONTACT_BLOCK_LABELS = new Set([
  "email",
  "e mail",
  "phone",
  "mobile",
  "cell",
  "tel",
  "telephone",
  "company",
  "title",
  "role",
  "position",
  "department",
  "dept",
  "office",
  "direct",
  "fax",
  "address",
  "website",
  "web",
  "linkedin",
  "slack",
  "ext",
  "extension",
]);

const SALUTATIONS = new Set([
  "hi",
  "hey",
  "hello",
  "good morning",
  "good afternoon",
  "good evening",
  "thanks",
  "thank you",
  "thanks again",
  "regards",
  "best",
  "best regards",
  "kind regards",
  "cheers",
  "sincerely",
  "team",
  "all",
  "folks",
  "everyone",
  "tron",
]);

/** A short greeting line ("Hi Tron,"). Candidate position rules allow these to
 * precede a name, because requiring the name to be the literal first line was
 * defeated by an ordinary greeting (panel critic finding 2026-07-31). */
export function isSalutationLine(line: string): boolean {
  const s = line
    .replace(/[,:!]+\s*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!s || s.split(" ").length > 5) return false;
  const words = s.split(" ");
  return SALUTATIONS.has(words[0]) || SALUTATIONS.has(words.slice(0, 2).join(" "));
}

/** Shape gate for anything that wants to become a card title without an
 * author saying so. REJECT-ONLY by house rule (see stripKindPrefix): a value
 * that fails is dropped, never rewritten into passing, because a silent
 * rewrite is a rename and renaming is admin-only. */
export function looksLikeAWorkName(v: string): boolean {
  const s = v.trim();
  if (s.length < WORK_CAPS.titleMinChars || s.length > WORK_CAPS.titleMaxChars)
    return false;
  if (/["`<>{}|\\@]/.test(s)) return false;
  if (/https?:/i.test(s) || /\bwww\./i.test(s)) return false;
  if (/[.!?,;:]$/.test(s)) return false;
  if (s.split(/\s+/).length > 6) return false;
  if (/\d{3,}/.test(s)) return false;
  if (!/\p{L}/u.test(s)) return false;
  if (TITLE_KIND_PREFIX_RE.test(s)) return false;
  if (isSalutationLine(s)) return false;
  // A package slug is a filename, not a card title.
  if (SLUG_SHAPE_RE.test(s)) return false;
  // A machine-name echo ("Outage Checker (outage-checker)") is the name
  // stated twice. REJECT here rather than strip (house rule above): the
  // dropped candidate falls to the brain rung, where grounding still lets
  // the model select the clean head from the submitter's own text.
  if (splitMachineEcho(s)) return false;
  return true;
}

/** Hostile characters for card titles: would break out of the quoting in a
 * downstream prompt or read as markup. Rejected (authored) or stripped
 * (subject-derived) BEFORE the title reaches panel.ts, which additionally
 * JSON-quotes it at every interpolation site. Apostrophes are legal:
 * "Tech's Helper" is a real title. */
export const HOSTILE_TITLE_CHARS = /["`<>{}|\\]/;
const HOSTILE_TITLE_CHARS_G = /["`<>{}|\\]/g;

/** The FULL subject-to-title chain, extracted so tests can pin the ORDER
 * (2026-07-31 lesson at the call site: hostile characters come out BEFORE
 * the kind-prefix strip, or a quoted subject re-exposes a category prefix
 * after a panel run was already spent; whitespace is recollapsed last). The
 * kind-prefix and machine-echo strips interleave to a fixpoint: "Skill:
 * Outage Checker (outage-checker)" needs the prefix gone before the echo
 * comparison can see the true head. echoStripped reports whether the echo
 * strip fired so the receipt can disclose the adaptation when the subject
 * wins the title. */
export function resolveSubjectTitle(subjectRaw: string): {
  title: string;
  echoStripped: boolean;
} {
  let s = titleFromSubject(subjectRaw).replace(HOSTILE_TITLE_CHARS_G, "");
  let echoStripped = false;
  for (let i = 0; i < 3; i++) {
    const kindStripped = stripKindPrefix(s);
    const next = stripMachineEcho(kindStripped);
    if (next !== kindStripped) echoStripped = true;
    if (next === s) break;
    s = next.trim();
  }
  return { title: s.replace(/\s+/g, " ").trim(), echoStripped };
}

/** Identity tokens for the SENDER, so a weak candidate that is just the
 * submitter's own name (the classic "Name: Jane Doe" contact block) can be
 * dropped. Display name plus the address local part, split and lowercased. */
export function senderIdentityTokens(
  fromRaw: string,
  senderAddress: string
): Set<string> {
  const display = fromRaw.split("<")[0] ?? "";
  const local = (senderAddress.split("@")[0] ?? "").replace(/[._-]+/g, " ");
  const out = new Set<string>();
  for (const tok of nameKey(`${display} ${local}`).split(" "))
    if (tok.length >= 2) out.add(tok);
  return out;
}

/** True when every meaningful token of the value belongs to the sender's own
 * identity ("Adam Radulovic", "Radulovic Adam", "Adam"), false for a real tool
 * name. Deliberately NOT a person-name shape test: "Patching Visualizer" and
 * "Jane Doe" are the same shape class, and a first-name gazetteer would fail
 * on non-Anglo names. */
export function isSenderIdentity(value: string, tokens: Set<string>): boolean {
  const parts = nameKey(value)
    .split(" ")
    .filter((t) => t.length >= 2);
  if (parts.length === 0) return false;
  return parts.every((t) => tokens.has(t));
}

/** Names the submitted DOCUMENT declares about itself, used to corroborate a
 * weak candidate at zero cost. ANCHORED on purpose: the front-matter scan is
 * bounded to the leading "---" block and matches "name:" at column 0 only, so
 * a nested "author:\n  name: Jane Doe" never corroborates a person (panel
 * critic finding 2026-07-31). */
export function docDeclaredNames(docText: string): string[] {
  const out: string[] = [];
  if (/^---\r?\n/.test(docText)) {
    const rest = docText.slice(docText.indexOf("\n") + 1);
    const end = rest.search(/^---\s*$/m);
    const front = end === -1 ? rest.slice(0, 4000) : rest.slice(0, end);
    const m = /^name:[ \t]*(.+)$/m.exec(front);
    if (m) out.push(m[1].trim());
  }
  const h1 = /^#[ \t]+(.+)$/m.exec(docText);
  if (h1) out.push(h1[1].trim());
  return out.filter(Boolean);
}

/** Names the PACKAGE declares: the archive filename minus its extension, plus
 * the sole top-level directory when the archive has exactly one. Corroborators
 * only, never candidates: 8.3 truncation ("SD-DAI~1.SKI") makes filenames
 * lossy. */
export function archiveDeclaredNames(
  packageName: string,
  manifestPaths: string[]
): string[] {
  const out: string[] = [packageName.replace(ARCHIVE_RE, "")];
  const tops = new Set(
    manifestPaths
      .map((p) => p.split("!/").pop() ?? p)
      .map((p) => p.split("/")[0])
      .filter((p) => p && !p.includes("."))
  );
  if (tops.size === 1) out.push([...tops][0]);
  return out.filter(Boolean);
}

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
/** Normalized directive label for one line, or null when the line is prose. */
function labelOf(line: string): string | null {
  const m = DIRECTIVE_RE.exec(line);
  if (!m) return null;
  return m[1]
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function parseSubmissionBody(raw: string): ParsedBody {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  // The cut is computed FIRST (it used to be a break inside the field loop):
  // candidate extraction needs to look ahead at following lines, and every
  // lookahead must stop at the same quoted-history/signature boundary the
  // blurb stops at.
  let cut = lines.length;
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
    ) {
      cut = i;
      break;
    }
  }
  const region = lines.slice(0, cut);
  /** Indices of the nearest n non-empty lines after i, within the region. */
  const nextNonEmpty = (i: number, n: number): string[] => {
    const out: string[] = [];
    for (let j = i + 1; j < region.length && out.length < n; j++)
      if (region[j].trim()) out.push(region[j]);
    return out;
  };
  const prevNonEmpty = (i: number, n: number): string[] => {
    const out: string[] = [];
    for (let j = i - 1; j >= 0 && out.length < n; j--)
      if (region[j].trim()) out.push(region[j]);
    return out;
  };
  /** True when a labelled contact line sits within the nearest 2 non-empty
   * lines either side. Window of 2, not 4: contact-block labels are adjacent
   * ("Name:/Title:/Email:" on consecutive lines), while 4 reached past an
   * ordinary one-paragraph blurb into the sender's signature and suppressed
   * legitimate directives (verification finding 2026-07-31). */
  const nearContactLabel = (i: number): boolean =>
    [...prevNonEmpty(i, 2), ...nextNonEmpty(i, 2)].some((near) => {
      const l = labelOf(near);
      return !!l && CONTACT_BLOCK_LABELS.has(l);
    });
  /** A bare 2-3 word Title-Case line with no colon directly above a "Title:"
   * is a person's name in a signature ("Thanks,\nJohn Smith\nTitle: ..."). It
   * only counts as one when a sign-off precedes that name, or when the
   * directive is in the trailing block of the message: without those, the
   * shape also matches an ordinary header line ("New Work Submission") above
   * a legitimate title (verification finding 2026-07-31). */
  const underSignatureName = (i: number): boolean => {
    const [before, beforeThat] = prevNonEmpty(i, 2);
    if (
      !before ||
      labelOf(before) !== null ||
      isSalutationLine(before) ||
      !/^\s*(?:[A-Z][\p{L}'-]*\s+){1,2}[A-Z][\p{L}'-]*\s*$/u.test(before)
    )
      return false;
    if (beforeThat && isSalutationLine(beforeThat)) return true;
    // No sign-off above: fall back to "nothing but signature-shaped lines
    // follow". Counting the remaining lines was not enough, because a short
    // legitimate body also has few lines after its title (verification
    // round); what separates a signature is that no PROSE follows it.
    const isProse = (l: string): boolean =>
      l.trim().split(/\s+/).length >= 6 || /[.!?]$/.test(l.trim());
    return !nextNonEmpty(i, 6).some(isProse);
  };
  const kept: string[] = [];
  const titleCandidates: ParsedBody["titleCandidates"] = [];
  let sawContentLine = false;
  let salutationsSeen = 0;
  /** True while nothing but greetings has been kept, so a name line at the
   * top of the message is still in "heading" position. Requiring the literal
   * first line was defeated by "Hi Tron," (panel critic finding). */
  const inHeadingPosition = (): boolean => !sawContentLine && salutationsSeen <= 2;
  let title: string | null = null;
  let kind: WorkKind | null = null;
  let kindRaw: string | null = null;
  let kindInferred: string | null = null;
  let credit: string | null = null;
  let creditIgnored: string | null = null;
  let updateTarget: string | null = null;
  for (let i = 0; i < region.length; i++) {
    const line = region[i];
    const directive = DIRECTIVE_RE.exec(line);
    if (directive) {
      const label = directive[1]
        .replace(/\u00A0/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      const value = directiveValue(directive[2]).trim();
      if (label === "kind") {
        // Exact vocabulary lifts the line out of the blurb (the sender used
        // the documented form). A fuzzy match is honored but DISCLOSED and
        // the authored line stays in the blurb; anything else stays too and
        // the attachments decide (2026-08-03 natural-email round: the old
        // behavior hard-rejected any unrecognized value). An empty value is
        // a dangling label, dropped silently (the Update Card: rule).
        if (!value) continue;
        const mapped = KIND_VALUES[value.toLowerCase().replace(/\.$/, "")] ?? null;
        if (mapped) {
          kind = mapped;
          continue;
        }
        const fuzzy = fuzzyKind(value);
        if (fuzzy) {
          kind = fuzzy;
          kindInferred = value.slice(0, 60);
        } else {
          kindRaw = value.slice(0, 60);
        }
        // falls through: the authored line stays in the blurb
      }
      if (label === "credit") {
        // Only accept-shaped values lift (see CREDIT_RE); prose stays in
        // the blurb with a receipt note instead of bouncing the submission.
        if (!value) continue;
        if (CREDIT_RE.test(value)) {
          credit = value;
          continue;
        }
        creditIgnored = value.slice(0, 60);
        // falls through: the authored line stays in the blurb
      }
      if (UPDATE_LABELS.has(label)) {
        // FIRST match wins (the Title: rule); an empty value stays prose so
        // a dangling "Update Card:" label never claims the submission.
        if (value && updateTarget === null) updateTarget = value.slice(0, 200);
        continue;
      }
      if (TITLE_LABELS.has(label)) {
        // A BARE "Title:" inside a contact or signature block is a job
        // title, not a card title. With no directive above it, "Title:
        // Senior Systems Engineer" in an uncut signature titled the card
        // (panel critic finding 2026-07-31, confirmed against the parser).
        // NEVER suppressed in heading position: a job title does not open an
        // email, and noTitleMessage teaches "Title:" as THE way to be
        // certain of the name, so suppressing it at the top of a body would
        // defeat the escape hatch this same change advertises (verification
        // finding). The unambiguous labels ("Skill Name:", "Card Title:",
        // ...) are never suppressed at all; a suppressed line stays in the
        // blurb as prose.
        if (
          label === "title" &&
          !inHeadingPosition() &&
          (nearContactLabel(i) || underSignatureName(i))
        ) {
          kept.push(line);
          sawContentLine = true;
          continue;
        }
        // FIRST match wins (unlike Kind/Credit): a signature job-title
        // line ("Title: Senior Systems Engineer") late in the body must
        // not silently beat an explicit "Skill Name:" line above it
        // (panel critic finding 2026-07-31). An empty value ("Title:"
        // alone) is ignored so the subject stays authoritative rather
        // than failing length validation on "".
        if (value && title === null) title = value.slice(0, 200);
        continue;
      }
      if (
        NAME_LABELS.has(label) &&
        value &&
        inHeadingPosition() &&
        !titleCandidates.some((c) => c.source === "name-line") &&
        !nearContactLabel(i) &&
        looksLikeAWorkName(value)
      )
        titleCandidates.push({ value, source: "name-line" });
      // Unrecognized label: ordinary prose, stays in the blurb. A weak name
      // line ALSO stays in the blurb (it is never lifted), so the blurb the
      // length gate measures is the blurb that gets stored.
    }
    if (
      labelOf(line) === null &&
      line.trim() &&
      inHeadingPosition() &&
      !isSalutationLine(line) &&
      !titleCandidates.some((c) => c.source === "first-line") &&
      // A heading is followed by a blank line and then more message.
      region[i + 1] !== undefined &&
      !region[i + 1].trim() &&
      nextNonEmpty(i, 1).length === 1 &&
      looksLikeAWorkName(line.trim())
    )
      titleCandidates.push({ value: line.trim(), source: "first-line" });
    if (line.trim()) {
      if (isSalutationLine(line)) salutationsSeen++;
      else sawContentLine = true;
    }
    kept.push(line);
  }
  const blurb = kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    blurb,
    title,
    kind,
    kindRaw,
    kindInferred,
    credit,
    creditIgnored,
    updateTarget,
    titleCandidates,
  };
}

/** §5.16 natural-email round: pick the Skill's document among several .md
 * attachments deterministically. One attachment: that one. Several with
 * exactly one named SKILL.md (any case): that one, with a receipt note
 * (deterministic selection is not authoring). Anything else is ambiguous
 * and the caller rejects with the file list. */
export function pickSkillDoc(
  mds: AttachmentMeta[]
): { pick: AttachmentMeta; noted: boolean } | null {
  if (mds.length === 1) return { pick: mds[0], noted: false };
  const exact = mds.filter((m) => /^skill\.md$/i.test(m.filename ?? ""));
  if (exact.length === 1) return { pick: exact[0], noted: true };
  return null;
}

export type InferredTitleCheck =
  | { ok: true; title: string }
  | { ok: false; reason: string };

/** The gate EVERY non-authored title must clear, whether it came from the
 * package-corroborated rung or from the model. Shared on purpose: the
 * corroborated rung once skipped it, so a candidate carrying an en dash (Word
 * and Outlook autocorrect " - " into " – " by default) still corroborated
 * against the package slug, since nameKey collapses punctuation on both
 * sides. It reached the card, failed the publish lint, and the repair prompt
 * then let the MODEL rename it, which is exactly what "renaming is
 * admin-only" forbids (verification finding 2026-07-31).
 *
 * sanitizeHeaderValue also runs here rather than only on the model path: it
 * collapses the exotic line terminators (U+2028/U+2029) that JSON.stringify
 * leaves unescaped downstream. Nothing here ever truncates or rewrites into
 * passing: truncation is a silent rename. */
export function validateWeakTitle(
  raw: string,
  senderTokens: Set<string>
): InferredTitleCheck {
  const t = sanitizeHeaderValue(raw, 200)
    .trim()
    .replace(/^["'`*_]+/, "")
    .replace(/["'`*_]+$/, "")
    .replace(/\.$/, "")
    .trim();
  if (!looksLikeAWorkName(t)) return { ok: false, reason: "shape" };
  if (stringViolations("title", t).length > 0)
    return { ok: false, reason: "house_rules" };
  if (isSenderIdentity(t, senderTokens))
    return { ok: false, reason: "sender_identity" };
  return { ok: true, title: t };
}

/** The gate a MODEL-PROPOSED title must clear: everything above, plus
 * grounding.
 *
 * The governing rule is that the model SELECTS, it never AUTHORS (owner
 * directive 2026-07-31: "figuring out what the name of the work might be, as I
 * included it"). Grounding is what enforces it: the answer has to be a span
 * the submitter typed, so the model can pick a name but can never mint one. A
 * model that cannot point at the human's own text returns nothing and the
 * submitter is asked.
 *
 * Precisely what is enforced: the match is on nameKey, which lowercases and
 * collapses punctuation, so the model may re-case or re-punctuate a name it
 * found ("patch-o-matic" may come back as "Patch O Matic"). It cannot
 * introduce a word the submitter never wrote, which is the property that
 * matters. The padding on both sides keeps a partial word from matching
 * ("Visual" must not ground against "Patching Visualizer"). */
export function validateInferredTitle(
  raw: string,
  opts: { sourceText: string; senderTokens: Set<string> }
): InferredTitleCheck {
  const base = validateWeakTitle(raw, opts.senderTokens);
  if (!base.ok) return base;
  const hay = ` ${nameKey(opts.sourceText)} `;
  if (!hay.includes(` ${nameKey(base.title)} `))
    return { ok: false, reason: "ungrounded" };
  return base;
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
