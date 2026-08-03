// /llms.txt — module handler (packages/aicompany §19.1/§19.24).
// Host-authored summary from site.config seo.llmsTxt plus the module's
// latest-articles section; served with X-Robots-Tag: noindex by contract.
//
// The module handler is used deliberately rather than hand-rolling a route
// (2026-08-03 panel, seat 4): it is what emits the noindex header, and this
// file is a duplicate-content aggregate of canonical article pages. A
// hand-rolled route is how a host ends up serving an indexable duplicate of
// its own article list.
//
// force-dynamic is REQUIRED, not decorative: createLlmsTxt() reads the latest
// published articles from the database on every call, and that per-request
// generation is the whole reason no nightly regeneration pipeline exists
// (panel C2 — a nightly static writer would raise worst-case staleness from
// the ~1h CDN window to ~24h). A statically rendered route would freeze this
// file at build time and silently break that guarantee.
import { createLlmsTxtHandler } from "@aicompany/core/seo/llms-txt";
import { siteConfig } from "../../../site.config";

export const dynamic = "force-dynamic";

export const GET = createLlmsTxtHandler(siteConfig);
