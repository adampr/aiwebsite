"use client";

// Host wrapper around the module's <ChatWidget/> (§5.17).
//
// The public widget is the marketing-persona Tron on its own session
// namespace with no document context. Inside an RFP workspace that is a trust
// bug: two Tron affordances on one screen, one of which cannot see the draft
// it is being asked about, and a floating launcher that lands on top of the
// workspace rail. The in-draft Tron is the one that can actually help there.
//
// A wrapper rather than a prop because ChatWidgetProps has no route exclusion
// (pageContext.excludePaths suppresses context capture only, never the
// launcher), and packages/aicompany is a submodule this host does not modify.

import { usePathname } from "next/navigation";
import { ChatWidget } from "@aicompany/core/components/chat-widget";
import type { ComponentProps } from "react";

export function ChatWidgetMount(props: ComponentProps<typeof ChatWidget>) {
  const pathname = usePathname();
  if (pathname.startsWith("/rfp/r/")) return null;
  return <ChatWidget {...props} />;
}
