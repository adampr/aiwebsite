import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Account Settings",
  description:
    "Manage your XL.net AI account: your verified phone number, texting opt-in with Tron Netter, and messaging preferences.",
  alternates: { canonical: "/account" },
  // W-AUDIT 2026-07-26: thin logged-out settings page, linked sitewide,
  // was index,follow with a self-canonical — classic index bloat.
  robots: { index: false, follow: false },
};

export default function AccountLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return children;
}
