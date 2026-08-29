#!/usr/bin/env -S npx tsx
// File a /work submission from the command line, EXACTLY as
// POST /api/work/submissions files one for a signed-in @xl.net admin
// (§5.16 intake). The scripted twin of the create route, in the same family
// as scripts/work-transfer.ts (twin of POST .../transfer) and
// scripts/work-archive-import.ts.
//
// WHY THIS EXISTS (2026-08-29): the owner is submitting a dozen of his own
// code repositories as .zip packages. Every other lane needs something a
// headless session cannot produce: the web form needs a browser session
// (Google/Microsoft OAuth, a cookie, a CSRF origin), and the email lane
// caps out well below what a 100 MB repository weighs. So this is the lane.
//
// NOTHING IS RE-IMPLEMENTED. Every gate, band, message and ladder step is
// the route's own: inspectArchive / inspectBareMd / mergeSkillCorpus /
// skillDocFailureMessage (work/extract.ts), createSubmission /
// normalizeTitle / activeTitleClash / publishedTitleClash / countCreatedToday
// / userIdForEmail / isUniqueViolation (work/db.ts), storeArchiveFiles
// (work/archive-store.ts), staticTitles (work/static-titles.json),
// splitMachineEcho (work/names.ts), TITLE_KIND_PREFIX_RE + WORK_CAPS +
// MISSING_ARCH_DOC_MESSAGE (work/config.ts), parseTimeSavedHours
// (work/time-saved.ts), isAdmin (@aicompany/core/auth/guard). The pure
// decisions and the route's own refusal sentences live in
// scripts/lib/work-submit-ops.ts, unit-tested with no database by
// scripts/work-submit-tests.ts, and SUBMIT_GATES there holds the route's
// gate ORDER as data so this script cannot silently reorder or drop one.
//
// THE ROW IT WRITES is a staff-lane web submission: company_id null,
// user_id resolved from the users table for the submitter address when an
// account exists (null is legitimate and is what the email lane stores),
// submitter_email = --email (default: the first ADMIN_EMAIL entry),
// submitter_name = --attribution or null, creator_email stamped by
// createSubmission. Then storeArchiveFiles writes the durable store copy
// with the package at slot 0 and the standalone document at slot 1, exactly
// as the route does.
//
// ---- DELIBERATELY NOT REPRODUCED, and why ----
//
//  1. Session auth (requireWorkUser). There is no session to read and no
//     browser to mint one; that is the whole reason this script exists. What
//     the gate IMPLIES is reproduced instead: the row is filed in the public
//     lane (company_id null) and --email must be an address in
//     WORK_SUBMIT_DOMAINS, so this can never produce a row the site itself
//     could not have produced. A company's private lane is out of scope
//     entirely (it needs a trusted session, companyById, the paused/eligible
//     checks and the per-company daily quota, none of them reproduced).
//  2. CSRF origin checking. A defence against a browser being made to POST
//     with the user's cookie. There is no browser, no cookie and no
//     cross-origin request here; the operator is the origin.
//  3. The in-memory rate limiter (rateLimit, 10 upload attempts/user/hour).
//     A per-fork CPU guard against upload hammering in the running site
//     process. This is a separate short-lived process, so it does not even
//     share that counter, and one operator-driven upload per invocation is
//     not the hammering it guards against. The DURABLE bound is reproduced:
//     countCreatedToday against the same daily quota, which is the gate that
//     actually protects the pipeline.
//  4. The Content-Length precheck. It exists to refuse an oversized body
//     BEFORE req.formData() buffers the whole multipart request into the
//     site fork's memory. There is no request and no multipart body; the
//     file is read from disk, and the true byte caps (WORK_CAPS.uploadMaxBytes
//     and skillMdMaxBytes), which the route itself calls authoritative, ARE
//     enforced below.
//  5. brainHealthy(). The route refuses to accept into a dead pipeline
//     because it kicks the panel synchronously on the very next lines, so a
//     row accepted during a brain outage would be a row that immediately
//     fails to start. This script does not kick (see below). The row is left
//     at "received" for the VM's queue drain, whose kickPanel admission
//     gates INCLUDE brain health, so a row filed while the brain is down
//     simply waits and starts when it returns. Refusing here would throw
//     away a perfectly good row and make the operator re-upload a 100 MB
//     package for a condition that resolves itself.
//  6. The panel kick (kickPanel + after(run) + noteQueueWait). DEFAULT AND
//     ONLY BEHAVIOUR: no kick. The row is created at status "received" and
//     the site process's own queue drain (src/lib/work/queue-drain.ts, a
//     60 s tick inside the running server, oldest-first) picks it up under
//     its UNCHANGED gates. Verified against queuedWorkCandidates: it selects
//     rows with held_at null, created_at older than 30 s, status "received",
//     ordered by created_at, which is exactly the row this script writes. A
//     panel run started here would be a child of a short-lived tsx process
//     and would be killed the moment the operator's ssh session ended,
//     stranding the row mid-run at "running" until the drain reclaimed it as
//     a stale heartbeat, so kicking from here would be strictly worse than
//     not kicking. There is no --kick flag on purpose.
//
// Runs ON THE PROD VM (DATABASE_URL and the archive store's disk resolve
// only there). Refuses to run as root for the same reason work:backfill and
// work:import do.
//
// Usage:
//   npm run work:submit -- --title "<title>" --file <package.zip>
//                          [--md <doc.md>] [--blurb-file <file>]
//                          [--email adam@xl.net] [--attribution <FirstName>]
//                          [--time-saved <hours>] [--dry-run] [--yes]
//
//   --title        the card title, 4 to 60 chars, just the tool's name
//   --file         the package (.zip or .skill), up to 100 MB
//   --md           the standalone reviewed document (.md/.mdx/.markdown,
//                  up to 1 MB); OPTIONAL, and taken from every submission,
//                  not only Skills
//   --blurb-file   a file holding the optional description (context only,
//                  never published); absent = empty, which is legal
//   --email        who is submitting; default the first ADMIN_EMAIL entry
//   --attribution  public credit, a single first name; absent = the XL.net
//                  team
//   --time-saved   self-reported hours saved per month; absent = not
//                  reported
//   --dry-run      run every gate and the whole inspection, print the
//                  verdict, write NOTHING to the database or the store
//   --yes          skip the confirm prompt
//
// Exit 0 when the row was created (or when --dry-run finished clean), 1 on
// any refusal or failure. A refusal here is a failure, not a disclosure:
// this files ONE submission, so nothing else was going to happen anyway.

