"use client";

// Section sub-nav. A client component only because it reads the pathname to
// mark the active tab; it holds no session state and fetches nothing.
//
// .tabstrip styles `button` and keys its selected state off aria-selected /
// aria-pressed. These are links, so globals.css carries a matching
// `.tabstrip a` + `[aria-current="page"]` rule.

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/rfp", label: "Overview" },
  { href: "/rfp/knowledge", label: "Knowledge base" },
] as const;

export function RfpTabs() {
  const pathname = usePathname();

  return (
    <nav className="tabstrip" aria-label="RFP Response sections">
      {TABS.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          aria-current={pathname === tab.href ? "page" : undefined}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
