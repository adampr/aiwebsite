import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession, isAdmin } from "@/lib/auth";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

const ADMIN_NAV = [
  { href: "/admin/analytics", label: "Analytics" },
  { href: "/admin/conversations", label: "Chats" },
  { href: "/admin/messages", label: "SMS" },
  { href: "/admin/mailbox", label: "Mailbox" },
  { href: "/admin/calls", label: "Calls" },
  { href: "/admin/contacts", label: "Contacts" },
  { href: "/admin/companies", label: "Companies" },
  { href: "/admin/seo", label: "SEO" },
  { href: "/admin/knowledge", label: "Knowledge" },
];

// Defense-in-depth: each admin page also guards itself, but the shared
// layout redirects non-admins before any page tree renders.
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session || !isAdmin(session.email)) redirect("/login");

  return (
    <div>
      <nav
        className="mb-8 flex flex-wrap items-center gap-x-6 gap-y-2 pb-4"
        style={{ borderBottom: "1px solid var(--xl-line)" }}
        aria-label="Admin navigation"
      >
        <span className="sys-label">Admin</span>
        {ADMIN_NAV.map((item) => (
          <Link key={item.href} href={item.href} className="text-sm no-underline">
            {item.label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
