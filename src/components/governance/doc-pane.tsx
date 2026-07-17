"use client";

// The live document pane: doc tabs (horizontally scrollable strip, critique
// S11), section rendering via the shared governance markdown parser (never a
// markdown dependency), per-turn CYAN change highlights (critique S1), and
// the "Updated just now" change summary with jump links. The pane never
// blanks during updates; it always renders the last committed documents.

import { useMemo } from "react";
import type { GovernanceDoc, ProjectStatus } from "@/lib/governance/types";
import {
  parseMarkdown,
  splitConfirmRuns,
  type Block,
  type Inline,
} from "@/lib/governance/markdown";
import type { ResolvedMarkerReveal } from "@/lib/governance/resolved-anim";
import {
  normalizeSectionBlocks,
  sectionTitleText,
} from "@/lib/governance/numbering";
import { fmtDate } from "./shared";

const faint = { color: "var(--xl-text-faint)" } as const;
const dim = { color: "var(--xl-text-dim)" } as const;

export function secDomId(doc: string, section: string): string {
  return `gov-sec-${doc}--${section}`;
}

export interface ChangedRef {
  doc: string;
  section: string;
  title: string;
}

/** The resolution reveal in progress (§5.12, owner request 2026-07-17):
 *  one resolved item plays at a time: the old marker struck out, then the
 *  replacement typing itself out, then a beat: over the COMMITTED markdown
 *  (the theater is only progressive disclosure, never synthesized text). */
export interface RevealState {
  item: ResolvedMarkerReveal;
  // "hold" = typing finished, the 1 s rest with a BLINKING caret (the
  // strongest just-live-edited cue); typing itself shows a steady caret
  // (a moving caret does not blink).
  mode: "old" | "typing" | "hold";
  chars: number; // typing: how much of the replacement is shown
}

/* Private-use sentinels injected into a section's markdown BEFORE parsing so
 * inline styling can span emphasis boundaries: the render walks them as
 * style toggles. They never occur in real content; we inject render-side
 * only. */
const R_ON = "\uE000"; // persistent resolved wash on
const R_OFF = "\uE001"; // off
const OLD_ON = "\uE002"; // old-marker strike on
const OLD_OFF = "\uE003"; // off
const CARET = "\uE004"; // blinking caret (the hold beat)
const CARET_STEADY = "\uE005"; // steady caret (while typing)

const SENTINEL_RE = /[\uE000-\uE005]/;

/** Inject reveal/resolved sentinels into committed section markdown.
 *  Edits apply in descending offset order so earlier spans stay valid. */
