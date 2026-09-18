"use client";

// The session-variant top-nav model (nav restructure 2026-08-19; the
// Internal Tools submenu was RETIRED 2026-09-18 — see below).
//
// The top menu varies by session state (owner spec):
//   anonymous          Home · Our Work · Your AI Roadmap · AI News · Contact
//   signed-in, not xl  Home · XL.net Work · AI Roadmap · AI News · Contact
//   signed-in @xl.net  Home · AI Roadmap · AI News · RFP Response · XLAnt
//                      · Contact (six PLAIN links — no submenu)
//
// THE "INTERNAL TOOLS" SUBMENU IS GONE (2026-09-18). It existed to hold the
// staff tools, and by the end it held three rows: RFP Response, XLAnt
// (download) and XLAnt token & computers -> /internal/xlant. The owner
// retired the XLAnt token process — the desktop enrols by an approved code at
// https://xlant.ai/connect since 0.14.0 (2026-09-17) — so /internal/xlant and
// its API lane were deleted, the third row with them, and a disclosure
// holding two rows was not worth its machinery: the two survivors sit in the
// staff bar as plain links. The NavMenuItem/NavSubItem shapes and
// internal-tools-menu.tsx were deleted with it, not left as dead types.
//
// THE XLAnt LINK IS EXTERNAL, AND THAT IS THE OWNER'S 2026-09-15 INSTRUCTION
// STILL STANDING: picking XLAnt in the nav lands a member of staff in XLAnt's
// own download area, https://xlant.ai/account/download, where the product
// lives and the installers are published. `external` marks it, and both
// renderers (nav-anchors.tsx, mobile-nav.tsx) draw an external item as a
// plain `<a rel="noopener">` — next/link would route an absolute URL through
// this app's router, which has no such route — and skip it in every
// "am I currently here" test, since a pathname on THIS host can never be
// inside another origin.
//
// This module is the SINGLE SOURCE OF TRUTH for that list. The root layout
// (src/app/layout.tsx) is a NON-async server component and must stay that
// way - every public page's static render depends on it - so the variant
// cannot be server-rendered there. Instead the two presentations of the menu
// (the desktop anchor row, nav-anchors.tsx, and the phone panel,
// mobile-nav.tsx) both call useNavItems() below, so they cannot disagree
// about which destinations exist.
//
// HYDRATION: both islands render the ANONYMOUS set first (useState initial
// value) so server HTML and the client's first render are identical, then
// swap after the shared session probe resolves. That one-frame swap for
// signed-in viewers is the accepted precedent set by YourWorkLink and the
// former StaffRfpLink bar island.
//
// The staff predicate is the probeStaff-style @xl.net email suffix, NOT the
// server's isVerifiedStaffProvider (the per-login mv claim is invisible to
// the client - see staff-probe.ts). This is a UI convenience, never the
// control: /rfp and /roadmap stay server-gated, and an unverified-provider
// staff session that follows RFP Response lands on the server's explainer.
// XLAnt is on another origin with its own accounts and its own gate; this
// menu decides nothing about it, and whoever follows it signs in there.
// One probe, memoized module-wide in the module's session store, so the two
// islands cost zero extra requests and resolve to the same answer.

import { useEffect, useState } from "react";
import { probeSession } from "@/components/staff-probe";

/** One destination in the bar.
 *
 * `external` is set when `href` is an ABSOLUTE URL on another origin. Both
 * renderers of this list draw such an entry as a plain `<a rel="noopener">`
 * rather than a `<Link>`, because next/link would try to route an absolute URL
 * through this app's router. Absent means an ordinary in-app path, which is
 * what every other destination is.
 *
 * Only ONE renderer has an "am I currently here" test to skip, and saying so
 * exactly is the point: mobile-nav.tsx compares `usePathname()` per row and
 * sets `aria-current`, and it leaves an external row out of that comparison,
 * since a pathname on THIS host can never be inside another origin.
 * nav-anchors.tsx computes no current-page state at all — it does not read the
 * pathname — so the desktop bar marks nothing as current for any entry,
 * external or not. That asymmetry predates the external row and outlived the
 * Internal Tools disclosure, whose lit toggle was the desktop bar's only
 * current-page signal until it was deleted on 2026-09-18 (ARCHITECTURE.md
 * §5.22); it is recorded rather than repaired, because inventing a desktop
 * grammar for it is a design change and not this round's. */
export type NavLinkItem = {
  kind: "link";
  href: string;
  label: string;
  external?: true;
};
export type NavItem = NavLinkItem;

/** The signed-out set - also the server-rendered / first-paint set. */
export const ANONYMOUS_NAV: readonly NavItem[] = [
  { kind: "link", href: "/", label: "Home" },
  { kind: "link", href: "/work", label: "Our Work" },
  { kind: "link", href: "/roadmap", label: "Your AI Roadmap" },
  { kind: "link", href: "/blog", label: "AI News" },
  { kind: "link", href: "/contact", label: "Contact" },
];

/** Signed in, not @xl.net: same five destinations, two relabeled. */
const MEMBER_NAV: readonly NavItem[] = [
  { kind: "link", href: "/", label: "Home" },
  { kind: "link", href: "/work", label: "XL.net Work" },
  { kind: "link", href: "/roadmap", label: "AI Roadmap" },
  { kind: "link", href: "/blog", label: "AI News" },
  { kind: "link", href: "/contact", label: "Contact" },
];

/** Signed in @xl.net: /work leaves the bar; RFP Response and XLAnt ride it as
 * plain links (six entries — the one variant that is not five).
 *
 * The XLAnt URL is spelled here in full, character for character, and
 * xlant.ai serves that exact path (`src/app/account/download/page.tsx` in the
 * xlantai repo). The two repos share no code, so this string and that route
 * move in the same round or the menu leads to a 404. */
const STAFF_NAV: readonly NavItem[] = [
  { kind: "link", href: "/", label: "Home" },
  { kind: "link", href: "/roadmap", label: "AI Roadmap" },
  { kind: "link", href: "/blog", label: "AI News" },
  { kind: "link", href: "/rfp", label: "RFP Response" },
  {
    kind: "link",
    href: "https://xlant.ai/account/download",
    label: "XLAnt",
    external: true,
  },
  { kind: "link", href: "/contact", label: "Contact" },
];

export function useNavItems(): readonly NavItem[] {
  const [items, setItems] = useState<readonly NavItem[]>(ANONYMOUS_NAV);

  useEffect(() => {
    let alive = true;
    void probeSession().then((s) => {
      if (!alive || !s.authenticated || !s.email) return;
      const staff = s.email.trim().toLowerCase().endsWith("@xl.net");
      setItems(staff ? STAFF_NAV : MEMBER_NAV);
    });
    return () => {
      alive = false;
    };
  }, []);

  return items;
}
