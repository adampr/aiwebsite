// Tests for the §5.16 attribution lane (scripts/work-attribute.ts +
// scripts/lib/work-attribute-ops.ts): argument parsing, the name rule, the
// card link, and a SOURCE PIN of the promises the script's header makes
// about what it writes and what it refuses to do.
//
// NO DATABASE, no brain, no network: everything here is pure, and the one
// DB-backed import (isUuid, via work/db.ts) rides the module's lazy drizzle
// proxy and is never asked to connect. Run: npm run test:workattribute.
//
// NO EM DASHES in any of the three files, asserted below (site rule).

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ATTRIBUTE_USAGE,
  creditLink,
  laneLabel,
  parseAttributeArgs,
} from "./lib/work-attribute-ops";

const HERE = dirname(fileURLToPath(import.meta.url));
const ID = "878d70e4-1111-4222-8333-444455556666";

function ok(argv: string[]) {
  const r = parseAttributeArgs(argv);
  assert.ok(r.ok, `expected ${JSON.stringify(argv)} to parse: ${r.ok ? "" : r.message}`);
  return r as Extract<typeof r, { ok: true }>;
}

function refused(argv: string[], match: RegExp) {
  const r = parseAttributeArgs(argv);
  assert.ok(!r.ok, `expected ${JSON.stringify(argv)} to be refused`);
  if (!r.ok) assert.match(r.message, match);
}

