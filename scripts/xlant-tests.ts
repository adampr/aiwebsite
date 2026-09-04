#!/usr/bin/env -S npx tsx
// Invariant checks for the XLAnt DEVICE lane (ARCHITECTURE.md §5.22). Plain
// node:assert, no framework (the host repo has none) and NO DATABASE. Run:
//
//   npm run test:xlant
//
// TWO HALVES. Sections 1-6 are pure: the allowlist, the artifact predicates and
// the verify cache, exercised as functions. Sections 7-9 EXECUTE THE REAL ROUTE
// HANDLERS AND THE REAL MIDDLEWARE in-process against a fake XLAnt relay on
// 127.0.0.1 and a scratch artifacts directory, because the pure half cannot see
// what the handlers actually put on the wire — which headers reach the relay,
// which caller-supplied headers do NOT, what a caller gets back when the relay
// is down. (A first cut of this file asserted the CSRF exclusion by grepping
// `src/proxy.ts` for quoted prefixes; that regex would miss a prefix added
// inline, so the middleware is now run instead.) No network leaves the box: the
// only server is one this file starts and stops.
//
// What is pinned:
//
//   · the relay ALLOWLIST — the exact six shapes and nothing else. That list
//     is a MIRROR of the route list in the xlant repo's
//     packages/shared/src/contract.ts, and the relay mirrors it a third time;
//     if a change to the contract does not appear here, the two sides have
//     drifted and the passthrough is either broken or too wide. The rejection
//     legs are the ones that matter: `v1/device/issue` and `v1/device/verify`
//     are the INTERNAL routes that mint and check device tokens, and a prefix
//     match or an unanchored test would publish them to the internet.
//   · which allowlisted path is the MCP one (the only body that may arrive
//     with no declared length);
//   · `safeArtifactName()` (the traversal gate) and `isXlantUpdateArtifact()`
//     (the RELEASE gate), which are different questions and are both needed:
//     `latest.yml.part` is a safe name and a truncated manifest;
//   · `verifyDeviceToken()`'s cache — positives cached, negatives and relay
//     failures NOT cached, oldest-half eviction past the cap, a too-short
//     token refused without a relay round-trip;
//   · and, live: forwarded vs withheld headers, the body caps, query-string
//     preservation, upstream status pass-through, 502/504 when the relay is
//     down or slow, the arming gate, and that the CSRF middleware lets an
//     Origin-less device POST through while still refusing one to
//     `/api/internal/xlant`.
//
// NO REAL TOKENS. Every token here is a synthetic filler string; a real device
// token reaches a technician agent on somebody's PC and git history would keep
// it after any revert.

import assert from "node:assert";
import http from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  XLANT_INSTALLER_RE,
  XLANT_MCP_PATH,
  XLANT_RELAY_ALLOWED,
  isXlantMcpPath,
  isXlantRelayPath,
  isXlantUpdateArtifact,
  resetXlantVerifyCache,
  safeArtifactName,
  verifyDeviceToken,
  xlantVerifyCacheSize,
  type XlantConfig,
} from "../src/lib/xlant";

