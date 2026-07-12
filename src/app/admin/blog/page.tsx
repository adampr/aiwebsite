// Thin wrapper over @aicompany/core (README §2.1): /admin/blog (§19.10) —
// article list, gate results, publish/unpublish/regenerate/noindex controls,
// Run now, needs-attention strip.
import { BlogPage } from "@aicompany/core/admin/pages";
import { siteConfig } from "site.config";

export const dynamic = "force-dynamic";

export default function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <BlogPage config={siteConfig} searchParams={searchParams} />;
}
