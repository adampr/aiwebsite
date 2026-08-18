"use client";

// The two mutating controls on the notification-list page (§5.10): explicit
// opt-in (POST /api/workshop/notify) and remove (DELETE). The API re-reads
// the session server-side and takes the email from it, so this island only
// carries the click and the joined/left readout.

import { useState } from "react";

export function NotifyButtons({ initialJoined }: { initialJoined: boolean }) {
  const [joined, setJoined] = useState(initialJoined);
  const [state, setState] = useState<"idle" | "busy" | "error">("idle");
  const [message, setMessage] = useState("");

  async function send(method: "POST" | "DELETE") {
    setState("busy");
    setMessage("");
    try {
      const res = await fetch("/api/workshop/notify", { method });
      const body = (await res.json().catch(() => null)) as {
        joined?: boolean;
        error?: { message?: string };
      } | null;
      if (res.ok) {
        setJoined(body?.joined === true);
        setState("idle");
        return;
      }
      setMessage(
        body?.error?.message ?? "That did not work. Try again shortly."
      );
      setState("error");
    } catch {
      setMessage("Network problem. Try again.");
      setState("error");
    }
  }

  return (
    <div className="space-y-3">
      {joined ? (
        <>
          <p className="text-sm" role="status">
            You are on the list. We&apos;ll email you when the next workshop
            date is set.
          </p>
          <button
            type="button"
            className="btn w-full"
            onClick={() => send("DELETE")}
            disabled={state === "busy"}
            aria-busy={state === "busy"}
          >
            {state === "busy" ? "Removing..." : "Remove me from the list"}
          </button>
        </>
      ) : (
        <button
          type="button"
          className="btn btn--primary w-full"
          onClick={() => send("POST")}
          disabled={state === "busy"}
          aria-busy={state === "busy"}
        >
          {state === "busy"
            ? "Adding..."
            : "Add me to the notification list for the next workshop"}
        </button>
      )}
      {state === "error" && (
        <p className="text-sm" role="alert" style={{ color: "#e5484d" }}>
          {message}
        </p>
      )}
    </div>
  );
}
