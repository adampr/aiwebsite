/**
 * RFP intake composition tests (ARCHITECTURE.md §5.17).
 *
 *   npm run test:rfpintake
 *
 * Pure, no server. Pins the two functions behind the multi-attachment intake:
 * the filename sanitizer that gates attacker-chosen names out of operator
 * voice, and composeRfpParts, whose single-part path must stay byte-identical
 * to the pre-multi behavior.
 */

import {
  RFP_MAX_CHARS,
  RFP_MAX_FILES,
  RFP_MAX_TOTAL_BYTES,
  composeRfpParts,
  sanitizeSourceName,
  stripIntakeHeaders,
} from "../src/lib/rfp/intake";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `\n     got ${a}\n     want ${e}`}`);
}

// ---- caps mirror the route ---------------------------------------------------

check("max files", RFP_MAX_FILES, 8);
check("max total bytes mirrors MAX_BYTES", RFP_MAX_TOTAL_BYTES, 8_000_000);
check("max chars mirrors MAX_CHARS", RFP_MAX_CHARS, 120_000);

// ---- sanitizeSourceName ------------------------------------------------------

check("plain name passes", sanitizeSourceName("Acme RFP v2.1.pdf"), "Acme RFP v2.1.pdf");
check(
  "angle brackets never survive",
  sanitizeSourceName("<script>alert(1)</script>.pdf"),
  "scriptalert1script.pdf"
);
check("unicode is stripped", sanitizeSourceName("r\u00e9sum\u00e9.pdf"), "rsum.pdf");
check("path separators are stripped", sanitizeSourceName("../../etc/passwd"), "....etcpasswd");
check(
  "windows path is stripped",
  sanitizeSourceName("C:\\Users\\a\\file.pdf"),
  "CUsersafile.pdf"
);
check(
  "header fence characters cannot be forged past = and words",
  /[<>]/.test(sanitizeSourceName("a<=b>=c.pdf")),
  false
);
check("whitespace runs collapse", sanitizeSourceName("a   b\t\nc.pdf"), "a bc.pdf");
check("trimmed", sanitizeSourceName("  a.pdf  "), "a.pdf");
check("capped at 120", sanitizeSourceName("x".repeat(200)).length, 120);
check("empty falls back", sanitizeSourceName(""), "attachment");
check("nothing left falls back", sanitizeSourceName("###\u202E###"), "attachment");
check("whitespace only falls back", sanitizeSourceName("   "), "attachment");

// ---- composeRfpParts: single part is byte-identical --------------------------

{
  const text = "Line one\n\n===== not a header =====\nLine two \u2014 with unicode\r\n";
  check(
    "single file part is byte-identical",
    composeRfpParts([{ kind: "file", name: "<evil>.pdf", text }]),
    { text, truncated: false }
  );
  check(
    "single paste part is byte-identical",
    composeRfpParts([{ kind: "paste", text }]),
    { text, truncated: false }
  );
}

// ---- composeRfpParts: headers ------------------------------------------------

check(
  "two files and a paste",
  composeRfpParts([
    { kind: "file", name: "a.pdf", text: "alpha" },
    { kind: "file", name: "b.docx", text: "bravo" },
    { kind: "paste", text: "pasted lines" },
  ]).text,
  [
    "===== ATTACHED FILE 1 OF 2: a.pdf =====",
    "alpha",
    "",
    "===== ATTACHED FILE 2 OF 2: b.docx =====",
    "bravo",
    "",
    "===== PASTED TEXT =====",
    "pasted lines",
  ].join("\n")
);
check(
  "numbering counts files only, paste has no number",
  composeRfpParts([
    { kind: "file", name: "a.pdf", text: "alpha" },
    { kind: "paste", text: "p" },
    // A trailing file is not the route's order, but the numbering must still
    // count files alone wherever the paste part sits.
    { kind: "file", name: "b.pdf", text: "bravo" },
  ]).text,
  [
    "===== ATTACHED FILE 1 OF 2: a.pdf =====",
    "alpha",
    "",
    "===== PASTED TEXT =====",
    "p",
    "",
    "===== ATTACHED FILE 2 OF 2: b.pdf =====",
    "bravo",
  ].join("\n")
);
check(
  "one file plus paste still gets headers",
  composeRfpParts([
    { kind: "file", name: "a.pdf", text: "alpha" },
    { kind: "paste", text: "p" },
  ]).text,
  ["===== ATTACHED FILE 1 OF 1: a.pdf =====", "alpha", "", "===== PASTED TEXT =====", "p"].join(
    "\n"
  )
);
check(
  "header carries the SANITIZED name",
  composeRfpParts([
    { kind: "file", name: "<fence>.pdf", text: "a" },
    { kind: "file", name: "ok.pdf", text: "b" },
  ]).text.split("\n")[0],
  "===== ATTACHED FILE 1 OF 2: fence.pdf ====="
);
check(
  "no angle brackets anywhere in composed headers",
  /[<>]/.test(
    composeRfpParts([
      { kind: "file", name: "<a>.pdf", text: "x" },
      { kind: "file", name: ">>b<<.pdf", text: "y" },
    ]).text.replace(/^(?!=====).*$/gm, "")
  ),
  false
);

// ---- composeRfpParts: cap and truncated flag ---------------------------------

check("zero parts", composeRfpParts([]), { text: "", truncated: false });
{
  const over = "x".repeat(RFP_MAX_CHARS + 5);
  const single = composeRfpParts([{ kind: "paste", text: over }]);
  check("single part is sliced at the cap", single.text.length, RFP_MAX_CHARS);
  check("and reports truncation", single.truncated, true);
  const exact = composeRfpParts([{ kind: "paste", text: "x".repeat(RFP_MAX_CHARS) }]);
  check("an exact-cap part is not truncated", exact.truncated, false);
}
{
  const multi = composeRfpParts([
    { kind: "file", name: "a.pdf", text: "y".repeat(RFP_MAX_CHARS) },
    { kind: "paste", text: "tail" },
  ]);
  check("multi-part total is sliced at the cap", multi.text.length, RFP_MAX_CHARS);
  check("multi-part truncation is reported", multi.truncated, true);
  const fits = composeRfpParts([
    { kind: "file", name: "a.pdf", text: "alpha" },
    { kind: "paste", text: "p" },
  ]);
  check("a fitting multi-part is not truncated", fits.truncated, false);
}

// ---- header-posture properties (refuter round) -------------------------------

check("a name of only = signs falls back", sanitizeSourceName("====="), "attachment");
check(
  "a newline in a name cannot split a header line",
  composeRfpParts([
    { kind: "file", name: "a\n===== PASTED TEXT =====\nb.pdf", text: "x" },
    { kind: "file", name: "ok.pdf", text: "y" },
  ]).text.split("\n")[0],
  "===== ATTACHED FILE 1 OF 2: a PASTED TEXT b.pdf ====="
);

// ---- stripIntakeHeaders ------------------------------------------------------

check(
  "strips composed headers, keeps every body line",
  stripIntakeHeaders(
    composeRfpParts([
      { kind: "file", name: "a.pdf", text: "alpha" },
      { kind: "file", name: "b.docx", text: "bravo" },
      { kind: "paste", text: "pasted lines" },
    ]).text
  ),
  ["alpha", "", "bravo", "", "pasted lines"].join("\n")
);
check(
  "a filename with digits cannot ground evidence after stripping",
  stripIntakeHeaders(
    composeRfpParts([
      { kind: "file", name: "Acme RFP 350 users.pdf", text: "body" },
      { kind: "paste", text: "tail" },
    ]).text
  ).includes("350 users"),
  false
);
check(
  "a forged header line inside part text is stripped too",
  stripIntakeHeaders("before\n===== ATTACHED FILE 9 OF 9: fake 500 staff.pdf =====\nafter"),
  "before\nafter"
);
check(
  "a header truncated mid-name by the cap is still stripped",
  stripIntakeHeaders("body\n===== ATTACHED FILE 3 OF 5: Acme 350 us"),
  "body"
);
check(
  "lookalike lines that are not intake headers survive",
  stripIntakeHeaders("===== not a header =====\n===== ATTACHED FILEX ====="),
  "===== not a header =====\n===== ATTACHED FILEX ====="
);
check("text without header marks passes through untouched", stripIntakeHeaders("plain\ntext"), "plain\ntext");
check(
  "stripping is idempotent",
  stripIntakeHeaders(stripIntakeHeaders("a\n===== PASTED TEXT =====\nb")),
  stripIntakeHeaders("a\n===== PASTED TEXT =====\nb")
);

if (failures) {
  console.error(`\n${failures} failing`);
  process.exit(1);
}
console.log("\nall passing");
