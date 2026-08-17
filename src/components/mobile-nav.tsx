"use client";

// Mobile disclosure menu (phone nav 2026-08-17).
//
// Below Tailwind's md the seven destinations in .nav wrapped to 4-5 rows —
// 12px caps at 0.3em tracking are very wide ("YOUR AI ROADMAP" alone is
// ~174px of a ~328px usable row) — roughly 45% of the first screen on a
// 360px phone. Those seven now live in a panel under the bar; .nav-anchors
// (futurism.css §7b) hides the desktop row at the same breakpoint.
//
// WHAT GOES IN THE PANEL: the seven destinations, plus the session-gated
// links (YourWorkLink, StaffRfpLink) as `children`. An earlier draft kept
// those in the bar, arguing a second instance would double the session probe.
// A review pass refuted that from the code: roadmap-probe.ts holds a
// module-scoped promise memo whose own comment reads "exactly one fetch of
// /api/roadmap/nav per page, shared by every island instance", and staff-probe
// delegates to the module's shared session store, "the single reader of GET
// /api/auth/session for the whole document". A second instance costs ZERO
// requests and awaits the identical promise, so two copies cannot disagree.
//
// That mattered because of WHO verifies this. The gated islands return null
// for anonymous visitors — but the owner is signed-in @xl.net staff, so
// StaffRfpLink and RoadmapPercentBadge both render for him. Leaving them in
// the bar put ~650px of chrome in a 328px row: three rows, for the one person
// opening it on a phone. The fix would have done nothing for its own tester.
//
// WHAT STAYS IN THE BAR: ThemeToggle, UserMenu (itself a disclosure — nesting
// one inside this panel creates a nested-Escape precedence problem and buries
// sign-in two taps deep), and RoadmapPercentBadge (a STATUS, not a
// destination; the owner asked for it displayed prominently, and ~60px fits).
//
// The link list is a PLAIN ARRAY owned by layout.tsx and passed to both the
// desktop row and this panel, so the two presentations cannot disagree about
// which destinations exist. The layout stays a non-async server component.
//
// Server HTML and the client's first render are identical (panel present but
// [hidden]) — no hydration swap on a cold load.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

export type MobileNavLink = { href: string; label: string };

// MUST equal Tailwind's md (min-width:768px), which the header's md:sticky
// and futurism.css §7b are both keyed to. 767.98 is Tailwind's own max-md
// boundary — a fractional CSS pixel width (browser zoom) must land on
// exactly one side in both the stylesheet and this query.
const PHONE_MQ = "(max-width: 767.98px)";

export function MobileNav({
  links,
  children,
}: {
  links: readonly MobileNavLink[];
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // App Router keeps the layout mounted across a <Link> navigation, so
  // unlike a full-page-load menu this panel would still be open on the next
  // page. Close on every path change — this also covers back/forward and a
  // tap on the destination the visitor is already on.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Crossing the breakpoint while open (rotation to landscape) would leave
  // `open` latched: nothing renders above the boundary, but the invisible
  // toggle keeps aria-expanded="true" and the panel re-presents itself
  // already open on the way back down. Bound only while open.
  useEffect(() => {
    if (!open) return;
    const media = window.matchMedia(PHONE_MQ);
    const onChange = (event: MediaQueryListEvent) => {
      if (!event.matches) setOpen(false);
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [open]);

  // Dismissal, bound only while open: Escape closes and hands focus back to
  // the button (the panel never steals focus on open, so that is the only
  // restoration needed); pointerdown outside the button+panel subtree closes
  // without eating the tap that landed elsewhere.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (root && event.target instanceof Node && !root.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  return (
    <div className="mobile-nav" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="mobile-nav-toggle"
        aria-label="Menu"
        aria-expanded={open}
        aria-controls="mobile-nav-panel"
        onClick={() => setOpen((value) => !value)}
      >
        {/* Hairline strokes, not the usual 1.5-2px bars: this design system
            draws with 1px rules everywhere (§7 nav, §9 tables). Stroke is
            currentColor so the dim-ink rest state, the cyan open state and
            both themes come along for free. */}
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
          {open ? (
            <path d="M5.5 5.5l11 11M16.5 5.5l-11 11" stroke="currentColor" strokeWidth="1.25" />
          ) : (
            <path d="M3 6.5h16M3 11h16M3 15.5h16" stroke="currentColor" strokeWidth="1.25" />
          )}
        </svg>
      </button>
      {/* Always in the DOM ([hidden] when closed) — keeps aria-controls
          pointing at a real element and the markup byte-identical between
          server and client. Positioning is absolute against .nav; see the
          containing-block note in futurism.css §7b. */}
      <div id="mobile-nav-panel" className="mobile-nav-panel" hidden={!open}>
        {links.map((link, i) => {
          // "/" only matches itself; every other destination owns its
          // subtree (/blog/<slug> is still AI News).
          const current =
            link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
          return (
            <Link
              key={link.href}
              href={link.href}
              aria-current={current ? "page" : undefined}
              onClick={() => setOpen(false)}
            >
              {/* Real markup, not a CSS counter: `content: counter() / ""`
                  (the alt-text form that keeps the numeral out of the
                  accessibility tree) is too new for older iOS Safari, and an
                  invalid content value drops the numeral entirely. */}
              <span className="mobile-nav-index" aria-hidden="true">
                {String(i + 1).padStart(2, "0")}
              </span>
              {link.label}
            </Link>
          );
        })}
        {/* Session-gated destinations (YourWorkLink, StaffRfpLink) render here
            when they render at all. They sit BELOW the numbered public list on
            purpose: the numerals are a fixed 01-07 index of the public site, and
            a conditional row would make the sequence lie for signed-in staff. */}
        {children ? <div className="mobile-nav-gated">{children}</div> : null}
      </div>
    </div>
  );
}
