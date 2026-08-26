// Roadmap snapshot rendering + re-import (§5.18 <-> §5.12 bridge, owner
// directive 2026-08-20: "Even final governance should be editable in the
// future"). projectMarkdown renders a builder project's documents_json into
// the markdown copy the roadmap governance file stores;
// parseSnapshotMarkdown is its inverse, seeding a NEW builder project from
// an on-file snapshot after the source project's 30-day retention has
// removed the original. Both live here (not in the route file) so the pair
// cannot drift apart and the test suite can round-trip them directly.

import { BLUEPRINTS } from "./blueprints";
import { CAPS } from "./config";
import type { GovernanceDoc, GovernanceKind, TranscriptEntry } from "./types";

type ProjectDoc = {
  title?: unknown;
  sections?: { title?: unknown; markdown?: unknown }[];
};

/**
 * Snapshot heading floor (round 21). projectMarkdown writes each section as
 * "## <title>" followed by that section's own markdown, and
 * parseSnapshotMarkdown reads EVERY "## " line as a section boundary. A
 * drafted section routinely carries its own "## " inner headings, so the
 * round trip used to split one section into several: an 11-section AUP came
 * back as 16 to 20 sections, every ordinal moved, duplicate titles appeared,
 * and the blueprint section ids were lost. Shifting a section's headings so
 * its SHALLOWEST is "###" makes "## " mean section boundary and nothing else.
 *
 * Render-neutral: normalizeSectionBlocks rebases each section's heading depth
 * to the shallowest level that section uses, so a body written entirely in
 * "###" renders exactly like one in "##". Idempotent: a body already at "###"
 * or deeper is returned untouched, so repeated round trips never walk
 * headings deeper. Byte-safe for stub restore: no blueprint placeholder
 * contains a heading (verified across all 127 sections), so a placeholder is
 * never rewritten and the byte-exact scaffold comparison still holds. The
 * shift is clamped so nothing passes "######"; a section already spanning
 * "##" through "######" cannot shift and keeps today's ambiguity, which
 * beats corrupting its structure.
 *
 * Chosen over an in-band marker deliberately: any marker line is body text to
 * the CURRENT parser, so a marker at the file head invents a phantom document
 * that consumes the first blueprint slug and loses every stub flag, and a
 * trailing marker block lands inside the last section's stored markdown. This
 * scheme has no such rollback edge: an old server reading a new snapshot
 * parses it correctly, and better than it parses today's.
 */
