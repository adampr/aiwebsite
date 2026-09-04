// GET|POST /api/xlant/relay/* — the DEVICE passthrough to the XLAnt relay on
// the internal VM (ARCHITECTURE.md §5.22). Moved here from roleplay.xl.net on
// 2026-09-04 with desktop 0.2.1, which is re-signed and re-published with its
// relay base and updater feed pinned to https://ai.xl.net. The cutover is
// TWO-PHASE: roleplay keeps its copy of this route as a transitional bridge
// for the one 0.2.0 desktop still in service (a 0.2.0 build resolves its feed
// from its own bundled default), and phase 2 retires it — see §5.22 and the
// xlant repo's docs/SETUP.md "Cutover (2026-09-04)".
//
// It adds the shared proxy secret and `X-XLAnt-Via: proxy` (the relay hard-
// rejects its INTERNAL routes when they carry that header, so a request that
// arrives through here can never reach the token mint), forwards the caller's
// own Authorization header when there is one, and streams bodies both ways.
// Only the hello / incident / tool-bridge / MCP surface is reachable — the
// allowlist lives in `@/lib/xlant` and mirrors the xlant repo's contract.
//
// TWO kinds of caller arrive here, and they authenticate differently:
//   · the Windows desktop, with `Authorization: Bearer <device token>`, for
//     the hello + incident routes and for the tool bridge it long-polls
//     (`v1/incident/{id}/tools/next?wait=25`, a GET, and the matching
//     `/tools/{callId}/result` POST);
//   · Cursor's cloud VM, acting as an MCP client, for `v1/mcp/{bridgeToken}`.
//     Those requests carry NO device Authorization header — the per-run bridge
//     token in the PATH is the whole credential, and the RELAY authenticates
//     it (unknown ⇒ 404, finished run ⇒ 410). We forward them as they arrive
//     and add nothing.
//
// NOT in `src/proxy.ts`'s `protectedPrefixes`, deliberately — see the comment
// on `/api/internal/xlant` there. Neither caller is a browser and neither
// sends an Origin header, so a CSRF origin check would refuse every device
// POST on this host.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
// Declared for PORTABILITY, not because anything here enforces it: on this
// self-hosted `next start` nothing under next/dist/server reads maxDuration —
// only the build manifest carries it (measured 2026-09-04). The real ceilings
// on this host are Cloudflare's 100 s edge close and nginx's 120 s
// proxy_read_timeout. It stays declared so a move to a platform that DOES
// enforce a function budget does not silently cut the long polls.
export const maxDuration = 300;

import { isXlantMcpPath, isXlantRelayPath, xlantConfig } from "@/lib/xlant";

// Cap BEFORE buffering: this route runs pre-auth (the relay authenticates
// downstream), so an unauthenticated body must never be allowed to expand in
// this shared host's memory. XLAnt sends only JSON — no audio, no uploads — so
// 1 MB is generous (the largest bodies are a capped incident detail, a tool
// result, or an MCP tools/call frame).
const MAX_BODY = 1024 * 1024;

function fail(error: string, status: number): Response {
  return Response.json(
    { error },
    { status, headers: { "Cache-Control": "private, no-store" } }
  );
}

/**
 * Did this fetch rejection come from the AbortSignal rather than from the
 * connection? undici reports the timeout as a `TimeoutError` DOMException, but
 * it also wraps failures in a `TypeError: fetch failed` whose `cause` carries
 * the real one, so the whole cause chain is walked (with a seen-set, because
 * a self-referential cause would otherwise spin).
 */
function isAbortError(err: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur !== null && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const name = (cur as { name?: unknown }).name;
    if (name === "TimeoutError" || name === "AbortError") return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Buffer a body whose length was not declared, abandoning the read the moment
 * it passes `max` (returns null). Used only for the MCP path — see forward().
 */
async function readCapped(
  stream: ReadableStream<Uint8Array>,
  max: number
): Promise<ArrayBuffer | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out.buffer;
}

