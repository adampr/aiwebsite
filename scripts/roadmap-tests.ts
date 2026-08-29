// Roadmap unit tests (§5.18): the pure security-critical helpers. No DB, no
// network. Run: npm run test:roadmap
//
// The strictClaimTrue pins exist because of a refutation-panel blocker:
// Entra serializes manifest-declared optional claims as JSON STRINGS on some
// tenants, so xms_edov can arrive as the string "false" - and a truthiness
// test would have re-opened the exact nOAuth forgery the hardened callback
// closes. Boolean("false") === true; these pins keep that bug dead.

import assert from "node:assert/strict";
import {
  decodeJwtPayload,
  strictClaimTrue,
} from "../src/lib/auth/oauth-hardened";
import {
  FREEMAIL_DOMAINS,
  isCompanyEligibleDomain,
  RESERVED_DOMAINS,
} from "../src/lib/roadmap/domains";
import {
  emailDomain,
  isVerifiedStaffProvider,
  RFP_PROVIDERS,
} from "../src/lib/rfp/access";
import { isStaffSession, SILENT_REVERIFY_PROVIDERS } from "../src/lib/roadmap/access";
import type { SessionData } from "@aicompany/core/auth/session";
import { INTERNAL_SCOPE, scopeOf } from "../src/lib/work/scope";
import { readFileSync, existsSync } from "node:fs";
import {
  isPaidStep,
  ROADMAP_CAPS,
  ROADMAP_STEPS,
  STAFF_LANE_DOMAIN,
  STAFF_STEP_HREFS,
  TRACKED_STEP_KEYS,
} from "../src/lib/roadmap/config";
import { parsePersonFields, parseRemoveIds } from "../src/lib/roadmap/validate";
import {
  PROGRESS_TOTAL,
  percentOf,
  roadmapProgress,
} from "../src/lib/roadmap/progress";
import {
  apiProxyView,
  devVmsView,
  fieldAttestable,
  fieldCounts,
  fieldInGrace,
  lakehouseView,
  secureSummary,
  secureView,
  toolCounts,
  type SecureSummary,
} from "../src/lib/roadmap/platform";
import {
  hostInDomain,
  isBlockedAddress,
  isPrivateNetworkAddress,
  parseCheckableUrl,
  statusCounts,
} from "../src/lib/roadmap/url-check";
import {
  FAILING_CARD_LINE,
  attestedLine,
  internalLine,
  reachedLine,
  secureCardLine,
  secureStepLine,
} from "../src/lib/roadmap/platform-copy";
import { rateLimitedMessage, retryAfterPhrase } from "../src/lib/retry-after";
import { staffGovernanceDraftQuery } from "../src/lib/governance/admin-db";
import { personLabel, personLabelParts } from "../src/lib/person-label";
import {
  REQ_CAP_OPEN,
  REQ_LISTED,
  REQ_OPEN,
  REQ_WORKING,
  REQUEST_CAPS,
  validateRequestBody,
} from "../src/lib/work/requests-config";

