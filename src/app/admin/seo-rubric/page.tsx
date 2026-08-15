// Thin wrapper over @aicompany/core (module §21.19): renders the weekly
// rubric record the dev-box scorer pushed — never re-scores anything.
import { SeoRubricPage } from "@aicompany/core/admin/pages";
import { siteConfig } from "site.config";

export const dynamic = "force-dynamic";

export default function Page() {
  return <SeoRubricPage config={siteConfig} />;
}
