// Apollo.io directory import (§5.18 step 2). The host calls Apollo's REST
// API directly (the module's dormant outreach sourcing is cold-lead tooling
// with its own config surface; this is a client-portal read). Privacy rules:
// persist EXACTLY {name, email, phone} plus the Apollo person id as the
// upsert key; the raw response is never persisted or logged; suppressed
// emails (previously removed by an admin) are skipped and counted.
//
// Failure semantics (ops ruling): fail FAST on any non-OK page (no retry on
// 429 - the 2/h/company limiter is also the double-click fence), KEEP rows
// already upserted, report "partial", and stamp companies.apollo_last_import_*
// only on a COMPLETE run. Hard page cap keeps the whole import inside one
// POST well under proxy timeouts.

import { ROADMAP_CAPS } from "@/lib/roadmap/config";
import {
  sha256Hex,
  stampApolloImport,
  suppressedHashes,
  trySpendApolloCall,
  upsertApolloPerson,
  type DirectoryScope,
} from "@/lib/roadmap/db";

export type ApolloImportResult =
  | { outcome: "not_configured" }
  | { outcome: "api_error" }
  | {
      outcome: "done";
      partial: boolean;
      found: number;
      added: number;
      updated: number;
      keptManual: number;
      skippedSuppressed: number;
      callsUsed: number;
    };

type ApolloPerson = {
  id?: string;
  name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone_numbers?: { sanitized_number?: string | null; raw_number?: string | null }[];
  organization?: { phone?: string | null } | null;
};

function personName(p: ApolloPerson): string | null {
  const name =
    (p.name && p.name.trim()) ||
    [p.first_name, p.last_name].filter(Boolean).join(" ").trim();
  return name || null;
}

/** Apollo masks locked emails with a placeholder; store null instead. */
function personEmail(p: ApolloPerson): string | null {
  const email = (p.email ?? "").trim().toLowerCase();
  if (!email || !email.includes("@")) return null;
  if (email.startsWith("email_not_unlocked")) return null;
  return email;
}

function personPhone(p: ApolloPerson): string | null {
  const n = p.phone_numbers?.[0];
  return n?.sanitized_number || n?.raw_number || null;
}

// Per-lane in-flight dedup (round 3): two tabs auto-kicking at once must
// collapse into ONE Apollo run (upserts are idempotent either way; this
// protects the page budget and the hourly limiter's spirit). Valid because
// this host runs a single PM2 fork (same caveat as the dkim cache). The
// staff lane (companyId null) keys on the "staff" sentinel, which can
// never collide with a company uuid.
const inflightImports = new Map<string, Promise<ApolloImportResult>>();

function laneKey(scope: DirectoryScope): string {
  return scope.companyId ?? "staff";
}

export function runApolloImport(opts: {
  scope: DirectoryScope;
  companyDomain: string;
}): Promise<ApolloImportResult> {
  const key = laneKey(opts.scope);
  const existing = inflightImports.get(key);
  if (existing) return existing;
  const run = runApolloImportInner(opts).finally(() =>
    inflightImports.delete(key)
  );
  inflightImports.set(key, run);
  return run;
}

async function runApolloImportInner(opts: {
  scope: DirectoryScope;
  companyDomain: string;
}): Promise<ApolloImportResult> {
  const key = process.env.APOLLO_API_KEY;
  if (!key) {
    console.log("[roadmap] apollo import refused: APOLLO_API_KEY is not set");
    return { outcome: "not_configured" };
  }

  const suppressed = await suppressedHashes(opts.scope);
  let found = 0;
  let added = 0;
  let updated = 0;
  let keptManual = 0;
  let skippedSuppressed = 0;
  let callsUsed = 0;
  let partial = false;

  for (let page = 1; page <= ROADMAP_CAPS.apolloPagesPerImport; page++) {
    if (!(await trySpendApolloCall())) {
      partial = page > 1;
      if (page === 1) return { outcome: "api_error" };
      break;
    }
    callsUsed++;
    let res: Response | null = null;
    try {
      res = await fetch("https://api.apollo.io/api/v1/mixed_people/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
        },
        body: JSON.stringify({
          q_organization_domains_list: [opts.companyDomain],
          page,
          per_page: ROADMAP_CAPS.apolloPeoplePerPage,
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      res = null;
    }
    if (!res || !res.ok) {
      // Named env var goes to the server log ONLY; the admin-facing copy
      // never mentions it.
      console.log(
        `[roadmap] apollo page ${page} failed${res ? ` (${res.status})` : " (network)"} for lane ${laneKey(opts.scope)}`
      );
      if (page === 1) return { outcome: "api_error" };
      partial = true;
      break;
    }
    const body = (await res.json().catch(() => null)) as {
      people?: ApolloPerson[];
      contacts?: ApolloPerson[];
      pagination?: { page?: number; total_pages?: number };
    } | null;
    // A 200 with an unparseable or shape-less body is a FAILURE, not an
    // empty result: it must never stamp apollo_last_import_at (the stamp is
    // the auto-kick once-flag, and a transient error page would suppress
    // auto-init for the company forever; round-3 refutation finding).
    if (!body || (!Array.isArray(body.people) && !Array.isArray(body.contacts))) {
      console.log(
        `[roadmap] apollo page ${page} returned an unparseable body for lane ${laneKey(opts.scope)}`
      );
      if (page === 1) return { outcome: "api_error" };
      partial = true;
      break;
    }
    const people = [
      ...(body.people ?? []),
      ...(body.contacts ?? []),
    ];
    if (people.length === 0) break;

    for (const p of people) {
      const name = personName(p);
      if (!name || !p.id) continue;
      found++;
      const email = personEmail(p);
      if (email && suppressed.has(sha256Hex(email))) {
        skippedSuppressed++;
        continue;
      }
      const what = await upsertApolloPerson({
        scope: opts.scope,
        apolloId: String(p.id),
        name,
        email,
        phone: personPhone(p),
      });
      if (what === "added") added++;
      else if (what === "updated") updated++;
      else keptManual++;
    }

    const totalPages = body.pagination?.total_pages ?? 1;
    if (page >= totalPages) break;
    if (page === ROADMAP_CAPS.apolloPagesPerImport && totalPages > page) {
      partial = true;
    }
  }

  if (!partial) {
    await stampApolloImport(opts.scope, added + updated + keptManual);
  }
  return {
    outcome: "done",
    partial,
    found,
    added,
    updated,
    keptManual,
    skippedSuppressed,
    callsUsed,
  };
}
