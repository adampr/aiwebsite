"use client";

// The live document pane: doc tabs (horizontally scrollable strip, critique
// S11), section rendering via the shared governance markdown parser (never a
// markdown dependency), per-turn CYAN change highlights (critique S1), and
// the "Updated just now" change summary with jump links. The pane never
// blanks during updates; it always renders the last committed documents.

import { Fragment, useMemo, useRef, useState, type CSSProperties } from "react";
import type { GovernanceDoc, ProjectStatus } from "@/lib/governance/types";
import {
  parseMarkdown,
  splitConfirmRuns,
  type Block,
  type Inline,
  type SubList,
} from "@/lib/governance/markdown";
import {
  isRegionItem,
  regionWashLines,
  type ResolvedMarkerReveal,
} from "@/lib/governance/resolved-anim";
import {
  normalizeSectionBlocks,
  sectionTitleText,
  type NumberingProfile,
  type NumberingStyle,
} from "@/lib/governance/numbering";
import {
  droppedOutlineTitles,
  outlineReconciled,
  planOutline,
} from "@/lib/governance/outline";
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
  // (a moving caret does not blink). "swap" = the reduced-motion variant:
  // full replacement at once, NO caret (a solid bar beside settled text
  // reads as an artifact when nothing typed). "region" = the guaranteed-
  // motion floor for unanchorable resolutions: the changed-line block
  // washes as one, nothing types, no caret, no strike (the show bar names
  // the removed marker instead).
  mode: "old" | "typing" | "hold" | "swap" | "region";
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
const RA_ON = "\uE006"; // ACTIVE region wash on (stronger than R_ON)
const RA_OFF = "\uE007"; // off

const SENTINEL_RE = /[\uE000-\uE007]/;

/** Inject reveal/resolved sentinels into committed section markdown.
 *  Edits apply in descending offset order so earlier spans stay valid. */
