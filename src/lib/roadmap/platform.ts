// Derivation for phases 09/10/11 (§5.20): turns company_roadmap_links rows
// into the booleans the runway, the cards, the percentage and the step
// pages all read. PURE - no db access - so the step pages, the status
// bundle and the tests share one definition of "enabled".
//
// THE ONE RULE THAT MATTERS (owner): a URL never counts just because it was
// typed. Saving is always allowed and never lost; counting waits for
// EVIDENCE. So every predicate below goes through fieldCounts, never
// "a URL is present", which is what makes "saved but not counted" a real
// state rather than a promise in the copy.
//
// What counts as evidence is the LADDER (§5.20 round 2), because the
// original check asked "can XL.net reach this" as a stand-in for "can your
// builders reach this", and those are unrelated when the endpoint lives on
// the company's own network:
//   ok       we reached it over HTTP
//   internal it is inside the tenant's verified domain and resolves onto a
//            private network; machine-checked, and we never connect
//   attested a named admin asserted it after a real check failed
// Plus HYSTERESIS: a field that was counting and starts failing keeps
// counting until its grace window closes.

import type { LinkRow } from "@/lib/roadmap/db";
// The PURE module, never url-check: this file is read by client
// islands, and url-check imports node:dns/http/https/net.
import { hostInDomain } from "@/lib/roadmap/host-domain";

/** The three rungs of the evidence ladder that COUNT. They differ in what
 * evidence we hold, never in whether the step is earned. */
export const COUNTING_STATES = ["ok", "internal", "attested"] as const;

/**
 * Does this field count toward its step?
 *
 * Two things are folded in here so no caller can implement one and forget
 * the other:
 *  - the LADDER: reached, internal and attested all count.
 *  - the HYSTERESIS: a field that was counting and has started failing
 *    keeps counting until its grace window expires. One bad minute on a
 *    customer's server must not un-light a step, and a step that flickers
 *    is worse than one that is briefly generous. A field that never counted
 *    gets no grace, because there is nothing to protect.
 */
export function fieldCounts(
  state: string | null | undefined,
  graceUntil?: Date | string | null
): boolean {
  if (!state) return false;
  if ((COUNTING_STATES as readonly string[]).includes(state)) return true;
  if (state !== "failed" || !graceUntil) return false;
  const until = graceUntil instanceof Date ? graceUntil : new Date(graceUntil);
  return Number.isFinite(until.getTime()) && until.getTime() > Date.now();
}

/** True while a field is counting ONLY because its grace window has not
 * expired: it is failing, and the step will drop when the window closes.
 * The UI needs this to warn before the drop rather than after. */
export function fieldInGrace(
  state: string | null | undefined,
  graceUntil?: Date | string | null
): boolean {
  return state === "failed" && fieldCounts(state, graceUntil);
}

/**
 * May this field be attested (rung 3)?
 *
 * THIS PREDICATE IS THE ONLY THING BETWEEN ATTESTATION AND A UNIVERSAL
 * BYPASS, and an earlier version of it was exactly that. It asked only for
 * a failure reason of "unreachable" or "not_public", and both refuters took
 * it apart the same way:
 *   - "unreachable" covers a DNS failure AND a refused connection, so
 *     https://not-a-real-company.example could be typed, fail, and be
 *     attested into counting. Any string at all would have qualified.
 *   - "not_public" covers a BARE PRIVATE IP LITERAL, so http://10.0.0.5:8080
 *     would have counted, defeating the very rule rung 2 enforces (an IP
 *     has no tenant binding, so it can never be evidence of anything).
 *
 * So rung 3 now carries the SAME domain binding as rung 2: the address must
 * live inside the tenant's own verified domain. That makes it coherent with
 * the rung above it ("we could not even resolve it, but it is yours"),
 * kills both bypasses, and still serves the case it exists for, which is
 * split-horizon DNS on a company's own name.
 *
 * The failure must also be one consistent with an endpoint we cannot see:
 * "http_status" is never attestable, because a server ANSWERED and said the
 * address is wrong, and "invalid"/"self_host" are not addresses worth
 * asserting. And the field must already BE failed, so a real check has to
 * have run first.
 *
 * ACCEPTED CONSEQUENCE: a wiki on a vendor domain (acme.atlassian.net)
 * cannot be attested. In practice those are public DNS and answer 401/403,
 * which already counts as reached; a self-hosted one on a domain the
 * company owns but has not verified here is the real gap, and the honest
 * fix for that is domain aliases, not a looser assertion.
 */
