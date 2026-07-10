// Thin wrapper over @aicompany/core (README §2.1). Manually kicks the nightly
// knowledge crawl — the module handler spawns scripts/refresh-knowledge.mjs
// detached (node child_process, hence the explicit runtime), logging to
// data/knowledge-refresh-manual.log.
import { createAdminKnowledgeRefreshHandler } from "@aicompany/core/admin/api";
import { siteConfig } from "site.config";

export const runtime = "nodejs";

export const { GET, POST } = createAdminKnowledgeRefreshHandler(siteConfig);
