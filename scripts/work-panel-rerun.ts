#!/usr/bin/env -S npx tsx
// Admin ops lever for /work submissions (2026-07-31 meta-commentary
// incident): re-run the editorial panel on a row (including a PUBLISHED
// one) or retitle a published card in place. Runs ON THE PROD VM, in its
// own process: a deploy's PM2 restart cannot kill the panel mid-run, and
// every exit path still lands the row in published/held/failed because
// runPanel owns that invariant.
//
// LEDGER CAVEAT (--no-notify): a FAILED suppressed re-run sends no
// failure alert, and the reported_issues triage row rides that alert, so
// the failure is ledger-invisible: the console (exit code 3) and
// /admin/work are the only records. A batch driver must collect exit
// codes; a human running one-offs must read them.
//
// CRASH CAVEAT (--no-notify / --keep-position): both flags live only in
// THIS invocation. A run this process does not finish strands the row at
// running with held_at set, which the queue drain deliberately never
// resumes (db.ts queuedWorkCandidates), so a crash cannot leak emails - but
// the RECOVERY is another work:rerun invocation, and the flags must be
// passed AGAIN there or the recovery run emails and re-stamps. Do not kill
// a run mid-flight; if one dies, re-invoke with the same flags.
//
// Usage:
//   npm run work:rerun -- <uuid> [--title "New Title"] [--retitle-only]
//                                [--no-notify] [--keep-position] [--yes]
//
// Re-run branch: published rows are pulled to held FIRST (bad copy comes
// down immediately; the stored draft is nulled so approveHeld cannot
// republish it), then claimed fromHeld and run to completion in-process.
// Retitle-only branch: rewrites row.title + cardJson.title + slug with NO
// brain calls; use when the copy is right and only the title is a transport
// artifact. It refuses --no-notify (that branch never emails) but accepts
// --keep-position as the stay-put assertion described below.
//
// Side effects the operator must expect BY DEFAULT (all verified in code):
// - A re-run publish re-fires BOTH notifyPublished emails (owner and
//   submitter) with the corrected link; a held outcome fires notifyHeld.
// - deliverArchiveRetention re-sends from the archive store when the row's
//   bytea was already cleared (2026-08-19 store-first flow); it is a no-op
//   only on rows with bytes in neither place (pre-2026-07-29 rows and the
//   2026-08-03 loss pair).
// - finishPublished stamps a fresh published_at (and the hold cleared
//   display_rank), so a re-run card leaves its place and re-enters at the
//   head of the lane's unranked tail; re-run multiple rows in their
//   original published_at order to preserve relative order.
// - The re-run OVERWRITES panel_transcript_json and card_json; dump them
//   first if forensic value remains (this script prints both).
// - An unchanged title keeps its slug; a changed title mints a new one and
//   old /work#slug fragments in past emails degrade to top-of-page. A new
//   slug ALSO drops the card out of any placements.ts bay (the map keys on
//   the slug, owner directive 2026-08-29): this script warns before the
//   confirm prompt when a placed slug would change, and --keep-position
//   refuses a slug-changing retitle outright.
//
// The 2026-08-30 flags (owner directive: "present tense this and other
// cards that remain", "with no notify on those 26 past tense fixes") turn
// the first and third bullets off for copy-correction batches:
// - --no-notify: the re-run's outcome sends NO email of any kind. Not
//   notifyPublished (owner or submitter), not deliverArchiveRetention, not
//   notifyHeld, not the update-lane mails, and not the notifyPanelFailed
//   failure alert (this console is the operator's record). The row outcome
//   (published/held/failed) writes exactly as always; the summary here says
//   "No email was sent". panel.ts logs one
//   "[work] rerun: notifications suppressed for <id>" line.
// - --keep-position: the published_at AND display_rank captured from the
//   row just before the hold are restored by finishPublished instead of a
//   fresh now() stamp, so the card stays where it was on /work. updated_at
//   still moves (the sitemap lastmod reads greatest(published_at,
//   updated_at), so crawlers still see the change). Requires a row that has
//   a published_at to keep. The slug needs no forcing: an unchanged title
//   re-derives the same slug by construction, and a slug-changing --title
//   under this flag is refused (see the placements bullet above).
// Both flags combine with each other and with --title; both are opt-in and
// every other kickPanel caller (web routes, email intake, queue drain)
// keeps today's behaviour byte for byte. A dry plan line prints before the
// confirm prompt stating exactly which side effects (emails, position,
// slug) will and will not happen; after a publish the old and new summary
// first sentences print so a tense fix is visible without opening the page.
//
// TOP-LEVEL IMPORTS ONLY (deploys run npm ci under live jobs). The env
// side-effect import must stay first.

