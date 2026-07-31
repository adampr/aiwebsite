#!/usr/bin/env -S npx tsx
// Admin ops lever for /work submissions (2026-07-31 meta-commentary
// incident): re-run the editorial panel on a row (including a PUBLISHED
// one) or retitle a published card in place. Runs ON THE PROD VM, in its
// own process: a deploy's PM2 restart cannot kill the panel mid-run, and
// every exit path still lands the row in published/held/failed because
// runPanel owns that invariant.
//
// Usage:
//   npm run work:rerun -- <uuid> [--title "New Title"] [--retitle-only] [--yes]
//
// Re-run branch: published rows are pulled to held FIRST (bad copy comes
// down immediately; the stored draft is nulled so approveHeld cannot
// republish it), then claimed fromHeld and run to completion in-process.
// Retitle-only branch: rewrites row.title + cardJson.title + slug with NO
// brain calls; use when the copy is right and only the title is a transport
// artifact.
//
// Side effects the operator must expect (all verified in code):
// - A re-run publish re-fires BOTH notifyPublished emails (owner and
//   submitter) with the corrected link; a held outcome fires notifyHeld.
// - deliverArchiveRetention is a no-op on rows whose archive bytes were
//   already emailed and cleared.
// - finishPublished stamps a fresh published_at, so re-run cards move to
//   the END of the From the Team section; re-run multiple rows in their
//   original published_at order to preserve relative order.
// - The re-run OVERWRITES panel_transcript_json and card_json; dump them
//   first if forensic value remains (this script prints both).
// - An unchanged title keeps its slug; a changed title mints a new one and
//   old /work#slug fragments in past emails degrade to top-of-page.
//
// TOP-LEVEL IMPORTS ONLY (deploys run npm ci under live jobs). The env
// side-effect import must stay first.

import "./lib/governance-env";
import { createInterface } from "node:readline/promises";
import { deployInProgress, isUuid } from "../src/lib/governance/db";
import { brainHealthy } from "../src/lib/governance/brain";
import {
  TITLE_KIND_PREFIX_RE,
  WORK_CAPS,
  workSubmissionsEnabled,
} from "../src/lib/work/config";
import {
  holdPublishedForRerun,
  normalizeTitle,
  publishedTitleClash,
  activeTitleClash,
  retitlePublishedCard,
  setSubmissionTitle,
  submissionById,
} from "../src/lib/work/db";
import { stringViolations } from "../src/lib/work/lint";
import { kickPanel } from "../src/lib/work/panel";
import staticTitles from "../src/lib/work/static-titles.json";