let failures = 0;
async function leg(label: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`ok   ${label}`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${label}\n     ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// 1. The relay allowlist — exactly six shapes
// ---------------------------------------------------------------------------

await leg("the allowlist holds exactly the six contract shapes", () => {
  assert.equal(XLANT_RELAY_ALLOWED.length, 6);
  for (const re of XLANT_RELAY_ALLOWED) {
    // Anchored at BOTH ends: an unanchored entry matches any longer path that
    // merely contains an allowed one.
    assert.ok(re.source.startsWith("^"), `not ^-anchored: ${re.source}`);
    assert.ok(re.source.endsWith("$"), `not $-anchored: ${re.source}`);
    // A /g regex is stateful across .test() calls, so the predicate would
    // answer differently on identical input.
    assert.equal(re.flags, "", `unexpected flags on ${re.source}`);
  }
});

const ACCEPTED = [
  "v1/device/hello",
  "v1/incident/start",
  "v1/incident/inc_123/events",
  "v1/incident/inc_123/decision",
  "v1/incident/inc_123/chat",
  "v1/incident/inc_123/close",
  "v1/incident/inc-123/tools/next",
  "v1/incident/inc_123/tools/call-7/result",
  "v1/mcp/bridge_token_abc-123",
];

await leg("every device and MCP surface the contract names is accepted", () => {
  for (const rel of ACCEPTED) {
    assert.ok(isXlantRelayPath(rel), `should accept ${rel}`);
  }
});

const REJECTED = [
  // Prefix / suffix variants of an allowed path.
  "v1/device/hello/x",
  "v1/device/hello/",
  "xv1/device/hello",
  "v1/incident/start/x",
  "v1/incident/inc_123/events/x",
  "v1/incident/inc_123/tools/next/x",
  "v1/incident/inc_123/tools/call-7/result/extra",
  "v1/mcp/tok/x",
  // Traversal, in the shapes a catch-all can produce.
  "v1/incident/../x",
  "v1/incident/../../v1/device/issue",
  "v1/mcp/../device/issue",
  "../v1/device/hello",
  "v1/incident/%2e%2e/events",
  // Empty and bare segments.
  "",
  "v1/mcp/",
  "v1/mcp",
  "v1/incident//events",
  "v1/incident/inc_123/tools//result",
  // INTERNAL relay routes — this origin must never publish these.
  "v1/status",
  "v1/device/issue",
  "v1/device/verify",
  "v1/providers/refresh",
  // Near misses.
  "v1/device/hell",
  "v1/incident/inc_123/decisions",
  "v1/incident/inc_123/tools/next?wait=25",
  "v2/device/hello",
];

await leg("everything else is refused, traversal and internals included", () => {
  for (const rel of REJECTED) {
    assert.ok(!isXlantRelayPath(rel), `should reject ${JSON.stringify(rel)}`);
  }
});

await leg("the accept and reject lists do not overlap", () => {
  for (const rel of REJECTED) assert.ok(!ACCEPTED.includes(rel));
});

await leg("no URL metacharacter survives the allowlist", () => {
  // The allowlisted `rel` is concatenated into the upstream URL, so a
  // character that could open a query, a fragment, an authority or a second
  // path segment must never pass the id classes.
  const leaked: string[] = [];
  for (const ch of '?#%\\@:. \t\r\n<>"\'') {
    for (const cand of [
      `v1/mcp/a${ch}b`,
      `v1/incident/i${ch}d/events`,
      `v1/device/hello${ch}`,
      `v1/incident/i/tools/c${ch}1/result`,
    ]) {
      if (isXlantRelayPath(cand)) leaked.push(JSON.stringify(cand));
    }
  }
  assert.deepEqual(leaked, []);
});

// ---------------------------------------------------------------------------
// 2. MCP path detection — the one allowlisted path that is not a device route
// ---------------------------------------------------------------------------

await leg("only v1/mcp/{bridgeToken} is the MCP path", () => {
  assert.ok(isXlantMcpPath("v1/mcp/bridge_token_abc-123"));
  assert.ok(XLANT_MCP_PATH.test("v1/mcp/t0"));
  for (const rel of ACCEPTED) {
    if (rel.startsWith("v1/mcp/")) continue;
    assert.ok(!isXlantMcpPath(rel), `${rel} is not the MCP path`);
  }
  // Nothing the allowlist already refused is an MCP path either, so the
  // length-less-body concession cannot be reached around the allowlist.
  for (const rel of REJECTED) {
    assert.ok(!isXlantMcpPath(rel), `${rel} is not the MCP path`);
  }
});

await leg("the MCP shape is one of the allowlisted six", () => {
  assert.ok(
    XLANT_RELAY_ALLOWED.some((re) => re.source === XLANT_MCP_PATH.source),
    "XLANT_MCP_PATH must be one of XLANT_RELAY_ALLOWED"
  );
});

// ---------------------------------------------------------------------------
// 3. safeArtifactName — the update feed's traversal gate
// ---------------------------------------------------------------------------

await leg("the three names electron-updater actually asks for pass", () => {
  for (const n of [
    "latest.yml",
    "XLAnt-Setup-0.2.1.exe",
    "XLAnt-Setup-0.2.1.exe.blockmap",
  ]) {
    assert.ok(safeArtifactName(n), `should accept ${n}`);
  }
});

await leg("traversal, absolute paths and odd names are refused", () => {
  for (const n of [
    "",
    ".",
    "..",
    "../.env",
    "../../etc/passwd",
    "a/../b",
    "sub/latest.yml",
    "/etc/passwd",
    ".env",
    "-rf",
    "latest.yml .txt",
    "latest yml",
    "XLAnt Setup.exe",
  ]) {
    assert.ok(!safeArtifactName(n), `should refuse ${JSON.stringify(n)}`);
  }
});

// ---------------------------------------------------------------------------
// 4. isXlantUpdateArtifact — the RELEASE gate, a different question
// ---------------------------------------------------------------------------

await leg("exactly the manifest, an installer and its blockmap are releases", () => {
  for (const n of [
    "latest.yml",
    "XLAnt-Setup-0.2.1.exe",
    "XLAnt-Setup-0.2.1.exe.blockmap",
    "XLAnt-Setup-1.10.0-beta.3.exe",
    "XLAnt-Setup-1.10.0-beta.3.exe.blockmap",
  ]) {
    assert.ok(isXlantUpdateArtifact(n), `should publish ${n}`);
  }
});

await leg("a safe name is not automatically a publishable one", () => {
  for (const n of [
    // The publish step's half-written temp files. `latest.yml.part` is the one
    // that matters: served, it hands electron-updater a truncated manifest.
    "latest.yml.part",
    "XLAnt-Setup-0.2.1.exe.part",
    "XLAnt-Setup-0.2.1.exe.blockmap.part",
    // Anything else an operator may leave in the directory.
    "notes.txt",
    "latest.yml.bak",
    "latest-mac.yml",
    "XLAnt-Setup-x.exe.exe",
    "XLAnt-Setup-1.2.exe",
    "XLAnt-Setup-0.2.1.exe.blockmap.blockmap",
    "blockmap",
    ".blockmap",
    "signing.log",
  ]) {
    assert.ok(safeArtifactName(n) || n.startsWith("."), `precondition: ${n}`);
    assert.ok(!isXlantUpdateArtifact(n), `should NOT publish ${n}`);
  }
});

// ---------------------------------------------------------------------------
// 5. The installer filename regex
// ---------------------------------------------------------------------------

await leg("the installer regex captures a real version and nothing else", () => {
  assert.equal(XLANT_INSTALLER_RE.exec("XLAnt-Setup-0.2.1.exe")?.[1], "0.2.1");
  assert.equal(
    XLANT_INSTALLER_RE.exec("XLAnt-Setup-1.10.0-beta.3.exe")?.[1],
    "1.10.0-beta.3"
  );
  for (const n of [
    // The defect the strict pattern exists for: a loose [\w.-]+ accepts this
    // and would then show "x.exe" to staff as the version being downloaded.
    "XLAnt-Setup-x.exe.exe",
    "XLAnt-Setup-.exe",
    "XLAnt-Setup-1.2.exe",
    "XLAnt-Setup-1.2.3.4.exe",
    "XLAnt-Setup-0.2.1.exe.blockmap",
    "XLAnt-Setup-0.2.1.exe.part",
    "xlant-setup-0.2.1.exe",
    "latest.yml",
    "prefix-XLAnt-Setup-0.2.1.exe",
  ]) {
    assert.ok(!XLANT_INSTALLER_RE.test(n), `should refuse ${n}`);
  }
});

// ---------------------------------------------------------------------------
// 6. verifyDeviceToken — the cache, against a stubbed global fetch
// ---------------------------------------------------------------------------

const cfg: XlantConfig = {
  relayUrl: "http://relay.invalid:8403",
  proxySecret: "x".repeat(32),
  artifactsDir: "/nonexistent-artifacts",
};

// Synthetic, and long enough to clear the pre-network length test.
const token = (n: number) =>
  `synthetic-device-token-${String(n).padStart(6, "0")}`;

const realFetch = globalThis.fetch;
let calls = 0;
type Mode = "ok" | "refuse" | "throw";
let mode: Mode = "ok";
globalThis.fetch = (async () => {
  calls++;
  if (mode === "throw") throw new Error("relay unreachable (stub)");
  return new Response(null, { status: mode === "ok" ? 200 : 401 });
}) as typeof fetch;

function fresh(m: Mode) {
  resetXlantVerifyCache();
  calls = 0;
  mode = m;
}

await leg("a too-short or empty token is refused with no relay call", async () => {
  fresh("ok");
  assert.equal(await verifyDeviceToken(cfg, ""), false);
  assert.equal(await verifyDeviceToken(cfg, "short"), false);
  assert.equal(await verifyDeviceToken(cfg, "a".repeat(19)), false);
  assert.equal(calls, 0, "no fetch may be made for a token of the wrong shape");
  assert.equal(xlantVerifyCacheSize(), 0);
  // 20 characters is the first accepted length, and it DOES reach the relay.
  assert.equal(await verifyDeviceToken(cfg, "a".repeat(20)), true);
  assert.equal(calls, 1);
});

await leg("a positive is cached: the second ask makes no relay call", async () => {
  fresh("ok");
  assert.equal(await verifyDeviceToken(cfg, token(1)), true);
  assert.equal(calls, 1);
  assert.equal(await verifyDeviceToken(cfg, token(1)), true);
  assert.equal(await verifyDeviceToken(cfg, token(1)), true);
  assert.equal(calls, 1, "a cached positive must not re-ask the relay");
  assert.equal(xlantVerifyCacheSize(), 1);
  // A DIFFERENT token is a different entry, never a hit on the first.
  assert.equal(await verifyDeviceToken(cfg, token(2)), true);
  assert.equal(calls, 2);
  assert.equal(xlantVerifyCacheSize(), 2);
});

await leg("a refusal is NOT cached: every ask re-asks the relay", async () => {
  fresh("refuse");
  assert.equal(await verifyDeviceToken(cfg, token(3)), false);
  assert.equal(await verifyDeviceToken(cfg, token(3)), false);
  assert.equal(calls, 2, "a negative must not be remembered");
  assert.equal(xlantVerifyCacheSize(), 0, "nothing is stored for a refusal");
});

await leg("a relay that throws is false, and is not remembered either", async () => {
  fresh("throw");
  assert.equal(await verifyDeviceToken(cfg, token(4)), false);
  assert.equal(xlantVerifyCacheSize(), 0);
  assert.equal(calls, 1);
  // The blip passes; the very next request must succeed rather than sit out
  // the TTL, which is the whole reason negatives are not cached.
  mode = "ok";
  assert.equal(await verifyDeviceToken(cfg, token(4)), true);
  assert.equal(calls, 2);
  assert.equal(xlantVerifyCacheSize(), 1);
});

await leg("past 500 entries the OLDEST HALF is evicted, not the map", async () => {
  fresh("ok");
  for (let i = 1; i <= 501; i++) await verifyDeviceToken(cfg, token(i));
  assert.equal(xlantVerifyCacheSize(), 501, "the cap is a > test, so 501 fits");
  // The 502nd insert trips it: 501 > 500, drop floor(501/2) = 250, then set.
  await verifyDeviceToken(cfg, token(502));
  assert.equal(xlantVerifyCacheSize(), 252);
  const after = calls;
  // The newest survivors are still cached, so they cost no relay call.
  assert.equal(await verifyDeviceToken(cfg, token(251)), true);
  assert.equal(await verifyDeviceToken(cfg, token(501)), true);
  assert.equal(await verifyDeviceToken(cfg, token(502)), true);
  assert.equal(calls, after, "entries past the eviction line must survive");
  // The oldest were dropped, so they cost a round-trip again — which is the
  // point: eviction must not sign every device out at once.
  assert.equal(await verifyDeviceToken(cfg, token(1)), true);
  assert.equal(calls, after + 1, "token 1 was evicted and must be re-verified");
});

globalThis.fetch = realFetch;
resetXlantVerifyCache();

// ===========================================================================
// 7. THE REAL HANDLERS, in-process, against a fake relay
// ===========================================================================

// A scratch artifacts directory plus a sibling holding a file that must never
// be served, so the traversal legs have a real target to fail to reach.
const ROOT = mkdtempSync(join(tmpdir(), "xlant-tests-"));
const ART = join(ROOT, "artifacts");
const OUTSIDE = join(ROOT, "outside");
mkdirSync(ART);
mkdirSync(OUTSIDE);
const YML = "version: 9.9.9\npath: XLAnt-Setup-9.9.9.exe\n";
writeFileSync(join(ART, "latest.yml"), YML);
writeFileSync(join(ART, "XLAnt-Setup-9.9.9.exe"), Buffer.alloc(4096, 7));
writeFileSync(join(ART, "XLAnt-Setup-9.9.9.exe.blockmap"), Buffer.alloc(64, 3));
writeFileSync(join(ART, "latest.yml.part"), "HALF WRITTEN\n");
writeFileSync(join(OUTSIDE, "secret.txt"), "SYNTHETIC-NEVER-SERVE\n");

interface RelayCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}
let relayCalls: RelayCall[] = [];
let relayReply = {
  status: 200,
  body: '{"ok":true}',
  headers: {} as Record<string, string>,
};
const relay = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    relayCalls.push({
      method: req.method ?? "",
      url: req.url ?? "",
      headers: Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, String(v)])
      ),
      body: Buffer.concat(chunks).toString(),
    });
    res.writeHead(relayReply.status, {
      "content-type": "application/json",
      ...relayReply.headers,
    });
    res.end(relayReply.body);
  });
});
await new Promise<void>((r) => relay.listen(0, "127.0.0.1", () => r()));
const RELAY_PORT = (relay.address() as AddressInfo).port;