let passed = 0;
function ok(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

// ---- strictClaimTrue (the string-"false" blocker pin) ----
ok("strictClaimTrue accepts only true and 'true'", () => {
  assert.equal(strictClaimTrue(true), true);
  assert.equal(strictClaimTrue("true"), true);
  assert.equal(strictClaimTrue(false), false);
  assert.equal(strictClaimTrue("false"), false); // Boolean("false") is true; this pin is the fix
  assert.equal(strictClaimTrue("False"), false);
  assert.equal(strictClaimTrue("TRUE"), false); // exact string only
  assert.equal(strictClaimTrue(1), false);
  assert.equal(strictClaimTrue("1"), false);
  assert.equal(strictClaimTrue(undefined), false);
  assert.equal(strictClaimTrue(null), false);
  assert.equal(strictClaimTrue({}), false);
});

// ---- decodeJwtPayload ----
ok("decodeJwtPayload roundtrips a payload and rejects junk", () => {
  const payload = { aud: "client", tid: "t", xms_edov: "false", exp: 9 };
  const jwt = [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "sig",
  ].join(".");
  assert.deepEqual(decodeJwtPayload(jwt), payload);
  assert.equal(decodeJwtPayload("not-a-jwt"), null);
  assert.equal(decodeJwtPayload("a.b"), null);
  assert.equal(decodeJwtPayload(`x.${Buffer.from("[1]").toString("base64url")}.y`), null);
});

// ---- domain classification ----
ok("reserved domains are never companies", () => {
  for (const d of RESERVED_DOMAINS) assert.equal(isCompanyEligibleDomain(d), false, d);
});
ok("freemail and shared-tenant domains are never companies", () => {
  for (const d of ["gmail.com", "web.de", "qq.com", "mail.ru", "yopmail.com"])
    assert.equal(isCompanyEligibleDomain(d), false, d);
  assert.equal(isCompanyEligibleDomain("contoso.onmicrosoft.com"), false);
  assert.equal(isCompanyEligibleDomain("onmicrosoft.com"), false);
});
ok("ordinary company domains are eligible; malformed ones are not", () => {
  assert.equal(isCompanyEligibleDomain("booboo.com"), true);
  assert.equal(isCompanyEligibleDomain("corp.booboo.com"), true); // subdomains are DISTINCT companies in v1
  assert.equal(isCompanyEligibleDomain("Booboo.com"), false); // must be lowercase
  assert.equal(isCompanyEligibleDomain("localhost"), false); // bare label
  assert.equal(isCompanyEligibleDomain(""), false);
});
ok("freemail list has no duplicates", () => {
  assert.equal(new Set(FREEMAIL_DOMAINS).size, FREEMAIL_DOMAINS.length);
});
ok("freemail list is exact lowercase labels", () => {
  for (const d of FREEMAIL_DOMAINS) {
    assert.equal(d, d.toLowerCase(), d);
    assert.ok(d.includes("."), d);
    assert.ok(!d.startsWith("."), d);
  }
});

// ---- strict email domain parser (tenancy key) ----
ok("emailDomain stays strict for tenancy use", () => {
  assert.equal(emailDomain("a@booboo.com"), "booboo.com");
  assert.equal(emailDomain("a@evil.com@booboo.com"), null); // double-@ ambiguity refused
  assert.equal(emailDomain("a@Booboo.COM."), "booboo.com"); // lowered, root dot stripped
  assert.equal(emailDomain("a@xn--boo"), "xn--boo");
  assert.equal(emailDomain("a@bΟΟboo.com"), null); // non-ASCII homoglyph refused
});

// ---- Microsoft staff parity (2026-08-09) ----
// The nOAuth hole stays closed on the Microsoft lane by the per-login mv
// claim ALONE, so these pins are the security boundary: anything other than
// boolean true must fail, including the string "true" that Entra's optional
// claim serialization produces (the strictClaimTrue family above).
ok("isVerifiedStaffProvider: google needs no mv, microsoft needs mv === true", () => {
  // Google (Workspace anchor): admitted with or without mv. Never tighten.
  assert.equal(isVerifiedStaffProvider({ provider: "google" }), true);
  assert.equal(isVerifiedStaffProvider({ provider: "google", mv: false }), true);
  assert.equal(isVerifiedStaffProvider({ provider: " GOOGLE " }), true);
  // Microsoft: ONLY strict boolean true.
  assert.equal(isVerifiedStaffProvider({ provider: "microsoft", mv: true }), true);
  assert.equal(isVerifiedStaffProvider({ provider: " MICROSOFT ", mv: true }), true);
  assert.equal(isVerifiedStaffProvider({ provider: "microsoft" }), false);
  assert.equal(isVerifiedStaffProvider({ provider: "microsoft", mv: false }), false);
  assert.equal(isVerifiedStaffProvider({ provider: "microsoft", mv: "true" }), false);
  assert.equal(isVerifiedStaffProvider({ provider: "microsoft", mv: "false" }), false);
  assert.equal(isVerifiedStaffProvider({ provider: "microsoft", mv: 1 }), false);
  assert.equal(isVerifiedStaffProvider({ provider: "microsoft", mv: null }), false);
  assert.equal(isVerifiedStaffProvider({ provider: "microsoft", mv: {} }), false);
  // Everything else, mv or not: staff is OAuth-only.
  assert.equal(isVerifiedStaffProvider({ provider: "magic-link", mv: true }), false);
  assert.equal(isVerifiedStaffProvider({ provider: null }), false);
  assert.equal(isVerifiedStaffProvider({ provider: undefined, mv: true }), false);
});

ok("RFP_PROVIDERS stays google-only (microsoft rides mv, never this list)", () => {
  // A provider LIST cannot see mv, so listing microsoft here would admit
  // unverified common-tenant sessions at every isRfpProvider call site.
  assert.deepEqual([...RFP_PROVIDERS], ["google"]);
});

ok("isStaffSession pairs the predicate with exact-label xl.net", () => {
  const base: SessionData = {
    userId: "u1",
    email: "adam@xl.net",
    displayName: "Adam Example",
    provider: "microsoft",
    iat: 0,
    exp: 0,
  };
  assert.equal(isStaffSession({ ...base, mv: true }), true);
  assert.equal(isStaffSession(base), false); // microsoft without mv
  assert.equal(isStaffSession({ ...base, provider: "google" }), true); // no mv needed
  // Verified, but not xl.net: never staff.
  assert.equal(
    isStaffSession({ ...base, mv: true, email: "adam@gmail.com" }),
    false
  );
  assert.equal(
    isStaffSession({ ...base, mv: true, email: "adam@evilxl.net" }),
    false
  );
  // Subdomain and double-@ are refused by the strict parser.
  assert.equal(
    isStaffSession({ ...base, mv: true, email: "tron@ai.xl.net" }),
    false
  );
  assert.equal(
    isStaffSession({ ...base, mv: true, email: "a@xl.net@evil.com" }),
    false
  );
});

ok("SILENT_REVERIFY_PROVIDERS carries both arms the route implements", () => {
  assert.deepEqual([...SILENT_REVERIFY_PROVIDERS], ["google", "microsoft"]);
});

// ---- scope plumbing ----
ok("scopeOf maps company_id to the scope axis", () => {
  assert.deepEqual(scopeOf({ companyId: null }), INTERNAL_SCOPE);
  assert.deepEqual(scopeOf({ companyId: "abc" }), { companyId: "abc" });
});

// ---- step-list invariants (§5.20 eleven-step round) ----
ok("ROADMAP_STEPS is the eleven-step list, numbered in order", () => {
  assert.equal(ROADMAP_STEPS.length, 11);
  assert.deepEqual(
    ROADMAP_STEPS.map((s) => s.num),
    ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11"]
  );
  assert.deepEqual(
    ROADMAP_STEPS.map((s) => s.key),
    [
      "governance",
      "directory",
      "workshop",
      "work",
      "request",
      "requested",
      "scorecard",
      "cohort",
      "secure",
      "data",
      "tools",
    ]
  );
});

ok("every step is tracked XOR paid (runway grammar invariant)", () => {
  // An untracked non-paid step would silently render "Booked separately";
  // a tracked paid step would hold the frontier ring forever.
  for (const s of ROADMAP_STEPS) {
    assert.equal(
      isPaidStep(s),
      !(TRACKED_STEP_KEYS as readonly string[]).includes(s.key),
      s.key
    );
  }
  // TRACKED order matches ROADMAP_STEPS order (frontier find() depends on it).
  const stepOrder = ROADMAP_STEPS.filter(
    (s) => !isPaidStep(s)
  ).map((s) => s.key);
  assert.deepEqual([...TRACKED_STEP_KEYS], stepOrder);
});

ok("STAFF_STEP_HREFS is total and pins the owner-ruled staff targets", () => {
  for (const s of ROADMAP_STEPS)
    assert.equal(typeof STAFF_STEP_HREFS[s.key], "string", s.key);
  assert.equal(STAFF_STEP_HREFS.work, "/work/submit");
  assert.equal(STAFF_STEP_HREFS.request, "/work/requested");
  assert.equal(STAFF_STEP_HREFS.requested, "/work/requested");
  assert.equal(STAFF_STEP_HREFS.scorecard, "/roadmap/scorecard");
  // Staff governance round (owner ruling 2026-08-18): the step page's
  // read-only staff branch, never the public builder (the Noel report: a
  // staffer clicking the hub card landed in builder "create one" copy).
  assert.equal(STAFF_STEP_HREFS.governance, "/roadmap/governance");
  // Staff parity round: the REAL staff directory, no longer the scorecard
  // alias.
  assert.equal(STAFF_STEP_HREFS.directory, "/roadmap/directory");
  assert.equal(STAFF_STEP_HREFS.workshop, "/builders#workshop");
  assert.equal(STAFF_STEP_HREFS.cohort, "/builders#cohort");
  // §5.20: these three point at THEMSELVES because there is no public
  // equivalent to send staff to, so the pages MUST serve the staff lane.
  // A redirect here would be an infinite loop, and returning null for staff
  // would render the documented BLANK SHELL.
  assert.equal(STAFF_STEP_HREFS.secure, "/roadmap/secure");
  assert.equal(STAFF_STEP_HREFS.data, "/roadmap/data");
  assert.equal(STAFF_STEP_HREFS.tools, "/roadmap/tools");
});

// ---- §5.20 phases 09/10/11 ----

ok("every (steps) page under a self-pointing staff href serves the staff lane", () => {
  // The invariant that a page returning null for staff renders a blank
  // shell. These three pages have no staff redirect, so each MUST route its
  // gate through readPlatformPage, which carries the staff branch.
  for (const slug of ["secure", "data", "tools"]) {
    const src = readFileSync(
      `src/app/roadmap/(steps)/${slug}/page.tsx`,
      "utf8"
    );
    assert.ok(
      src.includes("readPlatformPage"),
      `${slug} page must gate through readPlatformPage`
    );
    assert.ok(
      !src.includes("redirect("),
      `${slug} page must not redirect (its staff href points at itself)`
    );
  }
});

ok("completion percentage: denominator is the tracked steps, not all eleven", () => {
  assert.equal(PROGRESS_TOTAL, TRACKED_STEP_KEYS.length);
  assert.equal(PROGRESS_TOTAL, 9);
  // The paid steps are server-invisible, so including them would cap every
  // company below 100 percent forever.
  assert.equal(ROADMAP_STEPS.filter(isPaidStep).length, 2);
});

ok("percentOf reserves 0 and 100 for the real ends", () => {
  assert.equal(percentOf(0, 9), 0);
  assert.equal(percentOf(9, 9), 100);
  // 8.5/9 rounds to 94, and must NOT read as 100.
  assert.equal(percentOf(8.5, 9), 94);
  // Anything short of complete is clamped below 100 even when it rounds up.
  assert.equal(percentOf(8.99, 9), 99);
  // Anything started is clamped above 0 even when it rounds down.
  assert.equal(percentOf(0.01, 9), 1);
  assert.equal(percentOf(0, 0), 0);
});

ok("step 09 half credit moves the percentage", () => {
  const base = {
    governance: { done: false },
    directory: { done: false },
    work: { done: false },
    request: { done: false },
    requested: { live: false },
    scorecard: { live: false },
    secure: { done: false, partial: false },
    data: { done: false },
    tools: { done: false },
  };
  assert.equal(roadmapProgress(base).earned, 0);
  assert.equal(roadmapProgress(base).percent, 0);
  const half = { ...base, secure: { done: false, partial: true } };
  assert.equal(roadmapProgress(half).earned, 0.5);
  assert.equal(roadmapProgress(half).percent, 6);
  const full = { ...base, secure: { done: true, partial: false } };
  assert.equal(roadmapProgress(full).earned, 1);
  const all = {
    governance: { done: true },
    directory: { done: true },
    work: { done: true },
    request: { done: true },
    requested: { live: true },
    scorecard: { live: true },
    secure: { done: true, partial: false },
    data: { done: true },
    tools: { done: true },
  };
  assert.equal(roadmapProgress(all).percent, 100);
});

ok("SAVED BUT NOT COUNTED: an unconfirmed URL never lights a step", () => {
  // The owner's central rule. A row with both URLs present but unchecked,
  // or failed, must not count; only "ok" on every required field does.
  const row = (over: Record<string, unknown> = {}) =>
    ({
      id: "x",
      companyId: null,
      kind: "api_proxy",
      label: null,
      description: null,
      url: "https://proxy.example.com",
      urlState: "unchecked",
      urlReason: null,
      urlHttpStatus: null,
      urlCheckedAt: null,
      docsUrl: "https://docs.example.com",
      docsState: "unchecked",
      docsReason: null,
      docsHttpStatus: null,
      docsCheckedAt: null,
      environmentsJson: null,
      addedByUserId: null,
      addedByEmail: "a@b.c",
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
    }) as unknown as Parameters<typeof apiProxyView>[0];

  assert.equal(apiProxyView(row())!.added, true);
  assert.equal(apiProxyView(row())!.enabled, false);
  assert.equal(
    apiProxyView(row({ urlState: "ok", docsState: "unchecked" }))!.enabled,
    false
  );
  assert.equal(
    apiProxyView(row({ urlState: "ok", docsState: "failed" }))!.enabled,
    false
  );
  assert.equal(
    apiProxyView(row({ urlState: "ok", docsState: "ok" }))!.enabled,
    true
  );
  // Developer VMs needs environments, not a URL.
  assert.equal(
    devVmsView(row({ kind: "dev_vms", url: null, docsState: "ok" }))!.enabled,
    false
  );
  assert.equal(
    devVmsView(
      row({
        kind: "dev_vms",
        url: null,
        docsState: "ok",
        environmentsJson: JSON.stringify(["Vultr"]),
      })
    )!.enabled,
    true
  );
});

ok("TOOL CARDS GATE ON THE LINK ALONE (owner directive 2026-08-20)", () => {
  // The instructions field is informational on tool cards: its state must
  // never decide counting, in either direction. Singleton views above keep
  // their two-field gating; this pins that tools diverged on purpose.
  const tool = (over: Record<string, unknown> = {}) =>
    ({
      id: "t",
      companyId: null,
      kind: "tool",
      label: "Claude Code",
      description: null,
      url: "https://tool.example.com",
      urlState: "unchecked",
      urlReason: null,
      urlHttpStatus: null,
      urlCheckedAt: null,
      urlGraceUntil: null,
      docsUrl: "https://docs.example.com",
      docsState: "unchecked",
      docsReason: null,
      docsHttpStatus: null,
      docsCheckedAt: null,
      docsGraceUntil: null,
      environmentsJson: null,
      addedByUserId: null,
      addedByEmail: "a@b.c",
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
    }) as unknown as Parameters<typeof toolCounts>[0];

  // A confirmed link counts no matter what the docs field says.
  assert.equal(toolCounts(tool({ urlState: "ok", docsState: "failed" })), true);
  assert.equal(toolCounts(tool({ urlState: "ok", docsState: "unchecked" })), true);
  // A confirmed docs field rescues nothing: the link is the evidence.
  assert.equal(toolCounts(tool({ urlState: "failed", docsState: "ok" })), false);
  assert.equal(toolCounts(tool({ urlState: "unchecked", docsState: "ok" })), false);
  // The ladder and the grace window still apply to the link itself.
  assert.equal(toolCounts(tool({ urlState: "internal" })), true);
  assert.equal(toolCounts(tool({ urlState: "attested" })), true);
  assert.equal(
    toolCounts(
      tool({
        urlState: "failed",
        urlGraceUntil: new Date(Date.now() + 60_000),
      })
    ),
    true
  );
});

// ── Step 09: ADDED is not COUNTING (defect of 2026-08-29) ───────────────
// XL.net had BOTH components on file. The api_proxy address failed its
// reachability check (truthfully: it times out from the VM), so the step
// earned half, which is correct. But the step page said "Add the other
// component to finish it" and both hub cards said "API proxy to go",
// telling the owner to add what was already there. These pins exist so a
// surface can never again call a component missing off `*Counting`.

const secureLink = (over: Record<string, unknown> = {}) =>
  ({
    id: "x",
    companyId: null,
    kind: "api_proxy",
    label: null,
    description: null,
    url: null,
    urlState: "unchecked",
    urlReason: null,
    urlHttpStatus: null,
    urlCheckedAt: null,
    urlGraceUntil: null,
    urlAttestedBy: null,
    docsUrl: null,
    docsState: "unchecked",
    docsReason: null,
    docsHttpStatus: null,
    docsCheckedAt: null,
    docsGraceUntil: null,
    docsAttestedBy: null,
    environmentsJson: null,
    addedByUserId: null,
    addedByEmail: "a@b.c",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }) as unknown as Parameters<typeof apiProxyView>[0];

/** The XL.net staff lane exactly as production held it on 2026-08-29. */
const PROD_API_PROXY = secureLink({
  id: "p",
  kind: "api_proxy",
  url: "https://lakehouse.xl.net/",
  urlState: "failed",
  urlReason: "unreachable",
  urlGraceUntil: null,
  urlCheckedAt: new Date(),
  docsUrl: "https://www.sweetprocess.com/procedures/x/",
  docsState: "ok",
  docsHttpStatus: 200,
});
const PROD_DEV_VMS = secureLink({
  id: "v",
  kind: "dev_vms",
  url: null,
  urlState: "unchecked",
  environmentsJson: JSON.stringify(["Microsoft Azure"]),
  docsUrl: "https://www.sweetprocess.com/procedures/x/",
  docsState: "ok",
  docsHttpStatus: 200,
});

ok("PROD SHAPE: a failed api_proxy is ADDED, not counting, and not missing", () => {
  const v = secureView([PROD_API_PROXY!, PROD_DEV_VMS!]);
  // CREDIT IS UNCHANGED BY THIS FIX. Half, and only half.
  assert.equal(v.apiProxy.enabled, false);
  assert.equal(v.devVms.enabled, true);
  assert.equal(v.partial, true);
  assert.equal(v.done, false);
  // "failing" means riding a grace window, which this row is not doing:
  // it failed with no grace, so it simply does not count.
  assert.equal(v.failing, false);
  // THE DEFECT: the proxy IS added.
  assert.equal(v.apiProxy.added, true);

  const s = secureSummary(v);
  assert.equal(s.apiProxyAdded, true);
  assert.equal(s.apiProxyCounting, false);
  assert.equal(s.devVmsCounting, true);
  // The collapsed boolean that could not name a component must not return.
  assert.ok(!("savedUnverified" in s));

  const card = secureCardLine(s);
  const step = secureStepLine(s);
  for (const line of [card, step]) {
    assert.ok(!/to go/i.test(line), line);
    assert.ok(!/\badd\b/i.test(line), line);
    assert.ok(/API proxy/i.test(line), line);
  }
  // The card names BOTH halves and their states, so nothing on it can be
  // read as "the API proxy is missing".
  assert.equal(card, "Developer VMs counting · API proxy not counting");
  assert.ok(step.includes("The API proxy is saved but not counting yet"), step);
  assert.ok(!step.includes("Add the other component"), step);
});

ok("step 09 copy: 'to go' and 'Add' survive ONLY where nothing was added", () => {
  // `touched` defaults to `added` because added IMPLIES touched; a case that
  // wants the touched-but-not-added grade sets it explicitly.
  const S = (o: Partial<SecureSummary>): SecureSummary => {
    const base = {
      done: false,
      partial: false,
      apiProxyCounting: false,
      devVmsCounting: false,
      apiProxyAdded: false,
      devVmsAdded: false,
      apiProxyTouched: false,
      devVmsTouched: false,
      failing: false,
      apiProxyFailing: false,
      devVmsFailing: false,
      ...o,
    };
    return {
      ...base,
      apiProxyTouched: base.apiProxyTouched || base.apiProxyAdded,
      devVmsTouched: base.devVmsTouched || base.devVmsAdded,
    };
  };
  // The genuinely-missing halves keep the old imperative wording.
  const vmsMissing = S({ partial: true, apiProxyCounting: true, apiProxyAdded: true });
  assert.equal(secureCardLine(vmsMissing), "API proxy counting · Developer VMs to go");
  assert.ok(/Add Developer VMs/.test(secureStepLine(vmsMissing)));
  const proxyMissing = S({ partial: true, devVmsCounting: true, devVmsAdded: true });
  assert.equal(secureCardLine(proxyMissing), "Developer VMs counting · API proxy to go");
  assert.ok(/Add the API proxy/.test(secureStepLine(proxyMissing)));

  // Every reachable combination gets its OWN line. Eight inputs, eight
  // distinct strings: the pre-fix chain could not satisfy this, because
  // its saved-but-not-counting arm was unreachable whenever exactly one
  // half counted.
  const all = [
    S({ failing: true, apiProxyFailing: true, devVmsFailing: true, done: true, apiProxyCounting: true, devVmsCounting: true, apiProxyAdded: true, devVmsAdded: true }),
    S({ done: true, apiProxyCounting: true, devVmsCounting: true, apiProxyAdded: true, devVmsAdded: true }),
    S({ partial: true, apiProxyCounting: true, apiProxyAdded: true, devVmsAdded: true }),
    vmsMissing,
    S({ partial: true, devVmsCounting: true, devVmsAdded: true, apiProxyAdded: true }),
    proxyMissing,
    S({ apiProxyAdded: true }),
    S({}),
    // The two step-line branches the eight above never reach. A refuter
    // proved the earlier version of this pin could not see them, so a
    // swapped component name in either would have shipped.
    S({ apiProxyAdded: true, devVmsAdded: true }),
    S({ devVmsAdded: true }),
  ];
  // secureCardLine has EIGHT possible outputs and the last two inputs share
  // its "Saved, not counting yet" arm, so eight distinct strings from these
  // ten inputs is full coverage of the card. secureStepLine has TEN.
  assert.equal(new Set(all.map(secureCardLine)).size, 8);
  assert.equal(new Set(all.map(secureStepLine)).size, 10);
  // The grace sentence NAMES the failing half, so it can never point at the
  // component the sentence before it just called not-counting.
  const proxyGrace = secureStepLine(
    S({ partial: true, apiProxyCounting: true, apiProxyAdded: true, devVmsAdded: true, failing: true, apiProxyFailing: true })
  );
  assert.ok(proxyGrace.includes("Checks on the API proxy have started failing"), proxyGrace);
  assert.ok(!proxyGrace.includes("One address here"), proxyGrace);
  const vmsGrace = secureStepLine(
    S({ partial: true, devVmsCounting: true, devVmsAdded: true, apiProxyAdded: true, failing: true, devVmsFailing: true })
  );
  assert.ok(vmsGrace.includes("Checks on Developer VMs have started failing"), vmsGrace);
  assert.ok(secureStepLine(all[0]!).includes("both components"), "both-failing wording");
  // "stopped answering" is a rung-1 claim: an `internal` field enters grace
  // without our ever having opened a socket to it.
  for (const line of all.map(secureStepLine))
    assert.ok(!/stopped answering/.test(line), line);
  // Nothing at all still reads exactly as it always did.
  assert.equal(secureCardLine(S({})), "Nothing listed yet");
  assert.equal(secureStepLine(S({})), "Nothing is counting toward this step yet.");
  // A grace window still outranks every other hub line, and the line is the
  // ONE constant steps 09/10/11 share.
  assert.equal(secureCardLine(all[0]!), FAILING_CARD_LINE);
  assert.ok(!/stopped answering/.test(FAILING_CARD_LINE));
  // On the step page grace APPENDS, so which half counts is still said.
  assert.ok(secureStepLine(all[0]!).includes("This step is complete."));
  assert.ok(secureStepLine(all[0]!).includes("Checks on both components have started failing"));
  // Site rule: no em dashes in visible copy. Step-page copy has no
  // pre-commit scan, and the ROADMAP_STEPS pin does not reach these.
  for (const line of [...all.map(secureCardLine), ...all.map(secureStepLine)])
    assert.ok(!/[–—]/.test(line), line);
});

ok("ADDED is the PRIMARY input, so 'saved' is never said about a component with none", () => {
  // THE MIRROR DEFECT, caught by a refuter on the first version of this
  // round: `added` was `url || docsUrl`, so an API proxy row carrying only
  // an instructions link and NO address reported as "saved", and the step
  // page dropped the "Add the API proxy" sentence that was correct for it.
  const docsOnlyProxy = apiProxyView(
    secureLink({ kind: "api_proxy", docsUrl: "https://d.example.com/", docsState: "ok" })
  );
  assert.equal(docsOnlyProxy!.added, false, "no address means the proxy is not added");
  assert.ok(docsOnlyProxy!.row !== null, "row existence stays visible as `row`");
  const s = secureSummary(
    secureView([
      secureLink({ kind: "api_proxy", docsUrl: "https://d.example.com/", docsState: "ok" })!,
      PROD_DEV_VMS!,
    ])
  );
  // The step page names exactly what is missing. It must NOT say the proxy
  // is "saved" (the mirror lie), and it must not claim it is "not listed"
  // either, because an instructions link IS listed. The card, which has one
  // short line, keeps "to go": the address is genuinely still to come.
  const step = secureStepLine(s);
  assert.ok(step.includes("instructions link but no address yet"), step);
  assert.ok(!/saved but not counting/.test(step), step);
  assert.ok(!/not listed/.test(step), step);
  assert.equal(secureCardLine(s), "Developer VMs counting · API proxy to go");
  // TOUCHED is what stops the hub reading as untouched. A component holding
  // only an instructions link, with nothing else on the step, used to fall
  // through to "Nothing listed yet" (a regression this pin exists to catch).
  const docsOnlyAlone = secureSummary(
    secureView([secureLink({ kind: "api_proxy", docsUrl: "https://d.example.com/", docsState: "ok" })!])
  );
  assert.equal(docsOnlyAlone.apiProxyTouched, true);
  assert.equal(docsOnlyAlone.apiProxyAdded, false);
  assert.equal(secureCardLine(docsOnlyAlone), "Saved, not counting yet · open this step");
  // "not listed" is still correct ABOUT DEV VMS here (no row at all); what
  // must never be said is that the touched API proxy is not listed.
  const aloneStep = secureStepLine(docsOnlyAlone);
  assert.ok(aloneStep.includes("the API proxy has an instructions link"), aloneStep);
  assert.ok(!aloneStep.includes("the API proxy is not listed"), aloneStep);
  assert.ok(aloneStep.includes("Developer VMs are not listed"), aloneStep);
  // Genuinely empty still reads as empty.
  const empty = secureSummary(secureView([]));
  assert.equal(secureCardLine(empty), "Nothing listed yet");
  assert.equal(secureStepLine(empty), "Nothing is counting toward this step yet.");

  // dev_vms: the environment list is the component, an instructions link is not.
  assert.equal(devVmsView(secureLink({ kind: "dev_vms", environmentsJson: "[]" }))!.added, false);
  assert.equal(
    devVmsView(secureLink({ kind: "dev_vms", docsUrl: "https://d.example.com/", docsState: "ok", environmentsJson: "[]" }))!.added,
    false
  );
  assert.equal(
    devVmsView(secureLink({ kind: "dev_vms", environmentsJson: JSON.stringify(["Vultr"]) }))!.added,
    true
  );
  assert.equal(apiProxyView(secureLink({ kind: "api_proxy" }))!.added, false);
  assert.equal(lakehouseView(secureLink({ kind: "lakehouse" }))!.added, false);
});

ok("counting IMPLIES added, and the fold in view() is what enforces it", () => {
  // THIS FIXTURE IS THE POINT. A refuter mutation-tested the earlier
  // version of this pin by deleting `added &&` from view() and it still
  // passed: every fixture satisfied the invariant for reasons unrelated to
  // the fold. Only a row that is counting with NO primary input can tell
  // the difference, and the DB forbids it (migration 0042's
  // *_ok_needs_url_ck), which is exactly why the type must forbid it too.
  const noUrlButCounting = apiProxyView(
    secureLink({ kind: "api_proxy", url: null, urlState: "ok", docsUrl: "https://d.example.com/", docsState: "ok" })
  );
  assert.equal(noUrlButCounting!.added, false);
  assert.equal(noUrlButCounting!.enabled, false, "the fold in view() is the only guard here");
  assert.equal(noUrlButCounting!.failing, false);
  // And the invariant across the ordinary shapes.
  for (const v of [
    devVmsView(secureLink({ kind: "dev_vms", environmentsJson: "[]" })),
    apiProxyView(PROD_API_PROXY),
    devVmsView(PROD_DEV_VMS),
    apiProxyView(secureLink({ url: "https://p.example.com/", urlState: "ok", docsUrl: "https://d.example.com/", docsState: "ok" })),
  ])
    assert.ok(!v!.enabled || v!.added);
});

ok("step 09 tells ONE story: no surface rebuilds the chain, and credit is untouched", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  for (const f of ["src/app/roadmap/page.tsx", "src/components/roadmap/staff-hub.tsx"]) {
    const src = read(f);
    assert.ok(src.includes("secureCardLine(status.secure)"), f);
    // The duplicated ternary and its false wording are gone from both.
    assert.ok(!src.includes("API proxy to go"), f);
    assert.ok(!src.includes("developer VMs to go"), f);
    assert.ok(!src.includes("status.secure.apiProxy"), f);
  }
  const page = read("src/app/roadmap/(steps)/secure/page.tsx");
  assert.ok(page.includes("secureStepLine("), "the step page reads the ONE copy source");
  assert.ok(!page.includes("Add the other component"));
  assert.ok(!/[–—]/.test(page));
  assert.ok(read("src/lib/roadmap/status.ts").includes("secureSummary(p.secure)"));
  // The runway and the percentage must stay structurally blind to the new
  // fields: the half is genuinely not earned, so nothing they paint moves.
  // Asserted on the ABSENCE of the new field names rather than on an exact
  // type-literal spelling, which a reformat would break with a message
  // naming the wrong problem.
  for (const f of ["src/components/roadmap/runway.tsx", "src/lib/roadmap/progress.ts"]) {
    const src = read(f);
    assert.ok(/secure:\s*\{\s*done:\s*boolean;\s*partial:\s*boolean\s*\}/.test(src), f);
    assert.ok(!src.includes("Counting"), `${f} must not learn the added/counting split`);
    assert.ok(!src.includes("Added"), f);
  }
  const s = secureSummary(secureView([PROD_API_PROXY!, PROD_DEV_VMS!]));
  assert.equal(
    roadmapProgress({
      governance: { done: false },
      directory: { done: false },
      work: { done: false },
      request: { done: false },
      requested: { live: false },
      scorecard: { live: false },
      secure: s,
      data: { done: false },
      tools: { done: false },
    }).earned,
    0.5
  );
});

