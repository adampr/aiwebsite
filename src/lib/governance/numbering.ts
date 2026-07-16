// Host-owned document numbering (§5.12). Drafting edits one section at a
// time with the rest of the draft elided, so the model can never keep manual
// numbers consistent across sections; the host numbers instead. Both
// renderers (the React doc pane and the .docx generator) run this pass on
// parseMarkdown output, so web and Word stay identical, and normalizing at
// render time means stored documents with drifted manual numbers clean up
// without regeneration. Client-safe: no node imports; bounded quantifiers.

import type { Block, Inline } from "./markdown";

// Unambiguous manual section-number prefixes only: "3. Title", "3) Title",
// "3.1 Title", "1.2.3. Title". A dotted multipart number, or a short number
// with a "." / ")" separator, followed by a letter or an opening quote,
// bracket, or paren ('3.1 "Quoted"', "3.1 [TO CONFIRM: ...]"). "30 days
// notice" (no separator) and "2026 Budget" (four digits, no separator)
// never match: the separator requirement guards those, not the lookahead.
const NUM_PREFIX =
  /^(?:\d{1,3}(?:\.\d{1,3}){1,4}\.?|\d{1,3}[.)])\s{1,10}(?=["'([A-Za-z])/;

// Same number shapes when they are an entire inline node ("3.1 **Scope**"
// parses as text "3.1 " + bold "Scope": the letter lookahead above can never
// see across nodes, so a whole-node number is matched separately).
const NUM_ONLY = /^(?:\d{1,3}(?:\.\d{1,3}){1,4}\.?|\d{1,3}[.)])\s{0,10}$/;

/** Strip a manual section-number prefix from a title or heading line. */
export function stripLeadingNumber(text: string): string {
  return text.replace(NUM_PREFIX, "");
}

/** Section title as rendered in both panes: "3. Data handling". */
export function sectionTitleText(num: number, title: string): string {
  return `${num}. ${stripLeadingNumber(title.trim())}`;
}

function stripInlineNumber(inline: Inline[]): Inline[] {
  const first = inline[0];
  if (!first) return inline;
  if (inline.length > 1 && NUM_ONLY.test(first.text)) return inline.slice(1);
  const stripped = stripLeadingNumber(first.text);
  if (stripped === first.text) return inline;
  if (!stripped) return inline.slice(1);
  return [{ ...first, text: stripped }, ...inline.slice(1)];
}

/**
 * Normalize one section's blocks under its host-assigned number:
 * - strip manual number prefixes from headings,
 * - number the top two inner heading levels ("3.1", "3.1.1"; deeper levels
 *   stay unnumbered),
 * - rebase heading depth to the shallowest level used in the section, so a
 *   section written entirely in "###" renders exactly like one in "#".
 * Levels in the result are relative: 1 = first level under the section
 * title. Renderers map them below the section-title style.
 */
export function normalizeSectionBlocks(
  blocks: Block[],
  sectionNum: number
): Block[] {
  let min = Infinity;
  for (const b of blocks) if (b.t === "heading" && b.level < min) min = b.level;
  let c1 = 0;
  let c2 = 0;
  return blocks.map((b): Block => {
    if (b.t !== "heading") return b;
    const depth = b.level - min;
    const inline = stripInlineNumber(b.inline);
    let label = "";
    if (depth === 0) {
      c1++;
      c2 = 0;
      label = `${sectionNum}.${c1} `;
    } else if (depth === 1 && c1 > 0) {
      c2++;
      label = `${sectionNum}.${c1}.${c2} `;
    }
    return {
      t: "heading",
      level: (Math.min(depth, 3) + 1) as 1 | 2 | 3 | 4,
      inline: label ? [{ t: "text", text: label }, ...inline] : inline,
    };
  });
}
