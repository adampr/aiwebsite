// Thin wrapper over @aicompany/core (README §2.1): internal sink for the
// tracking middleware's page-view beacons. Fail closed — without
// INTERNAL_TRACK_SECRET every request is rejected and middleware sends none.
import { createTrackHandler } from "@aicompany/core/tracking/track-api";
import { siteConfig } from "site.config";

export const POST = createTrackHandler(siteConfig);
