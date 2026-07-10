// Thin wrapper over @aicompany/core (README §2.1).
import { MessagesPage } from "@aicompany/core/admin/pages";
import { siteConfig } from "site.config";

export const dynamic = "force-dynamic";

export default function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <MessagesPage config={siteConfig} searchParams={searchParams} />;
}
