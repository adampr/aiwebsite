"use client";

// The session-variant top-nav model (nav restructure 2026-08-19).
//
// The top menu varies by session state (owner spec):
//   anonymous          Home · Our Work · Your AI Roadmap · AI News · Contact
//   signed-in, not xl  Home · XL.net Work · AI Roadmap · AI News · Contact
//   signed-in @xl.net  Home · AI Roadmap · AI News · Internal Tools · Contact
//                      (Internal Tools is a submenu, group "XL.net", holding
//                      three destinations: RFP Response -> /rfp,
//                      XLAnt (download) -> https://xlant.ai/account/download
//                      and XLAnt token & computers -> /internal/xlant)
//
// XLANT'S BYTES LEFT THIS HOST ON 2026-09-15, ITS TOKEN DID NOT. The owner's
// instruction was that picking XLAnt from this menu should land a member of
// staff in XLAnt's own download area on xlant.ai, which is where the product
// lives and where the installers are published. So the XLAnt entry is now an
// ABSOLUTE href to another origin — the first one this list has ever carried —
// and `external` marks it, because an absolute href handed to next/link is a
// client-side navigation to a route this app does not have.
//
// THE SECOND XLAnt ROW IS NOT A DUPLICATE. Only the BYTES moved. The device
// token is minted against an XL.net staff session, which lives on the xl.net
// zone and which xlant.ai cannot see, so /internal/xlant stays here as the
// token-and-computers page — and every XLAnt build in the field prints that
// URL under its token box. Dropping it from this menu would leave a staffer
// who has to sign a lost laptop out with no door but the string the app
// prints.
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
// control: /rfp, /internal/xlant and /roadmap stay server-gated, and an
// unverified-provider staff session that follows either of the Internal Tools
// destinations ON THIS HOST lands on the server's explainer. The third one is
// on another origin with its own accounts and its own gate; this menu decides
// nothing about it, and whoever follows it signs in there.
// One probe, memoized module-wide in the module's session store, so the two
// islands cost zero extra requests and resolve to the same answer.

import { useEffect, useState } from "react";
import { probeSession } from "@/components/staff-probe";

export type NavLinkItem = { kind: "link"; href: string; label: string };

/** One destination inside a submenu.
 *
 * `external` is set when `href` is an ABSOLUTE URL on another origin, and it
 * changes two things in every renderer of this list (internal-tools-menu.tsx
 * and mobile-nav.tsx): the row is drawn as a plain `<a rel="noopener">` rather
 * than a `<Link>` — next/link would try to route an absolute URL through this
 * app's router — and it is skipped by the "am I currently here" tests, since a
 * pathname on THIS host can never be inside another origin. Absent means an
 * ordinary in-app path, which is what every other destination is. */
export type NavSubItem = {
  href: string;
  label: string;
  external?: true;
};

export type NavMenuItem = {
  kind: "menu";
  label: string;
  /** Small group label shown above the submenu's items. */
  group: string;
  items: readonly NavSubItem[];
};
export type NavItem = NavLinkItem | NavMenuItem;

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

/** Signed in @xl.net: /work leaves the bar; RFP and XLAnt ride the submenu.
 *
 * The XLAnt download URL is spelled here in full, character for character, and
 * xlant.ai serves that exact path (`src/app/account/download/page.tsx` in the
 * xlantai repo). The two repos share no code, so this string and that route
 * move in the same round or the menu leads to a 404. */
const STAFF_NAV: readonly NavItem[] = [
  { kind: "link", href: "/", label: "Home" },
  { kind: "link", href: "/roadmap", label: "AI Roadmap" },
  { kind: "link", href: "/blog", label: "AI News" },
  {
    kind: "menu",
    label: "Internal Tools",
    group: "XL.net",
    items: [
      { href: "/rfp", label: "RFP Response" },
      {
        href: "https://xlant.ai/account/download",
        label: "XLAnt (download)",
        external: true,
      },
      { href: "/internal/xlant", label: "XLAnt token & computers" },
    ],
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
