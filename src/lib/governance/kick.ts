// Research kick (§5.12): the ONE place a research job gets claimed and
// spawned from the web process. Order: kill switch -> deploy marker ->
// global Tavily budget -> atomic claim -> detached spawn. Anything short of
// a claim parks the row in `queued`; the client re-POSTs when the poll says
// the row is reclaimable. GETs never call this.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { governanceEnabled, tavilyDailyCap } from "./config";
import {
  claimResearch,
  deployInProgress,
  isUuid,
  readTodayUsage,
} from "./db";
import { db, schema } from "@/lib/db";
import { and, eq, inArray } from "drizzle-orm";

const RESEARCH_LOG = "/var/log/aiwebsite-governance-research.log";

async function parkQueued(id: string, userId: string | null): Promise<void> {
  const P = schema.governanceProjects;
  const where = userId
    ? and(
        eq(P.id, id),
        eq(P.userId, userId),
        inArray(P.status, ["created", "research_failed"])
      )
    : and(eq(P.id, id), inArray(P.status, ["created", "research_failed"]));
  await db.update(P).set({ status: "queued" }).where(where);
}

function openLog(): number {
  try {
    return fs.openSync(RESEARCH_LOG, "a");
  } catch {
    // Dev box / first boot: fall back next to the other VM-generated files.
    const fallback = path.join(process.cwd(), "data", "governance-research.log");
    fs.mkdirSync(path.dirname(fallback), { recursive: true });
    return fs.openSync(fallback, "a");
  }
}

export type KickOutcome =
  | { status: "researching" }
  | { status: "queued"; reason: "budget" | "deploy" | "disabled" }
  | { status: "refused"; reason: "claim" };

/**
 * Attempt to claim + spawn the detached research job for a project.
 * `userId` binds ownership into the claim; pass null only from trusted
 * script contexts (the daily timer's queued-row kick).
 */
export async function kickResearch(
  id: string,
  userId: string | null
): Promise<KickOutcome> {
  if (!isUuid(id)) return { status: "refused", reason: "claim" };
  if (!governanceEnabled(process.env)) {
    await parkQueued(id, userId);
    return { status: "queued", reason: "disabled" };
  }
  if (deployInProgress()) {
    await parkQueued(id, userId);
    return { status: "queued", reason: "deploy" };
  }
  const usage = await readTodayUsage();
  if (usage.tavilyCalls >= tavilyDailyCap(process.env)) {
    await parkQueued(id, userId);
    return { status: "queued", reason: "budget" };
  }
  const claimed = await claimResearch(id, userId);
  if (!claimed) return { status: "refused", reason: "claim" };

  const tsxBin = path.join(process.cwd(), "node_modules", ".bin", "tsx");
  const script = path.join(process.cwd(), "scripts", "governance-research.ts");
  const fd = openLog();
  try {
    // projectId is UUID-validated above — nothing user-authored reaches argv.
    // Heap-capped: this VM has OOM history and jobs run beside the site.
    spawn(tsxBin, [script, id], {
      detached: true,
      stdio: ["ignore", fd, fd],
      cwd: process.cwd(),
      env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=256" },
    }).unref();
  } finally {
    fs.closeSync(fd);
  }
  return { status: "researching" };
}
