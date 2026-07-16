"use client";

// Shared client helpers for the AI Governance builder UI (§5.12): fetch
// wrapper speaking the API's {error:{code,message}} shape, promptId minting,
// the concrete deletion-date formatter, and the one-word status badge.
// Copy rule: no em or en dashes anywhere; ASCII plus the middle dot only.

import type {
  GovernanceDoc,
  GovernanceErrorCode,
  NextQuestion,
  ProjectStatus,
} from "@/lib/governance/types";
import { RESEARCH_DURATION_COPY } from "@/lib/governance/config";

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | {
      ok: false;
      status: number;
      code: GovernanceErrorCode | "network";
      message: string;
    };

export async function api<T>(
  path: string,
  init?: RequestInit
): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: init?.body ? { "content-type": "application/json" } : undefined,
      cache: "no-store",
    });
  } catch {
    return { ok: false, status: 0, code: "network", message: "Network error." };
  }
  if (res.status === 204) return { ok: true, status: 204, data: undefined as T };
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // non-JSON body (proxy error page); fall through to the generic message
  }
  if (res.ok) return { ok: true, status: res.status, data: body as T };
  const err = (
    body as { error?: { code?: GovernanceErrorCode; message?: string } } | null
  )?.error;
  return {
    ok: false,
    status: res.status,
    code: err?.code ?? "network",
    message: err?.message ?? "Something went wrong. Try again.",
  };
}

/** Multipart variant of api(): the browser sets the content-type boundary. */
export async function apiUpload<T>(
  path: string,
  form: FormData
): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, { method: "POST", body: form, cache: "no-store" });
  } catch {
    return { ok: false, status: 0, code: "network", message: "Network error." };
  }
  if (res.status === 204) return { ok: true, status: 204, data: undefined as T };
  // 413 arrives from nginx as HTML, never our JSON envelope: name the real
  // problem instead of the generic fallback.
  if (res.status === 413)
    return {
      ok: false,
      status: 413,
      code: "invalid_request",
      message:
        "That file is too large to upload. Keep the sample under 2 MB; a few representative pages are plenty.",
    };
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // non-JSON body; fall through
  }
  if (res.ok) return { ok: true, status: res.status, data: body as T };
  const err = (
    body as { error?: { code?: GovernanceErrorCode; message?: string } } | null
  )?.error;
  return {
    ok: false,
    status: res.status,
    code: err?.code ?? "network",
    message: err?.message ?? "Something went wrong. Try again.",
  };
}

/** What POST /answer returns on success. */
export interface TurnResponse {
  rev: number;
  status: ProjectStatus;
  changedSections: Record<string, string[]>;
  nextQuestion: NextQuestion | null;
  reviewSummary: string | null;
  progress: { answered: number; total: number };
  openConfirmItems: { doc: string; section: string; excerpt: string }[];
  documents: GovernanceDoc[];
}

/**
 * promptId: gov_<ts36>_<rand>. Minted once per submit attempt; the SAME id is
 * reused only for transport retries of the same answer, and a NEW one is
 * minted after a 502 invalid_turn (the brain replays (sessionId, promptId)).
 */
export function mintPromptId(): string {
  return `gov_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** A "<doc-slug>#<section-id>" pair from NextQuestion.feeds, parsed. */
export interface FeedRef {
  doc: string;
  section: string;
}

/** Parse one feeds entry; null when malformed (empty slug or id). */
export function parseFeedRef(feed: string): FeedRef | null {
  const i = feed.indexOf("#");
  if (i <= 0 || i >= feed.length - 1) return null;
  return { doc: feed.slice(0, i), section: feed.slice(i + 1) };
}

/**
 * First fed section that actually exists in the committed documents:
 * the anchor target for "the text this question is about".
 */
export function firstFeedTarget(
  feeds: string[],
  documents: GovernanceDoc[]
): FeedRef | null {
  for (const f of feeds) {
    const ref = parseFeedRef(f);
    if (!ref) continue;
    const doc = documents.find((d) => d.slug === ref.doc);
    if (doc && doc.sections.some((s) => s.id === ref.section)) return ref;
  }
  return null;
}

/** "Aug 15, 2026" (en-US, UTC): the concrete deletion date everywhere. */
export function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export interface StatusMeta {
  word: string;
  cls: string;
  dot: boolean;
  check: boolean;
  note: string;
}

/**
 * One-word badges (critique S2); the explanatory sentence renders as
 * adjacent normal text, never inside .badge.
 */
export const STATUS_META: Record<ProjectStatus, StatusMeta> = {
  created: {
    word: "Queued",
    cls: "badge--warn",
    dot: false,
    check: false,
    note: "Setting up your project.",
  },
  queued: {
    word: "Queued",
    cls: "badge--warn",
    dot: false,
    check: false,
    note: "Research is waiting its turn and starts automatically.",
  },
  researching: {
    word: "Researching",
    cls: "badge--light",
    dot: true,
    check: false,
    note: `This takes ${RESEARCH_DURATION_COPY}.`,
  },
  research_failed: {
    word: "Paused",
    cls: "badge--danger",
    dot: false,
    check: false,
    note: "Research paused.",
  },
  drafting: {
    word: "Drafting",
    cls: "badge--light",
    dot: true,
    check: false,
    note: "More questions coming.",
  },
  review: {
    word: "Review",
    cls: "badge--sand",
    dot: false,
    check: true,
    note: "No more questions.",
  },
  done: {
    word: "Final",
    cls: "badge--ok",
    dot: false,
    check: true,
    note: "Ready to download.",
  },
};

export function CheckGlyph() {
  return (
    <svg viewBox="0 0 16 16" className="h-3 w-3 shrink-0" aria-hidden="true">
      <path
        d="M3 8.5 6.5 12 13 4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      />
    </svg>
  );
}

/** One-word status badge; color is never the sole signal (word + glyph). */
export function StatusBadge({ status }: { status: ProjectStatus }) {
  const meta = STATUS_META[status];
  return (
    <span className={`badge ${meta.cls}`}>
      {meta.dot && <span className="dot" aria-hidden="true" />}
      {meta.check && <CheckGlyph />}
      {meta.word}
    </span>
  );
}
