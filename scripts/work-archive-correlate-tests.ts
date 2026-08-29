// Tests for the §5.16 external-recovery correlation helpers
// (scripts/lib/work-archive-correlate.ts): armor decode against the real
// retention encoder, screened-name rules, per-slot coverage verdicts,
// recovery planning (provenance rules), the unmatched-local grouping and
// the bounded SKILL.md name sniff. Run: npm run test:correlate (tsx, no
// DB, no brain).

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { toDeliverableAttachment } from "../src/lib/work/retention-encoding";
import { storedRelPath } from "../src/lib/work/archive-naming";
import {
  DEFAULT_MD_NAME,
  MD_SLOT,
  PACKAGE_SLOT,
  decodeArmor,
  frontmatterName,
  importCommand,
  isArmorName,
  isScreenedName,
  knownShas,
  localName,
  planRecovery,
  planSlotRecovery,
  preferLocal,
  recordedSlots,
  shellQuote,
  slotCoverage,
  sniffSkillName,
  unarmoredName,
  unmatchedLocal,
  unscreenedName,
  type LedgerFacts,
  type LocalEntry,
  type LocalIndex,
  type RowFacts,
} from "./lib/work-archive-correlate";

const ID = "3b0d3b0e-6d9f-4f3e-9b7a-1f2e3d4c5b6a";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

function row(over: Partial<RowFacts> = {}): RowFacts {
  return {
    id: ID,
    title: "Ticket Triage",
    status: "published",
    createdAt: "2026-07-31T12:00:00.000Z",
    archiveName: "triage.skill",
    archiveSha256: SHA_A,
    archiveBytes: 100,
    mdName: "SKILL.md",
    mdSha256: SHA_B,
    mdBytes: 50,
    hasArchive: false,
    hasMd: false,
    ...over,
  };
}

function ledger(over: Partial<LedgerFacts> = {}): LedgerFacts {
  return {
    relPath: storedRelPath(ID, PACKAGE_SLOT, "triage.skill"),
    fileName: "triage.skill",
    bytes: 100,
    sha256: SHA_A,
    deleted: false,
    ...over,
  };
}

function entry(over: Partial<LocalEntry> & { path: string }): LocalEntry {
  return { bytes: 100, sha256: SHA_A, source: "file", ...over };
}

function indexOf(...entries: LocalEntry[]): LocalIndex {
  const m: LocalIndex = new Map();
  for (const e of entries) {
    const list = m.get(e.sha256);
    if (list) list.push(e);
    else m.set(e.sha256, [e]);
  }
  return m;
}

