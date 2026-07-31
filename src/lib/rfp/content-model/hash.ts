/**
 * Content hashing.
 *
 * DATA-MODEL.md: "contentHash hashes the CONTENT MODEL the artifact was emitted from, not the file
 * bytes. Two artifacts of the same proposal in different formats must share a hash; if they do
 * not, they were built from different states and rule C2 has been violated."
 *
 * That guarantee only holds if serialization is canonical, so key order and date encoding are
 * pinned here rather than left to JSON.stringify's insertion order.
 */

import { createHash } from "node:crypto";

/** Deterministic JSON: object keys sorted, Dates as ISO strings, undefined dropped. */
export function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[k] = canonicalize(v);
    return out;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function contentHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/**
 * The hash that goes on an Artifact.
 *
 * Deliberately excludes the fields that legitimately differ between two emissions of the same
 * content: the hash itself, and the density mode, which is a presentation decision. Everything
 * that changes WHAT the document says is in scope.
 */
export function resolvedProposalHash(resolved: { contentHash?: string; density?: unknown }): string {
  const { contentHash: _ignored, density: _density, ...rest } = resolved as Record<string, unknown>;
  return contentHash(rest);
}
