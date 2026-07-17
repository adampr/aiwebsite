// Minimal markdown model for governance documents (§5.12). The model emits
// section markdown; we parse it to a small block structure that both the live
// doc pane (React) and the .docx generator render from, so the two outputs
// can never disagree. Deliberately tiny: headings, paragraphs, lists, tables,
// bold/italic/code/links. Raw HTML is stripped as data, never parsed.
// Client-safe: no node imports.

export type Inline =
  | { t: "text"; text: string }
  | { t: "bold"; text: string }
  | { t: "italic"; text: string }
  | { t: "code"; text: string }
  | { t: "link"; text: string; href: string };

export type Block =
  | { t: "heading"; level: 1 | 2 | 3 | 4; inline: Inline[] }
  | { t: "paragraph"; inline: Inline[] }
  | { t: "list"; ordered: boolean; items: Inline[][] }
  | { t: "table"; header: Inline[][]; rows: Inline[][][] };

import { promoteManualHeadingLines } from "./numbering";

const SAFE_LINK = /^https?:\/\//i;

/** Strip raw HTML tags and normalize characters the site bans (em dashes). */
export function sanitizeMarkdown(md: string): string {
  return md
    .replace(/<[^>]{0,300}>/g, "") // raw HTML is never rendered
    .replace(/—/g, "-") // em dash: banned in visible copy
    .replace(/–/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/ /g, " ")
    .replace(/\r\n/g, "\n");
}

