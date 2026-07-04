import type { Metadata } from "next";
import Link from "next/link";
import Script from "next/script";
import { ThemeToggle } from "@/components/theme-toggle";
import { TronNetterChat } from "@/components/tron-netter-chat";
import { FuturismFx } from "@/components/futurism-fx";
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
  },
  twitter: {
    card: "summary_large_image",
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true },
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
        <script dangerouslySetInnerHTML={{ __html: `(function(){try{var e=document.documentElement,t=localStorage.getItem('theme'),d=t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme:dark)').matches);if(d){e.classList.add('dark')}else{e.setAttribute('data-theme','light')}}catch(e){}})()` }} />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "Organization",
              name: "XL.net",
              url: "https://xl.net",
              description: "Strategic IT for SMBs. SOC 2 Type II + ISO 27001:2022 certified managed IT services provider in Chicago.",
              address: {
                "@type": "PostalAddress",
                addressLocality: "Chicago",
                addressRegion: "IL",
                addressCountry: "US",
              },
            }),
          }}
        />
      </head>
      <body className="min-h-screen antialiased">
        <a href="#main-content" className="skip-to-content">
          Skip to content
        </a>

        <header className="sticky top-0 z-40">
          <nav className="nav" aria-label="Main navigation">
            <Link href="/" className="logo no-underline">
              XL<em>.NET</em>
            </Link>
            <span className="badge badge--light">AI</span>
            <div className="ml-auto flex flex-wrap items-center gap-8">
              <Link href="/">Home</Link>
              <Link href="/contact">Contact</Link>
              <ThemeToggle />
            </div>
          </nav>
        </header>

        <main id="main-content" className="mx-auto max-w-7xl px-6 py-12">
          {children}
        </main>

        <footer className="mt-24">
          <div className="mx-auto max-w-7xl px-6">
            <hr className="rule" />
            <div className="grid gap-12 pb-12 sm:grid-cols-3">
              <div>
                <div className="logo">
                  XL<em>.NET</em> AI
                </div>
                <p className="mt-4 text-sm">
                  Showcasing how XL.net leverages artificial intelligence to
                  transform managed IT services for SMBs.
                </p>
              </div>
              <div>
                <span className="sys-label">Links</span>
                <ul className="mt-4 space-y-2 text-sm">
                  <li>
                    <Link href="/">Home</Link>
                  </li>
                  <li>
                    <Link href="/contact">Contact</Link>
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
              <div>
                <span className="sys-label">Contact</span>
                <ul className="mt-4 space-y-2 text-sm">
                  <li>
                    <a href="mailto:ai@xl.net" className="mono">
                      ai@xl.net
                    </a>
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
        <TronNetterChat />
        <FuturismFx />
        <Script src="/fx.js" strategy="afterInteractive" />
      </body>
    </html>
  );
}
