/**
 * Cover-letter + signature unit tests (ARCHITECTURE.md §5.17.4).
 *
 *   npm run test:rfpletter
 *
 * Pure, no server. Pins the reserved-label forgery gate and the signature
 * resolver in both directions: the strip must neutralize any client label
 * that would land in a reserved slot, and it must not touch ordinary labels
 * (rule C4 keeps client labels verbatim).
 */

import {
  DEFAULT_LETTER_BODY,
  LETTER_LABEL,
  LETTER_TITLE,
  labelDisplaysWorded,
  splitSections,
  stripReservedPrefix,
} from "../src/lib/rfp/letter";
import { sectionKicker } from "../src/lib/rfp/export-assets";
import { COMPANY_SIGNATURE, signatureFor } from "../src/lib/rfp/signature";
import type { DraftSectionRecord } from "../src/app/api/rfp/documents/[id]/generate/route";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`ok   ${label}`);
  else {
    failures += 1;
    console.log(`FAIL ${label}\n  expected ${e}\n  got      ${a}`);
  }
}

const rec = (label: string, generatedBy: "llm" | "human" = "llm"): DraftSectionRecord => ({
  label,
  title: label,
  paragraphs: ["p"],
  cites: [],
  gaps: [],
  generatedBy,
  updatedAt: "2026-08-02T00:00:00.000Z",
});

// ---- reserved-label strip: hostile labels neutralized, real ones verbatim
check("strips __letter", stripReservedPrefix("__letter"), "letter");
check("strips any run of underscores", stripReservedPrefix("____x"), "x");
check("single underscore stripped too", stripReservedPrefix("_1"), "1");
check("plain numeric label untouched", stripReservedPrefix("4.2"), "4.2");
check("roman label untouched", stripReservedPrefix("III"), "III");
check("interior underscore untouched", stripReservedPrefix("A_1"), "A_1");
check("empty stays empty", stripReservedPrefix(""), "");

// ---- splitSections: exact reserved label only
{
  const letter = rec(LETTER_LABEL);
  const s1 = rec("1");
  const { letter: l, sections } = splitSections([s1, letter]);
  check("letter split out", l?.label, LETTER_LABEL);
  check("sections keep the rest", sections.map((s) => s.label), ["1"]);
}
check(
  "near-miss labels are ordinary sections",
  splitSections([rec("__Letter"), rec(" __letter"), rec("__letter2")]).letter,
  null
);
check("no letter yields null", splitSections([rec("1")]).letter, null);
check("default body is non-empty", DEFAULT_LETTER_BODY.length > 0, true);
check("letter title constant", LETTER_TITLE, "Cover Letter");

// ---- signatureFor: directory hit vs fallback
{
  const adam = signatureFor("Adam@XL.net", "ignored display name");
  check("adam resolves by lowercased email", adam.name, "Adam Radulovic");
  check("adam title", adam.title, "CEO");
  check("adam phone", adam.phone, "847.242.1299");
  check("adam fax", adam.fax, "847.686.0201");
  check(
    "adam linkedin is https",
    adam.linkedinUrl?.startsWith("https://"),
    true
  );
}
{
  const other = signatureFor("jordan@xl.net", "Jordan Sample");
  check("fallback uses display name", other.name, "Jordan Sample");
  check("fallback has no title", other.title, null);
  check("fallback has no phone", other.phone, null);
  check("fallback keeps email", other.email, "jordan@xl.net");
}

// ---- the constant company half never varies per signer
check("company name", COMPANY_SIGNATURE.name, "XL.net");
check(
  "tagline split matches the source email",
  [COMPANY_SIGNATURE.tagline.orange, COMPANY_SIGNATURE.tagline.navy],
  ["XLerate Your ", "Business"]
);
check("two article links", COMPANY_SIGNATURE.articles.length, 2);
check(
  "article titles carry the byline suffix",
  COMPANY_SIGNATURE.articles.every((a) => a.title.endsWith("(by XL.net)")),
  true
);

// ---- labelDisplaysWorded parity with the kicker display rule (§5.17.1).
// The retitle op decides which slot a new header lands in by asking whether
// the LABEL is what the reader sees, and that must match sectionKicker
// (export-assets.ts, itself a pinned replica of the workspace's secKicker)
// byte for byte: worded ⇔ the kicker renders the label verbatim.
for (const label of [
  "8",
  "3.1",
  "IV",
  "III",
  "VII",
  "F.",
  "4.2",
  "A",
  "June 8th, 2026:",
  "June 19 2026:",
  "Current IT Provider Issues (Entiva)",
  "Next Steps",
  "Section 4",
  "mix III words",
  "",
  "   ",
  "MMMM",
  "IIX",
]) {
  check(
    `worded-label parity: ${JSON.stringify(label)}`,
    labelDisplaysWorded(label),
    sectionKicker(label) === label.trim() && label.trim() !== ""
  );
}

if (failures) {
  console.log(`\n${failures} failing`);
  process.exit(1);
}
console.log("\nall passing");
