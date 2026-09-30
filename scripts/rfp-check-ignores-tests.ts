/**
 * Checks-pane ignore / fix-it tests (ARCHITECTURE.md §5.17.8).
 *
 *   npm run test:rfpchecks
 *
 * Pure, no server, no DB. Pins the two persisted/lockstep contracts:
 * findingSig is a PERSISTED FORMAT (stored checks_ignores_json rows key on
 * it — a recipe change un-ignores live dismissals), and
 * sectionIdForLabel/blockId parsing must mirror resolve-draft.ts exactly or
 * Fix it targets the wrong section. applyIgnores' recompute is the pane's
 * and the export header's shared pass verdict.
 */

import {
  appendIgnore,
  applyIgnores,
  findingSig,
  MAX_CHECK_IGNORES,
  parseCheckIgnores,
  type CheckIgnore,
} from "../src/lib/rfp/check-ignores";
import {
  fixAllSteps,
  fixInstruction,
  fixInstructionFor,
  fixRecipe,
  groupFindings,
  groupFixPlan,
  isAutoFixable,
  isAutoFixableGroup,
  isReferenceCardBlockId,
  REFERENCE_CARD_FIX_MESSAGE,
  resolveTargetLabel,
  sectionIdForLabel,
} from "../src/lib/rfp/check-fixes";
import { DOC_LABEL } from "../src/lib/rfp/letter";
import type { Violation } from "../src/lib/rfp/content-model/gate";
import type { GateResult } from "../src/lib/rfp/validators/gate";

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

const viol = (
  over: Partial<Violation> & Pick<Violation, "ruleId" | "severity">
): Violation => ({
  message: "The finding.",
  locator: {},
  overriddenBy: null,
  overrideReason: null,
  ...over,
});

const result = (
  violations: Violation[],
  errors: GateResult["errors"] = []
): GateResult => ({
  passed: false,
  violations,
  failedRules: [...new Set(violations.map((v) => v.ruleId))].sort(),
  errors,
});

const ign = (sig: string, n = "note"): CheckIgnore => ({
  sig,
  ruleId: "A1",
  note: n,
  by: "adam@xl.net",
  at: "2026-09-30T00:00:00.000Z",
});

// ---- findingSig: persisted format ------------------------------------------

const base = viol({
  ruleId: "C5",
  severity: "warn",
  message: 'The word "veeam" should be spelled "Veeam".',
  locator: { sectionId: "sec_4_2", blockId: "b_4_2_1", field: "body", charOffset: 12 },
  excerpt: "we back up with veeam nightly",
});

check(
  "sig is stable across identical findings",
  findingSig(base) === findingSig({ ...base }),
  true
);
check(
  "sig normalizes whitespace runs in the text key",
  findingSig({ ...base, excerpt: "we  back up\n\twith veeam   nightly" }),
  findingSig({ ...base, excerpt: "we back up with veeam nightly" })
);
check(
  "an excerpt change diverges the sig (the edited finding resurfaces)",
  findingSig({ ...base, excerpt: "we back up with Veeam nightly" }) ===
    findingSig(base),
  false
);
check(
  "a moved charOffset diverges the sig",
  findingSig({
    ...base,
    locator: { ...base.locator, charOffset: 13 },
  }) === findingSig(base),
  false
);
check(
  "absent locator fields and absent excerpt fall back cleanly",
  findingSig(viol({ ruleId: "A1", severity: "block", message: " Two   words. " })),
  "A1\u0000\u0000\u0000\u0000\u0000\u0000\u0000Two words."
);
check(
  "text key caps at 300 chars",
  findingSig(
    viol({ ruleId: "A1", severity: "block", message: "x".repeat(500) })
  ).length,
  "A1\u0000\u0000\u0000\u0000\u0000\u0000\u0000".length + 300
);

// ---- parseCheckIgnores: tolerant reader ------------------------------------

