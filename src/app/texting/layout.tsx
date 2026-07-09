import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Text with Tron Netter",
  description:
    "Opt in to text messaging with Tron Netter, XL.net's AI agent. Verify your mobile number to get started.",
  alternates: { canonical: "/texting" },
};

export default function TextingLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return children;
}
