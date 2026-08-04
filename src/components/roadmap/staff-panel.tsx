// Staff explainer for the /roadmap hub (§5.18 round 2). Rendered when the
// hub view is kind "staff": provider google + exact-label xl.net (see
// isStaffSession in src/lib/roadmap/access.ts).
//
// SECURITY INVARIANT: the staff predicate grants ZERO authority. It is safe
// only because this screen renders no tenant data and performs no action; it
// merely picks an explainer. Anything added here that reads data or performs
// an action must re-derive its own gate (requireGlobalAdmin or a trusted
// principal) - never lean on the staff predicate. Never render a login
// prompt here: the visitor is already signed in and their session is fine.

import Link from "next/link";

const faint = { color: "var(--xl-text-faint)" } as const;

export function StaffPanel({
  email,
  showAdminLink,
}: {
  email: string;
  showAdminLink: boolean;
}) {
  return (
    <div className="mx-auto max-w-2xl space-y-10 pt-8">
      <div className="text-center">
        <span className="sys-label sys-label--center">Your AI Roadmap</span>
        <h1 className="mt-6">The client portal</h1>
        <p className="mono mt-4 text-xs" style={faint}>
          {email} · staff
          {showAdminLink ? " · admin" : ""}
        </p>
      </div>

      <div className="panel panel--lightline space-y-4">
        <p className="text-sm">
          This portal gives each client company a private workspace keyed by
          its email domain: everyone who signs in at a client domain shares
          one roadmap, from governance document to builder scorecard. XL.net
          is the operator domain, so it never anchors a workspace; there is
          nothing for a staff account to set up here.
        </p>
        <p className="text-sm">
          Published client-facing work lives on{" "}
          <Link href="/work">the Work page</Link>.
        </p>
      </div>

      {showAdminLink && (
        <div className="panel">
          <span className="sys-label">Operations</span>
          <p className="mt-4 text-sm">
            Client workspaces are managed from the admin console.
          </p>
          <Link
            href="/admin/roadmap"
            className="btn btn--text mt-4 no-underline"
          >
            Manage client workspaces <span aria-hidden="true">→</span>
          </Link>
        </div>
      )}
    </div>
  );
}