ok("url-check refuses every private, reserved and mapped address", () => {
  for (const a of [
    "127.0.0.1",
    "10.0.0.5",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "fc00::1",
    "fe80::1",
    // The IPv4-mapped-IPv6 bypass: a v6 literal that reaches v4 loopback.
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "::ffff:7f00:1",
    "64:ff9b::127.0.0.1",
  ])
    assert.equal(isBlockedAddress(a), true, a);
  for (const a of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700::1111"])
    assert.equal(isBlockedAddress(a), false, a);
  // Anything we cannot parse as an address fails CLOSED.
  assert.equal(isBlockedAddress("not-an-ip"), true);
});

ok("url-check parser refuses non-http schemes and embedded credentials", () => {
  for (const u of [
    "ftp://example.com/",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,x",
    // Userinfo is both an SSRF and a phishing vector in a rendered link.
    "http://trusted.example.com@127.0.0.1/",
    "not a url",
    "",
  ])
    assert.equal(parseCheckableUrl(u), null, u);
  // Ports are explicitly supported (the owner asked for :PORT).
  assert.ok(parseCheckableUrl("https://proxy.example.com:8443/v1"));
});

ok("integer-encoded loopback normalizes into the blocklist", () => {
  // http://2130706433/ and friends are the classic blocklist dodge. The
  // WHATWG URL parser normalizes them to dotted-quad, so the address
  // classifier sees 127.0.0.1 and refuses; this pins that the two halves
  // actually meet (verified end to end against the live checker too).
  for (const raw of [
    "http://2130706433/",
    "http://0x7f000001/",
    "http://017700000001/",
  ]) {
    const parsed = parseCheckableUrl(raw);
    assert.ok(parsed, raw);
    assert.equal(parsed!.url.hostname, "127.0.0.1", raw);
    assert.equal(isBlockedAddress(parsed!.url.hostname), true, raw);
  }
});

ok("statusCounts: a secured proxy answering 401 counts, a 404 does not", () => {
  for (const s of [200, 204, 301, 302, 401, 403, 405, 429])
    assert.equal(statusCounts(s), true, String(s));
  for (const s of [404, 410, 500, 502, 503])
    assert.equal(statusCounts(s), false, String(s));
});

// ---- Staff-parity round (2026-08-09) invariants ----
ok("STAFF_LANE_DOMAIN is the one xl.net spelling", () => {
  assert.equal(STAFF_LANE_DOMAIN, "xl.net");
});

ok("person-label rule: First Last or email, never a bare first name", () => {
  assert.deepEqual(personLabelParts("Adam Radulovic", "adam@xl.net"), {
    label: "Adam Radulovic",
    kind: "name",
  });
  // Single-token name demotes to the email.
  assert.deepEqual(personLabelParts("Adam", "adam@xl.net"), {
    label: "adam@xl.net",
    kind: "email",
  });
  assert.deepEqual(personLabelParts(null, "adam@xl.net"), {
    label: "adam@xl.net",
    kind: "email",
  });
  // Bare single token only when there is no email at all.
  assert.deepEqual(personLabelParts("Adam", null), {
    label: "Adam",
    kind: "bare",
  });
  assert.deepEqual(personLabelParts("  Ana  Maria  ", ""), {
    label: "Ana  Maria",
    kind: "name",
  });
  assert.equal(personLabel("", null), "");
  assert.equal(personLabel("Tim", "  "), "Tim");
});

// Source pins (readFileSync from the repo root, where test:roadmap runs).
// The blank-shell/redirect-loop class cannot be import-pinned, so these
// grep the files that must not regress.
ok("staff-parity source pins hold", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  // StepStrip is retired: the (steps) shell renders the hub runway.
  assert.equal(existsSync("src/components/roadmap/step-strip.tsx"), false);
  assert.ok(!read("src/app/roadmap/roadmap.css").includes("rmp-strip"));
  assert.ok(
    !read("src/app/roadmap/(steps)/layout.tsx").includes("StepStrip")
  );
  // The runway's ornament staff render is retired with its prop.
  const runway = read("src/components/roadmap/runway.tsx");
  assert.ok(!runway.includes("noInvite"));
  // The staff hub passes real status + the ONE staff href map and the ONE
  // lane-domain constant (a literal "xl.net" prop would fork the
  // apolloKickGuardKey sessionStorage fence).
  const staffHub = read("src/components/roadmap/staff-hub.tsx");
  assert.ok(staffHub.includes("hrefs={STAFF_STEP_HREFS}"));
  assert.ok(!staffHub.includes("status={null}"));
  assert.ok(staffHub.includes("domain={STAFF_LANE_DOMAIN}"));
  // The directory page renders a staff branch; a resurrected staff
  // redirect against the flipped href would be a self-redirect loop.
  const dirPage = read("src/app/roadmap/(steps)/directory/page.tsx");
  assert.ok(!dirPage.includes("redirect(STAFF_STEP_HREFS.directory)"));
  assert.ok(dirPage.includes("STAFF_DIRECTORY_SCOPE"));
  // Staff governance is COMPUTED since the staff governance round (owner
  // ruling 2026-08-18); the constant-done "public offering" reading is
  // retired and must not come back.
  assert.ok(
    !read("src/lib/roadmap/status.ts").includes("governance: { done: true }")
  );
  // Company-lane fallback strings stay put (the staff overrides are props).
  assert.ok(
    read("src/components/roadmap/directory-card.tsx").includes(
      "Your company admin can initialize this from Apollo."
    )
  );
  assert.ok(
    read("src/app/roadmap/(steps)/directory/directory-table.tsx").includes(
      "Your company admin adds people here."
    )
  );
  // Every staff write branch keeps the kill switch + global-admin gate.
  // The three DIRECTORY write routes reach it through the ONE shared gate
  // (bulk-cleanup round), so the assertion moved to that file and the routes
  // are pinned to actually import it - a route that re-spelled its own gate
  // would pass the old string check while drifting from the other two.
  const gate = read("src/lib/roadmap/directory-gate.ts");
  for (const name of [
    "readStaffPage",
    "requireGlobalAdmin",
    "requireCompanyAdmin",
    "requireRoadmapWritesEnabled",
  ]) {
    assert.ok(gate.includes(name), `directory-gate: ${name}`);
  }
  for (const route of [
    "src/app/api/roadmap/directory/route.ts",
    "src/app/api/roadmap/directory/[id]/route.ts",
    "src/app/api/roadmap/directory/remove/route.ts",
  ]) {
    assert.ok(read(route).includes("directoryWriteLane"), route);
  }
  {
    const src = read("src/app/api/roadmap/apollo-import/route.ts");
    assert.ok(src.includes("readStaffPage"));
    assert.ok(src.includes("requireGlobalAdmin"));
    assert.ok(src.includes("requireRoadmapWritesEnabled"));
  }
  // The duplicate-email catch must recognize the staff lane's partial
  // unique or a staff duplicate 500s instead of 409ing.
  for (const route of [
    "src/app/api/roadmap/directory/route.ts",
    "src/app/api/roadmap/directory/[id]/route.ts",
  ]) {
    assert.ok(read(route).includes("company_people_email_staff_uq"), route);
  }
  // The naming rule's consumers and its deliberate exclusion.
  for (const consumer of [
    "src/app/roadmap/(steps)/scorecard/page.tsx",
    "src/app/roadmap/(steps)/scorecard/requests/page.tsx",
    "src/components/requests/serialize.ts",
  ]) {
    assert.ok(read(consumer).includes("@/lib/person-label"), consumer);
  }
  // The public /work credit must never become an email.
  assert.ok(!read("src/components/work-card.tsx").includes("person-label"));
  // The bare-first-name source is gone from the scorecard query.
  assert.ok(!read("src/lib/roadmap/db.ts").includes("submitterName"));
});

