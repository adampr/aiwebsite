// Thin wrapper over @aicompany/core (README §2.1): the module maps these
// site-relative paths onto site.baseUrl; the host owns the entry list's
// completeness. blogSitemapEntries excludes noindexed rows, everything under
// blog.indexing="noindex", and the /blog index URL while 0 published (§19.7).
import { blogSitemapEntries } from "@aicompany/core/blog/sitemap";
import { createSitemap } from "@aicompany/core/seo/sitemap";
import { siteConfig } from "site.config";

// Without this the route is baked at build time and nightly-published blog
// articles never enter the sitemap until the next deploy rebuilds it.
export const revalidate = 3600;

// lastmod per static page (§21 scorecard row `sitemap-lastmod`, which found
// 10 of 26 locs carrying no <lastmod> — every one of them a host page, while
// blogSitemapEntries has always emitted last_material_update_at for articles).
//
// THE RULE: a REAL content timestamp or NOTHING. Never `new Date()`.
// itsupportchicago's QA-058 restamped 117 URLs on every hourly ISR
// regeneration, which teaches crawlers to ignore lastmod on the domain
// entirely — strictly worse than omitting it. Note `revalidate = 3600` above:
// this route re-renders hourly, so a computed date here would be exactly that
// defect.
//
// Real dates of last material change, from `git log -1 --format=%cs -- <file>`
// on 2026-07-28. **Update the entry when you materially change the page.**
// Stale-but-true is fine — it says "this has not changed". A date that moves
// without the content moving is a lie the crawler learns from.
const STATIC_LASTMOD: Record<string, string> = {
  "/": "2026-07-23",
  "/work": "2026-08-05",
  "/builders": "2026-08-26",
  "/governance": "2026-07-21",
  // §5.18: the /roadmap TEASER only — portal child paths are noindex and
  // the check-roadmap-caching gate bans any child-path string in this file.
  "/roadmap": "2026-08-05",
  // 2026-08-13: was "2026-07-13" — stale by 24 days. Commit d7f5dba (2026-08-06)
  // expanded /contact 216w -> 467w as the remediation for the open
  // seo/money-page-indexed row, and touched only contact/page.tsx, so the
  // sitemap kept asserting the page was unchanged since July. That is the one
  // signal that invites a re-fetch, pointed the wrong way, on the single URL
  // the row is about. Necessary, not sufficient: Google has not re-downloaded
  // this sitemap since 2026-07-17 (both sibling hosts are fetched daily).
  "/contact": "2026-08-06",
  "/methodology": "2026-07-25",
  "/privacy": "2026-07-16",
  "/sms-terms": "2026-07-10",
  "/texting": "2026-07-10",
};

// Bare "YYYY-MM-DD" parses as UTC midnight — no timezone drift makes a date
// appear to move.
const lm = (path: string) => new Date(STATIC_LASTMOD[path]);

// /work also changes when a team-submitted card publishes (§5.16, no deploy
// involved), so its lastmod is max(hand-maintained floor, latest publish).
// A publish IS a real content change, so this does not violate the rule
// above; the hand date stays the floor (the value can never regress below
// it or go null), and a DB error falls back to the floor.
async function workLastmod(): Promise<Date> {
  const floor = lm("/work");
  try {
    const { latestPublishedAt } = await import("@/lib/work/db");
    const latest = await latestPublishedAt();
    if (latest && new Date(latest).getTime() > floor.getTime())
      return new Date(latest);
  } catch {
    // fall through to the floor
  }
  return floor;
}

const staticEntries = (workDate: Date) => createSitemap(siteConfig, [
  { path: "/", lastModified: lm("/") },
  { path: "/work", lastModified: workDate },
  { path: "/builders", lastModified: lm("/builders") },
  { path: "/governance", lastModified: lm("/governance") },
  { path: "/roadmap", lastModified: lm("/roadmap") },
  { path: "/contact", lastModified: lm("/contact") },
  { path: "/methodology", lastModified: lm("/methodology") },
  { path: "/privacy", lastModified: lm("/privacy") },
  { path: "/sms-terms", lastModified: lm("/sms-terms") },
  { path: "/texting", lastModified: lm("/texting") },
]);

export default async function sitemap() {
  return [
    ...staticEntries(await workLastmod())(),
    ...(await blogSitemapEntries(siteConfig)),
  ];
}
