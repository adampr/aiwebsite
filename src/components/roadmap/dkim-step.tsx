"use client";

// Step 05 hub-panel island (§5.18 round 2): the DKIM step has NO (steps)
// page; this action area IS its surface. A status line plus one button
// opening a native <dialog> that renders dkimCopy(check) - the ONE copy
// source shared with the instructions email, so this component never writes
// its own instruction text. Recheck updates local state AND calls
// router.refresh() so the server-rendered runway and panel line resync to
// the same fresh verdict. Escape closes natively (no onCancel preventDefault:
// nothing here is ever mid-upload). No em dashes.

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { DkimCheck } from "@/lib/roadmap/dkim";
import { dkimCopy } from "@/lib/roadmap/dkim-copy";

type Notice = { role: "status" | "alert"; text: string } | null;

function panelLine(check: DkimCheck): string {
  if (check.verdict === "ok")
    return "Signing records for your domain are published.";
  if (check.verdict === "missing")
    return "Your domain is not signing its email yet.";
  return "We could not confirm your domain's signing setup from here.";
}

function panelButtonLabel(check: DkimCheck): string {
  if (check.verdict === "ok") return "View details";
  if (check.verdict === "missing") return "Set up DKIM";
  return "Check DKIM";
}

async function readErrorMessage(res: Response): Promise<{
  code: string;
  message: string;
}> {
  try {
    const body = (await res.json()) as {
      error?: { code?: string; message?: string };
    };
    return {
      code: body.error?.code ?? "",
      message: body.error?.message ?? "",
    };
  } catch {
    return { code: "", message: "" };
  }
}

export function DkimStep({
  initial,
  email,
}: {
  initial: DkimCheck;
  email: string;
}) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [check, setCheck] = useState<DkimCheck>(initial);
  const [rechecking, setRechecking] = useState(false);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const copy = dkimCopy(check);
  const busy = rechecking || sending;

  function open() {
    const d = dialogRef.current;
    if (d && !d.open) {
      d.showModal();
      headingRef.current?.focus();
    }
  }

  function close() {
    dialogRef.current?.close();
  }

  async function recheck() {
    setRechecking(true);
    setNotice(null);
    try {
      const res = await fetch("/api/roadmap/dkim/recheck", { method: "POST" });
      if (res.ok) {
        const fresh = (await res.json()) as DkimCheck;
        setCheck(fresh);
        // The runway and the panel's mono line are server-rendered from the
        // same cache this recheck just refilled; resync them.
        router.refresh();
        if (fresh.verdict === "missing") {
          setNotice({
            role: "status",
            text: "Still not visible. DNS changes can take a few hours; check back later.",
          });
        }
        return;
      }
      if (res.status === 429) {
        setNotice({
          role: "status",
          text: "Give it a minute, then try again.",
        });
        return;
      }
      setNotice({
        role: "alert",
        text: "The check could not run just now. Try again shortly.",
      });
    } catch {
      setNotice({
        role: "alert",
        text: "The check could not run just now. Check your connection and try again.",
      });
    } finally {
      setRechecking(false);
    }
  }

  async function emailInstructions() {
    setSending(true);
    setNotice(null);
    try {
      const res = await fetch("/api/roadmap/dkim/email-instructions", {
        method: "POST",
      });
      if (res.ok) {
        const body = (await res.json()) as { sentTo?: string };
        setNotice({
          role: "status",
          text: `Sent to ${body.sentTo ?? email}.`,
        });
        return;
      }
      if (res.status === 429) {
        setNotice({
          role: "status",
          text: "You have asked for this a few times today; check your inbox.",
        });
        return;
      }
      const err = await readErrorMessage(res);
      if (res.status === 503 || err.code === "disabled") {
        setNotice({
          role: "status",
          text:
            err.message ||
            "Roadmap changes are paused right now. Reading is unaffected; try again later.",
        });
        return;
      }
      if (res.status === 409) {
        setNotice({
          role: "status",
          text:
            err.message ||
            "The check itself could not complete, so there are no instructions to send yet. Hit Recheck first.",
        });
        return;
      }
      setNotice({
        role: "alert",
        text:
          err.message ||
          "The email could not be sent right now. The steps shown here still work; try the email again later.",
      });
    } catch {
      setNotice({
        role: "alert",
        text: "The email could not be sent right now. The steps shown here still work; try the email again later.",
      });
    } finally {
      setSending(false);
    }
  }

  return (
    <div>
      <p className="mt-4 text-sm">{panelLine(check)}</p>
      <button
        type="button"
        className={
          check.verdict === "ok" ? "btn btn--text mt-5" : "btn mt-5"
        }
        onClick={open}
      >
        {panelButtonLabel(check)}
        {check.verdict === "ok" && <span aria-hidden="true"> →</span>}
      </button>

      <dialog
        ref={dialogRef}
        className="rmp-dialog"
        aria-labelledby="rmp-dkim-title"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <span className="sys-label">Your AI Roadmap / Verified Email</span>
            <h2
              id="rmp-dkim-title"
              ref={headingRef}
              tabIndex={-1}
              className="mt-2 text-xl font-bold"
            >
              {copy.heading}
            </h2>
          </div>
          <button
            type="button"
            className="btn btn--text"
            aria-label="Close"
            onClick={close}
          >
            ✕
          </button>
        </div>

        <p className="mt-4 text-sm">{copy.intro}</p>
        <ol className="mt-4 list-decimal space-y-3 pl-5 text-sm">
          {copy.steps.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
        {copy.outro && <p className="mt-4 text-sm">{copy.outro}</p>}

        <div className="mt-6 flex flex-wrap items-center gap-4">
          {copy.emailable && (
            <button
              type="button"
              className="btn"
              disabled={busy}
              aria-busy={sending}
              onClick={emailInstructions}
            >
              {sending ? "Sending..." : "Email me these instructions"}
            </button>
          )}
          <button
            type="button"
            className="btn"
            disabled={busy}
            aria-busy={rechecking}
            onClick={recheck}
          >
            {rechecking ? "Rechecking..." : "Recheck"}
          </button>
          <button type="button" className="btn btn--text" onClick={close}>
            Close
          </button>
        </div>
        {notice && (
          <p role={notice.role} className="mt-4 text-sm">
            {notice.text}
          </p>
        )}
      </dialog>
    </div>
  );
}
