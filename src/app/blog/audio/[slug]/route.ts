import { createBlogAudioHandler } from "@aicompany/core/blog/audio-route";

import { siteConfig } from "site.config";

// Serves the §19.33 default audio storage (blog_audio) — this path must match
// blog.audio.routePath, and the handler answers 400 (never 404) to a malformed
// slug so a mounted route is distinguishable from an unmounted one (doctor
// probes exactly that, §19.11). HEAD shares the handler: podcast clients and
// Apple's validator both HEAD the enclosure before fetching it.
export const GET = createBlogAudioHandler(siteConfig);
export const HEAD = GET;
