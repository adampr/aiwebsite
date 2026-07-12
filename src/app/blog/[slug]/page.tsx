// Thin wrapper over @aicompany/core (README §2.1): one AI-news article
// (module §19.7). ISR: warm-cache article pages keep serving last-good
// between deploys.
import { BlogArticlePage } from "@aicompany/core/blog/article-page";
import { blogArticleMetadata } from "@aicompany/core/blog/metadata";
import { siteConfig } from "site.config";

export const revalidate = 60;

export async function generateMetadata(props: { params: Promise<{ slug: string }> }) {
  // Canonical, OG article, og:image fallback chain, noindex rules (§19.7).
  const { slug } = await props.params;
  return blogArticleMetadata(siteConfig, "/blog", slug);
}

export default function Page(props: { params: Promise<{ slug: string }> }) {
  return <BlogArticlePage config={siteConfig} prefix="/blog" params={props.params} />;
}
