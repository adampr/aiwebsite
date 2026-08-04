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
import { emailDomain } from "../src/lib/rfp/access";
import { INTERNAL_SCOPE, scopeOf } from "../src/lib/work/scope";

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

// ---- scope plumbing ----
ok("scopeOf maps company_id to the scope axis", () => {
  assert.deepEqual(scopeOf({ companyId: null }), INTERNAL_SCOPE);
  assert.deepEqual(scopeOf({ companyId: "abc" }), { companyId: "abc" });
});

console.log(`\nroadmap-tests: ${passed} checks passed`);
