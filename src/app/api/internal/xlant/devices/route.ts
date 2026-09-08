// GET /api/internal/xlant/devices — the caller's OWN computers, the ones
// holding a live XLAnt token right now, staff-gated (ARCHITECTURE.md §5.22).
//
// The identity is taken from the SESSION and from nothing else. There is no
// body here to ignore and no `email` parameter to accept: a route that let a
// caller name someone else would list that person's machines and — with the
// sign-out beside it — take them off the air. The relay's internal
// `GET /v1/device/list` DOES take an email, because the relay serves several
// callers; this host supplies exactly one value for it.
//
// Why this route exists at all. Until 2026-09-08 the relay kept one active
// token per (person, kind) and every mint signed the previous machine out, so
// "which of my computers are signed in" had one possible answer and needed no
// page. Now a person holds as many tokens as they have computers, revocation
// is an explicit act rather than a side effect of minting, and a list they can
// read is the only way that act can be aimed.
//
// Same skeleton as the mint next door: runtime knobs pinned rather than
// inherited, the gate's typed reasons passed through as 401/403, and every
// answer `no-store, private` — this is one person's machine inventory and no
// cache anywhere should hold a copy.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import {
  relayInternalGet,
  requireXlantStaff,
  xlantConfig,
  xlantDeviceSummaries,
} from "@/lib/xlant";

function fail(error: string, status: number): Response {
  return Response.json(
    { error },
    { status, headers: { "cache-control": "no-store, private" } }
  );
}

export async function GET(): Promise<Response> {
  const cfg = xlantConfig();
  if (!cfg) return fail("XLAnt is not configured on this host", 503);

  const gate = await requireXlantStaff();
  // 401 for "no session" and 403 for "wrong session", the same split the mint
  // and /rfp use: "sign in again" and "this account cannot" are different
  // instructions and the island says whichever is true.
  if (!gate.ok) {
    return fail(gate.reason, gate.reason === "unauthenticated" ? 401 : 403);
  }
  const email = gate.session.email.toLowerCase();

  let res: Response;
  try {
    res = await relayInternalGet(
      cfg,
      `/v1/device/list?email=${encodeURIComponent(email)}`
    );
  } catch {
    // Timeout, DNS, refused connection: the relay did not answer. Kept
    // separate from a refusal so the island can say "try again in a moment"
    // for one and not for the other.
    return fail("the XLAnt relay did not answer", 502);
  }
  if (!res.ok) return fail("relay refused the device list", 502);

  // A 200 is not a promise of JSON: an intermediary can answer 200 with an
  // HTML error page, and an unguarded .json() would throw a 500 out of a route
  // whose real answer is "the relay did not give us a list".
  const json = (await res.json().catch(() => null)) as {
    devices?: unknown;
  } | null;
  const devices = xlantDeviceSummaries(json?.devices);
  // NOT an empty list. "You have no computers" is a sentence the page will
  // print, and it must never be printed because the relay answered something
  // unreadable — a person with two laptops would be told they have none and
  // would go and mint a third token.
  if (!devices) return fail("relay returned no device list", 502);

  return Response.json(
    { devices },
    { headers: { "cache-control": "no-store, private" } }
  );
}
