/**
 * Where visual blocks land and how the write paths carry them (ARCHITECTURE.md §5.17).
 *
 * draft-blocks.ts is the contract (shapes, grounding, the builders). This module is the server's
 * use of it, kept pure so every decision is testable with no database and no brain:
 *
 *   finishDraftVisuals   the drafter's `visuals` array -> validated blocks + prose to append
 *   landDraftBlocks      what a freshly drafted section stores (model blocks + the system sets)
 *   keptBlocks           what an edit, a Tron accept or a gap weave keeps (everything, re-anchored)
 *   applyVisualsOp       the section route's "visuals" op (add the snapshot / stats / timeline,
 *                        remove one block), with the refusals as data
 *
 * Blocks are never read from a request body anywhere; the only inputs here are stored records,
 * live facts and the drafter's validated output.
 */

import {
  LIMITS,
  PARAGRAPH_CAP,
  buildAboutBlocks,
  buildOnboardingTimeline,
  buildServiceStatsBlock,
  parseModelVisuals,
  pickAboutSection,
  reanchorBlocks,
  sanitizeStoredBlocks,
  type DraftBlock,
  type GroundFact,
} from "./draft-blocks";

type FactLike = {
  id: string;
  key: string;
  statement: string;
  detail: string | null;
  polarity: string;
  retiredInKb?: number | null;
};

/**
 * Fact rows as the grounding sees them: live rows only, five fields. Polarity rides along rather
 * than being filtered here, because the builders and the tile check refuse a negative fact
 * themselves and a pre-filter would let an older affirmative row under the same key win.
 */
export function toGroundFacts(rows: FactLike[]): GroundFact[] {
  return (Array.isArray(rows) ? rows : [])
    .filter((f) => f && typeof f.id === "string" && f.retiredInKb == null)
    .map((f) => ({
      id: f.id,
      key: String(f.key ?? ""),
      statement: String(f.statement ?? ""),
      detail: f.detail ?? null,
      polarity: String(f.polarity ?? ""),
    }));
}

export type VisualStats = {
  /** How many visuals the model returned. */
  returned: number;
  kept: number;
  /** Paragraphs appended in place of visuals that could not be kept as blocks. */
  degraded: number;
  dropped: number;
};

/**
 * The drafter's `visuals` through the grounding, against the paragraphs the section keeps.
 * Degraded visuals come back as prose appended inside the paragraph cap; nothing here can fail
 * the section.
 */
export function finishDraftVisuals(
  rawVisuals: unknown,
  paragraphs: string[],
  facts: GroundFact[],
  sectionCites: string[]
): { paragraphs: string[]; blocks: DraftBlock[]; stats: VisualStats } {
  const v = parseModelVisuals(rawVisuals, {
    facts,
    paragraphCount: paragraphs.length,
    sectionCites,
  });
  const next = [...paragraphs, ...v.degraded].slice(0, PARAGRAPH_CAP);
  return {
    paragraphs: next,
    blocks: reanchorBlocks(v.blocks, next.length) ?? [],
    stats: {
      returned: Array.isArray(rawVisuals) ? rawVisuals.length : 0,
      kept: v.blocks.length,
      degraded: next.length - paragraphs.length,
      dropped: v.dropped.length,
    },
  };
}

/** Service desk, support and response language. Deliberately narrow: "support" alone is in every section of a managed-services RFP. */
const SERVICE_PATTERN =
  /\b(?:service|help) ?desk\b|\b(?:response|resolution) times?\b|\bservice levels?\b|\bslas?\b|\b(?:end[- ]user|user|technical|remote|after[- ]hours) support\b|\buser experience\b/;

/**
 * The section the service stat tiles belong on, or null: label + title weigh 3, each matching
 * requirement 1, a section needs 2, the highest score wins and a tie goes to the first in
 * structure order. Reserved "__" labels never qualify.
 */
export function pickServiceStatsSection(
  structure: { label: string; title: string }[],
  requirements: { structureLabel: string; text: string }[]
): string | null {
  if (!Array.isArray(structure)) return null;
  const reqs = Array.isArray(requirements) ? requirements : [];
  let best: { label: string; score: number } | null = null;
  for (const s of structure) {
    if (!s || typeof s.label !== "string" || s.label.startsWith("__")) continue;
    const head = `${s.label} ${typeof s.title === "string" ? s.title : ""}`.toLowerCase();
    let score = SERVICE_PATTERN.test(head) ? 3 : 0;
    for (const r of reqs) {
      if (!r || r.structureLabel !== s.label || typeof r.text !== "string") continue;
      if (SERVICE_PATTERN.test(r.text.slice(0, 4000).toLowerCase())) score += 1;
    }
    if (score >= 2 && (!best || score > best.score)) best = { label: s.label, score };
  }
  return best ? best.label : null;
}

