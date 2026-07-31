// /rfp/knowledge/mine — knowledge you added (§5.17).
//
// Private rows are usable in YOUR drafts and nobody else's. They become
// shared only when an XL.net admin approves them, which mints a brand new
// fact rather than flipping a flag on this row.

import type { Metadata } from "next";
import { requireRfpPage } from "@/lib/rfp/access";
import { KnowledgeNav } from "../nav";
import { listMyKnowledge } from "@/lib/rfp/db";
import { when } from "@/lib/rfp/time";
import { AddKnowledge } from "./add";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  title: "Your knowledge",
  robots: { index: false, follow: false },
};

const STATUS: Record<string, { label: string; cls: string }> = {
  private: { label: "Yours only", cls: "badge" },
  submitted: { label: "Awaiting approval", cls: "badge badge--warn" },
  approved: { label: "In the shared base", cls: "badge badge--ok" },
  returned: { label: "Returned", cls: "badge badge--danger" },
};

export default async function MyKnowledgePage() {
  const gate = await requireRfpPage("/rfp/knowledge/mine");
  if (!gate.ok) return null;

  const rows = await listMyKnowledge(gate.user);

  return (
    <div className="space-y-10">
      <KnowledgeNav admin={gate.user.admin} />
      <div>
        <span className="sys-label">Your knowledge</span>
        <p className="mt-4 max-w-2xl">
          Anything you add here is usable in your own drafts straight away, and
          in nobody else&apos;s. Send a fact for approval and an XL.net admin
          decides whether it joins the shared base that everyone drafts from.
        </p>
      </div>

      <AddKnowledge />

      {rows.length === 0 ? (
        <div className="panel">
          <p className="text-faint">
            You have not added anything yet.
          </p>
        </div>
      ) : (
        <div className="panel">
          {rows.map((r, i) => {
            const s = STATUS[r.status] ?? STATUS.private;
            return (
              <div className={i > 0 ? "rfp-row" : undefined} key={r.id}>
                <div className="flex flex-wrap items-center gap-3">
                  <span className={s.cls}>{s.label}</span>
                  <span className="badge">{r.kind}</span>
                  {r.polarity === "negative" && (
                    <span className="badge">Negative</span>
                  )}
                  {r.factKey && (
                    <span className="mono text-xs text-faint">{r.factKey}</span>
                  )}
                  <span className="ml-auto text-xs text-faint">
                    {when(r.createdAt)}
                  </span>
                </div>
                <p className="mt-2">{r.statement}</p>
                {r.detail && (
                  <p className="mt-1 text-sm text-faint">{r.detail}</p>
                )}
                {r.status === "returned" && r.reviewNote && (
                  <p className="mt-2 text-sm">
                    <span className="text-faint">Returned by {r.reviewedBy}: </span>
                    {r.reviewNote}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
