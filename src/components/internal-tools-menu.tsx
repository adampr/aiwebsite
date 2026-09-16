"use client";

// The staff nav's "Internal Tools" disclosure (nav restructure 2026-08-19).
//
// Not a destination: a button opening a small submenu with an "XL.net" group
// label and the staff-only tools (today three: RFP Response -> /rfp, XLAnt
// (download) -> https://xlant.ai/account/download, and XLAnt token &
// computers -> /internal/xlant). The list is nav-links.ts's, rendered by
// mapping over item.items, so a fourth costs nothing here.
//
// ONE OF THEM IS ON ANOTHER ORIGIN (2026-09-15), which is the only reason this
// component has a branch in its map at all. XLAnt's installers live on
// xlant.ai now and nowhere else, so the download row is an ABSOLUTE href, and
// an absolute href must not reach next/link: <Link> prefetches and then routes
// it through THIS app's router, which has no such route. It is drawn as a
// plain <a rel="noopener"> instead — the house pattern for a link that leaves
// this site (src/app/contact/page.tsx). See the `current` note below for the
// other half of it.
// Rendered only inside the staff variant of the desktop anchor row
// (nav-anchors.tsx); the phone panel presents the same group as labeled rows
// (mobile-nav.tsx), so this component never renders below md.
//
// Dismissal mirrors MobileNav's proven set: Escape closes and returns focus
// to the button (the menu never steals focus on open, so that is the only
// restoration needed); pointerdown outside the button+menu subtree closes
// without eating the tap; the App Router keeps the layout mounted across a
// <Link> navigation, so a pathname effect closes on every route change.
// The menu stays in the DOM ([hidden] when closed) so aria-controls always
// points at a real element and server/client markup stay byte-identical.
//
// Client rendering is a UI convenience, NOT the control: every destination in
// here that is ON THIS HOST is gated server-side regardless of what this menu
// shows (/rfp by its layout + pages, /internal/xlant by
// src/app/internal/layout.tsx and its own page) - the staff-probe.ts doctrine.
// The external one is another origin's to gate, and it does: xlant.ai reads
// the relay's own allowance for whoever is signed in there.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { NavMenuItem } from "@/components/nav-links";

// MUST equal Tailwind's md — same lockstep contract as mobile-nav.tsx.
const PHONE_MQ = "(max-width: 767.98px)";

export function InternalToolsMenu({ item }: { item: NavMenuItem }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Close on every path change (back/forward included). Adjust-during-render
  // rather than an effect: same behavior as MobileNav's pathname effect
  // without tripping react-hooks/set-state-in-effect on a new file.
  const [lastPathname, setLastPathname] = useState(pathname);
  if (pathname !== lastPathname) {
    setLastPathname(pathname);
    if (open) setOpen(false);
  }

  // Crossing the breakpoint while open (rotation to portrait) would leave
  // `open` latched: the whole anchor row hides below md, but the invisible
  // toggle keeps aria-expanded="true" and the menu re-presents itself already
  // open on the way back up. MobileNav guards the mirror case; bound only
  // while open.
  useEffect(() => {
    if (!open) return;
    const media = window.matchMedia(PHONE_MQ);
    const onChange = (event: MediaQueryListEvent) => {
      if (event.matches) setOpen(false);
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [open]);

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

  // The toggle lights up while the viewer is inside one of its destinations ON
  // THIS HOST. An external destination is skipped rather than tested: a
  // pathname here can never be inside another origin, so the test could only
  // ever be false, and a comparison that cannot be true is a comparison that
  // will be misread later.
  // Styled off data-current, not aria-current: aria-current marks the current
  // item WITHIN a set of links, and this toggle is a button, not a link (the
  // real aria-current sits on the menu link below).
  const current = item.items.some(
    (l) => !l.external && pathname.startsWith(l.href)
  );

  return (
    <div className="nav-tools" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="nav-tools-toggle"
        aria-expanded={open}
        aria-controls="internal-tools-menu"
        data-current={current || undefined}
        onClick={() => setOpen((value) => !value)}
      >
        {item.label}
        {/* Hairline chevron, stroke currentColor - same drawing rules as the
            MobileNav toggle glyph (1.25px strokes, no fills). */}
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          {open ? (
            <path d="M1.5 6.5L5 3l3.5 3.5" stroke="currentColor" strokeWidth="1.25" />
          ) : (
            <path d="M1.5 3.5L5 7l3.5-3.5" stroke="currentColor" strokeWidth="1.25" />
          )}
        </svg>
      </button>
      {/* The id is safe as a constant: exactly one Internal Tools menu can
          exist per document (one staff nav row). */}
      <div id="internal-tools-menu" className="nav-tools-menu" hidden={!open}>
        <span className="nav-tools-group">{item.group}</span>
        {item.items.map((l) =>
          l.external ? (
            // No aria-current: this row is never the page you are on, because
            // it is not on this site. `rel="noopener"` without target="_blank"
            // is deliberate — the menu navigates in place, and the attribute
            // costs nothing while making the intent of an absolute href plain.
            <a
              key={l.href}
              href={l.href}
              rel="noopener"
              onClick={() => setOpen(false)}
            >
              {l.label}
            </a>
          ) : (
            <Link
              key={l.href}
              href={l.href}
              aria-current={pathname.startsWith(l.href) ? "page" : undefined}
              onClick={() => setOpen(false)}
            >
              {l.label}
            </Link>
          )
        )}
      </div>
    </div>
  );
}
