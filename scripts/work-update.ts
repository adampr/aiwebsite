#!/usr/bin/env -S npx tsx
// Propose an UPDATE to a published /work card from the command line, as
// POST /api/work/submissions/[id]/update does for a signed-in @xl.net staff
// member (§5.16 admin-mediated updates). The scripted twin of the update
// route, in the same family as scripts/work-submit.ts (twin of the create
// route) and scripts/work-transfer.ts.
//
// WHY THIS EXISTS (2026-09-21). work:submit already covers the create lane
// for the one case the web form cannot serve: a repository package is far
// too big for the email lane, and a browser session cannot be minted
// headlessly. The update lane had no such twin, so re-drafting a published
// card from a new package was possible ONLY from a browser. That made
// "widen this card to cover the rest of the system" an owner-only action
// even when the operator already had the package in hand.
//
// NOTHING IS RE-IMPLEMENTED. Every gate, band, message and ladder step is
// the route's own, and the pure ones are the SAME helpers work:submit uses
// (scripts/lib/work-submit-ops.ts), so the two console lanes cannot drift
// from each other or from the routes they mirror.
//
// THE ROW IT WRITES is a staff-lane web update: a NEW submission with
// parent_id set to the published card, company_id null, title and kind
// PINNED to the parent (renames stay admin-CLI-only, work:rerun --title),
// submitter_email = --email, submitter_name = --attribution or null.
//
// ---- DELIBERATELY NOT REPRODUCED, and why ----
//
//  1. Session auth (requireXlUser). There is no session and no browser; that
//     is the whole reason this exists. What the gate IMPLIES is reproduced:
//     --email must be in WORK_SUBMIT_DOMAINS, the row is filed in the public
//     lane, and the parent must be one this submitter could have updated
//     through the site (canProposeUpdate, the route's own chain-ownership
//     check). A company-lane parent is refused exactly as the route 404s it.
//  2. CSRF origin checking. No browser, no cookie, no cross-origin request.
//  3. The in-memory rate limiter (10 upload attempts/user/hour). A per-fork
//     CPU guard in the running site process; this is a separate short-lived
//     process and one operator-driven upload is not the hammering it guards
//     against. The DURABLE bound, countCreatedToday against the same daily
//     quota, IS reproduced.
//  4. The Content-Length precheck. There is no multipart body to buffer; the
//     authoritative byte caps below are the route's own.
//  5. brainHealthy(). The route refuses early because it kicks the panel on
//     the very next lines. This script does NOT kick (see below), so a row
//     filed during a brain blip simply waits for the drain, whose own
//     admission gates include brain health.
//  6. kickPanel(). Same reason as work:submit: a run started in a
//     short-lived tsx process dies with the ssh session and would strand the
//     row at "running" until the drain reclaimed a stale heartbeat. The row
//     lands at "received" and src/lib/work/queue-drain.ts takes it.
//
// ---- THE ONE FLAG THAT CARRIES AUTHORITY ----
//
// --auto-approve sets the row's autoApprove, which the route arms ONLY for
// verifiedWebAdmin (a Google-verified staff admin session). It does NOT skip
// any content gate: finishUpdateRow still swaps the card live only on a
// PASSING panel run, and a lint or disclosure failure still holds the row.
// What it skips is the human approval click on /admin/work, which for the
// card's own owner the route itself calls ceremony. It is OFF by default
// here, so the default console update parks at pending_approval exactly as
// a teammate's would, and arming it is a deliberate, logged operator act.
//
// Usage:
//   npm run work:update -- --id <published-uuid> --file <package.zip>
//                          [--md <doc.md>] [--blurb-file <file>]
//                          [--email adam@xl.net] [--attribution <FirstName>]
//                          [--auto-approve] [--dry-run] [--yes]
//
//   --id            the PUBLISHED card being updated (its submission uuid)
//   --file          the replacement package (.zip or .skill)
//   --md            the standalone reviewed document (.md/.mdx/.markdown)
//   --blurb-file    a file holding the optional description (context only)
//   --email         who is submitting; default the first ADMIN_EMAIL entry
//   --attribution   public credit, a single first name. IMPORTANT: after a
//                   swap the live card renders THIS row's byline, so leaving
//                   it empty publishes the card as the XL.net team even if
//                   the parent carried a name.
//   --auto-approve  arm the admin auto-swap (see above)
//   --dry-run       run every gate and the whole inspection, write nothing
//   --yes           skip the confirm prompt
//
// Exit 0 when the row was created (or a --dry-run finished clean), 1 on any
// refusal, 2 on a write race.
//
// Runs ON THE PROD VM (DATABASE_URL resolves only there).
import "dotenv/config";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { isAdmin } from "@aicompany/core/auth/guard";
import { type WorkKind } from "../src/lib/work/config";
import {
  activeTitleClash,
  canProposeUpdate,
  countCreatedToday,
  createSubmission,
  isUniqueViolation,
  publishedTitleClash,
  submissionById,
  userIdForEmail,
} from "../src/lib/work/db";
import {
  inspectArchive,
  inspectBareMd,
  mergeSkillCorpus,
  skillDocFailureMessage,
  type ExtractOk,
} from "../src/lib/work/extract";
import { storeArchiveFiles } from "../src/lib/work/archive-store";
import { decideStorage } from "../src/lib/work/cleaning";
import { reportIntakeCleaningIssue } from "../src/lib/report-issue";
import { INTERNAL_SCOPE } from "../src/lib/work/scope";
import {
  DISABLED_MESSAGE,
  activeClashMessage,
  blurbRefusal,
  clip,
  dailyQuotaFor,
  docBaseName,
  mdNameRefusal,
  mdSizeRefusal,
  outerLevelOnly,
  packageBytesRefusal,
  packageNameRefusal,
  packageSizeRefusal,
  parseAttribution,
  quotaRefusal,
  readBlurb,
  rescueApplies,
  rescuePassMessage,
  resolveSubmitterEmail,
  standaloneDocMessage,
  storedName,
  workSubmissionsEnabled,
} from "./lib/work-submit-ops";

