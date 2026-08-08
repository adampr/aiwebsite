"use client";

// Shared 10/50/All pager for React-state-rendered lists (§5.19; used by the
// requested-work board, the your-requests list, and the scorecard
// click-through page). A 1:1 behavioral clone of the hardened
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

import { useEffect, useState } from "react";

export const PAGE_SIZES = [10, 50, 0] as const; // 0 = All, deliberately last
export const DEFAULT_PAGE_SIZE = 10;

export type PagedList<T> = {
  windowed: T[];
  pageSize: number;
  safePage: number;
  pageCount: number;
  showPager: boolean;
  readout: string;
  changeSize: (n: number) => void;
  goTo: (n: number) => void;
};

export function usePagedList<T>(items: T[], noun: string): PagedList<T> {
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [page, setPage] = useState(0);

  const pageCount =
    pageSize === 0 ? 1 : Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const windowed =
    pageSize === 0
      ? items
      : items.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const showPager =
    items.length > DEFAULT_PAGE_SIZE || pageSize !== DEFAULT_PAGE_SIZE;

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
  const countLabel = `${items.length} ${noun}${items.length === 1 ? "" : "s"}`;
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
    changeSize,
    goTo,
  };
}

/** The strip. Render above AND below long lists; pass bottom on the lower
 * one so only the top readout is announced. */
export function PagerStrip<T>({
  pager,
  idPrefix,
  noun,
  bottom = false,
}: {
  pager: PagedList<T>;
  idPrefix: string;
  noun: string;
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
          aria-label={`Show ${noun}s per page`}
          value={pager.pageSize}
          onChange={(e) => pager.changeSize(Number(e.target.value))}
        >
          {PAGE_SIZES.map((s) => (
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
