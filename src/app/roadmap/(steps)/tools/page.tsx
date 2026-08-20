// Roadmap step 11: AI Builder Tools (§5.20). A card per tool, paginated
// the same way the rest of the portal's lists are (the shared
// src/components/list-pager.tsx, NEVER src/app/work/pager.tsx, which
// mutates server-owned DOM and renders invisible off /work).
//
// The step completes with the FIRST tool whose link is confirmed
// (owner directive 2026-08-20: the instructions link is informational on
// tool cards); everything after that is depth, not progress.

import type { Metadata } from "next";
import { countTools, listTools } from "@/lib/roadmap/db";
import { ROADMAP_CAPS } from "@/lib/roadmap/config";
import { readPlatformPage } from "@/lib/roadmap/platform-page";
import { publicRow } from "@/lib/roadmap/platform-check";
import { toolCounts } from "@/lib/roadmap/platform";
import { ToolsManager } from "@/components/roadmap/platform-islands";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "AI Builder Tools · Your AI Roadmap",
  robots: { index: false, follow: false },
};

const faint = { color: "var(--xl-text-faint)" } as const;

export default async function RoadmapToolsPage() {
  const view = await readPlatformPage("/roadmap/tools");
  if (!view.ok) return null;

  // countTools is the UNTRUNCATED total, so the page can say plainly when
  // the render cap is hiding rows rather than quietly showing fewer.
  const [rows, total] = await Promise.all([
    listTools(view.scope, ROADMAP_CAPS.toolsMax),
    countTools(view.scope),
  ]);
  const counted = rows.filter(toolCounts).length;

  return (
    <div className="space-y-12">
      <section>
        <span className="sys-label">Step 11 · AI Builder Tools</span>
        <h1 className="mt-4">The tools your builders are cleared to use</h1>
        <p className="mt-4 max-w-3xl text-sm">
          A short, current list beats a long, stale one. Give each tool
          {" "}{view.ownerName} has approved a card here: what it is for, a
          link to it, and a link to how to get started. The step completes with
          the first tool whose link checks out.
        </p>
      </section>

      <ToolsManager
        initial={rows.map((r) => publicRow(r, view.internalDomain))}
        isAdmin={view.isAdmin}
        truncated={total > rows.length}
      />

      <section>
        <p className="mono text-xs" style={faint}>
          {counted > 0
            ? `${counted} of ${rows.length} listed ${rows.length === 1 ? "tool is" : "tools are"} counting toward this step.`
            : "Nothing is counting toward this step yet."}
        </p>
      </section>
    </div>
  );
}