import "dotenv/config";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { isAdmin } from "@aicompany/core/auth/guard";
import {
  MISSING_ARCH_DOC_MESSAGE,
  WORK_CAPS,
  type WorkKind,
} from "../src/lib/work/config";
import { kindVerdictSentence } from "../src/lib/work/classify";
import {
  activeTitleClash,
  countCreatedToday,
  createSubmission,
  isUniqueViolation,
  publishedTitleClash,
  userIdForEmail,
} from "../src/lib/work/db";
import {
  inspectArchive,
  inspectBareMd,
  mergeSkillCorpus,
  skillDocFailureMessage,
  type ExtractOk,
  type ExtractResult,
} from "../src/lib/work/extract";
import { storeArchiveFiles, archiveStoreRoot } from "../src/lib/work/archive-store";
import { decideStorage } from "../src/lib/work/cleaning";
import { INTERNAL_SCOPE } from "../src/lib/work/scope";
import { parseTimeSavedHours } from "../src/lib/work/time-saved";
import {
  DISABLED_MESSAGE,
  PACKAGE_MISSING_MESSAGE,
  PUBLISHED_CLASH_MESSAGE,
  SUBMIT_GATES,
  SUBMIT_USAGE,
  activeClashMessage,
  blurbRefusal,
  clip,
  dailyQuotaFor,
  docBaseName,
  isDocFailure,
  kindRefusalText,
  machineEchoRefusal,
  mdNameRefusal,
  mdSizeRefusal,
  outerLevelOnly,
  packageBytesRefusal,
  packageNameRefusal,
  packageSizeRefusal,
  parseAttribution,
  parseSubmitArgs,
  quotaRefusal,
  readBlurb,
  rescueApplies,
  rescuePassMessage,
  resolveSubmitterEmail,
  standaloneDocMessage,
  staticTitleClash,
  storedName,
  titleBandRefusal,
  titlePrefixRefusal,
  uniqueViolationMessage,
  workSubmissionsEnabled,
} from "./lib/work-submit-ops";