function decorateMarkdown(
  md: string,
  marks: ResolvedMarkerReveal[],
  reveal: RevealState | null
): string {
  type Edit = { start: number; end: number; text: string };
  // Active-item edits are built FIRST and always win overlaps: a settled
  // mark inside the active region must never displace the live beat.
  const active: Edit[] = [];
  if (reveal && reveal.item.nextEnd <= md.length) {
    const { item, mode, chars } = reveal;
    if (isRegionItem(item)) {
      // Region beat: wash the block's structure-safe lines; nothing types,
      // nothing strikes (the show bar names the removed marker). Table
      // rows inside the block stay bare; an all-table block leaves zero
      // edits and the section-level class carries the signal.
      for (const w of regionWashLines(md, item.nextStart, item.nextEnd))
        active.push({
          start: w.start,
          end: w.end,
          text: RA_ON + md.slice(w.start, w.end) + RA_OFF,
        });
    } else {
      const full = md.slice(item.nextStart, item.nextEnd);
      // Deletion-only items (empty span) never get a caret: a caret
      // blinking next to nothing where text just vanished is nonsense
      // theater.
      active.push({
        start: item.nextStart,
        end: item.nextEnd,
        text:
          mode === "old"
            ? OLD_ON + item.oldMarkerText + OLD_OFF
            : mode === "typing"
              ? R_ON + full.slice(0, chars) + (full ? CARET_STEADY : "") + R_OFF
              : mode === "swap"
                ? R_ON + full + R_OFF
                : R_ON + full + (full ? CARET : "") + R_OFF,
      });
    }
  }
  const edits: Edit[] = [...active];
  for (const m of marks) {
    // Regions never settle to a wash: the block-wide claim was already the
    // weakest honest beat, freezing it until next rev would over-assert
    // (the Updated treatment plus the cleared chip carry the record).
    if (isRegionItem(m)) continue;
    if (
      reveal &&
      reveal.item.nextStart === m.nextStart &&
      reveal.item.nextEnd === m.nextEnd
    )
      continue; // the active item renders above, not as a settled mark
    if (m.nextEnd > md.length) continue; // stale offsets: skip, never garble
    // Drop any settled mark that intersects a kept edit (the active beats
    // first, then earlier marks): overlapping injections would garble the
    // descending splice below.
    if (edits.some((e) => m.nextStart < e.end && m.nextEnd > e.start))
      continue;
    edits.push({
      start: m.nextStart,
      end: m.nextEnd,
      text: R_ON + md.slice(m.nextStart, m.nextEnd) + R_OFF,
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
  active: boolean; // live region wash (stronger than the settled resolved)
}

function styledText(text: string, ctx: SpanCtx, key: number) {
  // Always-on [TO CONFIRM] decoration rides the same pass: warn-colored
  // marks, quiet (no wash) so a marker-dense draft does not read as broken.
  if (!SENTINEL_RE.test(text)) {
    if (ctx.old || ctx.resolved || ctx.active)
      return (
        <span
          key={key}
          className={
            ctx.old
              ? "doc-resolve-old"
              : ctx.active
                ? "doc-resolved doc-resolved--active"
                : "doc-resolved"
          }
        >
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
    if (
      ch === R_ON ||
      ch === R_OFF ||
      ch === OLD_ON ||
      ch === OLD_OFF ||
      ch === RA_ON ||
      ch === RA_OFF
    ) {
      flush();
      ctx.resolved = ch === R_ON ? true : ch === R_OFF ? false : ctx.resolved;
      ctx.old = ch === OLD_ON ? true : ch === OLD_OFF ? false : ctx.old;
      ctx.active = ch === RA_ON ? true : ch === RA_OFF ? false : ctx.active;
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
  const c = ctx ?? { resolved: false, old: false, active: false };
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
    // Top margin steps down with depth, mirroring the .docx spacing ladder.
    return (
      <Tag className={`doc-h ${cls} ${block.level <= 2 ? "mt-5" : "mt-4"}`}>
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
    // Letter formats via inline listStyleType: the list-decimal utility
    // class sets CSS list-style-type, which silently overrides the HTML
    // `type` attribute - inline style is the only reliable override.
    // `start` keeps split ordered runs counting from their literal number.
    const letterStyle = (f?: string): CSSProperties =>
      f === "upperLetter"
        ? { ...dim, listStyleType: "upper-alpha" }
        : f === "lowerLetter"
          ? { ...dim, listStyleType: "lower-alpha" }
          : f === "lowerRoman"
            ? { ...dim, listStyleType: "lower-roman" }
            : f === "upperRoman"
              ? { ...dim, listStyleType: "upper-roman" }
              : dim;
    const renderSub = (sub: SubList | undefined) => {
      if (!sub) return null;
      const lis = sub.items.map((si, k) => (
        <li key={k} className="text-sm" style={dim}>
          <InlineSpans nodes={si} />
        </li>
      ));
      return sub.ordered ? (
        <ol
          className="mt-1 list-decimal space-y-1 pl-5"
          start={sub.start && sub.start > 1 ? sub.start : undefined}
          style={letterStyle(sub.format)}
        >
          {lis}
        </ol>
      ) : (
        <ul className="mt-1 list-disc space-y-1 pl-5">{lis}</ul>
      );
    };
    const items = block.items.map((it, i) => (
      <li key={i} className="text-sm" style={dim}>
        <InlineSpans nodes={it.inline} />
        {renderSub(it.sub)}
      </li>
    ));
    return block.ordered ? (
      <ol
        className="mt-3 list-decimal space-y-1 pl-5"
        start={block.start && block.start > 1 ? block.start : undefined}
        style={letterStyle(block.format)}
      >
        {items}
      </ol>
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
  numbering,
  profile,
  baseLabel,
  nested,
  marks,
  reveal,
}: {
  markdown: string;
  num: number;
  numbering: NumberingStyle | null;
  // Round 22: the sample's per-level scheme; null = flat style only.
  profile?: NumberingProfile | null;
  // Round 18b: nested sections hang their inner headings off the compound
  // label ("5.2" -> "5.2.1") instead of their flat ordinal.
  baseLabel?: string | null;
  // Round 22: nested sections index the profile one level deeper.
  nested?: boolean;
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
        num,
        numbering,
        baseLabel ?? null,
        profile ?? null,
        nested ? 1 : 0
      ),
    // Keyed on the reveal's PRIMITIVES, not object identity: the show
    // creates a fresh RevealState every 60ms tick, and only the section
    // being revealed may re-parse per tick. `marks` arrays come from the
    // parent's memoized per-section map, so idle marked sections hold too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [markdown, num, numbering, profile, baseLabel, nested, marks, reveal?.item, reveal?.mode, reveal?.chars]
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
  cleared,
  showStatus,
  showNote,
  numbering,
  profile,
  groupedOkDocs,
  sampleOutlineTitles,
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
  /** "slug#sectionId" -> markers resolved there this turn (count-delta
   *  proven at diff time). Drives the persistent cleared chip; cleared on
   *  the next rev alongside the marks. */
  cleared?: Record<string, number> | null;
  /** Progress + skip control for the reveal sequence. */
  showStatus?: { index: number; total: number; onSkip: () => void } | null;
  /** Honest overflow line after a capped reveal run. */
  showNote?: string | null;
  /** The format sample's detected numbering style (round 15b); null =
   *  decimal default. Applied to section titles and sub-heading labels. */
  numbering: NumberingStyle | null;
  /** Round 22: the sample's per-level numbering profile; null keeps the
   *  flat style's rendering exactly as today. */
  profile?: NumberingProfile | null;
  /** Round 18b: while a reformat run is active, docs NOT in this set render
   *  flat even if an adoption landed mid-run (no regrouping under the hold
   *  banner; the end receipt announces it). null = no run, adoptions render
   *  immediately. */
  groupedOkDocs?: ReadonlySet<string> | null;
  /** Round 18b: the sample's top-level outline titles (from the view) for
   *  the dropped-heading honesty note; null hides the note. */
  sampleOutlineTitles?: string[] | null;
}) {
  const doc =
    documents.find((d) => d.slug === activeDoc) ?? documents[0] ?? null;

  // Skeleton adoption (round 18b): with an adopted outline the pane renders
  // in PLAN order (bucket headings + nested sections); without one, rows are
  // the flat section list, byte-identical to the pre-18b pane. Every
  // existing section appears exactly once either way (planOutline invariant).
  type BucketRow = { kind: "bucket"; label: string; empty: boolean };
  type SecRow = {
    kind: "sec";
    s: NonNullable<typeof doc>["sections"][number];
    si: number;
    meta: {
      label: string;
      nested: boolean;
      base: string | null;
    } | null;
  };
  const renderRows = useMemo((): (BucketRow | SecRow)[] => {
    if (!doc) return [];
    const grouped = groupedOkDocs == null || groupedOkDocs.has(doc.slug);
    // Round 23: the sample's title sequence rides into the plan so sample
    // headings the outline left empty still render, at their positions.
    const plan = grouped
      ? planOutline(
          doc,
          numbering,
          profile ?? null,
          sampleOutlineTitles ?? null
        )
      : null;
    if (!plan)
      return doc.sections.map(
        (s, si): SecRow => ({ kind: "sec", s, si, meta: null })
      );
    const bySec = new Map(doc.sections.map((s, si) => [s.id, { s, si }]));
    const rows: (BucketRow | SecRow)[] = [];
    for (const e of plan) {
      if (e.sectionId === null) {
        // Bucket heading row: its own row now (round 23), so a bucket
        // with nothing under it still renders as an empty heading.
        rows.push({ kind: "bucket", label: e.label, empty: e.empty === true });
        continue;
      }
      const rec = bySec.get(e.sectionId);
      if (!rec) continue;
      rows.push({
        kind: "sec",
        s: rec.s,
        si: rec.si,
        meta: {
          label: e.label,
          nested: !e.top,
          base: e.innerBase,
        },
      });
    }
    return rows;
  }, [doc, numbering, profile, groupedOkDocs, sampleOutlineTitles]);

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

  // Round 18b honesty note, round 23 semantics, hoisted to doc level so it
  // renders in the editing-notes window (owner directive 2026-09-21) instead
  // of inside the document block: once dismissible it is no longer a note
  // that stands forever, it re-arms whenever flashKey moves (the
  // flashKey-keyed dismissal below), so "where did References go" is
  // always answered again on the next update. Renders ONLY while the adoption
  // left sample headings empty (post-23 reconcile) or dropped them (legacy
  // rows below the match threshold); clean adoptions say nothing (the
  // structure is its own receipt).
  const outlineNote = useMemo(() => {
    if (!doc?.outline?.length) return null;
    if (groupedOkDocs != null && !groupedOkDocs.has(doc.slug)) return null;
    // Round 23: the note derives from the PLAN, not the stored
    // outline - post-23 adoptions store every sample title, so
    // dropped-title math reads [] exactly when empty headings DO
    // render and need explaining. The legacy dropped-titles note
    // stays for rows where the reconcile is inactive (a replaced
    // sample below the match threshold): those titles truly do
    // not appear.
    const emptyLabels = renderRows
      .flatMap((r) => (r.kind === "bucket" && r.empty ? [r.label] : []))
      .slice(0, 12);
    const dropped =
      !emptyLabels.length &&
      sampleOutlineTitles?.length &&
      !outlineReconciled(doc, sampleOutlineTitles)
        ? droppedOutlineTitles(doc, sampleOutlineTitles)
        : [];
    if (!emptyLabels.length && !dropped.length) return null;
    return emptyLabels.length
      ? emptyLabels.length === 1
        ? `Grouped to match your format sample. Its "${emptyLabels[0]}" heading has no matching content here yet, so it appears as an empty heading.`
        : emptyLabels.length === 2
          ? `Grouped to match your format sample. Its "${emptyLabels[0]}" and "${emptyLabels[1]}" headings have no matching content here yet, so they appear as empty headings.`
          : `Grouped to match your format sample. ${emptyLabels.length} of its headings have no matching content here yet, so they appear as empty headings.`
      : dropped.length === 1
        ? `Grouped to match your format sample. Its "${dropped[0]}" heading has no matching content here, so it does not appear.`
        : dropped.length === 2
          ? `Grouped to match your format sample. Its "${dropped[0]}" and "${dropped[1]}" headings have no matching content here, so they do not appear.`
          : `Grouped to match your format sample. ${dropped.length} of its headings have no matching content here, so they do not appear.`;
  }, [doc, renderRows, sampleOutlineTitles, groupedOkDocs]);

  // Editing-notes window dismissal (owner directive 2026-09-21): the X hides
  // only the window; jump targets, chips and highlights are untouched.
  // Keyed to flashKey, never to the window's content: closing the editing
  // notes hides them until the next update. flashKey bumps on every
  // doc-updating turn, on keep, and on a cross-tab rev refresh, so a
  // dismissal lasts exactly until one of those; intra-turn content drift
  // (a doc-tab switch changing the outline note) can never resurrect a
  // dismissed window. changedNow may survive a keep by design, so the
  // re-armed window can name the prior turn's sections, matching the
  // pane's committed display behavior. Per-mount state, never persisted.
  const [dismissedFlash, setDismissedFlash] = useState<number | null>(null);
  const hasNotes =
    (changedNow?.length ?? 0) > 0 || !!showNote || !!outlineNote;
  // Dismissal moves focus to the pane section (tabIndex 0) so keyboard and
  // AT users are not dropped on <body> when the X unmounts under them.
  const paneRef = useRef<HTMLElement | null>(null);

  const footer =
    status === "review"
      ? "Ready for your review"
      : status === "done"
        ? `Final · auto-deletes ${fmtDate(deletesAt)}`
        : `Draft · updates as you answer · auto-deletes ${fmtDate(deletesAt)}`;

  return (
    <section
      ref={paneRef}
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

      {/* The editor-process notes render inside the editing-notes window
          (chrome in src/app/doc-notes.css, shared with the RFP receipt) so
          they read as UI, never as document content. Empty window renders
          nothing at all. The stub and Planned notes below stay in the doc
          block (they describe the document for its reader), and the footer
          retention line is never dismissible. */}
      {hasNotes && flashKey !== dismissedFlash && (
        <div className="doc-notes">
          <div className="doc-notes-head">
            <span className="doc-notes-label">Editing notes</span>
            <button
              type="button"
              className="doc-notes-x"
              aria-label="Close editing notes"
              onClick={() => {
                setDismissedFlash(flashKey);
                paneRef.current?.focus();
              }}
            >
              {"×"}
            </button>
          </div>
          {changedNow && changedNow.length > 0 && (
            <p className="text-sm">
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
          {outlineNote && (
            <p
              className="mt-2 max-w-none text-xs"
              style={faint}
              data-qa="doc-outline-note"
            >
              {outlineNote}
            </p>
          )}
        </div>
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
          {/* The round 18b/23 outline honesty note moved to the
              editing-notes window above (outlineNote memo): dismissible,
              re-armed by the flashKey-keyed dismissal on the next update. */}
          {renderRows.map((row, ri) => {
            if (row.kind === "bucket")
              return (
                <h3
                  key={`bucket-${ri}`}
                  className="doc-h doc-bucket text-xl"
                  aria-label={row.label}
                >
                  {row.label}
                </h3>
              );
            const { s, si, meta } = row;
            const changed = (highlights[doc.slug] ?? []).includes(s.id);
            const asked = (asking[doc.slug] ?? []).includes(s.id);
            const planned = (placeholders[doc.slug] ?? []).includes(s.id);
            // undefined when a section has no marks; otherwise the STABLE
            // array from marksBySection, so the parse memo holds for every
            // section except the one actually revealing.
            const secMarks = marksBySection.get(`${doc.slug}#${s.id}`);
            // Count-delta proven, set at diff time: the durable trace of a
            // resolution whose theater degraded or was skipped.
            const clearedCount = cleared?.[`${doc.slug}#${s.id}`] ?? 0;
            // Live region beat on this section. The section-level class
            // mounts ONLY when the block has no washable lines (all-table
            // regions): with wash spans present the line-level treatment
            // carries both the motion and the static reduce signal, and a
            // second outline would just be noise.
            const regionActive =
              !!reveal &&
              reveal.mode === "region" &&
              reveal.item.doc === doc.slug &&
              reveal.item.section === s.id &&
              regionWashLines(
                s.markdown,
                reveal.item.nextStart,
                reveal.item.nextEnd
              ).length === 0;
            const cls =
              [
                changed ? "doc-sec--changed doc-sec--flash" : "",
                asked ? "doc-sec--asking" : "",
                planned ? "doc-sec--planned" : "",
                regionActive ? "doc-sec--region" : "",
              ]
                .filter(Boolean)
                .join(" ") || undefined;
            // Nested rows keep the exact visual style sections have today
            // (text-lg) one semantic level down; the bucket heading above
            // them is the larger new layer, so nothing ever looks demoted.
            const SecTag = meta?.nested ? "h4" : "h3";
            return (
              <Fragment key={changed ? `${s.id}-${flashKey}` : s.id}>
              <section
                id={secDomId(doc.slug, s.id)}
                className={cls}
                // Round 23, profile-gated: nested sections indent under
                // their bucket so the pane's shape mirrors the docx
                // ladder (proportional, not pixel-matched).
                style={
                  profile && meta?.nested
                    ? { marginLeft: "1.25rem" }
                    : undefined
                }
              >
                <SecTag className="doc-h text-lg" tabIndex={-1} data-sec-heading>
                  {meta
                    ? meta.label
                    : sectionTitleText(si + 1, s.title, numbering, profile ?? null)}
                  {changed && <span className="doc-chip">Updated</span>}
                  {clearedCount > 0 && (
                    <span className="doc-chip">
                      {clearedCount === 1
                        ? "Open item cleared"
                        : `${clearedCount} open items cleared`}
                    </span>
                  )}
                  {asked && (
                    <span className="doc-chip doc-chip--ask">
                      Asking about this
                    </span>
                  )}
                  {planned && (
                    <span className="doc-chip doc-chip--plan">Planned</span>
                  )}
                </SecTag>
                <SectionBody
                  markdown={s.markdown}
                  num={si + 1}
                  numbering={numbering}
                  profile={profile ?? null}
                  baseLabel={meta?.base ?? null}
                  nested={meta?.nested === true}
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
              </Fragment>
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
          {/* Region beats have no inline strike (no anchored place to put
              one); the bar names the removed marker instead. Verbatim old
              text, struck, full opacity: WCAG-persistent, never faded. */}
          {reveal && isRegionItem(reveal.item) && reveal.item.excerpt && (
            <span className="doc-bar-strike text-xs">
              Cleared ·{" "}
              <s>
                [TO CONFIRM:{" "}
                {reveal.item.excerpt.replace(/\s+/g, " ").length > 48
                  ? `${reveal.item.excerpt.replace(/\s+/g, " ").slice(0, 48).trimEnd()}...`
                  : reveal.item.excerpt.replace(/\s+/g, " ")}
                ]
              </s>
            </span>
          )}
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