const SECRET = "d".repeat(32);
process.env.SKIP_ENV_VALIDATION = "1";
process.env.INTERNAL_TRACK_SECRET ??= "synthetic-track-secret";
process.env.XLANT_RELAY_URL = `http://127.0.0.1:${RELAY_PORT}`;
process.env.XLANT_PROXY_SHARED_SECRET = SECRET;
process.env.XLANT_ARTIFACTS_DIR = ART;

// Imported AFTER the env is set. (They read it per request, but importing late
// keeps this file honest about the ordering the routes actually rely on.)
const relayRoute = await import("../src/app/api/xlant/relay/[[...path]]/route");
const updateRoute = await import("../src/app/api/xlant/update/[[...path]]/route");

const U = "https://ai.xl.net";
const ctx = (rel: string) => ({
  params: Promise.resolve({ path: rel === "" ? [] : rel.split("/") }),
});
function relayReset(
  status = 200,
  body = '{"ok":true}',
  headers: Record<string, string> = {}
) {
  relayCalls = [];
  relayReply = { status, body, headers };
}
// `duplex: "half"` is required by undici for a streamed request body and is
// absent from the DOM RequestInit type.
type StreamInit = RequestInit & { duplex: "half" };

await leg("relay: our secret and Via are SET, the caller's are not forwarded", async () => {
  relayReset();
  const res = await relayRoute.POST(
    new Request(`${U}/api/xlant/relay/v1/device/hello`, {
      method: "POST",
      body: '{"a":1}',
      headers: {
        "content-length": "7",
        "content-type": "application/json",
        authorization: "Bearer synthetic-device-token-0001",
        // Spoofs a caller might try. None may reach the relay.
        "x-xlant-via": "caller-spoof",
        "x-xlant-proxy-secret": "SYNTHETIC-ATTACKER-VALUE",
        cookie: "session=abc",
      },
    }),
    ctx("v1/device/hello")
  );
  assert.equal(res.status, 200);
  assert.equal(relayCalls.length, 1);
  const h = relayCalls[0].headers;
  assert.equal(h["x-xlant-proxy-secret"], SECRET, "the secret must be OURS");
  assert.equal(h["x-xlant-via"], "proxy", "Via must be SET, not passed through");
  assert.equal(h["authorization"], "Bearer synthetic-device-token-0001");
  assert.equal(h["content-type"], "application/json");
  assert.equal(h["cookie"], undefined, "no browser cookie may reach the relay");
  assert.equal(relayCalls[0].body, '{"a":1}');
  assert.equal(relayCalls[0].url, "/v1/device/hello");
  assert.equal(res.headers.get("cache-control"), "private, no-store");
});

