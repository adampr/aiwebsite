// Thin wrapper over @aicompany/core (README §2.1): the AI-news blog index
// (module §19.7). ISR keeps last-good pages serving between deploys.
import { BlogIndexPage } from "@aicompany/core/blog/index-page";
import { blogIndexMetadata } from "@aicompany/core/blog/metadata";
import { siteConfig } from "site.config";

export const revalidate = 60;

export async function generateMetadata(props: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Canonical (self per ?offset page), RSS alternate, noindex rules (§19.7).
  return blogIndexMetadata(siteConfig, "/blog", await props.searchParams);
}

export default function Page(props: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <BlogIndexPage config={siteConfig} prefix="/blog" searchParams={props.searchParams} />;
}
