"use client";

// /work console pager (pagination round, 2026-08-04): windows the ONE
// works sequence (25 static exhibits in bay order, then team cards in lane
// display order) behind a "Show 5 / 10 / 25 / All" mono strip below the
// registry.
//
// Mechanism and safety contract, in order of importance:
// - The server always renders EVERY card; this island only toggles
//   hidden="until-found" on out-of-window sections at runtime. No JS, a
//   crashed island, or a structure drift (count mismatch) all mean nothing
//   was ever hidden and the strips stay display:none (html.pager-active is
//   the CSS gate) - fail-open by construction, never fail-hidden.
// - There is deliberately NO pre-hydration boot script: inline scripts do
//   not run on App Router soft navigations (the majority arrival path via
//   header links), so the island owns ALL windowing at mount. The cost is
//   a brief fully-visible state on hard loads; page 1 content is identical
//   either way, so a visitor at the top sees nothing move.
// - The sequence is discovered from the RSC-rendered DOM via SEQ_SELECTOR.
//   Those nodes are server-owned: React never reconciles them, so
//   setAttribute/classList mutation is safe. Any refactor that wraps the
//   bay sections in a client component breaks that assumption - the count
//   check below turns that mistake into "everything visible", not data loss.
// - hidden="until-found" (not display:none) keeps paged-out cards
//   find-in-page searchable in Chromium/Firefox 139+, which fire
//   beforematch on reveal; we re-sync the pager so the readout never lies.
//   Safari parses it as plain hidden - cards there are reachable via the
//   registry, the pager, and Show All.
// - Deep links: hashchange does NOT fire on initial navigation, so the
//   reveal routine also runs once at mount; a capture-phase click listener
//   covers re-clicking a registry row whose hash is ALREADY current (no
//   hashchange fires on same-hash clicks - without this the browser
//   re-scrolls to a zero-height hidden box).
// - sessionStorage persists the SIZE only (never the page): a weeks-old
//   "5" must not permanently hide the lab, and every fresh session matches
//   the canonical crawlable page.

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const SIZES = [5, 10, 25, 0] as const; // 0 = All
const DEFAULT_SIZE = 10;
const STORAGE_KEY = "xl.work.pageSize";
const SEQ_SELECTOR = ".work-page section[aria-label] section.panel[id]";

function readStoredSize(): number {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    const n = raw === null ? NaN : Number(raw);
    return (SIZES as readonly number[]).includes(n) ? n : DEFAULT_SIZE;
  } catch {
    return DEFAULT_SIZE;
  }
}

