"use client";

// Shared pager for React-state-rendered lists (§5.19). 10/50/All by default
// (the requested-work board, the your-requests list, the scorecard
// click-through page); the roadmap directory passes 10/50/250 with no All.
// A 1:1 behavioral clone of the hardened
// /work/submit "Your submissions" pager (src/app/work/submit/
// submit-client.tsx, SUBMISSIONS-PAGER round 2026-08-07): safePage is
// CLAMPED in render so a list that shrinks underneath the pager never
// paints an empty window; the clamp is settled back into state in a guarded
// effect; changeSize re-anchors on the first visible row; both arrows stay
// MOUNTED and use aria-disabled (never the disabled attribute or a
// pageCount conditional, which would blur a keyboard user's focus to
// <body>); only the top readout is aria-live.
//
// NEVER import src/app/work/pager.tsx here or reuse anything gated on
// html.pager-active: that island mutates server-owned DOM and its
// .work-pager CSS renders invisible off /work. This one is for lists the
// island itself renders from props/state.
//
// PARAMETERIZATION RULES (2026-08-09), because the options are read on EVERY
// render: pass the options object as a MODULE-LEVEL constant, never an inline
// literal (a fresh object per render is fine for these reads today, but it is
// the kind of thing that stops being fine the moment one is memoized). sizes[0]
// is the size the list OPENS on and the one showPager compares against, so a
// list whose first entry is not its default silently never shows its pager.
// 0 means All and is legal only as the LAST entry.

import { useEffect, useState } from "react";

export const PAGE_SIZES = [10, 50, 0] as const; // 0 = All, deliberately last
export const DEFAULT_PAGE_SIZE = 10;

/** Per-list overrides. `sizes` MUST start with the default page size (the
 * first entry is what the list opens on and what showPager compares against);
 * 0 means All and is only legal as the LAST entry. The directory passes
 * [10, 50, 250] with no All: it renders an editable row per person, and the
 * owner ruled a 500-row All "too much" (2026-08-09). `plural` exists because
 * the readout used to build "2 persons" from noun + "s". */
export type PagerOptions = { sizes?: readonly number[]; plural?: string };

export type PagedList<T> = {
  windowed: T[];
  pageSize: number;
  safePage: number;
  pageCount: number;
  showPager: boolean;
  readout: string;
  sizes: readonly number[];
  plural: string;
  changeSize: (n: number) => void;
  goTo: (n: number) => void;
};

export function usePagedList<T>(
  items: T[],
  noun: string,
  opts?: PagerOptions
): PagedList<T> {
  const sizes = opts?.sizes ?? PAGE_SIZES;
  const plural = opts?.plural ?? `${noun}s`;
  const defaultSize = sizes[0] ?? DEFAULT_PAGE_SIZE;
  const [pageSize, setPageSize] = useState<number>(defaultSize);
  const [page, setPage] = useState(0);

  const pageCount =
    pageSize === 0 ? 1 : Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const windowed =
    pageSize === 0
      ? items
      : items.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const showPager =
    items.length > defaultSize || pageSize !== defaultSize;

  // Settle the clamp into state (guarded: exactly one extra render, cannot
  // re-enter), so a stale high index does not silently re-apply when the
  // list grows again.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- settle a clamp the render already applied; guarded, so exactly one extra render and it cannot re-enter
    if (page > pageCount - 1) setPage(pageCount - 1);
  }, [page, pageCount]);

  function changeSize(next: number) {
    const anchor = pageSize === 0 ? 0 : safePage * pageSize;
    setPageSize(next);
    setPage(next === 0 ? 0 : Math.floor(anchor / next));
  }

  function goTo(next: number) {
    if (next < 0 || next >= pageCount) return;
    setPage(next);
  }

  const pad = (n: number) => String(n).padStart(2, "0");
  const countLabel = `${items.length} ${items.length === 1 ? noun : plural}`;
  const readout =
    pageSize === 0
      ? countLabel
      : `Page ${pad(safePage + 1)} / ${pad(pageCount)} · ${countLabel}`;

  return {
    windowed,
    pageSize,
    safePage,
    pageCount,
    showPager,
    readout,
    sizes,
    plural,
    changeSize,
    goTo,
  };
}

/** The strip. Render above AND below long lists; pass bottom on the lower
 * one so only the top readout is announced. The noun comes from the pager
 * (usePagedList owns the plural), never a second prop that could disagree
 * with the readout it sits next to. */
export function PagerStrip<T>({
  pager,
  idPrefix,
  bottom = false,
}: {
  pager: PagedList<T>;
  idPrefix: string;
  bottom?: boolean;
}) {
  const sizeId = bottom ? `${idPrefix}-size-bottom` : `${idPrefix}-size`;
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-[var(--xl-line)] pt-3">
      <div className="flex items-center gap-3">
        <label
          htmlFor={sizeId}
          className="mono text-xs uppercase tracking-[0.2em] text-light"
        >
          Show
        </label>
        <select
          id={sizeId}
          className="input"
          // A SUPERSET of the visible "Show" (WCAG 2.5.3 Label in Name).
          aria-label={`Show ${pager.plural} per page`}
          value={pager.pageSize}
          onChange={(e) => pager.changeSize(Number(e.target.value))}
        >
          {pager.sizes.map((s) => (
            <option key={s} value={s}>
              {s === 0 ? "All" : s}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-4">
        <button
          type="button"
          className="btn btn--text"
          aria-disabled={pager.safePage === 0}
          onClick={() => pager.goTo(pager.safePage - 1)}
        >
          Prev
        </button>
        <span
          className="mono text-xs uppercase tracking-[0.2em] text-faint"
          aria-live={bottom ? undefined : "polite"}
          aria-hidden={bottom ? true : undefined}
        >
          {pager.readout}
        </span>
        <button
          type="button"
          className="btn btn--text"
          aria-disabled={pager.safePage >= pager.pageCount - 1}
          onClick={() => pager.goTo(pager.safePage + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}
