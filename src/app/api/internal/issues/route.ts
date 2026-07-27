// Thin wrapper over @aicompany/core (module §5.15): the issue-ledger ingest
// and read surface. The VM watchdog drains its alert spool here over loopback;
// the dev-box synth sweep and scripts/issues.mjs use it over public HTTPS.
// Fail closed — without ISSUE_TRACKER_SECRET every request is rejected.
import { createIssuesHandler } from "@aicompany/core/issues/api";
import { siteConfig } from "site.config";

export const { GET, POST } = createIssuesHandler(siteConfig);
