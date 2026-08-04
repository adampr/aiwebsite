"use client";

// Step 05 hub-panel island (§5.18 round 2): the DKIM step has NO (steps)
// page; this action area IS its surface. A status line plus one button
// opening a native <dialog> that renders dkimCopy(check) - the ONE copy
// source shared with the instructions email, so this component never writes
// its own instruction text. Recheck updates local state AND calls
// router.refresh() so the server-rendered runway and panel line resync to
// the same fresh verdict. Escape closes natively (no onCancel preventDefault:
// nothing here is ever mid-upload). No em dashes.
//
// Round 3, Initializing: the status read races DNS on an 800ms budget, so a
// cold-cache render commonly arrives with timedOut === true while the
// detached check still runs. While the current check is timedOut this
// island shows INITIALIZING... and polls GET /api/roadmap/dkim/status on a
// chained schedule (2s x5 then 4s x5, ~30s), skipping ticks while the tab
// is hidden and stopping on any 429. The first non-timedOut check is
// adopted with ONE router.refresh(). Give-up sets an EPISODE-level flag and
// never refreshes on a still-timedOut synthetic (nothing new to show). The
// initializing copy instructs a reload, so it is honest without JS and
// needs no <noscript>. The CTA button stays ENABLED throughout (the
// dialog's unknown/dns-error copy covers a pending check), and the dialog's
// Recheck is only ever disabled during its own in-flight fetch.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { DkimCheck } from "@/lib/roadmap/dkim";
import { dkimCopy } from "@/lib/roadmap/dkim-copy";

type Notice = { role: "status" | "alert"; text: string } | null;

/** 2s x5 then 4s x5: 10 polls, ~30s of wall clock per episode. */
const POLL_DELAYS_MS = [
  2000, 2000, 2000, 2000, 2000, 4000, 4000, 4000, 4000, 4000,
] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  // Episode-level give-up: the poll bound was reached (or a 429 landed)
  // while the check was still a timedOut synthetic. Cleared ONLY by an
  // explicit Recheck click, never by a fresh timedOut initial prop.
  const [gaveUp, setGaveUp] = useState(false);
  // Bumping the episode cancels any running poll loop.
  const episodeRef = useRef(0);

  const copy = dkimCopy(check);
  const busy = rechecking || sending;
  const initializing = check.timedOut === true;

  function startPolling() {
    const ep = ++episodeRef.current;
    void (async () => {
      for (const delay of POLL_DELAYS_MS) {
        await sleep(delay);
        if (episodeRef.current !== ep) return;
        // Pause while hidden: skip the fetch, keep the wall-clock bound.
        if (document.hidden) continue;
        try {
          const res = await fetch("/api/roadmap/dkim/status");
          if (episodeRef.current !== ep) return;
          if (res.status === 429) break; // stop polling; give up below
          if (!res.ok) continue;
          const fresh = (await res.json()) as DkimCheck;
          if (episodeRef.current !== ep) return;
          if (fresh.timedOut !== true) {
            setCheck(fresh);
            // ONE refresh: the server-rendered runway and card line resync
            // to the resolved verdict.
            router.refresh();
            return;
          }
        } catch {
          // transient network trouble: let the loop keep going
        }
      }
      if (episodeRef.current !== ep) return;
      // Bound reached (or 429) while still timedOut. NO router.refresh():
      // the latest check is still a timedOut synthetic, nothing new to show.
      setGaveUp(true);
    })();
  }

  // Round 4: the runway's dkim node (#rmp-node-dkim, server-rendered with
  // .rmp-node--working while timedOut) must stop PROMISING activity once the
  // poll episode ends without a verdict: stamp data-gave-up, which demotes
  // the pulse to the static working form. The CSS selector is scoped to
  // .rmp-node--working, so a stale stamp is inert after any verdict refresh;
  // an explicit Recheck clears gaveUp and the stamp with it.
  useEffect(() => {
    const node = document.getElementById("rmp-node-dkim");
    if (!node) return;
    if (initializing && gaveUp) node.setAttribute("data-gave-up", "");
    else node.removeAttribute("data-gave-up");
  }, [initializing, gaveUp]);

  // Arm the poll once per mount when the SSR state is already Initializing.
  // useRef StrictMode guard; deliberately no cleanup cancel (StrictMode's
  // immediate unmount would kill the only episode).
  const pollArmed = useRef(false);
  useEffect(() => {
    if (pollArmed.current) return;
    pollArmed.current = true;
    if (initial.timedOut === true) startPolling();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Prop resync (refuter-pinned): adopt a fresh `initial` ONLY when the
  // dialog is NOT open AND the new initial is NOT a timedOut synthetic OR
  // it differs in verdict from current. A new timedOut synthetic must NOT
  // clear gaveUp and must NOT re-arm the poll. Deferred a tick (codebase
  // pattern: open-items-resolver) so the effect body stays setState-free;
  // the updater itself is pure and compares against the CURRENT check.
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (dialogRef.current?.open) return;
      setCheck((cur) => {
        if (initial.timedOut === true && initial.verdict === cur.verdict)
          return cur;
        return initial; // adopt; gaveUp and the poll are untouched here
      });
      // A resolved server verdict makes any running poll moot.
      if (initial.timedOut !== true) episodeRef.current++;
    }, 0);
    return () => window.clearTimeout(t);
  }, [initial]);

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
        // An explicit Recheck starts a fresh episode: clear give-up, and if
        // THIS response is itself timedOut, re-enter polling.
        setGaveUp(false);
        // The runway and the panel's mono line are server-rendered from the
        // same cache this recheck just refilled; resync them.
        router.refresh();
        if (fresh.timedOut === true) {
          startPolling();
          return;
        }
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
      {initializing ? (
        <div className="mt-4">
          <span className="rmp-state rmp-state--init">Initializing...</span>
          {/* role=status: the one announcement channel for the check's
              resolution (WCAG 4.1.3); the runway is never a live region. */}
          <p className="mt-3 text-sm" role="status">
            {gaveUp
              ? "Still checking. Reload this page in a moment for the result."
              : "Checking your domain's setup. Reload this page in a moment for the result."}
          </p>
        </div>
      ) : (
        <p className="mt-4 text-sm">{panelLine(check)}</p>
      )}
      {/* rmp-card-cta: the uniform overlay pattern - this button is the dkim
          card's single interactive element and its ::after stretches over
          the card. The <dialog> it opens is top-layer, so it renders and
          receives clicks above the overlay. NEVER disabled during
          Initializing: it opens the dialog, whose unknown/dns-error copy
          already covers a pending check. */}
      <button type="button" className="rmp-card-cta" onClick={open}>
        {panelButtonLabel(check)}
        {check.verdict === "ok" && (
          <span className="rmp-arrow" aria-hidden="true">
            {" "}
            →
          </span>
        )}
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