// ---- Attended node modifier (owner override 2026-08-20) source pins ----
ok("attended stays a bright DASHED offered modifier", () => {
  const css = readFileSync("src/app/roadmap/roadmap.css", "utf8");
  const offered = css.indexOf(".rmp-node--offered {");
  const attended = css.indexOf(".rmp-node--attended {");
  // Source order is load-bearing: both selectors are single-class (0,1,0),
  // so the attended border-color only beats the offered neutral by coming
  // LATER in the file.
  assert.ok(offered !== -1 && attended !== -1 && offered < attended);
  const block = css.slice(attended, css.indexOf("}", attended));
  // The paid identity is the dash: the modifier must inherit border-style
  // from --offered, never repaint it, and never animate (pulse = working).
  assert.ok(!block.includes("border-style"));
  assert.ok(!block.includes("animation"));
  // Attendance layers over offered ONLY: the sr phrase is state-guarded, so
  // a tracked step can never voice a head count.
  const runway = readFileSync("src/components/roadmap/runway.tsx", "utf8");
  assert.ok(runway.includes('s === "offered" && attended > 0'));
});

// ---- Staff governance round (2026-08-18, owner ruling) invariants ----
ok("staff governance: lane scope discipline holds end to end", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  const db = read("src/lib/roadmap/db.ts");
  // Every governance-doc read/write binds the ONE lane predicate
  // (govDocLaneWhere): list and count take it bare, download, edit-again
  // (2026-08-20) and remove AND it with the id - so a company read can
  // never see the staff document and vice versa.
  assert.equal(db.match(/\.where\(govDocLaneWhere\(scope\)\)/g)?.length, 2);
  assert.equal(
    db.match(/and\(eq\(CGD\.id, docId\), govDocLaneWhere\(scope\)\)/g)?.length,
    3
  );
  // The insert takes the scope, not a bare companyId (a string param would
  // compile the staff lane out of existence).
  assert.ok(db.includes("companyId: opts.scope.companyId"));
  // Only the download reader ever selects the stored bytes.
  assert.equal(db.match(/fileData: CGD\.fileData/g)?.length, 1);
  // The step page serves a REAL staff branch: a resurrected staff redirect
  // against the flipped href (/roadmap/governance) would be a self-redirect
  // loop, and returning null for staff renders the documented blank shell.
  const page = read("src/app/roadmap/(steps)/governance/page.tsx");
  assert.ok(!page.includes("redirect("));
  assert.ok(page.includes("STAFF_GOVDOC_SCOPE"));
  // The in-draft hint exists, and the write affordances (which carry the
  // only /governance builder links on the staff branch) render behind the
  // globalAdmin flag: non-admin staff are never funneled into creating.
  assert.ok(
    page.includes("It will appear here once an XL.net admin files it")
  );
  assert.ok(page.includes("{globalAdmin && ("));
  // Both doc routes resolve their lane through the ONE gate, whose staff
  // branch authorizes every write via requireGlobalAdmin.
  for (const route of [
    "src/app/api/roadmap/docs/route.ts",
    "src/app/api/roadmap/docs/[id]/route.ts",
  ]) {
    assert.ok(read(route).includes("docsWriteLane"), route);
  }
  assert.ok(
    read("src/app/api/roadmap/docs/[id]/route.ts").includes("docsReadLane")
  );
  const gate = read("src/lib/roadmap/docs-gate.ts");
  for (const name of [
    "readStaffPage",
    "requireGlobalAdmin",
    "requireCompanyAdmin",
    "requireCompanyMember",
  ]) {
    assert.ok(gate.includes(name), `docs-gate: ${name}`);
  }
  // The hub card stopped pitching the builder to staff.
  const staffHub = read("src/components/roadmap/staff-hub.tsx");
  assert.ok(!staffHub.includes("Public offering"));
  assert.ok(!staffHub.includes("Open the Governance Builder"));
});

ok("staff draft signal is metadata-only, staff-bound and retention-bounded", () => {
  // .toSQL() builds without connecting, but the lazy client wants a URL
  // (SESSION_COOKIE_SECRET idiom below).
  process.env.DATABASE_URL ||= "postgresql://pin:pin@127.0.0.1:5432/pin";
  const q = staffGovernanceDraftQuery().toSQL();
  const sqlText = q.sql.toLowerCase();
  const selectPart = sqlText.slice(0, sqlText.indexOf(" from "));
  assert.ok(sqlText.includes('"governance_projects"'));
  assert.ok(sqlText.includes("last_activity_at")); // retentionCutoff folds in
  assert.ok(selectPart.includes("count(*)"));
  // BOTH binding predicates ride the params: the project's domain field AND
  // the owner-email suffix. The domain alone is typed by the project owner
  // at creation, so without the suffix any signed-in visitor could light
  // the staff hub's "In draft" line by naming xl.net.
  assert.ok(q.params.includes("xl.net"));
  assert.ok(q.params.includes("%@xl.net"));
  // Nothing but the count leaves Postgres: no content column, no status, no
  // owner email in the SELECT (this reader's audience is any verified staff
  // session, wider than the admin console).
  for (const col of [
    "documents_json",
    "transcript_json",
    "research_json",
    "review_summary",
    "email",
    "status",
  ]) {
    assert.ok(!selectPart.includes(col), col);
  }
});

// ---- Governance doc link lane (owner directive 2026-08-18) ----
ok("gov link lane: admin-gated, scheme-gated, and urlcheck-budgeted", () => {
  const route = readFileSync("src/app/api/roadmap/docs/route.ts", "utf8");
  // The url branch is ADMIN-gated like upload (two admin resolutions in the
  // file: the JSON link branch and the multipart branch; attach keeps its
  // one member gate). Dropping either count reopens the lane to members.
  assert.equal(route.match(/docsWriteLane\("admin"\)/g)?.length, 2);
  assert.equal(route.match(/docsWriteLane\("attach"\)/g)?.length, 1);
  // The stored href is parseCheckableUrl OUTPUT, never the raw body: the
  // scheme gate IS the XSS gate, because link_url renders as an anchor.
  assert.ok(route.includes("parseCheckableUrl(body.url)"));
  assert.ok(route.includes("linkUrl: parsed.href"));
  assert.ok(!route.includes("linkUrl: body.url"));
  // Reachability spends the SHARED §5.20 urlcheck buckets (per-user + per
  // lane) on top of the doc-write bucket: those caps bound our TOTAL
  // outbound probe traffic, so a parallel bucket would double them.
  assert.ok(route.includes("roadmap:urlcheck:${"));
  assert.ok(route.includes("roadmap:urlcheck:lane:${"));
  assert.ok(route.includes("urlChecksPerUserPerHour"));
  assert.ok(route.includes("urlChecksPerCompanyPerHour"));
  assert.ok(route.includes("docWritesPerUserPerHour"));
  // The check runs with the LANE's verified domain (docs-gate resolves it
  // from the principal / STAFF_LANE_DOMAIN, never a request field): rung 2
  // is only as trustworthy as this value.
  assert.ok(route.includes("internalDomain: lane.internalDomain"));
  const gate = readFileSync("src/lib/roadmap/docs-gate.ts", "utf8");
  assert.ok(gate.includes("internalDomain: STAFF_LANE_DOMAIN"));
  assert.ok(gate.includes("internalDomain: p.company.domain"));
});

ok("gov link rows: safe anchor on the page, never a download body", () => {
  const page = readFileSync(
    "src/app/roadmap/(steps)/governance/page.tsx",
    "utf8"
  );
  // The stored href renders as an EXTERNAL anchor with the full discipline:
  // new tab, no opener handle, no referrer leak of the portal URL.
  assert.ok(page.includes('target="_blank"'));
  assert.ok(page.includes('rel="noopener noreferrer"'));
  assert.ok(page.includes("doc.linkUrl"));
  // A link row stores NO bytes and NO text (its addGovernanceDoc call
  // passes docText null and no file), so the download route's !body check
  // is what 404s it; both halves are pinned so neither can drift alone.
  const linkAt = readFileSync(
    "src/app/api/roadmap/docs/route.ts",
    "utf8"
  ).indexOf('source: "link"');
  assert.ok(linkAt >= 0);
  const linkCall = readFileSync(
    "src/app/api/roadmap/docs/route.ts",
    "utf8"
  ).slice(linkAt, linkAt + 300);
  assert.ok(linkCall.includes("docText: null"));
  assert.ok(!linkCall.includes("file:"));
  const dl = readFileSync("src/app/api/roadmap/docs/[id]/route.ts", "utf8");
  assert.ok(dl.includes("if (!body) return NOT_FOUND();"));
  // And the download projection never grew the link column: a link row's
  // reader is the anchor, not this route.
  const db = readFileSync("src/lib/roadmap/db.ts", "utf8");
  const dlFn = db.slice(
    db.indexOf("export async function governanceDocForDownload")
  );
  assert.ok(!dlFn.slice(0, dlFn.indexOf("removeGovernanceDoc")).includes("linkUrl"));
  // The secured-page ruling in one line: a 401/403 wall still "goes to SOME
  // page" (owner directive), while a 404 is a wrong address and refuses.
  assert.ok(statusCounts(401) && statusCounts(403) && !statusCounts(404));
});

// ---- Confirm-final auto-attach round (2026-08-20, owner directive) ----
ok("gov attach dedupe: one refreshed snapshot row per (lane, project)", () => {
  const db = readFileSync("src/lib/roadmap/db.ts", "utf8");
  const start = db.indexOf(
    "export async function attachOrRefreshGovernanceDoc"
  );
  assert.ok(start >= 0);
  const fn = db.slice(
    start,
    db.indexOf("export async function governanceDocForDownload")
  );
  assert.ok(fn.length > 0);
  // The refresh UPDATE is keyed on the LANE predicate + source + project
  // id: dropping the lane term would let one lane's re-confirm rewrite
  // another lane's snapshot; dropping the source term could catch an
  // unrelated future row that reuses the provenance column.
  assert.ok(fn.includes("govDocLaneWhere(opts.scope)"));
  assert.ok(fn.includes('eq(CGD.source, "governance_project")'));
  assert.ok(
    fn.includes("eq(CGD.governanceProjectId, opts.governanceProjectId)")
  );
  // The refresh rewrites the snapshot fields AND the stamp (the on-file
  // list orders and labels by created_at; a refreshed snapshot is a new
  // copy of the project as of now).
  for (const field of [
    "title: opts.title",
    "docText: opts.docText",
    "addedByUserId: opts.addedByUserId",
    "createdAt: new Date()",
  ]) {
    assert.ok(fn.includes(field), field);
  }
  // The fallback INSERT goes through the ONE writer (addGovernanceDoc),
  // never a second .insert of its own.
  assert.ok(fn.includes("addGovernanceDoc({"));
  assert.ok(!fn.includes(".insert("));
  // The route's attach lane calls the refresh writer and answers 200 with
  // the existing id on a refresh vs 201 on a first attach.
  const route = readFileSync("src/app/api/roadmap/docs/route.ts", "utf8");
  assert.ok(route.includes("attachOrRefreshGovernanceDoc({"));
  assert.ok(route.includes("refreshed ? 200 : 201"));
});

