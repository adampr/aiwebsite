"use client";

// "One last check" screen (§5.18 round 2): shown to a signed-in session
// whose provider could not verify its email claim (Microsoft without
// xms_edov, or a pre-hardening OAuth session). Framed as VERIFICATION of an
// existing login, never as a new login: the session is fine, we just confirm
// once that the address really belongs to the account before showing company
// data. NO company data renders here, not even a company name.
//
// Ways out: a Google or Microsoft verification sign-in (both mint the
// verified email claim; reserved staff domains get both providers and never
// the email option) or a verification link mailed to the address the session
// ALREADY carries - the
// address renders as static text and the POST body uses exactly the session
// email prop, so this screen can never mint a link for a different mailbox.
// Reserved domains (xl.net / ai.xl.net) never get magic links, so the email
// option is suppressed entirely there. The magic-link API always answers
// {ok:true} (anti-enumeration), so the confirmation copy hedges on delivery.

import { useState } from "react";

export function ConfirmIdentity({
  email,
  reservedDomain,
  attempted,
  verifyFlag,
}: {
  email: string;
  reservedDomain: boolean;
  attempted: boolean;
  /** The silent bounce came back with ?verify=<provider>_unverified. */
  verifyFlag: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendLink(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/email/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, redirect: "/roadmap" }),
      });
      if (res.ok) {
        setSent(true);
        return;
      }
      if (res.status === 429) {
        setError(
          "Too many verification links requested for now. Wait a few minutes and try again, or verify with Google."
        );
        return;
      }
      setError("Something went wrong. Try again shortly.");
    } catch {
      setError("Something went wrong. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl space-y-8 pt-8">
      <div className="text-center">
        <span className="sys-label sys-label--center">Your AI Roadmap</span>
        <h1 className="mt-6">One last check</h1>
        <p className="mx-auto mt-4 text-sm">
          You are signed in as <span className="mono">{email}</span> and your
          session is fine. Company roadmaps are private to verified company
          addresses, so we confirm once that this address really belongs to
          your account before showing company data.
        </p>
        {attempted && (
          <p className="mx-auto mt-3 text-sm">
            We tried to confirm this automatically and could not, so one click
            is needed.
          </p>
        )}
        {verifyFlag && !reservedDomain && (
          <p className="mx-auto mt-3 text-sm">
            The sign-in completed but your provider could not vouch for this
            address; use the email link instead.
          </p>
        )}
      </div>

      <div className="panel panel--raised space-y-6">
        <div>
          {!reservedDomain && <span className="sys-label">Option 1</span>}
          <p className="mt-3 text-sm">
            {reservedDomain
              ? "XL.net accounts verify with a Google or Microsoft sign-in."
              : "Verify through Google, which vouches for your email address."}
          </p>
          {/* Reserved (staff) domains get BOTH providers: a Microsoft
              re-login now mints the verified claim, and an org that does not
              use Google would otherwise face a button it can never press.
              Public visitors keep the Google + email-link pair. */}
          <div className="mt-4 flex flex-wrap gap-3">
            <a
              href="/api/auth/google/start?redirect=%2Froadmap"
              className="btn no-underline"
            >
              Verify with Google
            </a>
            {reservedDomain && (
              <a
                href="/api/auth/microsoft/start?redirect=%2Froadmap"
                className="btn no-underline"
              >
                Verify with Microsoft
              </a>
            )}
          </div>
        </div>
        {!reservedDomain && (
          <>
            <hr className="rule" />
            <div>
              <span className="sys-label">Option 2</span>
              <p className="mt-3 text-sm">
                Have a verification link emailed to the address on your
                account:
              </p>
              <p className="mono mt-2 text-sm">{email}</p>
              {sent ? (
                <p className="mt-4 text-sm" role="status">
                  Check your email. If no email arrives within a few minutes,
                  verify with Google or try again later.
                </p>
              ) : (
                <form onSubmit={sendLink} className="mt-4 space-y-3">
                  <button
                    type="submit"
                    className="btn"
                    disabled={busy}
                    aria-busy={busy}
                  >
                    {busy ? "Sending..." : "Email me a verification link"}
                  </button>
                  {error && (
                    <p role="alert" className="text-xs text-red-400">
                      {error}
                    </p>
                  )}
                </form>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
