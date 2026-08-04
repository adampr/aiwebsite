"use client";

// "Confirm it is you" screen (§5.18): shown to a signed-in session whose
// provider could not verify its email claim (Microsoft without xms_edov, or
// a pre-hardening OAuth session). NO company data renders here, not even a
// company name. Two ways out: Google sign-in (verified email claim) or a
// magic link to the address the session already carries (mailbox control by
// construction). The magic-link API always answers {ok:true}
// (anti-enumeration), so the confirmation copy hedges on delivery.

import { useState } from "react";

export function ConfirmIdentity({
  email,
  redirect,
}: {
  email: string;
  redirect: string;
}) {
  const [addr, setAddr] = useState(email);
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
        body: JSON.stringify({ email: addr, redirect }),
      });
      if (res.ok) {
        setSent(true);
        return;
      }
      if (res.status === 429) {
        setError(
          "Too many sign-in links requested for now. Wait a few minutes and try again, or sign in with Google."
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
        <h1 className="mt-6">Confirm it is you</h1>
        <p className="mx-auto mt-4 text-sm">
          Your sign-in method could not verify that you control{" "}
          <span className="mono">{email}</span>, and company roadmaps are
          private to verified company addresses. Confirm your email one of two
          ways and you are in.
        </p>
      </div>

      <div className="panel panel--raised space-y-6">
        <div>
          <span className="sys-label">Option 1</span>
          <p className="mt-3 text-sm">
            Sign in with Google, which verifies your email address.
          </p>
          <a
            href={`/api/auth/google/start?redirect=${encodeURIComponent(redirect)}`}
            className="btn mt-4 no-underline"
          >
            Sign in with Google
          </a>
        </div>
        <hr className="rule" />
        <div>
          <span className="sys-label">Option 2</span>
          <p className="mt-3 text-sm">
            Have a sign-in link emailed to your work address.
          </p>
          {sent ? (
            <p className="mt-4 text-sm" role="status">
              Check your email. If no email arrives within a few minutes, sign
              in with Google or try again later.
            </p>
          ) : (
            <form onSubmit={sendLink} className="mt-4 space-y-3">
              <input
                type="email"
                required
                value={addr}
                onChange={(e) => setAddr(e.target.value)}
                className="w-full rounded-lg border bg-transparent px-3 py-2 text-sm"
                style={{ borderColor: "var(--xl-line)" }}
                aria-label="Work email address"
              />
              <button
                type="submit"
                className="btn"
                disabled={busy}
                aria-busy={busy}
              >
                {busy ? "Sending..." : "Email me a sign-in link"}
              </button>
              {error && (
                <p role="alert" className="text-xs text-red-400">
                  {error}
                </p>
              )}
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
