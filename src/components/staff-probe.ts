"use client";

// ONE session probe, shared by every staff-only island (§5.16, §5.17).
//
// Both the /work submit links and the /rfp nav entry need the same answer, and
// each previously owning its own module-scoped promise meant one fetch per
// island per page. This module holds the single promise so N islands cost one
// request. (The module's own <UserMenu> probes separately; that is module code
// this host does not modify.)

export type StaffSession = {
  authenticated: boolean;
  email: string | null;
  provider: string | null;
};

let probe: Promise<StaffSession> | null = null;

export function probeSession(): Promise<StaffSession> {
  probe ??= fetch("/api/auth/session", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then(
      (
        d: {
          authenticated?: boolean;
          user?: { email?: string; provider?: string };
        } | null
      ) => ({
        authenticated: Boolean(d?.authenticated),
        email: typeof d?.user?.email === "string" ? d.user.email : null,
        provider:
          typeof d?.user?.provider === "string" ? d.user.provider : null,
      })
    )
    .catch(() => ({ authenticated: false, email: null, provider: null }));
  return probe;
}

/** Signed in on an xl.net account. The /work submission gate's predicate. */
export function probeStaff(): Promise<boolean> {
  return probeSession().then((s) =>
    Boolean(s.authenticated && s.email?.toLowerCase().endsWith("@xl.net"))
  );
}

/**
 * Signed in on an xl.net account via a staff provider (google or microsoft).
 *
 * OVER-APPROXIMATES the server gate on purpose (Microsoft parity round): the
 * per-login mv claim is not exposed by /api/auth/session (the module handler
 * returns only email/displayName/provider/isAdmin, and its augment hook sees
 * the users ROW, while mv is per-login and never stored), so the client
 * cannot mirror isVerifiedStaffProvider exactly. Keeping this google-only
 * would permanently hide the link from verified Microsoft staff; widening it
 * only over-advertises to an xl.net Microsoft session without mv, which
 * lands on the server's explainer naming the fix. The server gate is the
 * control; if the two disagree, the server is right.
 */
export function probeRfpStaff(): Promise<boolean> {
  return probeSession().then((s) => {
    if (!s.authenticated || !s.email) return false;
    const parts = s.email.trim().toLowerCase().split("@");
    if (parts.length !== 2) return false;
    return (
      parts[1].replace(/\.$/, "") === "xl.net" &&
      ["google", "microsoft"].includes(s.provider?.trim().toLowerCase() ?? "")
    );
  });
}
