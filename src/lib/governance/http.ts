// Route helpers (§5.12): session gate, uniform error bodies, rate limiting.
// Errors are machine-readable ({error:{code,message}}) and the not-found
// response is identical for missing / expired / not-owned rows (no existence
// oracle).

import { readSession } from "@aicompany/core/auth/session";
import { checkRateLimit } from "@aicompany/core/lib/rate-limit";
import { siteConfig } from "site.config";
import type { GovernanceErrorCode } from "./types";

export interface GovUser {
  userId: string;
  email: string;
  emailDomain: string;
}

export function govError(
  code: GovernanceErrorCode,
  message: string,
  status: number,
  extra?: { retriable?: boolean; retryAfterSec?: number }
): Response {
  const headers: Record<string, string> = {
    "cache-control": "no-store, private",
  };
  if (extra?.retryAfterSec)
    headers["retry-after"] = String(extra.retryAfterSec);
  return Response.json(
    {
      error: {
        code,
        message,
        ...(extra?.retriable !== undefined ? { retriable: extra.retriable } : {}),
      },
    },
    { status, headers }
  );
}

export const NOT_FOUND = () =>
  govError(
    "not_found",
    "This project is gone. Projects auto-delete 30 days after the last activity.",
    404
  );

export async function requireUser(): Promise<GovUser | Response> {
  const session = await readSession(siteConfig);
  if (!session)
    return govError("unauthenticated", "Sign in to use the governance builder.", 401);
  return {
    userId: session.userId,
    email: session.email,
    emailDomain: session.email.split("@")[1]?.toLowerCase() ?? "",
  };
}

/** Per-user (or per-key) in-memory rate limit -> 429 Response when exceeded. */
export function rateLimit(
  key: string,
  windowSec: number,
  max: number
): Response | null {
  const r = checkRateLimit(key, { windowSec, max });
  if (r.allowed) return null;
  return govError("rate_limited", "Too many requests. Give it a moment.", 429, {
    retryAfterSec: r.retryAfterSec,
  });
}

export function okJson(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store, private" },
  });
}