function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  // Order matters: links, then bold, then italic, then code.
  const re =
    /\[([^\]]{1,200})\]\(([^)\s]{1,500})\)|\*\*([^*]{1,300})\*\*|\*([^*]{1,300})\*|`([^`]{1,200})`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ t: "text", text: text.slice(last, m.index) });
    if (m[1] !== undefined && m[2] !== undefined) {
      // Links must be absolute http(s); anything else renders as plain text.
      if (SAFE_LINK.test(m[2])) out.push({ t: "link", text: m[1], href: m[2] });
      else out.push({ t: "text", text: m[1] });
    } else if (m[3] !== undefined) out.push({ t: "bold", text: m[3] });
    else if (m[4] !== undefined) out.push({ t: "italic", text: m[4] });
    else if (m[5] !== undefined) out.push({ t: "code", text: m[5] });
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ t: "text", text: text.slice(last) });
  return out.length ? out : [{ t: "text", text }];
}

function parseTableRow(line: string): Inline[][] {
  return line
    .replace(/^\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => parseInline(c.trim()));
}

const TABLE_DIVIDER = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;

/** Parse sanitized markdown into blocks. Never throws on odd input. */
export function parseMarkdown(raw: string): Block[] {
  // Manual-heading promotion runs pre-parse so a bare "3.1 Data handling"
  // line becomes a real heading instead of gluing into the paragraph above.
  // Hooked here (the only parse entry) so the doc pane and .docx can never
  // disagree. The reverse import is type-only in numbering.ts: no cycle.
  const md = promoteManualHeadingLines(sanitizeMarkdown(raw));
  const lines = md.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      i++;
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (h) {
      blocks.push({
        t: "heading",
        level: h[1].length as 1 | 2 | 3 | 4,
        inline: parseInline(h[2].trim()),
      });
      i++;
      continue;
    }
    // Table: a | row followed by a divider row.
    if (
      trimmed.startsWith("|") &&
      i + 1 < lines.length &&
      TABLE_DIVIDER.test(lines[i + 1].trim())
    ) {
      const header = parseTableRow(trimmed);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push(parseTableRow(lines[i].trim()));
        i++;
      }
      blocks.push({ t: "table", header, rows });
      continue;
    }
    // Lists (unordered and ordered), one level.
    const ul = /^[-*]\s+(.*)$/.exec(trimmed);
    const ol = /^\d{1,3}[.)]\s+(.*)$/.exec(trimmed);
    if (ul || ol) {
      const ordered = !!ol;
      const items: Inline[][] = [];
      while (i < lines.length) {
        const t = lines[i].trim();
        const mu = /^[-*]\s+(.*)$/.exec(t);
        const mo = /^\d{1,3}[.)]\s+(.*)$/.exec(t);
        const m = ordered ? mo : mu;
        if (!m) break;
        items.push(parseInline(m[1]));
        i++;
      }
      blocks.push({ t: "list", ordered, items });
      continue;
    }
    // Paragraph: consume until blank line or a structural line.
    const para: string[] = [trimmed];
    i++;
    while (i < lines.length) {
      const t = lines[i].trim();
      if (
        !t ||
        /^#{1,4}\s/.test(t) ||
        /^[-*]\s/.test(t) ||
        /^\d{1,3}[.)]\s/.test(t) ||
        t.startsWith("|")
      )
        break;
      para.push(t);
      i++;
    }
    blocks.push({ t: "paragraph", inline: parseInline(para.join(" ")) });
  }
  return blocks;
}

export function inlineToText(inline: Inline[]): string {
  return inline.map((x) => x.text).join("");
}

export function blocksToText(blocks: Block[]): string {
  return blocks
    .map((b) => {
      if (b.t === "heading" || b.t === "paragraph") return inlineToText(b.inline);
      if (b.t === "list") return b.items.map(inlineToText).join("\n");
      return [b.header, ...b.rows]
        .map((r) => r.map(inlineToText).join(" | "))
        .join("\n");
    })
    .join("\n\n");
}

/** Find [TO CONFIRM: ...] markers for the review panel's open-items list. */
export function findConfirmMarkers(markdown: string): string[] {
  const out: string[] = [];
  const re = confirmMarkerRe();
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) out.push(m[1].trim() || "open item");
  return out;
}

/* ------------------------------------------------------------------ *
 * [TO CONFIRM] marker resolution (§5.12). A FINAL draft must carry zero
 * markers, each resolved by the user: a typed fact (AI revise turn) or an
 * explicit keep-as-drafted (the deterministic strip below, zero AI calls).
 * ------------------------------------------------------------------ */

// 400 chars of innards is deliberately wider than any sane marker; the UI
// truncates for display. Malformed markers (unclosed bracket, oversized) are
// still COUNTED by countConfirmMarkers so the confirm gate can never pass a
// document that prints a marker the parser missed.
function confirmMarkerRe(): RegExp {
  return /\[TO CONFIRM:?\s*([^\]]{0,400})\]/gi;
}

/** Lenient marker count: every "[TO CONFIRM" opener, malformed or not.
 *  The confirm gate and all user-facing totals MUST use this count. */
export function countConfirmMarkers(markdown: string): number {
  return (markdown.match(/\[TO\s*CONFIRM/gi) ?? []).length;
}

/** Excerpt as transported to the client and echoed back to address a strip. */
export function confirmExcerpt(inner: string): string {
  return (inner.trim() || "open item").slice(0, 200);
}

export interface ScannedConfirmMarker {
  excerpt: string;
  occurrence: number; // 0-based among markers with the SAME excerpt
  contextBefore: string;
  contextAfter: string;
  confirmable: boolean;
}

/** Cut to `max` chars at a word boundary, from the marker outward. */
function windowBefore(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(s.length - max);
  const sp = cut.indexOf(" ");
  return "..." + (sp > 0 && sp < max / 2 ? cut.slice(sp + 1) : cut);
}
function windowAfter(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max / 2 ? cut.slice(0, sp) : cut) + "...";
}

/** The line containing the span [start,end) (list items and table rows are
 *  single lines; paragraph context beyond the line is not worth the payload). */
function lineAround(md: string, start: number, end: number) {
  const ls = md.lastIndexOf("\n", start - 1) + 1;
  const leRaw = md.indexOf("\n", end);
  const le = leRaw === -1 ? md.length : leRaw;
  return { ls, le };
}

/** Join the text around a removed marker, cleaning strip residue: doubled
 *  spaces at the seam, a space stranded before punctuation, and empty
 *  bracket/paren husks the removal created. */
function joinStripped(before: string, after: string): string {
  let b = before;
  let a = after;
  if (/\(\s*$/.test(b) && /^\s*\)/.test(a)) {
    b = b.replace(/\(\s*$/, "");
    a = a.replace(/^\s*\)/, "");
  }
  if (/[ \t]$/.test(b) && /^[ \t]/.test(a)) a = a.replace(/^[ \t]+/, "");
  if (/[ \t]$/.test(b) && /^[.,;:)\]]/.test(a)) b = b.replace(/[ \t]+$/, "");
  return b + a;
}

/** Would the marker's containing block still hold content after a strip?
 *  Scope: the table cell when the line is a | row, else the whole line minus
 *  list/heading markers. "Content" = at least one letter or digit. */
function stripLeavesContent(
  md: string,
  matchStart: number,
  matchEnd: number
): boolean {
  const { ls, le } = lineAround(md, matchStart, matchEnd);
  const line = md.slice(ls, le);
  const inLineStart = matchStart - ls;
  const inLineEnd = matchEnd - ls;
  let scopeStart = 0;
  let scopeEnd = line.length;
  if (line.trim().startsWith("|")) {
    const cellStart = line.lastIndexOf("|", inLineStart - 1);
    const cellEnd = line.indexOf("|", inLineEnd);
    scopeStart = cellStart === -1 ? 0 : cellStart + 1;
    scopeEnd = cellEnd === -1 ? line.length : cellEnd;
  }
  const rest = joinStripped(
    line.slice(scopeStart, inLineStart),
    line.slice(inLineEnd, scopeEnd)
  )
    // list/heading markers are structure, not content
    .replace(/^\s*(?:#{1,4}|[-*]|\d{1,3}[.)])\s*/, "");
  return /[a-z0-9]/i.test(rest);
}

/** ScannedConfirmMarker plus its character span in the section markdown.
 *  Kept as a SEPARATE type on purpose: view.ts spreads ScannedConfirmMarker
 *  into the public OpenConfirmItem API, and positions must not leak there. */
export interface PositionedConfirmMarker extends ScannedConfirmMarker {
  start: number;
  end: number;
}

/** Scan one section's markdown into addressable open items, with spans. */
export function scanConfirmMarkersWithPos(
  markdown: string
): PositionedConfirmMarker[] {
  const out: PositionedConfirmMarker[] = [];
  const counts = new Map<string, number>();
  const re = confirmMarkerRe();
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    const excerpt = confirmExcerpt(m[1]);
    const occurrence = counts.get(excerpt) ?? 0;
    counts.set(excerpt, occurrence + 1);
    const { ls, le } = lineAround(markdown, m.index, m.index + m[0].length);
    out.push({
      excerpt,
      occurrence,
      contextBefore: windowBefore(markdown.slice(ls, m.index), 110),
      contextAfter: windowAfter(markdown.slice(m.index + m[0].length, le), 110),
      confirmable: stripLeavesContent(markdown, m.index, m.index + m[0].length),
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return out;
}

/** Scan one section's markdown into addressable open items. Positions are
 *  deliberately dropped here (view.ts spreads these into the public API). */
export function scanConfirmMarkers(markdown: string): ScannedConfirmMarker[] {
  return scanConfirmMarkersWithPos(markdown).map((m) => ({
    excerpt: m.excerpt,
    occurrence: m.occurrence,
    contextBefore: m.contextBefore,
    contextAfter: m.contextAfter,
    confirmable: m.confirmable,
  }));
}

/** Split plain inline text into runs, marking [TO CONFIRM: ...] spans so the
 *  doc pane can style them (render-time only; the shared Inline model and
 *  the .docx renderer stay untouched). */
export function splitConfirmRuns(
  text: string
): { text: string; confirm: boolean }[] {
  const out: { text: string; confirm: boolean }[] = [];
  const re = confirmMarkerRe();
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), confirm: false });
    out.push({ text: m[0], confirm: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), confirm: false });
  return out.length ? out : [{ text, confirm: false }];
}

export type StripResult =
  | { ok: true; markdown: string }
  | { ok: false; reason: "not_found" | "needs_answer" };

/** Deterministically remove the `occurrence`-th marker whose excerpt matches,
 *  with residue cleanup. Refuses when the strip would leave the containing
 *  block empty (the marker is the content there; keep-as-drafted is a lie). */
export function stripConfirmMarker(
  markdown: string,
  excerpt: string,
  occurrence: number
): StripResult {
  const re = confirmMarkerRe();
  let seen = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    if (confirmExcerpt(m[1]) !== excerpt) continue;
    if (seen++ < occurrence) continue;
    const start = m.index;
    const end = m.index + m[0].length;
    if (!stripLeavesContent(markdown, start, end))
      return { ok: false, reason: "needs_answer" };
    const { ls, le } = lineAround(markdown, start, end);
    const newLine = joinStripped(
      markdown.slice(ls, start),
      markdown.slice(end, le)
    );
    return {
      ok: true,
      markdown: markdown.slice(0, ls) + newLine + markdown.slice(le),
    };
  }
  return { ok: false, reason: "not_found" };
}
