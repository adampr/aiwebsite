export type TrafficSource =
  | "organic"
  | "direct"
  | "social"
  | "referral"
  | "email"
  | "paid";

const SEARCH_ENGINES = [
  "google.",
  "bing.com",
  "yahoo.com",
  "duckduckgo.com",
  "baidu.com",
  "yandex.",
  "ecosia.org",
  "search.brave.com",
  "startpage.com",
];

const SOCIAL_DOMAINS = [
  "linkedin.com",
  "facebook.com",
  "twitter.com",
  "x.com",
  "reddit.com",
  "youtube.com",
  "instagram.com",
  "threads.net",
  "tiktok.com",
  "pinterest.com",
  "t.co",
];

const EMAIL_DOMAINS = [
  "mail.google.com",
  "outlook.live.com",
  "outlook.office.com",
  "mail.yahoo.com",
  "mail.aol.com",
];

function extractHostname(referrer: string): string {
  try {
    return new URL(referrer).hostname.toLowerCase();
  } catch {
    return referrer.toLowerCase();
  }
}

export function classifyReferrer(
  referrer: string | null | undefined,
  utm?: { utmSource?: string | null; utmMedium?: string | null },
): TrafficSource {
  const medium = utm?.utmMedium?.toLowerCase();
  if (medium === "cpc" || medium === "paid") return "paid";

  const source = utm?.utmSource?.toLowerCase();
  if (source === "email" || source === "newsletter") return "email";

  if (!referrer || referrer.trim() === "") {
    if (source) return "referral";
    return "direct";
  }

  const lower = referrer.toLowerCase();
  if (lower.includes("utm_medium=cpc") || lower.includes("utm_medium=paid") || lower.includes("gclid=")) {
    return "paid";
  }

  const host = extractHostname(referrer);

  if (EMAIL_DOMAINS.some((d) => host.includes(d))) return "email";
  if (SEARCH_ENGINES.some((d) => host.includes(d))) return "organic";
  if (SOCIAL_DOMAINS.some((d) => host.includes(d))) return "social";

  return "referral";
}

export function extractDomain(referrer: string | null | undefined): string | null {
  if (!referrer || referrer.trim() === "") return null;
  try {
    const host = new URL(referrer).hostname;
    return host.replace(/^www\./, "");
  } catch {
    return null;
  }
}
