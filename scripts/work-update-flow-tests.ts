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
  canProposeUpdate,
  isUniqueViolation,
  createSubmission,
  deleteSubmission,
  finishPendingApproval,
  finishUpdateRow,
  holdPublishedForRerun,
  liveDescendantId,
  publishWithSupersede,
  publishedCards,
  reorderPublishedCard,
  publishedTitleClash,
  publishedTitleAndFacetSets,
  resolveUpdateTarget,
  rollbackSwappedUpdate,
  submissionById,
  latestPublishedAt,
  updateChainEmails,
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
  // After the rows: the company FK is RESTRICT (§5.18).
  await db
    .delete(schema.companies)
    .where(eq(schema.companies.domain, "zztest-reorder.example"));
}

async function mkRow(over: Record<string, unknown> = {}) {
  const row = await createSubmission({
    companyId: null,
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
  assert.equal((await resolveUpdateTarget(TITLE, { companyId: null }))?.id, parent.id, "by title");
  assert.equal(
    (await resolveUpdateTarget("  zztest  update   flow probe ", { companyId: null }))?.id,
    parent.id,
    "normalized title"
  );
  assert.equal(
    (await resolveUpdateTarget("team-zztest-update-flow-probe", { companyId: null }))?.id,
    parent.id,
    "by slug"
  );
  assert.equal(
    (await resolveUpdateTarget("zztest-update-flow-probe", { companyId: null }))?.id,
    parent.id,
    "by slug minus team-"
  );
  assert.equal(await resolveUpdateTarget("ZZTEST no such card", { companyId: null }), null);

  // publishedTitleClash exceptId carve-out.
  assert.equal(await publishedTitleClash(TITLE, { companyId: null }), true);
  assert.equal(
    await publishedTitleClash(TITLE, { companyId: null }, { exceptId: parent.id }),
    false,
    "exceptId excludes the predecessor"
  );

  // excludeId keeps the pinned title/facets out of the panel sets.
  const withSets = await publishedTitleAndFacetSets({ companyId: null });
  assert.ok(withSets.publishedTitles.includes(TITLE.toLowerCase()));
  const exSets = await publishedTitleAndFacetSets({ companyId: null }, parent.id);
  assert.ok(!exSets.publishedTitles.includes(TITLE.toLowerCase()));
  assert.ok(!exSets.publishedFacetLabels.includes("zztest facet one"));

  // 2. An update child, panel-passed -> pending_approval. Submitted by a
  // DIFFERENT teammate: chain ownership (2026-08-04) is exercised below.
  const child = await mkRow({
    parentId: parent.id,
    email: "zztest-updater@xl.net",
  });
  assert.equal(child.parentId, parent.id, "parentId persisted");
  // The pinned title trips the active-title guard for a SECOND update.
  assert.ok(await activeTitleClash(TITLE, { companyId: null }), "in-flight update occupies the title");
  await db
    .update(S)
    .set({ status: "running", panelAttemptId: "att1" })
    .where(eq(S.id, child.id));
  assert.ok(
    await finishPendingApproval(child.id, "att1", card(TITLE), "[]"),
    "finishPendingApproval lands"
  );
  const c = await submissionById(child.id);
  assert.equal(c?.status, "pending_approval");
  assert.equal(c?.slug, null, "no slug before the swap");
  assert.equal(c?.heldAt, null, "heldAt untouched by pending_approval");
  // pending_approval still occupies the one-in-flight slot (index + clash).
  assert.ok(await activeTitleClash(TITLE, { companyId: null }), "pending_approval occupies the title");
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

  // 5b. Chain ownership (2026-08-04): the swap made the UPDATER's row the
  // published one; the original author must keep the right to update.
  const tip = await submissionById(child.id);
  assert.ok(tip, "swapped child readable");
  if (tip) {
    const chain = await updateChainEmails(tip);
    assert.ok(chain.has("zztest@xl.net"), "chain reaches the original author");
    assert.ok(chain.has("zztest-updater@xl.net"), "chain includes the tip");
    assert.equal(
      await canProposeUpdate(tip, "ZZTEST@XL.NET", false),
      true,
      "original author may update the swapped-in version (case-insensitive)"
    );
    assert.equal(
      await canProposeUpdate(tip, "zztest-stranger@xl.net", false),
      false,
      "a stranger may not"
    );
    assert.equal(
      await canProposeUpdate(tip, "zztest-stranger@xl.net", true),
      true,
      "an admin always may"
    );
  }
  assert.equal(
    await liveDescendantId(parent.id),
    child.id,
    "superseded parent resolves its live version"
  );
  assert.equal(
    await liveDescendantId(child.id),
    null,
    "the published tip has no live descendant"
  );

  // 5c. Second-generation update: the swapped-in child is itself updatable
  // (the "update it once and the option is gone" report, 2026-08-04).
  const grand = await mkRow({
    parentId: child.id,
    email: "zztest-author3@xl.net",
  });
  await db
    .update(S)
    .set({ status: "running", panelAttemptId: "attg" })
    .where(eq(S.id, grand.id));
  assert.ok(
    await finishPendingApproval(grand.id, "attg", card(TITLE), "[]"),
    "grandchild parks pending_approval"
  );
  const swapped2 = await publishWithSupersede(grand.id);
  assert.ok(swapped2.ok, "second-generation swap succeeds");
  if (swapped2.ok) {
    assert.equal(swapped2.slug, "team-zztest-update-flow-probe", "slug carried again");
    const g = await submissionById(grand.id);
    const c4 = await submissionById(child.id);
    assert.equal(g?.status, "published");
    assert.equal(c4?.status, "superseded");
    if (g) {
      const chain2 = await updateChainEmails(g);
      assert.ok(
        chain2.has("zztest@xl.net") && chain2.has("zztest-updater@xl.net"),
        "two-hop chain reaches every prior submitter"
      );
    }
    assert.equal(
      await liveDescendantId(parent.id),
      grand.id,
      "live-descendant walk crosses generations"
    );
  }
  // Roll the grandchild back so step 6 exercises the original single-hop
  // rollback exactly as before.
  const rolledGrand = await rollbackSwappedUpdate(grand.id);
  assert.ok(rolledGrand.ok, "grandchild rollback succeeds");
  assert.equal(
    (await submissionById(child.id))?.status,
    "published",
    "child restored by grandchild rollback"
  );

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

  // ── §5.16 admin web auto-approve (migration 0034) ──────────────────
  // The first ADMIN_EMAIL entry is what isAdmin() accepts; the auto gate
  // re-checks it at finish time.
  assert.ok(
    process.env.ADMIN_EMAIL,
    "ADMIN_EMAIL must be set (isAdmin() reads it; without it the auto-lane cases fail confusingly downstream)"
  );
  const ADMIN = (process.env.ADMIN_EMAIL ?? "adam@xl.net")
    .split(",")[0]
    .trim();
  await cleanup();

  // 9. createSubmission refuses the flag on a non-update row (the email-
  // lane leak guard, layer 1).
  let flagCaught: unknown = null;
  try {
    await mkRow({ autoApprove: true });
  } catch (e) {
    flagCaught = e;
  }
  assert.ok(
    flagCaught instanceof Error &&
      flagCaught.message.includes("parentId required"),
    "autoApprove without parentId throws"
  );

  // 10. The DB CHECK refuses it too (layer 2: survives any refactor of
  // createSubmission).
  const plain = await mkRow();
  let ckCaught: unknown = null;
  try {
    await db
      .update(S)
      .set({ autoApprove: true })
      .where(eq(S.id, plain.id));
  } catch (e) {
    ckCaught = e;
  }
  assert.ok(
    isUniqueViolation(ckCaught, "work_sub_auto_approve_parent_ck") ||
      (ckCaught instanceof Error &&
        `${ckCaught.message} ${(ckCaught.cause as Error | undefined)?.message ?? ""}`.includes(
          "work_sub_auto_approve_parent_ck"
        )),
    "CHECK constraint blocks auto_approve on a non-update row"
  );

  // 11. An email-lane-shaped update row defaults to autoApprove false.
  await db
    .update(S)
    .set({
      status: "published",
      slug: "team-zztest-update-flow-probe",
      publishedAt: new Date("2026-01-02T00:00:00Z"),
      cardJson: JSON.stringify(card(TITLE)),
      panelAttemptId: "seed",
    })
    .where(eq(S.id, plain.id));
  const emailish = await mkRow({ parentId: plain.id });
  assert.equal(emailish.autoApprove, false, "flag never defaults on");

  // 12. Non-auto update parks (unchanged behavior through the new helper).
  await db
    .update(S)
    .set({ status: "running", panelAttemptId: "att3" })
    .where(eq(S.id, emailish.id));
  const parkFin = await finishUpdateRow(emailish.id, "att3", card(TITLE), "[]");
  assert.equal(parkFin.outcome, "parked", "non-auto row parks");
  assert.equal(
    (await submissionById(emailish.id))?.status,
    "pending_approval"
  );
  await deleteSubmission(emailish.id);

  // 13. Auto + admin submitter: finishUpdateRow swaps in one pass.
  const auto1 = await mkRow({
    parentId: plain.id,
    email: ADMIN,
    autoApprove: true,
  });
  assert.equal(auto1.autoApprove, true, "flag persisted");
  await db
    .update(S)
    .set({ status: "running", panelAttemptId: "att4" })
    .where(eq(S.id, auto1.id));
  const swapFin = await finishUpdateRow(auto1.id, "att4", card(TITLE), "[]");
  assert.equal(swapFin.outcome, "swapped", "auto row swaps on pass");
  if (swapFin.outcome === "swapped") {
    assert.equal(swapFin.slug, "team-zztest-update-flow-probe");
    assert.equal(swapFin.parent.id, plain.id, "parent returned for notify");
  }
  assert.equal((await submissionById(auto1.id))?.status, "published");
  assert.equal((await submissionById(plain.id))?.status, "superseded");
  // Roll back to reuse the parent for the remaining cases.
  assert.ok((await rollbackSwappedUpdate(auto1.id)).ok, "rollback auto swap");

  // 14. Fencing: a stale attempt stops at the park and NEVER swaps, even
  // with autoApprove true (zombie-run containment).
  const auto2 = await mkRow({
    parentId: plain.id,
    email: ADMIN,
    autoApprove: true,
  });
  await db
    .update(S)
    .set({ status: "running", panelAttemptId: "att5-current" })
    .where(eq(S.id, auto2.id));
  const staleFin = await finishUpdateRow(
    auto2.id,
    "att5-stale",
    card(TITLE),
    "[]"
  );
  assert.equal(staleFin.outcome, "superseded_claim", "stale attempt fenced");
  assert.equal(
    (await submissionById(auto2.id))?.status,
    "running",
    "row untouched by the stale attempt"
  );

  // 15. The swap primitive itself refuses a wrong fence and a non-auto row.
  await db
    .update(S)
    .set({
      status: "pending_approval",
      cardJson: JSON.stringify(card(TITLE)),
    })
    .where(eq(S.id, auto2.id));
  const wrongFence = await publishWithSupersede(auto2.id, "att5-stale");
  assert.ok(
    !wrongFence.ok && wrongFence.reason === "not_eligible",
    "fenced swap refuses a non-owning attempt"
  );
  await db
    .update(S)
    .set({ autoApprove: false })
    .where(eq(S.id, auto2.id));
  const notAuto = await publishWithSupersede(auto2.id, "att5-current");
  assert.ok(
    !notAuto.ok && notAuto.reason === "not_eligible",
    "fenced swap refuses a row not stamped autoApprove"
  );
  await db
    .update(S)
    .set({ autoApprove: true })
    .where(eq(S.id, auto2.id));

  // 16. Admin re-check: de-listed submitter parks instead of swapping.
  await db
    .update(S)
    .set({
      status: "running",
      panelAttemptId: "att6",
      submitterEmail: "zztest-not-admin@xl.net",
    })
    .where(eq(S.id, auto2.id));
  const deListed = await finishUpdateRow(auto2.id, "att6", card(TITLE), "[]");
  assert.equal(deListed.outcome, "parked", "non-admin submitter parks");
  assert.equal(
    (await submissionById(auto2.id))?.status,
    "pending_approval",
    "parked, not published"
  );

  // 17. heldAt one-shot: a once-held auto row parks for the click.
  await db
    .update(S)
    .set({
      status: "running",
      panelAttemptId: "att7",
      submitterEmail: ADMIN,
      heldAt: new Date("2026-01-03T00:00:00Z"),
    })
    .where(eq(S.id, auto2.id));
  const onceHeld = await finishUpdateRow(auto2.id, "att7", card(TITLE), "[]");
  assert.equal(onceHeld.outcome, "parked", "once-held auto row parks");
  assert.equal(
    (await submissionById(auto2.id))?.status,
    "pending_approval",
    "held history forces the click"
  );

  // 18. Conflict through the helper: target gone -> held + note + heldAt
  // stamped (the auto lane inherits the manual lane's conflict park).
  await db
    .update(S)
    .set({ status: "running", panelAttemptId: "att8", heldAt: null })
    .where(eq(S.id, auto2.id));
  await db
    .update(S)
    .set({ status: "superseded", slug: null })
    .where(eq(S.id, plain.id));
  const conflictFin = await finishUpdateRow(
    auto2.id,
    "att8",
    card(TITLE),
    "[]"
  );
  assert.equal(conflictFin.outcome, "conflict", "conflict surfaces");
  const cf = await submissionById(auto2.id);
  assert.equal(cf?.status, "held", "conflict parks held");
  assert.ok(
    cf?.panelError?.includes("update approval conflict"),
    "conflict note stored for the auto lane too"
  );
  assert.ok(cf?.heldAt, "conflict park stamps heldAt (one-shot from now on)");

  // 19. deleteSubmission expectStatus: a stale observer cannot delete a row
  // that changed state under them.
  assert.equal(
    await deleteSubmission(auto2.id, { expectStatus: "pending_approval" }),
    null,
    "stale-status delete refused"
  );
  assert.ok(
    await submissionById(auto2.id),
    "row survives the refused delete"
  );
  assert.ok(
    await deleteSubmission(auto2.id, { expectStatus: "held" }),
    "matching-status delete proceeds"
  );

  // 20. Crash recovery: an auto row stranded in pending_approval (process
  // died between park and swap) is still approvable by the UNFENCED click
  // path (/admin/work), which skips the attempt+autoApprove+heldAt fence.
  await db
    .update(S)
    .set({
      status: "published",
      slug: "team-zztest-update-flow-probe",
      publishedAt: new Date("2026-01-02T00:00:00Z"),
    })
    .where(eq(S.id, plain.id));
  const auto3 = await mkRow({
    parentId: plain.id,
    email: ADMIN,
    autoApprove: true,
  });
  await db
    .update(S)
    .set({
      status: "pending_approval",
      cardJson: JSON.stringify(card(TITLE)),
      panelAttemptId: "att9-dead",
    })
    .where(eq(S.id, auto3.id));
  const recovered = await publishWithSupersede(auto3.id);
  assert.ok(recovered.ok, "unfenced click approves a stranded auto row");
  assert.equal((await submissionById(auto3.id))?.status, "published");

  // 21. Reorder (§5.16 display_rank): all-NULL parity, dense re-rank,
  // NULLS LAST placement for new publishes, clamp, not-published guard.
  await cleanup();
  async function seedPublished(
    letter: string,
    whenIso: string,
    companyId: string | null = null
  ) {
    const r = await mkRow({ title: `ZZTEST Reorder ${letter}`, companyId });
    await db
      .update(S)
      .set({
        status: "published",
        slug: `team-zztest-reorder-${letter.toLowerCase()}`,
        publishedAt: new Date(whenIso),
        cardJson: JSON.stringify(card(`ZZTEST Reorder ${letter}`)),
      })
      .where(eq(S.id, r.id));
    return r.id;
  }
  const laneOrder = async (companyId: string | null = null) =>
    (await publishedCards({ companyId })).map((x) => x.id);
  const laneRanks = async (companyId: string | null = null) => {
    const cards = await publishedCards({ companyId });
    const ranks: (number | null)[] = [];
    for (const c of cards) ranks.push((await submissionById(c.id))!.displayRank);
    return ranks;
  };

  const ra = await seedPublished("A", "2026-01-01T00:00:00Z");
  const rb = await seedPublished("B", "2026-01-02T00:00:00Z");
  const rc = await seedPublished("C", "2026-01-03T00:00:00Z");
  assert.deepEqual(
    await laneOrder(),
    [rc, rb, ra],
    "all-NULL lane keeps newest-first parity"
  );

  const moved = await reorderPublishedCard(rc, 3);
  assert.ok(moved.ok && moved.spot === 3 && moved.laneSize === 3, "move ok");
  assert.deepEqual(await laneOrder(), [rb, ra, rc], "C moved to the end");
  assert.deepEqual(await laneRanks(), [1, 2, 3], "dense 1..k after first move");

  const rd = await seedPublished("D", "2026-01-04T00:00:00Z");
  assert.deepEqual(
    await laneOrder(),
    [rb, ra, rc, rd],
    "new publish appends after the ranked block (NULLS LAST)"
  );

  const clamped = await reorderPublishedCard(rd, 99);
  assert.ok(
    clamped.ok && clamped.spot === 4 && clamped.laneSize === 4,
    "overshooting spot clamps to the lane end"
  );
  assert.deepEqual(await laneRanks(), [1, 2, 3, 4], "clamp densifies the lane");

  const promoted = await reorderPublishedCard(rd, 1);
  assert.ok(promoted.ok && promoted.spot === 1);
  assert.deepEqual(await laneOrder(), [rd, rb, ra, rc], "promote to spot 1");

  const heldRow = await mkRow({ title: "ZZTEST Reorder Held" });
  await db
    .update(S)
    .set({
      status: "held",
      heldAt: new Date(),
      cardJson: JSON.stringify(card("ZZTEST Reorder Held")),
    })
    .where(eq(S.id, heldRow.id));
  const refused = await reorderPublishedCard(heldRow.id, 1);
  assert.ok(
    !refused.ok && refused.reason === "not_published",
    "non-published rows cannot be moved"
  );

  // The panel's uniqueness gate consumes publishedCards as SETS: a reorder
  // must never change the membership it sees.
  const setsBefore = await publishedTitleAndFacetSets({ companyId: null });
  await reorderPublishedCard(ra, 1);
  const setsAfter = await publishedTitleAndFacetSets({ companyId: null });
  assert.deepEqual(
    [...setsAfter.publishedTitles].sort(),
    [...setsBefore.publishedTitles].sort(),
    "reorder is invisible to the title uniqueness sets"
  );

  // 22. Tenancy isolation: ranks are lane-relative; a company-lane move
  // never touches public-lane ranks, and vice versa.
  const [comp] = await db
    .insert(schema.companies)
    .values({
      domain: "zztest-reorder.example",
      name: "ZZTEST Reorder Co",
      createdByEmail: "zztest@zztest-reorder.example",
    })
    .returning({ id: schema.companies.id });
  const ce1 = await seedPublished("Co1", "2026-01-01T00:00:00Z", comp.id);
  const ce2 = await seedPublished("Co2", "2026-01-02T00:00:00Z", comp.id);
  const publicBefore = {
    order: await laneOrder(),
    ranks: await laneRanks(),
  };
  const companyMove = await reorderPublishedCard(ce1, 1);
  assert.ok(
    companyMove.ok &&
      companyMove.laneSize === 2 &&
      companyMove.companyId === comp.id,
    "company-lane move sees only its own lane"
  );
  assert.deepEqual(await laneOrder(comp.id), [ce1, ce2]);
  assert.deepEqual(
    { order: await laneOrder(), ranks: await laneRanks() },
    publicBefore,
    "company-lane move leaves the public lane byte-identical"
  );
  const companyBefore = {
    order: await laneOrder(comp.id),
    ranks: await laneRanks(comp.id),
  };
  await reorderPublishedCard(rb, 1);
  assert.deepEqual(
    { order: await laneOrder(comp.id), ranks: await laneRanks(comp.id) },
    companyBefore,
    "public-lane move leaves the company lane byte-identical"
  );

  // 23. Swap inheritance + rollback rank: the update child takes the
  // parent's spot; rollback restores the CHILD's current spot (a reorder
  // between swap and rollback re-ranks the live child while the superseded
  // parent's rank goes stale).
  const rbRank = (await submissionById(rb))!.displayRank;
  assert.equal(rbRank, 1, "precondition: B sits at spot 1");
  const upd = await mkRow({
    parentId: rb,
    title: "ZZTEST Reorder B",
    email: "zztest-updater@xl.net",
  });
  await db
    .update(S)
    .set({
      status: "pending_approval",
      cardJson: JSON.stringify(card("ZZTEST Reorder B")),
    })
    .where(eq(S.id, upd.id));
  const swapRanked = await publishWithSupersede(upd.id);
  assert.ok(swapRanked.ok, "ranked swap publishes");
  assert.equal(
    (await submissionById(upd.id))?.displayRank,
    rbRank,
    "swap inherits the locked parent's rank"
  );
  const moveLive = await reorderPublishedCard(upd.id, 3);
  assert.ok(moveLive.ok && moveLive.spot === 3);
  const liveRank = (await submissionById(upd.id))!.displayRank;
  const rolledRanked = await rollbackSwappedUpdate(upd.id);
  assert.ok(rolledRanked.ok, "rollback after reorder");
  assert.equal(
    (await submissionById(rb))?.displayRank,
    liveRank,
    "rollback restores the live spot, not the stale pre-reorder one"
  );
  const publicRanks = (await laneRanks()).filter((r) => r !== null);
  assert.deepEqual(
    publicRanks,
    publicRanks.map((_, i) => i + 1).slice(0, publicRanks.length),
    "no duplicate or gapped ranks after swap + reorder + rollback"
  );

  // 24. holdPublishedForRerun clears the rank: the one published -> held ->
  // published round trip must re-enter unranked, never resurrect a stale
  // spot over whichever card the admin has since moved there.
  assert.ok(await holdPublishedForRerun(rb, "zztest hold"));
  assert.equal(
    (await submissionById(rb))?.displayRank,
    null,
    "held-for-rerun rows drop their rank"
  );

  await cleanup();
  console.log("update-flow-test: all assertions passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