function die(msg: string, code = 1): never {
  console.error(`[work-submit] ${msg}`);
  process.exit(code);
}

/** The console twin of the route's workError(): one submitter-facing
 * sentence, the HTTP status the web lane would have returned so the two can
 * be matched line for line, and the machine code. `paths` and `instructions`
 * are printed only where the route attaches them. */
function refuse(
  status: number,
  code: string,
  message: string,
  extra?: { paths?: string[]; instructions?: string }
): never {
  console.error(`\n[work-submit] REFUSED ${status} ${code}`);
  console.error(`  ${message}`);
  if (extra?.paths?.length)
    for (const p of extra.paths) console.error(`  path: ${p}`);
  if (extra?.instructions) console.error(`  instructions: ${extra.instructions}`);
  console.error(`\nNothing was written to the database or the archive store.`);
  process.exit(1);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readFileOrDie(label: string, path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (err) {
    die(`cannot read ${label} ${path}: ${errMessage(err)}`);
  }
}

function sizeOrDie(label: string, path: string): number {
  try {
    const st = statSync(path);
    if (!st.isFile()) die(`${label} ${path} is not a regular file`);
    return st.size;
  } catch (err) {
    die(`cannot stat ${label} ${path}: ${errMessage(err)}`);
  }
}

async function main(): Promise<void> {
  if (typeof process.getuid === "function" && process.getuid() === 0)
    die(
      "Refusing to run as root: store files must be owned by the user the site runs as (run this as the deploy user), or admin cleanup could never unlink them."
    );

  const parsed = parseSubmitArgs(process.argv.slice(2));
  if (!parsed.ok) die(`${parsed.error}\n\n${SUBMIT_USAGE}`);
  const args = parsed.args;

  const who = resolveSubmitterEmail(args.email, process.env);
  if (!who.ok) die(who.error);
  const email = who.email;
  const admin = isAdmin(email);

  const filePath = resolve(args.file);
  const mdPath = args.md === null ? null : resolve(args.md);

  console.log(`Mode:    ${args.dryRun ? "DRY RUN (no writes)" : "LIVE"}`);
  console.log(`Lane:    public /work (company_id null), staff lane`);
  console.log(
    `From:    ${email}${who.fromDefault ? " (first ADMIN_EMAIL entry)" : ""}${admin ? " · ADMIN_EMAIL member" : " · not an ADMIN_EMAIL member"}`
  );
  console.log(`Title:   ${args.title}`);
  console.log(`Package: ${filePath}`);
  console.log(`Doc:     ${mdPath ?? "(none attached; the package must carry it)"}`);
  console.log(`Store:   ${resolve(archiveStoreRoot())}`);
  console.log(`Gates:   ${SUBMIT_GATES.length}, in the route's order:`);
  for (const g of SUBMIT_GATES)
    console.log(`  route ${g.route.padEnd(8)} ${g.id.padEnd(22)} ${g.what}`);
  console.log("");

  // The description file is READ here (the route's multipart body arrives
  // whole too) but GATED in the route's position below.
  let blurb: string;
  try {
    blurb = readBlurb(args.blurbFile);
  } catch (err) {
    die(`cannot read --blurb-file ${args.blurbFile}: ${errMessage(err)}`);
  }

  // ── gate: kill_switch (route 219-224) ────────────────────────────
  if (!workSubmissionsEnabled(process.env))
    refuse(503, "disabled", DISABLED_MESSAGE);

  // ── gate: daily_quota (route 239-249) ────────────────────────────
  // The route's THIRD gate, ahead of every title check. Counted on
  // creator_email, so a transferred row never charges the recipient.
  const quota = dailyQuotaFor(admin);
  const createdToday = await countCreatedToday(email);
  const quotaMsg = quotaRefusal(createdToday, quota);
  if (quotaMsg) refuse(429, "quota", quotaMsg);

  // ── gate: title_band (route 299-307) ─────────────────────────────
  const title = args.title.trim();
  const bandMsg = titleBandRefusal(title);
  if (bandMsg) refuse(400, "invalid_request", bandMsg);

  // ── gate: title_kind_prefix (route 311-316) ──────────────────────
  const prefixMsg = titlePrefixRefusal(title);
  if (prefixMsg) refuse(400, "invalid_request", prefixMsg);

  // ── gate: title_machine_echo (route 323-328) ─────────────────────
  const echoMsg = machineEchoRefusal(title);
  if (echoMsg) refuse(400, "invalid_request", echoMsg);

  // ── gate: blurb_max (route 333-338) ──────────────────────────────
  const blurbMsg = blurbRefusal(blurb);
  if (blurbMsg) refuse(400, "invalid_request", blurbMsg);

  // ── gate: time_saved (route 350-351) ─────────────────────────────
  // args.timeSaved is null when the flag is absent, which is exactly what
  // form.get() returns for an omitted field: a successful parse to null.
  const timeSaved = parseTimeSavedHours(args.timeSaved);
  if (!timeSaved.ok) refuse(400, "invalid_request", timeSaved.message);

  // ── gate: published_title_clash (route 355-367) ──────────────────
  if (staticTitleClash(title) || (await publishedTitleClash(title, INTERNAL_SCOPE)))
    refuse(409, "duplicate_title", PUBLISHED_CLASH_MESSAGE);

  // ── gate: active_title_clash (route 368-381) ─────────────────────
  const clash = await activeTitleClash(title, INTERNAL_SCOPE);
  if (clash)
    refuse(409, "duplicate_title", activeClashMessage(title, clash, email));

  // ── gate: attribution (route 385-397) ────────────────────────────
  const credit = parseAttribution(args.attribution);
  if (!credit.ok) refuse(400, "invalid_request", credit.message);
  const attribution = credit.attribution;

  // ── gate: package_present / package_ext / package_size (405-424) ─
  const declaredSize = sizeOrDie("--file", filePath);
  if (declaredSize === 0) refuse(400, "invalid_request", PACKAGE_MISSING_MESSAGE);
  const name = storedName(basename(filePath), "upload");
  const extMsg = packageNameRefusal(name);
  if (extMsg) refuse(400, "invalid_request", extMsg);
  const sizeMsg = packageSizeRefusal(declaredSize);
  if (sizeMsg) refuse(400, "invalid_request", sizeMsg);

  // ── gate: package_bytes (route 425-427) ──────────────────────────
  const bytes = readFileOrDie("--file", filePath);
  const bytesMsg = packageBytesRefusal(bytes.length);
  if (bytesMsg) refuse(400, "invalid_request", bytesMsg);
  // No magic-byte gate, exactly as the route has none (owner directive
  // 2026-08-05): inspectArchive attempts the parse and nonZipMessage names
  // what the bytes actually are when it fails.

  // ── gate: md_ext / md_size (route 445-459) ───────────────────────
  let mdFile: { name: string; bytes: Buffer } | null = null;
  if (mdPath !== null) {
    const mdSize = sizeOrDie("--md", mdPath);
    // A zero-byte --md is the `md.size > 0` arm: the route treats it as no
    // document at all rather than refusing, so the package must carry one.
    if (mdSize > 0) {
      const mdName = storedName(basename(mdPath), "SKILL.md");
      const mdExtMsg = mdNameRefusal(mdName);
      if (mdExtMsg) refuse(400, "invalid_request", mdExtMsg);
      const mdSizeMsg = mdSizeRefusal(mdSize);
      if (mdSizeMsg) refuse(400, "invalid_request", mdSizeMsg);
      mdFile = { name: mdName, bytes: readFileOrDie("--md", mdPath) };
    } else {
      console.log(
        `NOTE: ${mdPath} is empty, so it is treated as no standalone document at all (the route's md.size > 0 arm). The package must carry the reviewed document.`
      );
    }
  }

  // ── gate: inspect_archive (route 465) ────────────────────────────
  // null kind, so classify.ts decides from the files. The kind that comes
  // back is the one stored on the row.
  const extracted: ExtractResult = await inspectArchive(bytes, null, {
    packageName: name,
  });

  // ── gate: standalone_doc (route 473) ─────────────────────────────
  // Validated exactly ONCE, and deliberately AFTER the package walk: an
  // archive carrying credentials must keep refusing with the secrets
  // message, which is the one to act on fastest.
  const mdExtract = mdFile ? inspectBareMd(mdFile.name, mdFile.bytes) : null;

  // ── gate: kind_ladder (route 475-543) ────────────────────────────
  let pkg: ExtractOk;
  let kind: WorkKind;
  let rescued = false;
  if (extracted.ok) {
    pkg = extracted;
    kind = extracted.kind;
  } else if (mdExtract && rescueApplies(extracted)) {
    // The standalone-document rescue. A second walk with the kind PINNED to
    // "skill" purely to get a manifest and a corpus back; `kind` stays the
    // FIRST pass's inferred one, so a rescued program is stored and reviewed
    // as a program.
    if (!mdExtract.ok)
      refuse(422, mdExtract.code, standaloneDocMessage(mdExtract), {
        ...(mdExtract.paths ? { paths: mdExtract.paths } : {}),
        instructions: standaloneDocMessage(mdExtract),
      });
    const rescue = await inspectArchive(bytes, "skill", { packageName: name });
    // A rescue supplies a missing document; it never launders an archive.
    if (!rescue.ok)
      refuse(422, rescue.code, rescuePassMessage(rescue, name), {
        ...(rescue.paths ? { paths: rescue.paths } : {}),
      });
    pkg = outerLevelOnly(rescue);
    // rescueApplies has already established extracted.kind === "program";
    // TypeScript cannot narrow through a helper, hence the assertion. The
    // pinned kind is a MEANS, never a result: this is the FIRST pass's
    // inferred kind, so a rescued program is stored and reviewed as one.
    kind = extracted.kind as WorkKind;
    rescued = true;
  } else {
    const docFailure = isDocFailure(extracted);
    refuse(
      422,
      extracted.code,
      docFailure
        ? kindRefusalText(extracted.kindVerdict, extracted.message)
        : extracted.message,
      {
        ...(extracted.paths ? { paths: extracted.paths } : {}),
        ...(docFailure ? { instructions: MISSING_ARCH_DOC_MESSAGE } : {}),
      }
    );
  }

  // ── gate: doc_precedence (route 545-598) ─────────────────────────
  // A standalone upload always wins; else the package's resolved doc; else
  // the skill ladder's doc-resolution failure, which only a standalone could
  // have rescued, so with neither it refuses here.
  let docText = pkg.docText;
  let docSource: string;
  let corpus = pkg.corpus;
  let mdMeta:
    | { name: string; sha256: string; bytes: number; data: Buffer }
    | undefined;
  if (mdFile && mdExtract) {
    if (!mdExtract.ok)
      refuse(422, mdExtract.code, standaloneDocMessage(mdExtract), {
        ...(mdExtract.paths ? { paths: mdExtract.paths } : {}),
        instructions: standaloneDocMessage(mdExtract),
      });
    docText = mdExtract.docText;
    docSource = `the standalone --md upload (${mdFile.name})`;
    // mergeSkillCorpus is kind-blind in what it does (standalone first, then
    // the package's texts minus byte-identical duplicates, under the cap),
    // so it is the merge for a rescued program too.
    corpus = mergeSkillCorpus(mdExtract, pkg);
    mdMeta = {
      name: mdFile.name.slice(0, 200),
      sha256: mdExtract.archiveSha256,
      bytes: mdFile.bytes.length,
      data: mdFile.bytes,
    };
  } else if (pkg.docMissing) {
    // Only the skill ladder returns ok-with-docMissing, so this is the Skill
    // refusal, and it discloses the verdict: the submitter never said
    // "Skill", the files did.
    const message = skillDocFailureMessage(pkg.docMissing);
    refuse(
      422,
      `skill_doc_${pkg.docMissing}`,
      kindRefusalText(pkg.kindVerdict, message),
      {
        ...(pkg.candidatePaths ? { paths: pkg.candidatePaths } : {}),
        instructions: message,
      }
    );
  } else if (kind === "skill" && pkg.docRawBytes) {
    // Doc came from inside the package: retention still carries it as its own
    // attachment (md_* backfilled from the untruncated raw bytes). Skill
    // only, exactly as the route has it.
    const docBase = docBaseName(pkg.docPath);
    docSource = `inside the package (${pkg.docPath}), md_* backfilled from its raw bytes`;
    mdMeta = {
      name: docBase.slice(0, 200),
      sha256: createHash("sha256").update(pkg.docRawBytes).digest("hex"),
      bytes: pkg.docRawBytes.length,
      data: pkg.docRawBytes,
    };
  } else {
    docSource = `inside the package (${pkg.docPath})`;
  }

  // ── The verdict, printed for both modes ──────────────────────────
  console.log(`\n== Inspection verdict ==`);
  console.log(`Kind:          ${kind}${rescued ? " (rescued by the standalone document)" : ""}`);
  console.log(`Why:           ${kindVerdictSentence(pkg.kindVerdict)}`);
  if (rescued)
    console.log(
      `               The rescue pass was PINNED to "skill" to recover a manifest and a corpus; the stored kind is the first pass's inferred one (${kind}), and inner-archive paths are filtered out of both.`
    );
  console.log(`Reviewed doc:  ${docSource}`);
  console.log(`Manifest:      ${pkg.manifest.length} entries${pkg.manifestTruncated ? ` (truncated at ${WORK_CAPS.manifestMaxEntries})` : ""}`);
  console.log(`Corpus:        ${corpus.length} entries, ${corpus.reduce((n, c) => n + c.text.length, 0)} chars`);
  console.log(`Archive:       ${pkg.archiveSha256}`);
  console.log(`               ${pkg.archiveBytes} bytes, stored as ${name}`);
  if (mdMeta)
    console.log(
      `Standalone md: ${mdMeta.name}, ${mdMeta.bytes} bytes, sha256 ${mdMeta.sha256}`
    );
  console.log(`Time saved:    ${timeSaved.minutes === null ? "not reported" : `${timeSaved.minutes} minutes/month`}`);
  console.log(`Credit:        ${attribution ?? "(none; the card credits the XL.net team)"}`);
  console.log(`Description:   ${blurb.length} chars${blurb.length === 0 ? " (empty, which is legal)" : ""}`);
  console.log(`\n---- first 400 characters of the reviewed document ----`);
  console.log(clip(docText, 400));
  console.log(`-------------------------------------------------------`);

  if (args.dryRun) {
    console.log(
      `\nDRY RUN: every gate passed and the inspection completed. NOTHING was written to the database or to the archive store. Re-run without --dry-run to file it.`
    );
    process.exit(0);
  }

  // ── The write ────────────────────────────────────────────────────
  const userId = await userIdForEmail(email);
  console.log(
    `\nuser_id:  ${userId ?? "null (no site account for this address; legitimate, and what the email lane stores)"}`
  );

  if (!args.yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(
      `\n[work-submit] file "${title}" as ${email} in the public /work lane? Type yes: `
    );
    rl.close();
    if (answer.trim().toLowerCase() !== "yes") die("aborted", 0);
  }

  // THE SAME STORAGE DECISION THE OTHER THREE LANES MAKE (§5.16 cleaning,
  // 2026-08-29). This script is a fourth intake lane and it was missed when
  // cleaning shipped, which turned it into the round's own worst case: the
  // walk stopped REFUSING credential-bearing uploads, so this lane started
  // accepting them, and it was still writing the SUBMITTED buffer into the
  // row bytea and the durable store, and mailing it to ADMIN_EMAIL at
  // publish. A repo full of .env files is exactly what this script is for.
  const storage = decideStorage({
    pkg,
    submittedArchive: bytes,
    // Only the standalone-upload branch carries its own cleaning record; when
    // the reviewed doc came out of the package, mdMeta.data is already the
    // cleaned buffer and mdData below falls through to it.
    md:
      mdFile && mdExtract?.ok
        ? { extract: mdExtract, submitted: mdFile.bytes }
        : null,
  });
  const mdForRow = mdMeta
    ? { ...mdMeta, data: storage.mdData ?? mdMeta.data }
    : undefined;
  if (storage.cleaned) {
    console.log(
      `\n[work-submit] CLEANED at intake before storing (${storage.cleanedCount} file(s)):`
    );
    for (const cp of storage.cleanedPaths) console.log(`    ${cp}`);
    if (storage.failed)
      console.log(
        `  !! the cleaned rebuild could not be verified (${storage.failed}), so NO archive is being stored for this row.`
      );
    console.log(
      `  Rotate anything real in them: they were read from disk as they are.`
    );
  }

  let row;
  try {
    row = await createSubmission({
      companyId: null,
      userId,
      email,
      name: attribution,
      kind,
      title,
      blurb,
      timeSavedMinutes: timeSaved.minutes,
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
    });
  } catch (err) {
    // ── gate: unique_violation (route 626-638) ─────────────────────
    // The partial unique index closes the race the pre-check leaves open;
    // isUniqueViolation walks the cause chain because drizzle wraps the
    // PostgresError.
    if (isUniqueViolation(err, "work_sub_active_title_uq"))
      refuse(409, "duplicate_title", uniqueViolationMessage(title));
    throw err;
  }

  // Durable second copy at accept time, the route's call verbatim: package
  // at slot 0, standalone document at slot 1. Never throws; a store failure
  // logs and leaves the row's bytea as the copy.
  if (storage.archiveData)
    await storeArchiveFiles(row.id, title, [
      { name: name.slice(0, 200), data: storage.archiveData },
      ...(mdForRow ? [{ name: mdForRow.name, data: mdForRow.data }] : []),
    ]);

  console.log(`\nCreated ${row.id}`);
  console.log(`  status ${row.status}`);
  console.log(`  kind   ${row.kind}`);
  console.log(`  owner  ${row.submitterEmail}`);
  console.log(
    `\nNo panel was kicked, deliberately. The site process's queue drain (src/lib/work/queue-drain.ts, 60 s tick, oldest-first) will pick this row up once it is more than 30 seconds old and start the panel under its own unchanged gates: kill switch, deploy window, brain health, both budget ledgers, one panel at a time, and the per-row 3-runs-per-day claim cap. A panel started from this short-lived process would be killed when your ssh session ends and would strand the row at "running" until the drain reclaimed the stale heartbeat.`
  );
  console.log(
    `Watch it at /work/submit (the submitter's list) or /admin/work, and the archive store copy at /admin/work#storage.`
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