async function forward(
  req: Request,
  ctx: { params: Promise<{ path?: string[] }> }
): Promise<Response> {
  const cfg = xlantConfig();
  if (!cfg) return fail("XLAnt is not configured on this host", 503);

  const { path } = await ctx.params;
  const rel = (path ?? []).join("/");
  // 404, not 403: an unallowlisted path is not a thing this origin has.
  if (!isXlantRelayPath(rel)) return fail("not found", 404);
  const isMcp = isXlantMcpPath(rel);

  const url = new URL(req.url);
  // url.search is load-bearing: the tool-bridge long poll is
  // `/tools/next?wait=25` and the events poll is `/events?since=<cursor>`.
  const target = `${cfg.relayUrl}/${rel}${url.search}`;

  const headers: Record<string, string> = {
    "X-XLAnt-Proxy-Secret": cfg.proxySecret,
    "X-XLAnt-Via": "proxy",
  };
  const auth = req.headers.get("authorization");
  if (auth) headers["Authorization"] = auth;
  const contentType = req.headers.get("content-type");
  if (contentType) headers["Content-Type"] = contentType;
  // Streamable HTTP MCP negotiates the reply shape on Accept
  // (application/json vs text/event-stream) and carries its session in
  // Mcp-Session-Id; both must survive the hop, in both directions.
  const accept = req.headers.get("accept");
  if (accept) headers["Accept"] = accept;
  const session = req.headers.get("mcp-session-id");
  if (session) headers["Mcp-Session-Id"] = session;

  let body: BodyInit | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const declaredRaw = req.headers.get("content-length");
    if (declaredRaw !== null) {
      const declared = Number(declaredRaw);
      if (!Number.isFinite(declared) || declared < 0) {
        return fail("content-length required", 411);
      }
      if (declared > MAX_BODY) return fail("body too large", 413);
      // Re-checked after the read: a declared length is a claim, not a fact.
      const buf = await req.arrayBuffer();
      if (buf.byteLength > MAX_BODY) return fail("body too large", 413);
      body = buf;
    } else if (isMcp) {
      // MCP clients normally send JSON with a Content-Length, but some stream
      // the frame instead (Transfer-Encoding: chunked on h1; no length header
      // at all on h2), so there is nothing to check up front. Buffer it here
      // under the SAME 1 MB cap and drop the request the moment it goes over.
      // Only the MCP path gets this: the desktop always declares a length.
      const buffered = req.body
        ? await readCapped(req.body, MAX_BODY)
        : new ArrayBuffer(0);
      if (buffered === null) return fail("body too large", 413);
      body = buffered;
    } else {
      return fail("content-length required", 411);
    }
  }

  let res: Response;
  try {
    res = await fetch(target, {
      method: req.method,
      headers,
      body,
      // 290 s: one MCP tools/call blocks on the PC for up to TOOL_CALL_MAX_MS
      // (240 s) before the relay answers it with a timeout of its own, and the
      // tools/next long poll holds for TOOL_POLL_WAIT_S. It is a backstop, not
      // the operative ceiling — Cloudflare closes an idle response at 100 s
      // and nginx's proxy_read_timeout is 120 s, so anything past 100 s is a
      // 524 at the edge whatever this signal says.
      signal: AbortSignal.timeout(290_000),
    });
  } catch (err) {
    // An unguarded fetch here is a bare 500 with an HTML body: `next start`
    // renders its error page for a throw out of a route handler, and the two
    // things that throw are exactly the two an operator most needs told apart
    // — the relay being down (ECONNREFUSED / DNS / TLS, immediate) and the
    // relay being slow (the AbortSignal firing). Both answer JSON in the same
    // shape as every other refusal on this route.
    return isAbortError(err)
      ? fail("relay timeout", 504)
      : fail("relay unreachable", 502);
  }

  const out: Record<string, string> = {
    "Content-Type": res.headers.get("content-type") ?? "application/json",
    "Cache-Control": "private, no-store",
  };
  const outSession = res.headers.get("mcp-session-id");
  if (outSession) out["Mcp-Session-Id"] = outSession;
  return new Response(res.body, { status: res.status, headers: out });
}

// GET is here for the tools/next long poll and for MCP clients that probe the
// path for a server-initiated stream — the latter is forwarded and the relay
// answers 405.
export { forward as GET, forward as POST };
