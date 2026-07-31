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
 * Signed in on an xl.net account VIA GOOGLE.
 *
 * Mirrors src/lib/rfp/access.ts exactly, including the provider requirement,
 * so the nav link never advertises a section the server will then refuse. If
 * the two ever disagree, the server is right and this is the bug.
 */
export function probeRfpStaff(): Promise<boolean> {
  return probeSession().then((s) => {
    if (!s.authenticated || !s.email) return false;
    const parts = s.email.trim().toLowerCase().split("@");
    if (parts.length !== 2) return false;
    return (
      parts[1].replace(/\.$/, "") === "xl.net" &&
      s.provider?.trim().toLowerCase() === "google"
    );
  });
}