export function fieldAttestable(
  state: string | null | undefined,
  reason: string | null | undefined,
  url: string | null | undefined,
  internalDomain: string | null | undefined
): boolean {
  if (state !== "failed") return false;
  if (reason !== "unreachable" && reason !== "not_public") return false;
  if (!url || !internalDomain) return false;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return hostInDomain(host, internalDomain);
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
  /** Enabled, but riding a grace window that will close. */
  failing: boolean;
  row: LinkRow | null;
};

function view(row: LinkRow | null, enabled: boolean): ComponentView {
  return {
    saved: !!row,
    enabled: !!row && enabled,
    // Counting, but only because a grace window is open. Surfaced so the
    // hub can warn BEFORE the step drops rather than after.
    failing:
      !!row &&
      enabled &&
      (fieldInGrace(row.urlState, row.urlGraceUntil) ||
        fieldInGrace(row.docsState, row.docsGraceUntil)),
    row,
  };
}

/** API Proxy: a reachable endpoint plus reachable instructions. */
export function apiProxyView(row: LinkRow | null): ComponentView {
  return view(
    row,
    !!row &&
      fieldCounts(row.urlState, row.urlGraceUntil) &&
      fieldCounts(row.docsState, row.docsGraceUntil)
  );
}

/** Developer VMs: at least one hosting environment listed, plus reachable
 * instructions. There is deliberately NO endpoint here: the owner's input
 * for this component is the environment list, and a VM fleet has no single
 * URL to answer. */
export function devVmsView(row: LinkRow | null): ComponentView {
  const envs = row ? parseEnvironments(row.environmentsJson) : [];
  return view(
    row,
    envs.length > 0 && fieldCounts(row?.docsState, row?.docsGraceUntil)
  );
}

/** Lakehouse: a reachable address plus reachable instructions. */
export function lakehouseView(row: LinkRow | null): ComponentView {
  return view(
    row,
    !!row &&
      fieldCounts(row.urlState, row.urlGraceUntil) &&
      fieldCounts(row.docsState, row.docsGraceUntil)
  );
}

/** A tool card counts once BOTH its link and its instructions are
 * confirmed (the owner's phrasing: a tool listed "with a full URL ... and
 * an associated instructions URL"). */
export function toolCounts(row: LinkRow): boolean {
  return (
    fieldCounts(row.urlState, row.urlGraceUntil) &&
    fieldCounts(row.docsState, row.docsGraceUntil)
  );
}

export type SecureView = {
  apiProxy: ComponentView;
  devVms: ComponentView;
  /** Both halves confirmed. */
  done: boolean;
  /** Exactly one half confirmed: the step is half earned, and the runway
   * paints its own state for it (the only partial-capable step). */
  partial: boolean;
  /** Some counted half is inside a grace window. */
  failing: boolean;
};

export function secureView(rows: LinkRow[]): SecureView {
  const apiProxy = apiProxyView(rows.find((r) => r.kind === "api_proxy") ?? null);
  const devVms = devVmsView(rows.find((r) => r.kind === "dev_vms") ?? null);
  const n = (apiProxy.enabled ? 1 : 0) + (devVms.enabled ? 1 : 0);
  return {
    apiProxy,
    devVms,
    done: n === 2,
    partial: n === 1,
    failing: apiProxy.failing || devVms.failing,
  };
}

export type PlatformView = {
  secure: SecureView;
  data: { done: boolean; lakehouse: ComponentView; failing: boolean };
  tools: {
    done: boolean;
    counted: number;
    total: number;
    failing: boolean;
    rows: LinkRow[];
  };
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
    data: { done: lakehouse.enabled, lakehouse, failing: lakehouse.failing },
    tools: {
      done: counted > 0,
      counted,
      total: toolRows.length,
      failing: toolRows.some(
        (r) =>
          toolCounts(r) &&
          (fieldInGrace(r.urlState, r.urlGraceUntil) ||
            fieldInGrace(r.docsState, r.docsGraceUntil))
      ),
      rows: toolRows,
    },
  };
}