function storeSize(size: number) {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, String(size));
  } catch {
    // private mode: the choice just does not persist
  }
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function WorkPager({
  staticCount,
  teamCount,
}: {
  staticCount: number;
  teamCount: number;
}) {
  const total = staticCount + teamCount;
  const [size, setSize] = useState<number>(DEFAULT_SIZE);
  const [page, setPage] = useState(0);
  const [active, setActive] = useState(false);
  const panelsRef = useRef<HTMLElement[]>([]);
  const stateRef = useRef({ size: DEFAULT_SIZE, page: 0 });

  const pageCount = size === 0 ? 1 : Math.max(1, Math.ceil(total / size));

  /** Apply the window to the DOM: hide out-of-window panels, then hide bay
   * headers/team divider for bays with nothing visible. Idempotent. */
  const applyWindow = useCallback((nextSize: number, nextPage: number) => {
    const panels = panelsRef.current;
    panels.forEach((el, i) => {
      const hide =
        nextSize !== 0 &&
        (i < nextPage * nextSize || i >= (nextPage + 1) * nextSize);
      if (hide) el.setAttribute("hidden", "until-found");
      else el.removeAttribute("hidden");
    });
    document
      .querySelectorAll(".work-page > section[aria-label]")
      .forEach((wrapper) => {
        const anyVisible = wrapper.querySelector(
          "section.panel[id]:not([hidden])"
        );
        wrapper.classList.toggle("pager-empty", !anyVisible);
        const head = wrapper.querySelector("[data-bay-head]");
        if (head) {
          if (anyVisible) head.removeAttribute("hidden");
          else head.setAttribute("hidden", "");
        }
      });
    const divider = document.querySelector("[data-team-divider]");
    if (divider) {
      const anyTeam = document.querySelector(
        'section.panel[id][data-work-card="team"]:not([hidden])'
      );
      if (anyTeam) divider.removeAttribute("hidden");
      else divider.setAttribute("hidden", "");
    }
    stateRef.current = { size: nextSize, page: nextPage };
  }, []);

  const setAndApply = useCallback(
    (nextSize: number, nextPage: number) => {
      applyWindow(nextSize, nextPage);
      setSize(nextSize);
      setPage(nextPage);
    },
    [applyWindow]
  );

  /** Reveal the card a fragment points at: window to its page, focus it,
   * scroll it under the fixed nav. Returns false for foreign hashes. */
  const revealHash = useCallback(
    (hash: string, scroll: boolean) => {
      const id = decodeURIComponent(hash.replace(/^#/, ""));
      if (!id) return false;
      const panels = panelsRef.current;
      const idx = panels.findIndex((p) => p.id === id);
      if (idx < 0) return false;
      const { size: curSize } = stateRef.current;
      if (curSize !== 0) {
        const targetPage = Math.floor(idx / curSize);
        if (targetPage !== stateRef.current.page) {
          setAndApply(curSize, targetPage);
        }
      }
      const el = panels[idx];
      el.setAttribute("tabindex", "-1");
      el.focus({ preventScroll: true });
      if (scroll) {
        el.scrollIntoView({
          behavior: prefersReducedMotion() ? "auto" : "smooth",
          block: "start",
        });
      }
      return true;
    },
    [setAndApply]
  );

  useEffect(() => {
    const panels = Array.from(
      document.querySelectorAll<HTMLElement>(SEQ_SELECTOR)
    );
    if (panels.length !== total) {
      // Structure drift: fail open. Nothing is hidden, strips stay hidden.
      console.warn(
        `work pager: found ${panels.length} panels, expected ${total} - pager disabled`
      );
      return;
    }
    panelsRef.current = panels;

    const initialSize = readStoredSize();
    let initialPage = 0;
    const hashId = decodeURIComponent(window.location.hash.replace(/^#/, ""));
    const hashIdx = hashId ? panels.findIndex((p) => p.id === hashId) : -1;
    if (initialSize !== 0 && hashIdx >= 0) {
      initialPage = Math.floor(hashIdx / initialSize);
    }
    applyWindow(initialSize, initialPage);
    // SSR renders the default for a clean hydration; the island then adopts
    // the stored size + hash page in ONE deliberate post-mount render.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- adopt browser state after hydration, one render by design
    setSize(initialSize);
    setPage(initialPage);
    document.documentElement.classList.add("pager-active");
    setActive(true);
    if (hashIdx >= 0) {
      // The browser anchored against the fully-visible page before mount;
      // re-scroll after windowing shifted the layout.
      requestAnimationFrame(() => revealHash(window.location.hash, true));
    }

    const onHashChange = () => revealHash(window.location.hash, true);
    // Same-hash clicks (registry row clicked twice) never fire hashchange;
    // catch the click itself. Runs after the browser's default fragment
    // navigation thanks to the timeout - the routine is idempotent, so the
    // changed-hash case harmlessly runs both handlers.
    const onClick = (ev: MouseEvent) => {
      if (ev.defaultPrevented || ev.button !== 0) return;
      if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      const anchor = (ev.target as Element | null)?.closest?.(
        'a[href^="#"]'
      ) as HTMLAnchorElement | null;
      if (!anchor) return;
      const hash = anchor.getAttribute("href")!;
      window.setTimeout(() => revealHash(hash, true), 0);
    };
    // Find-in-page revealed a hidden card (Chromium/FF139+): the browser
    // already stripped hidden; move the window there so the readout and
    // the neighboring cards match what the visitor is looking at.
    const onBeforeMatch = (ev: Event) => {
      const el = (ev.target as Element | null)?.closest?.(
        "section.panel[id]"
      ) as HTMLElement | null;
      if (!el) return;
      const idx = panelsRef.current.indexOf(el);
      const { size: curSize } = stateRef.current;
      if (idx >= 0 && curSize !== 0) {
        window.setTimeout(
          () => setAndApply(curSize, Math.floor(idx / curSize)),
          0
        );
      }
    };
    window.addEventListener("hashchange", onHashChange);
    document.addEventListener("click", onClick, true);
    document.addEventListener("beforematch", onBeforeMatch, true);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("beforematch", onBeforeMatch, true);
      document.documentElement.classList.remove("pager-active");
      panels.forEach((el) => el.removeAttribute("hidden"));
      document
        .querySelectorAll(".work-page > section[aria-label]")
        .forEach((w) => {
          w.classList.remove("pager-empty");
          w.querySelector("[data-bay-head]")?.removeAttribute("hidden");
        });
      document
        .querySelector("[data-team-divider]")
        ?.removeAttribute("hidden");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [total]);

  const onSizeChange = (nextSize: number) => {
    storeSize(nextSize);
    let nextPage = 0;
    if (nextSize !== 0) {
      // Re-anchor on the topmost panel currently in the viewport, so a
      // size change never teleports the reader (refute amendment: window
      // start alone breaks the All -> 5 case).
      const panels = panelsRef.current;
      const { size: curSize, page: curPage } = stateRef.current;
      let anchorIdx = curSize === 0 ? 0 : curPage * curSize;
      for (let i = 0; i < panels.length; i++) {
        if (panels[i].hasAttribute("hidden")) continue;
        if (panels[i].getBoundingClientRect().bottom > 96) {
          anchorIdx = i;
          break;
        }
      }
      nextPage = Math.floor(anchorIdx / nextSize);
    }
    setAndApply(nextSize, nextPage);
  };

  const goTo = (nextPage: number) => {
    if (nextPage < 0 || nextPage >= pageCount) return; // aria-disabled guard
    setAndApply(size, nextPage);
    const strip = document.getElementById("work-pager");
    strip?.scrollIntoView({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      block: "start",
    });
  };

  const pad = (n: number) => String(n).padStart(2, "0");
  const readout =
    size === 0
      ? `${total} works`
      : `Page ${pad(page + 1)} / ${pad(pageCount)} · ${total} works`;

  const strip = (bottom: boolean) => (
    <nav
      aria-label={bottom ? "Works pager (bottom)" : "Works pager"}
      className="work-pager"
      id={bottom ? undefined : "work-pager"}
    >
      <fieldset className="work-pager-sizes">
        <legend>Show</legend>
        {SIZES.map((s) => (
          <label
            key={s}
            className={
              size === s ? "work-pager-size is-active" : "work-pager-size"
            }
          >
            <input
              type="radio"
              name={bottom ? "work-page-size-b" : "work-page-size"}
              className="sr-only"
              checked={size === s}
              // eslint-disable-next-line react-hooks/refs -- onSizeChange reads panel/state refs at event time only, never in render
              onChange={() => onSizeChange(s)}
            />
            {s === 0 ? "All" : s}
          </label>
        ))}
      </fieldset>
      <div className="work-pager-nav">
        <button
          type="button"
          className="work-pager-btn"
          style={size === 0 ? { visibility: "hidden" } : undefined}
          aria-disabled={page === 0}
          onClick={() => goTo(page - 1)}
        >
          <span aria-hidden="true">←</span> Prev
        </button>
        <span
          className="work-pager-readout"
          aria-live={bottom ? undefined : "polite"}
          aria-hidden={bottom ? true : undefined}
        >
          {readout}
        </span>
        <button
          type="button"
          className="work-pager-btn"
          style={size === 0 ? { visibility: "hidden" } : undefined}
          aria-disabled={page >= pageCount - 1}
          onClick={() => goTo(page + 1)}
        >
          Next <span aria-hidden="true">→</span>
        </button>
      </div>
    </nav>
  );

  const foot =
    active && pageCount > 1 ? document.getElementById("work-pager-foot") : null;

  return (
    <>
      {strip(false)}
      {foot ? createPortal(strip(true), foot) : null}
    </>
  );
}