await leg("relay: off-list and INTERNAL paths 404 without touching the relay", async () => {
  for (const rel of [
    "v1/device/issue",
    "v1/device/verify",
    "v1/status",
    "v1/providers/refresh",
    "v1/device/hello/x",
    "v1/mcp/a/b",
    "../v1/device/hello",
    "v1/incident/../../v1/device/issue",
    "v1/incident/inc1/tools/next/x",
    "",
    "v1/mcp",
  ]) {
    relayReset();
    const res = await relayRoute.GET(
      new Request(`${U}/api/xlant/relay/${rel}`),
      ctx(rel)
    );
    assert.equal(res.status, 404, `status for ${JSON.stringify(rel)}`);
    assert.equal(relayCalls.length, 0, `relay touched for ${rel}`);
  }
  relayReset();
  const res = await relayRoute.GET(
    new Request(`${U}/api/xlant/relay/v1/status`),
    ctx("v1/status")
  );
  assert.equal(await res.text(), '{"error":"not found"}');
  assert.equal(res.headers.get("cache-control"), "private, no-store");
});

await leg("relay: the MCP hop invents no Authorization and carries the session", async () => {
  relayReset();
  const res = await relayRoute.POST(
    new Request(`${U}/api/xlant/relay/v1/mcp/synthetic-bridge`, {
      method: "POST",
      body: '{"jsonrpc":"2.0"}',
      headers: {
        "content-length": "17",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": "SESS-1",
      },
    }),
    ctx("v1/mcp/synthetic-bridge")
  );
  assert.equal(res.status, 200);
  assert.equal(relayCalls.length, 1);
  assert.equal(
    relayCalls[0].headers["authorization"],
    undefined,
    "the bridge token in the path is the whole credential"
  );
  assert.equal(
    relayCalls[0].headers["accept"],
    "application/json, text/event-stream"
  );
  assert.equal(relayCalls[0].headers["mcp-session-id"], "SESS-1");
});

