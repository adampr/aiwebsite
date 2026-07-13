import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Account Settings",
  description:
    "Manage your XL.net AI account: your verified phone number, texting opt-in with Tron Netter, and messaging preferences.",
  alternates: { canonical: "/account" },
};

export default function AccountLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return children;
}