check("null parses to []", parseCheckIgnores(null), []);
check("garbage parses to []", parseCheckIgnores("{not json"), []);
check("a non-array parses to []", parseCheckIgnores('{"sig":"x"}'), []);
check(
  "malformed entries drop, well-formed survive",
  parseCheckIgnores(
    JSON.stringify([
      ign("good"),
      { sig: 7, ruleId: "A1", note: "n", by: "b", at: "t" },
      { sig: "s" },
      null,
      "string",
    ])
  ),
  [ign("good")]
);

// ---- appendIgnore: dedupe + cap --------------------------------------------

check(
  "append dedupes by sig, latest entry wins",
  appendIgnore([ign("a", "old"), ign("b")], ign("a", "new")),
  [ign("b"), ign("a", "new")]
);
{
  const full: CheckIgnore[] = [];
  for (let i = 0; i < MAX_CHECK_IGNORES; i++) full.push(ign(`s${i}`));
  const grown = appendIgnore(full, ign("overflow"));
  check("cap holds at MAX_CHECK_IGNORES", grown.length, MAX_CHECK_IGNORES);
  check("oldest entry is evicted", grown.some((e) => e.sig === "s0"), false);
  check(
    "the new entry survives eviction",
    grown[grown.length - 1].sig,
    "overflow"
  );
}

// ---- applyIgnores: recompute across severities -----------------------------

const blockV = viol({ ruleId: "A1", severity: "block", message: "Block it." });
const warnV = viol({ ruleId: "A8", severity: "warn", message: "Warn it." });
const infoV = viol({ ruleId: "B1", severity: "info", message: "Note it." });

check(
  "a dismissed lone block passes",
  applyIgnores(result([blockV]), [ign(findingSig(blockV))]).passed,
  true
);
check(
  "the dismissed violation carries by/at from its ignore",
  applyIgnores(result([blockV]), [ign(findingSig(blockV))]).violations[0]
    .dismissed,
  { by: "adam@xl.net", at: "2026-09-30T00:00:00.000Z" }
);
check(
  "an undismissed block still fails",
  applyIgnores(result([blockV, warnV]), [ign(findingSig(warnV))]).passed,
  false
);
check(
  "an overridden warn passes with no ignore (existing semantics preserved)",
  applyIgnores(result([{ ...warnV, overriddenBy: "adam@xl.net" }]), []).passed,
  true
);
check(
  "an unoverridden warn fails with no ignore",
  applyIgnores(result([warnV]), []).passed,
  false
);
check(
  "a dismissed warn passes",
  applyIgnores(result([warnV]), [ign(findingSig(warnV))]).passed,
  true
);
check("info never blocks", applyIgnores(result([infoV]), []).passed, true);
check(
  "a validator error always fails, dismissals or not",
  applyIgnores(result([blockV], [{ ruleId: "A1", message: "threw" }]), [
    ign(findingSig(blockV)),
  ]).passed,
  false
);
check(
  "restore clears a stale dismissed mark on re-apply",
  applyIgnores(
    result([
      { ...blockV, dismissed: { by: "x@xl.net", at: "2026-01-01T00:00:00Z" } },
    ]),
    []
  ),
  result([blockV])
);
check(
  "an unmatched violation never gains a dismissed key",
  "dismissed" in applyIgnores(result([blockV]), []).violations[0],
  false
);
check(
  "failedRules follows the surviving violations (a fully-dismissed rule drops)",
  applyIgnores(result([blockV, warnV]), [ign(findingSig(blockV))]).failedRules,
  ["A8"]
);
check(
  "failedRules keeps a rule while any of its findings survives",
  applyIgnores(result([blockV, { ...blockV, message: "Twin, other text." }]), [
    ign(findingSig(blockV)),
  ]).failedRules,
  ["A1"]
);
// findingSig must be TOTAL: it runs on every violation of a STORED row (the
// workspace render, applyIgnores inside the checks tx), so a shape-corrupt
// element degrades to a nonsense sig instead of throwing mid-render.
check(
  "a violation with no locator does not throw",
  typeof findingSig({ ...blockV, locator: undefined as never }),
  "string"
);
check(
  "a violation with no message or excerpt does not throw",
  typeof findingSig({
    ...blockV,
    message: undefined as never,
    excerpt: undefined,
  }),
  "string"
);

