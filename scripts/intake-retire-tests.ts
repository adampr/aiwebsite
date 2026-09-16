// Tests for the §5.15(ii) cleaned-intake ledger retirement
// (src/lib/work/intake-issue-retire.ts, 2026-09-16 RC 14) and for the RFC 3834
// audience rule the host's raw Resend seams share (src/lib/auto-response-headers.ts,
// RC 7). Run: npm run test:intakeretire (tsx, no DB, no network, no mail).
//
// The retirement core takes its reads and its resolve as injected deps, so
// every case here drives the REAL predicate and records exactly which resolve
// calls it would have made.

import assert from "node:assert";
import { readFileSync } from "node:fs";
import {
  CLEANED_KEY_LIKE,
  CLEANED_KEY_PREFIX,
  CLEANED_TERMINAL,
  MIN_CAS_MODULE_VERSION,
  RETIRE_RESOLVED_BY,
  cleanedRowsRetirable,
  isCleanedKey,
  pinnedModuleVersion,
  retireIntakeCleaningRowsWith,
  versionAtLeast,
  type CasResolveEvent,
  type OpenCleanedRow,
  type RetireDeps,
} from "../src/lib/work/intake-issue-retire";
import { autoResponseSuppress } from "../src/lib/auto-response-headers";

let passed = 0;
async function section(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`  ok   ${name}`);
}

const T1 = new Date("2026-09-01T18:19:00.123Z");
const T2 = new Date("2026-09-02T09:00:00.456Z");

function fakeDeps(opts: {
  rows: OpenCleanedRow[];
  statuses: string[];
  cas?: boolean;
  resolveResult?: (evt: CasResolveEvent) => { ok: boolean; resolved: number; known: boolean };
}) {
  const calls: string[] = [];
  const resolves: CasResolveEvent[] = [];
  const logs: string[] = [];
  const deps: RetireDeps = {
    casSupported: () => opts.cas ?? true,
    listOpenCleanedRows: async () => {
      calls.push("rows");
      return opts.rows;
    },
    cleanedSubmissionStatuses: async () => {
      calls.push("statuses");
      return opts.statuses;
    },
    resolve: async (evt) => {
      calls.push(`resolve:${evt.key}`);
      resolves.push(evt);
      return opts.resolveResult ? opts.resolveResult(evt) : { ok: true, resolved: 1, known: true };
    },
    log: (m) => logs.push(m),
  };
  return { deps, calls, resolves, logs };
}

