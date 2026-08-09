// Roadmap step 10: Data Access (§5.20). One component: the lakehouse
// address plus the instructions that explain how to connect to it.

import type { Metadata } from "next";
import { listRoadmapLinks } from "@/lib/roadmap/db";
import { readPlatformPage } from "@/lib/roadmap/platform-page";
import { publicRow } from "@/lib/roadmap/platform-check";
import { lakehouseView } from "@/lib/roadmap/platform";
import { SingletonForm } from "@/components/roadmap/platform-islands";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Data Access · Your AI Roadmap",
  robots: { index: false, follow: false },
};

const faint = { color: "var(--xl-text-faint)" } as const;

export default async function RoadmapDataPage() {
  const view = await readPlatformPage("/roadmap/data");
  if (!view.ok) return null;

  const rows = await listRoadmapLinks(view.scope);
  const lakehouse = lakehouseView(
    rows.find((r) => r.kind === "lakehouse") ?? null
  );
  const row = lakehouse.row ? publicRow(lakehouse.row) : null;

  return (
    <div className="space-y-12">
      <section>
        <span className="sys-label">Step 10 · Data Access</span>
        <h1 className="mt-4">Point your builders at the data</h1>
        <p className="mt-4 max-w-3xl text-sm">
          The best AI work at {view.ownerName} will come from people who can
          reach real company data instead of guessing at it. Put the address
          of your lakehouse here, with the instructions that say how to
          connect and what the rules are.
        </p>
      </section>

      <section className="mx-auto max-w-2xl">
        <div className="panel">
          <span className="sys-label">Lakehouse</span>
          <h2 className="mt-4 text-lg">Where the data lives</h2>
          <p className="mt-3 text-sm">
            The address your builders use to reach it. Include the port if it
            needs one.
          </p>
          <SingletonForm
            kind="lakehouse"
            initial={row}
            isAdmin={view.isAdmin}
            urlLabel="Lakehouse address"
            urlHint="A full address, for example https://lakehouse.example.com:443"
            docsLabel="Instructions for connecting"
          />
        </div>
      </section>

      <section>
        <p className="mono text-xs" style={faint}>
          {lakehouse.enabled
            ? "The lakehouse and its instructions are confirmed. This step is complete."
            : "Nothing is counting toward this step yet."}
        </p>
      </section>
    </div>
  );
}
