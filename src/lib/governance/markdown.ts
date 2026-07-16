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
  const md = sanitizeMarkdown(raw);
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
  const re = /\[TO CONFIRM:?\s*([^\]]{0,160})\]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) out.push(m[1].trim() || "open item");
  return out;
}
