// POST /api/internal/xlant/device-token — mint (or rotate) the caller's XLAnt
// device token, staff-gated (ARCHITECTURE.md §5.22).
//
// The identity is taken from the SESSION, never from the request body: the
// token this returns is what lets a PC reach the technician lane as that
// person, so a caller must not be able to name someone else. Optional JSON
// body `{ kind?: "windows" }` (absent or empty body ⇒ windows, the only kind
// XLAnt has). The relay keeps one active token per (user, kind) and revokes
// the previous one on mint, so this is also "sign out my old PC".
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import {
  isXlantDeviceKind,
  relayInternal,
  requireXlantStaff,
  xlantConfig,
  type XlantDeviceKind,
} from "@/lib/xlant";

interface MintBody {
  kind?: unknown;
}

function fail(error: string, status: number): Response {
  return Response.json(
    { error },
    { status, headers: { "cache-control": "no-store, private" } }
  );
}

/** Tolerates no body, an empty body, or a JSON object; rejects anything else. */
async function readBody(req: Request): Promise<MintBody | null> {
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
      ? (parsed as MintBody)
      : null;
  } catch {
    return null;
  }
}

export async function POST(req: Request): Promise<Response> {
  const cfg = xlantConfig();
  if (!cfg) return fail("XLAnt is not configured on this host", 503);

  const gate = await requireXlantStaff();
  // 401 for "no session" and 403 for "wrong session", mirroring
  // requireRfpUser(): the button can tell a signed-out staffer to sign in
  // again, which is a different instruction from "this account cannot".
  if (!gate.ok) {
    return fail(gate.reason, gate.reason === "unauthenticated" ? 401 : 403);
  }
  const session = gate.session;

  const body = await readBody(req);
  if (body === null) return fail("body must be a JSON object", 400);
  const kindRaw = body.kind ?? "windows";
  if (!isXlantDeviceKind(kindRaw)) return fail("kind must be 'windows'", 400);
  const kind: XlantDeviceKind = kindRaw;

  const email = session.email.toLowerCase();
  let res: Response;
  try {
    res = await relayInternal(cfg, "/v1/device/issue", {
      email,
      displayName: session.displayName ?? email.split("@")[0],
      kind,
    });
  } catch {
    // Timeout, DNS, refused connection: the relay did not answer. Same shape
    // as a refusal so the button says one true thing either way.
    return fail("the XLAnt relay did not answer", 502);
  }
  if (!res.ok) return fail("relay refused the token mint", 502);

  // A 200 is not a promise of JSON: an intermediary can answer 200 with an
  // HTML error page, and an unguarded .json() would throw a 500 out of a
  // route whose real answer is "the relay did not give us a token".
  const json = (await res.json().catch(() => null)) as {
    token?: unknown;
    kind?: unknown;
  } | null;
  if (!json || typeof json.token !== "string" || !json.token) {
    return fail("relay returned no token", 502);
  }
  return Response.json(
    {
      token: json.token,
      kind: isXlantDeviceKind(json.kind) ? json.kind : kind,
    },
    { headers: { "cache-control": "no-store, private" } }
  );
}
