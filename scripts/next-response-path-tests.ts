// What a visitor receives from a route handler on THIS next (16.4.6 since 2026-11-19): Next's own sendResponse +
// NodeNextRequest/NodeNextResponse + its compression middleware, over a loopback server, the path a route handler's
// Response takes under `next start`. Pins the three assumptions this host's next update made (the module session's
// independent reader, 2026-11-19, note b; the dependency-upgrade rule wants a test per assumption):
//   1. the module's narration hand-off to nginx (status 200, X-Accel-Redirect, the audio type, no body) passes Next's
//      compression and sender untouched: no Content-Encoding, no Vary added by them, the header kept, no body (under
//      `next start` the app router's base server adds its own `vary: rsc, …` before this path; not run here);
//   2. the chat's NDJSON stream is not compressed and its lines arrive as separate pieces, not buffered to the end
//      (the content type is what keeps compression off; a compressible-type control proves compression is live here);
//   3. a whole-file download (the shape of /api/rfp/library/[id]) arrives complete, and on 16.4.5+ without the
//      Content-Length the handler set (Next drops it: GHSA-pc58 fix).
// Run: npm run test:nextwire (tsx, loopback only: no network, no DB, no key).
import assert from "node:assert";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { summaryGuard } from "./lib/summary-guard";
import { NDJSON_HEADERS } from "@aicompany/core/lib/ndjson";

const req = createRequire(path.join(process.cwd(), "package.json"));
type Got = { status: number; headers: IncomingHttpHeaders; body: Buffer; arrivals: number[] };

async function serve(make: () => Response, method = "GET"): Promise<Got> {
  const compression = req("next/dist/compiled/compression") as () => (rq: unknown, rs: unknown, next: () => void) => void;
  const { NodeNextRequest, NodeNextResponse } = req("next/dist/server/base-http/node") as {
    NodeNextRequest: new (r: unknown) => unknown;
    NodeNextResponse: new (r: unknown) => unknown;
  };
  const { sendResponse } = req("next/dist/server/send-response") as {
    sendResponse: (rq: unknown, rs: unknown, r: Response) => Promise<void>;
  };
  const compress = compression();
  const server = createServer((rq, rs) => {
    compress(rq, rs, () => {
      void sendResponse(new NodeNextRequest(rq), new NodeNextResponse(rs), make());
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const { port } = server.address() as AddressInfo;
    return await new Promise<Got>((resolve, reject) => {
      const rq = request({ host: "127.0.0.1", port, path: "/", method, headers: { "accept-encoding": "gzip" } }, (rs) => {
        const chunks: Buffer[] = [];
        const arrivals: number[] = [];
        const t0 = Date.now();
        rs.on("data", (c: Buffer) => { chunks.push(c); arrivals.push(Date.now() - t0); });
        rs.on("end", () => resolve({ status: rs.statusCode ?? 0, headers: rs.headers, body: Buffer.concat(chunks), arrivals }));
      });
      rq.on("error", reject);
      rq.setTimeout(10_000, () => rq.destroy(new Error("timeout")));
      rq.end();
    });
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

let passed = 0;
async function ok(name: string, fn: () => Promise<void> | void) {
  guard.step(name);
  await fn();
  passed++;
  console.log(`  ok   ${name}`);
}

async function main() {
  const nextV = (req("next/package.json") as { version: string }).version;
  console.log(`next ${nextV}`);

  await ok("the narration hand-off to nginx passes Next's compression and sender untouched (200, X-Accel-Redirect, audio type, no body, no encoding)", async () => {
    const make = () => new Response(null, {
      status: 200,
      headers: { "X-Accel-Redirect": "/_aicompany_media/audio/probe.0123abcd.mp3", "Content-Type": "audio/mpeg" },
    });
    for (const method of ["GET", "HEAD"]) {
      const got = await serve(make, method);
      assert.equal(got.status, 200, method);
      assert.equal(got.headers["x-accel-redirect"], "/_aicompany_media/audio/probe.0123abcd.mp3", method);
      assert.equal(got.headers["content-type"], "audio/mpeg", method);
      assert.equal(got.headers["content-encoding"], undefined, method);
      assert.equal(got.headers["vary"], undefined, method);
      assert.equal(got.body.length, 0, method);
    }
  });

  await ok("control: compression is live in this harness (a compressible JSON body is gzipped when the client asks)", async () => {
    const got = await serve(() => new Response(JSON.stringify({ items: Array.from({ length: 400 }, (_, i) => ({ i, text: "workshop" })) }), {
      headers: { "content-type": "application/json" },
    }));
    assert.equal(got.status, 200);
    assert.equal(got.headers["content-encoding"], "gzip", "without this the other no-compression checks could not fail");
  });

  await ok("the chat's NDJSON stream is not compressed and its two lines arrive as two separate pieces (not held to the end)", async () => {
    const enc = new TextEncoder();
    const got = await serve(() => new Response(new ReadableStream<Uint8Array>({
      async start(c) {
        c.enqueue(enc.encode('{"type":"delta","text":"Hel"}\n'));
        await new Promise((r) => setTimeout(r, 150));
        c.enqueue(enc.encode('{"type":"delta","text":"lo"}\n'));
        c.close();
      },
    }), { headers: NDJSON_HEADERS }));
    assert.equal(got.status, 200);
    assert.equal(got.headers["content-encoding"], undefined);
    assert.equal(got.body.toString("utf8").trim().split("\n").length, 2);
    assert.ok(got.arrivals.length >= 2, `the stream arrived in ${got.arrivals.length} piece(s), not as it was written`);
    assert.ok(got.arrivals[got.arrivals.length - 1] - got.arrivals[0] >= 100, `pieces at ${got.arrivals.join(", ")} ms: the first line was held back until the second`);
  });

  await ok("a whole-file download (the /api/rfp/library/[id] shape) arrives complete; on next 16.4.5+ without its Content-Length", async () => {
    const bytes = new Uint8Array(300_000).map((_, i) => i % 251);
    const got = await serve(() => new Response(bytes, {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-length": String(bytes.length),
        "content-disposition": 'attachment; filename="probe.pdf"',
        "cache-control": "no-store, private",
      },
    }));
    assert.equal(got.status, 200);
    assert.equal(got.body.length, bytes.length);
    assert.ok(got.body.equals(Buffer.from(bytes)), "the bytes arrive unchanged");
    assert.equal(got.headers["content-encoding"], undefined, "a PDF is not compressed");
    const [maj, min, pat] = nextV.split(/[.-]/).map(Number);
    const dropsLength = maj > 16 || (maj === 16 && (min > 4 || (min === 4 && pat >= 5)));
    assert.equal(got.headers["content-length"], dropsLength ? undefined : String(bytes.length));
  });

  guard.reached();
  console.log(`\nnext-response-path: ${passed} passed`);
}

// This script cannot exit 0 without reaching its summary (scripts/lib/summary-guard.ts).
const guard = summaryGuard("next-response-path-tests");
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
