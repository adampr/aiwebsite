#!/usr/bin/env -S npx tsx
// Invariant checks for the XLAnt STAFF surface on this host (ARCHITECTURE.md
// §5.22). Plain node:assert, no framework (the host repo has none) and NO
// DATABASE. Run:
//
//   npm run test:xlant
//
// IT USED TO COVER TWO LANES AND NOW COVERS ONE. The DEVICE lane
// (`/api/xlant/relay/*` and `/api/xlant/update/*`) was decommissioned on
// 2026-09-15, once the relay measured zero active devices still reaching this
// front, and the legs that executed those two route handlers went with the
// handlers: the allowlist, the MCP-path split, the release gate, the update
// feed's own traversal and body legs, and the device-token verify cache. What
// is left is the HUMAN half, which did not move and must not break — the staff
// page, the download, the mint, the computer list and the sign-out.
//
// TWO HALVES STILL. Sections 1-3b are pure: the artifact predicates, the
// filename contracts, the platform enums and the shape this host hands the
// browser, exercised as functions. Sections 4-7 EXECUTE THE REAL ROUTE
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
//   · ONE TOKEN PER COMPUTER (2026-09-08) — the staff routes
//     `GET /api/internal/xlant/devices` and
//     `POST /api/internal/xlant/devices/revoke`, executed in-process against a
//     REAL SIGNED SESSION (see section 5 for how the request scope is faked
//     and why that is worth doing): who is refused, that the relay is told the
//     SESSION's email and never a body's, that an unreadable list is a 502 and
//     never an empty one, and that a bad device id never leaves this host;
//   · `safeArtifactName()`, the traversal gate on the one name the staff
//     download opens a stream against. It is defence in depth there — the name
//     comes from readdir() — and it is kept at its old width on purpose: the
//     directory is written by an operator and a publish step, which is exactly
//     where a name worth refusing turns up;
//   · the MAC half of contract 0.5.0 — the two device kinds, the two Mac
//     architectures, the `XLAnt-<version>-<arm64|x64>-mac.zip` filename
//     contract (and the arch-less `XLAnt-<version>-mac.zip` that a build which
//     lost its explicit `artifactName` would emit, refused on purpose), the
//     download route's query-string decision, the Content-Type table, and the
//     pre-mint `/v1/status` probe that keeps a pre-0.5.0 relay from being
//     reported as "the relay refused the token mint";
//   · the artifacts directory read the way the staff page reads it: newest by
//     MTIME rather than by parsed version, per ARCHITECTURE for the Mac zips,
//     and null — never a throw — for a directory that is empty or unreadable.
//     The stale update manifests still sitting in that directory are part of
//     the fixture, because they are part of the real one;
//   · and, live: the arming gate, and that the CSRF middleware still refuses an
//     Origin-less POST to `/api/internal/xlant` while letting the list GET
//     through.
//
// NO REAL TOKENS. Every token here is a synthetic filler string; a real device
// token reaches a technician agent on somebody's PC and git history would keep
// it after any revert.

// FIRST, AND IT HAS TO BE FIRST. Next's request-scope storage
// (`work-unit-async-storage`) decides ONCE, when its module is first loaded,
// whether a real AsyncLocalStorage exists: it reads `globalThis.AsyncLocalStorage`,
// which Node does not define, and falls back to a stub whose `.run()` throws
// and whose `.getStore()` is always undefined. Section 5 needs a real one, and
// the very next import below (`../src/lib/xlant`) pulls that module in through
// @aicompany/core/auth/session -> next/headers. ES modules evaluate in source
// order and a statement cannot run before an import, so the only place left to
// set the global is a module that is itself imported earlier — hence this
// one-line data: module. (No `?` anywhere in it: a question mark in a data URL
// starts the query string and would truncate the source.) Nothing about the
// PRODUCT depends on this; it is how a route handler that calls `headers()`
// can be executed at all outside `next start`.
import "data:text/javascript,import{AsyncLocalStorage}from'node:async_hooks';globalThis.AsyncLocalStorage=AsyncLocalStorage;";

import assert from "node:assert";
import { execFileSync } from "node:child_process";
import http from "node:http";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  XLANT_DEVICE_KINDS,
  XLANT_INSTALLER_RE,
  XLANT_MAC_ARCHES,
  XLANT_MAC_BUNDLE_RE,
  isXlantDeviceId,
  isXlantDeviceKind,
  isXlantMacArch,
  latestInstaller,
  latestMacBundle,
  probeRelayMacSupport,
  safeArtifactName,
  xlantArtifactContentType,
  xlantDeviceSummaries,
  xlantDownloadRequest,
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
// 1. safeArtifactName — the staff download's traversal gate
// ---------------------------------------------------------------------------