await leg("relay: body caps — 411, 413 declared, 413 streamed, 1 MB exactly", async () => {
  // A device POST with no Content-Length is refused outright.
  relayReset();
  const noLen = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode("x"));
      c.close();
    },
  });
  let res = await relayRoute.POST(
    new Request(`${U}/api/xlant/relay/v1/incident/start`, {
      method: "POST",
      body: noLen,
      duplex: "half",
    } as StreamInit),
    ctx("v1/incident/start")
  );
  assert.equal(res.status, 411, "device POST without Content-Length");
  assert.equal(relayCalls.length, 0);

  // The MCP path buffers a length-less body instead.
  relayReset();
  const chunked = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode('{"chunked":true}'));
      c.close();
    },
  });
  res = await relayRoute.POST(
    new Request(`${U}/api/xlant/relay/v1/mcp/synthetic-bridge`, {
      method: "POST",
      body: chunked,
      duplex: "half",
    } as StreamInit),
    ctx("v1/mcp/synthetic-bridge")
  );
  assert.equal(res.status, 200, "MCP chunked body is forwarded");
  assert.equal(relayCalls[0]?.body, '{"chunked":true}');

  // …under the same cap, and the read is abandoned rather than drained.
  relayReset();
  let sent = 0;
  const flood = new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent >= 2 * 1024 * 1024) {
        c.close();
        return;
      }
      c.enqueue(new Uint8Array(64 * 1024));
      sent += 64 * 1024;
    },
  });
  res = await relayRoute.POST(
    new Request(`${U}/api/xlant/relay/v1/mcp/synthetic-bridge`, {
      method: "POST",
      body: flood,
      duplex: "half",
    } as StreamInit),
    ctx("v1/mcp/synthetic-bridge")
  );
  assert.equal(res.status, 413, "2 MB streamed to the MCP path");
  assert.equal(relayCalls.length, 0, "the relay never saw it");
  // The guarantee is that readCapped STOPS once the total passes the cap, not
  // that it stops on the exact byte: the producer may already have queued a
  // chunk or two behind the reader. What must not happen is draining all 2 MB.
  assert.ok(
    sent > 1024 * 1024 && sent <= 1024 * 1024 + 256 * 1024,
    `abandoned the read after ${sent} bytes (want just past the 1 MB cap)`
  );

  // A declared length over the cap is refused before the body is read…
  relayReset();
  res = await relayRoute.POST(
    new Request(`${U}/api/xlant/relay/v1/incident/start`, {
      method: "POST",
      body: "x",
      headers: { "content-length": String(1024 * 1024 + 1) },
    }),
    ctx("v1/incident/start")
  );
  assert.equal(res.status, 413);
  assert.equal(relayCalls.length, 0);

  // …and exactly 1 MB is allowed through.
  relayReset();
  res = await relayRoute.POST(
    new Request(`${U}/api/xlant/relay/v1/incident/start`, {
      method: "POST",
      body: "x",
      headers: { "content-length": String(1024 * 1024) },
    }),
    ctx("v1/incident/start")
  );
  assert.equal(res.status, 200, "exactly at the cap is not over it");

  // A non-numeric length is treated as no length at all.
  relayReset();
  res = await relayRoute.POST(
    new Request(`${U}/api/xlant/relay/v1/incident/start`, {
      method: "POST",
      body: "x",
      headers: { "content-length": "not-a-number" },
    }),
    ctx("v1/incident/start")
  );
  assert.equal(res.status, 411);
  assert.equal(relayCalls.length, 0);
});