function main(): void {
  // ---- argument parsing ----
  {
    const a = ok([ID, "Ken"]);
    assert.equal(a.id, ID);
    assert.equal(a.name, "Ken");
    assert.equal(a.clear, false);
    assert.equal(a.yes, false);

    const b = ok([ID, "Ken", "--yes"]);
    assert.equal(b.yes, true);
    // Flags may lead: the operator types them where they think of them.
    assert.deepEqual(ok(["--yes", ID, "Ken"]), b);

    const c = ok([ID, "--clear"]);
    assert.equal(c.name, null);
    assert.equal(c.clear, true);
    const d = ok([ID, "--clear", "--yes"]);
    assert.equal(d.clear, true);
    assert.equal(d.yes, true);
  }

  // The uuid is required, and it is the FIRST positional.
  refused([], /uuid is required/);
  refused(["--clear"], /uuid is required/);
  refused(["not-a-uuid", "Ken"], /is not a submission uuid/);

  // Name XOR --clear: never both, never neither.
  refused([ID], /--clear/);
  refused([ID, "Ken", "--clear"], /not both/);

  // Unknown and repeated flags are refusals, not silent tolerance.
  refused([ID, "Ken", "--force"], /unknown flag --force/);
  refused([ID, "Ken", "--attribution"], /unknown flag --attribution/);
  refused([ID, "--clear", "--clear"], /--clear given twice/);
  refused([ID, "Ken", "--yes", "--yes"], /--yes given twice/);
  refused([ID, "Ken", "Castellano"], /unexpected extra argument "Castellano"/);

  // ---- the name rule, which is parseAttribution's (the route's own) ----
  assert.equal(ok([ID, "Ken"]).name, "Ken");
  assert.equal(ok([ID, "O'Brien"]).name, "O'Brien");
  assert.equal(ok([ID, "Jean-Luc"]).name, "Jean-Luc");
  assert.equal(ok([ID, " Ken "]).name, "Ken", "the name is trimmed");
  refused([ID, "K"], /single first name/); // 1 char
  refused([ID, "Ken Castellano"], /single first name/); // a space is two names
  refused([ID, "Pat@example.com"], /single first name/);
  refused([ID, "Ken3"], /single first name/);
  refused([ID, "Kenneth-Alexander-Maximilian"], /single first name/); // over 20
  refused([ID, ""], /--clear/); // an empty argument is not a clear gesture

  // ---- the card link ----
  assert.equal(creditLink(null, "team-ticket-reply-composer"), "/work#team-ticket-reply-composer");
  assert.equal(creditLink("c-1", "team-x"), "/roadmap/work#team-x");
  assert.equal(creditLink(null, null), null, "an unpublished row has no card to link");
  assert.match(laneLabel(null), /public \/work/);
  assert.match(laneLabel("c-1"), /company lane/);
  assert.match(ATTRIBUTE_USAGE, /npm run work:attribute -- <uuid> <FirstName>/);
  assert.match(ATTRIBUTE_USAGE, /--clear/);

  // ---- source pins: the promises the header makes ----
  const scriptSrc = readFileSync(resolve(HERE, "work-attribute.ts"), "utf8");
  const opsSrc = readFileSync(resolve(HERE, "lib", "work-attribute-ops.ts"), "utf8");
  const testSrc = readFileSync(resolve(HERE, "work-attribute-tests.ts"), "utf8");

  for (const [name, src] of [
    ["work-attribute.ts", scriptSrc],
    ["work-attribute-ops.ts", opsSrc],
    ["work-attribute-tests.ts", testSrc],
  ] as [string, string][])
    assert.ok(!/[\u2013\u2014]/.test(src), `${name} contains an em or en dash`);

  assert.ok(
    /process\.getuid\(\) === 0/.test(scriptSrc) &&
      /Refusing to run as root: npx tsx caches inside the deploy user's checkout/.test(
        scriptSrc
      ),
    "the euid-0 refusal, with work:reclassify's reason verbatim"
  );

  // ONE column and ONE row: no owner move, no card copy, no title, no slug,
  // no ranking, no publish stamp, and NOT updated_at (the retention timer;
  // refutation MAJOR 2026-08-29, same call as work:reclassify).
  assert.ok(
    /\.set\(\s*\{\s*submitterName:\s*args\.name\s*\}\s*\)/.test(scriptSrc),
    "the update writes submitter_name and nothing else"
  );
  assert.ok(!/updatedAt/.test(scriptSrc), "updated_at is never bumped (retention timer)");
  // A superseded parent is refused and the live descendant is named.
  assert.ok(
    /row\.status === "superseded"/.test(scriptSrc) &&
      /liveDescendantId\(row\.id\)/.test(scriptSrc),
    "a superseded row is refused, naming the live descendant"
  );
  assert.ok(/main\(\)\.catch\(/.test(scriptSrc), "a thrown error prints one line, not a stack");
  assert.ok(
    /at that person's own request/.test(scriptSrc),
    "the confirm prompt states the consent rule"
  );
  for (const forbidden of [
    "submitterEmail:",
    "creatorEmail:",
    "cardJson:",
    "slug:",
    "displayRank:",
    "publishedAt:",
    "status:",
  ])
    assert.ok(
      !scriptSrc.includes(forbidden),
      `the update must never set ${forbidden}`
    );

  // No email, no panel run: the two side effects a byline change must not have.
  for (const forbidden of ["notify", "kickPanel", "runPanel", "resend", "Resend"])
    assert.ok(
      !new RegExp(`\\b${forbidden}\\w*\\(`).test(scriptSrc),
      `this lane must never call ${forbidden}`
    );

  // The confirm prompt sits ahead of the write, and --yes is the only skip.
  {
    const prompt = scriptSrc.indexOf("rl.question(");
    const write = scriptSrc.search(/\.update\(\s*S\s*\)/);
    assert.ok(prompt > 0 && write > prompt, "the confirm prompt is ahead of the update");
    assert.ok(/if \(!args\.yes\)/.test(scriptSrc), "--yes is what skips it");
  }

  // The revalidate is public-lane only and best effort: it must sit AFTER the
  // write and inside a try/catch, so a dead loopback never loses the credit.
  {
    const write = scriptSrc.search(/\.update\(\s*S\s*\)/);
    const reval = scriptSrc.indexOf("await revalidateWorkPage()");
    assert.ok(reval > write, "the revalidate runs after the write");
    assert.ok(
      /if \(row\.companyId === null\) \{\s*try \{\s*await revalidateWorkPage\(\);/.test(
        scriptSrc
      ),
      "public-lane only, and wrapped in try/catch (best effort)"
    );
  }

  // The name rule is imported, never restated: a second copy of the regex is
  // how the script and the route drift apart.
  assert.ok(
    /import \{ parseAttribution \} from "\.\/work-submit-ops"/.test(opsSrc),
    "the name rule comes from work-submit-ops.ts"
  );
  assert.ok(
    !/A-Za-z'-\]\{1,19\}/.test(opsSrc) && !/A-Za-z'-\]\{1,19\}/.test(scriptSrc),
    "neither file restates the name regex"
  );

  console.log("work-attribute-tests: all assertions passed.");
}

main();