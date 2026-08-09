// Derivation for phases 09/10/11 (§5.20): turns company_roadmap_links rows
// into the booleans the runway, the cards, the percentage and the step
// pages all read. PURE - no db access - so the step pages, the status
// bundle and the tests share one definition of "enabled".
//
// THE ONE RULE THAT MATTERS (owner): a URL only counts once we have
// actually reached it. Saving is always allowed and never lost; counting
// waits for a passing check. So every predicate below asks for state
// "ok", never merely "a URL is present". That is what makes "saved but not
// counted" a real state rather than a promise in the copy.

import type { LinkRow } from "@/lib/roadmap/db";

/** A URL field is confirmed only in state "ok". */
export function fieldOk(state: string | null | undefined): boolean {
  return state === "ok";
}

export function parseEnvironments(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

/** One component of a phase, as every surface needs to see it. */
export type ComponentView = {
  /** A row exists at all (the admin has saved something). */
  saved: boolean;
  /** Every input this component requires is present AND confirmed. Only
   * this may light a step or move the percentage. */
  enabled: boolean;
  row: LinkRow | null;
};

function view(row: LinkRow | null, enabled: boolean): ComponentView {
  return { saved: !!row, enabled: !!row && enabled, row };
}

/** API Proxy: a reachable endpoint plus reachable instructions. */
export function apiProxyView(row: LinkRow | null): ComponentView {
  return view(row, !!row && fieldOk(row.urlState) && fieldOk(row.docsState));
}

/** Developer VMs: at least one hosting environment listed, plus reachable
 * instructions. There is deliberately NO endpoint here: the owner's input
 * for this component is the environment list, and a VM fleet has no single
 * URL to answer. */
export function devVmsView(row: LinkRow | null): ComponentView {
  const envs = row ? parseEnvironments(row.environmentsJson) : [];
  return view(row, envs.length > 0 && fieldOk(row?.docsState));
}

/** Lakehouse: a reachable address plus reachable instructions. */
export function lakehouseView(row: LinkRow | null): ComponentView {
  return view(row, !!row && fieldOk(row.urlState) && fieldOk(row.docsState));
}

/** A tool card counts once BOTH its link and its instructions are
 * confirmed (the owner's phrasing: a tool listed "with a full URL ... and
 * an associated instructions URL"). */
export function toolCounts(row: LinkRow): boolean {
  return fieldOk(row.urlState) && fieldOk(row.docsState);
}

export type SecureView = {
  apiProxy: ComponentView;
  devVms: ComponentView;
  /** Both halves confirmed. */
  done: boolean;
  /** Exactly one half confirmed: the step is half earned, and the runway
   * paints its own state for it (the only partial-capable step). */
  partial: boolean;
};

export function secureView(rows: LinkRow[]): SecureView {
  const apiProxy = apiProxyView(rows.find((r) => r.kind === "api_proxy") ?? null);
  const devVms = devVmsView(rows.find((r) => r.kind === "dev_vms") ?? null);
  const n = (apiProxy.enabled ? 1 : 0) + (devVms.enabled ? 1 : 0);
  return { apiProxy, devVms, done: n === 2, partial: n === 1 };
}

export type PlatformView = {
  secure: SecureView;
  data: { done: boolean; lakehouse: ComponentView };
  tools: { done: boolean; counted: number; total: number; rows: LinkRow[] };
};

/** The whole §5.20 picture from one already-fetched row set. */
export function platformView(rows: LinkRow[]): PlatformView {
  const secure = secureView(rows);
  const lakehouse = lakehouseView(
    rows.find((r) => r.kind === "lakehouse") ?? null
  );
  const toolRows = rows.filter((r) => r.kind === "tool");
  const counted = toolRows.filter(toolCounts).length;
  return {
    secure,
    data: { done: lakehouse.enabled, lakehouse },
    tools: { done: counted > 0, counted, total: toolRows.length, rows: toolRows },
  };
}
