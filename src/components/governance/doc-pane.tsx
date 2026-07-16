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
  type Block,
  type Inline,
} from "@/lib/governance/markdown";
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

function InlineSpans({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        if (n.t === "bold") return <strong key={i}>{n.text}</strong>;
        if (n.t === "italic") return <em key={i}>{n.text}</em>;
        if (n.t === "code") return <code key={i}>{n.text}</code>;
        if (n.t === "link")
          return (
            <a key={i} href={n.href} target="_blank" rel="noopener noreferrer">
              {n.text}
            </a>
          );
        return <span key={i}>{n.text}</span>;
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

function SectionBody({ markdown, num }: { markdown: string; num: number }) {
  const blocks = useMemo(
    () => normalizeSectionBlocks(parseMarkdown(markdown), num),
    [markdown, num]
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
  flashKey,
  changedNow,
  onJump,
  status,
  deletesAt,
}: {
  documents: GovernanceDoc[];
  activeDoc: string | null;
  onSelectDoc: (slug: string) => void;
  highlights: Record<string, string[]>;
  /** docSlug -> [sectionId] the ACTIVE question is about (owner fix #3). */
  asking: Record<string, string[]>;
  flashKey: number;
  changedNow: ChangedRef[] | null;
  onJump: (doc: string, section: string, focus: boolean) => void;
  status: ProjectStatus;
  deletesAt: string;
}) {
  const doc =
    documents.find((d) => d.slug === activeDoc) ?? documents[0] ?? null;

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

      {!doc && (
        <p className="mt-6 text-sm" style={dim}>
          No documents yet.
        </p>
      )}

      {doc && (
        <div className="mt-6 space-y-8">
          {doc.stub && (
            <p className="text-xs" style={faint}>
              This document records a negative determination: it explains why
              the rest of the set does not apply.
            </p>
          )}
          {doc.sections.map((s, si) => {
            const changed = (highlights[doc.slug] ?? []).includes(s.id);
            const asked = (asking[doc.slug] ?? []).includes(s.id);
            const cls =
              [
                changed ? "doc-sec--changed doc-sec--flash" : "",
                asked ? "doc-sec--asking" : "",
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
                </h3>
                <SectionBody markdown={s.markdown} num={si + 1} />
              </section>
            );
          })}
        </div>
      )}

      <p className="mono mt-8 text-xs" style={faint}>
        {footer}
      </p>
    </section>
  );
}
