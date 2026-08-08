// Route helpers for the Requested Work board (§5.19). Kept out of the
// shared http.ts (shared-checkout rule: never wholesale-edit a co-edited
// file). One lane-admin definition and one audience gate for the whole
// feature.

import { companyAdminRole } from "@/lib/roadmap/db";
import { isRfpProvider } from "@/lib/rfp/access";
import {
  REQUEST_STATUS_COPY,
  type WorkRequestStatus,
} from "@/lib/work/requests-config";
import {
  requireWorkUser,
  verifiedWebAdmin,
  workError,
  type WorkUser,
} from "@/lib/work/http";
import type { WorkScope } from "@/lib/work/scope";

export type RequestUser = WorkUser & { scope: WorkScope };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isRequestId = (id: string): boolean => UUID_RE.test(id);

/**
 * The board's audience gate. requireWorkUser resolves the lane from the
 * SESSION (xl.net -> internal scope; registered company -> its scope with
 * the trusted-session requirement), and this wrapper adds one §5.19
 * hardening on top: the INTERNAL lane additionally requires the /rfp
 * provider anchor (Google). requireWorkUser deliberately admits any-provider
 * xl.net sessions for submissions, where a forged Microsoft common-tenant
 * session (the nOAuth argument, http.ts header) can at worst spam its own
 * drafts through an AI panel; here it could burn the lane's claim slots and
 * flood the admin queue, so requests pin the same trust anchor the staff
 * hub and every admin surface already use. Company-lane behavior is
 * unchanged (isTrustedSession is already required there).
 */
export async function requireRequestUser(): Promise<RequestUser | Response> {
  const user = await requireWorkUser();
  if (user instanceof Response) return user;
  if (user.scope.companyId === null && !isRfpProvider(user.provider)) {
    return workError(
      "untrusted_provider",
      "The requested-work board is open to xl.net Google sign-ins. Sign in with your xl.net Google account and try again.",
      403
    );
  }
  return user;
}

/** One honest error body per failed transition (approve-route pattern:
 * report what actually happened, not a generic refusal). quotaMessage is the
 * route-specific 429 copy. */
export function transitionErrorResponse(
  failure: {
    reason: "not_found" | "not_eligible" | "quota";
    status?: string;
  },
  opts: { verbPast: string; quotaMessage: string }
): Response {
  if (failure.reason === "not_found")
    return workError("not_found", "That request does not exist.", 404);
  if (failure.reason === "quota")
    return workError("quota", opts.quotaMessage, 429);
  const label = failure.status
    ? (REQUEST_STATUS_COPY[failure.status as WorkRequestStatus] ??
      failure.status)
    : "in another state";
  return workError(
    "not_eligible",
    `This request is now "${label}" and cannot be ${opts.verbPast}.`,
    409
  );
}

/** Lane admin: internal = verifiedWebAdmin (ADMIN_EMAIL AND the Google
 * provider AND exact-label xl.net - never bare isAdmin); company =
 * companyAdminRole over the SESSION-derived scope. companyId never comes
 * from client input: requireWorkUser derived it from the session email
 * domain. */
export async function isLaneAdmin(user: RequestUser): Promise<boolean> {
  return user.scope.companyId === null
    ? verifiedWebAdmin(user)
    : companyAdminRole(user.scope.companyId, user.userId);
}
