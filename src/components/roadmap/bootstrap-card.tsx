"use client";

// "Set up {domain} workspace" island (§5.18). The click is the explicit
// bootstrap act; the visible copy above the button carries both required
// disclosures (first-signer-becomes-admin, XL.net visibility). On success
// the page refreshes into the status board; "exists" means someone else
// raced the bootstrap, which resolves the same way (viewer becomes a
// member).

import { useState } from "react";
import { useRouter } from "next/navigation";

export function BootstrapCard({ domain }: { domain: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/roadmap/company/bootstrap", {
        method: "POST",
      });
      const data = (await res.json().catch(() => null)) as {
        outcome?: string;
        error?: { message?: string };
      } | null;
      if (res.ok) {
        router.refresh();
        return;
      }
      setError(
        data?.error?.message ?? "Something went wrong. Try again shortly."
      );
      setBusy(false);
    } catch {
      setError("Something went wrong. Check your connection and try again.");
      setBusy(false);
    }
  }

  return (
    <div className="panel panel--lightline mx-auto max-w-xl">
      <span className="sys-label">Getting Started</span>
      <h2 className="mt-4">Set up the {domain} workspace</h2>
      <p className="mt-4 text-sm">
        This creates a private AI roadmap for everyone who signs in with a
        {" "}{domain}{" "}
        email address. As the person setting it up, you become this
        company&apos;s admin: you manage its documents and directory, and you
        can approve admin access for colleagues.
      </p>
      <p className="mt-3 text-sm">
        XL.net administrators can view and manage every company workspace in
        order to operate and support the service.
      </p>
      <button
        type="button"
        className="btn btn--primary mt-6"
        disabled={busy}
        aria-busy={busy}
        onClick={create}
      >
        {busy ? "Setting up..." : `Set up ${domain} workspace`}
      </button>
      {error && (
        <p role="alert" className="mt-4 text-sm text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
