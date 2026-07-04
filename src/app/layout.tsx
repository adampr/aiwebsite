import type { Metadata } from "next";
import Link from "next/link";
import { Poppins } from "next/font/google";
import { ThemeToggle } from "@/components/theme-toggle";
import { TronNetterChat } from "@/components/tron-netter-chat";
import "./globals.css";

const poppins = Poppins({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  display: "swap",
  variable: "--font-poppins",
});

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
    <html lang="en" className={poppins.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `(function(){try{var t=localStorage.getItem('theme');if(t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme:dark)').matches))document.documentElement.classList.add('dark')}catch(e){}})()` }} />
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
      <body className="min-h-screen bg-white text-neutral-900 antialiased dark:bg-neutral-950 dark:text-neutral-100">
        <a href="#main-content" className="skip-to-content">
          Skip to content
        </a>

        <header className="header-tint border-b border-neutral-200 dark:border-neutral-800">
          <nav
            className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-6 py-4"
            aria-label="Main navigation"
          >
            <Link href="/" className="flex items-center gap-2 text-lg font-bold no-underline">
              <span className="text-[var(--xl-primary)]">XL.net</span>
              <span className="rounded bg-[var(--xl-primary)] px-1.5 py-0.5 text-xs font-semibold text-white">AI</span>
            </Link>
            <div className="flex flex-wrap items-center gap-4 text-sm sm:gap-6">
              <Link
                href="/"
                className="text-neutral-600 hover:text-[#010205] dark:text-neutral-400 dark:hover:text-white"
              >
                Home
              </Link>
              <Link
                href="/contact"
                className="text-neutral-600 hover:text-[#010205] dark:text-neutral-400 dark:hover:text-white"
              >
                Contact
              </Link>
              <ThemeToggle />
            </div>
          </nav>
        </header>

        <main id="main-content" className="mx-auto max-w-7xl px-6 py-8">
          {children}
        </main>

        <footer className="border-t border-neutral-200 dark:border-neutral-800">
          <div className="footer-tint">
            <div className="mx-auto max-w-7xl px-6 py-8">
              <div className="grid gap-8 sm:grid-cols-3">
                <div>
                  <h3 className="font-semibold">
                    XL.net AI
                  </h3>
                  <p className="mt-2 text-sm">
                    Showcasing how XL.net leverages artificial intelligence to
                    transform managed IT services for SMBs.
                  </p>
                </div>
                <div>
                  <h3 className="font-semibold">Links</h3>
                  <ul className="mt-2 space-y-1 text-sm">
                    <li>
                      <Link href="/" className="text-neutral-600 hover:text-[#010205] dark:text-neutral-400 dark:hover:text-white">Home</Link>
                    </li>
                    <li>
                      <Link href="/contact" className="text-neutral-600 hover:text-[#010205] dark:text-neutral-400 dark:hover:text-white">Contact</Link>
                    </li>
                    <li>
                      <a href="https://xl.net" target="_blank" rel="noopener noreferrer" className="text-neutral-600 hover:text-[#010205] dark:text-neutral-400 dark:hover:text-white">XL.net Main Site</a>
                    </li>
                  </ul>
                </div>
                <div>
                  <h3 className="font-semibold">
                    Contact
                  </h3>
                  <p className="mt-2 text-sm">
                    <a href="mailto:ai@xl.net" className="link-accent">
                      ai@xl.net
                    </a>
                  </p>
                  <p className="mt-1 text-sm">
                    <a href="https://xl.net" target="_blank" rel="noopener noreferrer" className="link-accent">
                      xl.net
                    </a>
                  </p>
                </div>
              </div>
            </div>
          </div>
          <div className="mx-auto max-w-7xl px-6 py-4 text-center text-xs text-neutral-500 dark:text-neutral-400">
            &copy; <span suppressHydrationWarning>{new Date().getFullYear()}</span> XL.net. All rights reserved.
          </div>
        </footer>
        <TronNetterChat />
      </body>
    </html>
  );
}