ok("nav probe carries the own-lane attach verdict for the auto-attach offer", () => {
  const route = readFileSync("src/app/api/roadmap/nav/route.ts", "utf8");
  // Staff lane: global-admin only (staff are never funneled into creating
  // governance docs, owner ruling 2026-08-18). Company lane: membership
  // itself (the docs attach lane is member-actionable). The empty answer
  // stays attach: false, so the endpoint's privacy shape is unchanged: a
  // session with no lane learns nothing new from the field.
  assert.ok(route.includes("attach: staff.globalAdmin"));
  assert.ok(route.includes("attach: true"));
  assert.ok(route.includes("attach: false"));
  // The client parse admits only the literal true (a tampered or stale
  // shape degrades to no offer, never to a promised 403).
  const probe = readFileSync("src/components/roadmap-probe.ts", "utf8");
  assert.ok(probe.includes("attach: d?.attach === true"));
  assert.ok(probe.includes("attach: false"));
});

// ---- Edit-again from the roadmap file (2026-08-20, owner directive:
// "Even final governance should be editable in the future") ----
ok("gov edit-again route: attach-lane gate, one 404 shape, validation before the write token", () => {
  const route = readFileSync(
    "src/app/api/roadmap/docs/[id]/edit/route.ts",
    "utf8"
  );
  // Lane mirrors the attach lane exactly (member-actionable company lane,
  // global-admin staff lane), resolved once; never the admin gate.
  assert.equal(route.match(/docsWriteLane\("attach"\)/g)?.length, 1);
  assert.ok(!route.includes('docsWriteLane("admin")'));
  // Missing, not-owned and wrong-source rows share the download route's
  // exact 404 body: no existence oracle across lanes or sources.
  assert.ok(route.includes('"That document does not exist."'));
  assert.ok(route.includes('doc.source !== "governance_project"'));
  // The 2026-08-09 lockout mechanic: EVERY validation (row fetch, snapshot
  // parse, builder caps, per-person creates budget, domain, byte cap) runs
  // before the fixed-hour roadmap:docs token is spent; the up-front
  // per-minute request throttle is a separate bucket.
  const tokenAt = route.indexOf("roadmap:docs:${");
  assert.ok(tokenAt > 0);
  for (const marker of [
    "roadmap:docedit:",
    "governanceDocForEdit(",
    "parseSnapshotMarkdown(",
    "countActiveProjects(",
    "countCreatedToday(",
    "documentsJsonMaxBytes",
  ]) {
    assert.ok(route.indexOf(marker) < tokenAt, marker);
  }
  // Both kill switches: roadmap writes AND governanceEnabled (a seeded
  // project in a 503'd workbench is a trap - the reopen route's reasoning).
  assert.ok(route.includes("requireRoadmapWritesEnabled()"));
  assert.ok(route.includes("governanceEnabled(process.env)"));
  // Kind validated against known kinds; domain from the lane's verified
  // tenancy value, never a request field.
  assert.ok(route.includes("isGovernanceKind(doc.governanceKind)"));
  assert.ok(route.includes("normalizeDomain(lane.internalDomain)"));
  // Round 2 FIX 4: NULL/unknown governance_kind is INELIGIBLE and answers
  // the SAME 404 (oracle-safe) - never a fallback kind, which would parse
  // the snapshot against the wrong blueprint allowlist (a 7-doc FFIEC file
  // folded into one giant doc).
  assert.ok(
    route.includes(
      "if (!isGovernanceKind(doc.governanceKind)) return NOT_FOUND();"
    )
  );
  assert.ok(!route.includes('"usage_policy"'));
  // Round 2 FIX 2 (owner rule 2026-07-17): the seeded review summary rides
  // withOpenItemsNote - a snapshot CAN carry [TO CONFIRM] markers (the
  // manual attach lane has no marker gate), and a review summary must
  // never read ready-for-final over open markers.
  assert.ok(
    route.includes("withOpenItemsNote(") &&
      route.includes("openConfirmTotal(documents)")
  );
  // Still-live own project short-circuits with created:false and spends
  // nothing; otherwise seed then repoint then 201.
  assert.ok(route.includes("created: false"));
  assert.ok(
    route.indexOf("createImportedProject({") <
      route.indexOf("repointGovernanceDocProject({")
  );
  assert.ok(route.includes("{ projectId, created: true }, 201"));
});

ok("gov edit-again repoint: lane + source bound into the ONE update", () => {
  const db = readFileSync("src/lib/roadmap/db.ts", "utf8");
  const start = db.indexOf(
    "export async function repointGovernanceDocProject"
  );
  assert.ok(start >= 0);
  const fn = db.slice(
    start,
    db.indexOf("export async function removeGovernanceDoc")
  );
  // Dropping the lane term would let one lane re-key another lane's row;
  // dropping the source term could re-key an unrelated future row that
  // reuses the provenance column.
  assert.ok(fn.includes("govDocLaneWhere(opts.scope)"));
  assert.ok(fn.includes('eq(CGD.source, "governance_project")'));
  assert.ok(fn.includes("governanceProjectId: opts.governanceProjectId"));
  // The edit read is lane-scoped in its one query and strict-uuid shaped
  // (the loose [0-9a-f-]{36} hyphen-soup 22P02 lesson).
  const readFn = db.slice(
    db.indexOf("export async function governanceDocForEdit"),
    start
  );
  assert.ok(readFn.includes("[0-9a-f]{8}-[0-9a-f]{4}"));
  assert.ok(readFn.includes("govDocLaneWhere(scope)"));
});

ok("gov edit-again UI: island only on Builder rows, staff lane admin-gated", () => {
  const page = readFileSync(
    "src/app/roadmap/(steps)/governance/page.tsx",
    "utf8"
  );
  assert.ok(page.includes('canEdit && doc.source === "governance_project"'));
  assert.ok(page.includes("canEdit={globalAdmin}"));
  const islands = readFileSync(
    "src/app/roadmap/(steps)/governance/gov-islands.tsx",
    "utf8"
  );
  assert.ok(islands.includes("Edit in the Governance Builder"));
  assert.ok(islands.includes("/edit"));
  assert.ok(islands.includes("router.push(`/governance/${data.projectId}`)"));
  // The explicit promise line, and no em/en dashes in either file's copy.
  assert.ok(page.includes("even after the original project has"));
  assert.ok(!/[–—]/.test(page) && !/[–—]/.test(islands));
});

// ---- Directory bulk-cleanup round (2026-08-09) invariants ----
ok("directory write limits are per-MINUTE windows, not per-hour", () => {
  // The reported bug: 60 writes per HOUR against a limiter whose window is
  // fixed from the first request, so clearing a bad Apollo import locked the
  // admin out for up to 59 minutes. A directory write is one statement
  // against loopback Postgres; per-hour windows are for calls with EXTERNAL
  // cost. If this key ever goes back to PerHour, that bug is back.
  assert.equal(ROADMAP_CAPS.directoryWritesPerUserPerMinute, 60);
  assert.ok(!("directoryWritesPerUserPerHour" in ROADMAP_CAPS));
  const gate = readFileSync("src/lib/roadmap/directory-gate.ts", "utf8");
  assert.ok(gate.includes("directoryWritesPerUserPerMinute"));
  assert.ok(gate.includes("directoryBulkRemovesPerUserPerMinute"));
  // Bulk draws its OWN bucket: charging a 100-row sweep to the single-write
  // bucket would lock the Add form out behind one sweep.
  assert.ok(gate.includes("roadmap:dirbulk:"));
  assert.ok(gate.includes("roadmap:dir:"));
  // Both windows are 60s. Two occurrences, one per branch.
  assert.equal(gate.match(/\n\s*60,\n/g)?.length, 2);
});

ok("a 429 names the wait instead of saying 'Give it a moment'", () => {
  assert.equal(retryAfterPhrase(1), "in a few seconds");
  // Sub-minute waits name the SECONDS. On the directory (a 60s window now) a
  // vaguer phrase would have answered the owner's complaint about "give it a
  // moment" with a near-verbatim repeat of it.
  assert.equal(retryAfterPhrase(31), "in about 40 seconds"); // rounds UP
  assert.equal(retryAfterPhrase(59), "in about a minute"); // never "60 seconds"
  assert.equal(retryAfterPhrase(60), "in about a minute");
  assert.equal(retryAfterPhrase(61), "in about 2 minutes");
  assert.equal(retryAfterPhrase(3540), "in about 59 minutes");
  // The old copy was off by an hour here, and by a day on the governance
  // console's 86400s keys.
  assert.equal(retryAfterPhrase(3600), "in about an hour");
  assert.equal(retryAfterPhrase(86_400), "in about 24 hours");
  assert.ok(rateLimitedMessage(3600).includes("in about an hour"));
  // No singular/plural mismatch at any boundary.
  for (let s = 1; s < 7300; s += 1) {
    const p = retryAfterPhrase(s);
    assert.ok(!p.includes(" 1 minutes"), String(s));
    assert.ok(!p.includes(" 1 seconds"), String(s));
    assert.ok(!p.includes(" 1 hours"), String(s));
  }
  // Both 429 helpers ship the machine-readable field the island reads.
  for (const f of ["src/lib/work/http.ts", "src/lib/governance/http.ts"]) {
    const src = readFileSync(f, "utf8");
    assert.ok(src.includes("rateLimitedMessage"), f);
    assert.ok(src.includes("retryAfterSec"), f);
    assert.ok(!src.includes("Give it a moment"), f);
  }
});