// ---- resolveTargetLabel: locator to stored label ---------------------------

const punct = "June 8th, 2026: Current IT Provider Issues";
check(
  "sectionId roundtrips a punctuation-heavy label",
  resolveTargetLabel(
    viol({
      ruleId: "D1",
      severity: "block",
      locator: { sectionId: sectionIdForLabel(punct) },
    }),
    [{ label: "1" }, { label: punct }],
    []
  ),
  punct
);
check(
  "blockId longest-prefix disambiguation: 1 vs 1.2",
  resolveTargetLabel(
    viol({ ruleId: "D5", severity: "warn", locator: { blockId: "b_1_2_3" } }),
    [{ label: "1" }, { label: "1.2" }],
    []
  ),
  "1.2"
);
check(
  "blockId prefix match still finds the short label",
  resolveTargetLabel(
    viol({ ruleId: "D5", severity: "warn", locator: { blockId: "b_1_0" } }),
    [{ label: "1" }, { label: "1.2" }],
    []
  ),
  "1"
);
check(
  "bv_ visual ids resolve the same way",
  resolveTargetLabel(
    viol({ ruleId: "D5", severity: "warn", locator: { blockId: "bv_1_2_abc" } }),
    [{ label: "1" }, { label: "1.2" }],
    []
  ),
  "1.2"
);
check(
  "a look-alike label prefix without its separator does not match",
  resolveTargetLabel(
    viol({ ruleId: "D5", severity: "warn", locator: { blockId: "b_10_2" } }),
    [{ label: "1" }],
    []
  ),
  null
);
check(
  "requirementId maps to the structure label even when undrafted",
  resolveTargetLabel(
    viol({ ruleId: "C3", severity: "block", locator: { requirementId: "r1" } }),
    [],
    [{ id: "r1", structureLabel: "4.2" }]
  ),
  "4.2"
);
check(
  "an empty locator resolves to null",
  resolveTargetLabel(viol({ ruleId: "A1", severity: "block" }), [{ label: "1" }], []),
  null
);

// ---- fixRecipe: kind per rule ----------------------------------------------

const ctx = {
  sections: [{ label: "1" }, { label: "1.2" }, { label: "4.2" }],
  requirements: [
    { id: "r1", structureLabel: "4.2" },
    { id: "r2", structureLabel: "9.9" },
  ],
};
const kindOf = (v: Violation) => {
  const r = fixRecipe(v, ctx);
  return r.kind === "tron"
    ? `tron:${r.label}${r.ask ? ":ask" : ""}`
    : r.kind === "redraft"
      ? `redraft:${r.label}`
      : r.kind;
};

check(
  "A1 with a section locator is a plain tron on it",
  kindOf(
    viol({ ruleId: "A1", severity: "block", locator: { sectionId: "sec_1_2" } })
  ),
  "tron:1.2"
);
check(
  "A1 with no locator sweeps the whole document",
  kindOf(viol({ ruleId: "A1", severity: "block" })),
  `tron:${DOC_LABEL}`
);
for (const id of ["A2", "A3", "A4", "A6", "A7", "A8", "C5", "C6", "D1", "D2", "D3"])
  check(
    `${id} is a plain tron`,
    kindOf(viol({ ruleId: id, severity: "warn", locator: { blockId: "b_1_0" } })),
    "tron:1"
  );
