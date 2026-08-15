// Thin wrapper over @aicompany/core (module §21.19): weekly rubric-record
// ingest + read surface. Sole legitimate writer: the dev-box scorer's push
// leg. Fail closed — without ISSUE_TRACKER_SECRET every request is rejected.
import { createSeoRubricHandler } from "@aicompany/core/seo/rubric-api";
import { siteConfig } from "site.config";

export const { GET, POST } = createSeoRubricHandler(siteConfig);