async function main() {
  // ---- names ---------------------------------------------------------
  assert.ok(isArmorName("x.skill.b64.txt"));
  assert.ok(isArmorName("X.ZIP.B64.TXT"));
  assert.ok(!isArmorName("x.skill"));
  assert.ok(!isArmorName("x.b64.txt.skill"));
  assert.equal(unarmoredName("x.skill.b64.txt"), "x.skill");
  assert.equal(unarmoredName("plain.md"), "plain.md");
  assert.ok(isScreenedName("gap.screened.skill"));
  assert.ok(isScreenedName("gap_1_.screened.skill.b64.txt"));
  assert.ok(!isScreenedName("screened-report.skill"), "the marker is the dotted infix, not the word");
  assert.equal(unscreenedName("gap.screened.skill"), "gap.skill");
  assert.equal(localName(entry({ path: "/x/SKILL (3).md" })), "SKILL_3_.md");

  // ---- armor decode round-trip against the REAL encoder ----------------
  // n=0 is asserted below: an empty decode is null by rule (F4), not a round-trip.
  for (const n of [1, 2, 3, 4, 56, 57, 58, 100, 3000, 4097]) {
    const data = Buffer.alloc(n);
    for (let i = 0; i < n; i++) data[i] = (i * 7 + 3) & 0xff;
    // a .skill name armors at every size (a text name would attach an empty file raw)
    const att = toDeliverableAttachment({ name: `f${n}.skill`, data });
    assert.ok(att.encoded, `n=${n} armored`);
    const armorText = Buffer.from(att.contentBase64, "base64").toString("utf8");
    assert.ok(armorText.endsWith("\n"), "76-column armor ends in a newline");
    const back = decodeArmor(armorText);
    assert.ok(back !== null, `n=${n} decodes`);
    assert.ok(back.equals(data), `n=${n} round-trips`);
  }
  // Re-wrapped / CRLF / tab-mangled armor still decodes.
  const src = Buffer.from("hello, armor world!!");
  const b64 = src.toString("base64");
  assert.ok(decodeArmor(b64.replace(/(.{5})/g, "$1\r\n\t "))?.equals(src));
  // Not clean base64 -> null.
  assert.equal(decodeArmor("this is a SKILL.md, not base64"), null);
  assert.equal(decodeArmor("abc"), null, "length not a multiple of 4");
  assert.equal(decodeArmor("ab=c"), null, "padding in the middle");
  assert.equal(decodeArmor("abcd==="), null, "over-padded");
  assert.equal(decodeArmor("---\nname: x\n---\n"), null);
  assert.equal(decodeArmor("PK"), null, "raw zip bytes are not armor");
  assert.equal(decodeArmor("\n"), null, "an empty decode is never a recovered artifact (the encoder's empty-input armor included)");
  assert.equal(decodeArmor(""), null);

  // ---- recorded slots ---------------------------------------------------
  assert.deepEqual(recordedSlots(row()), [PACKAGE_SLOT, MD_SLOT]);
  assert.deepEqual(recordedSlots(row({ mdName: null, mdSha256: null })), [PACKAGE_SLOT]);
  assert.deepEqual(recordedSlots(row({ archiveName: null, archiveSha256: null })), [MD_SLOT]);
  assert.deepEqual(
    recordedSlots(row({ archiveName: null, archiveSha256: null, mdName: null, mdSha256: null })),
    []
  );
  assert.deepEqual(recordedSlots(row({ archiveName: null })), [PACKAGE_SLOT, MD_SLOT], "a sha alone records the slot");

  // ---- slot coverage ----------------------------------------------------
  {
    const c = slotCoverage(row({ hasArchive: true, hasMd: true }), []);
    assert.deepEqual(c.map((s) => s.verdict), ["row-bytes", "row-bytes"]);
    assert.equal(c[0].relPath, `${ID}/00-triage.skill`);
    assert.equal(c[1].relPath, `${ID}/01-SKILL.md`);
  }
  {
    // store-live by sha, even under another rel_path (noted).
    const c = slotCoverage(row(), [ledger(), ledger({ relPath: `${ID}/07-SKILL.md`, fileName: "SKILL.md", bytes: 50, sha256: SHA_B })]);
    assert.deepEqual(c.map((s) => s.verdict), ["store-live", "store-live"]);
    assert.equal(c[0].note, null);
    assert.match(c[1].note ?? "", /07-SKILL\.md/);
  }
  {
    // store-live by rel_path when the row records no sha.
    const c = slotCoverage(row({ archiveSha256: null, mdName: null, mdSha256: null }), [ledger({ sha256: SHA_C })]);
    assert.deepEqual(c.map((s) => s.verdict), ["store-live"]);
    assert.equal(c[0].note, null);
    // ... and a live file at the path whose sha differs from a RECORDED sha
    // is store-MISMATCH (the store holds the wrong bytes), noted with the
    // sha it actually has.
    const d = slotCoverage(row({ mdName: null, mdSha256: null }), [ledger({ sha256: SHA_C })]);
    assert.equal(d[0].verdict, "store-mismatch");
    assert.match(d[0].note ?? "", new RegExp(`hashes to ${SHA_C}, not the recorded ${SHA_A}`));
    assert.ok(!/refuses rows with ledger rows/.test(d[0].note ?? ""), "the per-slot gate wording, not the stale whole-row one");
  }
  {
    // admin-deleted: only deleted rows at the slot's rel_path (or sha).
    const c = slotCoverage(row(), [
      ledger({ deleted: true }),
      ledger({ relPath: `${ID}/01-SKILL.md`, fileName: "SKILL.md", bytes: 50, sha256: SHA_B, deleted: true }),
    ]);
    assert.deepEqual(c.map((s) => s.verdict), ["admin-deleted", "admin-deleted"]);
    // a deleted row at ANOTHER slot does not cover this one
    const d = slotCoverage(row({ mdName: null, mdSha256: null }), [
      ledger({ relPath: `${ID}/01-SKILL.md`, fileName: "SKILL.md", bytes: 50, sha256: SHA_B, deleted: true }),
    ]);
    assert.deepEqual(d.map((s) => s.verdict), ["missing"]);
  }
  {
    // missing: no bytea, no ledger trace; default names when none recorded.
    const c = slotCoverage(row({ archiveName: null, mdName: null }), []);
    assert.deepEqual(c.map((s) => s.verdict), ["missing", "missing"]);
    assert.equal(c[0].name, "upload.zip");
    assert.equal(c[1].name, DEFAULT_MD_NAME);
  }

  // ---- recovery planning ------------------------------------------------
  const cov = (over: Partial<RowFacts> = {}) => slotCoverage(row(over), []);
  {
    // plain file preferred over decoded armor, then shortest path.
    const decoded = entry({ path: "/r/.decoded/triage.skill", source: "decoded-armor", armorPath: "/r/triage.skill.b64.txt" });
    const longer = entry({ path: "/r/nested/copy/triage (1).skill" });
    const plain = entry({ path: "/r/triage.skill" });
    assert.ok(preferLocal(plain, decoded) < 0);
    assert.ok(preferLocal(plain, longer) < 0);
    assert.ok(preferLocal(decoded, longer) > 0, "a plain file wins even with a longer path");
    const r = planSlotRecovery(cov()[0], indexOf(decoded, longer, plain));
    assert.equal(r.recovery, "recoverable");
    assert.equal(r.ready, true);
    assert.equal(r.file?.path, "/r/triage.skill");
    assert.equal(r.flag, "--file /r/triage.skill");
    // only a decoded armor copy -> still recoverable, pointing at the real file.
    const r2 = planSlotRecovery(cov()[0], indexOf(decoded));
    assert.equal(r2.recovery, "recoverable");
    assert.equal(r2.file?.source, "decoded-armor");
    assert.equal(r2.flag, "--file /r/.decoded/triage.skill");
  }
  {
    // a sha match wins regardless of the local basename (transport junk).
    const r = planSlotRecovery(cov()[1], indexOf(entry({ path: "/r/SKILL (14).md", bytes: 50, sha256: SHA_B })));
    assert.equal(r.recovery, "recoverable");
    assert.equal(r.flag, "--md '/r/SKILL (14).md'");
  }
  {
    // screened-only: a screened copy never satisfies the sha, no --force.
    const screened = entry({ path: "/r/.decoded/triage.screened.skill", bytes: 120, sha256: SHA_C, source: "decoded-armor", armorPath: "/r/triage.screened.skill.b64.txt" });
    const r = planSlotRecovery(cov()[0], indexOf(screened));
    assert.equal(r.recovery, "screened-only");
    assert.equal(r.ready, false);
    assert.equal(r.file, null);
    assert.equal(r.flag, null);
    assert.match(r.reason, /never the original bytes/);
    assert.match(r.reason, /NOT in this folder/);
    assert.ok(!/--force/.test(r.reason));
    // ... even when the row records no sha: a screened copy is not a name match for the unverifiable rung.
    const r2 = planSlotRecovery(cov({ archiveSha256: null, archiveBytes: 120 })[0], indexOf(screened));
    assert.equal(r2.recovery, "screened-only");
    assert.equal(r2.flag, null);
  }
  {
    // unverifiable-name-match: no sha on the row, same sanitized name AND bytes.
    const same = entry({ path: "/r/triage (2).skill", bytes: 100, sha256: SHA_C });
    const r = planSlotRecovery(cov({ archiveSha256: null })[0], indexOf(same));
    assert.equal(r.recovery, "unrecovered", "the basename must sanitize to the recorded name");
    const exact = entry({ path: "/r/dl/triage.skill", bytes: 100, sha256: SHA_C });
    const r2 = planSlotRecovery(cov({ archiveSha256: null })[0], indexOf(exact));
    assert.equal(r2.recovery, "unverifiable-name-match");
    assert.equal(r2.ready, false, "unverifiable never rides the ready block");
    assert.equal(r2.flag, "--file /r/dl/triage.skill", "the eyes-open flag is offered beside the reason");
    assert.equal(r2.file?.path, "/r/dl/triage.skill");
    assert.match(r2.reason, /proves nothing about originality/);
    assert.match(r2.reason, /without hash verification/);
    // wrong byte count -> not a match
    const r3 = planSlotRecovery(cov({ archiveSha256: null })[0], indexOf(entry({ path: "/r/dl/triage.skill", bytes: 101, sha256: SHA_C })));
    assert.equal(r3.recovery, "unrecovered");
    // no recorded byte count -> name alone is not enough
    const r4 = planSlotRecovery(cov({ archiveSha256: null, archiveBytes: null })[0], indexOf(exact));
    assert.equal(r4.recovery, "unrecovered");
    // a recorded sha that does not match is NEVER downgraded to a name match
    const r5 = planSlotRecovery(cov()[0], indexOf(exact));
    assert.equal(r5.recovery, "unrecovered");
    assert.match(r5.reason, /bytes differ: not the original/);
    assert.match(r5.reason, new RegExp(SHA_A));
  }
  {
    // planRecovery: commands cover recoverable slots only, never --force/--yes.
    const rows = [
      row(),
      row({ id: "4c1e4c1f-7e0a-4a4f-8c8b-2a3b4c5d6e7f", title: "Complete", hasArchive: true, hasMd: true }),
      row({ id: "5d2f5d20-8f1b-4b50-9d9c-3b4c5d6e7f80", title: "Half", mdSha256: SHA_C }),
    ];
    const idx = indexOf(
      entry({ path: "/r/triage.skill" }),
      entry({ path: "/r/SKILL.md", bytes: 50, sha256: SHA_B })
    );
    const plan = planRecovery(rows, new Map(), idx);
    assert.equal(plan.length, 3);
    assert.equal(plan[0].open.length, 2);
    assert.ok(plan[0].open.every((m) => m.ready));
    assert.equal(plan[0].command, `npm run work:import -- ${ID} --file /r/triage.skill --md /r/SKILL.md`);
    assert.equal(plan[1].open.length, 0, "row-bytes rows are complete");
    assert.equal(plan[1].command, null);
    assert.equal(plan[2].open.length, 2);
    assert.equal(plan[2].open[1].recovery, "unrecovered");
    assert.equal(plan[2].open[1].ready, false);
    assert.equal(
      plan[2].command,
      "npm run work:import -- 5d2f5d20-8f1b-4b50-9d9c-3b4c5d6e7f80 --file /r/triage.skill",
      "only the recovered slot rides the command"
    );
    for (const p of plan)
      if (p.command) {
        assert.ok(!/--force/.test(p.command), "never --force");
        assert.ok(!/--yes/.test(p.command), "never --yes");
        assert.ok(p.command.startsWith("npm run work:import -- "));
      }
    // ledger facts flow through by row id
    const withLedger = planRecovery([row()], new Map([[ID, [ledger({ deleted: true })]]]), idx);
    assert.equal(withLedger[0].slots[0].verdict, "admin-deleted");
    assert.equal(withLedger[0].open.length, 1, "the deleted package is not searched for");
    assert.equal(withLedger[0].command, `npm run work:import -- ${ID} --md /r/SKILL.md`);

    // F1: store-mismatch. The true original is in the folder and is NAMED,
    // but no command is emitted (the live ledger row refuses the slot) and
    // the row is not complete: it exits 2, not 0.
    const mism = planRecovery([row({ mdName: null, mdSha256: null })], new Map([[ID, [ledger({ sha256: SHA_C })]]]), idx);
    assert.equal(mism[0].open.length, 1, "a mismatched slot is open, the row is not complete");
    const mm = mism[0].open[0];
    assert.equal(mm.verdict, "store-mismatch");
    assert.equal(mm.recovery, "recoverable", "the folder search still runs");
    assert.equal(mm.file?.path, "/r/triage.skill", "the true original is named");
    assert.equal(mm.ready, false);
    assert.equal(mm.flag, null);
    assert.equal(mism[0].command, null, "no command: work:import refuses a slot with a live ledger row");
    assert.match(mm.reason, /delete the wrong store file in the \/admin\/work#storage console first/);
    assert.match(mm.reason, /true original IS in this folder: \/r\/triage\.skill/);
    // ... and when the folder does not hold it either, both facts are said.
    const mism2 = planRecovery([row({ mdName: null, mdSha256: null })], new Map([[ID, [ledger({ sha256: SHA_C })]]]), indexOf());
    assert.equal(mism2[0].open[0].recovery, "unrecovered");
    assert.equal(mism2[0].open[0].ready, false);
    assert.match(mism2[0].open[0].reason, /delete the wrong store file/);
    assert.match(mism2[0].open[0].reason, /no local file hashes to the recorded sha256/);

    // F2: a row that still holds bytea in ANY slot never gets a command:
    // work:import refuses byte-holding rows whole, work:backfill goes first.
    const holds = planRecovery([row({ hasArchive: true })], new Map(), idx);
    assert.equal(holds[0].slots[0].verdict, "row-bytes");
    assert.equal(holds[0].open.length, 1);
    const hm = holds[0].open[0];
    assert.equal(hm.slot, MD_SLOT);
    assert.equal(hm.recovery, "recoverable", "the file IS the original, and stays labelled so");
    assert.equal(hm.file?.path, "/r/SKILL.md");
    assert.equal(hm.ready, false);
    assert.equal(hm.flag, null);
    assert.equal(holds[0].command, null, "command null: the import would be refused");
    assert.match(hm.reason, /work:import refuses byte-holding rows/);
    assert.match(hm.reason, /run npm run work:backfill first/);
    assert.match(hm.reason, /true original IS in this folder: \/r\/SKILL\.md/);
    // the same row with nothing in the folder keeps the backfill-first rule AND the search reason
    const holds2 = planRecovery([row({ hasArchive: true })], new Map(), indexOf());
    assert.match(holds2[0].open[0].reason, /work:backfill first/);
    assert.match(holds2[0].open[0].reason, /no local file hashes/);
  }
  // shell quoting: only when needed, single quotes escaped.
  assert.equal(shellQuote("/r/plain-name_1.skill"), "/r/plain-name_1.skill");
  assert.equal(shellQuote("/r/SKILL (3).md"), "'/r/SKILL (3).md'");
  assert.equal(shellQuote("/r/it's.md"), "'/r/it'\\''s.md'");
  assert.equal(importCommand(ID, ["--file a"]), `npm run work:import -- ${ID} --file a`);

  // ---- unmatched local --------------------------------------------------
  {
    const rows = [row()];
    const led = [ledger({ relPath: `${ID}/02-extra.skill`, fileName: "extra.skill", bytes: 9, sha256: SHA_C, deleted: true })];
    const armorMatched = entry({ path: "/r/triage.skill.b64.txt", bytes: 180, sha256: "d".repeat(64) });
    const decodedMatched = entry({ path: "/r/.decoded/triage.skill", source: "decoded-armor", armorPath: "/r/triage.skill.b64.txt" });
    const armorUnmatched = entry({ path: "/r/other.skill.b64.txt", bytes: 300, sha256: "e".repeat(64) });
    const decodedUnmatched = entry({ path: "/r/.decoded/other.skill", bytes: 200, sha256: "f".repeat(64), source: "decoded-armor", armorPath: "/r/other.skill.b64.txt" });
    const armorBroken = entry({ path: "/r/broken.skill.b64.txt", bytes: 7, sha256: "1".repeat(64) });
    const dupA = entry({ path: "/r/nested/x/queuebot (1).skill", bytes: 33, sha256: "2".repeat(64) });
    const dupB = entry({ path: "/r/queuebot.skill", bytes: 33, sha256: "2".repeat(64) });
    const extraCopy = entry({ path: "/r/extra.skill", bytes: 9, sha256: SHA_C });
    const groups = unmatchedLocal(
      indexOf(armorMatched, decodedMatched, armorUnmatched, decodedUnmatched, armorBroken, dupA, dupB, extraCopy),
      rows,
      led
    );
    const shas = groups.map((g) => g.sha256);
    assert.ok(!shas.includes(SHA_A), "a row-sha match is not unmatched");
    assert.ok(!shas.includes(SHA_C), "a ledger sha (deleted too) is known");
    assert.ok(!shas.includes("d".repeat(64)), "the armor source is hidden when its decoded copy matched");
    assert.ok(!shas.includes("e".repeat(64)), "an unmatched armor's decoded copy is the listed artifact, not the transport");
    assert.ok(shas.includes("f".repeat(64)));
    assert.ok(shas.includes("1".repeat(64)), "an undecodable armor stays listed as itself");
    const dup = groups.find((g) => g.sha256 === "2".repeat(64));
    assert.ok(dup);
    assert.equal(dup.entries.length, 2, "duplicates list together");
    assert.equal(dup.entries[0].path, "/r/queuebot.skill", "best path first");
    assert.equal(dup.bytes, 33);
    assert.deepEqual([...knownShas(rows, led)].sort(), [SHA_A, SHA_B, SHA_C]);
  }

  // ---- SKILL.md name sniff ----------------------------------------------
  assert.equal(frontmatterName("---\nname: ticket-triage\ndescription: x\n---\n# hi"), "ticket-triage");
  assert.equal(frontmatterName("\uFEFF---\r\nname: \"quoted name\"\r\n---\r\n"), "quoted name");
  assert.equal(frontmatterName("---\nauthor:\n  name: nested\n---\n"), null, "nested keys never match");
  assert.equal(frontmatterName("# no front matter\nname: later"), null);
  assert.equal(frontmatterName("---\ndescription: only\n---\n"), null);
  {
    const zip = new JSZip();
    zip.file("deep/a/b/SKILL.md", "---\nname: too-deep\n---\n");
    zip.file("pkg/SKILL.md", "---\nname: right-one\n---\n");
    zip.file("README.md", "---\nname: not-a-skill-file\n---\n");
    const buf = await zip.generateAsync({ type: "nodebuffer" });
    assert.equal(await sniffSkillName("x.skill", buf), "right-one");
    const top = new JSZip();
    top.file("SKILL.md", "---\nname: top\n---\n");
    assert.equal(await sniffSkillName("renamed.bin", await top.generateAsync({ type: "nodebuffer" })), "top", "zip by magic, not by extension");
    const deep = new JSZip();
    deep.file("a/b/c/SKILL.md", "---\nname: deep\n---\n");
    assert.equal(await sniffSkillName("x.zip", await deep.generateAsync({ type: "nodebuffer" })), null, "depth > 2 is not read");
    assert.equal(await sniffSkillName("bad.skill", Buffer.from("PK not really a zip")), null, "a bad zip never throws");
    assert.equal(await sniffSkillName("doc.md", Buffer.from("---\nname: bare\n---\n")), "bare");
    assert.equal(await sniffSkillName("doc.txt", Buffer.from("---\nname: bare\n---\n")), null, "only md reads bare front matter");
    const big = Buffer.concat([Buffer.from("---\n"), Buffer.alloc(70 * 1024, 0x20), Buffer.from("\nname: past-cap\n---\n")]);
    assert.equal(await sniffSkillName("big.md", big), null, "the 64 KB cap holds");
  }

  // ---- source scrape: no em or en dashes in the correlate lane ------------
  const here = dirname(fileURLToPath(import.meta.url));
  for (const f of [
    "lib/work-archive-correlate.ts",
    "work-archive-correlate.ts",
    "work-archive-correlate-tests.ts",
  ]) {
    const text = readFileSync(resolve(here, f), "utf8");
    assert.ok(!/[\u2013\u2014]/.test(text), `no em or en dashes in ${f}`);
  }
  const scriptSrc = readFileSync(resolve(here, "work-archive-correlate.ts"), "utf8");
  // Code lines only (comment lines stripped): --force may be NAMED in the
  // printed disclaimer, never emitted as part of a command.
  const codeLines = scriptSrc.split("\n").filter((l) => !/^\s*\/\//.test(l));
  for (const l of codeLines)
    if (/--force/.test(l))
      assert.ok(/never --force, never --yes/.test(l), `--force only inside the disclaimer: ${l.trim()}`);
  assert.ok(!/pg_try_advisory_lock|ARCHIVE_OPS_LOCK_KEY/.test(scriptSrc), "the correlate script takes no archive-ops lock");
  assert.ok(/lstatSync\(/.test(scriptSrc) && /isSymbolicLink\(\)/.test(scriptSrc), "the walk lstats and skips symlinks");
  const libSrc = readFileSync(resolve(here, "lib/work-archive-correlate.ts"), "utf8");
  assert.ok(!/refuses rows with ledger rows/.test(libSrc + scriptSrc), "the stale whole-row ledger-gate wording is gone (the gate is per slot)");
  const byteaMentions = (scriptSrc.match(/\b(archiveData|mdData)\b/g) ?? []).length;
  const existenceBits = (scriptSrc.match(/\$\{S\.(archiveData|mdData)\} is not null/g) ?? []).length;
  assert.equal(byteaMentions, 2, "both bytea columns are named");
  assert.equal(existenceBits, 2, "bytea columns appear ONLY as existence bits, never selected");
  assert.ok(!/db\s*\.\s*(update|insert|delete|execute|transaction)\(|storeArchiveFiles|verifyAndClearRowBytes|deleteStoredArchive/.test(scriptSrc), "the script writes nothing to the DB or the store");

  console.log("work-archive-correlate-tests: all assertions passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