await leg("every name the artifacts directory really holds passes", () => {
  for (const n of [
    // Windows.
    "latest.yml",
    "XLAnt-Setup-0.2.1.exe",
    "XLAnt-Setup-0.2.1.exe.blockmap",
    // macOS (contract 0.5.0). The gate is about the SHAPE of a name, not about
    // which names this host will serve — the filename contracts in section 2
    // are what decide that, and they must be the ones that get the say.
    "latest-mac.yml",
    "XLAnt-0.5.0-arm64-mac.zip",
    "XLAnt-0.5.0-arm64-mac.zip.blockmap",
    "XLAnt-0.5.0-x64-mac.zip",
    "XLAnt-0.5.0-x64-mac.zip.blockmap",
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
// 2. The two filename regexes
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

await leg("the Mac bundle regex captures a real version AND the architecture", () => {
  const arm = XLANT_MAC_BUNDLE_RE.exec("XLAnt-0.5.0-arm64-mac.zip");
  assert.equal(arm?.[1], "0.5.0");
  assert.equal(arm?.[2], "arm64");
  const intel = XLANT_MAC_BUNDLE_RE.exec("XLAnt-1.10.0-beta.3-x64-mac.zip");
  assert.equal(intel?.[1], "1.10.0-beta.3");
  assert.equal(intel?.[2], "x64");
  // Both regexes are anchored and flag-free for the same reasons the allowlist
  // is: an unanchored pattern matches a longer name that merely contains one,
  // and a /g regex answers differently on identical input.
  for (const re of [XLANT_INSTALLER_RE, XLANT_MAC_BUNDLE_RE]) {
    assert.ok(re.source.startsWith("^"), `not ^-anchored: ${re.source}`);
    assert.ok(re.source.endsWith("$"), `not $-anchored: ${re.source}`);
    assert.equal(re.flags, "", `unexpected flags on ${re.source}`);
  }
  // The two never claim the same file, so "is this a Windows or a Mac build?"
  // has exactly one answer for every name.
  for (const n of [
    "XLAnt-Setup-0.5.0.exe",
    "XLAnt-0.5.0-arm64-mac.zip",
    "XLAnt-0.5.0-x64-mac.zip",
  ]) {
    assert.notEqual(
      XLANT_INSTALLER_RE.test(n),
      XLANT_MAC_BUNDLE_RE.test(n),
      `${n} matched both or neither filename contract`
    );
  }
});

// ---------------------------------------------------------------------------
// 3. Contract 0.5.0's platform words: the kinds, the architectures, what the
//    download route decides from a query string, and the Content-Type table
// ---------------------------------------------------------------------------

await leg("the device kinds are exactly the contract's two", () => {
  // A MIRROR of DEVICE_KINDS in the xlant repo's packages/shared/src/contract.ts
  // (the two repos share no code). The kind decides which BUILD a token is for
  // — it stopped being a count on 2026-09-08, when a person became able to
  // hold one token per computer — so a third entry here that the relay does not
  // know would mint nothing at all.
  assert.deepEqual([...XLANT_DEVICE_KINDS], ["windows", "mac"]);
  for (const k of ["windows", "mac"]) {
    assert.ok(isXlantDeviceKind(k), `should accept ${k}`);
  }
  for (const k of [
    "Windows",
    "MAC",
    "macos",
    "darwin",
    "linux",
    "ios",
    "windows ",
    "",
    null,
    undefined,
    7,
    ["mac"],
  ]) {
    assert.ok(!isXlantDeviceKind(k), `should refuse ${JSON.stringify(k)}`);
  }
});

await leg("the Mac architectures are exactly arm64 and x64", () => {
  assert.deepEqual([...XLANT_MAC_ARCHES], ["arm64", "x64"]);
  assert.ok(isXlantMacArch("arm64"));
  assert.ok(isXlantMacArch("x64"));
  for (const a of [
    // Spellings other toolchains use. None of them names a file this host
    // publishes, and admitting one would 404 a staffer at the download.
    "aarch64",
    "amd64",
    "x86_64",
    "ARM64",
    "x64 ",
    // The bundle the desktop deliberately does not build.
    "universal",
    "",
    null,
    undefined,
    64,
  ]) {
    assert.ok(!isXlantMacArch(a), `should refuse ${JSON.stringify(a)}`);
  }
});

await leg("the download route's query string decides one build, or refuses", () => {
  const ask = (qs: string) => xlantDownloadRequest(new URLSearchParams(qs));
  // No query at all is the WINDOWS installer — the link this host has served
  // since the page existed, and the one an old bookmark still carries.
  assert.deepEqual(ask(""), { ok: true, platform: "windows" });
  assert.deepEqual(ask("platform=windows"), { ok: true, platform: "windows" });
  // `arch` is meaningless for Windows and is IGNORED, not refused: there is one
  // Windows build and a stray parameter must not break a working link.
  assert.deepEqual(ask("platform=windows&arch=arm64"), {
    ok: true,
    platform: "windows",
  });
  assert.deepEqual(ask("platform=mac&arch=arm64"), {
    ok: true,
    platform: "mac",
    arch: "arm64",
  });
  assert.deepEqual(ask("platform=mac&arch=x64"), {
    ok: true,
    platform: "mac",
    arch: "x64",
  });
  // A Mac ask with no architecture is refused rather than defaulted: the two
  // zips are not interchangeable, and an arm64 bundle on an Intel Mac does not
  // launch.
  for (const qs of [
    "platform=mac",
    "platform=mac&arch=",
    "platform=mac&arch=universal",
    "platform=mac&arch=x86_64",
    "platform=mac&arch=ARM64",
  ]) {
    const got = ask(qs);
    assert.deepEqual(got, { ok: false, error: "arch must be 'arm64' or 'x64'" }, qs);
  }
  for (const qs of [
    "platform=",
    "platform=Mac",
    "platform=macos",
    "platform=linux",
    "platform=darwin&arch=arm64",
  ]) {
    assert.deepEqual(
      ask(qs),
      { ok: false, error: "platform must be 'windows' or 'mac'" },
      qs
    );
  }
});

await leg("every publishable name has one Content-Type and no sniffing", () => {
  for (const [name, want] of [
    ["latest.yml", "text/yaml"],
    ["latest-mac.yml", "text/yaml"],
    ["XLAnt-Setup-0.5.0.exe", "application/octet-stream"],
    ["XLAnt-Setup-0.5.0.exe.blockmap", "application/octet-stream"],
    ["XLAnt-0.5.0-arm64-mac.zip", "application/zip"],
    ["XLAnt-0.5.0-x64-mac.zip", "application/zip"],
    // The blockmap of a zip is a BLOCKMAP, not a zip: it ends in .blockmap, so
    // the .zip test (an endsWith on the whole name) must not claim it.
    ["XLAnt-0.5.0-arm64-mac.zip.blockmap", "application/octet-stream"],
    ["XLAnt-0.5.0-x64-mac.zip.blockmap", "application/octet-stream"],
  ] as const) {
    assert.equal(xlantArtifactContentType(name), want, name);
  }
  // The table is TOTAL over every name the artifacts directory holds — not
  // just the two the staff download can reach — so it can never answer with an
  // empty or invented content type. It was not narrowed when the update feed
  // that served the other six went (2026-09-15): a narrowed table would answer
  // `application/octet-stream` for a `.yml` the day something asked, which is
  // a wrong answer where there was no answer wanted.
  for (const n of [
    "latest.yml",
    "latest-mac.yml",
    "XLAnt-Setup-9.9.9.exe",
    "XLAnt-Setup-9.9.9.exe.blockmap",
    "XLAnt-9.9.9-arm64-mac.zip",
    "XLAnt-9.9.9-arm64-mac.zip.blockmap",
    "XLAnt-9.9.9-x64-mac.zip",
    "XLAnt-9.9.9-x64-mac.zip.blockmap",
  ]) {
    assert.match(xlantArtifactContentType(n), /^[a-z]+\/[\w.+-]+$/, n);
  }
});

// ---------------------------------------------------------------------------
// 3b. The computer list (2026-09-08): the shape this host hands the browser,
//     the id it will forward, and the words the island prints
// ---------------------------------------------------------------------------

await leg("a device id is this product's own opaque id class and nothing else", () => {
  // `_` is IN, matching the `[\w-]` the relay's own route shapes use: incident
  // ids, tool call ids and bridge tokens are all `[A-Za-z0-9_-]` here, so a
  // class that omitted the underscore would refuse a Sign out on ids the relay
  // issues.
  for (const good of ["dev_1", "dev-1", "DEV_abc-123", "a", "a".repeat(80)]) {
    assert.ok(isXlantDeviceId(good), `should accept ${good}`);
  }
  // Everything that could mean something somewhere else. These never reach the
  // internal lane inside a JSON field, which is the point of testing at all:
  // the body is not a URL, but the relay's handler puts the value into a query.
  for (const bad of [
    "",
    " ",
    "a".repeat(81),
    "dev 1",
    "dev/1",
    "dev.1",
    "dev?1",
    "dev&1",
    "dev#1",
    "dev%2f1",
    "..",
    "dev\n1",
    7,
    null,
    undefined,
    {},
    ["dev_1"],
  ]) {
    assert.ok(!isXlantDeviceId(bad), `should reject ${JSON.stringify(bad)}`);
  }
});

await leg("the device list is re-read, not relayed: bad rows drop, blanks are null", () => {
  // NOT an array is null, and null is what the route turns into a 502. The
  // distinction is load-bearing: "you have no computers" is a sentence the
  // page prints, and a person with two laptops must never read it because the
  // relay answered something unreadable.
  for (const notAList of [undefined, null, {}, "[]", 7, { devices: [] }]) {
    assert.equal(xlantDeviceSummaries(notAList), null, JSON.stringify(notAList));
  }
  assert.deepEqual(xlantDeviceSummaries([]), []);

  // A whole row survives verbatim — this host adds nothing and renames nothing.
  const whole = {
    deviceId: "dev_one",
    kind: "windows" as const,
    machineName: "XL-LPT-A1",
    userName: "adam",
    clientVersion: "0.11.2",
    createdAt: "2026-09-04T10:00:00.000Z",
    lastSeenAt: "2026-09-08T11:00:00.000Z",
    expiresAt: null,
    openIncidents: 2,
  };
  assert.deepEqual(xlantDeviceSummaries([whole]), [whole]);

  // A row with no usable id is DROPPED rather than drawn: the id is what the
  // Sign out button posts back, so a row without one is a button that cannot
  // work and a promise the page cannot keep.
  assert.deepEqual(xlantDeviceSummaries([{ kind: "mac" }, { deviceId: "  " }]), []);
  // A local unwrapper rather than a `!`: every call below is expected to
  // produce a list, and a null here should fail as a null, not as a TypeError.
  const rowsOf = (v: unknown) => {
    const r = xlantDeviceSummaries(v);
    assert.ok(r, "expected a list of computers");
    return r;
  };
  assert.deepEqual(
    rowsOf([{ deviceId: "keep" }, { deviceId: 7 }, null, "x", ["y"]]).map(
      (r) => r.deviceId
    ),
    ["keep"]
  );

  // An unrecognised kind is null, never "windows": guessing Windows for a Mac
  // is worse than the page saying "Computer".
  const odd = rowsOf([
    { deviceId: "d", kind: "linux", machineName: "", clientVersion: "", openIncidents: -3 },
  ]);
  assert.equal(odd[0].kind, null);
  // An empty string is a null, so the island prints its own words ("not
  // connected yet", "—") rather than an empty cell.
  assert.equal(odd[0].machineName, null);
  assert.equal(odd[0].clientVersion, null);
  assert.equal(odd[0].userName, null);
  assert.equal(odd[0].lastSeenAt, null);
  assert.equal(odd[0].createdAt, "");
  // "N open" is drawn only above zero, so a negative or fractional count is 0.
  assert.equal(odd[0].openIncidents, 0);
  assert.equal(rowsOf([{ deviceId: "d", openIncidents: 2.9 }])[0].openIncidents, 2);
  assert.equal(rowsOf([{ deviceId: "d", openIncidents: "3" }])[0].openIncidents, 0);

  // `expiresAt` is the one field held to a stricter standard than "a non-empty
  // string", because it is the only one drawn as a COUNTDOWN: a value that is
  // not an instant would become a fabricated number of days on a staff page.
  const expiring = "2026-09-15T11:30:00.000Z";
  assert.equal(rowsOf([{ deviceId: "d", expiresAt: expiring }])[0].expiresAt, expiring);
  for (const bad of [undefined, null, "", "   ", "next Tuesday", "soon", 7, {}, ["x"]]) {
    assert.equal(
      rowsOf([{ deviceId: "d", expiresAt: bad }])[0].expiresAt,
      null,
      JSON.stringify(bad)
    );
  }
});

await leg("the island says how long ago in words, and never invents one", async () => {
  // The island is imported for its two pure helpers only. It is a "use client"
  // file, so this also proves it can be evaluated without a server module —
  // an accidental `@/lib/xlant` import there would drag node:fs and the shared
  // secret into a browser bundle (pinned again as a source leg in section 7).
  const island = await import("../src/app/internal/xlant/devices-list");
  const now = Date.parse("2026-09-08T12:00:00.000Z");
  const at = (iso: string) => island.lastSeenWords(iso, now);

  assert.equal(island.lastSeenWords(null), "never");
  assert.equal(island.lastSeenWords("whenever"), "unknown", "no invented duration");
  assert.equal(at("2026-09-08T11:59:31.000Z"), "just now");
  // A relay clock AHEAD of the viewer's must not read "in a moment".
  assert.equal(at("2026-09-08T12:05:00.000Z"), "just now");
  assert.equal(at("2026-09-08T11:59:00.000Z"), "1 minute ago");
  assert.equal(at("2026-09-08T11:58:00.000Z"), "2 minutes ago");
  assert.equal(at("2026-09-08T11:00:00.000Z"), "1 hour ago");
  assert.equal(at("2026-09-08T10:00:00.000Z"), "2 hours ago");
  assert.equal(at("2026-09-07T12:00:00.000Z"), "1 day ago");
  assert.equal(at("2026-09-01T12:00:00.000Z"), "7 days ago");

  // THE SIGN-OUT CONFIRM, both shapes (refuter R2, F10). Signing a computer
  // out closes every non-terminal piece of work of that device on the relay,
  // and the row is already showing "N open" a few pixels away — a confirm that
  // stayed silent about it would be asking the person to agree to something
  // the page had already told them was there.
  assert.equal(
    island.confirmWords("XL-LPT-A1", 0),
    "Sign XL-LPT-A1 out of XLAnt? Its token stops working immediately, and that computer needs a new one from this page to come back."
  );
  assert.equal(
    island.confirmWords("XL-LPT-A1", 1),
    "Sign XL-LPT-A1 out of XLAnt? Its token stops working immediately, and that computer needs a new one from this page to come back. The one piece of work XLAnt still has open on it ends with it."
  );
  assert.equal(
    island.confirmWords("XL-LPT-A1", 2),
    "Sign XL-LPT-A1 out of XLAnt? Its token stops working immediately, and that computer needs a new one from this page to come back. The 2 pieces of work XLAnt still has open on it end with it."
  );
  // A count that never happens must still not produce a clause about it.
  assert.equal(island.confirmWords("x", -1), island.confirmWords("x", 0));
  // The nameless row is a pronoun, never "not connected yet", which would read
  // as a machine name inside the sentence.
  assert.match(island.confirmWords("this computer", 0), /^Sign this computer out of XLAnt\?/);

  assert.equal(island.kindWords("windows"), "Windows");
  assert.equal(island.kindWords("mac"), "Mac");
  assert.equal(island.kindWords(null), "Computer");

  // THE NAME SLOT HAS THREE ANSWERS, not two. The relay binds the machine name
  // at the computer's FIRST INCIDENT, so an install that has said hello and
  // had nothing go wrong yet is connected, working and still nameless —
  // calling that "not connected yet" would tell a staffer their working PC
  // never arrived and invite them to mint another token for it.
  assert.equal(island.machineWords("XL-LPT-A1", null), "XL-LPT-A1");
  assert.equal(island.machineWords("XL-LPT-A1", "2026-09-08T11:00:00.000Z"), "XL-LPT-A1");
  assert.equal(island.machineWords(null, null), "not connected yet");
  assert.equal(
    island.machineWords(null, "2026-09-08T11:00:00.000Z"),
    "no name yet",
    "a computer that HAS reported must not read 'not connected yet'"
  );

  // The seven-day clock on a token nobody pasted anywhere. Days are FLOORED,
  // never rounded up: overstating the time somebody has left is the expensive
  // direction of that error.
  const until = (iso: string) => island.expiryWords(iso, now);
  assert.equal(island.expiryWords(null), null, "no clock, no sentence");
  assert.equal(island.expiryWords("whenever"), null, "no invented countdown");
  assert.equal(until("2026-09-15T12:00:00.000Z"), "expires in 7 days");
  assert.equal(until("2026-09-10T12:00:00.000Z"), "expires in 2 days");
  assert.equal(until("2026-09-10T11:00:00.000Z"), "expires in 1 day");
  // The day boundary, both sides: 23h59m left is "today", 24h00m is "1 day".
  assert.equal(until("2026-09-09T11:59:00.000Z"), "expires today");
  assert.equal(until("2026-09-09T12:00:00.000Z"), "expires in 1 day");
  assert.equal(until("2026-09-08T12:00:01.000Z"), "expires today");
  // Already past: the relay lists ACTIVE devices only, so this should never
  // arrive — and if it does, a positive countdown would be a lie.
  assert.equal(until("2026-09-08T12:00:00.000Z"), "expired");
  assert.equal(until("2026-09-01T12:00:00.000Z"), "expired");
});

// ===========================================================================
// 4. THE ARTIFACTS DIRECTORY AND THE PRE-MINT PROBE, against a fake relay
// ===========================================================================

// A scratch artifacts directory, filled the way the real one on the VM is:
// the builds the staff download serves, and — in the SAME directory, which is
// the point — everything it must refuse to call a build. The update manifests
// are among them now: the feed that read them went on 2026-09-15 and the
// release step no longer publishes them here, but the copies already on disk
// were left where they were, so a reader that started matching them would be
// matching real files.
const ROOT = mkdtempSync(join(tmpdir(), "xlant-tests-"));
const ART = join(ROOT, "artifacts");
mkdirSync(ART);
const YML = "version: 9.9.9\npath: XLAnt-Setup-9.9.9.exe\n";
writeFileSync(join(ART, "latest.yml"), YML);
writeFileSync(join(ART, "XLAnt-Setup-9.9.9.exe"), Buffer.alloc(4096, 7));
writeFileSync(join(ART, "XLAnt-Setup-9.9.9.exe.blockmap"), Buffer.alloc(64, 3));
writeFileSync(join(ART, "latest.yml.part"), "HALF WRITTEN\n");

// The macOS half of the same directory (contract 0.5.0). One manifest naming
// both architectures, one zip and one blockmap each, plus the shapes
// latestMacBundle() has to refuse while sitting in the SAME directory: the
// half-written temp file, a universal bundle nobody builds, and the arch-less
// name a build that lost its explicit `mac.artifactName` would produce.
const YML_MAC =
  "version: 9.9.9\nfiles:\n  - url: XLAnt-9.9.9-arm64-mac.zip\n  - url: XLAnt-9.9.9-x64-mac.zip\n";
writeFileSync(join(ART, "latest-mac.yml"), YML_MAC);
writeFileSync(join(ART, "XLAnt-9.9.9-arm64-mac.zip"), Buffer.alloc(8192, 11));
writeFileSync(join(ART, "XLAnt-9.9.9-arm64-mac.zip.blockmap"), Buffer.alloc(96, 5));
writeFileSync(join(ART, "XLAnt-9.9.9-x64-mac.zip"), Buffer.alloc(6144, 13));
writeFileSync(join(ART, "XLAnt-9.9.9-x64-mac.zip.blockmap"), Buffer.alloc(80, 6));
writeFileSync(join(ART, "latest-mac.yml.part"), "HALF WRITTEN\n");
writeFileSync(join(ART, "XLAnt-9.9.9-universal-mac.zip"), Buffer.alloc(32, 1));
writeFileSync(join(ART, "XLAnt-9.9.9-mac.zip"), Buffer.alloc(32, 2));
// A PREVIOUS arm64 release, kept the way the real directory keeps the previous
// build, and deliberately stamped NEWER than 9.9.9 so "newest by mtime" is
// measured rather than accidentally agreeing with "highest version".
writeFileSync(join(ART, "XLAnt-9.9.8-arm64-mac.zip"), Buffer.alloc(1024, 9));
const NEWER = Date.now() / 1000 + 60;
utimesSync(join(ART, "XLAnt-9.9.8-arm64-mac.zip"), NEWER, NEWER);

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

// The env is set BEFORE the staff routes are imported further down, which is
// the ordering those routes actually rely on (they read it per request).
const U = "https://ai.xl.net";
function relayReset(
  status = 200,
  body = '{"ok":true}',
  headers: Record<string, string> = {}
) {
  relayCalls = [];
  relayReply = { status, body, headers };
}

// --- the artifacts directory, read the way the staff page reads it ---------

// The same three env vars the routes read, as a value the lib functions take
// directly (they are pure over a config, which is why the page can call them
// during a render).
const artCfg: XlantConfig = {
  relayUrl: `http://127.0.0.1:${RELAY_PORT}`,
  proxySecret: SECRET,
  artifactsDir: ART,
};

await leg("latestInstaller sees the Windows build and no Mac bundle", async () => {
  const found = await latestInstaller(artCfg);
  assert.equal(found?.fileName, "XLAnt-Setup-9.9.9.exe");
  assert.equal(found?.version, "9.9.9");
  assert.equal(found?.size, 4096, "size comes from the same stat as the mtime");
});

await leg("latestMacBundle answers per ARCHITECTURE, never per newest zip", async () => {
  // The two zips of one release differ only in mtime, so a single
  // newest-of-all would hand whichever finished writing last to everybody.
  const arm = await latestMacBundle(artCfg, "arm64");
  const intel = await latestMacBundle(artCfg, "x64");
  assert.equal(intel?.fileName, "XLAnt-9.9.9-x64-mac.zip");
  assert.equal(intel?.version, "9.9.9");
  assert.equal(intel?.arch, "x64");
  assert.equal(intel?.size, 6144);
  // NEWEST BY MTIME, not by parsed version: 9.9.8 was stamped later, and a
  // republished build of an older version must win exactly as it does on the
  // Windows side. This host invents no version ordering.
  assert.equal(arm?.fileName, "XLAnt-9.9.8-arm64-mac.zip");
  assert.equal(arm?.version, "9.9.8");
  assert.equal(arm?.arch, "arm64");
  assert.equal(arm?.size, 1024);
});

await leg("a directory with no Mac build, and an unreadable one, are null", async () => {
  const onlyWindows = mkdtempSync(join(tmpdir(), "xlant-nomac-"));
  writeFileSync(join(onlyWindows, "XLAnt-Setup-9.9.9.exe"), Buffer.alloc(8, 1));
  // The shapes that sit in a real directory and are NOT a servable bundle: the
  // publish step's temp file, a universal build and the arch-less name a build
  // without an explicit artifactName emits.
  writeFileSync(join(onlyWindows, "XLAnt-9.9.9-arm64-mac.zip.part"), "HALF\n");
  writeFileSync(join(onlyWindows, "XLAnt-9.9.9-universal-mac.zip"), "U\n");
  writeFileSync(join(onlyWindows, "XLAnt-9.9.9-mac.zip"), "N\n");
  try {
    for (const arch of ["arm64", "x64"] as const) {
      assert.equal(
        await latestMacBundle({ ...artCfg, artifactsDir: onlyWindows }, arch),
        null,
        `${arch} must not fall back to a name outside the contract`
      );
    }
    assert.ok(await latestInstaller({ ...artCfg, artifactsDir: onlyWindows }));
  } finally {
    rmSync(onlyWindows, { recursive: true, force: true });
  }
  // An unreadable directory is "nothing published", never a thrown page: this
  // runs inside a server render.
  const gone = { ...artCfg, artifactsDir: join(ROOT, "does-not-exist") };
  assert.equal(await latestInstaller(gone), null);
  assert.equal(await latestMacBundle(gone, "arm64"), null);
});

// --- the pre-mint probe ----------------------------------------------------

await leg("the Mac probe GETs /v1/status on the INTERNAL lane", async () => {
  relayReset(200, '{"ok":true,"platforms":["windows","mac"]}');
  assert.equal(await probeRelayMacSupport(artCfg), "supported");
  assert.equal(relayCalls.length, 1);
  assert.equal(relayCalls[0].method, "GET", "express routes /v1/status by GET");
  assert.equal(relayCalls[0].url, "/v1/status");
  assert.equal(relayCalls[0].headers["x-xlant-proxy-secret"], SECRET);
  assert.equal(
    relayCalls[0].headers["x-xlant-via"],
    undefined,
    "the internal lane must NOT carry the proxy marker — the relay rejects it"
  );
  assert.equal(relayCalls[0].body, "", "a GET carries no body");
});

await leg("a relay that does not name 'mac' is unsupported, not broken", async () => {
  // EVERY relay in production before 0.5.0: /v1/status answers 200 and simply
  // has no `platforms` key. That is the case this probe exists for.
  for (const body of [
    '{"ok":true,"version":"0.4.2"}',
    '{"ok":true,"platforms":[]}',
    '{"ok":true,"platforms":["windows"]}',
    // A `platforms` that is not a list is not a list of platforms.
    '{"ok":true,"platforms":"windows,mac"}',
    '{"ok":true,"platforms":{"mac":true}}',
    '{"ok":true,"platforms":null}',
  ]) {
    relayReset(200, body);
    assert.equal(await probeRelayMacSupport(artCfg), "unsupported", body);
  }
  // …and the nearest allow: 'mac' anywhere in the list is support.
  for (const body of [
    '{"ok":true,"platforms":["mac"]}',
    '{"ok":true,"platforms":["windows","mac"]}',
    '{"ok":true,"platforms":["mac","windows","linux"]}',
  ]) {
    relayReset(200, body);
    assert.equal(await probeRelayMacSupport(artCfg), "supported", body);
  }
});

await leg("a relay we cannot READ is 'unreadable', a different answer", async () => {
  // "The Mac lane is not deployed" and "the relay is down" are different
  // problems with different people to tell, so they must not collapse.
  for (const [status, body] of [
    [500, '{"error":"boom"}'],
    [401, '{"error":"unauthorized"}'],
    [404, "not found"],
  ] as const) {
    relayReset(status, body);
    assert.equal(await probeRelayMacSupport(artCfg), "unreadable", String(status));
  }
  // A 200 is not a promise of JSON: an intermediary can answer 200 with an
  // HTML error page, and an unguarded .json() would throw out of the mint.
  relayReset(200, "<html>gateway</html>");
  assert.equal(await probeRelayMacSupport(artCfg), "unreadable");
  relayReset(200, "null");
  assert.equal(await probeRelayMacSupport(artCfg), "unreadable");
  // Nothing listening at all.
  const dead: XlantConfig = { ...artCfg, relayUrl: "http://127.0.0.1:1" };
  assert.equal(await probeRelayMacSupport(dead), "unreadable");
});

// ===========================================================================
// 5. THE STAFF ROUTES, in-process, WITH A REAL SIGNED SESSION
// ===========================================================================
//
// Everything above this line runs without a session, and until 2026-09-08 that
// was the whole story: `readSession()` reads `next/headers`, `next/headers`
// needs a Next request scope, and this file has none — which is why the staff
// routes were pinned by reading their source rather than by running them, and
// why `xlantDownloadRequest()` was extracted as a pure function in the first
// place.
//
// That is no longer good enough. The two routes added in this round hand out
// and take away access to real machines, and the ONE property that matters
// most about them cannot be seen in a source grep: that the email the relay is
// told comes from the SESSION and never from the request body. A caller who
// could name someone else would list that person's computers and sign them
// out. So the request scope is FAKED here, with Next's own storages:
//
//   · `workAsyncStorage` + `workUnitAsyncStorage` (the `.external` entry
//     points, which is what `next/headers` itself reads) are given a minimal
//     `type: 'request'` store carrying a sealed Headers and RequestCookies
//     built from one cookie string;
//   · the session inside that cookie is minted by the REAL `signSession()`
//     with a synthetic `SESSION_COOKIE_SECRET`, so the real
//     `verifySessionToken()` accepts it and the real `requireXlantStaff()`
//     applies the real /rfp predicates to it.
//
// Nothing is stubbed: the route, the gate, the domain and provider tests and
// the relay call are all the shipped code. Two things to know when this
// breaks. (1) It depends on Next internals, so a Next upgrade can move them —
// the failure is loud and local, and the fix is this harness, never the
// routes. (2) `readSession()` also checks whether the account has been
// archived, which needs a database; there is none here, it FAILS OPEN by
// design, and each distinct email therefore prints one
// `archived-session check failed open: DATABASE_URL environment variable is
// not set` line into this output. That line is expected.
//
// NO REAL SECRET AND NO REAL SESSION: the cookie secret below is filler, and
// the sessions are minted, used and dropped inside this process.

const { workAsyncStorage } = await import(
  "next/dist/server/app-render/work-async-storage.external.js"
);
const { workUnitAsyncStorage } = await import(
  "next/dist/server/app-render/work-unit-async-storage.external.js"
);
const { HeadersAdapter } = await import(
  "next/dist/server/web/spec-extension/adapters/headers.js"
);
const { RequestCookiesAdapter } = await import(
  "next/dist/server/web/spec-extension/adapters/request-cookies.js"
);
const { RequestCookies } = await import(
  "next/dist/server/web/spec-extension/cookies.js"
);
const { signSession } = await import("@aicompany/core/auth/session");
const { siteConfig } = await import("site.config");

process.env.SESSION_COOKIE_SECRET = "synthetic-session-secret-for-xlant-tests";

const devicesRoute = await import("../src/app/api/internal/xlant/devices/route");
const revokeRoute = await import(
  "../src/app/api/internal/xlant/devices/revoke/route"
);
const mintRoute = await import(
  "../src/app/api/internal/xlant/device-token/route"
);

const LIST_PATH = "/api/internal/xlant/devices";
const REVOKE_PATH = "/api/internal/xlant/devices/revoke";
const MINT_PATH = "/api/internal/xlant/device-token";

/** A staff session, and the two shapes /rfp refuses. `Adam@xl.net` is mixed
 * case on purpose: the routes lowercase it and the relay is keyed on the
 * lowercased address. */
const STAFF = {
  userId: "u-staff",
  email: "Adam@xl.net",
  displayName: "Adam",
  provider: "google",
};
const OTHER_DOMAIN = {
  userId: "u-gmail",
  email: "someone@gmail.com",
  provider: "google",
};
// Microsoft WITHOUT the per-login `mv: true` claim — MICROSOFT_TENANT_ID is
// "common", so this is the forgery path §5.17 exists to close.
const UNVERIFIED = {
  userId: "u-ms",
  email: "adam@xl.net",
  provider: "microsoft",
};

const cookieFor = (claims: { userId: string; email: string }): string =>
  `${siteConfig.auth.sessionCookieName}=${signSession(siteConfig, claims)}`;

/** Run `fn` as if Next had just handed it a request carrying `cookie`. */
function inScope<T>(
  cookie: string | null,
  route: string,
  fn: () => Promise<T>
): Promise<T> {
  const h = new Headers(cookie ? { cookie } : {});
  // `phase: 'render'` rather than 'action': cookies() then reads the READONLY
  // jar, which is all readSession() wants, and nothing here writes one.
  const requestStore = {
    type: "request",
    phase: "render",
    headers: HeadersAdapter.seal(h),
    cookies: RequestCookiesAdapter.seal(new RequestCookies(h)),
    mutableCookies: new RequestCookies(h),
    userspaceMutableCookies: new RequestCookies(h),
    implicitTags: undefined,
    url: { pathname: route, search: "" },
    rootParams: {},
    draftMode: undefined,
    devFallbackParams: null,
  };
  const workStore = { route, forceStatic: false, dynamicShouldError: false };
  return workAsyncStorage.run(workStore as never, () =>
    workUnitAsyncStorage.run(requestStore as never, fn)
  );
}

const post = (path: string, body: unknown): Request =>
  new Request(`${U}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const errorOf = async (res: Response): Promise<unknown> =>
  ((await res.json()) as { error?: unknown }).error;

await leg("the fake request scope works at all (harness self-check)", async () => {
  // BOTH DIRECTIONS, and the POSITIVE one is the whole point (refuter R3).
  // A scope whose cookie jar is broken answers "no session" for every caller,
  // so a self-check that asserted only the 401 would stay green while every
  // product leg below failed — which is exactly what R3 measured by mutating
  // the jar: eight legs red, this one still ok. If Next moves its storages,
  // the failure must land HERE and by name, not scattered across the section.
  relayReset(200, '{"ok":true,"email":"adam@xl.net","devices":[]}');
  const out = await inScope(null, LIST_PATH, () => devicesRoute.GET());
  assert.equal(out.status, 401, "a scope with no cookie must reach the gate");
  assert.equal(await errorOf(out), "unauthenticated");
  assert.equal(relayCalls.length, 0, "…and must not reach the relay");

  // The jar is READABLE: a signed staff session gets through the real
  // requireXlantStaff() and the relay is called as that person. Anything less
  // than a 200 here means the harness, not the route, is broken.
  const inside = await inScope(cookieFor(STAFF), LIST_PATH, () =>
    devicesRoute.GET()
  );
  assert.equal(
    inside.status,
    200,
    "a scope carrying a signed staff session must be READ — the jar is broken"
  );
  assert.equal(relayCalls.length, 1, "…and the route must reach the relay");
  assert.match(
    relayCalls[0].url,
    /email=adam%40xl\.net/,
    "…as the person the cookie names"
  );
});

await leg("the computer routes answer 503 BEFORE they look at a session", async () => {
  const saved = process.env.XLANT_PROXY_SHARED_SECRET;
  delete process.env.XLANT_PROXY_SHARED_SECRET;
  relayReset();
  // Called with NO request scope at all. `readSession()` THROWS outside one,
  // so a clean 503 is proof the arming gate runs first: an unconfigured host
  // must not go looking for who is asking.
  const list = await devicesRoute.GET();
  assert.equal(list.status, 503);
  assert.equal(await errorOf(list), "XLAnt is not configured on this host");
  const rev = await revokeRoute.POST(post(REVOKE_PATH, { deviceId: "dev_1" }));
  assert.equal(rev.status, 503);
  assert.equal(relayCalls.length, 0, "an unarmed host contacts nothing");
  process.env.XLANT_PROXY_SHARED_SECRET = saved;
});

await leg("signed out is 401, and the relay is never called", async () => {
  relayReset();
  for (const call of [
    () => inScope(null, LIST_PATH, () => devicesRoute.GET()),
    () =>
      inScope(null, REVOKE_PATH, () =>
        revokeRoute.POST(post(REVOKE_PATH, { deviceId: "dev_1" }))
      ),
  ]) {
    const res = await call();
    assert.equal(res.status, 401);
    assert.equal(await errorOf(res), "unauthenticated");
    // A staff inventory is one person's, so no cache anywhere may hold it —
    // including the refusals, which name the reason.
    assert.equal(res.headers.get("cache-control"), "no-store, private");
  }
  assert.equal(relayCalls.length, 0, "no session, no internal call");
});

await leg("a signed-in NON-staff caller is 403, with the reason that is true", async () => {
  relayReset();
  for (const [claims, reason] of [
    [OTHER_DOMAIN, "wrong_domain"],
    [UNVERIFIED, "wrong_provider"],
  ] as const) {
    const cookie = cookieFor(claims);
    const list = await inScope(cookie, LIST_PATH, () => devicesRoute.GET());
    assert.equal(list.status, 403, reason);
    assert.equal(await errorOf(list), reason);
    const rev = await inScope(cookie, REVOKE_PATH, () =>
      revokeRoute.POST(post(REVOKE_PATH, { deviceId: "dev_1" }))
    );
    assert.equal(rev.status, 403, reason);
    assert.equal(await errorOf(rev), reason);
  }
  assert.equal(relayCalls.length, 0, "a refused session reaches no relay");
});

// The two rows the fake relay answers with: one settled machine (reported in,
// so no clock) and one token that has never been pasted anywhere, which is the
// state a fresh mint leaves and the only state that carries an `expiresAt`.
const ROWS = [
  {
    deviceId: "dev_one",
    kind: "windows",
    machineName: "XL-LPT-A1",
    userName: "adam",
    clientVersion: "0.11.2",
    createdAt: "2026-09-04T10:00:00.000Z",
    lastSeenAt: "2026-09-08T11:00:00.000Z",
    expiresAt: null,
    openIncidents: 2,
  },
  {
    deviceId: "dev_two",
    kind: "mac",
    machineName: null,
    userName: null,
    clientVersion: null,
    createdAt: "2026-09-08T11:30:00.000Z",
    lastSeenAt: null,
    expiresAt: "2026-09-15T11:30:00.000Z",
    openIncidents: 0,
  },
];

await leg("the list is a GET on the INTERNAL lane, keyed on the SESSION's email", async () => {
  relayReset(200, JSON.stringify({ ok: true, email: "adam@xl.net", devices: ROWS }));
  const res = await inScope(cookieFor(STAFF), LIST_PATH, () => devicesRoute.GET());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store, private");
  assert.deepEqual(await res.json(), { devices: ROWS });

  assert.equal(relayCalls.length, 1);
  assert.equal(relayCalls[0].method, "GET", "express routes the list by GET");
  // LOWERCASED (the session says "Adam@xl.net") and percent-escaped: an email
  // is user-controlled text, and a raw `&` in one would invent a parameter.
  assert.equal(relayCalls[0].url, "/v1/device/list?email=adam%40xl.net");
  assert.equal(relayCalls[0].headers["x-xlant-proxy-secret"], SECRET);
  assert.equal(
    relayCalls[0].headers["x-xlant-via"],
    undefined,
    "the internal lane must NOT carry the proxy marker — the relay rejects it"
  );
  assert.equal(relayCalls[0].body, "", "a GET carries no body");
});

await leg("a body `email` is IGNORED: the sign-out names the SESSION's person", async () => {
  // THE leg this whole harness exists for. If the body could name someone,
  // any staffer could sign any colleague's laptop out of XLAnt.
  relayReset(200, '{"ok":true,"deviceId":"dev_one","superseded":3}');
  const res = await inScope(cookieFor(STAFF), REVOKE_PATH, () =>
    revokeRoute.POST(
      post(REVOKE_PATH, { deviceId: "dev_one", email: "victim@xl.net" })
    )
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, deviceId: "dev_one" });
  assert.equal(relayCalls.length, 1);
  assert.equal(relayCalls[0].method, "POST");
  assert.equal(relayCalls[0].url, "/v1/device/revoke");
  assert.deepEqual(JSON.parse(relayCalls[0].body), {
    email: "adam@xl.net",
    deviceId: "dev_one",
  });
  assert.ok(
    !relayCalls[0].body.includes("victim"),
    "a body email must not reach the relay in any field"
  );
});

await leg("the mint takes its email from the session too, whatever the body says", async () => {
  // The same property on the route that has had it since day one, now
  // MEASURED rather than read: a session can be faked here, so it is.
  relayReset(
    200,
    '{"ok":true,"deviceId":"dev_new","token":"synthetic-minted-token-0001","kind":"windows","expiresAt":"2026-09-15T12:00:00.000Z"}'
  );
  const res = await inScope(cookieFor(STAFF), MINT_PATH, () =>
    mintRoute.POST(post(MINT_PATH, { kind: "windows", email: "victim@xl.net" }))
  );
  assert.equal(res.status, 200);
  const answered = await res.text();
  assert.deepEqual(JSON.parse(answered), {
    token: "synthetic-minted-token-0001",
    kind: "windows",
  });
  // The mint answers `{token, kind}` and NOTHING else: every other field the
  // relay sends is dropped here rather than forwarded, so the button cannot
  // put a fact on screen that this host never looked at. (The seven-day clock
  // a fresh token is on reaches the staffer through the computer list, which
  // reads `expiresAt` deliberately, and through the button's own fixed
  // sentence — not by echoing whatever the relay attached to the mint.)
  assert.ok(!answered.includes("expiresAt"));
  assert.ok(!answered.includes("deviceId"));
  assert.equal(relayCalls.length, 1, "a windows mint does not probe");
  assert.equal(relayCalls[0].url, "/v1/device/issue");
  const sent = JSON.parse(relayCalls[0].body) as Record<string, unknown>;
  assert.equal(sent.email, "adam@xl.net");
  assert.equal(sent.displayName, "Adam");
  assert.equal(sent.kind, "windows");
});

await leg("a list this host cannot read is 502, and NEVER an empty list", async () => {
  for (const body of [
    '{"ok":true}',
    '{"ok":true,"devices":null}',
    '{"ok":true,"devices":{"0":{"deviceId":"x"}}}',
    "<html>gateway</html>",
    "null",
  ]) {
    relayReset(200, body);
    const res = await inScope(cookieFor(STAFF), LIST_PATH, () => devicesRoute.GET());
    assert.equal(res.status, 502, body);
    assert.equal(await errorOf(res), "relay returned no device list", body);
  }
});

await leg("a refusal and a silence get their own 502 sentence, per route", async () => {
  relayReset(500, '{"error":"boom"}');
  const list = await inScope(cookieFor(STAFF), LIST_PATH, () => devicesRoute.GET());
  assert.equal(list.status, 502);
  assert.equal(await errorOf(list), "relay refused the device list");

  relayReset(500, '{"error":"boom"}');
  const rev = await inScope(cookieFor(STAFF), REVOKE_PATH, () =>
    revokeRoute.POST(post(REVOKE_PATH, { deviceId: "dev_one" }))
  );
  assert.equal(rev.status, 502);
  assert.equal(await errorOf(rev), "relay refused the sign-out");

  // Nothing listening at all: the timeout/DNS/refused branch, which the island
  // answers with "try again in a moment" and the refusal branch does not.
  const savedUrl = process.env.XLANT_RELAY_URL;
  process.env.XLANT_RELAY_URL = "http://127.0.0.1:1";
  const deadList = await inScope(cookieFor(STAFF), LIST_PATH, () => devicesRoute.GET());
  assert.equal(deadList.status, 502);
  assert.equal(await errorOf(deadList), "the XLAnt relay did not answer");
  const deadRev = await inScope(cookieFor(STAFF), REVOKE_PATH, () =>
    revokeRoute.POST(post(REVOKE_PATH, { deviceId: "dev_one" }))
  );
  assert.equal(deadRev.status, 502);
  assert.equal(await errorOf(deadRev), "the XLAnt relay did not answer");
  process.env.XLANT_RELAY_URL = savedUrl;
});

await leg("the relay's 404 stays a 404 — nothing to do is not a failure", async () => {
  relayReset(404, '{"ok":false,"error":"not_found"}');
  const res = await inScope(cookieFor(STAFF), REVOKE_PATH, () =>
    revokeRoute.POST(post(REVOKE_PATH, { deviceId: "dev_gone" }))
  );
  assert.equal(res.status, 404);
  assert.equal(
    await errorOf(res),
    "that computer is not yours or is already signed out"
  );
});

await leg("a deviceId that could never be one is 400, and never leaves this host", async () => {
  const cookie = cookieFor(STAFF);
  for (const body of [
    {},
    { deviceId: "" },
    { deviceId: " " },
    { deviceId: "dev one" },
    { deviceId: "dev/one" },
    { deviceId: "../dev" },
    { deviceId: "dev_one&email=victim@xl.net" },
    { deviceId: "a".repeat(81) },
    { deviceId: 7 },
    { deviceId: null },
    { deviceId: ["dev_one"] },
  ]) {
    relayReset();
    const res = await inScope(cookie, REVOKE_PATH, () =>
      revokeRoute.POST(post(REVOKE_PATH, body))
    );
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(await errorOf(res), "deviceId must be a device id");
    assert.equal(
      relayCalls.length,
      0,
      `a malformed id reached the relay: ${JSON.stringify(body)}`
    );
  }
  // …and a body that is not a JSON object at all, read AFTER the gate so a
  // malformed body never tells an anonymous caller what this route takes.
  for (const raw of ["[1,2]", "null", '"dev_one"', "{oops"]) {
    relayReset();
    const res = await inScope(cookie, REVOKE_PATH, () =>
      revokeRoute.POST(
        new Request(`${U}${REVOKE_PATH}`, { method: "POST", body: raw })
      )
    );
    assert.equal(res.status, 400, raw);
    assert.equal(relayCalls.length, 0, raw);
  }
});

// ===========================================================================
// 6. THE REAL MIDDLEWARE, in-process
// ===========================================================================

await leg("CSRF: the staff POSTs are refused without an Origin, the list GET is not", async () => {
  const { NextRequest } = await import("next/server");
  const middleware = (await import("../src/proxy")).default;
  const run = async (
    method: string,
    url: string,
    headers: Record<string, string> = {}
  ) => middleware(new NextRequest(new Request(url, { method, headers })));

  // Until 2026-09-15 this leg had a first half: the DEVICE lane, whose callers
  // (the desktop, and Cursor's cloud VM as an MCP client) send no Origin, had
  // to pass the very check the staff half has to fail. That lane is gone from
  // this host and so is that half — `/api/xlant` is still deliberately absent
  // from `protectedPrefixes` (see the comment there), and there is now nothing
  // under it to refuse.
  //
  // BOTH staff POSTs sit under the one `/api/internal/xlant` prefix and both
  // must refuse an Origin-less POST — the sign-out most of all, since a
  // cross-site POST to it would take a colleague's laptop off the air from a
  // page they merely visited. No new prefix was added for the 2026-09-08
  // routes; they inherit this one, which is the whole reason they live under
  // that path.
  for (const path of [
    "/api/internal/xlant/device-token",
    "/api/internal/xlant/devices/revoke",
  ]) {
    const noOrigin = await run("POST", `${U}${path}`);
    assert.equal(noOrigin.status, 403, `${path} must refuse an Origin-less POST`);
    const sameOrigin = await run("POST", `${U}${path}`, { origin: U });
    assert.notEqual(sameOrigin.status, 403, `${path}: a same-origin POST must pass`);
  }
  // The list is a GET and the check does not apply to it; it must not be
  // refused for want of an Origin either, or the section never loads.
  const listGet = await run("GET", `${U}/api/internal/xlant/devices`);
  assert.notEqual(listGet.status, 403, "the computer list must not be CSRF-refused");
});

// ===========================================================================
// 7. Source invariants the type system cannot express
// ===========================================================================

const readRepo = (rel: string) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

await leg("the staff download keeps its runtime knobs and its one decision", () => {
  const src = readRepo("src/app/api/internal/xlant/download/route.ts");
  assert.match(src, /export const runtime = "nodejs";/);
  assert.match(src, /export const dynamic = "force-dynamic";/);
  assert.match(src, /"Cache-Control": "private, no-store"/);
  // The platform/arch decision is the pure function pinned in section 3, not a
  // second copy of the same branching: a second copy is a second thing to
  // forget when a third build target appears.
  assert.match(src, /xlantDownloadRequest\(/);
  assert.ok(
    !src.includes('params.get("platform")'),
    "the route must not re-read the query string itself"
  );
});

await leg("every download link the page draws is one the route accepts", () => {
  const page = readRepo("src/app/internal/xlant/page.tsx");
  // JSX attributes are plain JS strings, so `&` is literal here — no entity
  // decoding, and what the browser requests is what this reads.
  const hrefs = [
    ...page.matchAll(/href="(\/api\/internal\/xlant\/download[^"]*)"/g),
  ].map((m) => m[1]);
  assert.equal(hrefs.length, 3, "one Windows link and two Mac links");
  const seen: string[] = [];
  for (const href of hrefs) {
    const qs = href.includes("?") ? href.slice(href.indexOf("?") + 1) : "";
    const want = xlantDownloadRequest(new URLSearchParams(qs));
    assert.ok(want.ok, `the page links a download the route refuses: ${href}`);
    seen.push(want.platform === "mac" ? `mac:${want.arch}` : want.platform);
  }
  assert.deepEqual(seen.sort(), ["mac:arm64", "mac:x64", "windows"]);
  // One token button per kind, mounted inside its own card.
  assert.match(page, /<DeviceTokenButton kind="windows" \/>/);
  assert.match(page, /<DeviceTokenButton kind="mac" \/>/);
});

await leg("the Mac mint probes first, and the button can read the refusals", () => {
  const mint = readRepo("src/app/api/internal/xlant/device-token/route.ts");
  const button = readRepo("src/app/internal/xlant/token-button.tsx");
  // The probe is guarded by the kind: a Windows mint has worked since day one
  // and must not acquire a second relay round-trip, let alone a second way to
  // fail.
  assert.match(mint, /if \(kind === "mac"\) \{/);
  assert.match(mint, /probeRelayMacSupport\(cfg\)/);
  assert.ok(
    mint.indexOf("probeRelayMacSupport") <
      mint.indexOf('relayInternal(cfg, "/v1/device/issue"'),
    "the probe must run BEFORE the mint, or it proves nothing"
  );
  assert.ok(mint.includes(JSON.stringify("kind must be 'windows' or 'mac'")));
  // A typed code is a fine thing to log and a poor thing to read. Both
  // sentences a staffer can actually provoke from the Mac button must exist
  // verbatim in the button's map, or the page shows a raw error string.
  for (const sentence of [
    "the relay does not support Mac tokens yet (needs relay 0.5.0)",
    "the XLAnt relay did not answer",
  ]) {
    const quoted = JSON.stringify(sentence);
    assert.ok(mint.includes(quoted), `the mint should answer ${quoted}`);
    assert.ok(button.includes(quoted), `the button cannot read ${quoted}`);
  }
  // The client island must never import the server module: it reads node:fs
  // and the XLAnt shared secret, and bundling it into a client would ship both.
  assert.ok(
    !/^\s*import\b[^;]*["']@\/lib\/xlant["']/m.test(button),
    "the token button must inline its kinds, not import the server module"
  );
});

await leg("the computer-list routes keep their knobs and their session-only identity", () => {
  for (const rel of [
    "src/app/api/internal/xlant/devices/route.ts",
    "src/app/api/internal/xlant/devices/revoke/route.ts",
  ]) {
    const src = readRepo(rel);
    assert.match(src, /export const runtime = "nodejs";/, `${rel}: runtime`);
    assert.match(src, /export const dynamic = "force-dynamic";/, `${rel}: dynamic`);
    assert.match(src, /export const revalidate = 0;/, `${rel}: revalidate`);
    assert.match(src, /"cache-control": "no-store, private"/, `${rel}: cache`);
    // The identity is the session's, lowercased, and there is no second
    // reader of an email anywhere in the file. Section 5 proves the behaviour
    // against the fake relay; this refuses the SHAPE of the mistake, which is
    // the one a hurried edit makes ("just fall back to the body").
    assert.match(src, /session\.email\.toLowerCase\(\)/, `${rel}: session email`);
    assert.ok(
      !/body\.email|body\["email"\]|req\.email/.test(src),
      `${rel} reads an email from somewhere other than the session`
    );
  }
});

await leg("the page states the token rule this build actually implements", () => {
  const page = readRepo("src/app/internal/xlant/page.tsx");
  // JSX wraps prose across source lines, so a sentence is matched against the
  // page with its whitespace collapsed. (A pin that only worked while a
  // sentence happened to fit on one line would go quiet on the next reflow —
  // which is exactly how a false sentence survives a rewrite.)
  const prose = page.replace(/\s+/g, " ");
  // The retired downloads page is history: roleplay.xl.net has carried nothing
  // of XLAnt since 2026-09-04, and a live page must not send anyone looking.
  assert.ok(!page.includes("roleplay.xl.net"), "the retired page is still named");
  // Peer round xlant-a0: XLAnt is the one that does the work, and XL.net is
  // never named as a party that does it.
  assert.ok(
    !page.includes("XL.net technician agent"),
    "XL.net is still named as the party that goes to work"
  );
  // The 2026-09-08 truth, and the section that makes signing out possible.
  assert.match(prose, /One token per computer/);
  assert.match(page, /<DevicesList \/>/);
  assert.ok(
    !prose.includes("generating one never signs the other out"),
    "the single-token-per-kind paragraph is still on the page"
  );
  // A mint replaces NOTHING; an unused token is dealt with by time. Both
  // halves are pinned, because the first draft of this round said the mint
  // replaced the person's own unused token of that kind — a smaller lie than
  // the one before it, but a lie.
  assert.ok(
    !prose.includes("never pasted anywhere is replaced"),
    "the page still describes a mint replacing an unused token"
  );
  assert.ok(
    !prose.includes("The only thing a new token replaces"),
    "the page still describes a mint replacing anything"
  );
  assert.match(prose, /expires on its own/);
  assert.match(prose, /seven days/);
  // REFUTER R2, F9: the daily check-up runs with nobody watching, so "only
  // while you are watching" was false the day it was written. What is true is
  // that nothing is CHANGED without a Yes, and that the check-up only looks.
  assert.ok(
    !prose.includes("while you are watching"),
    "the page still claims XLAnt only acts while the person watches"
  );
  assert.ok(
    !prose.includes("Nothing runs on your machine"),
    "the privacy note still makes the same claim in other words"
  );
  assert.match(prose, /nothing on it is changed until you click/);
  assert.match(prose, /that check-up only looks/);
  // REFUTER R2, F8: the relay binds the machine name at an INCIDENT, not at
  // connect, so a reinstalled XLAnt does not retire the old token by
  // connecting and both rows are live until it reports something.
  assert.ok(
    !prose.includes("the first time that computer reports in"),
    "the page still says the old token goes when the computer merely connects"
  );
  assert.match(prose, /the first time the new one reports something/);
  assert.match(prose, /you may see two rows/);
  // REFUTER R3: on deploy day the fleet's existing computers arrive here
  // NAMELESS — the relay back-fills a name from a device's own later incidents
  // only — so the one active machine will read "Windows · no name yet · 3
  // open" until it next reports. The section has to say that is ordinary, or
  // the page invents a fault the staffer will go looking for.
  assert.match(prose, /that is normal, and the computer is working/);
  // And a row is a TOKEN, not a computer: after a reinstall one laptop
  // legitimately has two rows, which the old bijection sentence denied.
  assert.ok(
    !prose.includes("A row is one computer holding one token"),
    "the section still promises one row per computer"
  );
});

await leg("the mint and the list agree, and neither island imports the server module", () => {
  const button = readRepo("src/app/internal/xlant/token-button.tsx");
  const island = readRepo("src/app/internal/xlant/devices-list.tsx");
  // The sentence that was true until 2026-09-08 and is a lie now.
  assert.ok(
    !button.includes("has just been signed out"),
    "the button still claims a mint signs another computer out"
  );
  assert.ok(button.includes("Your other computers stay signed in."));
  // Per kind, and naming the right machine in each, so the two cards cannot
  // drift into describing the same mint differently.
  assert.ok(
    button.includes(
      "If you do not paste this Windows token into a PC, it expires on its own seven days from now."
    )
  );
  assert.ok(
    button.includes(
      "If you do not paste this Mac token into a Mac, it expires on its own seven days from now."
    )
  );
  assert.ok(
    !button.includes("is replaced by this one"),
    "the button still claims a mint replaces an earlier token"
  );
  // The one line that must survive every rewrite of that paragraph.
  assert.ok(button.includes("Copy it now — it is not shown again."));
  // ONE event name, spelled in two files that must not import each other.
  const EVENT = '"xlant:devices-changed"';
  assert.ok(button.includes(`const DEVICES_CHANGED_EVENT = ${EVENT};`));
  assert.ok(island.includes(`export const DEVICES_CHANGED_EVENT = ${EVENT};`));
  assert.match(
    button,
    /window\.dispatchEvent\(new CustomEvent\(DEVICES_CHANGED_EVENT\)\)/,
    "a successful mint must tell the list"
  );
  assert.match(
    island,
    /addEventListener\(DEVICES_CHANGED_EVENT/,
    "the list must listen for it"
  );
  // Both islands: @/lib/xlant reads node:fs and the XLAnt shared secret, and
  // bundling it into a client would ship both.
  for (const [name, src] of [
    ["token button", button],
    ["devices list", island],
  ] as const) {
    assert.ok(
      !/^\s*import\b[^;]*["']@\/lib\/xlant["']/m.test(src),
      `the ${name} must inline its shapes, not import the server module`
    );
  }
});

await leg("no XLAnt JSX text node is glued to the word before it", () => {
  // THE SWC "GLUED TEXT" DEFECT, which has shipped on this host twice: a JSX
  // text node that contains BOTH a newline AND a decodable HTML entity loses
  // ALL of its leading whitespace at build time, so the word before it ships
  // joined on — `<strong>seven days</strong> later,` renders "seven dayslater".
  // It is invisible to review, to tsc and to eslint. It caught this round's own
  // Download paragraph on 2026-09-08.
  //
  // THE RULE IS NOT RE-STATED HERE. `scripts/check-jsx-spacing.mjs` owns it —
  // verified against next 16.2.11's own SWC binary rather than inferred from
  // rendered pages — and `npm run build:check` runs it over all of `src/`. A
  // second copy of the predicate in this file would be a second thing to get
  // wrong, and a first cut of this leg DID get it wrong: it only looked at text
  // following a close tag, a self-closing tag or an expression, while the real
  // defect does not care what precedes the node at all. So the scanner is
  // EXECUTED, on the three XLAnt files, and this leg exists only to put that
  // 3-second answer in front of a 7-minute `build:check`.
  const script = new URL("./check-jsx-spacing.mjs", import.meta.url).pathname;
  const files = [
    "src/app/internal/xlant/page.tsx",
    "src/app/internal/xlant/devices-list.tsx",
    "src/app/internal/xlant/token-button.tsx",
  ].map((rel) => new URL(`../${rel}`, import.meta.url).pathname);
  try {
    execFileSync(process.execPath, [script, ...files], { stdio: "pipe" });
  } catch (err) {
    // Exit 1 is a defect; exit 2 is "the check could not run" and must NEVER
    // be read as clean — both fail this leg, with the scanner's own words.
    const e = err as { status?: number; stderr?: Buffer; stdout?: Buffer };
    const said = `${e.stderr?.toString() ?? ""}${e.stdout?.toString() ?? ""}`.trim();
    assert.fail(`check-jsx-spacing exited ${e.status ?? "?"}:\n${said}`);
  }
});

await leg("the nginx drop-in still caps /api/xlant below the host default", () => {
  // THE DROP-IN OUTLIVES THE LANE IT WAS WRITTEN FOR (2026-09-15). The device
  // routes are deleted, so `/api/xlant/*` is now a 404 from Next — but nginx
  // still buffers a POST body before the app ever sees the path, and the
  // server-level ceiling is 110m. Keeping the 2m cap on a publicly known path
  // that a stranded old desktop may still post to costs nothing and removes
  // the only reason an anonymous POST there could be expensive. Removing the
  // file is an ops decision, not a code one: `setup-vm.sh` rsyncs
  // deploy/nginx.d/ with --delete, so dropping it here would take the cap off
  // the VM at the next deploy.
  const read = readRepo;
  const dropin = read("deploy/nginx.d/xlant-device.conf");
  // ^~ so the prefix wins over any regex location the stamped conf grows.
  assert.match(dropin, /location \^~ \/api\/xlant\/ \{/);
  assert.match(dropin, /client_max_body_size 2m;/);
  // Everything else must stay identical to the stamped `location /`, or this
  // prefix quietly acquires different proxy behaviour from the rest of the
  // site.
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
