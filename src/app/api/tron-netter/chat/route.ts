// Thin wrapper over @aicompany/core (README §2.1): the module owns the chat
// streaming pipeline; site behavior/copy live in site.config.ts.
import { createChatHandler } from "@aicompany/core/channels/chat";
import { siteConfig } from "site.config";

export const POST = createChatHandler(siteConfig);
