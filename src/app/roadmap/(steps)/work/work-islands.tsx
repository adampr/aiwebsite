"use client";

// Client islands for roadmap step 3 (§5.18): the submit entry that opens
// the SHARED /work submission dialog (same form, same validation; company
// copy rides in through the dialog's optional props), and the Retry button
// for the viewer's own failed submissions. The server gates every submit
// and retry regardless of what renders here.

import { lazy, Suspense, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { WorkSubmitDialogHandle } from "@/app/work/work-submit-dialog";

const LazyDialog = lazy(() =>
  import("@/app/work/work-submit-dialog").then((m) => ({
    default: m.WorkSubmitDialog,
  }))
);

export function RoadmapSubmitEntry({ orgName }: { orgName: string }) {
  const [wantDialog, setWantDialog] = useState(false);
  const dialogRef = useRef<WorkSubmitDialogHandle>(null);
  const pendingOpen = useRef(false);

  return (
    <div>
      <button
        type="button"
        className="btn btn--primary"
        aria-haspopup="dialog"
        onClick={() => {
          pendingOpen.current = true;
          setWantDialog(true);
          dialogRef.current?.open();
        }}
      >
        Submit a build
      </button>
      {wantDialog && (
        <Suspense fallback={null}>
          <LazyDialog
            ref={(h: WorkSubmitDialogHandle | null) => {
              dialogRef.current = h;
              if (h && pendingOpen.current) {
                pendingOpen.current = false;
                h.open();
              }
            }}
            intro="An automated editorial panel drafts a card from your documents, argues against it, and publishes only what it can verify to your company's private page. You get an email either way."
            trackHref="/roadmap/work"
            creditTeamName={`the ${orgName} team`}
            retentionLine="Uploads with credential files are rejected. Only document text is kept for review; the original files are emailed to the XL.net team when the card publishes."
          />
        </Suspense>
      )}
    </div>
  );
}

export function RetrySubmission({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function retry() {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch(`/api/work/submissions/${id}/retry`, {
        method: "POST",
      });
      const data = (await res.json().catch(() => null)) as {
        status?: string;
        error?: { message?: string };
      } | null;
      if (res.ok) {
        // The route returns ok only when a run actually started, so the
        // note states the running state, never "re-queued".
        setNote("The panel is reviewing again.");
        router.refresh();
        return;
      }
      setNote(
        data?.error?.message ?? "Something went wrong. Try again shortly."
      );
    } catch {
      setNote("Something went wrong. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-3">
      <button
        type="button"
        className="btn btn--text"
        disabled={busy}
        aria-busy={busy}
        onClick={retry}
      >
        {busy ? "Retrying..." : "Retry"}
      </button>
      {note && (
        <span role="status" className="text-xs text-faint">
          {note}
        </span>
      )}
    </span>
  );
}
