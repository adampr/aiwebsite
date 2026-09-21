// Template skeleton rendering plan (§5.12 round 18b, "reparent never
// merge"). A document with an adopted outline renders the sample's
// skeleton: bucket titles as top-level numbered headings, the blueprint's
// required sections nested one level below. Sections stay the atomic
// content units; this module only decides GROUPING and LABELS, shared by
// the doc pane and the .docx renderer so the two can never disagree.
//
// Lenience is the rule here: the stored outline may reference sections
// that no longer exist (removed later) or miss sections added later.
// Missing ids are skipped; unfiled sections render as their own top-level
// items after the buckets ("determination" renders FIRST: a stub's
// determination must lead the document). A null plan = flat rendering,
// byte-identical to the pre-18b document.

import type { GovernanceDoc } from "./types";
import {
  sectionTitleText,
  nestedSectionTitleText,
  nestedBaseLabel,
  stripLeadingNumber,
  type NumberingProfile,
  type NumberingStyle,
} from "./numbering";

/**
 * On-screen label for one section: fused bucket title, nested "5.2 Title",
 * or the flat "N. Title". THE one composer every quoting surface uses
 * (jump links, announcements, resolver quotes, question card, .docx) so no
 * surface can disagree with the pane about a section's visible name
 * (round 18b critic gate).
 */
export function sectionDisplayLabel(
  doc: GovernanceDoc,
  sectionId: string,
  style: NumberingStyle | null,
  profile: NumberingProfile | null = null,
  // Round 23: empty sample headings shift the positional numbers, so the
  // quoting surfaces must plan with the same titles the pane renders with.
  sampleTitles: string[] | null = null
): string {
  const plan = planOutline(doc, style, profile, sampleTitles);
  if (plan) {
    const e = plan.find((x) => x.sectionId === sectionId);
    if (e) return e.label;
  }
  const si = doc.sections.findIndex((s) => s.id === sectionId);
  return si >= 0
    ? sectionTitleText(si + 1, doc.sections[si].title, style, profile)
    : sectionId;
}

/** Leading outline numbering stripped, case preserved: the clean wording
 * stored as a bucket title and listed in prompts (round 18e). */
export function stripOutlineNumbering(t: string): string {
  return t
    .replace(
      /^(?:\d{1,3}(?:\.\d{1,3}){0,4}[.)]?|[IVXivx]{1,7}[.)]|[A-Za-z][.)]|[Ss]ection\s{1,4}\d{1,3}\s{0,4}[:.)-]?)\s+/,
      ""
    )
    .trim();
}

/** Case/space/numbering-insensitive identity for outline titles: bucket
 * titles come from model output mirroring the sample and may carry the
 * sample's numbering; the extractor's top-title list is number-stripped. */
export function canonOutlineTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(
      /^(?:\d{1,3}(?:\.\d{1,3}){0,4}[.)]?|[ivx]{1,7}[.)]|[a-z][.)]|section\s{1,4}\d{1,3}\s{0,4}[:.)-]?)\s+/,
      ""
    )
    .replace(/\s{1,20}/g, " ")
    .replace(/[.:;]{1,4}$/, "")
    .trim();
}

/** Sample outline items that ended up with NO bucket in this doc's adopted
 * outline: the "dropped headings" honesty surface (receipt clause + the
 * doc pane's durable note) computes from this, never asserts. */
export function droppedOutlineTitles(
  doc: GovernanceDoc,
  sampleTitles: string[]
): string[] {
  if (!hasOutline(doc) || !sampleTitles.length) return [];
  const used = new Set(doc.outline!.map((b) => canonOutlineTitle(b.title)));
  return sampleTitles.filter((t) => !used.has(canonOutlineTitle(t))).slice(0, 12);
}

export interface OutlinePlanEntry {
  /** The section this row renders; null = a bucket heading row. */
  sectionId: string | null;
  /** Rendered heading text (numbering applied, style-aware). */
  label: string;
  /** True for bucket-heading rows AND fused single-section rows: rendered
   * at the top heading level. False = nested one level down. */
  top: boolean;
  /** Base for the section's INNER heading labels ("5.2" -> "5.2.1"); null
   * for bucket-heading rows. */
  innerBase: string | null;
  /** Fused row: a bucket holding exactly one section renders once, the
   * template's wording winning the visible title. */
  fused: boolean;
  /** Title-only bucket heading row (round 23): nothing renders under it.
   * The honesty surfaces (pane note, receipt) derive from this. */
  empty?: boolean;
}

/**
 * Whether the render-side reconcile is IN EFFECT for this doc and sample
 * (round 23): at least half of the sample's titles (unique, canon-matched,
 * ceil) must already be stored buckets. Below that the outline belongs to
 * a DIFFERENT sample generation (a replaced sample mid-debt-window), and
 * interleaving would prepend a wall of empty headings and renumber every
 * real section behind them; the stored outline then renders as round 22
 * did, restyled numbering only, until the reformat re-adopts.
 */
export function outlineReconciled(
  doc: GovernanceDoc,
  sampleTitles: string[] | null | undefined
): boolean {
  if (!hasOutline(doc) || !sampleTitles?.length) return false;
  const canonSample = new Set(
    sampleTitles.map((t) => canonOutlineTitle(t)).filter(Boolean)
  );
  if (!canonSample.size) return false;
  const matched = new Set(
    doc
      .outline!.map((b) => canonOutlineTitle(b.title))
      .filter((c) => canonSample.has(c))
  ).size;
  return matched * 2 >= canonSample.size;
}

