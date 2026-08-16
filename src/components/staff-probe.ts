"use client";

// ONE session probe, shared by every staff-only island (§5.16, §5.17 of THIS
// host's doc — unrelated to the aicompany module's own §5.16 numbering).
//
// Both the /work submit links and the /rfp nav entry need the same answer, and
// each previously owning its own module-scoped promise meant one fetch per
// island per page. Since aicompany v1.90.0 the deduplication lives one level
// down, in the module's shared session store, which the module's <UserMenu>
// also reads — so the last remaining duplicate request on this host is gone
// too. The note that used to sit here ("the module's own <UserMenu> probes
// separately; that is module code this host does not modify") is now obsolete.

import { probeSession as moduleProbe } from "@aicompany/core/components/session-probe";

export type StaffSession = {
  authenticated: boolean;
  email: string | null;
  provider: string | null;
};

/**
 * v1.90.0: ADAPTER over the aicompany module's §5.16 session store, which is
 * now the single reader of GET /api/auth/session for the whole document. The
 * module's <UserMenu/> reads the same store, so this host went from two session
 * requests per page to one — and two requests can return two different answers
 * inside one document.
 *
 * The `StaffSession` shape is preserved EXACTLY, because it is a third envelope
 * shape (distinct from both the module's tagged union and roleplay's envelope)
 * and `roadmap-probe.ts` consumes it. Re-exporting the module's same-named
 * `probeSession` here would silently hand every caller a `{status}` union with
 * no `authenticated`/`email`/`provider` fields, and the /work and /rfp staff
 * gates would collapse to false with no error.
 *
 * A FAILED probe still resolves to `{authenticated:false}` here, exactly as the
 * old `.catch()` did. The module keeps `unknown` distinct from `anonymous` for
 * its own debuggability; nothing on this host acts on the difference, and the
 * server gate is the control either way (see probeRfpStaff below).
 */
export function probeSession(): Promise<StaffSession> {
  return moduleProbe().then((snapshot) =>
    snapshot.status === "authenticated"
      ? {
          authenticated: true,
          email: typeof snapshot.user.email === "string" ? snapshot.user.email : null,
          provider:
            typeof snapshot.user.provider === "string" ? snapshot.user.provider : null,
        }
      : { authenticated: false, email: null, provider: null }
  );
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