type StoredSection = { label: string; paragraphs?: unknown; blocks?: unknown };

function paragraphCountOf(s: StoredSection): number {
  return Array.isArray(s.paragraphs) ? s.paragraphs.length : 0;
}

function storedBlocks(s: StoredSection): DraftBlock[] {
  return sanitizeStoredBlocks(s.blocks, paragraphCountOf(s));
}

/** The label of a section OTHER than `label` that holds a block of this origin, or null. */
export function originHeldElsewhere(
  sections: StoredSection[],
  label: string,
  origin: NonNullable<DraftBlock["origin"]>
): string | null {
  for (const s of Array.isArray(sections) ? sections : []) {
    if (!s || s.label === label) continue;
    if (storedBlocks(s).some((b) => b.origin === origin)) return s.label;
  }
  return null;
}

/** Tiles open after the first paragraph, as the reference layout has them: a sentence of framing, then the figures. */
function statsAnchor(paragraphCount: number): number {
  return Math.min(1, Math.max(0, paragraphCount));
}

const tileKey = (v: string) => v.replace(/\s+/g, "").toLowerCase();

/**
 * What a freshly drafted section stores. The company snapshot goes on the section
 * pickAboutSection names, the service stats on the one pickServiceStatsSection names, each only
 * while no OTHER section holds that origin (a person who moved one keeps their choice). System
 * blocks take priority over the model's under LIMITS.blocksPerSection, and a model tile block
 * that only repeats the system tiles is dropped rather than shown twice.
 */
export function landDraftBlocks(input: {
  label: string;
  paragraphCount: number;
  modelBlocks: DraftBlock[];
  structure: { label: string; title: string }[];
  requirements: { structureLabel: string; text: string }[];
  /** The landing state. The target's own previous record may be in it; it is ignored. */
  sections: StoredSection[];
  /** Live shared facts only: a private pending note never feeds a system block. */
  sharedFacts: GroundFact[];
}): { blocks: DraftBlock[]; about: number; serviceStats: number; trimmed: number } {
  const { label, paragraphCount, sections, sharedFacts } = input;
  const system: DraftBlock[] = [];
  let about = 0;
  let serviceStats = 0;

  if (label && !label.startsWith("__")) {
    if (
      pickAboutSection(input.structure, input.requirements) === label &&
      !originHeldElsewhere(sections, label, "about")
    ) {
      const built = buildAboutBlocks(sharedFacts);
      system.push(...built);
      about = built.length;
    }
    if (
      pickServiceStatsSection(input.structure, input.requirements) === label &&
      !originHeldElsewhere(sections, label, "service-stats")
    ) {
      const tiles = buildServiceStatsBlock(sharedFacts);
      if (tiles) {
        system.push({ ...tiles, after: statsAnchor(paragraphCount) });
        serviceStats = 1;
      }
    }
  }

  const systemTiles = new Set(
    system.flatMap((b) => (b.kind === "stat-tiles" ? b.tiles.map((t) => tileKey(t.value)) : []))
  );
  const model = (Array.isArray(input.modelBlocks) ? input.modelBlocks : []).filter(
    (b) =>
      !(
        b.kind === "stat-tiles" &&
        systemTiles.size > 0 &&
        b.tiles.every((t) => systemTiles.has(tileKey(t.value)))
      )
  );
  const all = [...system, ...model];
  const blocks = reanchorBlocks(all.slice(0, LIMITS.blocksPerSection), paragraphCount) ?? [];
  return { blocks, about, serviceStats, trimmed: all.length - blocks.length };
}

/**
 * The blocks a write that changes a section's paragraphs keeps: all of them, as stored, with
 * `after` clamped to the new paragraph count. undefined when there are none.
 */
export function keptBlocks(
  section: StoredSection,
  nextParagraphCount: number
): DraftBlock[] | undefined {
  return reanchorBlocks(sanitizeStoredBlocks(section.blocks, nextParagraphCount), nextParagraphCount);
}

/** A record with its `blocks` key set, or ABSENT when there are none, so prose-only records stay byte-identical. */
export function withBlocks<T extends object>(
  record: T,
  blocks: DraftBlock[] | undefined
): Omit<T, "blocks"> & { blocks?: DraftBlock[] } {
  const next: Omit<T, "blocks"> & { blocks?: DraftBlock[] } = { ...record };
  if (blocks && blocks.length > 0) next.blocks = blocks;
  else delete next.blocks;
  return next;
}

