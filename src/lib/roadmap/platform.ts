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
  /**
   * The admin has ADDED this component: its PRIMARY input is stored,
   * whether or not it counts yet.
   *
   * NOT "a row exists" - that is `row`. And deliberately not "any input at
   * all": an API proxy row carrying only an instructions link has no proxy
   * address, and calling that "saved" would be the exact mirror of the bug
   * this field exists to fix. There the honest sentence is still "add the
   * API proxy", because the address is the component. A refuter broke an
   * earlier `url || docsUrl` version of this predicate on precisely that
   * row, so the primary input is the whole definition:
   *   api_proxy / lakehouse   the address
   *   dev_vms                 the hosting environment list (it has no
   *                           address by design)
   * The secondary input (instructions) is visible per field and gates
   * `enabled`; it never decides whether the component was added.
   *
   * ANY copy that says a component is MISSING must read this, never
   * `enabled`. Reading `enabled` for that is the 2026-08-29 defect: XL.net
   * had both components on file, one of them merely failing its
   * reachability check, and three surfaces at once told the owner to add
   * the component that was already there.
   */
  added: boolean;
  /**
   * ANY of this component's inputs is stored, primary or not.
   *
   * The third grade, and it exists because `added` alone produced a THIRD
   * lie: a row holding only an instructions link is not `added`, so the hub
   * card fell through to "Nothing listed yet" and read as untouched even
   * though the admin had typed something. That was a regression against the
   * old row-existence `savedUnverified`, and a verification pass caught it.
   *
   * The division of labour: `added` decides whether to say "add it" (the
   * primary input is what is missing), `touched` decides whether to say
   * "nothing listed yet" (nothing at all is stored). `added` implies
   * `touched`.
   */
  touched: boolean;
  /** Every input this component requires is present AND confirmed. Only
   * this may light a step or move the percentage. `added` is always true
   * when this is (folded into view(), pinned in test:roadmap). */
  enabled: boolean;
  /** Enabled, but riding a grace window that will close. */
  failing: boolean;
  row: LinkRow | null;
};

function view(
  row: LinkRow | null,
  added: boolean,
  touched: boolean,
  enabled: boolean
): ComponentView {
  return {
    added: !!row && added,
    // `added ||` is the stated implication, enforced rather than assumed.
    touched: !!row && (added || touched),
    // `added &&` is a structural guarantee, not a redundancy: every summary
    // sentence is written on the assumption that counting implies added, so
    // the type must make counting-without-added unrepresentable.
    enabled: !!row && added && enabled,
    // Counting, but only because a grace window is open. Surfaced so the
    // hub can warn BEFORE the step drops rather than after.
    failing:
      !!row &&
      added &&
      enabled &&
      (fieldInGrace(row.urlState, row.urlGraceUntil) ||
        fieldInGrace(row.docsState, row.docsGraceUntil)),
    row,
  };
}

/**
 * The PRIMARY input of a component, per kind. See ComponentView.added for
 * why "any input at all" is the wrong test and was refuted.
 *
 * These are computed from the row rather than delegated to the save route's
 * `hasSomething` refusal (src/app/api/roadmap/platform/route.ts): that gate
 * lives in a different file with no compile-time link to the copy that
 * depends on it, so a row arriving any other way (a backfill, an import, a
 * future console) must still be measured here.
 *
 * INVARIANT these must preserve: enabled implies added. Both URL-bearing
 * components require a counting `urlState` to be enabled, and a counting
 * url state implies a stored url (migration 0042's *_ok_needs_url_ck for
 * the three ladder rungs; recordLinkCheck's `WHERE url = probedUrl` fence
 * plus updateSingletonRow's reset-on-change for the grace case). dev_vms
 * requires envs > 0, which IS its added predicate.
 */
function urlComponentAdded(row: LinkRow): boolean {
  return !!row.url;
}

/** ANY input of a URL-bearing component. See ComponentView.touched. */
function urlComponentTouched(row: LinkRow): boolean {
  return !!row.url || !!row.docsUrl;
}

/** ANY input of Developer VMs. */
function devVmsTouched(row: LinkRow): boolean {
  return parseEnvironments(row.environmentsJson).length > 0 || !!row.docsUrl;
}

/** Developer VMs has NO endpoint by design, so its primary input is the
 * hosting environment list. An instructions link alone is NOT this
 * component: "Add Developer VMs" is still the honest sentence when nobody
 * has said where the machines live. */
function devVmsAdded(row: LinkRow): boolean {
  return parseEnvironments(row.environmentsJson).length > 0;
}

