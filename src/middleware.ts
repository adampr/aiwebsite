import { NextRequest, NextResponse } from "next/server";

// Two jobs, both ported from itsupportchicago:
//  1. CSRF origin check for the state-changing /api/admin/* routes (the
//     session cookie is sameSite=lax, but belt-and-braces).
//  2. Fire-and-forget page-view tracking into /api/internal/track. Disabled
//     entirely unless INTERNAL_TRACK_SECRET is set — no anonymous default.
const INTERNAL_SECRET = process.env.INTERNAL_TRACK_SECRET;

const SKIP_PREFIXES = [
  "/api/",
  "/_next/",
  "/admin", // don't count our own dashboard views
  "/auth/",
  "/favicon",
  "/robots",
  "/sitemap",
  "/opengraph-image",
];
const SKIP_EXTENSIONS = [
  ".css", ".js", ".png", ".jpg", ".svg", ".ico", ".webp",
  ".woff", ".woff2", ".ttf", ".txt", ".xml",
];
const BOT_PATTERN =
  /bot|crawl|spider|slurp|baidu|yandex|semrush|ahref|mj12|python|curl|wget/i;

function isTrackablePage(pathname: string, ua: string): boolean {
  if (SKIP_PREFIXES.some((p) => pathname.startsWith(p))) return false;
  if (SKIP_EXTENSIONS.some((ext) => pathname.endsWith(ext))) return false;
  if (BOT_PATTERN.test(ua)) return false;
  return true;
}

function simpleHash(str: string): string {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

export function middleware(request: NextRequest) {
  const { method, nextUrl } = request;
  const pathname = nextUrl.pathname;
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://ai.xl.net";

  // CSRF origin check — only the admin API mutates state from the browser.
  if (
    pathname.startsWith("/api/admin/") &&
    (method === "POST" || method === "DELETE" || method === "PATCH" || method === "PUT")
  ) {
    const expected = new URL(baseUrl).origin;
    const origin = request.headers.get("origin");
    const referer = request.headers.get("referer");
    // Compare parsed origins, never a prefix — startsWith(baseUrl) would let
    // https://ai.xl.net.evil.com/ through.
    let allowed = false;
    if (origin) {
      allowed = origin === expected;
    } else if (referer) {
      try {
        allowed = new URL(referer).origin === expected;
      } catch {
        allowed = false;
      }
    }
    if (!allowed) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  // Page-view tracking
  const ua = request.headers.get("user-agent") || "";
  if (INTERNAL_SECRET && method === "GET" && isTrackablePage(pathname, ua)) {
    const ip =
      request.headers.get("cf-connecting-ip") ||
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      "unknown";
    const dateStr = new Date().toISOString().slice(0, 10);
    const sessionHash = simpleHash(`${ip}|${ua}|${dateStr}`);
    const referrer = request.headers.get("referer") || "";

    const sp = nextUrl.searchParams;
    const landingUrl = nextUrl.search ? `${pathname}${nextUrl.search}` : undefined;

    // Fire-and-forget — never delays the page
    fetch(`${baseUrl}/api/internal/track`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-track-secret": INTERNAL_SECRET,
      },
      body: JSON.stringify({
        path: pathname,
        referrer,
        ip,
        userAgent: ua,
        sessionHash,
        landingUrl,
        utmSource: sp.get("utm_source") || undefined,
        utmMedium: sp.get("utm_medium") || undefined,
        utmCampaign: sp.get("utm_campaign") || undefined,
        utmTerm: sp.get("utm_term") || undefined,
        utmContent: sp.get("utm_content") || undefined,
      }),
    }).catch(() => {});
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico).*)"],
};
