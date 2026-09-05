"use client";

// The device-token mint button (§5.22). A client island because the token is
// shown ONCE and never re-rendered from the server: it exists in this
// component's state and nowhere else on this host.
//
// The kinds are inlined rather than imported from @/lib/xlant — that module
// reads node:fs and the shared secret, and must never be bundled into a
// client. One button per kind, and the page renders one inside each platform
// card: the relay keeps one active token per (user, KIND), so a Mac mint
// revokes the person's previous Mac token and leaves their Windows PC signed
// in. Two mounted instances hold separate state for the same reason — showing
// a Mac token must not blank the Windows one the staffer has not copied yet.

import { useState } from "react";

type Kind = "windows" | "mac";

/** The words each kind puts on screen. Split out so the two cards cannot drift
 * into describing the same mint differently, and so `revoked` can say the true
 * thing for each: issuing one kind never touches the other. */
const COPY: Record<Kind, { platform: string; machine: string; revoked: string }> = {
  windows: {
    platform: "Windows",
    machine: "PC",
    revoked:
      "Any PC still using an older XLAnt Windows token of yours, including one minted on the old roleplay.xl.net page, has just been signed out. Your Mac token is untouched.",
  },
  mac: {
    platform: "Mac",
    machine: "Mac",
    revoked:
      "Any Mac still using an older XLAnt Mac token of yours has just been signed out. Your Windows token is untouched.",
  },
};

// The route answers a typed reason, not prose (401 unauthenticated, 403
// wrong_domain / wrong_provider, plus the relay codes). A code is a fine thing
// to log and a poor thing to read, so each one that a person can actually
// provoke gets a sentence that names the fix. Anything unmapped falls through
// to the code itself rather than to a lie about what went wrong.
const MESSAGES: Record<string, string> = {
  unauthenticated:
    "Your sign-in has expired. Reload this page, sign in again, and generate the token.",
  wrong_domain: "This is open to XL.net staff accounts only.",
  wrong_provider:
    "This session could not verify your address. Sign in again with your xl.net Google or Microsoft account.",
  "relay refused the token mint":
    "The XLAnt relay refused the request. Nothing has changed — your existing token still works.",
  "the XLAnt relay did not answer":
    "The XLAnt relay did not answer. Nothing has changed — your existing token still works. Try again in a moment.",
  "relay returned no token":
    "The XLAnt relay answered without a token. Nothing has changed — try again in a moment.",
  "XLAnt is not configured on this host":
    "XLAnt is not configured on this server yet. Tell whoever set it up.",
  // The pre-mint probe (see the device-token route): the relay is up and
  // answering, it simply predates the Mac lane. Nothing to retry and nothing
  // the staffer can do, so the sentence points at the person who ships relays.
  "the relay does not support Mac tokens yet (needs relay 0.5.0)":
    "The XLAnt relay is not running the Mac release yet, so a Mac token cannot be issued. Nothing has changed. Ask whoever deploys the relay for 0.5.0.",
};

export function DeviceTokenButton({ kind }: { kind: Kind }) {
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const copy = COPY[kind];

  async function mint() {
    setBusy(true);
    setError(null);
    setCopyNote(null);
    try {
      const res = await fetch("/api/internal/xlant/device-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        token?: string;
        error?: string;
      };
      if (!res.ok || !json.token) {
        const code = json.error ?? "";
        throw new Error(
          MESSAGES[code] || code || "The token could not be generated."
        );
      }
      setToken(json.token);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function copyToken() {
    if (!token) return;
    // navigator.clipboard is absent on an insecure origin and can reject when
    // the browser withholds permission. Either way the token is still on
    // screen and selectable, so say that rather than failing silently.
    try {
      await navigator.clipboard.writeText(token);
      setCopyNote("Copied to the clipboard.");
    } catch {
      setCopyNote(
        "Could not copy automatically — select the token above and copy it by hand."
      );
    }
  }

  return (
    <div className="mt-6">
      <button
        type="button"
        onClick={mint}
        disabled={busy}
        aria-busy={busy}
        className="btn btn--primary"
      >
        {busy
          ? "Generating..."
          : token
            ? `Generate a new ${copy.platform} token`
            : `Generate ${copy.platform} token`}
      </button>

      {/* Polite, not assertive: the token appears in response to the viewer's
          own click, so it should be announced after the current utterance
          rather than interrupting it. */}
      <div aria-live="polite">
        {token && (
          <div className="panel panel--raised mt-6">
            <span className="sys-label">{copy.platform} token</span>
            <code
              className="mono mt-4 block rounded-lg border p-4 text-xs"
              style={{
                borderColor: "var(--xl-line)",
                wordBreak: "break-all",
                userSelect: "all",
              }}
            >
              {token}
            </code>
            <p className="mt-4 flex flex-wrap items-center gap-4">
              <button type="button" onClick={copyToken} className="btn">
                Copy token
              </button>
              {copyNote && <span className="text-sm text-faint">{copyNote}</span>}
            </p>
            <p className="mt-4 text-sm">
              Copy it now — it is not shown again. {copy.revoked}
            </p>
          </div>
        )}

        {error && (
          <p
            role="alert"
            className="mt-4 text-sm"
            style={{ color: "var(--xl-danger)" }}
          >
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
