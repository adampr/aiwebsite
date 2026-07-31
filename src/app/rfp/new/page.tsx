// /rfp/new — upload a file or paste the text (§5.17).

import type { Metadata } from "next";
import { requireRfpPage } from "@/lib/rfp/access";
import { NewRfpForm } from "./form";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  title: "Start an RFP",
  robots: { index: false, follow: false },
};

export default async function NewRfpPage() {
  const gate = await requireRfpPage("/rfp/new");
  if (!gate.ok) return null;

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <div>
        <span className="sys-label">Start an RFP</span>
        <p className="mt-4">
          Drop the client&apos;s RFP in, or paste the text. It is read for its
          structure and its questions, keeping the client&apos;s own section
          labels exactly as they wrote them.
        </p>
      </div>
      <NewRfpForm />
    </div>
  );
}