/** True when this doc renders through an adopted outline. */
export function hasOutline(doc: GovernanceDoc): boolean {
  return Array.isArray(doc.outline) && doc.outline.length > 0;
}

/**
 * The full render plan, or null for flat rendering. Every existing section
 * appears in the plan exactly once regardless of outline drift: the
 * guarantee that adoption can never hide required content is enforced at
 * op time (exact partition) AND re-derived defensively here.
 */
export function planOutline(
  doc: GovernanceDoc,
  style: NumberingStyle | null,
  profile: NumberingProfile | null = null,
  // Round 23 reconcile: the sample's title sequence. Sample titles absent
  // from the stored outline interleave as EMPTY top-level heading rows at
  // their sample position, so the skeleton stays complete and numbering
  // stays positional (Scope is always 2, References always 5) even for
  // rows stored before adoption kept empty buckets. Never applied to a
  // doc without an outline: grouping is never invented.
  sampleTitles: string[] | null = null
): OutlinePlanEntry[] | null {
  if (!hasOutline(doc)) return null;
  const byId = new Map(doc.sections.map((s) => [s.id, s]));
  const filed = new Set<string>();
  const entries: OutlinePlanEntry[] = [];
  let num = 0;

  // Sample-matched buckets render an empty heading even when their ids no
  // longer resolve (the position is the sample's promise); unmatched
  // (drift) buckets with dead ids keep today's skip.
  type PlanBucket = {
    b: { title: string; sections: string[] };
    matched: boolean;
  };
  let buckets: PlanBucket[] = doc.outline!.map((b) => ({
    b,
    matched: false,
  }));
  const reconciled = outlineReconciled(doc, sampleTitles);
  if (reconciled) {
    const stored = new Map<string, { title: string; sections: string[] }>();
    for (const { b } of buckets) {
      const c = canonOutlineTitle(b.title);
      if (!stored.has(c)) stored.set(c, b);
    }
    const usedCanon = new Set<string>();
    const merged: PlanBucket[] = [];
    for (const t of sampleTitles!) {
      const clean = stripOutlineNumbering(t);
      const c = canonOutlineTitle(t);
      if (!clean || usedCanon.has(c)) continue;
      usedCanon.add(c);
      merged.push({
        b: stored.get(c) ?? { title: clean, sections: [] },
        matched: true,
      });
    }
    // Stored buckets outside the sample sequence (drift) keep rendering,
    // after the sample's titles, in stored order.
    for (const { b } of buckets)
      if (!usedCanon.has(canonOutlineTitle(b.title)))
        merged.push({ b, matched: false });
    buckets = merged;
  }

  const unfiledLead = doc.sections.filter(
    (s) =>
      s.id === "determination" &&
      !doc.outline!.some((b) => b.sections.includes(s.id))
  );
  for (const s of unfiledLead) {
    filed.add(s.id);
    // Under an active reconcile the lead keeps its place but NOT an
    // ordinal: the sample's titles own the positional numbers (Scope is
    // always 2), and the determination's number is not a required element.
    if (reconciled) {
      entries.push({
        sectionId: s.id,
        label: stripLeadingNumber(s.title.trim()),
        top: true,
        innerBase: null,
        fused: false,
      });
      continue;
    }
    num++;
    entries.push({
      sectionId: s.id,
      label: sectionTitleText(num, s.title, style, profile),
      top: true,
      innerBase: nestedBaseLabel(num, null, style, profile),
      fused: false,
    });
  }

  for (const { b: bucket, matched } of buckets) {
    const secs = bucket.sections
      .map((id) => byId.get(id))
      .filter((s): s is NonNullable<typeof s> => !!s && !filed.has(s.id));
    if (!secs.length) {
      // A DELIBERATELY empty bucket (stored [] after round 23, a sample
      // title interleaved above, or a SAMPLE-MATCHED bucket whose ids all
      // died) renders as a title-only top-level heading, keeping the
      // sample's skeleton and positions complete; an unmatched (drift)
      // bucket whose listed ids merely fail to resolve stays skipped,
      // exactly as before.
      if (bucket.sections.length > 0 && !matched) continue;
      num++;
      entries.push({
        sectionId: null,
        label: sectionTitleText(num, bucket.title, style, profile),
        top: true,
        innerBase: null,
        fused: false,
        empty: true,
      });
      continue;
    }
    num++;
    if (secs.length === 1) {
      // Fused: the template's heading IS the section's visible title.
      filed.add(secs[0].id);
      entries.push({
        sectionId: secs[0].id,
        label: sectionTitleText(num, bucket.title, style, profile),
        top: true,
        innerBase: nestedBaseLabel(num, null, style, profile),
        fused: true,
      });
      continue;
    }
    entries.push({
      sectionId: null,
      label: sectionTitleText(num, bucket.title, style, profile),
      top: true,
      innerBase: null,
      fused: false,
    });
    secs.forEach((s, j) => {
      filed.add(s.id);
      entries.push({
        sectionId: s.id,
        label: nestedSectionTitleText(num, j + 1, s.title, style, profile),
        top: false,
        innerBase: nestedBaseLabel(num, j + 1, style, profile),
        fused: false,
      });
    });
  }

  // Anything the outline missed (sections added after adoption) renders as
  // its own top-level item after the buckets: visible, never hidden.
  for (const s of doc.sections) {
    if (filed.has(s.id)) continue;
    num++;
    entries.push({
      sectionId: s.id,
      label: sectionTitleText(num, s.title, style, profile),
      top: true,
      innerBase: nestedBaseLabel(num, null, style, profile),
      fused: false,
    });
  }
  return entries;
}
