#!/usr/bin/env -S npx tsx
// Runtime exercise of the §5.16 update state machine against a REAL DB
// (dev box; migration 0033 applied). Creates throwaway ZZTEST rows, walks
// the swap, rollback, conflict-park, and delete-guard transactions, asserts
// every invariant, and cleans up. Run: npm run test:workupdate (needs
// DATABASE_URL; not part of the pure test:work suite).
import "./lib/governance-env";
import assert from "node:assert";
import { db, schema } from "../src/lib/db";
import { eq, like } from "drizzle-orm";
import {
  activeTitleClash,
  activeUpdateChild,
  isUniqueViolation,
  createSubmission,
  finishPendingApproval,
  publishWithSupersede,
  publishedTitleClash,
  publishedTitleAndFacetSets,
  resolveUpdateTarget,
  rollbackSwappedUpdate,
  submissionById,
  latestPublishedAt,
} from "../src/lib/work/db";
import type { WorkCard } from "../src/lib/work/lint";

const S = schema.workSubmissions;
const TITLE = "ZZTEST Update Flow Probe";

const card = (title: string): WorkCard => ({
  title,
  categoryBadge: "Internal tool",
  summary: "s",
  body: ["b"],
  facets: [
    { label: "ZZTEST facet one", text: "t" },
    { label: "ZZTEST facet two", text: "t" },
    { label: "ZZTEST facet three", text: "t" },
  ],
  footerLine: ["zztest"],
});

async function cleanup() {
  await db.delete(S).where(like(S.title, "ZZTEST%"));
}

async function mkRow(over: Record<string, unknown> = {}) {
  const row = await createSubmission({
    userId: null,
    email: "zztest@xl.net",
    name: null,
    kind: "program",
    title: TITLE,
    blurb: "b".repeat(100),
    architectureText: "arch",
    skillMdText: null,
    fileManifestJson: "[]",
    corpusFilesJson: JSON.stringify([{ path: "architecture.md", text: "x" }]),
    archiveName: "z.zip",
    archiveSha256: "0".repeat(64),
    archiveBytes: 10,
    archiveData: Buffer.from("PK"),
    ...(over as object),
  });
  return row;
}

