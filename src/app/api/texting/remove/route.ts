// Thin wrapper over @aicompany/core (README §2.1): unlinks the session's
// verified number — appends the opt-out consent row FIRST (remove IS an
// opt-out), then clears the users texting columns. Idempotent when no
// number is linked.
import { createTextingRemoveHandler } from "@aicompany/core/channels/texting";
import { siteConfig } from "site.config";

export const POST = createTextingRemoveHandler(siteConfig);
