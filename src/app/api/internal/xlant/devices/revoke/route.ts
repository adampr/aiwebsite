// POST /api/internal/xlant/devices/revoke — sign ONE of the caller's own
// computers out, staff-gated (ARCHITECTURE.md §5.22).
//
// This route is the replacement for a security property the old mint used to
// give away for free. Until 2026-09-08 minting a token revoked the person's
// previous token of that kind, so "my laptop was stolen" was answered by
// pressing Generate; that same behaviour signed a working second machine out
// every time somebody set up a new one, which is the defect this round exists
// to fix. Taking it out leaves a real need behind — hence an explicit act,
// aimed at one computer, that says what it does before it does it.
//
// The body carries a `deviceId` and NOTHING ELSE that matters. The email goes
// to the relay from the SESSION, exactly as the mint does it: a body `email`
// is not read, not merged and not trusted, because the relay would honour it
// and sign out a machine belonging to whoever was named. The relay checks the
// device is that email's ACTIVE device and answers 404 when it is not, so a
// guessed id is refused there too — this host does not rely on that alone, but
// it does not have to duplicate it either.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { isXlantDeviceId, relayInternal, requireXlantStaff, xlantConfig } from "@/lib/xlant";

interface RevokeBody {
  deviceId?: unknown;
}

function fail(error: string, status: number): Response {
  return Response.json(
    { error },
    { status, headers: { "cache-control": "no-store, private" } }
  );
}

/** Tolerates an empty body and rejects anything that is not a JSON object —
 * the mint's reader, minus its "absent means windows" default, because there
 * is no defensible default for "which computer". */
async function readBody(req: Request): Promise<RevokeBody | null> {
  let text = "";
  try {
    text = await req.text();
  } catch {
    return {};
  }
  if (text.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as RevokeBody)
      : null;
  } catch {
    return null;
  }
}

export async function POST(req: Request): Promise<Response> {
  const cfg = xlantConfig();
  if (!cfg) return fail("XLAnt is not configured on this host", 503);

  const gate = await requireXlantStaff();
  if (!gate.ok) {
    return fail(gate.reason, gate.reason === "unauthenticated" ? 401 : 403);
  }
  const session = gate.session;

  // Read AFTER the gate, like the staff download's query string: a malformed
  // body must never tell an anonymous caller what parameters this route takes.
  const body = await readBody(req);
  if (body === null) return fail("body must be a JSON object", 400);
  if (!isXlantDeviceId(body.deviceId)) {
    return fail("deviceId must be a device id", 400);
  }
  const deviceId = body.deviceId;

  const email = session.email.toLowerCase();
  let res: Response;
  try {
    res = await relayInternal(cfg, "/v1/device/revoke", { email, deviceId });
  } catch {
    return fail("the XLAnt relay did not answer", 502);
  }
  // The relay's 404 is the one refusal a staffer can cause and can act on: the
  // id is not their active device — already signed out, or never theirs. It is
  // passed through as a 404 rather than flattened into the 502 bucket, because
  // "nothing to do" and "we could not do it" ask for different next steps, and
  // the page reloads the list either way.
  if (res.status === 404) {
    return fail("that computer is not yours or is already signed out", 404);
  }
  if (!res.ok) return fail("relay refused the sign-out", 502);

  // The relay's body carries `{ ok, deviceId, superseded }`; only the id is
  // echoed. The count of pieces of work the revoke closed is the relay's
  // business and the page has no true sentence to hang on it — the list
  // reloads and shows what is left, which is the thing the person asked about.
  return Response.json(
    { ok: true, deviceId },
    { headers: { "cache-control": "no-store, private" } }
  );
}
