// The ONE explainer for a signed-in xl.net session that is NOT verified
// staff (Microsoft parity round, 2026-08-09). After parity this fires for
// exactly one population: an xl.net Microsoft session without the per-login
// mv claim (minted before the 2026-08-04 hardening, or by an account whose
// tenant does not assert xms_edov).
//
// It exists because bouncing such a visitor to /login strands them on a form
// they have already satisfied (the rfp doctrine: explain, never bounce). Both
// providers are offered: a fresh Google or Microsoft sign-in mints the claim,
// and staff Google sessions need no claim at all.

import Link from "next/link";

export function StaffVerifyNotice({
  email,
  surface,
  redirectTo,
}: {
  email: string;
  /** What the visitor was trying to reach, named in the copy. */
  surface: string;
  /** Where both sign-in links return them. */
  redirectTo: string;
}) {
  const back = encodeURIComponent(redirectTo);
  return (
    <div className="mx-auto max-w-xl space-y-6 pt-12 text-center">
      <span className="sys-label sys-label--center">One last check</span>
      <h1>Confirm it is you</h1>
      <p className="text-sm">
        {surface} needs a verified XL.net sign-in. You are signed in as{" "}
        <span className="mono">{email}</span>, but this session could not
        verify your address. Sign in again with your xl.net Google or
        Microsoft account and you will land right back here.
      </p>
      <div className="flex flex-wrap justify-center gap-3">
        <a
          className="btn no-underline"
          href={`/api/auth/google/start?redirect=${back}`}
        >
          Sign in with Google
        </a>
        <a
          className="btn no-underline"
          href={`/api/auth/microsoft/start?redirect=${back}`}
        >
          Sign in with Microsoft
        </a>
      </div>
      <p className="text-sm">
        <Link href="/">Back to the site</Link>
      </p>
    </div>
  );
}
