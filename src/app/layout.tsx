import type { Metadata } from "next";
import Link from "next/link";
import Script from "next/script";
import { ChatWidget } from "@aicompany/core/components/chat-widget";
import {
  toChatWidgetProps,
  toSmsPromptCardProps,
  toUserMenuProps,
} from "@aicompany/core/components/props";
import { SmsPromptCard } from "@aicompany/core/components/sms-prompt-card";
import { themeScript } from "@aicompany/core/components/theme-script";
import { ThemeToggle } from "@aicompany/core/components/theme-toggle";
import { UserMenu } from "@aicompany/core/components/user-menu";
import { OrgJsonLdScript } from "@aicompany/core/seo/org-jsonld";
import { siteConfig } from "site.config";
import { FuturismFx } from "@/components/futurism-fx";
import { EmailLink } from "@/components/email-link";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "XL.net AI | Showcasing AI Innovation",
    template: "%s | XL.net AI",
  },
  description:
    "Discover how XL.net leverages artificial intelligence to transform managed IT services. Explore our AI accomplishments, innovations, and capabilities.",
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_BASE_URL || "https://ai.xl.net"
  ),
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    siteName: "XL.net AI",
    images: ["/xl-icon-512.png"],
  },
  twitter: {
    card: "summary_large_image",
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true },
  },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "48x48" },
      { url: "/xl-icon-192.png", type: "image/png", sizes: "192x192" },
      { url: "/xl-icon.svg", type: "image/svg+xml" },
    ],
    apple: "/xl-icon-180.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript(true) }} />
        <noscript>
          <style>{`.rise{opacity:1 !important;transform:none !important}`}</style>
        </noscript>
        <OrgJsonLdScript config={siteConfig} />
      </head>
      <body className="min-h-screen antialiased">
        <a href="#main-content" className="skip-to-content">
          Skip to content
        </a>

        {/* Sticky only from md up: on phones the 4-row wrapped header would
            otherwise occupy a third of the viewport and bury anchor targets. */}
        <header className="md:sticky md:top-0 z-40">
          <nav className="nav" aria-label="Main navigation">
            <Link
              href="/"
              className="flex items-center gap-3 no-underline"
              aria-label="XL.net AI home"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/xl-icon.svg" alt="" className="h-8 w-8" />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/brand/xl-wordmark-dark.png"
                alt="XL.net"
                className="theme-dark-only h-5 w-auto"
              />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/brand/xl-wordmark-light.png"
                alt="XL.net"
                className="theme-light-only h-5 w-auto"
              />
            </Link>
            <span className="badge badge--light">AI</span>
            <div className="ml-auto flex flex-wrap items-center gap-8">
              <Link href="/">Home</Link>
              <Link href="/work">Our Work</Link>
              <Link href="/builders">AI Builders</Link>
              <Link href="/blog">AI News</Link>
              <Link href="/contact">Contact</Link>
              <ThemeToggle />
              <UserMenu {...toUserMenuProps(siteConfig)} />
            </div>
          </nav>
        </header>

        {/* pb-24 keeps the last content line (e.g. /texting compliance fine
            print) scrollable above the 56px module chat launcher. */}
        <main id="main-content" className="mx-auto max-w-7xl px-6 pt-12 pb-24">
          {children}
        </main>

        <footer className="mt-24">
          <div className="mx-auto max-w-7xl px-6">
            <hr className="rule" />
            <div className="grid gap-x-12 gap-y-10 pb-12 sm:grid-cols-5 lg:grid-cols-[minmax(0,1fr)_auto_auto]">
              <div className="sm:col-span-5 lg:col-span-1">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/brand/xl-wordmark-dark.png"
                  alt="XL.net AI"
                  className="theme-dark-only h-6 w-auto"
                />
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/brand/xl-wordmark-light.png"
                  alt="XL.net AI"
                  className="theme-light-only h-6 w-auto"
                />
                <p className="mt-4 max-w-sm text-sm">
                  Showcasing how XL.net leverages artificial intelligence to
                  transform managed IT services for SMBs.
                </p>
              </div>
              <div className="sm:col-span-3 lg:col-span-1">
                <span className="sys-label">Links</span>
                <ul className="mt-4 grid gap-y-2 text-sm sm:grid-flow-col sm:grid-cols-[max-content_max-content] sm:grid-rows-6 sm:gap-x-10">
                  <li>
                    <Link href="/">Home</Link>
                  </li>
                  <li>
                    <Link href="/work">Our Work</Link>
                  </li>
                  <li>
                    <Link href="/builders">AI Builders</Link>
                  </li>
                  <li>
                    <Link href="/blog">AI News</Link>
                  </li>
                  <li>
                    <Link href="/contact">Contact</Link>
                  </li>
                  <li>
                    <Link href="/texting">Text with Tron Netter</Link>
                  </li>
                  <li>
                    <Link href="/account">Account</Link>
                  </li>
                  <li>
                    <Link href="/methodology">Methodology</Link>
                  </li>
                  <li>
                    <Link href="/privacy">Privacy Policy</Link>
                  </li>
                  <li>
                    <Link href="/sms-terms">SMS Terms</Link>
                  </li>
                  <li>
                    <a
                      href="https://xl.net"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      XL.net Main Site
                    </a>
                  </li>
                </ul>
              </div>
              <div className="sm:col-span-2 lg:col-span-1">
                <span className="sys-label">Contact</span>
                <ul className="mt-4 space-y-2 text-sm">
                  <li>
                    <EmailLink email="Tron.Netter@ai.xl.net" className="mono" />
                  </li>
                  <li>
                    <a href="tel:+18723504325" className="mono">
                      (872) 350-4325
                    </a>
                  </li>
                  <li>
                    <a
                      href="https://xl.net"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mono"
                    >
                      xl.net
                    </a>
                  </li>
                </ul>
              </div>
            </div>
            <div
              className="pb-8 text-center text-xs"
              style={{ color: "var(--xl-text-faint)" }}
            >
              &copy;{" "}
              <span suppressHydrationWarning>{new Date().getFullYear()}</span>{" "}
              XL.net. All rights reserved.
            </div>
          </div>
        </footer>
        <ChatWidget {...toChatWidgetProps(siteConfig)} />
        <SmsPromptCard {...toSmsPromptCardProps(siteConfig)} />
        <FuturismFx />
        <Script src="/fx.js" strategy="afterInteractive" />
      </body>
    </html>
  );
}
