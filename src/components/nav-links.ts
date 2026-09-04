"use client";

// The session-variant top-nav model (nav restructure 2026-08-19).
//
// The top menu varies by session state (owner spec):
//   anonymous          Home · Our Work · Your AI Roadmap · AI News · Contact
//   signed-in, not xl  Home · XL.net Work · AI Roadmap · AI News · Contact
//   signed-in @xl.net  Home · AI Roadmap · AI News · Internal Tools · Contact
//                      (Internal Tools is a submenu, group "XL.net", holding
//                      two destinations: RFP Response -> /rfp and
//                      XLAnt -> /internal/xlant)
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
// unverified-provider staff session that follows either Internal Tools
// destination lands on the server's explainer.
// One probe, memoized module-wide in the module's session store, so the two
// islands cost zero extra requests and resolve to the same answer.

import { useEffect, useState } from "react";
import { probeSession } from "@/components/staff-probe";

export type NavLinkItem = { kind: "link"; href: string; label: string };
export type NavMenuItem = {
  kind: "menu";
  label: string;
  /** Small group label shown above the submenu's items. */
  group: string;
  items: readonly { href: string; label: string }[];
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

/** Signed in @xl.net: /work leaves the bar; RFP and XLAnt ride the submenu. */
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
      { href: "/internal/xlant", label: "XLAnt" },
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