function die(msg: string, code = 1): never {
  console.error(`[work-rerun] ${msg}`);
  process.exit(code);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const id = args.find((a) => !a.startsWith("--"));
  const titleIdx = args.indexOf("--title");
  const newTitle = titleIdx >= 0 ? (args[titleIdx + 1] ?? "").trim() : null;
  const retitleOnly = args.includes("--retitle-only");
  const yes = args.includes("--yes");

  if (!id || !isUuid(id))
    die('usage: npm run work:rerun -- <uuid> [--title "New Title"] [--retitle-only] [--yes]');
  if (retitleOnly && !newTitle) die("--retitle-only requires --title");

  const row = await submissionById(id);
  if (!row) die(`no submission ${id}`);

  console.log(`[work-rerun] id=${row.id}`);
  console.log(`[work-rerun] status=${row.status} kind=${row.kind}`);
  console.log(`[work-rerun] title="${row.title}"`);
  console.log(`[work-rerun] slug=${row.slug ?? "-"} publishedAt=${row.publishedAt?.toISOString() ?? "-"}`);
  console.log(`[work-rerun] panelError=${row.panelError ?? "-"}`);
  console.log(`[work-rerun] current cardJson (SAVE THIS if forensic value remains):`);
  console.log(row.cardJson ? JSON.stringify(JSON.parse(row.cardJson), null, 2) : "(none)");
  console.log(`[work-rerun] transcript bytes=${row.panelTranscriptJson?.length ?? 0} (overwritten by a re-run)`);

  if (newTitle) {
    if (
      newTitle.length < WORK_CAPS.titleMinChars ||
      newTitle.length > WORK_CAPS.titleMaxChars
    )
      die(`--title must be ${WORK_CAPS.titleMinChars}-${WORK_CAPS.titleMaxChars} chars`);
    if (TITLE_KIND_PREFIX_RE.test(newTitle))
      die(`--title starts with a category prefix that duplicates the badge`);
    const bans = stringViolations("title", newTitle);
    if (bans.length > 0) die(`--title fails string bans:\n${bans.join("\n")}`);
    const norm = normalizeTitle(newTitle);
    if (staticTitles.titles.some((t: string) => normalizeTitle(t) === norm))
      die(`--title collides with a hand-authored /work exhibit title`);
    if (await publishedTitleClash(newTitle))
      die(`--title collides with a published community card`);
    const clash = await activeTitleClash(newTitle);
    if (clash && clash.id !== id)
      die(`--title collides with in-pipeline submission ${clash.id} (${clash.status})`);
  }

  if (!yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(
      `[work-rerun] ${retitleOnly ? "RETITLE" : "RE-RUN"} "${row.title}"${newTitle ? ` as "${newTitle}"` : ""}? Type yes: `
    );
    rl.close();
    if (answer.trim().toLowerCase() !== "yes") die("aborted", 0);
  }

  if (retitleOnly) {
    const res = await retitlePublishedCard(id, newTitle as string);
    if (!res) die("retitle refused (row not published, or cardJson missing/invalid)");
    console.log(`[work-rerun] retitled: slug ${res.oldSlug ?? "-"} -> ${res.slug}`);
    console.log(`[work-rerun] old /work#${res.oldSlug} fragments now scroll to top of page; /work heals via revalidate within 5 minutes.`);
    process.exit(0);
  }

  // ── Re-run preflight (mirrors kickPanel's gates so a refusal never
  //    strands a just-held row) ─────────────────────────────────────
  if (process.env.BRAIN_STUB)
    die("BRAIN_STUB is set in this environment; brainHealthy would lie. Unset it first.");
  if (!workSubmissionsEnabled(process.env))
    die("WORK_SUBMISSIONS_ENABLED=0 (kill switch): flip it on before re-running");
  if (deployInProgress())
    die("deploy in progress (marker fresh): wait it out and retry");
  if (!(await brainHealthy())) die("brain health check failed");

  if (newTitle && !(await setSubmissionTitle(id, newTitle)))
    die("title update failed");

  if (row.status === "published") {
    if (!(await holdPublishedForRerun(id, `ops re-run ${new Date().toISOString().slice(0, 10)}: meta-commentary incident`)))
      die("hold refused (row no longer published?)");
    console.log(`[work-rerun] row held; the card is OFF /work until this re-run publishes or an admin acts.`);
  } else if (row.status === "running") {
    const beat = row.panelHeartbeatAt?.getTime() ?? 0;
    if (Date.now() - beat < WORK_CAPS.panelStaleMs)
      die("a panel run is live on this row (fresh heartbeat); retry after it finishes");
  }

  const fromHeld = row.status === "published" || row.status === "held";
  const kicked = await kickPanel(id, fromHeld ? { fromHeld: true } : undefined);
  if (!kicked.run) {
    const reason = kicked.outcome.status === "refused" ? kicked.outcome.reason : "claim";
    console.error(`[work-rerun] kick refused: ${reason} (claim can mean the 3-runs/day per-submission cap)`);
    if (row.status === "published")
      console.error(`[work-rerun] WARNING: the row is now HELD and the card is OFF /work. Re-run later or use /admin/work.`);
    process.exit(1);
  }

  console.log(`[work-rerun] panel running in-process (worst case ~13 min; run under tmux/nohup for long runs)...`);
  await kicked.run();

  const after = await submissionById(id);
  if (!after) die("row vanished mid-run");
  console.log(`[work-rerun] terminal status=${after.status}`);
  if (after.status === "published") {
    console.log(`[work-rerun] published: /work#${after.slug}`);
    console.log(`[work-rerun] notifyPublished emails (owner + submitter) fired with the new link; archive retention no-ops on already-cleared rows.`);
    process.exit(0);
  }
  if (after.status === "held") {
    console.log(`[work-rerun] HELD: ${after.panelError ?? "(no reason)"}`);
    console.log(`[work-rerun] card stays OFF /work; review in /admin/work#sub-${id}. If the fixes were supposed to prevent this, STOP re-running other rows.`);
    process.exit(2);
  }
  console.log(`[work-rerun] FAILED: ${after.panelError ?? "(no reason)"}; re-invoking this script re-claims a failed row.`);
  process.exit(3);
}

void main();