async function main() {
  console.log("intake-retire-tests");

  await section("all published => resolve every cleaned key WITH CAS on its own last_seen_at", async () => {
    const f = fakeDeps({
      rows: [
        { key: "work-intake:cleaned:web-create", lastSeenAt: T1 },
        { key: "work-intake:cleaned:email:xl.net", lastSeenAt: T2 },
      ],
      statuses: ["published", "published", "superseded"],
    });
    const out = await retireIntakeCleaningRowsWith(f.deps);
    assert.equal(out.kind, "resolved");
    assert.equal(f.resolves.length, 2);
    for (const [i, want] of [T1, T2].entries()) {
      const evt = f.resolves[i];
      assert.equal(evt.source, "module");
      assert.equal(evt.resolvedBy, RETIRE_RESOLVED_BY);
      assert.ok(evt.lastSeenAtMax instanceof Date, "every resolve carries lastSeenAtMax");
      assert.equal(evt.lastSeenAtMax!.getTime(), want.getTime(), "CAS bound is the snapshot value");
      assert.ok(evt.note && evt.note.length > 0, "never resolve without a note");
      assert.ok(evt.note!.includes(want.toISOString()), "the note names the CAS bound");
    }
    // Order is the race property: ledger snapshot BEFORE the status scan.
    assert.deepEqual(f.calls.slice(0, 2), ["rows", "statuses"]);
    assert.ok(f.logs.some((l) => l.includes("retired 2")));
  });

  await section("one cleaned submission still received => no resolve", async () => {
    const f = fakeDeps({
      rows: [{ key: "work-intake:cleaned:web-create", lastSeenAt: T1 }],
      statuses: ["published", "received"],
    });
    const out = await retireIntakeCleaningRowsWith(f.deps);
    assert.deepEqual(out, { kind: "kept", pending: ["received"] });
    assert.equal(f.resolves.length, 0);
  });

  await section("held / pending_approval / failed / running each keep the row", async () => {
    for (const s of ["held", "pending_approval", "failed", "running"]) {
      const f = fakeDeps({
        rows: [{ key: "work-intake:cleaned:web-update", lastSeenAt: T1 }],
        statuses: ["superseded", s],
      });
      const out = await retireIntakeCleaningRowsWith(f.deps);
      assert.equal(out.kind, "kept", s);
      assert.equal(f.resolves.length, 0, s);
    }
  });

  await section("an UNKNOWN status keeps the row (allow-list, not deny-list)", async () => {
    const f = fakeDeps({
      rows: [{ key: "work-intake:cleaned:web-create", lastSeenAt: T1 }],
      statuses: ["published", "archived-by-some-future-migration"],
    });
    const out = await retireIntakeCleaningRowsWith(f.deps);
    assert.equal(out.kind, "kept");
    assert.equal(f.resolves.length, 0);
    assert.equal(cleanedRowsRetirable(["Published"]), false, "case matters: not the literal");
  });

  await section("cleaning-failed rows are never resolved, even if a widened read returned them", async () => {
    const f = fakeDeps({
      rows: [
        { key: "work-intake:cleaning-failed:web-create", lastSeenAt: T1 },
        { key: "work-intake:cleaning-failed:email:xl.net", lastSeenAt: T1 },
        { key: "work-intake:cleaned:web-create", lastSeenAt: T2 },
      ],
      statuses: ["published"],
    });
    await retireIntakeCleaningRowsWith(f.deps);
    assert.deepEqual(
      f.resolves.map((e) => e.key),
      ["work-intake:cleaned:web-create"]
    );
    // Only cleaning-failed rows open => nothing to do, no status read at all.
    const g = fakeDeps({
      rows: [{ key: "work-intake:cleaning-failed:web-create", lastSeenAt: T1 }],
      statuses: ["published"],
    });
    assert.deepEqual(await retireIntakeCleaningRowsWith(g.deps), { kind: "no-open-rows" });
    assert.equal(g.resolves.length, 0);
    // The query pattern itself cannot reach them either.
    assert.equal(CLEANED_KEY_PREFIX, "work-intake:cleaned:");
    assert.equal(CLEANED_KEY_LIKE, "work-intake:cleaned:%");
    assert.ok(!/[_]/.test(CLEANED_KEY_PREFIX), "no LIKE wildcard inside the prefix");
    assert.equal(isCleanedKey("work-intake:cleaning-failed:web-create"), false);
    assert.equal(isCleanedKey("work-intake:cleaned:web-create"), true);
    assert.equal(isCleanedKey("work-intake:reject:x:xl.net"), false);
  });

  await section("no cleaned submission left at all => keep (vacuous truth is not evidence)", async () => {
    const f = fakeDeps({
      rows: [{ key: "work-intake:cleaned:web-create", lastSeenAt: T1 }],
      statuses: [],
    });
    const out = await retireIntakeCleaningRowsWith(f.deps);
    assert.equal(out.kind, "kept");
    assert.equal(f.resolves.length, 0);
  });

  await section("a row without a readable last_seen_at is never resolved (no CAS bound, no resolve)", async () => {
    const f = fakeDeps({
      rows: [
        { key: "work-intake:cleaned:web-create", lastSeenAt: null },
        { key: "work-intake:cleaned:web-update", lastSeenAt: new Date("nope") },
      ],
      statuses: ["published"],
    });
    assert.deepEqual(await retireIntakeCleaningRowsWith(f.deps), { kind: "no-open-rows" });
    assert.equal(f.resolves.length, 0);
  });

  await section("CAS lost (row moved since the snapshot) is reported as raced, not resolved", async () => {
    const f = fakeDeps({
      rows: [{ key: "work-intake:cleaned:web-create", lastSeenAt: T1 }],
      statuses: ["published"],
      resolveResult: () => ({ ok: true, resolved: 0, known: true }),
    });
    const out = await retireIntakeCleaningRowsWith(f.deps);
    assert.deepEqual(out, {
      kind: "resolved",
      resolved: [],
      raced: ["work-intake:cleaned:web-create"],
      failed: [],
    });
    assert.ok(f.logs.some((l) => l.includes("CAS lost")));
  });

  await section("module without CAS (the v1.129.1 pin) => inert: no read, no resolve", async () => {
    const f = fakeDeps({
      rows: [{ key: "work-intake:cleaned:web-create", lastSeenAt: T1 }],
      statuses: ["published"],
      cas: false,
    });
    assert.deepEqual(await retireIntakeCleaningRowsWith(f.deps), { kind: "inert-no-cas" });
    assert.deepEqual(f.calls, []);
  });

  await section("version gate", () => {
    assert.equal(MIN_CAS_MODULE_VERSION, "1.130.0");
    assert.equal(versionAtLeast("1.129.1", "1.130.0"), false);
    assert.equal(versionAtLeast("1.130.0", "1.130.0"), true);
    assert.equal(versionAtLeast("1.130.1", "1.130.0"), true);
    assert.equal(versionAtLeast("2.0.0", "1.130.0"), true);
    assert.equal(versionAtLeast("1.99.9", "1.130.0"), false, "numeric, not lexical");
    assert.equal(versionAtLeast(null, "1.130.0"), false);
    assert.equal(versionAtLeast("garbage", "1.130.0"), false);
    assert.deepEqual([...CLEANED_TERMINAL], ["published", "superseded"]);
  });

  await section("pin tripwire: a pin at or above v1.130.0 must really declare lastSeenAtMax", () => {
    const v = pinnedModuleVersion();
    assert.ok(v, "packages/aicompany/package.json is readable from the repo root");
    const recordSrc = readFileSync("packages/aicompany/src/issues/record.ts", "utf8");
    const iface = /export interface IssueResolveEvent \{[\s\S]*?\n\}/.exec(recordSrc)?.[0] ?? "";
    assert.ok(iface.length > 0, "IssueResolveEvent is still declared in record.ts");
    if (versionAtLeast(v, MIN_CAS_MODULE_VERSION)) {
      assert.ok(
        /lastSeenAtMax\?:\s*Date/.test(iface),
        `module ${v} is at/above ${MIN_CAS_MODULE_VERSION} but IssueResolveEvent has no lastSeenAtMax?: Date; the retirement would resolve WITHOUT CAS`
      );
    } else {
      console.log(`       (pin ${v} is below ${MIN_CAS_MODULE_VERSION}: retirement is inert on this pin)`);
    }
  });

  await section("queue-drain wiring: called from the tick closure with its own catch, not inside drainWorkQueue", () => {
    const src = readFileSync("src/lib/work/queue-drain.ts", "utf8");
    const drainStart = src.indexOf("export async function drainWorkQueue");
    const startFn = src.indexOf("export function startWorkQueueDrain");
    assert.ok(drainStart !== -1 && startFn !== -1);
    const drainBody = src.slice(drainStart, startFn);
    assert.ok(!drainBody.includes("retireIntakeCleaningRows"), "not inside drainWorkQueue()");
    const tickStart = src.indexOf("const tick = () => {", startFn);
    const tickEnd = src.indexOf("\n  };", tickStart);
    const tick = src.slice(tickStart, tickEnd);
    assert.ok(/retireIntakeCleaningRows\(\)\.catch\(/.test(tick), "tick calls it with its own .catch");
  });

  // ---- RFC 3834 audience rule (RC 7) ----

  await section("X-Auto-Response-Suppress: All only when the operator is the sole recipient", () => {
    const op = "adam@xl.net";
    assert.equal(autoResponseSuppress(["adam@xl.net"], op), "All");
    assert.equal(autoResponseSuppress(["Adam <ADAM@xl.net>"], op), "All", "normalized like oversightBcc");
    assert.equal(autoResponseSuppress(["adam@xl.net", "adam@xl.net"], op), "All");
    assert.equal(autoResponseSuppress(["adam@xl.net"], "Adam Radulovic <adam@xl.net>"), "All");
    assert.equal(autoResponseSuppress(["submitter@example.com"], op), "OOF, AutoReply");
    assert.equal(
      autoResponseSuppress(["adam@xl.net", "admin@client.example"], op),
      "OOF, AutoReply",
      "a person in the visible to wins"
    );
    assert.equal(autoResponseSuppress([], op), "OOF, AutoReply", "empty list is not 'the operator'");
    assert.equal(autoResponseSuppress(["adam@xl.net"], "not an address"), "OOF, AutoReply");
    assert.equal(autoResponseSuppress(["adam@xl.net.evil.example"], op), "OOF, AutoReply");
  });

  await section("sendGovernanceEmail: RFC 3834 defaults at the seam, caller wins (runtime probe, stubbed fetch)", async () => {
    const { sendGovernanceEmail } = await import("../src/lib/governance/budget");
    const bodies: Record<string, unknown>[] = [];
    const realFetch = globalThis.fetch;
    const realKey = process.env.RESEND_API_KEY;
    const realAdmin = process.env.ADMIN_EMAIL;
    process.env.RESEND_API_KEY = "offline-test-key";
    process.env.ADMIN_EMAIL = "ops@example.test";
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      assert.equal(await sendGovernanceEmail({ subject: "s", text: "t" }), true);
      assert.equal(await sendGovernanceEmail({ to: "submitter@example.com", subject: "s", text: "t" }), true);
      assert.equal(
        await sendGovernanceEmail({
          to: "colleague@example.com",
          subject: "s",
          text: "t",
          headers: { "X-Auto-Response-Suppress": "OOF", "X-Extra": "1" },
        }),
        true
      );
    } finally {
      globalThis.fetch = realFetch;
      if (realKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = realKey;
      if (realAdmin === undefined) delete process.env.ADMIN_EMAIL;
      else process.env.ADMIN_EMAIL = realAdmin;
    }
    assert.equal(bodies.length, 3);
    assert.deepEqual(bodies[0].headers, {
      "Auto-Submitted": "auto-generated",
      "X-Auto-Response-Suppress": "All",
    });
    assert.deepEqual(bodies[1].headers, {
      "Auto-Submitted": "auto-generated",
      "X-Auto-Response-Suppress": "OOF, AutoReply",
    });
    assert.deepEqual(bodies[2].headers, {
      "Auto-Submitted": "auto-generated",
      "X-Auto-Response-Suppress": "OOF",
      "X-Extra": "1",
    });
    for (const b of bodies) {
      const h = b.headers as Record<string, string>;
      assert.ok(!("Precedence" in h), "no Precedence header");
    }
  });

  await section("every raw seam pairs the literal with the audience rule or the operator value (source pins)", () => {
    const audience = [
      "src/lib/governance/budget.ts",
      "src/lib/work/email-intake.ts",
      "src/lib/work/requests-notify.ts",
      "src/lib/roadmap/notify.ts",
    ];
    for (const f of audience) {
      const src = readFileSync(f, "utf8");
      assert.ok(
        /"Auto-Submitted": "auto-generated",\s*"X-Auto-Response-Suppress": autoResponseSuppress\(/.test(src),
        `${f}: audience-derived suppress value next to the literal`
      );
    }
    for (const f of ["src/lib/work/notify.ts", "scripts/governance-standards-refresh.ts"]) {
      const src = readFileSync(f, "utf8");
      assert.ok(
        /"Auto-Submitted": "auto-generated",\s*"X-Auto-Response-Suppress": "All",/.test(src),
        `${f}: operator-only send carries All`
      );
    }
    for (const f of [...audience, "src/lib/work/notify.ts", "scripts/governance-standards-refresh.ts", "scripts/qa/hi-speed-test.mjs", "deploy/post-install.sh"]) {
      const src = readFileSync(f, "utf8");
      assert.ok(!/Precedence/.test(src), `${f}: no Precedence header`);
      assert.ok(!/auto-replied/.test(src), `${f}: no auto-replied value`);
    }
  });

  console.log(`intake-retire-tests: ${passed} sections passed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