await leg("relay: the query string reaches the relay verbatim", async () => {
  for (const [rel, qs] of [
    ["v1/incident/inc_1/tools/next", "?wait=25"],
    ["v1/incident/inc_1/events", "?since=7"],
  ] as const) {
    relayReset();
    await relayRoute.GET(new Request(`${U}/api/xlant/relay/${rel}${qs}`), ctx(rel));
    assert.equal(relayCalls[0]?.url, `/${rel}${qs}`);
  }
});

await leg("relay: upstream status, body and Mcp-Session-Id pass through", async () => {
  // 401 = revoked device token, 404 = unknown bridge token, 410 = ended run.
  // Each must reach the caller unchanged; a rewritten status would make the
  // desktop and Cursor mis-handle their own errors.
  for (const st of [401, 404, 410, 405, 500]) {
    relayReset(st, `{"error":"upstream-${st}"}`);
    const res = await relayRoute.POST(
      new Request(`${U}/api/xlant/relay/v1/mcp/synthetic-bridge`, {
        method: "POST",
        body: "{}",
        headers: { "content-length": "2" },
      }),
      ctx("v1/mcp/synthetic-bridge")
    );
    assert.equal(res.status, st);
    assert.equal(await res.text(), `{"error":"upstream-${st}"}`);
  }
  relayReset(200, "{}", { "mcp-session-id": "SESS-RETURNED" });
  let res = await relayRoute.POST(
    new Request(`${U}/api/xlant/relay/v1/mcp/synthetic-bridge`, {
      method: "POST",
      body: "{}",
      headers: { "content-length": "2" },
    }),
    ctx("v1/mcp/synthetic-bridge")
  );
  assert.equal(res.headers.get("mcp-session-id"), "SESS-RETURNED");
  assert.equal(res.headers.get("cache-control"), "private, no-store");

  relayReset(200, "data: hi\n\n", { "content-type": "text/event-stream" });
  res = await relayRoute.POST(
    new Request(`${U}/api/xlant/relay/v1/mcp/synthetic-bridge`, {
      method: "POST",
      body: "{}",
      headers: { "content-length": "2" },
    }),
    ctx("v1/mcp/synthetic-bridge")
  );
  assert.equal(res.headers.get("content-type"), "text/event-stream");
});

await leg("relay: down is 502 and slow is 504, never a bare 500", async () => {
  // An unguarded fetch throws out of the handler and `next start` answers with
  // its HTML error page, which tells an operator nothing and tells the desktop
  // less. Both failures answer JSON in this route's own shape.
  const saved = process.env.XLANT_RELAY_URL;
  process.env.XLANT_RELAY_URL = "http://127.0.0.1:1"; // nothing listens here
  let res = await relayRoute.POST(
    new Request(`${U}/api/xlant/relay/v1/incident/start`, {
      method: "POST",
      body: "{}",
      headers: { "content-length": "2" },
    }),
    ctx("v1/incident/start")
  );
  assert.equal(res.status, 502, "connection refused");
  assert.deepEqual(await res.json(), { error: "relay unreachable" });
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  process.env.XLANT_RELAY_URL = saved;

  // The AbortSignal firing, in both shapes undici produces: the DOMException
  // itself, and a TypeError wrapping it as `cause`.
  const timeout = () =>
    new DOMException("The operation was aborted due to timeout", "TimeoutError");
  for (const thrown of [
    timeout(),
    Object.assign(new TypeError("fetch failed"), { cause: timeout() }),
  ]) {
    const real = globalThis.fetch;
    globalThis.fetch = (() => {
      throw thrown;
    }) as unknown as typeof fetch;
    try {
      res = await relayRoute.POST(
        new Request(`${U}/api/xlant/relay/v1/incident/start`, {
          method: "POST",
          body: "{}",
          headers: { "content-length": "2" },
        }),
        ctx("v1/incident/start")
      );
    } finally {
      globalThis.fetch = real;
    }
    assert.equal(res.status, 504, "the AbortSignal firing is a timeout");
    assert.deepEqual(await res.json(), { error: "relay timeout" });
  }
});

const GOOD = "synthetic-device-token-aaaaaaaa";
const auth = { authorization: `Bearer ${GOOD}` };

await leg("update: no token, a short token and a bad token are all 401", async () => {
  resetXlantVerifyCache();
  relayReset();
  let res = await updateRoute.GET(
    new Request(`${U}/api/xlant/update/latest.yml`),
    ctx("latest.yml")
  );
  assert.equal(res.status, 401);
  assert.equal(relayCalls.length, 0, "no header, no relay call");

  res = await updateRoute.GET(
    new Request(`${U}/api/xlant/update/latest.yml`, {
      headers: { authorization: "Bearer short" },
    }),
    ctx("latest.yml")
  );
  assert.equal(res.status, 401);
  assert.equal(relayCalls.length, 0, "short token, still no relay call");

  // A refused token costs a call every time — negatives are never cached.
  relayReset(401, '{"error":"revoked"}');
  const BAD = "synthetic-device-token-bbbbbbbb";
  for (const expected of [1, 2]) {
    res = await updateRoute.GET(
      new Request(`${U}/api/xlant/update/latest.yml`, {
        headers: { authorization: `Bearer ${BAD}` },
      }),
      ctx("latest.yml")
    );
    assert.equal(res.status, 401);
    assert.equal(relayCalls.length, expected, "a refusal must not be cached");
  }
});