check(
  "A5 asks for the real fact",
  kindOf(
    viol({ ruleId: "A5", severity: "block", locator: { sectionId: "sec_1" } })
  ),
  "tron:1:ask"
);
check(
  "B7 asks for the figure's source",
  kindOf(viol({ ruleId: "B7", severity: "block", locator: { blockId: "b_1_2_0" } })),
  "tron:1.2:ask"
);
check(
  "C1 block redrafts the section",
  kindOf(
    viol({ ruleId: "C1", severity: "block", locator: { sectionId: "sec_4_2" } })
  ),
  "redraft:4.2"
);
check(
  "C1 warn (kb advisory) is a none",
  kindOf(viol({ ruleId: "C1", severity: "warn" })),
  "none"
);
check(
  "C3 on a drafted section is a tron with an ask on the structure label",
  kindOf(
    viol({ ruleId: "C3", severity: "block", locator: { requirementId: "r1" } })
  ),
  "tron:4.2:ask"
);
{
  const r = fixRecipe(
    viol({ ruleId: "C3", severity: "block", locator: { requirementId: "r2" } }),
    ctx
  );
  check("C3 on an undrafted section is a none", r.kind, "none");
  check(
    "the C3 undrafted message names the section",
    r.kind === "none" ? r.message : "",
    "Draft section 9.9 first; this requirement is answered there."
  );
}
check("C2 is a none", kindOf(viol({ ruleId: "C2", severity: "block" })), "none");
check("C4 is a none", kindOf(viol({ ruleId: "C4", severity: "block" })), "none");
for (const id of ["B1", "B3", "B5"])
  check(
    `${id} points at the pricing sheet`,
    kindOf(viol({ ruleId: id, severity: "block" })),
    "pricing"
  );
check(
  "B4 points at the questionnaire",
  (() => {
    const r = fixRecipe(viol({ ruleId: "B4", severity: "block" }), ctx);
    return r.kind === "pricing" && r.message.includes("fully-managed split");
  })(),
  true
);
check(
  "B2 with an excerpt (hedge scan) is a tron",
  kindOf(
    viol({
      ruleId: "B2",
      severity: "block",
      excerpt: "about $3,705",
      locator: { blockId: "b_1_0" },
    })
  ),
  "tron:1"
);
check(
  "B2 with no excerpt and no span locator (the floor) is pricing",
  kindOf(viol({ ruleId: "B2", severity: "block" })),
  "pricing"
);
check(
  "B6 optional-vs-included prose is a tron sweep",
  kindOf(
    viol({
      ruleId: "B6",
      severity: "warn",
      message:
        '"xl secure+" is described as both optional and included. Optional add-ons must not read as included in one section and optional in another.',
    })
  ),
  `tron:${DOC_LABEL}`
);
check(
  "B6 undeclared pass-through is pricing",
  kindOf(
    viol({
      ruleId: "B6",
      severity: "warn",
      message:
        "Licensing or hardware is mentioned but the quote declares no pass-through items.",
    })
  ),
  "pricing"
);
check(
  "D4 edge-of-range (no section locator) asks for context",
  kindOf(viol({ ruleId: "D4", severity: "warn" })),
  `tron:${DOC_LABEL}:ask`
);
check(
  "D4 missing-forward-commitment (section locator) is a plain tron",
  kindOf(
    viol({
      ruleId: "D4",
      severity: "warn",
      locator: { sectionId: "sec_4_2", requirementId: "r1" },
    })
  ),
  "tron:4.2"
);
check(
  "D5 is a plain tron on the block's section",
  kindOf(viol({ ruleId: "D5", severity: "warn", locator: { blockId: "b_1_2_4" } })),
  "tron:1.2"
);
check(
  "an unknown future rule still gets a working tron",
  kindOf(viol({ ruleId: "Z9", severity: "warn" })),
  `tron:${DOC_LABEL}`
);

// ---- fixInstruction ---------------------------------------------------------

