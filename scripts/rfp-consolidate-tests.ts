/**
 * Whole-document consolidation scan tests (ARCHITECTURE.md §5.17.16).
 *
 *   npm run test:rfpconsolidate
 *
 * Pure, no server, no DB. Pins the deterministic duplicate scan the
 * consolidation review turn feeds on (normalization, the 0.5 containment
 * threshold on word 8-gram shingles, cross-section-only pairing, the letter
 * and short-paragraph exclusions, cluster ordering and the cap of 12) and
 * the two prompt-line builders' whole-line budget behavior.
 */

import {
  CONSOLIDATE_INSTRUCTION,
  clusterBlockIds,
  consolidationScan,
  findDuplicateClusters,
  formatDuplicateFindings,
  pruneAdmitter,
  pruneGuard,
  requirementLines,
  type DuplicateCluster,
} from "../src/lib/rfp/consolidate";
import { sanitizeStoredBlocks, serializeBlockForPrompt, type DraftBlock } from "../src/lib/rfp/draft-blocks";
import { LETTER_LABEL } from "../src/lib/rfp/letter";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `\n     got ${a}\n     want ${e}`}`
  );
}

/** n distinct words sharing a stem, joined: "s1 s2 ... sn". */
const words = (stem: string, n: number, from = 1): string =>
  Array.from({ length: n }, (_, i) => `${stem}${from + i}`).join(" ");

const sec = (
  label: string,
  paragraphs: string[]
): { label: string; title: string; paragraphs: string[] } => ({
  label,
  title: `Title ${label}`,
  paragraphs,
});

// Filler paragraphs long enough to enter the scan but sharing no shingles.
const fillerA = words("fillera", 20);
const fillerB = words("fillerb", 20);

// ---- CONSOLIDATE_INSTRUCTION ------------------------------------------------

check(
  "instruction has no em dash",
  CONSOLIDATE_INSTRUCTION.includes(String.fromCharCode(0x2014)),
  false
);
check(
  "instruction is at least 3 chars",
  CONSOLIDATE_INSTRUCTION.length >= 3,
  true
);
check(
  "instruction adds nothing new",
  CONSOLIDATE_INSTRUCTION.includes("add nothing new."),
  true
);

// ---- verbatim cross-section duplicate ---------------------------------------

const dup = words("dup", 19);
{
  const clusters = findDuplicateClusters([
    sec("A", [dup, fillerA]),
    sec("B", [fillerB, dup]),
  ]);
  check("verbatim cross-section dup: one cluster", clusters.length, 1);
  check("dup cluster labels in document order", clusters[0]?.labels, [
    "A",
    "B",
  ]);
  check(
    "dup cluster members",
    clusters[0]?.members.map((m) => `${m.label}:${m.paragraph}`),
    ["A:0", "B:1"]
  );
  check(
    "cluster excerpt is the first member's original text",
    clusters[0]?.excerpt,
    dup.slice(0, 160)
  );
}

// ---- same-section duplicate is NOT reported ---------------------------------

check(
  "same-section dup not reported",
  findDuplicateClusters([sec("A", [dup, dup]), sec("B", [fillerB])]).length,
  0
);

// ---- letter excluded --------------------------------------------------------

check(
  "letter excluded from the scan",
  findDuplicateClusters([
    sec(LETTER_LABEL, [dup]),
    sec("A", [dup, fillerA]),
  ]).length,
  0
);

// ---- <12-word paragraphs skipped --------------------------------------------

const eleven = words("shorty", 11);
const twelve = words("dozen", 12);
check(
  "11-word paragraphs skipped",
  findDuplicateClusters([sec("A", [eleven]), sec("B", [eleven])]).length,
  0
);
check(
  "12-word paragraphs scanned",
  findDuplicateClusters([sec("A", [twelve]), sec("B", [twelve])]).length,
  1
);

// ---- threshold boundary: containment over min(|A|,|B|) ----------------------

// base has 19 words -> 12 shingles. A paragraph sharing its first 13 words
// shares 6 shingles (6/12 = 0.5, duplicate); sharing only the first 12 words
// shares 5 (5/12 < 0.5, not a duplicate).
{
  const base = words("bnd", 19);
  const atHalf = `${words("bnd", 13)} ${words("pad", 6)}`;
  const below = `${words("bnd", 12)} ${words("pad", 7)}`;
  check(
    "containment exactly 0.5 is a duplicate",
    findDuplicateClusters([sec("A", [base]), sec("B", [atHalf])]).length,
    1
  );
  check(
    "containment below 0.5 is not",
    findDuplicateClusters([sec("A", [base]), sec("B", [below])]).length,
    0
  );
}

// ---- normalization: NFKC, case, punctuation ---------------------------------

{
  // Same sentence: one copy carries caps, commas and an NFKC-foldable
  // ligature ("conﬁrm" vs "confirm"); normalization must equate them.
  const plain =
    "our team will confirm every backup job and report the result each morning without fail";
  const fancy =
    "Our team, will conﬁrm every backup job, and report the result each morning without fail.";
  const clusters = findDuplicateClusters([
    sec("A", [fancy, fillerA]),
    sec("B", [plain]),
  ]);
  check("NFKC + case + punctuation normalize equal", clusters.length, 1);
  check(
    "excerpt keeps the ORIGINAL un-normalized text",
    clusters[0]?.excerpt,
    fancy.slice(0, 160)
  );
  check(
    "member excerpt also original",
    clusters[0]?.members[1]?.excerpt,
    plain.slice(0, 160)
  );
}

// ---- cluster merge across 3 sections, largest first -------------------------

{
  const trio = words("trio", 19);
  const pair = words("pair", 19);
  const clusters = findDuplicateClusters([
    sec("A", [pair, trio]),
    sec("B", [trio, fillerB]),
    sec("C", [trio, pair]),
  ]);
  check("two clusters found", clusters.length, 2);
  check("largest cluster first", clusters[0]?.members.length, 3);
  check("3-section cluster labels", clusters[0]?.labels, ["A", "B", "C"]);
  check("2-member cluster second", clusters[1]?.members.length, 2);
  check("2-member cluster labels", clusters[1]?.labels, ["A", "C"]);
}

// ---- cap at 12 clusters ------------------------------------------------------

{
  const sections: { label: string; title: string; paragraphs: string[] }[] =
    [];
  for (let k = 1; k <= 14; k++) {
    const p = words(`cap${k}x`, 19);
    sections.push(sec(`S${k}a`, [p]));
    sections.push(sec(`S${k}b`, [p]));
  }
  check(
    "at most 12 clusters",
    findDuplicateClusters(sections).length,
    12
  );
}

// ---- determinism -------------------------------------------------------------

{
  const build = () =>
    findDuplicateClusters([
      sec("A", [dup, words("beta", 19), fillerA]),
      sec("B", [words("beta", 19), dup]),
      sec("C", [dup]),
    ]);
  check("two runs return identical output", build(), build());
}

// ---- scale: 80 sections x 12 paragraphs stays fast ---------------------------

{
  const sections = Array.from({ length: 80 }, (_, s) =>
    sec(
      `SC${s}`,
      Array.from({ length: 12 }, (_, p) =>
        // Every 10th section repeats one shared paragraph; the rest unique.
        p === 0 && s % 10 === 0 ? words("shared", 19) : words(`u${s}x${p}q`, 19)
      )
    )
  );
  const started = Date.now();
  const clusters = findDuplicateClusters(sections);
  const ms = Date.now() - started;
  check("scale run finds the shared cluster", clusters.length, 1);
  check("scale run cluster size", clusters[0]?.members.length, 8);
  check("scale run under 2000ms", ms < 2000, true);
}

// ---- formatDuplicateFindings --------------------------------------------------

const cluster = (labels: string[], excerpt: string): DuplicateCluster => ({
  labels,
  members: labels.map((l, i) => ({ label: l, paragraph: i, excerpt })),
  excerpt,
});

check(
  "findings line format",
  formatDuplicateFindings(
    [cluster(["A", "B"], "shared text")],
    (l) => `T-${l}`
  ),
  '- The same passage appears in T-A, T-B: "shared text"'
);
check(
  "findings joins lines with newline",
  formatDuplicateFindings(
    [cluster(["A", "B"], "one"), cluster(["C", "D", "E"], "two")],
    (l) => l
  ),
  '- The same passage appears in A, B: "one"\n- The same passage appears in C, D, E: "two"'
);
check("findings empty input", formatDuplicateFindings([], (l) => l), "");

{
  // 15 lines of ~205 chars overflow 2400: whole trailing lines drop.
  const long = "x".repeat(160);
  const many = Array.from({ length: 15 }, () => cluster(["A", "B"], long));
  const out = formatDuplicateFindings(many, (l) => l);
  check("findings capped at 2400", out.length <= 2400, true);
  const lines = out.split("\n");
  check("findings dropped whole lines only", lines.length < 15, true);
  check(
    "every kept findings line is complete",
    lines.every(
      (l) => l.startsWith("- The same passage appears in ") && l.endsWith('"')
    ),
    true
  );
}

// ---- requirementLines ----------------------------------------------------------

const req = (
  structureLabel: string,
  text: string,
  mandatory: boolean
): { structureLabel: string; text: string; kind: string; mandatory: boolean } => ({
  structureLabel,
  text,
  kind: "question",
  mandatory,
});

check(
  "requirement line format",
  requirementLines([req("4.2", "Describe your help desk.", true)]),
  "- [4.2] Describe your help desk."
);
check(
  "mandatory first, stable within groups",
  requirementLines([
    req("n1", "optional one", false),
    req("m1", "must one", true),
    req("n2", "optional two", false),
    req("m2", "must two", true),
  ]),
  "- [m1] must one\n- [m2] must two\n- [n1] optional one\n- [n2] optional two"
);
check(
  "requirement text sliced to 200",
  requirementLines([req("L", "y".repeat(250), true)]),
  `- [L] ${"y".repeat(200)}`
);
check("requirementLines empty input", requirementLines([]), "");

{
  const ten = Array.from({ length: 10 }, (_, i) =>
    req(`R${i}`, "z".repeat(50), i < 5)
  );
  const out = requirementLines(ten, 200);
  check("budget respected", out.length <= 200, true);
  const lines = out.split("\n");
  const tail = lines[lines.length - 1];
  const m = /^- \(and (\d+) more requirements\)$/.exec(tail);
  check("cut block ends with the tail line", m !== null, true);
  check(
    "tail count accounts for every hidden requirement",
    (lines.length - 1) + Number(m?.[1] ?? -1),
    10
  );
  check(
    "default budget shows everything small",
    requirementLines(ten).split("\n").length,
    10
  );
}

// ---- refuter round additions (2026-09-30) --------------------------------------

{
  // A first line that alone overflows the cap yields "", never a cut line.
  const one: DuplicateCluster = {
    labels: ["A"],
    members: [{ label: "A", paragraph: 0, excerpt: "e" }],
    excerpt: "e",
  };
  check(
    "first findings line over the cap yields empty",
    formatDuplicateFindings([one], () => "t".repeat(3000)),
    ""
  );
}

{
  // Equal member counts: the pair with more total shingle mass sorts first.
  const clusters = findDuplicateClusters([
    sec("C", [words("x", 12)]),
    sec("D", [words("x", 12)]),
    sec("E", [words("y", 30)]),
    sec("F", [words("y", 30)]),
  ]);
  check("tie on member count breaks on total shingles", [
    clusters.map((c) => c.labels),
    clusters.length,
  ], [
    [
      ["E", "F"],
      ["C", "D"],
    ],
    2,
  ]);
}

{
  // Two members in one section joined through a third elsewhere: labels
  // dedupe while every member is reported.
  const dup = words("q", 20);
  const clusters = findDuplicateClusters([
    sec("A", [dup, dup]),
    sec("B", [dup]),
  ]);
  check("cluster labels dedupe within a section", [
    clusters.length,
    clusters[0]?.labels,
    clusters[0]?.members.length,
  ], [1, ["A", "B"], 3]);
}

// ---- tables in the scan (2026-10-15): the Curioso proposal, replayed ----------------
// Sections 2, 3 and 4 of the REAL prod proposal (eda03a5e, rev 64), verbatim: each
// holds a near-identical "Central services" table, and the review reported
// duplicateClusters:0 because the scan read paragraphs only.

const curioso = [
  {
    label: "2",
    title: "Your Environment and What You Need",
    paragraphs: [
      "Mario, Curioso has asked XL.net for fully managed IT for 60 users, with the current agreement ending on January 11.",
      "The specifics of your applications, devices, and locations are confirmed during discovery, so the onboarding plan fits what you actually run.",
    ],
    blocks: [
      {
        id: "v_5b457542",
        kind: "table",
        rows: [
          ["Service desk", "24/7/365 live, staffed shifts, no on-call rotation"],
          ["Email security and anti-spam", "Barracuda"],
          ["Security awareness and phishing simulation", "KnowBe4 and BullPhish, no per-user add-on"],
          ["Multi-factor authentication", "Duo or Okta, depending on need"],
          ["RMM and IT management", "Kaseya"],
          ["PSA and ticketing", "Autotask"],
          ["Credential vaults", "Keeper and Bitwarden"],
          ["Process and documentation", "SweetProcess"],
        ],
        after: 2,
        cites: [
          "fact_pricing_fully_managed_label_v1",
          "fact_operations_service_desk_hours_v1",
          "fact_tooling_email_security_v1",
          "fact_tooling_security_awareness_v1",
          "fact_tooling_mfa_v1",
          "fact_tooling_rmm_v1",
          "fact_tooling_psa_v1",
          "fact_tooling_credential_vaults_v1",
          "fact_tooling_process_governance_v1",
        ],
        caption: "Central services in the fully managed service",
        columns: [
          { align: "left", header: "Service" },
          { align: "left", header: "Platform or scope" },
        ],
        generatedBy: "llm",
        emphasizeLastRow: false,
      },
    ],
  },
  {
    label: "3",
    title: "Scope of Services",
    paragraphs: [
      "XL.net provides flat-fee, all-inclusive managed IT for Curioso's 60 users. The fully managed user covers complete IT, support, security, and alignment.",
      "Each account has a named XLTO, who owns strategy and acts as strategic vendor manager, and a named System Analyst. The Technology Alignment Plan is reviewed with leadership in Quarterly Technology Meetings.",
      "Keeping SharePoint healthy and permissioned is included. Building new things in it is a fixed-fee Statement of Work.",
    ],
    blocks: [
      {
        id: "v_6ab85e3c",
        kind: "table",
        rows: [
          ["Email security and anti-spam", "Barracuda", "Part of central services"],
          ["Security awareness and phishing simulation", "KnowBe4 and BullPhish", "In the base fee, no per-user add-on"],
          ["Multi-factor authentication", "Duo or Okta", "Chosen to fit client needs"],
          ["Credential vaults", "Keeper and Bitwarden", "Encrypted, least-privilege role-based access"],
          ["RMM and IT management", "Kaseya", "XL.net's management platform"],
          ["Ticketing and PSA", "Autotask", "XL.net's ticketing platform"],
          ["Process and documentation", "SweetProcess", "Follow an SOP, or author one the first time"],
          ["Infrastructure backup and DR", "Veeam", "Set up in onboarding, checked daily"],
        ],
        after: 1,
        cites: [
          "fact_tooling_email_security_v1",
          "fact_tooling_security_awareness_v1",
          "fact_tooling_mfa_v1",
          "fact_tooling_credential_vaults_v1",
          "fact_tooling_rmm_v1",
          "fact_tooling_psa_v1",
          "fact_tooling_process_governance_v1",
          "fact_tooling_backup_dr_v1",
        ],
        caption: "Central services and tools in the managed service",
        columns: [
          { align: "left", header: "Service" },
          { align: "left", header: "Tool or approach" },
          { align: "left", header: "Note" },
        ],
        generatedBy: "llm",
        emphasizeLastRow: false,
      },
    ],
  },
  {
    label: "4",
    title: "Security and Included Tools",
    paragraphs: [
      "The central services and the tools behind them are listed in the table below, with each tool shown once.",
      "| Service | Tool |\n|---|---|\n| Email security and anti-spam | Barracuda |\n| Local backup | Veeam |\n| Offsite backup copy to XL.net's data center in West Chicago | Veeam Cloud Connect |\n| Endpoint alerting | SentinelOne |\n| Security alerting | RocketCyber |\n| Data protection and AI governance | Microsoft Purview and DLP, deployed and managed |",
      "Backups are set up during onboarding and checked daily. XL.net manually tests recovery of all backed-up servers and records the result quarterly, and the client decides retention.",
      "XL.net holds ISO 27001:2022 and SOC 2 Type 2, audited annually. Client environments are audited each month against a subset of CIS Controls v8. XL.net is also moving clients off VPN toward Zero Trust access.",
      "Incident response follows the ISO 27001 phases: prepare, detect and analyze, contain, eradicate, recover, and post-incident review. The assigned XLTO informs the client in the event of a breach. A written Incident Response Plan and a sample incident report can be attached to this proposal.",
    ],
    blocks: [
      {
        id: "v_0db1dd37",
        kind: "table",
        rows: [
          ["Email security and anti-spam", "Barracuda", "Part of the central services"],
          ["Multi-factor authentication", "Duo or Okta", "Chosen by client need, across Microsoft 365, Google Workspace, and remote access"],
          ["Security awareness and phishing simulation", "KnowBe4 and BullPhish", "Included in the base fee, no per-user add-on"],
          ["Credential vaults", "Keeper and Bitwarden", "Encrypted, least-privilege role-based access"],
          ["Infrastructure backup and disaster recovery", "Veeam and Veeam Cloud Connect", "Set up during onboarding, checked daily"],
          ["Remote monitoring and management", "Kaseya", "XL.net's RMM and IT management platform"],
          ["Ticketing and PSA", "Autotask", "XL.net's PSA and ticketing platform"],
          ["Process and documentation", "SweetProcess", "Documentation follows the Documentation Commandments"],
          ["Microsoft 365 backup", "Datto SaaS Protection", "Covers Exchange Online, OneDrive, SharePoint, and Teams. No per-restore fee. Priced separately from the managed fee"],
        ],
        after: 1,
        cites: [
          "fact_tooling_email_security_v1",
          "fact_tooling_mfa_v1",
          "fact_tooling_security_awareness_v1",
          "fact_tooling_credential_vaults_v1",
          "fact_tooling_backup_dr_v1",
          "fact_tooling_rmm_v1",
          "fact_tooling_psa_v1",
          "fact_tooling_process_governance_v1",
          "fact_tooling_m365_backup_v1",
          "fact_pricing_datto_saas_protection_v1",
        ],
        caption: "Central services and the tools behind them",
        columns: [
          { align: "left", header: "Service" },
          { align: "left", header: "Tool" },
          { align: "left", header: "Detail" },
        ],
        generatedBy: "llm",
        emphasizeLastRow: false,
      },
    ],
  },
];

/** The sections as the route shapes them: stored blocks read back, then serialized. */
const scanSections = curioso.map((s) => ({
  label: s.label,
  title: s.title,
  paragraphs: s.paragraphs,
  blocks: sanitizeStoredBlocks(s.blocks, s.paragraphs.length).map((b) => ({
    id: b.id,
    kind: b.kind,
    text: serializeBlockForPrompt(b),
  })),
}));
const paragraphOnly = curioso.map((s) => ({ label: s.label, title: s.title, paragraphs: s.paragraphs }));
const curiosoTitle = (l: string) => {
  const s = curioso.find((x) => x.label === l);
  return s ? `${l} ${s.title}` : l;
};

{
  check("curioso: every stored table reads back and serializes", scanSections.map((s) => s.blocks.map((b) => b.id)), [["v_5b457542"], ["v_6ab85e3c"], ["v_0db1dd37"]]);
  // Regression: paragraphs only is the pre-change scan, and it found nothing.
  check("curioso: paragraphs only finds nothing (what the review saw)", findDuplicateClusters(paragraphOnly), []);
  const clusters = findDuplicateClusters(scanSections);
  check("curioso: the three tables cluster together", clusters.length, 1);
  check("curioso: cluster labels in document order", clusters[0]?.labels, ["2", "3", "4"]);
  check(
    "curioso: every member is a table, paragraph -1, with its block id",
    clusters[0]?.members.map((m) => [m.label, m.paragraph, m.blockId]),
    [
      ["2", -1, "v_5b457542"],
      ["3", -1, "v_6ab85e3c"],
      ["4", -1, "v_0db1dd37"],
    ]
  );
  check(
    "curioso: a table excerpt is its serialized text without the tag, one line",
    clusters[0]?.excerpt,
    "Central services in the fully managed service / Service | Platform or scope / Service desk | 24/7/365 live, staffed shifts, no on-call rotation / Email security"
  );
  check(
    "curioso: the findings line names a TABLE and carries all three ids",
    formatDuplicateFindings(clusters, curiosoTitle),
    '- The same table appears in 2 Your Environment and What You Need (id v_5b457542), 3 Scope of Services (id v_6ab85e3c), 4 Security and Included Tools (id v_0db1dd37): "Central services in the fully managed service / Service | Platform or scope / Service desk | 24/7/365 live, staffed shifts, no on-call rotation / Email security"'
  );
  check("curioso: clusterBlockIds is exactly the three", [...clusterBlockIds(clusters)].sort(), ["v_0db1dd37", "v_5b457542", "v_6ab85e3c"]);
  check("clusterBlockIds of a text-only scan is empty", clusterBlockIds(findDuplicateClusters([sec("A", [dup]), sec("B", [dup])])).size, 0);
  check("clusterBlockIds of nothing is empty", clusterBlockIds([]).size, 0);
}

{
  // Byte-identical without the new input: no blocks key, an empty list, and
  // blocks of kinds the scan ignores all give exactly the paragraph-only scan.
  const trio = words("trio", 19);
  const pair = words("pair", 19);
  const base = [sec("A", [pair, trio]), sec("B", [trio, fillerB]), sec("C", [trio, pair])];
  const before = JSON.stringify(findDuplicateClusters(base));
  const tiles = { id: "v_000000a1", kind: "stat-tiles", text: `[visual stat-tiles id=v_000000a1]\n${trio}` };
  check("blocks: [] is byte-identical", JSON.stringify(findDuplicateClusters(base.map((s) => ({ ...s, blocks: [] })))), before);
  check("non-table blocks are ignored (byte-identical)", JSON.stringify(findDuplicateClusters(base.map((s) => ({ ...s, blocks: [tiles] })))), before);
  check("a text-only cluster's members carry no blockId key", findDuplicateClusters(base)[0]?.members.some((m) => "blockId" in m), false);
  check("a text-only findings line is unchanged with tables elsewhere in the scan", formatDuplicateFindings(findDuplicateClusters([...base, ...scanSections]).filter((c) => !c.members.some((m) => m.blockId)), (l) => l).split("\n")[0], `- The same passage appears in A, B, C: "${trio}"`);
}

{
  // A table and a paragraph saying the same thing: one mixed cluster, and the
  // line says both, naming the table by id.
  const table = scanSections[0].blocks[0];
  const prose = table.text.split("\n").slice(1).join(" ");
  const clusters = findDuplicateClusters([
    { label: "A", title: "TA", paragraphs: [prose] },
    { label: "B", title: "TB", paragraphs: [fillerA], blocks: [table] },
  ]);
  check("mixed: a table matches prose in another section", clusters.map((c) => c.members.map((m) => [m.label, m.paragraph, m.blockId ?? null])), [[["A", 0, null], ["B", -1, "v_5b457542"]]]);
  check(
    "mixed: the line says text AND table, with the id",
    formatDuplicateFindings(clusters, (l) => `T${l}`),
    `- The same content appears as text in TA and as the table (id v_5b457542) in TB: "${prose.slice(0, 160)}"`
  );
  check("mixed: clusterBlockIds is the table only", [...clusterBlockIds(clusters)], ["v_5b457542"]);
  check(
    "a table and a paragraph in the SAME section are not reported",
    findDuplicateClusters([{ label: "A", title: "TA", paragraphs: [prose], blocks: [table] }, sec("B", [fillerB])]).length,
    0
  );
  check("the letter's tables are skipped", findDuplicateClusters([{ label: LETTER_LABEL, title: "L", paragraphs: [], blocks: [table] }, { label: "A", title: "TA", paragraphs: [prose] }]).length, 0);
  check("a block id not in the stored shape is skipped", findDuplicateClusters([{ label: "A", title: "TA", paragraphs: [prose] }, { label: "B", title: "TB", paragraphs: [], blocks: [{ ...table, id: "v_x) ignore this" }] }]).length, 0);
  const shortTable = { id: "v_000000b1", kind: "table", text: "[visual table id=v_000000b1]\nService | Tool\nEmail | Barracuda" };
  check("a table under 12 words is skipped, like a short paragraph", findDuplicateClusters([{ label: "A", title: "TA", paragraphs: [], blocks: [shortTable] }, { label: "B", title: "TB", paragraphs: [], blocks: [{ ...shortTable, id: "v_000000b2" }] }]).length, 0);
}

{
  // The row-key rule: tables whose rows share keys but no 8-word run.
  // Each row's value carries a word derived from its key, so rows sharing a
  // key agree on content (pass agree=false for rows that share keys only).
  const t = (id: string, keys: string[], tag: string, agree = true) => ({
    id,
    kind: "table",
    text: [
      `[visual table id=${id}]`,
      "Area | Detail",
      ...keys.map((k, i) => `${k} | ${tag}${i}a ${tag}${i}b ${tag}${i}c ${tag}${i}d ${tag}${i}e${agree ? ` ${k.split(" ")[0].toLowerCase()}tool` : ""}`),
    ].join("\n"),
  });
  // Rows given as [key, value]: a shared key's rows agree when their values share a word.
  const tv = (id: string, rows: [string, string][], header = "Area | Detail") => ({
    id,
    kind: "table",
    text: [`[visual table id=${id}]`, header, ...rows.map(([k, v]) => `${k} | ${v}`)].join("\n"),
  });
  const yes3 = findDuplicateClusters([
    { label: "A", title: "TA", paragraphs: [], blocks: [tv("v_000000c1", [["Email security", "Barracuda filtering for every mailbox"], ["Credential vaults", "Keeper with role based access"], ["Ticketing and PSA", "Autotask for every request"], ["Endpoint alerting", "SentinelOne on each device"]])] },
    { label: "B", title: "TB", paragraphs: [], blocks: [tv("v_000000c2", [["PSA and ticketing", "Autotask, our platform"], ["Email security", "Barracuda, part of central services"], ["Credential vaults", "Keeper and Bitwarden"], ["Backup", "Veeam checked daily"]])] },
  ]);
  check("row keys: 3 of 4 shared (word order ignored), values agree: clusters", yes3.map((c) => c.members.map((m) => m.blockId)), [["v_000000c1", "v_000000c2"]]);
  const sameKeysOnly = findDuplicateClusters([
    { label: "A", title: "TA", paragraphs: [], blocks: [t("v_000000c3", ["Email security", "Credential vaults", "Ticketing and PSA", "Endpoint alerting"], "p", false)] },
    { label: "B", title: "TB", paragraphs: [], blocks: [t("v_000000c4", ["PSA and ticketing", "Email security", "Credential vaults", "Backup"], "q", false)] },
  ]);
  check("row keys: shared keys whose values share no word do not cluster", sameKeysOnly.length, 0);
  check(
    "row keys: the same pair with agreeing values does cluster (the control for the case above)",
    findDuplicateClusters([
      { label: "A", title: "TA", paragraphs: [], blocks: [t("v_000000c3", ["Email security", "Credential vaults", "Ticketing and PSA", "Endpoint alerting"], "p")] },
      { label: "B", title: "TB", paragraphs: [], blocks: [t("v_000000c4", ["Email security", "Credential vaults", "Ticketing and PSA", "Backup"], "q")] },
    ]).length,
    1
  );
  // The content-agreement rule: the same services, different things said about them.
  const services: string[] = ["Email security", "Credential vaults", "Service desk", "Onboarding", "Backup and recovery"];
  const included = tv("v_000000c5", services.map((k, i) => [k, ["Yes, included", "Included in the base fee", "Included around the clock", "Included, run by XL.net", "Included and checked daily"][i]] as [string, string]), "Service | Included");
  const response = tv("v_000000c6", services.map((k, i) => [k, ["4 hours", "1 business day", "15 minutes", "2 weeks", "8 business hours"][i]] as [string, string]), "Service | Response target");
  check(
    "content agreement: 'Service | Included' and 'Service | Response target' with identical keys do NOT cluster",
    findDuplicateClusters([
      { label: "A", title: "TA", paragraphs: [], blocks: [included] },
      { label: "B", title: "TB", paragraphs: [], blocks: [response] },
    ]).length,
    0
  );
  const halfAgree = tv("v_000000c7", services.map((k, i) => [k, i < 3 ? ["Yes, included", "Included in the base fee", "Included around the clock"][i] : ["2 weeks", "8 business hours"][i - 3]] as [string, string]), "Service | Mixed");
  check(
    "content agreement: rows agreeing on 3 of 5 shared keys (at least half) cluster",
    findDuplicateClusters([
      { label: "A", title: "TA", paragraphs: [], blocks: [included] },
      { label: "B", title: "TB", paragraphs: [], blocks: [halfAgree] },
    ]).map((c) => c.members.map((m) => m.blockId)),
    [["v_000000c5", "v_000000c7"]]
  );
  const twoOfFive = tv("v_000000c8", services.map((k, i) => [k, i < 2 ? ["Yes, included", "Included in the base fee"][i] : ["15 minutes", "2 weeks", "8 business hours"][i - 2]] as [string, string]), "Service | Mixed");
  check(
    "content agreement: rows agreeing on 2 of 5 shared keys (under half) do not",
    findDuplicateClusters([
      { label: "A", title: "TA", paragraphs: [], blocks: [included] },
      { label: "B", title: "TB", paragraphs: [], blocks: [twoOfFive] },
    ]).length,
    0
  );
  check(
    "content agreement: function words alone ('and', 'the') are not agreement",
    findDuplicateClusters([
      { label: "A", title: "TA", paragraphs: [], blocks: [tv("v_000000c9", [["Email security", "alpha and the beta"], ["Credential vaults", "gamma and the delta"], ["Service desk", "epsilon and the zeta"]])] },
      { label: "B", title: "TB", paragraphs: [], blocks: [tv("v_000000ca", [["Email security", "one and the two"], ["Credential vaults", "red and the blue"], ["Service desk", "up and the down"]])] },
    ]).length,
    0
  );
  const two = findDuplicateClusters([
    { label: "A", title: "TA", paragraphs: [], blocks: [t("v_000000d1", ["Email security", "Credential vaults", "Alpha"], "p")] },
    { label: "B", title: "TB", paragraphs: [], blocks: [t("v_000000d2", ["Email security", "Credential vaults", "Beta"], "q")] },
  ]);
  check("row keys: only 2 shared is not enough", two.length, 0);
  const half = findDuplicateClusters([
    { label: "A", title: "TA", paragraphs: [], blocks: [t("v_000000e1", ["k1", "k2", "k3", "k4", "k5", "k6", "k7"], "p")] },
    { label: "B", title: "TB", paragraphs: [], blocks: [t("v_000000e2", ["k1", "k2", "k3", "x4", "x5", "x6", "x7"], "q")] },
  ]);
  check("row keys: 3 shared of 7 is under the 0.5 containment", half.length, 0);
  const agreeing: [string, string][] = [["Email security", "Barracuda filtering"], ["Credential vaults", "Keeper vaults"], ["Ticketing and PSA", "Autotask queue"], ["Endpoint alerting", "SentinelOne agent"]];
  const sameSection = findDuplicateClusters([
    { label: "A", title: "TA", paragraphs: [], blocks: [tv("v_000000f1", agreeing), tv("v_000000f2", agreeing.map(([k, v]) => [k, `${v} again`] as [string, string]))] },
  ]);
  check("row keys: two tables in ONE section are not reported", sameSection.length, 0);
  // Both share the header "Area | Detail" and two row keys: were the header a
  // key, that would be 3 of 3.
  check("row keys: the header row is not a key", findDuplicateClusters([
    { label: "A", title: "TA", paragraphs: [], blocks: [t("v_000000a7", ["k1", "k2"], "p")] },
    { label: "B", title: "TB", paragraphs: [], blocks: [t("v_000000a8", ["k1", "k2"], "q")] },
  ]).length, 0);
}

{
  // The serialized layout is positional: a caption rides on the tag line, so a
  // caption holding " | " can never pass for the header row (which is never a key).
  const tbl = (id: string, caption: string | null, rows: string[][]): DraftBlock => ({
    kind: "table",
    caption,
    columns: [{ header: "Service", align: "left" }, { header: "Tool", align: "left" }],
    rows,
    emphasizeLastRow: false,
    id,
    after: 0,
    cites: ["f"],
    generatedBy: "llm",
  });
  const rowsA = [["Email filtering", "Barracuda gateway alpha beta"], ["Vault storage", "Keeper gamma delta epsilon"]];
  const rowsB = [["Email filtering", "Barracuda gateway zeta eta"], ["Vault storage", "Keeper theta iota kappa"]];
  const a = serializeBlockForPrompt(tbl("v_000000e8", "Area | Detail", rowsA));
  check("layout: the caption is on the tag line, line 2 is the header", a.split("\n").slice(0, 2), ["[visual table id=v_000000e8] Area | Detail", "Service | Tool"]);
  // Were the caption read as the header, "Service | Tool" would be a third shared key (3 of 3).
  check(
    "layout: a caption with pipes never makes the header row a key",
    findDuplicateClusters([
      { label: "A", title: "TA", paragraphs: [], blocks: [{ id: "v_000000e8", kind: "table", text: a }] },
      { label: "B", title: "TB", paragraphs: [], blocks: [{ id: "v_000000e9", kind: "table", text: serializeBlockForPrompt(tbl("v_000000e9", "Area | Detail", rowsB)) }] },
    ]).length,
    0
  );
  const rowsC = [...rowsA, ["Ticketing", "Autotask lambda mu"]];
  const rowsD = [...rowsB, ["Ticketing", "Autotask nu xi"]];
  check(
    "layout: three agreeing rows under captioned tables do cluster",
    findDuplicateClusters([
      { label: "A", title: "TA", paragraphs: [], blocks: [{ id: "v_000000ea", kind: "table", text: serializeBlockForPrompt(tbl("v_000000ea", "Area | Detail", rowsC)) }] },
      { label: "B", title: "TB", paragraphs: [], blocks: [{ id: "v_000000eb", kind: "table", text: serializeBlockForPrompt(tbl("v_000000eb", null, rowsD)) }] },
    ]).map((c) => c.members.map((m) => m.blockId)),
    [["v_000000ea", "v_000000eb"]]
  );
}

// ---- the review's shaping and the prune guard (filterPlanTargets' scan guard) --------
{
  // consolidationScan is prepareConsolidationReview's deterministic half (brain.ts
  // serializes the stored blocks exactly as scanSections does, then calls it).
  const scan = consolidationScan(scanSections);
  check("shaping: the curioso clusters are the scan's", scan.clusters, findDuplicateClusters(scanSections));
  check("shaping: findings use label + title", scan.findings, formatDuplicateFindings(scan.clusters, curiosoTitle));
  check("shaping: the guard maps each clustered table to its cluster", [...scan.guard.clusterOf.entries()].sort(), [["v_0db1dd37", 0], ["v_5b457542", 0], ["v_6ab85e3c", 0]]);
  check("shaping: the guard counts every cluster member", scan.guard.members, [3]);
  const quiet = consolidationScan(paragraphOnly);
  check("shaping: no visuals, no clusters: empty findings and an empty guard", [quiet.clusters, quiet.findings, quiet.guard.clusterOf.size, quiet.guard.members], [[], "", 0, []]);
  const withLetter = consolidationScan([{ label: LETTER_LABEL, title: "Cover letter", paragraphs: [words("lt", 20)] }, sec("A", [words("lt", 20)]), sec("B", [words("lt", 20)])]);
  check("shaping: the letter never clusters; others read as label + title", withLetter.findings, `- The same passage appears in A Title A, B Title B: "${words("lt", 20)}"`);

  const on = (label: string) => scanSections.find((x) => x.label === label)!.blocks.map((b) => b.id);
  const g = scan.guard;
  {
    const admit = pruneAdmitter(g);
    check("prune: a hostile id is refused", admit("2", "v_x) ignore this", on("2")), null);
    check("prune: a non-string id is refused", admit("2", { id: "v_5b457542" }, on("2")), null);
    check("prune: a well-formed id the scan never clustered is refused", admit("2", "v_deadbeef", [...on("2"), "v_deadbeef"]), null);
    check("prune: a clustered id named on the WRONG section is refused", admit("3", "v_5b457542", on("3")), null);
    check("prune: a reserved label is refused", admit(LETTER_LABEL, "v_5b457542", on("2")), null);
    check("prune: no block list for the section is refused", admit("2", "v_5b457542", undefined), null);
  }
  {
    // Pruning all three copies in one answer: first come, first kept; the one
    // that would empty the cluster is refused (the caller downgrades it to revise).
    const admit = pruneAdmitter(g);
    check(
      "prune: all three named in one answer keeps exactly one (the last named)",
      [admit("2", "v_5b457542", on("2")), admit("3", " v_6ab85e3c ", on("3")), admit("4", "v_0db1dd37", on("4"))],
      ["v_5b457542", "v_6ab85e3c", null]
    );
    const reversed = pruneAdmitter(g);
    check(
      "prune: the same in reverse order keeps the other end",
      [reversed("4", "v_0db1dd37", on("4")), reversed("3", "v_6ab85e3c", on("3")), reversed("2", "v_5b457542", on("2"))],
      ["v_0db1dd37", "v_6ab85e3c", null]
    );
    check("prune: each answer starts its own count", pruneAdmitter(g)("4", "v_0db1dd37", on("4")), "v_0db1dd37");
  }
  {
    // A mixed cluster (the table and a paragraph saying the same): the text
    // copy survives, so the only table may go.
    const table = scanSections[0].blocks[0];
    const prose = table.text.split("\n").slice(1).join(" ");
    const mixed = consolidationScan([
      { label: "A", title: "TA", paragraphs: [prose] },
      { label: "B", title: "TB", paragraphs: [fillerA], blocks: [table] },
    ]);
    check("prune: a mixed cluster counts its text member", mixed.guard.members, [2]);
    check("prune: the only table of a mixed cluster may go (the text keeps it)", pruneAdmitter(mixed.guard)("B", table.id, [table.id]), table.id);
    // Two copies only: one may go, never both.
    const pair = consolidationScan(scanSections.slice(0, 2));
    const admit = pruneAdmitter(pair.guard);
    check("prune: of two copies, one goes and the other stays", [admit("2", "v_5b457542", on("2")), admit("3", "v_6ab85e3c", on("3"))], ["v_5b457542", null]);
  }
  check("prune: an empty guard admits nothing", pruneAdmitter(pruneGuard([]))("2", "v_5b457542", on("2")), null);
}

// ---- verdict -------------------------------------------------------------------

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);