function die(msg: string, code = 1): never {
  console.error(`[work-update] ${msg}`);
  process.exit(code);
}

/** The console twin of the route's workError(): the submitter-facing
 * sentence, the HTTP status the web lane would have returned, and the code. */
function refuse(
  status: number,
  code: string,
  message: string,
  paths?: string[]
): never {
  console.error(`\n[work-update] REFUSED ${status} ${code}`);
  console.error(`  ${message}`);
  if (paths?.length) {
    console.error(`  paths:`);
    for (const p of paths.slice(0, 20)) console.error(`    ${p}`);
  }
  process.exit(1);
}

/** The route's identical 404 for missing, unpublished, not-owned and
 * company-lane parents: no existence or ownership oracle, one message. */
const NOT_FOUND =
  "No published card with that id that you can update. Check the id on /work/submit, and remember an update must target a card that is live.";

interface Args {
  id: string | null;
  file: string | null;
  md: string | null;
  blurbFile: string | null;
  email: string | null;
  attribution: string | null;
  autoApprove: boolean;
  dryRun: boolean;
  yes: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    id: null,
    file: null,
    md: null,
    blurbFile: null,
    email: null,
    attribution: null,
    autoApprove: false,
    dryRun: false,
    yes: false,
  };
  const want = new Map<string, keyof Args>([
    ["--id", "id"],
    ["--file", "file"],
    ["--md", "md"],
    ["--blurb-file", "blurbFile"],
    ["--email", "email"],
    ["--attribution", "attribution"],
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--auto-approve") out.autoApprove = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--yes") out.yes = true;
    else {
      const key = want.get(a);
      if (!key) die(`unknown argument ${a}`);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--"))
        die(`${a} needs a value`);
      (out[key] as string) = value;
      i += 1;
    }
  }
  if (!out.id) die("--id <published-uuid> is required");
  if (!out.file) die("--file <package.zip> is required");
  return out;
}