export const VISUALS_ACTIONS = ["about", "service-stats", "onboarding", "remove"] as const;
export type VisualsAction = (typeof VISUALS_ACTIONS)[number];

export function isVisualsAction(v: unknown): v is VisualsAction {
  return typeof v === "string" && (VISUALS_ACTIONS as readonly string[]).includes(v);
}

const ORIGIN_NAME: Record<NonNullable<DraftBlock["origin"]>, string> = {
  about: "company snapshot",
  "service-stats": "service stats",
  onboarding: "onboarding timeline",
};

export type VisualsOpResult<S> =
  | { ok: true; sections: S[]; section: S; added: number; removed: number }
  | { ok: false; status: 400 | 404 | 409 | 422; code: string; message: string };

/**
 * The section route's "visuals" op, as a pure function of the stored sections and the live facts.
 *
 * "about" / "service-stats" / "onboarding" rebuild that set from the facts and REPLACE whatever
 * this section holds of the same origin, keeping its position, so a second call is a refresh and
 * never a duplicate. The company snapshot lives on one section only. "remove" deletes one block
 * by id. Nothing else on the record moves: paragraphs, cites, generatedBy and gaps are untouched.
 */
export function applyVisualsOp<S extends StoredSection>(
  sections: S[],
  op: { label: string; action: VisualsAction; blockId?: string },
  sharedFacts: GroundFact[],
  now: string
): VisualsOpResult<S> {
  const { label, action } = op;
  if (label.startsWith("__"))
    return {
      ok: false,
      status: 400,
      code: "invalid_request",
      message: "The cover letter never carries visuals.",
    };
  const at = sections.findIndex((s) => s.label === label);
  if (at < 0) return { ok: false, status: 404, code: "not_found", message: "No such section." };

  const section = sections[at];
  const count = paragraphCountOf(section);
  const current = storedBlocks(section);
  let next: DraftBlock[];
  let added = 0;
  let removed = 0;

  if (action === "remove") {
    const blockId = typeof op.blockId === "string" ? op.blockId : "";
    next = current.filter((b) => b.id !== blockId);
    removed = current.length - next.length;
    if (!blockId || removed === 0)
      return {
        ok: false,
        status: 404,
        code: "not_found",
        message: "That visual is no longer on this section. Reload to see the current draft.",
      };
  } else {
    const origin = action;
    if (origin === "about") {
      const elsewhere = originHeldElsewhere(sections, label, "about");
      if (elsewhere !== null)
        return {
          ok: false,
          status: 409,
          code: "conflict",
          message: `The company snapshot is already on section ${elsewhere}. Remove it there first.`,
        };
    }
    const tiles = origin === "service-stats" ? buildServiceStatsBlock(sharedFacts) : null;
    const timeline = origin === "onboarding" ? buildOnboardingTimeline(sharedFacts) : null;
    const single = tiles ?? timeline;
    const built: DraftBlock[] =
      origin === "about" ? buildAboutBlocks(sharedFacts) : single ? [single] : [];
    if (built.length === 0)
      return {
        ok: false,
        status: 422,
        code: "no_facts",
        message: `The knowledge base does not hold the facts the ${ORIGIN_NAME[origin]} is built from, so nothing was added.`,
      };

    // Replace in place: the refreshed set takes the slot and the anchor of the first block it
    // replaces. A first add opens the section (snapshot) or follows its first paragraph.
    const firstOld = current.findIndex((b) => b.origin === origin);
    const anchor =
      firstOld >= 0 ? current[firstOld].after : origin === "about" ? 0 : statsAnchor(count);
    const fresh = built.map((b) => ({ ...b, after: anchor }));
    const others = current.filter((b) => b.origin !== origin);
    removed = current.length - others.length;
    added = fresh.length;
    if (others.length + fresh.length > LIMITS.blocksPerSection)
      return {
        ok: false,
        status: 409,
        code: "too_many",
        message: `A section holds at most ${LIMITS.blocksPerSection} visuals. Remove one first.`,
      };
    const slot =
      firstOld >= 0
        ? current.slice(0, firstOld).filter((b) => b.origin !== origin).length
        : origin === "about"
          ? 0
          : others.length;
    next = [...others.slice(0, slot), ...fresh, ...others.slice(slot)];
  }

  // S is the caller's record type, which already carries the optional `blocks` and `updatedAt`.
  const updated = withBlocks({ ...section, updatedAt: now }, reanchorBlocks(next, count)) as unknown as S;
  const nextSections = sections.map((s, i) => (i === at ? updated : s));
  return { ok: true, sections: nextSections, section: updated, added, removed };
}