async function main() {
  await cleanup();

  // 1. A published parent.
  const parent = await mkRow();
  await db
    .update(S)
    .set({
      status: "published",
      slug: "team-zztest-update-flow-probe",
      publishedAt: new Date("2026-01-02T00:00:00Z"),
      cardJson: JSON.stringify(card(TITLE)),
      panelAttemptId: "seed",
    })
    .where(eq(S.id, parent.id));

  // resolveUpdateTarget: by title, by slug, by slug minus team-.
  assert.equal((await resolveUpdateTarget(TITLE))?.id, parent.id, "by title");
  assert.equal(
    (await resolveUpdateTarget("  zztest  update   flow probe "))?.id,
    parent.id,
    "normalized title"
  );
  assert.equal(
    (await resolveUpdateTarget("team-zztest-update-flow-probe"))?.id,
    parent.id,
    "by slug"
  );
  assert.equal(
    (await resolveUpdateTarget("zztest-update-flow-probe"))?.id,
    parent.id,
    "by slug minus team-"
  );
  assert.equal(await resolveUpdateTarget("ZZTEST no such card"), null);

  // publishedTitleClash exceptId carve-out.
  assert.equal(await publishedTitleClash(TITLE), true);
  assert.equal(
    await publishedTitleClash(TITLE, { exceptId: parent.id }),
    false,
    "exceptId excludes the predecessor"
  );

  // excludeId keeps the pinned title/facets out of the panel sets.
  const withSets = await publishedTitleAndFacetSets();
  assert.ok(withSets.publishedTitles.includes(TITLE.toLowerCase()));
  const exSets = await publishedTitleAndFacetSets(parent.id);
  assert.ok(!exSets.publishedTitles.includes(TITLE.toLowerCase()));
  assert.ok(!exSets.publishedFacetLabels.includes("zztest facet one"));

  // 2. An update child, panel-passed -> pending_approval.
  const child = await mkRow({ parentId: parent.id });
  assert.equal(child.parentId, parent.id, "parentId persisted");
  // The pinned title trips the active-title guard for a SECOND update.
  assert.ok(await activeTitleClash(TITLE), "in-flight update occupies the title");
  await db
    .update(S)
    .set({ status: "running", panelAttemptId: "att1" })
    .where(eq(S.id, child.id));
  assert.ok(
    await finishPendingApproval(child.id, "att1", card(TITLE), "[]"),
    "finishPendingApproval lands"
  );
  let c = await submissionById(child.id);
  assert.equal(c?.status, "pending_approval");
  assert.equal(c?.slug, null, "no slug before the swap");
  assert.equal(c?.heldAt, null, "heldAt untouched by pending_approval");
  // pending_approval still occupies the one-in-flight slot (index + clash).
  assert.ok(await activeTitleClash(TITLE), "pending_approval occupies the title");
  let dupCaught: unknown = null;
  try {
    await mkRow({ parentId: parent.id });
  } catch (e) {
    dupCaught = e;
  }
  assert.ok(
    isUniqueViolation(
      dupCaught,
      "work_sub_active_title_uq",
      "work_sub_parent_active_uq"
    ),
    "second in-flight update violates a unique index (via cause chain)"
  );

  // 3. Parent delete guard sees the pending child.
  assert.ok(await activeUpdateChild(parent.id), "delete guard sees pending child");

  // 4. The swap.
  const swapped = await publishWithSupersede(child.id);
  assert.ok(swapped.ok, "swap succeeds");
  if (swapped.ok) {
    assert.equal(swapped.slug, "team-zztest-update-flow-probe", "slug inherited");
    const p2 = await submissionById(parent.id);
    const c2 = await submissionById(child.id);
    assert.equal(p2?.status, "superseded");
    assert.equal(p2?.slug, null, "parent slug freed");
    assert.ok(p2?.supersededAt, "supersededAt stamped");
    assert.equal(c2?.status, "published");
    assert.equal(c2?.slug, "team-zztest-update-flow-probe");
    assert.equal(
      c2?.publishedAt?.toISOString(),
      "2026-01-02T00:00:00.000Z",
      "publishedAt inherited (position preserved)"
    );
    // Sitemap lastmod moves with the swap even though publishedAt is old.
    const last = await latestPublishedAt();
    assert.ok(
      last && Date.now() - new Date(last).getTime() < 60_000,
      "latestPublishedAt reflects the swap via updated_at"
    );
  }

  // 5. Double-approve is idempotent-refused.
  const again = await publishWithSupersede(child.id);
  assert.ok(!again.ok && again.reason === "not_eligible", "second approve refused");

  // 6. Rollback restores the parent.
  const rolled = await rollbackSwappedUpdate(child.id);
  assert.ok(rolled.ok, "rollback succeeds");
  if (rolled.ok) {
    const p3 = await submissionById(parent.id);
    assert.equal(p3?.status, "published");
    assert.equal(p3?.slug, "team-zztest-update-flow-probe", "slug restored");
    assert.equal(p3?.supersededAt, null, "supersededAt cleared");
    assert.equal(await submissionById(child.id), null, "child deleted");
  }

  // 7. Conflict-park: an update whose parent is no longer published.
  // NOTE: pulling the parent to HELD while a child is in flight is
  // structurally blocked by the recreated active-title index (both rows
  // would occupy the title's active slot), so the conflict is simulated the
  // one way it remains reachable: the parent already superseded (a rival
  // swap) with its slug freed.
  const child2 = await mkRow({ parentId: parent.id });
  await db
    .update(S)
    .set({
      status: "pending_approval",
      cardJson: JSON.stringify(card(TITLE)),
      panelAttemptId: "att2",
    })
    .where(eq(S.id, child2.id));
  await db
    .update(S)
    .set({ status: "superseded", slug: null })
    .where(eq(S.id, parent.id));
  const conflicted = await publishWithSupersede(child2.id);
  assert.ok(!conflicted.ok && conflicted.reason === "conflict", "conflict detected");
  const c3 = await submissionById(child2.id);
  assert.equal(c3?.status, "held", "conflict parks the child held");
  assert.ok(c3?.heldAt, "conflict-park stamps heldAt");
  assert.ok(
    c3?.panelError?.includes("update approval conflict"),
    "conflict note stored"
  );
  assert.notEqual(c3?.status, "published", "NEVER publishes standalone");

  // 8. failed child still blocks parent delete (refutation F1).
  await db.update(S).set({ status: "failed" }).where(eq(S.id, child2.id));
  assert.ok(await activeUpdateChild(parent.id), "failed child blocks parent delete");

  await cleanup();
  console.log("update-flow-test: all assertions passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