function sizeOrDie(label: string, path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return die(`cannot read ${label} ${path}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // ── gate: kill switch (route 122-128) ───────────────────────────
  if (!workSubmissionsEnabled(process.env)) refuse(503, "disabled", DISABLED_MESSAGE);

  // ── who is submitting (the route's session, modelled) ────────────
  const resolved = resolveSubmitterEmail(args.email, process.env);
  if (!resolved.ok) die(resolved.error);
  const email = resolved.email;
  const admin = isAdmin(email);

  // ── gate: daily quota (route 136-146) ───────────────────────────
  const quota = dailyQuotaFor(admin);
  const used = await countCreatedToday(email);
  const overQuota = quotaRefusal(used, quota);
  if (overQuota) refuse(429, "quota", overQuota);

  // ── gate: predecessor + ownership + lane (route 153-172) ─────────
  const row = await submissionById(args.id!);
  if (
    !row ||
    row.status !== "published" ||
    !row.cardJson ||
    !(await canProposeUpdate(row, email, admin))
  )
    refuse(404, "not_found", NOT_FOUND);
  if (row.companyId !== null) refuse(404, "not_found", NOT_FOUND);

  // Title and kind are the PARENT's, never the package's.
  const kind = row.kind as WorkKind;
  const title = row.title;

  // ── gate: blurb cap (route 224-230) ─────────────────────────────
  const blurb = readBlurb(args.blurbFile);
  const blurbBad = blurbRefusal(blurb);
  if (blurbBad) refuse(400, "invalid_request", blurbBad);

  // ── gate: attribution shape (route 233-244) ─────────────────────
  const parsedName = parseAttribution(args.attribution);
  if (!parsedName.ok) refuse(400, "invalid_request", parsedName.message);
  const attribution = parsedName.attribution;

  // ── gate: title clashes (route 248-267) ─────────────────────────
  // exceptId keeps the predecessor itself out of the published check.
  if (await publishedTitleClash(title, INTERNAL_SCOPE, { exceptId: row.id }))
    refuse(
      409,
      "duplicate_title",
      "Another published card now uses this title. Sort the titles out before updating."
    );
  const clash = await activeTitleClash(title, INTERNAL_SCOPE);
  if (clash) refuse(409, "duplicate_title", activeClashMessage(title, clash, email));

  // ── gate: package envelope (route 275-302) ──────────────────────
  const filePath = resolve(args.file!);
  const name = basename(filePath);
  const nameBad = packageNameRefusal(name);
  if (nameBad) refuse(400, "invalid_request", nameBad);
  const declared = sizeOrDie("--file", filePath);
  const sizeBad = packageSizeRefusal(declared);
  if (sizeBad) refuse(400, "invalid_request", sizeBad);
  const bytes = readFileSync(filePath);
  const bytesBad = packageBytesRefusal(bytes.length);
  if (bytesBad) refuse(400, "invalid_request", bytesBad);

  // ── the standalone reviewed document (route 315-328) ────────────
  let mdFile: { name: string; bytes: Buffer } | null = null;
  if (args.md) {
    const mdPath = resolve(args.md);
    const mdName = basename(mdPath);
    const mdNameBad = mdNameRefusal(mdName);
    if (mdNameBad) refuse(400, "invalid_request", mdNameBad);
    const mdSize = sizeOrDie("--md", mdPath);
    if (mdSize > 0) {
      const mdSizeBad = mdSizeRefusal(mdSize);
      if (mdSizeBad) refuse(400, "invalid_request", mdSizeBad);
      mdFile = { name: mdName, bytes: readFileSync(mdPath) };
    }
  }

  // ── the package walk, kind PINNED to the parent (route 333) ──────
  const extracted = await inspectArchive(bytes, kind, { packageName: name });
  const mdExtract = mdFile ? inspectBareMd(mdFile.name, mdFile.bytes) : null;

  let pkg: ExtractOk;
  if (extracted.ok) {
    pkg = extracted;
  } else if (mdExtract && kind === "program" && rescueApplies(extracted)) {
    if (!mdExtract.ok) refuse(422, mdExtract.code, standaloneDocMessage(mdExtract));
    const rescue = await inspectArchive(bytes, "skill", { packageName: name });
    if (!rescue.ok)
      refuse(422, rescue.code, rescuePassMessage(rescue, name), rescue.paths);
    pkg = outerLevelOnly(rescue);
  } else {
    refuse(
      422,
      extracted.code,
      extracted.message,
      extracted.paths ?? extracted.droppedPaths
    );
  }

  // ── reviewed-doc precedence (route 377-410) ─────────────────────
  let docText = pkg.docText;
  let corpus = pkg.corpus;
  let mdMeta:
    | { name: string; sha256: string; bytes: number; data: Buffer }
    | undefined;
  let docSource = `inside the package (${pkg.docPath})`;
  if (mdFile && mdExtract) {
    if (!mdExtract.ok) refuse(422, mdExtract.code, standaloneDocMessage(mdExtract));
    docText = mdExtract.docText;
    corpus = mergeSkillCorpus(mdExtract, pkg);
    mdMeta = {
      name: storedName(mdFile.name, "SKILL.md"),
      sha256: mdExtract.archiveSha256,
      bytes: mdFile.bytes.length,
      data: mdFile.bytes,
    };
    docSource = `the standalone --md upload (${mdFile.name})`;
  } else if (pkg.docMissing) {
    refuse(
      422,
      `skill_doc_${pkg.docMissing}`,
      skillDocFailureMessage(pkg.docMissing),
      pkg.candidatePaths
    );
  } else if (kind === "skill" && pkg.docRawBytes) {
    mdMeta = {
      name: storedName(docBaseName(pkg.docPath), "SKILL.md"),
      sha256: createHash("sha256").update(pkg.docRawBytes).digest("hex"),
      bytes: pkg.docRawBytes.length,
      data: pkg.docRawBytes,
    };
  }

  // ── cleaning, the one storage decision all lanes share ───────────
  const storage = decideStorage({
    pkg,
    submittedArchive: bytes,
    md:
      mdFile && mdExtract?.ok
        ? { extract: mdExtract, submitted: mdFile.bytes }
        : null,
  });
  // The route's mdFailed guard verbatim: a null mdData means either "no
  // standalone slot" (fallback correct) or "the rebuild could not be
  // produced" (fallback stores the uncleaned file), and only mdFailed tells
  // them apart.
  const mdForRow =
    mdMeta && !storage.mdFailed
      ? { ...mdMeta, data: storage.mdData ?? mdMeta.data }
      : undefined;

  // ── what is about to happen ─────────────────────────────────────
  console.log(`\n== Update to a published card ==`);
  console.log(`Card:          ${title}`);
  console.log(`  id           ${row.id}`);
  console.log(`  slug         ${row.slug ?? "(none)"}`);
  console.log(`  kind         ${kind} (PINNED from the card)`);
  console.log(`  credit now   ${row.submitterName ?? "(the XL.net team)"}`);
  console.log(`Submitter:     ${email}${admin ? " (admin)" : ""}`);
  console.log(`New credit:    ${attribution ?? "(the XL.net team)"}`);
  console.log(`Reviewed doc:  ${docSource}`);
  console.log(`Manifest:      ${pkg.manifest.length} entries`);
  console.log(
    `Corpus:        ${corpus.length} entries, ${corpus.reduce((n, c) => n + c.text.length, 0)} chars`
  );
  console.log(`Archive:       ${pkg.archiveSha256}`);
  console.log(`               ${pkg.archiveBytes} bytes, stored as ${name}`);
  console.log(`Description:   ${blurb.length} chars`);
  console.log(
    `Auto-approve:  ${args.autoApprove ? "YES - a PASSING panel run swaps the card live with no click" : "no - the run parks at pending_approval for /admin/work"}`
  );
  if (storage.cleaned) {
    console.log(
      `\n!! credential-shaped content was CLEANED from this package before storage:`
    );
    for (const p of storage.cleanedPaths) console.log(`   ${p}`);
    if (storage.failed)
      console.log(
        `  !! the cleaned rebuild could not be verified (${storage.failed}); NO archive will be stored.`
      );
  }
  console.log(`\n---- first 400 characters of the reviewed document ----`);
  console.log(clip(docText, 400));
  console.log(`-------------------------------------------------------`);

  if (args.dryRun) {
    console.log(
      `\nDRY RUN: every gate passed and the inspection completed. NOTHING was written to the database or to the archive store. Re-run without --dry-run to file it.`
    );
    return;
  }

  if (!args.yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (
      await rl.question(`\nFile this update to "${title}"? [y/N] `)
    )
      .trim()
      .toLowerCase();
    rl.close();
    if (answer !== "y" && answer !== "yes") {
      console.log("Not filed.");
      return;
    }
  }

  const userId = await userIdForEmail(email);

  let child;
  try {
    child = await createSubmission({
      companyId: null, // staff lane by construction (company parents refused)
      userId,
      email,
      name: attribution,
      kind,
      title,
      blurb,
      // NO time-saved value: §5.16 inherits the parent's figure at SWAP
      // time inside publishWithSupersede, which is the one primitive both
      // swap paths reach. Snapshotting it here would revert an owner's
      // later correction on the live parent.
      architectureText: kind === "program" ? docText : null,
      skillMdText: kind === "skill" ? docText : null,
      fileManifestJson: JSON.stringify(pkg.manifest),
      corpusFilesJson: JSON.stringify(corpus),
      archiveName: name.slice(0, 200),
      archiveSha256: pkg.archiveSha256,
      archiveBytes: pkg.archiveBytes,
      archiveData: storage.archiveData,
      md: mdForRow,
      cleaningJson: storage.cleaningJson,
      parentId: row.id,
      autoApprove: args.autoApprove,
    });
  } catch (err) {
    if (
      isUniqueViolation(
        err,
        "work_sub_active_title_uq",
        "work_sub_parent_active_uq"
      )
    )
      refuse(
        409,
        "duplicate_title",
        `An update for "${title}" is already in review, and only one can be open at a time.`
      );
    throw err;
  }

  if (storage.cleaned)
    reportIntakeCleaningIssue({
      key: storage.failed
        ? "work-intake:cleaning-failed:console-update"
        : "work-intake:cleaned:console-update",
      subject: storage.failed
        ? "A /work update (console) was cleaned but NO archive could be stored"
        : "Credential-shaped content cleaned from a /work update (console)",
      detail: [
        `update row ${child.id} for card ${row.id} (${title})`,
        `submitter ${email}`,
        `cleaned: ${storage.cleanedPaths.join(", ")}`,
        ...(storage.failed ? [`archive NOT stored: ${storage.failed}`] : []),
      ].join("\n"),
      emailed: false,
    });

  if (storage.archiveData)
    await storeArchiveFiles(child.id, title, [
      { name: name.slice(0, 200), data: storage.archiveData },
      ...(mdForRow ? [{ name: mdForRow.name, data: mdForRow.data }] : []),
    ]);

  console.log(`\nCreated ${child.id}`);
  console.log(`  status  ${child.status}`);
  console.log(`  updates ${row.id} ("${title}")`);
  console.log(`  auto    ${args.autoApprove ? "approve armed" : "needs the admin click"}`);
  console.log(
    `\nNo panel was kicked, deliberately: a run started in this short-lived process would die with the ssh session. The site's queue drain (src/lib/work/queue-drain.ts, 60 s tick, oldest first) takes the row under its own unchanged admission gates. Watch it at /work/submit or /admin/work.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