await leg("update: one verify serves the whole yml -> exe -> blockmap upgrade", async () => {
  resetXlantVerifyCache();
  relayReset(200, "{}");
  const yml = await updateRoute.GET(
    new Request(`${U}/api/xlant/update/latest.yml`, { headers: auth }),
    ctx("latest.yml")
  );
  assert.equal(yml.status, 200);
  assert.equal(relayCalls.length, 1, "verified once");
  assert.equal(relayCalls[0].url, "/v1/device/verify", "the INTERNAL route");
  assert.equal(relayCalls[0].headers["x-xlant-proxy-secret"], SECRET);
  assert.equal(
    relayCalls[0].headers["x-xlant-via"],
    undefined,
    "the internal lane must NOT carry the proxy marker"
  );
  assert.equal(yml.headers.get("content-type"), "text/yaml");
  assert.equal(
    yml.headers.get("content-length"),
    String(Buffer.byteLength(YML))
  );
  assert.equal(yml.headers.get("cache-control"), "private, no-store");

  const exe = await updateRoute.GET(
    new Request(`${U}/api/xlant/update/XLAnt-Setup-9.9.9.exe`, { headers: auth }),
    ctx("XLAnt-Setup-9.9.9.exe")
  );
  const map = await updateRoute.GET(
    new Request(`${U}/api/xlant/update/XLAnt-Setup-9.9.9.exe.blockmap`, {
      headers: auth,
    }),
    ctx("XLAnt-Setup-9.9.9.exe.blockmap")
  );
  assert.equal(relayCalls.length, 1, "the whole upgrade costs ONE verify");
  assert.equal(exe.status, 200);
  assert.equal(exe.headers.get("content-type"), "application/octet-stream");
  assert.equal(exe.headers.get("content-length"), "4096");
  assert.equal(map.status, 200);
  assert.equal(map.headers.get("content-length"), "64");
});

await leg("update: whole files only — Range is ignored, no Accept-Ranges", async () => {
  // Pinned because §5.22's "keep the previous release's blockmap" note would
  // otherwise read as a promise of differential downloads. The feed streams
  // the complete file and advertises no ranges, so electron-updater always
  // takes the full-download path — parity with roleplay's copy (same code),
  // and the thing a future Range implementation would change.
  resetXlantVerifyCache();
  relayReset(200, "{}");
  const res = await updateRoute.GET(
    new Request(`${U}/api/xlant/update/XLAnt-Setup-9.9.9.exe`, {
      headers: { ...auth, range: "bytes=0-99" },
    }),
    ctx("XLAnt-Setup-9.9.9.exe")
  );
  assert.equal(res.status, 200, "a Range request is answered 200, not 206");
  assert.equal(res.headers.get("content-length"), "4096", "the whole file");
  assert.equal(res.headers.get("accept-ranges"), null, "no ranges advertised");
});

await leg("update: traversal is 400 and a non-release name is 404", async () => {
  resetXlantVerifyCache();
  relayReset(200, "{}");
  // Seed a cached positive so every status below is the PATH's verdict.
  await updateRoute.GET(
    new Request(`${U}/api/xlant/update/latest.yml`, { headers: auth }),
    ctx("latest.yml")
  );
  for (const [rel, want] of [
    ["../latest.yml", 400],
    ["..", 400],
    ["a/b.yml", 400],
    ["sub/latest.yml", 400],
    ["../outside/secret.txt", 400],
    [".env", 400],
    ["", 400],
    // Safe names that are not releases (the .part file is the one that would
    // have handed the updater a truncated manifest).
    ["latest.yml.part", 404],
    ["notes.txt", 404],
    ["latest.yml.bak", 404],
    ["XLAnt-Setup-x.exe.exe", 404],
    // A release-shaped name that simply is not there.
    ["XLAnt-Setup-1.2.3.exe", 404],
  ] as const) {
    const res = await updateRoute.GET(
      new Request(`${U}/api/xlant/update/${rel}`, { headers: auth }),
      ctx(rel)
    );
    assert.equal(res.status, want, `GET ${JSON.stringify(rel)}`);
  }
  // The traversal target really exists; prove its content never leaves.
  const trav = await updateRoute.GET(
    new Request(`${U}/api/xlant/update/../outside/secret.txt`, { headers: auth }),
    ctx("../outside/secret.txt")
  );
  assert.equal(trav.status, 400);
  assert.ok(!(await trav.text()).includes("NEVER-SERVE"));
});

await leg("both routes answer 503 on a half-configured host", async () => {
  const saved = process.env.XLANT_PROXY_SHARED_SECRET;
  process.env.XLANT_PROXY_SHARED_SECRET = "tooshort";
  relayReset();
  const a = await relayRoute.GET(
    new Request(`${U}/api/xlant/relay/v1/device/hello`),
    ctx("v1/device/hello")
  );
  const b = await updateRoute.GET(
    new Request(`${U}/api/xlant/update/latest.yml`, { headers: auth }),
    ctx("latest.yml")
  );
  assert.equal(a.status, 503);
  assert.equal(b.status, 503);
  assert.equal(relayCalls.length, 0, "an unarmed host contacts nothing");
  process.env.XLANT_PROXY_SHARED_SECRET = saved;
});