ok("directory pager is 10/50/250 with no All, and stays keyboard-safe", () => {
  const island = readFileSync(
    "src/app/roadmap/(steps)/directory/directory-table.tsx",
    "utf8"
  );
  // Owner ruling: All would render every row of an up-to-2000-row directory
  // with an editable control per row.
  assert.ok(island.includes("sizes: [10, 50, 250]"));
  assert.ok(!/sizes:\s*\[[^\]]*\b0\b/.test(island));
  assert.ok(island.includes('plural: "people"')); // never "47 persons"
  const pagerSrc = readFileSync("src/components/list-pager.tsx", "utf8");
  // Both arrows stay MOUNTED and inert via aria-disabled: the `disabled`
  // attribute blurs a keyboard user's focus to <body>.
  assert.ok(pagerSrc.includes("aria-disabled={pager.safePage === 0}"));
  // The bare `disabled` attribute, not the aria- one it is a substring of.
  assert.ok(!/[^a-z-]disabled=\{/.test(pagerSrc));
  assert.ok(pagerSrc.includes('aria-live={bottom ? undefined : "polite"}'));
  // The strip reads its sizes and plural off the pager, so the menu and the
  // readout beside it cannot disagree.
  assert.ok(pagerSrc.includes("pager.sizes.map"));
  assert.ok(pagerSrc.includes("Show ${pager.plural} per page"));
  for (const consumer of [
    "src/components/requests/my-requests.tsx",
    "src/components/requests/request-board.tsx",
    "src/app/roadmap/(steps)/scorecard/requests/requests-list-client.tsx",
  ]) {
    assert.ok(!/<PagerStrip[^>]*noun=/.test(readFileSync(consumer, "utf8")), consumer);
  }
});

ok("bulk remove is lane-scoped, capped, counts-only, and audited", () => {
  const db = readFileSync("src/lib/roadmap/db.ts", "utf8");
  // The lane predicate must be IN the delete's WHERE: a client-supplied id
  // list is otherwise a cross-lane delete.
  assert.ok(
    /inArray\(CP\.id, opts\.personIds\), dirLaneWhere\(opts\.scope\)/.test(db)
  );
  assert.ok(db.includes("db.transaction"));
  const route = readFileSync(
    "src/app/api/roadmap/directory/remove/route.ts",
    "utf8"
  );
  // Counts only. Returning per-id status would make this a cross-lane uuid
  // existence oracle.
  assert.ok(!route.includes("personIds:") || !route.includes("ids: rows"));
  assert.ok(route.includes("parseRemoveIds"));
  assert.equal(ROADMAP_CAPS.directoryBulkRemoveMax, 100);
  // The confirm step names every person, and the two suppression labels are
  // the same sentence.
  const island = readFileSync(
    "src/app/roadmap/(steps)/directory/directory-table.tsx",
    "utf8"
  );
  assert.equal(
    island.match(/and keep them out of future imports/g)?.length,
    2
  );
  assert.ok(island.includes("You are removing:"));
  assert.ok(island.includes("Select every person on this page"));
});

ok("a directory mutation rescues focus without moving the viewport", () => {
  const island = readFileSync(
    "src/app/roadmap/(steps)/directory/directory-table.tsx",
    "utf8"
  );
  // Owner report 2026-08-09: removing a person scrolled the admin all the
  // way up. A bare focus() scrolls its target into view, the outcome line
  // rendered only ABOVE the table, and html carries scroll-behavior: smooth,
  // so a 500-row list glided back to the top on every single removal.
  assert.ok(island.includes("preventScroll: true"));
  assert.ok(!/\.focus\(\)/.test(island)); // never the bare, scrolling call
  assert.ok(
    readFileSync("src/app/futurism.css", "utf8").includes(
      "scroll-behavior: smooth"
    )
  );
  // The rescue still fires ONLY on orphaned focus, so a mouse user who moved
  // on is never yanked, and it still uses aria-disabled (the `disabled`
  // attribute would blur the focus of the button just pressed).
  assert.ok(island.includes("active !== document.body"));
  assert.ok(!/[^a-z-]disabled=\{/.test(island));
  // The line renders at BOTH ends of the table and the rescue picks the copy
  // nearer the viewport, so the bulk suppression sentence is not written for
  // an admin standing 9000px above it.
  assert.equal(island.match(/\{done\}/g)?.length, 2);
  assert.ok(island.includes("nearerToViewport"));
  assert.ok(island.includes("getBoundingClientRect"));
  // Exactly ONE of the two is the live region, so it is announced once.
  const attrsOf = (ref: string) =>
    island.slice(island.indexOf(`ref={${ref}}`)).split("{done}")[0] ?? "";
  assert.ok(attrsOf("doneTopRef").includes('role="status"'));
  assert.ok(!attrsOf("doneBottomRef").includes('role="status"'));
  // Both copies are focusable, and neither is hidden from the screen reader
  // that the rescue is about to land on.
  assert.ok(attrsOf("doneTopRef").includes("tabIndex={-1}"));
  assert.ok(attrsOf("doneBottomRef").includes("tabIndex={-1}"));
  assert.ok(!attrsOf("doneBottomRef").includes("aria-hidden"));
});

ok("parseRemoveIds rejects what would 500 or over-delete", () => {
  const id = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
  const other = "3f2504e0-4f89-11d3-9a0c-0305e82c3302";
  const good = parseRemoveIds({ ids: [id, other], suppress: false });
  assert.ok(good.ok && good.ids.length === 2 && good.suppress === false);
  // De-duplicated, so "Remove 40 selected" cannot spend 40 on 12 people.
  const dup = parseRemoveIds({ ids: [id, id, id], suppress: true });
  assert.ok(dup.ok && dup.ids.length === 1);
  // A non-uuid would reach Postgres as a uuid cast and throw 22P02 (a 500).
  assert.ok(!parseRemoveIds({ ids: ["not-a-uuid"], suppress: true }).ok);
  assert.ok(!parseRemoveIds({ ids: [], suppress: true }).ok);
  assert.ok(!parseRemoveIds({ ids: [id] }).ok); // suppress is REQUIRED
  assert.ok(!parseRemoveIds({ ids: [id], suppress: "yes" }).ok);
  // `null` is valid JSON, so req.json() hands it straight to the validator;
  // reading a property off it would 500 out of a 400 path.
  for (const hostile of [null, undefined, 42, "x", [id]])
    assert.ok(!parseRemoveIds(hostile).ok, String(hostile));
  assert.ok(!parsePersonFields(null).ok);
  assert.ok(!parsePersonFields([]).ok);
  const over = Array.from(
    { length: ROADMAP_CAPS.directoryBulkRemoveMax + 1 },
    (_, i) => `3f2504e0-4f89-11d3-9a0c-${String(i).padStart(12, "0")}`
  );
  const tooMany = parseRemoveIds({ ids: over, suppress: true });
  assert.ok(!tooMany.ok && tooMany.code === "too_many");
});

ok("the roadmap API is CSRF-protected and truncation is never silent", () => {
  // Every roadmap mutation shipped with no same-origin check until this
  // round; the prefix list is hand-maintained.
  assert.ok(readFileSync("src/proxy.ts", "utf8").includes('"/api/roadmap"'));
  // Rows past directoryRenderMax have no id on the client: unreachable for
  // edit or removal, so the page must say when it truncated.
  const page = readFileSync(
    "src/app/roadmap/(steps)/directory/page.tsx",
    "utf8"
  );
  assert.equal(page.match(/countPeople\(/g)?.length, 2); // both lanes
  const island = readFileSync(
    "src/app/roadmap/(steps)/directory/directory-table.tsx",
    "utf8"
  );
  assert.ok(island.includes("total > people.length"));
  assert.ok(ROADMAP_CAPS.directoryRenderMax >= 2000);
  // The RENDER cap must not decide who has a name on the scorecard: a person
  // past it used to fall out of the identity join and render as their email.
  const db2 = readFileSync("src/lib/roadmap/db.ts", "utf8");
  assert.ok(db2.includes("directoryIdentities"));
  // Tolerant of extra parallel queries: this pin went VACUOUS once a fourth
  // element (exhibitCounts) joined the destructuring, because it was anchored
  // on the exact three-element form and a non-matching regex makes a NEGATIVE
  // assertion pass for free.
  assert.ok(/const \[people, counts, requests(?:,[^\]]*)?\] = await Promise\.all\(/.test(db2),
    "scorecardRows still destructures its parallel reads (pin is not vacuous)");
  assert.ok(!/const \[people, counts, requests(?:,[^\]]*)?\][\s\S]{0,160}listPeople\(scope\)/.test(db2));
  // An inert .btn must LOOK inert, or a paused control reads as a dead one.
  assert.ok(
    readFileSync("src/app/futurism.css", "utf8").includes(
      '.btn[aria-disabled="true"]'
    )
  );
});

ok("no step copy carries an em dash (this pin IS the enforcement)", () => {
  // There is no pre-commit copy scan for em dashes; this pin is the only
  // mechanical gate for step copy.
  for (const s of ROADMAP_STEPS) {
    const strings = [s.title, s.blurb, s.cta.todo, s.cta.done];
    for (const str of strings) assert.ok(!str.includes("—"), s.key);
  }
});

ok("step-06 blurb speaks the enforced claim cap", () => {
  const requested = ROADMAP_STEPS.find((s) => s.key === "requested");
  assert.ok(
    requested?.blurb.includes(
      `up to ${REQUEST_CAPS.concurrentPerDeveloper} at a time`
    )
  );
});

// ---- §5.19 request-body validation pins ----
ok("validateRequestBody enforces every §5.19 bound", () => {
  const good = {
    title: "Ticket triage bot",
    description: "Route new tickets by category.",
    value: 12_500,
    metrics: ["2 hrs/week saved x 4 techs x $85/hr"],
  };
  const r = validateRequestBody(good);
  assert.ok(r.ok);
  assert.equal(r.ok && r.valueUsd, 12_500);
  // title bounds
  assert.ok(!validateRequestBody({ ...good, title: "abc" }).ok);
  assert.ok(!validateRequestBody({ ...good, title: "x".repeat(61) }).ok);
  // description required, but NO minimum beyond 1 (standing owner directive)
  assert.ok(!validateRequestBody({ ...good, description: "  " }).ok);
  assert.ok(validateRequestBody({ ...good, description: "x" }).ok);
  // value: integer USD, 0..1e9; floats/strings/negatives/overflow refused
  assert.ok(validateRequestBody({ ...good, value: 0 }).ok);
  assert.ok(!validateRequestBody({ ...good, value: 10.5 }).ok);
  assert.ok(!validateRequestBody({ ...good, value: -1 }).ok);
  assert.ok(!validateRequestBody({ ...good, value: "12500" }).ok);
  assert.ok(!validateRequestBody({ ...good, value: 2_000_000_000 }).ok);
  // metrics: >= 1 non-empty, <= 10, each <= 300 chars
  assert.ok(!validateRequestBody({ ...good, metrics: [] }).ok);
  assert.ok(!validateRequestBody({ ...good, metrics: ["  "] }).ok);
  assert.ok(
    !validateRequestBody({ ...good, metrics: Array(11).fill("m") }).ok
  );
  assert.ok(
    !validateRequestBody({ ...good, metrics: ["x".repeat(301)] }).ok
  );
  // empties are dropped, survivors kept
  const dropped = validateRequestBody({ ...good, metrics: ["", " a ", ""] });
  assert.ok(dropped.ok && dropped.metrics.length === 1);
  assert.equal(dropped.ok && dropped.metrics[0], "a");
  // non-object body
  assert.ok(!validateRequestBody(null).ok);
  assert.ok(!validateRequestBody("json").ok);
});

ok("§5.19 status vocabulary stays privacy-partitioned", () => {
  // pending/rejected NEVER appear in any listed/board/scorecard set.
  for (const set of [REQ_LISTED, REQ_WORKING, REQ_OPEN]) {
    assert.ok(!(set as readonly string[]).includes("pending"));
    assert.ok(!(set as readonly string[]).includes("rejected"));
  }
  // Working On is exactly the 3-cap predicate.
  assert.deepEqual([...REQ_WORKING], ["in_progress", "done_pending"]);
  // The 5-cap universe = everything not finished or refused.
  assert.deepEqual(
    [...REQ_CAP_OPEN].sort(),
    ["approved", "done_pending", "in_progress", "pending"].sort()
  );
});

console.log(`\nroadmap-tests: ${passed} checks passed`);

// ---- DKIM detection (§5.18 round 2): checkDkimWith against a fake port ----
// Each case pins a verdict rule the refutation panel flagged: false-missing
// on mixed/foreign MX, CNAME-presence never equals ok, wildcard zones veto
// both ok and revoked, indeterminate errors never produce missing.
import { checkDkimWith, type DnsPort } from "../src/lib/roadmap/dkim";
import { reverifyBinding } from "../src/lib/auth/reverify";
import { personPhone } from "../src/lib/roadmap/apollo";

type FakeAnswer =
  | { mx: { exchange: string; priority: number }[] }
  | { txt: string[][] }
  | { cname: string[] }
  | { err: string };

function fakePort(table: Record<string, FakeAnswer>): DnsPort {
  const answer = (key: string): FakeAnswer =>
    table[key] ?? { err: "ENOTFOUND" };
  const reject = (code: string) => {
    const e = new Error(code) as Error & { code: string };
    e.code = code;
    return Promise.reject(e);
  };
  return {
    resolveMx(name) {
      const a = answer(`MX:${name}`);
      return "mx" in a ? Promise.resolve(a.mx) : reject((a as { err: string }).err);
    },
    resolveTxt(name) {
      const a = answer(`TXT:${name}`);
      return "txt" in a ? Promise.resolve(a.txt) : reject((a as { err: string }).err);
    },
    resolveCname(name) {
      const a = answer(`CNAME:${name}`);
      return "cname" in a
        ? Promise.resolve(a.cname)
        : reject((a as { err: string }).err);
    },
    cancel() {},
  };
}

const M365_MX = { mx: [{ exchange: "co-com.mail.protection.outlook.com", priority: 0 }] };
const GOOGLE_MX = { mx: [{ exchange: "aspmx.l.google.com", priority: 1 }, { exchange: "alt1.aspmx.l.google.com", priority: 5 }] };
const VALID_KEY = { txt: [["v=DKIM1; k=rsa; p=", "MIIBIjANBgkq"]] }; // split chunks concatenate

await (async () => {
  // m365 clean ok
  let r = await checkDkimWith(
    fakePort({
      "MX:co.com": M365_MX,
      "TXT:selector1._domainkey.co.com": VALID_KEY,
    }),
    "co.com"
  );
  assert.equal(r.verdict, "ok");
  assert.equal(r.reason, "m365-selector-live");
  assert.equal(r.selector, "selector1");
  passed++; console.log("ok - dkim: m365 valid key -> ok");

  // m365 no cnames -> missing with the add-records remediation
  r = await checkDkimWith(fakePort({ "MX:co.com": M365_MX }), "co.com");
  assert.equal(r.verdict, "missing");
  assert.equal(r.reason, "m365-no-cnames");
  passed++; console.log("ok - dkim: m365 nothing published -> missing/no-cnames");

  // m365 CNAMEs installed but chain dead -> missing/cname-dead (and NEVER ok:
  // CNAME presence does not prove signing)
  r = await checkDkimWith(
    fakePort({
      "MX:co.com": M365_MX,
      "CNAME:selector1._domainkey.co.com": { cname: ["selector1-co-com._domainkey.t.onmicrosoft.com"] },
      "CNAME:selector2._domainkey.co.com": { cname: ["selector2-co-com._domainkey.t.onmicrosoft.com"] },
    }),
    "co.com"
  );
  assert.equal(r.verdict, "missing");
  assert.equal(r.reason, "m365-cname-dead");
  passed++; console.log("ok - dkim: m365 cname without keys -> missing/cname-dead");

  // google ok via split TXT concatenation
  r = await checkDkimWith(
    fakePort({
      "MX:g.com": GOOGLE_MX,
      "TXT:google._domainkey.g.com": VALID_KEY,
    }),
    "g.com"
  );
  assert.equal(r.verdict, "ok");
  assert.equal(r.reason, "google-selector-live");
  passed++; console.log("ok - dkim: google split-chunk key -> ok");

  // google authoritative absence -> missing
  r = await checkDkimWith(fakePort({ "MX:g.com": GOOGLE_MX }), "g.com");
  assert.equal(r.verdict, "missing");
  assert.equal(r.reason, "google-absent");
  passed++; console.log("ok - dkim: google absent -> missing");

  // revoked key (empty p=) with clean canary -> missing/key-revoked
  r = await checkDkimWith(
    fakePort({
      "MX:g.com": GOOGLE_MX,
      "TXT:google._domainkey.g.com": { txt: [["v=DKIM1; p="]] },
    }),
    "g.com"
  );
  assert.equal(r.verdict, "missing");
  assert.equal(r.reason, "key-revoked");
  passed++; console.log("ok - dkim: empty p= -> missing/key-revoked");

  // wildcard zone fakes the revocation -> unknown, never missing
  const wildcardTable: Record<string, FakeAnswer> = {
    "MX:w.com": GOOGLE_MX,
    "TXT:google._domainkey.w.com": { txt: [["v=DKIM1; p="]] },
  };
  const wildPort = fakePort(wildcardTable);
  const origTxt = wildPort.resolveTxt.bind(wildPort);
  wildPort.resolveTxt = (name) =>
    name.startsWith("xl-dkim-canary-")
      ? Promise.resolve([["v=DKIM1; p="]])
      : origTxt(name);
  r = await checkDkimWith(wildPort, "w.com");
  assert.equal(r.verdict, "unknown");
  assert.equal(r.reason, "wildcard-dns");
  passed++; console.log("ok - dkim: wildcard zone vetoes revocation -> unknown");

  // wildcard zone also vetoes ok
  const wildOk = fakePort({ "MX:w.com": GOOGLE_MX, "TXT:google._domainkey.w.com": VALID_KEY });
  const origTxt2 = wildOk.resolveTxt.bind(wildOk);
  wildOk.resolveTxt = (name) =>
    name.startsWith("xl-dkim-canary-") ? Promise.resolve([["parked"]]) : origTxt2(name);
  r = await checkDkimWith(wildOk, "w.com");
  assert.equal(r.verdict, "unknown");
  assert.equal(r.reason, "wildcard-dns");
  passed++; console.log("ok - dkim: wildcard zone vetoes ok -> unknown");

  // mixed providers mid-migration -> unknown, never missing
  r = await checkDkimWith(
    fakePort({
      "MX:m.com": { mx: [
        { exchange: "co-com.mail.protection.outlook.com", priority: 10 },
        { exchange: "aspmx.l.google.com", priority: 20 },
      ] },
    }),
    "m.com"
  );
  assert.equal(r.verdict, "unknown");
  assert.equal(r.reason, "mx-mixed");
  passed++; console.log("ok - dkim: mixed MX -> unknown/mx-mixed");

  // foreign gateway alongside a Google leftover -> other, never missing
  r = await checkDkimWith(
    fakePort({
      "MX:p.com": { mx: [
        { exchange: "mx0a-000.pphosted.com", priority: 10 },
        { exchange: "aspmx.l.google.com", priority: 20 },
      ] },
    }),
    "p.com"
  );
  assert.equal(r.provider, "other");
  assert.equal(r.verdict, "unknown");
  passed++; console.log("ok - dkim: gateway + leftover google MX -> other/unknown");

  // indeterminate selector error -> unknown, never missing
  r = await checkDkimWith(
    fakePort({
      "MX:t.com": GOOGLE_MX,
      "TXT:google._domainkey.t.com": { err: "ETIMEOUT" },
    }),
    "t.com"
  );
  assert.equal(r.verdict, "unknown");
  assert.equal(r.reason, "dns-error");
  passed++; console.log("ok - dkim: selector timeout -> unknown/dns-error");

  // no MX / null MX -> unknown/no-mx
  r = await checkDkimWith(fakePort({ "MX:n.com": { err: "ENODATA" } }), "n.com");
  assert.equal(r.reason, "no-mx");
  r = await checkDkimWith(fakePort({ "MX:n.com": { mx: [{ exchange: ".", priority: 0 }] } }), "n.com");
  assert.equal(r.reason, "no-mx");
  passed++; console.log("ok - dkim: no MX / null MX -> unknown/no-mx");

  // other provider, common-selector hit -> ok
  r = await checkDkimWith(
    fakePort({
      "MX:o.com": { mx: [{ exchange: "mail.o.com", priority: 10 }] },
      "TXT:default._domainkey.o.com": VALID_KEY,
    }),
    "o.com"
  );
  assert.equal(r.verdict, "ok");
  assert.equal(r.reason, "other-selector-live");
  passed++; console.log("ok - dkim: other provider selector hit -> ok");

  // other provider, all misses -> unknown (absence proves nothing)
  r = await checkDkimWith(
    fakePort({ "MX:o.com": { mx: [{ exchange: "mail.o.com", priority: 10 }] } }),
    "o.com"
  );
  assert.equal(r.verdict, "unknown");
  assert.equal(r.reason, "other-provider");
  passed++; console.log("ok - dkim: other provider no hits -> unknown");

  // malformed input -> unknown, no queries assumed
  r = await checkDkimWith(fakePort({}), "not a domain");
  assert.equal(r.verdict, "unknown");
  passed++; console.log("ok - dkim: malformed domain -> unknown");
})();

// ---- reverify binding ----
ok("reverify binding is deterministic and email-scoped", () => {
  process.env.SESSION_COOKIE_SECRET ??= "x".repeat(32);
  assert.equal(reverifyBinding("A@b.com"), reverifyBinding("a@B.COM"));
  assert.notEqual(reverifyBinding("a@b.com"), reverifyBinding("c@b.com"));
  assert.match(reverifyBinding("a@b.com"), /^[0-9a-f]{64}$/);
});

await (async () => {
  // Round 5: the Amazon vendor hint requires EVERY exchange to be the strict
  // inbound-smtp shape; a bare .amazonaws.com host (self-hosted EC2 mail)
  // must NOT claim Amazon routing.
  let r = await checkDkimWith(
    fakePort({ "MX:a.com": { mx: [{ exchange: "inbound-smtp.us-east-1.amazonaws.com", priority: 10 }] } }),
    "a.com"
  );
  assert.equal(r.reason, "other-provider");
  assert.equal(r.mxVendor, "amazon");
  r = await checkDkimWith(
    fakePort({ "MX:a.com": { mx: [{ exchange: "ec2-1-2-3-4.compute-1.amazonaws.com", priority: 10 }] } }),
    "a.com"
  );
  assert.equal(r.mxVendor, undefined);
  r = await checkDkimWith(
    fakePort({ "MX:a.com": { mx: [
      { exchange: "inbound-smtp.us-east-1.amazonaws.com", priority: 10 },
      { exchange: "mail.other.com", priority: 20 },
    ] } }),
    "a.com"
  );
  assert.equal(r.mxVendor, undefined);
  passed += 3;
  console.log("ok - dkim: strict SES inbound-smtp vendor matcher (3 pins)");
})();

await (async () => {
  // "resend" in OTHER_SELECTORS: ESP key published under SES inbound MX
  // (the real itsupportchicago.net topology) -> ok, and a valid hit renders
  // without the mxVendor copy hint (verdict is no longer Amazon-unverifiable).
  const SES_MX = { mx: [{ exchange: "inbound-smtp.us-east-1.amazonaws.com", priority: 10 }] };
  let r = await checkDkimWith(
    fakePort({ "MX:r.com": SES_MX, "TXT:resend._domainkey.r.com": VALID_KEY }),
    "r.com"
  );
  assert.equal(r.verdict, "ok");
  assert.equal(r.reason, "other-selector-live");
  assert.equal(r.selector, "resend");
  assert.equal(r.mxVendor, undefined);
  passed++; console.log("ok - dkim: resend selector hit under SES MX -> ok");

  // wildcard canary still vetoes a resend hit -> unknown, never ok
  const wildResend = fakePort({ "MX:r.com": SES_MX, "TXT:resend._domainkey.r.com": VALID_KEY });
  const origTxt3 = wildResend.resolveTxt.bind(wildResend);
  wildResend.resolveTxt = (name) =>
    name.startsWith("xl-dkim-canary-") ? Promise.resolve([["parked"]]) : origTxt3(name);
  r = await checkDkimWith(wildResend, "r.com");
  assert.equal(r.verdict, "unknown");
  assert.equal(r.reason, "wildcard-dns");
  passed++; console.log("ok - dkim: wildcard zone vetoes resend hit -> unknown");

  // revoked resend key (p= empty) in the other lane -> unknown/other-provider
  // (the other lane has no revoked branch; absence proves nothing there)
  r = await checkDkimWith(
    fakePort({ "MX:r.com": SES_MX, "TXT:resend._domainkey.r.com": { txt: [["v=DKIM1; p="]] } }),
    "r.com"
  );
  assert.equal(r.verdict, "unknown");
  assert.equal(r.reason, "other-provider");
  // Pinned: this path still carries the vendor hint, so the dialog shows the
  // Amazon console copy for a Resend customer mid key rotation. Known and
  // accepted (the other lane has no revoked branch); a change that flips this
  // copy on or off should be deliberate, not incidental.
  assert.equal(r.mxVendor, "amazon");
  passed += 2;
  console.log("ok - dkim: revoked resend key -> unknown, never missing (+ amazon copy pin)");

  // pure-M365 MX with a published resend key: OTHER_SELECTORS must NOT be
  // probed outside the other lane -> the M365 verdict is untouched (missing)
  r = await checkDkimWith(
    fakePort({ "MX:co.com": M365_MX, "TXT:resend._domainkey.co.com": VALID_KEY }),
    "co.com"
  );
  assert.equal(r.verdict, "missing");
  assert.equal(r.reason, "m365-no-cnames");
  passed++; console.log("ok - dkim: resend key does not green an M365 tenant");
})();

// ---- §5.20 round 2: the evidence ladder + hysteresis ----

ok("the ladder: reached, internal and attested all count; failed does not", () => {
  assert.equal(fieldCounts("ok", null), true);
  assert.equal(fieldCounts("internal", null), true);
  assert.equal(fieldCounts("attested", null), true);
  assert.equal(fieldCounts("failed", null), false);
  assert.equal(fieldCounts("unchecked", null), false);
  assert.equal(fieldCounts(null, null), false);
});

ok("hysteresis: a failing field keeps counting until its grace expires", () => {
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  assert.equal(fieldCounts("failed", future), true);
  assert.equal(fieldInGrace("failed", future), true);
  assert.equal(fieldCounts("failed", past), false);
  assert.equal(fieldInGrace("failed", past), false);
  // Grace is meaningless on a state that is not failing, and must never
  // make an unchecked field count.
  assert.equal(fieldCounts("unchecked", future), false);
  assert.equal(fieldInGrace("ok", future), false);
  assert.equal(fieldCounts("failed", "not-a-date"), false);
});

ok("attestation is NOT a universal bypass", () => {
  const D = "acme.com";
  const mine = "https://proxy.acme.com/v1";
  // The two failures consistent with an endpoint we cannot see from here,
  // on an address inside the tenant's OWN verified domain.
  assert.equal(fieldAttestable("failed", "unreachable", mine, D), true);
  assert.equal(fieldAttestable("failed", "not_public", mine, D), true);
  // THE TWO BYPASSES BOTH REFUTERS FOUND, now closed by the domain binding:
  // (1) any non-resolving string would have been attestable, because
  // "unreachable" covers a DNS failure as well as a refused connection.
  assert.equal(
    fieldAttestable("failed", "unreachable", "https://not-a-real-company.example/", D),
    false
  );
  // (2) "not_public" covers a BARE PRIVATE IP LITERAL, which has no tenant
  // binding at all and is exactly what rung 2 refuses.
  assert.equal(fieldAttestable("failed", "not_public", "http://10.0.0.5:8080/", D), false);
  // A lookalike domain is not the tenant's domain.
  assert.equal(
    fieldAttestable("failed", "unreachable", "https://proxy.evilacme.com/", D),
    false
  );
  // A server ANSWERED and said the address is wrong: fix it, do not assert
  // it. This is the line that stops attestation swallowing every typo.
  assert.equal(fieldAttestable("failed", "http_status", mine, D), false);
  assert.equal(fieldAttestable("failed", "invalid", mine, D), false);
  assert.equal(fieldAttestable("failed", "self_host", mine, D), false);
  // A real check must have run and failed FIRST.
  assert.equal(fieldAttestable("unchecked", "unreachable", mine, D), false);
  assert.equal(fieldAttestable("ok", "unreachable", mine, D), false);
  assert.equal(fieldAttestable("attested", "unreachable", mine, D), false);
  // No domain, no rung 3.
  assert.equal(fieldAttestable("failed", "unreachable", mine, null), false);
});

ok("rung 2 host boundary: a lookalike domain never qualifies", () => {
  assert.equal(hostInDomain("proxy.acme.com", "acme.com"), true);
  assert.equal(hostInDomain("acme.com", "acme.com"), true);
  assert.equal(hostInDomain("ACME.COM", "acme.com"), true);
  assert.equal(hostInDomain("proxy.acme.com.", "acme.com"), true); // trailing dot
  assert.equal(hostInDomain("a.b.acme.com", "acme.com"), true);
  // The classic suffix bug: "evilacme.com".endsWith("acme.com") is true.
  assert.equal(hostInDomain("evilacme.com", "acme.com"), false);
  assert.equal(hostInDomain("acme.com.evil.net", "acme.com"), false);
  assert.equal(hostInDomain("notacme.com", "acme.com"), false);
  // A bare IP has no tenant binding at all, so it can never carry rung 2.
  assert.equal(hostInDomain("10.0.0.5", "acme.com"), false);
  assert.equal(hostInDomain("[::1]", "acme.com"), false);
  assert.equal(hostInDomain("proxy.acme.com", null), false);
});

ok("rung 2 evidence is a PRIVATE NETWORK, not merely a blocked address", () => {
  // These are where company infrastructure actually lives.
  for (const a of ["10.0.0.5", "172.16.9.9", "192.168.1.1", "100.64.0.1", "fd12::1", "::ffff:10.0.0.5"])
    assert.equal(isPrivateNetworkAddress(a), true, a);
  // These are blocked from connection but are NOT a plausible internal
  // deployment, so they must not stand as evidence: a probe of mine found
  // 169.254.169.254 earning rung 2 before this distinction existed.
  for (const a of ["169.254.169.254", "127.0.0.1", "0.0.0.0", "224.0.0.1", "fe80::1", "8.8.8.8"])
    assert.equal(isPrivateNetworkAddress(a), false, a);
  // Everything above that is not a private network is still refused a
  // connection by the blocklist.
  for (const a of ["169.254.169.254", "127.0.0.1", "0.0.0.0", "224.0.0.1", "fe80::1"])
    assert.equal(isBlockedAddress(a), true, a);
});

ok("every decided state carries its date, and only rung 1 says 'reached'", () => {
  const at = "2026-08-09T12:00:00.000Z";
  // These return a CheckLine, not a string, since 2026-08-26: the date is
  // carried as `iso` and rendered by <LocalTime> in the viewer's zone, so
  // asserting on formatted words here would only pin the TEST BOX's
  // timezone. Carrying the date is still the rule; `iso` is where it lives
  // now, and `words` is the sentence the reader actually sees around it.
  const words = (l: { before: string; after: string }) => l.before + l.after;
  const reached = reachedLine(200, at);
  assert.equal(reached.iso, at, words(reached));
  assert.ok(words(reached).includes("reached"), words(reached));
  const internal = internalLine(at);
  assert.equal(internal.iso, at, words(internal));
  assert.ok(!/reached/i.test(words(internal)), "rung 2 must not claim we reached it");
  assert.ok(words(internal).includes("never connect"), words(internal));
  const attested = attestedLine("admin@acme.com", at);
  assert.equal(attested.iso, at, words(attested));
  assert.ok(words(attested).includes("admin@acme.com"), words(attested));
  assert.ok(words(attested).includes("their word"), words(attested));
  assert.ok(!/reached it from here/i.test(words(attested).replace("could not reach it from here", "")), words(attested));
  // A junk timestamp must fall back to the dateless sentence rather than
  // reaching <LocalTime>, which throws a RangeError on an Invalid Date.
  assert.equal(reachedLine(200, "not-a-date").iso, null);
  assert.ok(reachedLine(200, "not-a-date").before.includes("We reached this address (HTTP 200)."));
  // No em dashes anywhere in this family (site rule).
  for (const line of [reached, internal, attested])
    assert.ok(!words(line).includes("\u2014"), words(line));
});

ok("the nightly re-check never touches an attested field", () => {
  // Source pin: a human claim does not go stale because a clock ticked,
  // and re-probing an address we know we cannot reach would just burn
  // requests. If this ever changes, the copy in platform-copy.ts has to
  // change with it.
  const src = readFileSync("src/lib/roadmap/db.ts", "utf8");
  const q = src.slice(src.indexOf("export async function linksDueForRecheck"));
  assert.ok(!q.includes("'attested'"), "recheck query must not select attested fields");
  for (const state of ["'ok'", "'internal'", "'failed'"])
    assert.ok(q.includes(state), `recheck query should select ${state}`);
});

ok("the Apollo importer stores only a mobile-typed number (Mobile column round)", () => {
  // The directory's phone field is the Mobile column (owner directive
  // 2026-08-29: "change the column to say Mobile instead of Phone"). Apollo
  // returns a person's numbers in no useful order and the first entry is
  // frequently the company switchboard; 12 staff rows carried the HQ line
  // as their "phone" that way. The mobile-typed entry wins wherever it sits.
  assert.equal(
    personPhone({
      phone_numbers: [
        { type: "work_hq", sanitized_number: "+18776995638" },
        { type: "work_direct", sanitized_number: "+18476860200" },
        { type: "mobile", sanitized_number: "+13125550142" },
      ],
    }),
    "+13125550142"
  );
  // sanitized_number wins over raw_number; raw_number is the fallback.
  assert.equal(
    personPhone({
      phone_numbers: [{ type: "mobile", sanitized_number: null, raw_number: "312-555-0142" }],
    }),
    "312-555-0142"
  );
  assert.equal(
    personPhone({ phone_numbers: [{ type: " Mobile ", sanitized_number: "+13125550142" }] }),
    "+13125550142"
  );
  // Only switchboard / untyped entries: NOTHING lands in the Mobile column.
  assert.equal(
    personPhone({
      phone_numbers: [
        { type: "work_hq", sanitized_number: "+18776995638" },
        { sanitized_number: "+18476860200" },
        { type: null, raw_number: "847-686-0200" },
      ],
    }),
    null
  );
  assert.equal(personPhone({ phone_numbers: [] }), null);
  assert.equal(personPhone({}), null);
  // A mobile-typed entry with no number at all is not a number either.
  assert.equal(
    personPhone({ phone_numbers: [{ type: "mobile", sanitized_number: "", raw_number: null }] }),
    null
  );
});

ok("the directory table labels the phone field Mobile", () => {
  // Source pin: the column header, the add-row placeholder and both
  // aria-labels say Mobile; the `phone` state/field names and the API
  // payloads are deliberately unchanged (no migration, no API change).
  const read = (p: string) => readFileSync(p, "utf8");
  const table = read("src/app/roadmap/(steps)/directory/directory-table.tsx");
  assert.ok(/<th[^>]*>\s*Mobile\s*<\/th>/.test(table), "Mobile column header");
  assert.ok(table.includes('placeholder="Mobile (optional)"'));
  assert.equal(table.split('aria-label="Mobile"').length - 1, 2, "two Mobile aria-labels");
  assert.ok(!table.includes(">Phone<"));
  assert.ok(!/<th[^>]*>\s*Phone\s*<\/th>/.test(table), "no Phone column header");
  assert.ok(!table.includes('aria-label="Phone"'));
  assert.ok(!table.includes('placeholder="Phone'));
  // The privacy sentence on the page says mobile number, both lanes, no em dash.
  const page = read("src/app/roadmap/(steps)/directory/page.tsx");
  assert.equal(page.split("Exactly name, email, and mobile").length - 1, 2);
  assert.ok(!page.includes("Exactly name, email, and phone"));
  assert.ok(!page.includes("\u2014"));
});

// ── §5.16/§5.18 exhibit credits on the Employee Scorecard (2026-08-29) ──
// Owner ruling: the hand-authored /work exhibits are page copy, not rows, so
// their builders were counted by nothing here. work_static_credits feeds a
// staff-lane-only Exhibits column.

ok("exhibit credits: the mapping is NEVER seeded in the repo (this repo is public)", () => {
  // THE privacy invariant of this feature, enforced mechanically rather than
  // by intent: the rows map a colleague's address to an exhibit, and every
  // committed file is world-readable and permanent in git history. The
  // migration must create structure only, and no committed file may seed it.
  const mig = readFileSync("drizzle/migrations/0052_work_static_credits.sql", "utf8");
  assert.ok(/create table if not exists "work_static_credits"/i.test(mig));
  // The STATEMENT shape, not the word: the migration's own warning paragraph
  // says "a seed INSERT here ... would publish those addresses", and a test
  // that fails on its own documentation trains people to delete the warning.
  assert.ok(
    !/^\s*insert\s+into/im.test(mig),
    "migration 0052 must contain no INSERT statement"
  );
  assert.ok(!mig.includes("@"), "migration 0052 must contain no email address");
  const schema = readFileSync("src/lib/db/schema.ts", "utf8");
  const block = schema.slice(
    schema.indexOf("export const workStaticCredits"),
    schema.indexOf("export const workUsage")
  );
  assert.ok(block.length > 0 && !block.includes("@"), "no address in the table definition");
});

ok("exhibit credits: staff lane only, honesty-guarded, separate from published", () => {
  const db2 = readFileSync("src/lib/roadmap/db.ts", "utf8");
  // No company_id on the table, so the lane gate is in the read itself.
  assert.ok(db2.includes("scope.companyId === null && STATIC_EXHIBIT_IDS.length > 0"),
    "the exhibit read runs only on the staff lane");
  // A credit for a retired exhibit must stop counting with no migration.
  assert.ok(db2.includes("inArray(WSC.anchorId, STATIC_EXHIBIT_IDS)"), "honesty guard");
  assert.ok(db2.includes("const STATIC_EXHIBIT_IDS: string[] = staticTitles.anchorIds"));
  // Never folded into `published`: that column feeds the company hero.
  assert.ok(!/published:\s*[^,\n]*exhibits/.test(db2), "exhibits never folded into published");
  // Every row-construction site sets it (three drains plus the exhibit-only
  // stray loop), or a credited person silently reads 0.
  assert.ok(db2.split(/exhibits:\s/).length - 1 >= 4, "every row site sets exhibits");
  assert.ok(db2.includes("b.exhibits - a.exhibits"), "sort ranks exhibits below published");
});

ok("exhibit credits: the column is staff-only and is not a CountCell", () => {
  const page = readFileSync("src/app/roadmap/(steps)/scorecard/page.tsx", "utf8");
  const staff = page.slice(page.indexOf("const STAFF_HEADERS"), page.indexOf("function HeaderRow"));
  const company = page.slice(page.indexOf("const COMPANY_HEADERS"), page.indexOf("const STAFF_HEADERS"));
  assert.ok(staff.includes('"Exhibits"'), "staff headers carry Exhibits");
  assert.ok(!company.includes('"Exhibits"'), "company headers must NOT carry Exhibits");
  // Inserted after Published, not appended: HeaderRow drops the right padding
  // by INDEX on the last column.
  assert.ok(staff.indexOf('"Exhibits"') < staff.indexOf('"Most recent"'));
  assert.ok(page.includes("showExhibits={false}"), "company lane passes it false");
  // A CountCell promises a click-through list and there is no exhibit list.
  assert.ok(!/CountCell[\s\S]{0,200}exhibits/.test(page), "not rendered as a CountCell");
  // The disclosure must say the credit is internal and how to get it removed.
  assert.ok(page.includes("no exhibit on the public page names its builder"));
  assert.ok(page.includes("Ask an administrator to change or remove your exhibit credit"));
  assert.ok(!page.includes("\u2014"), "no em dash in scorecard copy");
});

ok("exhibit credits: the write path validates the anchor at the write edge", () => {
  // A mistyped section id fails CLOSED and SILENTLY: the reader filters
  // credits against the generated anchor list, so a bad id is
  // indistinguishable from a retired exhibit and the colleague still reads 0,
  // which is the exact bug the table exists to fix.
  const ops = readFileSync("scripts/lib/work-credit-ops.ts", "utf8");
  assert.ok(ops.includes("validAnchors.includes(anchorId)"), "anchor validated at the write edge");
  assert.ok(/normalizeCreditEmail|toLowerCase\(\)/.test(ops), "address lowercased to agree with the index");
  assert.ok(ops.includes("needs --by"), "both verbs record who did it");
  // The script must be VM-only and must not carry a plan file in the repo.
  const script = readFileSync("scripts/work-credit.ts", "utf8");
  assert.ok(script.includes("RUNS ON THE PROD VM ONLY"));
  assert.ok(script.includes("on conflict (anchor_id, lower(email))"), "add is an upsert on the real index");
  assert.ok(!/[—–]/.test(script) && !/[—–]/.test(ops), "no em or en dashes");
  // package.json exposes it.
  assert.ok(readFileSync("package.json", "utf8").includes('"work:credit"'));
});

ok("exhibit credits: a suppressed address is never re-surfaced by the credit drain", () => {
  // Directory removal keeps only sha256(lower(email)) and hard-DELETEs the
  // row so the person stops being named. The exhibit-only drain is the one
  // path that could print their literal address back to every colleague.
  const db2 = readFileSync("src/lib/roadmap/db.ts", "utf8");
  const drain = db2.slice(db2.indexOf("Anyone credited with an exhibit who reached none"));
  assert.ok(drain.includes("suppressedHashes(scope)"), "the credit drain consults the suppression list");
  assert.ok(drain.includes("if (suppressed.has(sha256Hex(email))) continue;"));
});

ok("exhibit credits: one switch decides the column set", () => {
  // Two independent switches (a headers array and a boolean) could disagree
  // and render eight headers over seven cells.
  const page = readFileSync("src/app/roadmap/(steps)/scorecard/page.tsx", "utf8");
  assert.ok(page.includes("function HeaderRow({ showExhibits }"), "HeaderRow takes the same boolean");
  assert.ok(page.includes("const headers = showExhibits ? STAFF_HEADERS : COMPANY_HEADERS"));
  assert.ok(!page.includes("headers={STAFF_HEADERS}"), "no second switch at the call site");
});

ok("exhibit credits: the published-only doctrine is untouched", () => {
  // Time saved must still share the Published predicate exactly: a nonzero
  // time-saved cell beside a 0 published would announce a held or failed row.
  const db2 = readFileSync("src/lib/roadmap/db.ts", "utf8");
  const agg = db2.slice(db2.indexOf("timeSaved: sql<number>"), db2.indexOf(".groupBy(", db2.indexOf("timeSaved: sql<number>")));
  assert.ok(agg.includes('eq(W.status, "published")') || db2.includes('eq(W.status, "published")'));
  // The company disclosure is client-visible copy about a feature that lane
  // does not have, and must not have moved.
  const page = readFileSync("src/app/roadmap/(steps)/scorecard/page.tsx", "utf8");
  assert.ok(page.includes("This scorecard counts published AI work submissions for each person in "),
    "company disclosure unchanged");
  // The PUBLIC /work sentence describes the CLIENT scorecard and stays true.
  const work = readFileSync("src/app/work/page.tsx", "utf8");
  assert.ok(work.includes("The scorecard counts published cards only"),
    "public copy describes the client lane and needs no change");
});

console.log(`\nroadmap-tests (incl. dkim): ${passed} checks passed`);