import "./lib/governance-env";
import { createInterface } from "node:readline/promises";
import { deployInProgress } from "../src/lib/governance/db";
import { brainHealthy } from "../src/lib/governance/brain";
import {
  TITLE_KIND_PREFIX_RE,
  WORK_CAPS,
  workSubmissionsEnabled,
} from "../src/lib/work/config";
import {
  activeUpdateChild,
  holdPublishedForRerun,
  normalizeTitle,
  publishedTitleClash,
  activeTitleClash,
  retitlePublishedCard,
  setSubmissionTitle,
  submissionById,
} from "../src/lib/work/db";
import { slugForTitle, stringViolations } from "../src/lib/work/lint";
import { TEAM_CARD_PLACEMENTS } from "../src/lib/work/placements";
import { kickPanel } from "../src/lib/work/panel";
import staticTitles from "../src/lib/work/static-titles.json";
import {
  parseRerunArgs,
  rerunPlanLine,
  summaryFirstSentence,
} from "./lib/work-rerun-ops";

function die(msg: string, code = 1): never {
  console.error(`[work-rerun] ${msg}`);
  process.exit(code);
}

async function main(): Promise<void> {
  const parsed = parseRerunArgs(process.argv.slice(2));
  if (!parsed.ok)
    die(
      `${parsed.error}\nusage: npm run work:rerun -- <uuid> [--title "New Title"] [--retitle-only] [--no-notify] [--keep-position] [--yes]`
    );
  const { id, title: newTitle, retitleOnly, noNotify, keepPosition, yes } =
    parsed.args;

  const row = await submissionById(id);
  if (!row) die(`no submission ${id}`);

  // §5.16 updates (2026-08-03): NEVER re-run a swapped-in update child.
  // holdPublishedForRerun would pull it to held, the re-run parks it
  // pending_approval, and approval then conflict-parks forever because its
  // parent is superseded, not published: the card is stranded off /work
  // with no in-app recovery (refutation FATAL). Roll back first (Delete on
  // the published update row in /admin/work restores the previous
  // version), then re-run the restored parent.
  if (row.parentId)
    die(
      row.status === "published"
        ? `this row is a swapped-in update of ${row.parentId}; re-running it would strand the card. Roll back first ("Roll back to previous version" on /admin/work), then re-run the restored card.`
        : `this row is an update proposal for ${row.parentId}; use /admin/work (Run the panel again / Approve / Reject) instead of this script.`
    );
  // A superseded row is the rollback reservoir, not a live card.
  if (row.status === "superseded")
    die(
      "this row was replaced by an approved update and is kept for rollback; re-run the published update row's card instead (or roll back first)."
    );
  // A parent with an in-flight update: pulling it to held would collide
  // with the child in the active-title unique index (raw DB error), and a
  // retitle would desync the child's pinned title. Resolve the update
  // first.
  {
    const child = await activeUpdateChild(row.id);
    if (child)
      die(
        `an update to this card is in the pipeline (${child.id}, status ${child.status}); approve, reject, or delete it on /admin/work first.`
      );
  }

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
    if (await publishedTitleClash(newTitle, { companyId: null }))
      die(`--title collides with a published community card`);
    const clash = await activeTitleClash(newTitle, { companyId: null });
    if (clash && clash.id !== id)
      die(`--title collides with in-pipeline submission ${clash.id} (${clash.status})`);
  }

  // /work PLACEMENTS (owner directive 2026-08-29): placements.ts pins a
  // published team card into a static bay BY SLUG. An unchanged title keeps
  // its slug (uniqueSlug excludes this row's own id), so a placement
  // survives a plain re-run; a slug-changing retitle silently drops the
  // card out of its placed bay back into the From the Team run and leaves
  // that bay's stripe seam double-striped until the map is updated. Company
  // lane rows are exempt: their slugs are id-derived, a title change never
  // moves them, and placements are a public /work concept.
  const internalLane = (row.companyId ?? null) === null;
  const newSlugBase = newTitle !== null ? slugForTitle(newTitle) : null;
  // Compare against the STORED slug, never a re-derivation of row.title: a
  // previously interrupted "--title" invocation commits the new title before
  // the run (setSubmissionTitle), so title-to-title comparison reads the
  // rename as "unchanged" and the next plain re-run mints the new slug with
  // no warning (refutation 2026-08-30). The startsWith arm tolerates a
  // legitimately "-2"-suffixed stored slug whose base matches.
  const expectedBase =
    newSlugBase ?? slugForTitle(newTitle !== null ? newTitle : row.title);
  const slugChanges =
    internalLane &&
    (row.slug !== null
      ? expectedBase !== row.slug && !row.slug.startsWith(expectedBase + "-")
      : newSlugBase !== null && newSlugBase !== slugForTitle(row.title));
  const placedBay =
    internalLane &&
    row.slug &&
    Object.prototype.hasOwnProperty.call(TEAM_CARD_PLACEMENTS, row.slug)
      ? TEAM_CARD_PLACEMENTS[row.slug]
      : null;
  // Under --keep-position the slug is kept VERBATIM (keepSlug ->
  // finishPublished), so a derived-base mismatch can no longer break
  // placements or anchors, and refusing on it was WRONG twice over
  // (2026-08-30 batch, row 34): (a) a row whose ORIGINAL panel run titled
  // the card differently from row.title has a slug derived from the card
  // title, so a plain re-run tripped the die with "-> null"; (b) a long
  // title's slug is length-capped at mint time, so even an identical title
  // re-derives a longer base and mismatches. Both are safe under keep. The
  // note below keeps the operator informed; the retitle-only branch (which
  // really does mint) keeps its own guard.
  if (keepPosition && slugChanges)
    console.log(
      `[work-rerun] note: --keep-position keeps the stored slug verbatim (${row.slug ?? "-"}) although the ${newTitle !== null ? "requested title" : "row title"} derives ${expectedBase}; placements.ts keys and old /work#${row.slug ?? ""} links survive unchanged.`
    );
  if (slugChanges && placedBay) {
    const bayName =
      staticTitles.bays.find((b) => b.n === placedBay)?.name ?? "unknown bay";
    const newSlugKeyed =
      newSlugBase !== null &&
      Object.prototype.hasOwnProperty.call(TEAM_CARD_PLACEMENTS, newSlugBase);
    console.log(`[work-rerun] **************************** WARNING ****************************`);
    console.log(`[work-rerun] WARNING: this card is PLACED. placements.ts pins slug ${row.slug} into bay ${placedBay} (${bayName}).`);
    console.log(`[work-rerun] WARNING: the new title mints slug ${newSlugBase}, so the card would FALL OUT of bay ${placedBay} into the From the Team run, and that bay's stripe seam double-stripes until the map is fixed.`);
    console.log(
      newSlugKeyed
        ? `[work-rerun] WARNING: TEAM_CARD_PLACEMENTS already keys the new slug, so this checkout's map is ahead; make sure it is DEPLOYED with this retitle.`
        : `[work-rerun] WARNING: to keep the placement, update TEAM_CARD_PLACEMENTS in src/lib/work/placements.ts to the new slug and deploy in the same change.`
    );
    console.log(`[work-rerun] *****************************************************************`);
  }

  // --keep-position, re-run branch: capture the row's place BEFORE the hold
  // nulls display_rank. A held row from an earlier aborted attempt still
  // carries its original published_at, so the recovery path keeps working;
  // its display_rank is already gone (that earlier hold cleared it), and
  // the plan line below says what will actually be restored.
  const origPublishedAt = row.publishedAt ?? null;
  const origDisplayRank = row.displayRank ?? null;
  const origSlug = row.slug ?? null;
  const oldSummarySentence = summaryFirstSentence(row.cardJson);
  if (!retitleOnly && keepPosition && !origPublishedAt)
    die(
      "--keep-position needs a row with a published_at to keep (this row was never published)"
    );

  if (!retitleOnly)
    console.log(
      `[work-rerun] ${rerunPlanLine({
        noNotify,
        keepPosition,
        slugChanges,
        publishedAt: origPublishedAt,
        displayRank: origDisplayRank,
        slug: origSlug,
      })}`
    );

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
    if (
      !(await holdPublishedForRerun(
        id,
        `ops re-run ${new Date().toISOString().slice(0, 10)}${noNotify ? " no-notify" : ""}${keepPosition ? " keep-position" : ""}`
      ))
    )
      die("hold refused (row no longer published?)");
    console.log(`[work-rerun] row held; the card is OFF /work until this re-run publishes or an admin acts.`);
  } else if (row.status === "running") {
    const beat = row.panelHeartbeatAt?.getTime() ?? 0;
    if (Date.now() - beat < WORK_CAPS.panelStaleMs)
      die("a panel run is live on this row (fresh heartbeat); retry after it finishes");
  }

  const fromHeld = row.status === "published" || row.status === "held";
  const kicked = await kickPanel(id, {
    ...(fromHeld ? { fromHeld: true } : {}),
    ...(noNotify ? { notify: false } : {}),
    ...(keepPosition
      ? {
          keepPublishedAt: origPublishedAt,
          keepDisplayRank: origDisplayRank,
          // slug kept VERBATIM: uniqueSlug is history-dependent (a freed
          // base collapses "team-x-2" back to "team-x"), so re-deriving
          // could move anchors and placements even with the title unchanged.
          keepSlug: origSlug,
        }
      : {}),
  });
  if (!kicked.run) {
    const reason = kicked.outcome.status === "refused" ? kicked.outcome.reason : "claim";
    console.error(`[work-rerun] kick refused: ${reason} (claim can mean the 3-runs/day per-submission cap)`);
    if (row.status === "published") {
      console.error(`[work-rerun] WARNING: the row is now HELD and the card is OFF /work. Re-run later or use /admin/work.`);
      if (keepPosition && origDisplayRank !== null)
        console.error(
          `[work-rerun] WARNING: the hold cleared display_rank; a later --keep-position re-invocation restores published_at only (the rank ${origDisplayRank} captured this run is lost). Re-arrange on /admin/work afterwards if the card was curated.`
        );
    }
    process.exit(1);
  }

  console.log(`[work-rerun] panel running in-process (worst case ~13 min; run under tmux/nohup for long runs)...`);
  await kicked.run();

  const after = await submissionById(id);
  if (!after) die("row vanished mid-run");
  console.log(`[work-rerun] terminal status=${after.status}`);
  if (after.status === "published") {
    console.log(`[work-rerun] published: /work#${after.slug}`);
    console.log(
      `[work-rerun] slug: ${origSlug ?? "-"} -> ${after.slug ?? "-"}${origSlug && after.slug === origSlug ? " (unchanged; old links and any placements.ts key still match)" : ""}`
    );
    if (origSlug && after.slug !== origSlug)
      console.log(
        `[work-rerun] ${keepPosition ? "WARNING: --keep-position was set but the slug CHANGED" : "slug changed (expected with a changed title)"} (${origSlug} -> ${after.slug}): old /work#${origSlug} fragments degrade to top-of-page; if this card is keyed in src/lib/work/placements.ts, move the key to the new slug and deploy.`
      );
    if ((after.panelTranscriptJson ?? "").includes("repair drift contained"))
      console.log(
        `[work-rerun] note: repair drift was contained in this run (see the transcript); under --no-notify the owner FYI email did not go out, so this console line is the operator-visible record.`
      );
    if (keepPosition) {
      console.log(
        `[work-rerun] position kept: published_at ${after.publishedAt?.toISOString() ?? "-"} (original), display_rank ${after.displayRank ?? "none"} restored; updated_at moved, so the sitemap lastmod still advances.`
      );
      if (after.publishedAt?.getTime() !== origPublishedAt?.getTime())
        console.log(
          `[work-rerun] WARNING: published_at ${after.publishedAt?.toISOString() ?? "-"} does not match the captured ${origPublishedAt?.toISOString() ?? "-"}; a concurrent actor may have won an interleave. Check /admin/work.`
        );
    } else {
      console.log(`[work-rerun] published_at re-stamped: the card re-enters at the head of the unranked tail.`);
    }
    if (noNotify)
      console.log(`[work-rerun] No email was sent (--no-notify): notifyPublished (owner and submitter) and archive retention were both suppressed.`);
    else
      console.log(`[work-rerun] notifyPublished emails (owner + submitter) fired with the new link; archive retention no-ops on already-cleared rows.`);
    console.log(`[work-rerun] summary, first sentence (the tense check, without opening the page):`);
    console.log(`[work-rerun]   old: ${oldSummarySentence ?? "(no stored card copy before the run)"}`);
    console.log(`[work-rerun]   new: ${summaryFirstSentence(after.cardJson) ?? "(none)"}`);
    process.exit(0);
  }
  if (after.status === "held") {
    console.log(`[work-rerun] HELD: ${after.panelError ?? "(no reason)"}`);
    if (noNotify)
      console.log(`[work-rerun] No email was sent (--no-notify): the notifyHeld mail was suppressed; this console and /admin/work are the only records.`);
    console.log(`[work-rerun] card stays OFF /work; review in /admin/work#sub-${id}. If the fixes were supposed to prevent this, STOP re-running other rows.`);
    process.exit(2);
  }
  console.log(`[work-rerun] FAILED: ${after.panelError ?? "(no reason)"}; re-invoking this script re-claims a failed row.`);
  if (noNotify)
    console.log(`[work-rerun] No email was sent (--no-notify): the notifyPanelFailed alert was suppressed; this console line is the only record.`);
  process.exit(3);
}

void main();
