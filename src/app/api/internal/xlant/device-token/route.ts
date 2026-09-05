// POST /api/internal/xlant/device-token — mint (or rotate) the caller's XLAnt
// device token, staff-gated (ARCHITECTURE.md §5.22).
//
// The identity is taken from the SESSION, never from the request body: the
// token this returns is what lets a machine reach the technician lane as that
// person, so a caller must not be able to name someone else. Optional JSON
// body `{ kind?: "windows" | "mac" }` (absent or empty body ⇒ windows, which
// is what every caller sent before contract 0.5.0). The relay keeps one active
// token per (user, kind) and revokes the previous one of THAT KIND on mint, so
// this is also "sign out my old PC" — and a Mac mint leaves a Windows token
// alone.
//
// A `mac` mint PROBES FIRST. See probeRelayMacSupport() for the argument; the
// short version is that a pre-0.5.0 relay refuses the kind with a generic 400
// this host would report as "relay refused the token mint", which sends a
// member of staff hunting for a fault that is really "the Mac lane is not
// deployed yet". A Windows mint does not probe: it has worked since day one
// and must not acquire a new way to fail.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import {
  isXlantDeviceKind,
  probeRelayMacSupport,
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
  if (!isXlantDeviceKind(kindRaw)) {
    return fail("kind must be 'windows' or 'mac'", 400);
  }
  const kind: XlantDeviceKind = kindRaw;

  if (kind === "mac") {
    const probe = await probeRelayMacSupport(cfg);
    // 503, not 502: the host is armed and the relay is answering — the
    // capability is simply not deployed yet, and it arrives with a relay
    // upgrade rather than a retry. The sentence names the version so an
    // operator reading it knows exactly what to ship.
    if (probe === "unsupported") {
      return fail(
        "the relay does not support Mac tokens yet (needs relay 0.5.0)",
        503
      );
    }
    // We could not read the capability at all, which is NOT the same claim.
    // Same sentence and status the mint itself uses for an unreachable relay,
    // so the button says one true thing either way.
    if (probe === "unreadable") return fail("the XLAnt relay did not answer", 502);
  }

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