// ===========================================================================
// 8. THE REAL MIDDLEWARE, in-process
// ===========================================================================

await leg("CSRF: Origin-less device POSTs pass, /api/internal/xlant does not", async () => {
  const { NextRequest } = await import("next/server");
  const middleware = (await import("../src/proxy")).default;
  const run = async (
    method: string,
    url: string,
    headers: Record<string, string> = {}
  ) => middleware(new NextRequest(new Request(url, { method, headers })));

  // The device lane. Neither the Windows desktop nor Cursor's cloud VM sends
  // an Origin, so every one of these MUST pass; a 403 here is the whole
  // feature broken.
  for (const [method, path] of [
    ["POST", "/api/xlant/relay/v1/device/hello"],
    ["POST", "/api/xlant/relay/v1/incident/start"],
    ["POST", "/api/xlant/relay/v1/incident/i/decision"],
    ["POST", "/api/xlant/relay/v1/incident/i/tools/c/result"],
    ["POST", "/api/xlant/relay/v1/mcp/synthetic-bridge"],
    ["GET", "/api/xlant/relay/v1/incident/i/tools/next?wait=25"],
    ["GET", "/api/xlant/update/latest.yml"],
    ["GET", "/api/xlant/update/XLAnt-Setup-9.9.9.exe"],
  ] as const) {
    const res = await run(method, `${U}${path}`);
    assert.notEqual(res.status, 403, `${method} ${path} was CSRF-refused`);
    // No attribution cookie is set on an API path either — isPagePath()
    // excludes /api, so the device lane is invisible to tracking.
    assert.equal(
      res.headers.get("set-cookie"),
      null,
      `${path} set a cookie on a device request`
    );
  }

  // The CONTROL: the browser-called half is still protected, so this proves
  // the check is live rather than globally disabled in this harness.
  const noOrigin = await run("POST", `${U}/api/internal/xlant/device-token`);
  assert.equal(noOrigin.status, 403, "the token mint must refuse an Origin-less POST");
  const sameOrigin = await run("POST", `${U}/api/internal/xlant/device-token`, {
    origin: U,
  });
  assert.notEqual(sameOrigin.status, 403, "a same-origin POST must pass");
});

// ===========================================================================
// 9. Source invariants the type system cannot express
// ===========================================================================

const readRepo = (rel: string) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

await leg("both device routes keep the runtime knobs they depend on", () => {
  const read = readRepo;
  const relaySrc = read("src/app/api/xlant/relay/[[...path]]/route.ts");
  const updateSrc = read("src/app/api/xlant/update/[[...path]]/route.ts");
  for (const [name, src] of [
    ["relay", relaySrc],
    ["update", updateSrc],
  ] as const) {
    assert.match(src, /export const runtime = "nodejs";/, `${name}: runtime`);
    assert.match(src, /export const dynamic = "force-dynamic";/, `${name}: dynamic`);
    assert.match(src, /"Cache-Control": "private, no-store"/, `${name}: cache`);
  }
  // maxDuration is DECLARED but inert on this self-hosted `next start` —
  // nothing under next/dist/server reads it, only the build manifest carries
  // it. It is pinned so a platform move that DOES enforce a function budget
  // inherits a 300 s one; the operative ceilings are Cloudflare's 100 s edge
  // close and nginx's 120 s proxy_read_timeout, neither of which lives here.
  assert.match(relaySrc, /export const maxDuration = 300;/);
  assert.match(relaySrc, /AbortSignal\.timeout\(290_000\)/);
  // The allowlist is imported, never re-declared: a second copy is a second
  // thing to forget when the xlant contract changes.
  assert.match(relaySrc, /isXlantRelayPath/);
  assert.ok(
    !relaySrc.includes("/^v1"),
    "the relay route must not carry its own copy of the allowlist"
  );
});

await leg("the nginx drop-in caps the device lane below the host default", () => {
  const read = readRepo;
  const dropin = read("deploy/nginx.d/xlant-device.conf");
  // ^~ so the prefix wins over any regex location the stamped conf grows.
  assert.match(dropin, /location \^~ \/api\/xlant\/ \{/);
  assert.match(dropin, /client_max_body_size 2m;/);
  // Everything else must stay identical to the stamped `location /`, or the
  // device lane quietly acquires different proxy behaviour from the rest of
  // the site.
  const site = read("deploy/nginx.conf");
  const block = /location \/ \{([\s\S]*?)\n {4}\}/.exec(site);
  assert.ok(block, "could not find `location /` in deploy/nginx.conf");
  for (const line of block[1]
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)) {
    assert.ok(dropin.includes(line), `drop-in is missing: ${line}`);
  }
  // The host-wide ceiling this exists to narrow.
  assert.match(read("deploy/nginx.d/governance-upload.conf"), /client_max_body_size 110m;/);
});

// ---------------------------------------------------------------------------

relay.close();
rmSync(ROOT, { recursive: true, force: true });

if (failures) {
  console.error(`\n${failures} failing`);
  process.exit(1);
}
console.log("\nall passing");
process.exit(0);
