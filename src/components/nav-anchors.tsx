"use client";

// The desktop anchor row (nav restructure 2026-08-19). Owns the
// .nav-anchors div the layout used to fill from a server-side NAV_LINKS
// array; the list now varies by session state, the layout must stay a
// non-async server component, so the row became this island. The list
// itself lives in nav-links.ts (one source of truth shared with MobileNav);
// see that module for the variants and the hydration-swap note.

import Link from "next/link";
import { useNavItems } from "@/components/nav-links";
import { InternalToolsMenu } from "@/components/internal-tools-menu";

export function NavAnchors() {
  const items = useNavItems();

  return (
    <div className="nav-anchors flex flex-wrap items-center gap-8">
      {items.map((item) =>
        item.kind === "link" ? (
          <Link key={item.href} href={item.href}>
            {item.label}
          </Link>
        ) : (
          <InternalToolsMenu key={item.label} item={item} />
        )
      )}
    </div>
  );
}
