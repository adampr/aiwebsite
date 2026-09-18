"use client";

// The desktop anchor row (nav restructure 2026-08-19). Owns the
// .nav-anchors div the layout used to fill from a server-side NAV_LINKS
// array; the list now varies by session state, the layout must stay a
// non-async server component, so the row became this island. The list
// itself lives in nav-links.ts (one source of truth shared with MobileNav);
// see that module for the variants and the hydration-swap note.
//
// Every entry is a plain link since 2026-09-18 (the Internal Tools
// disclosure retired with the XLAnt token page — see nav-links.ts). An
// `external` entry (staff XLAnt -> xlant.ai) is a plain <a rel="noopener">,
// never a <Link>: next/link would route an absolute URL through this app's
// router. It inherits `.nav-anchors a` styling like its peers.

import Link from "next/link";
import { useNavItems } from "@/components/nav-links";

export function NavAnchors() {
  const items = useNavItems();

  return (
    <div className="nav-anchors flex flex-wrap items-center gap-8">
      {items.map((item) =>
        item.external ? (
          // Another origin: `rel="noopener"` without target="_blank" is
          // deliberate — the row navigates in place, and the attribute costs
          // nothing while making the intent of an absolute href plain.
          <a key={item.href} href={item.href} rel="noopener">
            {item.label}
          </a>
        ) : (
          <Link key={item.href} href={item.href}>
            {item.label}
          </Link>
        )
      )}
    </div>
  );
}
