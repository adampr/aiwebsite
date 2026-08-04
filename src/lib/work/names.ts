// Name comparison for team work submissions (§5.16): the leaf-most pure
// pieces. Split out of email-parse.ts because lint.ts needs nameKey too and
// email-parse.ts already imports stringViolations FROM lint.ts; keeping
// these here avoids the cycle. NO EM DASHES in any string (site rule).

/** Comparison key for names: case, hyphens, underscores and punctuation all
 * collapse, so "patching-visualizer" (a package slug) and "Patching
 * Visualizer" (the card title) compare equal. Must be applied to BOTH sides of
 * every name comparison. */
export function nameKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** A package slug shape ("entra-m365-security-analyzer"): a filename, not a
 * card title. Shared by looksLikeAWorkName and the echo strip's
 * which-side-survives rule. */
export const SLUG_SHAPE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;

/** Machine-name echo (2026-08-04 incident: "Entra/M365 Security Analyzer
 * (entra-m365-security-analyzer)" published as a card title at 59
 * characters, inside the 60 band, and minted a doubled, truncated slug): a
 * TRAILING parenthetical
 * whose nameKey equals the head's is the tool's own name stated twice, never
 * a second name. Exact nameKey equality only, and only at the end of the
 * string: a prefix/truncated rule would guess which half is the name and
 * could collapse "Analyzer (Entra Analyzer)" into the vaguer half. The
 * equality is lossless up to nameKey's punctuation folding, no further:
 * "C Analyzer (C++ Analyzer)" strips, and the ++ variant is gone. That is
 * accepted because the surviving side is always a verbatim span the
 * submitter typed, and every call site either discloses the result or
 * rejects outright. The
 * empty-key guard is load-bearing: without it "!!! (???)" (both keys "")
 * would match. Returns the split so reject copy can name the corrected
 * title, or null when the shape is absent. */
export function splitMachineEcho(
  t: string
): { head: string; inner: string } | null {
  // Length guard before the recursion: every intake lane caps titles well
  // below this, but lintCard runs string bans on RAW model output before
  // the band violation stops anything, and a pathological stacked-echo
  // string can otherwise exhaust the stack (refutation finding 2026-08-04).
  if (t.length > 400) return null;
  const m = /^(.*\S)\s*\(\s*([^()]+?)\s*\)$/.exec(t.trim());
  if (!m) return null;
  // The head is FULLY stripped before comparing, so stacked echoes ("Foo
  // Tool (foo-tool) (foo-tool)") are recognized: the raw head still carries
  // the first echo and would never compare equal on its own. Mutual
  // recursion with stripMachineEcho terminates because the head is strictly
  // shorter than the input.
  const head = stripMachineEcho(m[1]);
  const key = nameKey(head);
  if (key === "" || key !== nameKey(m[2])) return null;
  return { head, inner: m[2] };
}

/** Remove a trailing machine-name echo (stacked echoes collapse via the
 * recursion in splitMachineEcho). When the surviving HEAD is the
 * slug-shaped half and the parenthetical is not ("entra-analyzer (Entra
 * Analyzer)"), the parenthetical form survives: both halves are the same
 * name by nameKey, so keeping the human-shaped one is selection, not
 * authoring. Deleting a segment nameKey-equal to what remains is the one
 * adaptation of a title that is not a rename (the update lane already
 * ignores authored Title: lines on exactly this equality). */
export function stripMachineEcho(t: string): string {
  const s = t.trim();
  const echo = splitMachineEcho(s);
  if (!echo) return s;
  return SLUG_SHAPE_RE.test(echo.head) && !SLUG_SHAPE_RE.test(echo.inner)
    ? echo.inner
    : echo.head;
}