check(
  "instruction composes message, excerpt, suggestion and context",
  fixInstruction(
    viol({
      ruleId: "A8",
      severity: "warn",
      message: "CIS scope overstated.",
      excerpt: "all  CIS\ncontrols",
      suggestion: "a subset of CIS Controls v8",
    }),
    "  the client asked about CIS  "
  ),
  'Fix compliance finding A8: CIS scope overstated. The offending text: "all CIS controls". Preferred wording or direction: a subset of CIS Controls v8 Additional context from the user: the client asked about CIS Change only what is needed to resolve this finding; keep everything else as it is.'
);
check(
  "instruction caps at 2000 chars",
  fixInstruction(
    viol({ ruleId: "A1", severity: "block", message: "y".repeat(4000) }),
    ""
  ).length,
  2000
);

// ---- a finding on a reference card never goes to the brain (§5.17.10) ----------
check("card id: a lifted reference card", isReferenceCardBlockId("bv_7__v_0000a010_2"), true);
check("card id: a worded label", isReferenceCardBlockId("bv_Client_References_v_1f2e3d4c_10"), true);
check("card id: an ordinary visual has no card number", isReferenceCardBlockId("bv_7__v_0000a010"), false);
check("card id: a prose block", isReferenceCardBlockId("b_7__1"), false);
check("card id: not hex", isReferenceCardBlockId("bv_7__v_0000zzzz_1"), false);
check("card id: absent", isReferenceCardBlockId(undefined), false);
for (const ruleId of ["D1", "A5", "B7", "D2", "Z9"]) {
  const recipe = fixRecipe(
    viol({
      ruleId,
      severity: "block",
      locator: { blockId: "bv_7__v_0000a010_1", sectionId: "sec_7_" },
      excerpt: "Alex Rivera, COO 312-555-0142 a.rivera@example.org",
    }),
    { sections: [{ label: "7." }], requirements: [] }
  );
  check(`card finding ${ruleId}: no Tron run, the edit pointer instead`, recipe, {
    kind: "none",
    message: REFERENCE_CARD_FIX_MESSAGE,
  });
}
check(
  "the pointer's wording",
  REFERENCE_CARD_FIX_MESSAGE,
  "Edit the references on this section: use Edit references on the cards."
);
check(
  "an ordinary visual's finding still gets its Tron recipe",
  fixRecipe(viol({ ruleId: "D1", severity: "block", locator: { blockId: "bv_7__v_0000a010" } }), { sections: [{ label: "7." }], requirements: [] }).kind,
  "tron"
);

// ---- grouped findings (§5.17.8): one row per rule id and message -----------

// The owner's duplicate: scanForbiddenPhrases emits one violation per text
// span, so one phrase in two paragraphs arrived as two identical rows.
const a6Message =
  'A6 "power automate development" contradicts the negative fact capability.sharepoint-power-platform: we do not build Power Automate flows.';
const a6One = viol({
  ruleId: "A6",
  severity: "block",
  message: a6Message,
  locator: { sectionId: "sec_4_2", blockId: "b_4_2_0", field: "body", charOffset: 10 },
  excerpt: "power automate development",
});
const a6Two = viol({
  ruleId: "A6",
  severity: "block",
  message: a6Message,
  locator: { sectionId: "sec_4_2", blockId: "b_4_2_3", field: "body", charOffset: 44 },
  excerpt: "Power Automate  development",
});
{
  const groups = groupFindings([a6One, a6Two]);
  check("the duplicate A6 pair is ONE group", groups.length, 1);
  check("with both members", groups[0]?.members.length, 2);
  check("blocking", groups[0]?.severity, "block");
  check("members keep their own sigs", groups[0]?.members.map(findingSig), [
    findingSig(a6One),
    findingSig(a6Two),
  ]);
}
check(
  "differing messages are two groups",
  groupFindings([a6One, { ...a6Two, message: "Another finding." }]).length,
  2
);
check(
  "a whitespace-only message difference collapses",
  groupFindings([a6One, { ...a6Two, message: a6Message.replace(/ /g, "  \n") }])
    .length,
  1
);
check(
  "same message, different rule: two groups",
  groupFindings([a6One, { ...a6Two, ruleId: "A7" }]).length,
  2
);
check(
  "any blocking member makes the group block",
  groupFindings([
    { ...a6One, severity: "warn" },
    a6Two,
  ])[0]?.severity,
  "block"
);
check(
  "groups come out in order of first appearance",
  groupFindings([
    viol({ ruleId: "D1", severity: "warn", message: "x" }),
    a6One,
    viol({ ruleId: "D1", severity: "warn", message: "x" }),
  ]).map((g) => [g.ruleId, g.members.length]),
  [
    ["D1", 2],
    ["A6", 1],
  ]
);

