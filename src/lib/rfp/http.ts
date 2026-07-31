// Route helpers for /api/rfp/* (ARCHITECTURE.md §5.17).
//
// Every handler under src/app/api/rfp/** must call requireRfpApi() as its
// first statement. scripts/rfp-tests.ts greps for that, so a new ungated
// route fails the suite rather than shipping open.

import { requireRfpUser, type RfpUser } from "./access";
import { logRfpActivity } from "./activity";

export function rfpError(
  code: string,
  message: string,
  status: number
): Response {
  return Response.json(
    { error: code, message },
    { status, headers: { "cache-control": "no-store, private" } }
  );
}

export function rfpOk(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store, private" },
  });
}

/**
 * The API gate. Returns the principal, or a Response to return as-is.
 *
 * A denial is logged: a run of denied reads against ids the caller does not
 * own is what an id-walking probe looks like, and a success-only log cannot
 * see it.
 */
export async function requireRfpApi(
  action: string
): Promise<{ ok: true; user: RfpUser } | { ok: false; response: Response }> {
  const result = await requireRfpUser();
  if (!result.ok) {
    await logRfpActivity({
      actorEmail: "anonymous",
      action: "access.denied",
      outcome: "denied",
      meta: { route: action },
    });
    return result;
  }
  return result;
}

/** 404 for someone else's row. A 403 would confirm the row exists. */
export function notFound(): Response {
  return rfpError("not_found", "No such RFP.", 404);
}
