// Thin wrapper over @aicompany/core (README §2.1).
import { CallsPage } from "@aicompany/core/admin/pages";
import { siteConfig } from "site.config";

export const dynamic = "force-dynamic";

export default function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <CallsPage config={siteConfig} searchParams={searchParams} />;
}
