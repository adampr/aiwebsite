// /rfp/knowledge/library: the supporting-documents library (§5.17.23).
//
// Staff-uploaded business documents (a SOC 2 report, a certificate, a
// procedure, a template) a proposal ships as numbered attachments from the
// workspace's Attachments pane. This page lists every row, retired ones
// struck through (a retired document is never deleted: a proposal that
// already picked it still exports it), takes uploads, and retires.
//
// No byte of any file reaches this page: the list select leaves `bytes` out
// (db.ts listLibraryDocuments) and the island receives titles, flags, sizes
// and dates only. Downloads stream from the staff-gated route.

import type { Metadata } from "next";
import { requireRfpPage } from "@/lib/rfp/access";
import { listLibraryDocuments } from "@/lib/rfp/db";
import { KnowledgeNav } from "../nav";
import { LibraryManager, type LibraryRowView } from "./manager";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  title: "Supporting documents",
  robots: { index: false, follow: false },
};

export default async function LibraryPage() {
  const gate = await requireRfpPage("/rfp/knowledge/library");
  if (!gate.ok) return null;

  const rows = await listLibraryDocuments({ includeRetired: true });
  // Live rows first (oldest first, as stored), retired after them: the list
  // reads as what can be picked today, then the record of what was.
  const items: LibraryRowView[] = [
    ...rows.filter((r) => !r.retired),
    ...rows.filter((r) => r.retired),
  ].map((r) => ({
    id: r.id,
    title: r.title,
    kind: r.kind,
    media: r.media,
    confidential: r.confidential,
    redactedSample: r.redactedSample,
    asOf: r.asOf,
    sizeBytes: r.sizeBytes,
    createdBy: r.createdBy,
    // Raw instants; the island formats them in the viewer's zone (<When>).
    createdAt: r.createdAt.toISOString(),
    retiredAt: r.retiredAt ? r.retiredAt.toISOString() : null,
  }));

  return (
    <div className="space-y-10">
      <KnowledgeNav admin={gate.user.admin} />
      <div>
        <span className="sys-label">Supporting documents</span>
        <p className="mt-4 max-w-2xl">
          The documents a proposal can attach: certifications, audit reports,
          procedures, templates, samples and agreements. Each proposal picks
          from this list in its Attachments pane and numbers them Attachment
          1, 2, 3 in the order picked. A confidential document is attached
          only after someone confirms it for that one client.
        </p>
      </div>

      <LibraryManager rows={items} />
    </div>
  );
}
