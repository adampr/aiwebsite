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
  fixInstruction,
  fixRecipe,
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

if (failures) {
  console.error(`\n${failures} failing`);
  process.exit(1);
}
console.log("\nall passing");