export function demoteSectionHeadings(md: string): string {
  if (typeof md !== "string" || !md.includes("#")) return md;
  // MATCHES THE RENDERER, NOT THE MARKDOWN SPEC. parseMarkdown only parses
  // "#" through "####" (markdown.ts), so a heading pushed to "#####" stops
  // being a heading entirely and glues into the paragraph above as literal
  // hash characters, in the doc pane and the .docx alike, permanently. The
  // ceiling here is therefore 4, not 6.
  //
  // Fenced blocks are deliberately NOT skipped: parseMarkdown has no fenced
  // -code concept, so a "# retention in days" line inside a fence is already
  // a heading to every renderer in this system. Shifting it is consistent
  // with how it is displayed, and skipping it would leave a "# " line in the
  // body for parseSnapshotMarkdown to read as a new DOCUMENT.
  const H = /^(#{1,4})(?=\s)/;
  const lines = md.split("\n");
  let min = 5;
  let max = 0;
  for (const line of lines) {
    const m = H.exec(line);
    if (!m) continue;
    min = Math.min(min, m[1].length);
    max = Math.max(max, m[1].length);
  }
  if (max === 0 || min >= 3) return md;
  // ALL OR NOTHING. A partial shift that leaves any "## " behind fixes
  // nothing (the boundary is still ambiguous) while still rewriting bytes,
  // so a section that cannot clear level 2 without passing level 4 is left
  // exactly as it is today: today's split beats a corrupted heading.
  const shift = 3 - min;
  if (max + shift > 4) return md;
  return lines
    .map((line) => {
      const m = H.exec(line);
      return m ? `${"#".repeat(m[1].length + shift)}${line.slice(m[1].length)}` : line;
    })
    .join("\n");
}

/** Lenient flatten of a project's documents_json to markdown. Placeholder
 * and malformed sections degrade to their headings; the snapshot is a copy
 * for the company file, not a re-render. Section bodies pass through
 * demoteSectionHeadings so the "## " boundary stays unambiguous on re-import. */
export function projectMarkdown(documentsJson: string): string {
  let docs: ProjectDoc[] = [];
  try {
    const parsed = JSON.parse(documentsJson);
    if (Array.isArray(parsed)) docs = parsed as ProjectDoc[];
  } catch {
    docs = [];
  }
  const out: string[] = [];
  for (const doc of docs) {
    if (typeof doc?.title === "string") out.push(`# ${doc.title}`);
    for (const s of Array.isArray(doc?.sections) ? doc.sections : []) {
      if (typeof s?.title === "string") out.push(`\n## ${s.title}\n`);
      if (typeof s?.markdown === "string")
        out.push(demoteSectionHeadings(s.markdown));
    }
    out.push("\n\n---\n");
  }
  return out.join("\n").trim();
}

/** Transcript seed for a re-imported project: ONE numberless history row
 * (qId "imported", the reopen-row pattern) so the workspace's audit trail
 * says where the draft came from. Never matched by isQuestionEntry, so it
 * consumes no question number. */
export const IMPORTED_ENTRY_Q = "Brought back for editing";
export const IMPORTED_ENTRY_A =
  "This document was brought back into the Governance Builder from the company's AI Roadmap governance file, so it can be edited and confirmed final again.";

export function importedTranscriptEntry(nowIso: string): TranscriptEntry {
  return {
    qId: "imported",
    bankId: null,
    q: IMPORTED_ENTRY_Q,
    a: IMPORTED_ENTRY_A,
    skipped: false,
    askedAt: nowIso,
    answeredAt: nowIso,
  };
}

/** Kebab id/slug from a title; empty input falls back. Satisfies the turn
 * validator's KEBAB shape (starts/ends alphanumeric, <=64 chars). */
function kebab(s: string, fallback: string): string {
  const k = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return k || fallback;
}

/** Title canonicalization for blueprint matching (case/punctuation blind). */
function canon(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

type RawSection = { title: string; body: string[] };
type RawDoc = { title: string; sections: RawSection[] };

/**
 * Inverse of projectMarkdown, lenient by contract (never throws; malformed
 * input degrades, empty input yields []): "# " lines start a document,
 * "## " lines start a section, a bare "---" line separates documents, and
 * everything else is section body. Body content arriving before any
 * heading gets an implicit document/section rather than being dropped.
 *
 * Slugs and section ids do not survive the markdown, so they are
 * REBUILT against the kind's blueprint: doc titles canon-match blueprint
 * doc titles (retitled docs fall back to the next unused allowlisted slug
 * in blueprint order) because every turn op is validated against
 * docSlugAllowlist(kind) - an off-allowlist slug would make the seeded
 * project LOOK editable while every revise op on it silently dropped.
 * Section titles canon-match the assigned blueprint doc's section ids for
 * the same reason feeds/"slug#section" refs do; unmatched sections get
 * kebab ids derived from their titles. When the input holds more "# " docs
 * than the allowlist can carry (a body line that looked like a heading),
 * the overflow doc's sections FOLD into the last real doc - leniency must
 * never discard user text. Docs with no titled or non-empty section drop.
 *
 * Caps: sections beyond CAPS.maxSectionsPerDoc fold into the last kept
 * section, and a single body over CAPS.sectionMarkdownMaxChars splits into
 * continuation sections - both byte-preserving. Stub status is RESTORED
 * for docs whose shape is provably the stub shape (blueprint-default stub
 * or determination-bearing, all other sections byte-exact blueprint
 * placeholders): without it a confirmed-final snapshot with stub docs
 * could never re-confirm.
 */
export function parseSnapshotMarkdown(
  markdown: string,
  kind: GovernanceKind
): GovernanceDoc[] {
  const rawDocs: RawDoc[] = [];
  let doc: RawDoc | null = null;
  let section: RawSection | null = null;
  const flushSection = () => {
    if (doc && section) doc.sections.push(section);
    section = null;
  };
  const flushDoc = () => {
    flushSection();
    if (doc) rawDocs.push(doc);
    doc = null;
  };
  for (const line of (typeof markdown === "string" ? markdown : "").split(
    /\r?\n/
  )) {
    const h1 = /^#\s+(.+)$/.exec(line);
    const h2 = /^##\s+(.+)$/.exec(line);
    if (h2) {
      if (!doc) doc = { title: "", sections: [] };
      flushSection();
      section = { title: h2[1].trim().slice(0, 200), body: [] };
      continue;
    }
    if (h1) {
      flushDoc();
      doc = { title: h1[1].trim().slice(0, 200), sections: [] };
      continue;
    }
    if (/^---\s*$/.test(line)) {
      flushDoc();
      continue;
    }
    if (!line.trim() && !section) continue; // stray blanks between headings
    if (!doc) doc = { title: "", sections: [] };
    if (!section) section = { title: "", body: [] };
    section.body.push(line);
  }
  flushDoc();

  const bp = BLUEPRINTS[kind].docs;
  const slugOrder = bp.map((d) => d.slug);
  const allowSet = new Set(slugOrder);
  const titleToSlug = new Map(bp.map((d) => [canon(d.title), d.slug]));
  const used = new Set<string>();
  const out: GovernanceDoc[] = [];

  const pushSections = (
    target: GovernanceDoc,
    sections: { title: string; markdown: string }[],
    secIdByTitle: Map<string, string>
  ) => {
    const ids = new Set(target.sections.map((s) => s.id));
    const addOne = (title: string, markdown: string, preferredId?: string) => {
      // Section-count cap (CAPS.maxSectionsPerDoc, the applyOps ceiling):
      // overflow FOLDS into the last kept section - leniency must never
      // discard text. The fold tail is the one place a section may exceed
      // the per-section char cap; the documents byte cap enforced at seed
      // time is the ceiling there, matching applyOps, which never
      // length-checks stored text.
      if (target.sections.length >= CAPS.maxSectionsPerDoc) {
        const last = target.sections[target.sections.length - 1];
        last.markdown = [last.markdown, title, markdown]
          .filter(Boolean)
          .join("\n\n");
        return;
      }
      let id =
        preferredId && !ids.has(preferredId)
          ? preferredId
          : kebab(title, `section-${target.sections.length + 1}`);
      let n = 2;
      while (ids.has(id)) id = `${id.slice(0, 56)}-${n++}`;
      ids.add(id);
      target.sections.push({
        id,
        title: title || `Section ${target.sections.length + 1}`,
        markdown,
      });
    };
    for (const s of sections) {
      const preferred = secIdByTitle.get(canon(s.title));
      // Per-section char cap: validateTurn REFUSES over-cap op markdown
      // (str() returns null past sectionMarkdownMaxChars) and applyOps
      // stores op text verbatim, so nothing in the codebase truncates. An
      // import must neither refuse nor truncate: oversize splits into
      // continuation sections - exact substrings, byte-preserving, cut at
      // a newline when one falls in the back half of the window.
      let md = s.markdown;
      let first = true;
      do {
        let chunk = md;
        if (md.length > CAPS.sectionMarkdownMaxChars) {
          const window = md.slice(0, CAPS.sectionMarkdownMaxChars);
          const nl = window.lastIndexOf("\n");
          chunk =
            nl > CAPS.sectionMarkdownMaxChars / 2
              ? window.slice(0, nl + 1)
              : window;
        }
        addOne(
          first ? s.title : s.title ? `${s.title} (continued)` : "",
          chunk,
          first ? preferred : undefined
        );
        md = md.slice(chunk.length);
        first = false;
      } while (md.length > 0);
    }
  };

  for (const rd of rawDocs) {
    const sections = rd.sections
      .map((s) => ({ title: s.title, markdown: s.body.join("\n").trim() }))
      .filter((s) => s.title || s.markdown);
    if (!sections.length) continue; // drop empty docs
    let slug: string | undefined = titleToSlug.get(canon(rd.title));
    if (!slug || used.has(slug)) {
      const guess = kebab(rd.title, "");
      slug =
        guess && allowSet.has(guess) && !used.has(guess)
          ? guess
          : slugOrder.find((s) => !used.has(s));
    }
    if (!slug) {
      // Allowlist exhausted: fold, never drop. The lost doc title survives
      // as the first folded section's title when that section has none.
      const last = out[out.length - 1];
      if (last) {
        if (rd.title && sections[0] && !sections[0].title)
          sections[0].title = rd.title;
        pushSections(last, sections, new Map());
      }
      continue;
    }
    used.add(slug);
    const bpDoc = bp.find((d) => d.slug === slug);
    const target: GovernanceDoc = {
      slug,
      title: rd.title || bpDoc?.title || "AI Governance Document",
      stub: false,
      sections: [],
    };
    pushSections(
      target,
      sections,
      new Map((bpDoc?.sections ?? []).map((s) => [canon(s.title), s.id]))
    );
    // Stub restore: a confirmed FINAL can carry stub docs - blueprint
    // -default stubs keep their scaffold placeholders (placeholderSectionMap
    // skips stub docs, so they never blocked confirm) and set_stub writes a
    // "determination" section. The markdown does not carry the flag, so
    // without restoring it those placeholders would sit on a stub:false doc
    // and 409 the re-confirm of a document that WAS final. Restore
    // stub:true only when the shape is provably the stub shape: the doc is
    // a blueprint-default stub OR carries set_stub EVIDENCE, AND every
    // other section is its blueprint placeholder byte-exact. A
    // determination section is evidence only when the blueprint does NOT
    // itself ship a "determination" section, or when its text differs
    // byte-wise from that shipped placeholder - two NON-stub eu_ai_act
    // docs scaffold one ("Determination and adoption"), and reading the
    // untouched scaffold as evidence would flip them to stub on a pure
    // scaffold round-trip and launder 8 undrafted sections past the
    // confirm gate; a real set_stub write always differs from scaffold.
    // Any drafted non-determination section leaves stub:false. Accepted
    // residual (conservative by design, anti-laundering wins): a doc that
    // was partly drafted and THEN set_stub'd (determination + drafted
    // sections + remaining placeholders) re-imports stub:false, and
    // re-confirm 409s until a revise/set_stub turn restores it.
    if (bpDoc) {
      const ph = new Map(bpDoc.sections.map((s) => [s.id, s.placeholder]));
      const det = target.sections.find((s) => s.id === "determination");
      const setStubEvidence =
        !!det &&
        (!ph.has("determination") ||
          ph.get("determination") !== det.markdown);
      if (setStubEvidence || bpDoc.stub === true) {
        const scaffoldOnly = target.sections
          .filter((s) => s.id !== "determination")
          .every((s) => ph.get(s.id) === s.markdown);
        if (scaffoldOnly) target.stub = true;
      }
    }
    out.push(target);
  }
  return out;
}