// ---- groupFixPlan -----------------------------------------------------------

{
  const plan = groupFixPlan(groupFindings([a6One, a6Two])[0], ctx);
  check("two members in one section: ONE step", plan.length, 1);
  check(
    "a tron step on that section",
    plan.map((p) => (p.kind === "tron" ? `tron:${p.label}` : p.kind)),
    ["tron:4.2"]
  );
  const instr = plan[0]?.kind === "tron" ? plan[0].instruction : "";
  check("the message is said once", instr.split(a6Message).length - 1, 1);
  check(
    "both excerpts are in the instruction",
    instr.includes('"power automate development"; "Power Automate development"'),
    true
  );
  check("no ask on a plain rule", plan[0]?.kind === "tron" && plan[0].ask, undefined);
}
{
  const other = { ...a6Two, locator: { sectionId: "sec_1_2", blockId: "b_1_2_0" } };
  const plan = groupFixPlan(groupFindings([a6One, other])[0], ctx);
  check(
    "members in two sections: ONE whole-document step",
    plan.map((p) => (p.kind === "tron" ? `tron:${p.label}` : p.kind)),
    [`tron:${DOC_LABEL}`]
  );
}
{
  const noLoc = { ...a6Two, locator: {} };
  const plan = groupFixPlan(groupFindings([a6One, noLoc])[0], ctx);
  check(
    "a member already at DOC_LABEL sends the group to the sweep",
    plan.map((p) => (p.kind === "tron" ? p.label : p.kind)),
    [DOC_LABEL]
  );
}
{
  const c1 = viol({
    ruleId: "C1",
    severity: "block",
    message: "Fact corrected after drafting.",
    locator: { sectionId: "sec_4_2" },
  });
  const plan = groupFixPlan(groupFindings([c1, { ...c1 }])[0], ctx);
  check("C1 block members: one redraft", plan, [
    { kind: "redraft", label: "4.2", why: "Fact corrected after drafting." },
  ]);
  check("a redraft is auto-fixable", isAutoFixable(plan), true);
}
{
  const b4 = viol({ ruleId: "B4", severity: "block", message: "Split unconfirmed." });
  const plan = groupFixPlan(groupFindings([b4, { ...b4 }])[0], ctx);
  check(
    "B4 members: ONE pricing step",
    plan.map((p) => p.kind),
    ["pricing"]
  );
  check("pricing is not auto-fixable", isAutoFixable(plan), false);
}
check(
  "a none is not auto-fixable",
  isAutoFixable(groupFixPlan(groupFindings([viol({ ruleId: "C2", severity: "block" })])[0], ctx)),
  false
);
check(
  "a tron step is auto-fixable",
  isAutoFixable(groupFixPlan(groupFindings([a6One])[0], ctx)),
  true
);
{
  const a5 = viol({ ruleId: "A5", severity: "block", message: "Uncited.", locator: { sectionId: "sec_1" } });
  const plan = groupFixPlan(groupFindings([a5, { ...a5, locator: { sectionId: "sec_1", blockId: "b_1_3" } }])[0], ctx);
  check(
    "the same ask on every member survives the collapse",
    plan[0]?.kind === "tron" ? Boolean(plan[0].ask) : null,
    true
  );
}
{
  const single = groupFixPlan(groupFindings([a6One])[0], ctx);
  const recipe = fixRecipe(a6One, ctx);
  check("a one-member group's plan IS its recipe", single, [recipe]);
}

