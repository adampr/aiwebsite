"use client";

// Section sub-nav. A client component only because it reads the pathname to
// mark the active tab; it holds no session state and fetches nothing.
//
// The active predicate is NOT `pathname === href`. Nested routes such as
// /rfp/knowledge/mine and /rfp/r/<id> would then leave no tab marked, and the
// RFPs tab in particular owns three siblings with no common prefix
// (/rfp/list, /rfp/new, /rfp/r/...), so each tab carries its own match list.

import Link from "next/link";
import { usePathname } from "next/navigation";

type Tab = { href: string; label: string; match: string[]; adminOnly?: boolean };

const TABS: Tab[] = [
  { href: "/rfp", label: "Overview", match: [] },
  { href: "/rfp/list", label: "RFPs", match: ["/rfp/list", "/rfp/new", "/rfp/r"] },
  { href: "/rfp/knowledge", label: "Knowledge base", match: ["/rfp/knowledge"] },
  { href: "/rfp/admin/activity", label: "Activity", match: ["/rfp/admin"], adminOnly: true },
];

function isActive(tab: Tab, pathname: string): boolean {
  if (tab.href === "/rfp") return pathname === "/rfp";
  return tab.match.some(
    (m) => pathname === m || pathname.startsWith(m + "/")
  );
}

export function RfpTabs({ admin }: { admin: boolean }) {
  const pathname = usePathname();

  return (
    <nav className="tabstrip" aria-label="RFP Response sections">
      {TABS.filter((t) => !t.adminOnly || admin).map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          aria-current={isActive(tab, pathname) ? "page" : undefined}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
