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
  style: NumberingStyle | null
): string {
  const plan = planOutline(doc, style);
  if (plan) {
    const e = plan.find((x) => x.sectionId === sectionId);
    if (e) return e.label;
  }
  const si = doc.sections.findIndex((s) => s.id === sectionId);
  return si >= 0
    ? sectionTitleText(si + 1, doc.sections[si].title, style)
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
  style: NumberingStyle | null
): OutlinePlanEntry[] | null {
  if (!hasOutline(doc)) return null;
  const byId = new Map(doc.sections.map((s) => [s.id, s]));
  const filed = new Set<string>();
  const entries: OutlinePlanEntry[] = [];
  let num = 0;

  const unfiledLead = doc.sections.filter(
    (s) =>
      s.id === "determination" &&
      !doc.outline!.some((b) => b.sections.includes(s.id))
  );
  for (const s of unfiledLead) {
    filed.add(s.id);
    num++;
    entries.push({
      sectionId: s.id,
      label: sectionTitleText(num, s.title, style),
      top: true,
      innerBase: nestedBaseLabel(num, null, style),
      fused: false,
    });
  }

  for (const bucket of doc.outline!) {
    const secs = bucket.sections
      .map((id) => byId.get(id))
      .filter((s): s is NonNullable<typeof s> => !!s && !filed.has(s.id));
    if (!secs.length) continue;
    num++;
    if (secs.length === 1) {
      // Fused: the template's heading IS the section's visible title.
      filed.add(secs[0].id);
      entries.push({
        sectionId: secs[0].id,
        label: sectionTitleText(num, bucket.title, style),
        top: true,
        innerBase: nestedBaseLabel(num, null, style),
        fused: true,
      });
      continue;
    }
    entries.push({
      sectionId: null,
      label: sectionTitleText(num, bucket.title, style),
      top: true,
      innerBase: null,
      fused: false,
    });
    secs.forEach((s, j) => {
      filed.add(s.id);
      entries.push({
        sectionId: s.id,
        label: nestedSectionTitleText(num, j + 1, s.title, style),
        top: false,
        innerBase: nestedBaseLabel(num, j + 1, style),
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
      label: sectionTitleText(num, s.title, style),
      top: true,
      innerBase: nestedBaseLabel(num, null, style),
      fused: false,
    });
  }
  return entries;
}