/** API Proxy: a confirmed endpoint plus confirmed instructions. */
export function apiProxyView(row: LinkRow | null): ComponentView {
  return view(
    row,
    !!row && urlComponentAdded(row),
    !!row && urlComponentTouched(row),
    !!row &&
      fieldCounts(row.urlState, row.urlGraceUntil) &&
      fieldCounts(row.docsState, row.docsGraceUntil)
  );
}

/** Developer VMs: at least one hosting environment listed, plus confirmed
 * instructions. There is deliberately NO endpoint here: the owner's input
 * for this component is the environment list, and a VM fleet has no single
 * URL to answer. */
export function devVmsView(row: LinkRow | null): ComponentView {
  const envs = row ? parseEnvironments(row.environmentsJson) : [];
  return view(
    row,
    !!row && devVmsAdded(row),
    !!row && devVmsTouched(row),
    envs.length > 0 && fieldCounts(row?.docsState, row?.docsGraceUntil)
  );
}

/** Lakehouse: a confirmed address plus confirmed instructions. */
export function lakehouseView(row: LinkRow | null): ComponentView {
  return view(
    row,
    !!row && urlComponentAdded(row),
    !!row && urlComponentTouched(row),
    !!row &&
      fieldCounts(row.urlState, row.urlGraceUntil) &&
      fieldCounts(row.docsState, row.docsGraceUntil)
  );
}

/** A tool card counts once its LINK is confirmed (owner directive
 * 2026-08-20, superseding the earlier "link AND instructions" reading):
 * on tool cards the instructions link is informational, and the link
 * alone is the evidence. The singleton components (API proxy, Developer
 * VMs, Lakehouse) keep their two-field gating; only tools changed. */
export function toolCounts(row: LinkRow): boolean {
  return fieldCounts(row.urlState, row.urlGraceUntil);
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

/**
 * The FLAT projection of a SecureView that every SUMMARY surface reads: the
 * step page's closing line and both hub cards.
 *
 * It lives here, in the pure module, so the status bundles and the step
 * page cannot build it differently, and it is a named type so both status
 * bundles declare one shape instead of re-typing six fields twice and
 * drifting apart.
 *
 * ADDED and COUNTING are separate fields because they differ in exactly one
 * state, and that state (added, saved, not counting yet) is the one three
 * surfaces used to report as "not added". It replaced a single collapsed
 * `savedUnverified` boolean that could not say WHICH component it meant,
 * which is what let the lie hide.
 */
export type SecureSummary = {
  /** Both components count. */
  done: boolean;
  /** Exactly one component counts. Never true at the same time as done. */
  partial: boolean;
  /** COUNTING: earning its half right now. */
  apiProxyCounting: boolean;
  devVmsCounting: boolean;
  /** ADDED: the component's PRIMARY input is stored. Always true when the
   * matching *Counting is true. Never write "add X" copy off *Counting. */
  apiProxyAdded: boolean;
  devVmsAdded: boolean;
  /** TOUCHED: ANY input is stored. Decides "nothing listed yet" and nothing
   * else; "add it" is still honest for a touched component, because what is
   * missing is the primary input. Implied by *Added. */
  apiProxyTouched: boolean;
  devVmsTouched: boolean;
  /** Some counted half is inside a grace window and will drop. */
  failing: boolean;
  /** WHICH counted half is riding grace. Carried per component because an
   * impersonal "one address here has stopped answering" binds to whichever
   * component the previous sentence named, which is the half that is NOT
   * failing exactly when the other one is. That is the same
   * pointing-at-the-wrong-component failure this round exists to remove. */
  apiProxyFailing: boolean;
  devVmsFailing: boolean;
};

export function secureSummary(v: SecureView): SecureSummary {
  return {
    done: v.done,
    partial: v.partial,
    apiProxyCounting: v.apiProxy.enabled,
    devVmsCounting: v.devVms.enabled,
    apiProxyAdded: v.apiProxy.added,
    devVmsAdded: v.devVms.added,
    apiProxyTouched: v.apiProxy.touched,
    devVmsTouched: v.devVms.touched,
    failing: v.failing,
    apiProxyFailing: v.apiProxy.failing,
    devVmsFailing: v.devVms.failing,
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
      // Link-only, like toolCounts: a docs grace window must not mark a
      // tool failing when the instructions no longer gate anything.
      failing: toolRows.some(
        (r) => toolCounts(r) && fieldInGrace(r.urlState, r.urlGraceUntil)
      ),
      rows: toolRows,
    },
  };
}
