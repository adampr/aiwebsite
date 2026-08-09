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
import { rateLimitedMessage, retryAfterPhrase } from "../src/lib/retry-after";
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

// ---- §5.19 step-list invariants (eight-step round) ----
ok("ROADMAP_STEPS is the eight-step list, numbered in order", () => {
  assert.equal(ROADMAP_STEPS.length, 8);
  assert.deepEqual(
    ROADMAP_STEPS.map((s) => s.num),
    ["01", "02", "03", "04", "05", "06", "07", "08"]
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
  assert.equal(STAFF_STEP_HREFS.governance, "/governance");
  // Staff parity round: the REAL staff directory, no longer the scorecard
  // alias.
  assert.equal(STAFF_STEP_HREFS.directory, "/roadmap/directory");
  assert.equal(STAFF_STEP_HREFS.workshop, "/builders#workshop");
  assert.equal(STAFF_STEP_HREFS.cohort, "/builders#cohort");
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
  // Staff governance is the constant-done public-offering ruling.
  assert.ok(
    read("src/lib/roadmap/status.ts").includes("governance: { done: true }")
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
  assert.ok(!/const \[people, counts, requests\][\s\S]{0,120}listPeople\(scope\)/.test(db2));
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

console.log(`\nroadmap-tests (incl. dkim): ${passed} checks passed`);
