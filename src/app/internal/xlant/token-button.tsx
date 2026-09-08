"use client";

// The device-token mint button (§5.22). A client island because the token is
// shown ONCE and never re-rendered from the server: it exists in this
// component's state and nowhere else on this host.
//
// The kinds are inlined rather than imported from @/lib/xlant — that module
// reads node:fs and the shared secret, and must never be bundled into a
// client. One button per kind, and the page renders one inside each platform
// card, because a Windows token and a Mac token are for different builds and
// are minted through different paths (only the Mac mint probes the relay
// first). Two mounted instances hold separate state so showing a Mac token
// cannot blank the Windows one the staffer has not copied yet.
//
// WHAT A MINT DOES, AND WHAT IT NO LONGER DOES (2026-09-08). It used to revoke
// the person's previous token of that kind, which meant setting up a second
// laptop signed the first one out — measured in production, one person's two
// machines took turns being the only one that worked, eight tokens deep. A
// mint now revokes NOTHING. A token that is never pasted anywhere is dealt
// with by time instead — it expires seven days after it was generated — and a
// reinstall on a computer that already had XLAnt retires that computer's own
// older token the first time the new install REPORTS SOMETHING (a problem, or
// the daily check-up), which is when the relay learns the machine name — not
// when it connects. So the sentence under a fresh token says the true thing
// twice over: nothing else of yours was signed out, and this one is on a clock
// until you use it. The page's Download paragraph carries the reinstall
// timing, because that is where somebody reads it.
//
// A SUCCESSFUL MINT ALSO TELLS THE PAGE. The "Your computers" island below is
// a separate mount with no shared parent state, so the button announces itself
// on `window` (`xlant:devices-changed`) and the island re-reads its list,
// where the new token shows up as a computer that has not connected yet. The
// event name is spelled in both files and a test pins that the two agree.

import { useState } from "react";

type Kind = "windows" | "mac";

/** The event the "Your computers" island listens for. Spelled here rather than
 * imported so this file keeps its one-import rule; `devices-list.tsx` exports
 * the same literal as DEVICES_CHANGED_EVENT and a test compares them. */
const DEVICES_CHANGED_EVENT = "xlant:devices-changed";

/** The words each kind puts on screen. Split out so the two cards cannot drift
 * into describing the same mint differently, and so `others` can name the
 * right machine in each: a mint touches nothing else of the person's, and the
 * token it just produced is the one on a seven-day clock. */
const COPY: Record<Kind, { platform: string; machine: string; others: string }> = {
  windows: {
    platform: "Windows",
    machine: "PC",
    others:
      "Your other computers stay signed in. If you do not paste this Windows token into a PC, it expires on its own seven days from now.",
  },
  mac: {
    platform: "Mac",
    machine: "Mac",
    others:
      "Your other computers stay signed in. If you do not paste this Mac token into a Mac, it expires on its own seven days from now.",
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
    "The XLAnt relay refused the request. Nothing has changed — every computer you have set up stays signed in.",
  "the XLAnt relay did not answer":
    "The XLAnt relay did not answer. Nothing has changed — every computer you have set up stays signed in. Try again in a moment.",
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
      // The list below is a separate mount, so it is told rather than
      // re-rendered. Fired only after a token actually arrived: a refused mint
      // changed nothing and must not make the list flicker.
      window.dispatchEvent(new CustomEvent(DEVICES_CHANGED_EVENT));
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
              Copy it now — it is not shown again. {copy.others}
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