function decorateMarkdown(
  md: string,
  marks: ResolvedMarkerReveal[],
  reveal: RevealState | null
): string {
  type Edit = { start: number; end: number; text: string };
  const edits: Edit[] = [];
  for (const m of marks) {
    if (
      reveal &&
      reveal.item.nextStart === m.nextStart &&
      reveal.item.nextEnd === m.nextEnd
    )
      continue; // the active item renders below, not as a settled mark
    if (m.nextEnd > md.length) continue; // stale offsets: skip, never garble
    edits.push({
      start: m.nextStart,
      end: m.nextEnd,
      text: R_ON + md.slice(m.nextStart, m.nextEnd) + R_OFF,
    });
  }
  if (reveal && reveal.item.nextEnd <= md.length) {
    const { item, mode, chars } = reveal;
    const full = md.slice(item.nextStart, item.nextEnd);
    // Deletion-only items (empty span) never get a caret: a caret blinking
    // next to nothing where text just vanished is nonsense theater.
    edits.push({
      start: item.nextStart,
      end: item.nextEnd,
      text:
        mode === "old"
          ? OLD_ON + item.oldMarkerText + OLD_OFF
          : mode === "typing"
            ? R_ON + full.slice(0, chars) + (full ? CARET_STEADY : "") + R_OFF
            : R_ON + full + (full ? CARET : "") + R_OFF,
    });
  }
  edits.sort((a, b) => b.start - a.start);
  let out = md;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

/** Mutable per-render styling context: sentinel toggles persist across
 *  inline nodes (a revealed span may cross a bold boundary). Created fresh
 *  on every SectionBody render, so double-invoked renders stay correct. */
interface SpanCtx {
  resolved: boolean;
  old: boolean;
}

function styledText(text: string, ctx: SpanCtx, key: number) {
  // Always-on [TO CONFIRM] decoration rides the same pass: warn-colored
  // marks, quiet (no wash) so a marker-dense draft does not read as broken.
  if (!SENTINEL_RE.test(text)) {
    if (ctx.old || ctx.resolved)
      return (
        <span key={key} className={ctx.old ? "doc-resolve-old" : "doc-resolved"}>
          {text}
        </span>
      );
    const runs = splitConfirmRuns(text);
    if (runs.length === 1 && !runs[0].confirm)
      return <span key={key}>{text}</span>;
    return (
      <span key={key}>
        {runs.map((r, i) =>
          r.confirm ? (
            <mark key={i} className="doc-confirm">
              {r.text}
            </mark>
          ) : (
            <span key={i}>{r.text}</span>
          )
        )}
      </span>
    );
  }
  const parts: React.ReactNode[] = [];
  let buf = "";
  const flush = () => {
    if (!buf) return;
    parts.push(styledText(buf, { ...ctx }, parts.length));
    buf = "";
  };
  for (const ch of text) {
    if (ch === R_ON || ch === R_OFF || ch === OLD_ON || ch === OLD_OFF) {
      flush();
      ctx.resolved = ch === R_ON ? true : ch === R_OFF ? false : ctx.resolved;
      ctx.old = ch === OLD_ON ? true : ch === OLD_OFF ? false : ctx.old;
    } else if (ch === CARET || ch === CARET_STEADY) {
      flush();
      parts.push(
        <span
          key={parts.length}
          className={
            ch === CARET_STEADY
              ? "doc-reveal-caret doc-reveal-caret--steady"
              : "doc-reveal-caret"
          }
        />
      );
    } else buf += ch;
  }
  flush();
  return <span key={key}>{parts}</span>;
}

function InlineSpans({ nodes, ctx }: { nodes: Inline[]; ctx?: SpanCtx }) {
  const c = ctx ?? { resolved: false, old: false };
  return (
    <>
      {nodes.map((n, i) => {
        if (n.t === "bold")
          return <strong key={i}>{styledText(n.text, c, 0)}</strong>;
        if (n.t === "italic")
          return <em key={i}>{styledText(n.text, c, 0)}</em>;
        if (n.t === "code") return <code key={i}>{n.text}</code>;
        if (n.t === "link")
          return (
            <a key={i} href={n.href} target="_blank" rel="noopener noreferrer">
              {n.text}
            </a>
          );
        return styledText(n.text, c, i);
      })}
    </>
  );
}

function BlockView({ block }: { block: Block }) {
  if (block.t === "heading") {
    // Section titles are h3; normalized inner headings demote below them
    // with a visible scale (doc-h4 > doc-h5 > doc-h6 > doc-h7), one class
    // per level so web keeps the same ordering Word does (Heading2..5).
    const Tag = `h${Math.min(block.level + 3, 6)}` as "h4" | "h5" | "h6";
    const cls =
      block.level === 1
        ? "doc-h4"
        : block.level === 2
          ? "doc-h5"
          : block.level === 3
            ? "doc-h6"
            : "doc-h7";
    return (
      <Tag className={`doc-h ${cls} mt-5`}>
        <InlineSpans nodes={block.inline} />
      </Tag>
    );
  }
  if (block.t === "paragraph") {
    return (
      <p className="mt-3 max-w-none text-sm">
        <InlineSpans nodes={block.inline} />
      </p>
    );
  }
  if (block.t === "list") {
    const items = block.items.map((it, i) => (
      <li key={i} className="text-sm" style={dim}>
        <InlineSpans nodes={it} />
      </li>
    ));
    return block.ordered ? (
      <ol className="mt-3 list-decimal space-y-1 pl-5">{items}</ol>
    ) : (
      <ul className="mt-3 list-disc space-y-1 pl-5">{items}</ul>
    );
  }
  // table: wide content scrolls inside its own container
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="table">
        <thead>
          <tr>
            {block.header.map((c, i) => (
              <th key={i}>
                <InlineSpans nodes={c} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, ri) => (
            <tr key={ri}>
              {row.map((c, ci) => (
                <td key={ci}>
                  <InlineSpans nodes={c} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SectionBody({
  markdown,
  num,
  marks,
  reveal,
}: {
  markdown: string;
  num: number;
  marks?: ResolvedMarkerReveal[];
  reveal?: RevealState | null;
}) {
  const blocks = useMemo(
    () =>
      normalizeSectionBlocks(
        parseMarkdown(
          marks?.length || reveal
            ? decorateMarkdown(markdown, marks ?? [], reveal ?? null)
            : markdown
        ),
        num
      ),
    // Keyed on the reveal's PRIMITIVES, not object identity: the show
    // creates a fresh RevealState every 60ms tick, and only the section
    // being revealed may re-parse per tick. `marks` arrays come from the
    // parent's memoized per-section map, so idle marked sections hold too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [markdown, num, marks, reveal?.item, reveal?.mode, reveal?.chars]
  );
  return (
    <>
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} />
      ))}
    </>
  );
}

export function DocPane({
  documents,
  activeDoc,
  onSelectDoc,
  highlights,
  asking,
  placeholders,
  flashKey,
  changedNow,
  onJump,
  status,
  deletesAt,
  resolvedMarks,
  reveal,
  showStatus,
  showNote,
}: {
  documents: GovernanceDoc[];
  activeDoc: string | null;
  onSelectDoc: (slug: string) => void;
  highlights: Record<string, string[]>;
  /** docSlug -> [sectionId] the ACTIVE question is about (owner fix #3). */
  asking: Record<string, string[]>;
  /** docSlug -> [sectionId] still holding scaffold text (server-computed;
   *  stub docs are never in it). Rendered as Planned, never as content. */
  placeholders: Record<string, string[]>;
  flashKey: number;
  changedNow: ChangedRef[] | null;
  onJump: (doc: string, section: string, focus: boolean) => void;
  status: ProjectStatus;
  deletesAt: string;
  /** Settled resolved-marker spans: persistent cyan wash until next turn. */
  resolvedMarks?: ResolvedMarkerReveal[];
  /** The one resolution reveal currently playing, if any. */
  reveal?: RevealState | null;
  /** Progress + skip control for the reveal sequence. */
  showStatus?: { index: number; total: number; onSkip: () => void } | null;
  /** Honest overflow line after a capped reveal run. */
  showNote?: string | null;
}) {
  const doc =
    documents.find((d) => d.slug === activeDoc) ?? documents[0] ?? null;

  // Stable per-section mark arrays: a fresh .filter() per render defeats
  // SectionBody's parse memo for every marked section on every reveal tick
  // (up to ~60 ticks/item since the per-char pacing).
  const marksBySection = useMemo(() => {
    const m = new Map<string, ResolvedMarkerReveal[]>();
    for (const r of resolvedMarks ?? []) {
      const k = `${r.doc}#${r.section}`;
      const arr = m.get(k);
      if (arr) arr.push(r);
      else m.set(k, [r]);
    }
    return m;
  }, [resolvedMarks]);

  const footer =
    status === "review"
      ? "Ready for your review"
      : status === "done"
        ? `Final · auto-deletes ${fmtDate(deletesAt)}`
        : `Draft · updates as you answer · auto-deletes ${fmtDate(deletesAt)}`;

  return (
    <section
      aria-label="Document draft. Updates as you answer."
      tabIndex={0}
      className="panel docpane min-w-0"
    >
      <h2 className="sr-only">The draft</h2>

      {documents.length > 1 ? (
        <div className="tabstrip" aria-label="Documents">
          {documents.map((d) => {
            const changed = (highlights[d.slug] ?? []).length > 0;
            return (
              <button
                key={d.slug}
                type="button"
                aria-pressed={doc?.slug === d.slug}
                aria-label={changed ? `${d.title}, updated` : undefined}
                onClick={() => onSelectDoc(d.slug)}
              >
                {d.title}
                {changed && (
                  <span
                    className="dot"
                    style={{ color: "var(--xl-light)" }}
                    aria-hidden="true"
                  />
                )}
              </button>
            );
          })}
        </div>
      ) : (
        doc && <span className="sys-label">{doc.title}</span>
      )}

      {changedNow && changedNow.length > 0 && (
        <p className="mt-4 text-sm">
          Updated just now:{" "}
          {changedNow.map((c, i) => (
            <span key={`${c.doc}:${c.section}`}>
              {i > 0 && ", "}
              <button
                type="button"
                className="linklike"
                onClick={() => onJump(c.doc, c.section, true)}
              >
                {documents.length > 1
                  ? `${documents.find((d) => d.slug === c.doc)?.title ?? c.doc} · ${c.title}`
                  : c.title}
              </button>
            </span>
          ))}
        </p>
      )}

      {showNote && (
        <p className="mt-2 max-w-none text-xs" style={faint}>
          {showNote}
        </p>
      )}

      {!doc && (
        <p className="mt-6 text-sm" style={dim}>
          No documents yet.
        </p>
      )}

      {doc && (
        <div className="mt-6 space-y-8">
          {doc.stub && (
            <p className="text-xs" style={faint}>
              {doc.sections.some((s) => s.id === "determination")
                ? "This document records a determination: it explains why these obligations do not apply."
                : "This document activates only if your answers show it applies. No determination has been recorded yet."}
            </p>
          )}
          {!doc.stub && (placeholders[doc.slug] ?? []).length > 0 && (
            <p className="text-xs" style={faint}>
              {status === "review"
                ? "Sections marked Planned are not drafted yet. Ask Tron in the revision box to draft them before you confirm."
                : status === "done"
                  ? "Sections marked Planned were not drafted in this project."
                  : "Sections marked Planned are drafted as the interview goes on."}
            </p>
          )}
          {doc.sections.map((s, si) => {
            const changed = (highlights[doc.slug] ?? []).includes(s.id);
            const asked = (asking[doc.slug] ?? []).includes(s.id);
            const planned = (placeholders[doc.slug] ?? []).includes(s.id);
            // undefined when a section has no marks; otherwise the STABLE
            // array from marksBySection, so the parse memo holds for every
            // section except the one actually revealing.
            const secMarks = marksBySection.get(`${doc.slug}#${s.id}`);
            const cls =
              [
                changed ? "doc-sec--changed doc-sec--flash" : "",
                asked ? "doc-sec--asking" : "",
                planned ? "doc-sec--planned" : "",
              ]
                .filter(Boolean)
                .join(" ") || undefined;
            return (
              <section
                key={changed ? `${s.id}-${flashKey}` : s.id}
                id={secDomId(doc.slug, s.id)}
                className={cls}
              >
                <h3 className="doc-h text-lg" tabIndex={-1} data-sec-heading>
                  {sectionTitleText(si + 1, s.title)}
                  {changed && <span className="doc-chip">Updated</span>}
                  {asked && (
                    <span className="doc-chip doc-chip--ask">
                      Asking about this
                    </span>
                  )}
                  {planned && (
                    <span className="doc-chip doc-chip--plan">Planned</span>
                  )}
                </h3>
                <SectionBody
                  markdown={s.markdown}
                  num={si + 1}
                  marks={secMarks}
                  reveal={
                    reveal &&
                    reveal.item.doc === doc.slug &&
                    reveal.item.section === s.id
                      ? reveal
                      : null
                  }
                />
              </section>
            );
          })}
        </div>
      )}

      {showStatus && (
        <div className="doc-show-bar">
          <span className="text-xs" style={dim}>
            Showing resolved items · {showStatus.index + 1} of{" "}
            {showStatus.total}
          </span>
          <button
            type="button"
            className="btn btn--text"
            onClick={showStatus.onSkip}
          >
            Skip the replay
          </button>
        </div>
      )}

      <p className="mono mt-8 text-xs" style={faint}>
        {footer}
      </p>
    </section>
  );
}