// ---- fixInstructionFor ------------------------------------------------------

for (const v of [
  a6One,
  viol({ ruleId: "A8", severity: "warn", message: "CIS scope overstated.", excerpt: "all  CIS\ncontrols", suggestion: "a subset" }),
  viol({ ruleId: "A1", severity: "block" }),
])
  for (const extra of ["", "  context  "])
    check(
      `fixInstruction(${v.ruleId}, ${JSON.stringify(extra)}) equals fixInstructionFor([v])`,
      fixInstruction(v, extra),
      fixInstructionFor([v], extra)
    );
check("fixInstructionFor of nothing is empty", fixInstructionFor([], "x"), "");

// ---- fixAllSteps: one pass of the Fix all round -----------------------------

{
  const d1 = viol({ ruleId: "D1", severity: "warn", message: "Vague.", locator: { blockId: "b_4_2_1" }, excerpt: "world class" });
  const c1 = viol({ ruleId: "C1", severity: "block", message: "Stale fact.", locator: { sectionId: "sec_1" } });
  const b4 = viol({ ruleId: "B4", severity: "block", message: "Split." });
  const sweep = viol({ ruleId: "B6", severity: "warn", message: '"x" is described as both optional and included.' });
  const d1on1 = viol({ ruleId: "D2", severity: "warn", message: "Passive.", locator: { blockId: "b_1_0" }, excerpt: "was done" });
  const steps = fixAllSteps(groupFindings([sweep, a6One, a6Two, d1, c1, b4, d1on1]), ctx);
  check(
    "fixAll: redrafts first, then per-section tron, the sweep last; pricing waits; a redrafted section is not also revised",
    steps.map((st) => (st.kind === "tron" || st.kind === "redraft" ? `${st.kind}:${st.label}` : st.kind)),
    ["redraft:1", "tron:4.2", `tron:${DOC_LABEL}`]
  );
  const merged = steps[1]?.kind === "tron" ? steps[1].instruction : "";
  check(
    "fixAll: one section's findings merge into one instruction",
    merged.includes("A6") && merged.includes("D1"),
    true
  );
  check("fixAll: no ask survives into the round", steps.some((st) => st.kind === "tron" && st.ask), false);
}
{
  const many = Array.from({ length: 6 }, (_, i) =>
    viol({ ruleId: "D1", severity: "warn", message: `Finding ${i} ${"z".repeat(600)}`, locator: { blockId: "b_4_2_1" } })
  );
  const steps = fixAllSteps(groupFindings(many), ctx);
  check(
    "fixAll: an oversize merge packs into several whole instructions under the cap",
    steps.every((st) => st.kind === "tron" && st.label === "4.2" && st.instruction.length <= 2000) && steps.length > 1,
    true
  );
  check(
    "fixAll: every packed instruction ends with its guard",
    steps.every((st) => st.kind === "tron" && st.instruction.endsWith("keep everything else as it is.")),
    true
  );
}
check("fixAll: nothing visible, nothing to do", fixAllSteps([], ctx), []);
{
  // Two C1 groups (different messages) on one label: ONE rebuild.
  const c1a = viol({ ruleId: "C1", severity: "block", message: "Fact A corrected.", locator: { sectionId: "sec_4_2" } });
  const c1b = viol({ ruleId: "C1", severity: "block", message: "Fact B corrected.", locator: { sectionId: "sec_4_2" } });
  check(
    "fixAll: redrafts dedupe across two groups on one label",
    fixAllSteps(groupFindings([c1a, c1b]), ctx).map((st) => `${st.kind}:${st.kind === "redraft" ? st.label : ""}`),
    ["redraft:4.2"]
  );
  const again = fixAllSteps(groupFindings([c1a, c1b, a6One]), ctx, { noRedraft: new Set(["4.2"]) });
  check(
    "fixAll: a label already rebuilt is not redrafted again, and its Tron steps return",
    again.map((st) => (st.kind === "tron" || st.kind === "redraft" ? `${st.kind}:${st.label}` : st.kind)),
    ["tron:4.2"]
  );
}
{
  const s1 = viol({ ruleId: "B6", severity: "warn", message: '"x" is described as both optional and included.' });
  const s2 = viol({ ruleId: "A1", severity: "block", message: "Banned phrase." });
  const steps = fixAllSteps(groupFindings([s1, s2]), ctx);
  check(
    "fixAll: two DOC_LABEL groups union into ONE sweep step",
    steps.map((st) => (st.kind === "tron" ? st.label : st.kind)),
    [DOC_LABEL]
  );
  const ins = steps[0]?.kind === "tron" ? steps[0].instruction : "";
  check("fixAll: the sweep carries both findings", ins.includes("B6") && ins.includes("A1"), true);
}
{
  const b7 = viol({ ruleId: "B7", severity: "block", message: "Unsourced figure.", locator: { blockId: "b_1_2_0" }, excerpt: "$4,200" });
  check(
    "fixAll: a B7 member is never an actionable step",
    fixAllSteps(groupFindings([b7, a6One]), ctx).map((st) => (st.kind === "tron" ? st.label : st.kind)),
    ["4.2"]
  );
  check("fixAll: B7 alone gives the round nothing", fixAllSteps(groupFindings([b7]), ctx), []);
  check("B7 is excluded from the Fix all count", isAutoFixableGroup(groupFindings([b7])[0], ctx), false);
  check("B7's own Fix it still has its recipe", groupFixPlan(groupFindings([b7])[0], ctx)[0]?.kind, "tron");
  check("A5 stays automatic", isAutoFixableGroup(groupFindings([viol({ ruleId: "A5", severity: "block", locator: { sectionId: "sec_1" } })])[0], ctx), true);
}
{
  // D1 emits one finding per em dash: a 60-member group.
  const many = Array.from({ length: 60 }, (_, i) =>
    viol({
      ruleId: "D1",
      severity: "warn",
      message: "Em dash in client-facing copy.",
      locator: { blockId: `b_4_2_${i}` },
      excerpt: `sentence ${i} ${"w".repeat(80)} with a dash`,
    })
  );
  const ins = fixInstructionFor(many, "the client prefers commas");
  check("60 members: under the cap", ins.length <= 2000, true);
  check(
    "60 members: ends with the guard",
    ins.endsWith("Change only what is needed to resolve this finding in every place it appears; keep everything else as it is."),
    true
  );
  check("60 members: keeps the user's context", ins.includes("Additional context from the user: the client prefers commas"), true);
  check("60 members: lists six places and counts the rest", ins.includes("and 54 more places."), true);
  check("60 members: the seventh excerpt is not listed", ins.includes("sentence 6 "), false);
  const huge = fixInstructionFor(
    [viol({ ruleId: "A1", severity: "block", message: "y".repeat(4000) })],
    "keep this"
  );
  check("an oversize message never cuts the context or the guard", huge.endsWith("Additional context from the user: keep this Change only what is needed to resolve this finding; keep everything else as it is."), true);
  check("and still fills the cap", huge.length, 2000);
}

// ---- atRev survives the re-apply --------------------------------------------

{
  const stamped: GateResult = { ...result([a6One]), atRev: 7 };
  check("applyIgnores preserves atRev", applyIgnores(stamped, [ign(findingSig(a6One))]).atRev, 7);
  check("applyIgnores adds no atRev to a pre-round row", "atRev" in applyIgnores(result([a6One]), []), false);
}

if (failures) {
  console.error(`\n${failures} failing`);
  process.exit(1);
}
console.log("\nall passing");
