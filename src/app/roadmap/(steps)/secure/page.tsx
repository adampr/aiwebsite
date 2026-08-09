// Roadmap step 09: Secure AI Builders (§5.20). TWO independent components
// on one page, either of which alone earns half the step: an API proxy
// (endpoint + instructions) and Developer VMs (hosting environments +
// instructions).
//
// COPY DISCIPLINE FOR THIS STEP: the title says "Secure" because the step
// is about giving builders a sanctioned path instead of letting them find
// their own. Nothing on this page may suggest XL.net inspected, tested or
// approved what is behind these addresses. All we ever establish is that
// the address answered us.

import type { Metadata } from "next";
import { listRoadmapLinks } from "@/lib/roadmap/db";
import { readPlatformPage } from "@/lib/roadmap/platform-page";
import { publicRow } from "@/lib/roadmap/platform-check";
import { secureView } from "@/lib/roadmap/platform";
import { SingletonForm } from "@/components/roadmap/platform-islands";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Secure AI Builders · Your AI Roadmap",
  robots: { index: false, follow: false },
};

const faint = { color: "var(--xl-text-faint)" } as const;

export default async function RoadmapSecurePage() {
  const view = await readPlatformPage("/roadmap/secure");
  if (!view.ok) return null;

  const rows = await listRoadmapLinks(view.scope);
  const secure = secureView(rows);
  const apiProxy = secure.apiProxy.row ? publicRow(secure.apiProxy.row) : null;
  const devVms = secure.devVms.row ? publicRow(secure.devVms.row) : null;

  return (
    <div className="space-y-12">
      <section>
        <span className="sys-label">Step 09 · Secure AI Builders</span>
        <h1 className="mt-4">A sanctioned way for builders to build</h1>
        <p className="mt-4 max-w-3xl text-sm">
          Builders who have no approved way to reach models or machines will
          find their own, on personal accounts you cannot see. This step is
          where {view.ownerName} writes down the two things that prevent
          that: the AI endpoint your people should call, and the machines
          they should build on. Each one needs its instructions link too, and
          we have to be able to reach what you list. Finish either component
          to earn half this step, both to complete it.
        </p>
      </section>

      <section className="grid gap-6 md:grid-cols-2">
        <div className="panel">
          <span className="sys-label">Component 1</span>
          <h2 className="mt-4 text-lg">API proxy</h2>
          <p className="mt-3 text-sm">
            The endpoint your builders call instead of going direct, so keys,
            spend and logging stay with you. Include the port if it needs one.
          </p>
          <SingletonForm
            kind="api_proxy"
            initial={apiProxy}
            isAdmin={view.isAdmin}
            urlLabel="Proxy address"
            urlHint="A full address, for example https://ai-proxy.example.com:8443"
            docsLabel="Instructions for builders"
          />
        </div>

        <div className="panel">
          <span className="sys-label">Component 2</span>
          <h2 className="mt-4 text-lg">Developer VMs</h2>
          <p className="mt-3 text-sm">
            Where your builders get a machine to work on. Pick every hosting
            environment you use, add your own if it is not listed, and point
            at the instructions for getting one.
          </p>
          <SingletonForm
            kind="dev_vms"
            initial={devVms}
            isAdmin={view.isAdmin}
            docsLabel="Instructions for getting a machine"
            withEnvironments
          />
        </div>
      </section>

      <section>
        <p className="mono text-xs" style={faint}>
          {secure.done
            ? "Both components are listed and confirmed. This step is complete."
            : secure.partial
              ? "Half of this step is done. Add the other component to finish it."
              : "Nothing is counting toward this step yet."}
        </p>
      </section>
    </div>
  );
}
