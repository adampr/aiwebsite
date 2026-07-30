"use client";

// Staff-only entry points to the submission flow (§5.16). /work is
// ISR-cached so the server render cannot vary by viewer; this island asks
// /api/auth/session in the browser (ONE probe per page via a module-scoped
// cache, shared by both instances) and renders only for a signed-in @xl.net
// account. Public visitors get nothing, and no space is reserved: the
// one-line staff-only layout shift is accepted by ruling, because reserved
// height would be visible to prospects.
//
// variant="top" (in the hero): the link opens the submission dialog in
// place; the dialog chunk is lazy-loaded only after the staff probe
// confirms, so the public /work bundle never grows. Plain left-click opens
// the dialog; modifier clicks and middle clicks follow the real href to
// /work/submit. (There is deliberately no no-JS staff entry on /work; the
// noscript-safe surface is /work/submit itself.)
// variant="bottom" (after the community section): a plain link to
// /work/submit, where the status list lives.

import Link from "next/link";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { WorkSubmitDialogHandle } from "./work-submit-dialog";

let staffProbe: Promise<boolean> | null = null;
function probeStaff(): Promise<boolean> {
  staffProbe ??= fetch("/api/auth/session", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then(
      (d: { authenticated?: boolean; user?: { email?: string } } | null) =>
        Boolean(
          d?.authenticated &&
            typeof d.user?.email === "string" &&
            d.user.email.toLowerCase().endsWith("@xl.net")
        )
    )
    .catch(() => false);
  return staffProbe;
}

const LazyDialog = lazy(() =>
  import("./work-submit-dialog").then((m) => ({ default: m.WorkSubmitDialog }))
);

export function StaffSubmitLink({
  variant = "bottom",
}: {
  variant?: "top" | "bottom";
}) {
  const [staff, setStaff] = useState(false);
  const [wantDialog, setWantDialog] = useState(false);
  const dialogRef = useRef<WorkSubmitDialogHandle>(null);
  const pendingOpen = useRef(false);

  useEffect(() => {
    let alive = true;
    void probeStaff().then((ok) => {
      if (alive && ok) setStaff(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!staff) return null;

  // The .staff-bar chip (design panel 2026-07-30): a bordered, badge-led
  // utility strip with real object-hood, replacing the bare faint line the
  // owner twice failed to find. The bottom instance carries ONE link (the
  // submissions list lives on that same page).
  if (variant === "bottom")
    return (
      <div className="flex justify-center">
        <p className="staff-bar">
          <span className="badge badge--light">Staff</span>
          <span className="text-faint">Built something?</span>
          <Link href="/work/submit">Submit it for review</Link>
        </p>
      </div>
    );

  return (
    <div className="mt-6 flex flex-col items-center">
      <p className="staff-bar">
        <span className="badge badge--light">Staff</span>
        <span className="text-faint">Built something?</span>
        <a
          href="/work/submit"
          aria-haspopup="dialog"
          onClick={(e) => {
            // Modifier/middle clicks keep real-link semantics (new tab).
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0)
              return;
            e.preventDefault();
            pendingOpen.current = true;
            setWantDialog(true);
            // Already mounted from a prior open: open immediately.
            dialogRef.current?.open();
          }}
        >
          Submit it for review
        </a>
        <span aria-hidden="true" className="text-faint">
          ·
        </span>
        <Link href="/work/submit">Your submissions</Link>
      </p>
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
          />
        </Suspense>
      )}
    </div>
  );
}
