"use client";

// Second-level strip inside the knowledge section. Shared / yours / review.

import Link from "next/link";
import { usePathname } from "next/navigation";

export function KnowledgeNav({ admin }: { admin: boolean }) {
  const pathname = usePathname();
  const items = [
    { href: "/rfp/knowledge", label: "Shared" },
    { href: "/rfp/knowledge/mine", label: "Yours" },
    ...(admin
      ? [{ href: "/rfp/knowledge/review", label: "Review queue" }]
      : []),
  ];
  return (
    <nav className="tabstrip mb-6" aria-label="Knowledge views">
      {items.map((i) => (
        <Link
          key={i.href}
          href={i.href}
          aria-current={pathname === i.href ? "page" : undefined}
        >
          {i.label}
        </Link>
      ))}
    </nav>
  );
}
