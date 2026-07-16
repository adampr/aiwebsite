// Governance brain calls (§5.12). Every governance envelope — turns, repairs,
// research distills, standards authoring — goes through buildGovernanceEnvelope
// so the privacy invariant lives in exactly one place:
//
//   DO-NOT-REMOVE INVARIANT: no `requester`, `memoryMode: "do_not_store"`,
//   no `groupName`. Without a requester the brain persists neither facts nor
//   conversation turns, so confidential answers and scraped web content never
//   reach brain_messages/brain_memories (memory poisoning would corrupt Tron
//   on every channel for every visitor). Checked by scripts/governance-tests.
//
// JSON mode (brain v1.95+): response_format {type:"json_object"} short-circuits
// the thinking pipeline to ONE completion on the executor model. The host
// cannot set max_tokens or temperature on this path — output size is bounded
// prompt-side (CAPS.turnOpMarkdownMaxChars).

import { callBrain, newId } from "@aicompany/core/brain/client";
import { extractAnswer } from "@aicompany/core/brain/stream";
import { siteConfig } from "site.config";

export { newId };

export function buildGovernanceEnvelope(opts: {
  sessionId: string; // "gov_<projectId>" | "govres_<projectId>" | "govstd_<slug>"
  promptId: string;
  system: string;
  user: string;
}): Record<string, unknown> {
  return {
    sessionId: opts.sessionId,
    promptId: opts.promptId,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
    brainIdentity: {
      ...(siteConfig.persona.identity as Record<string, unknown>),
      purpose:
        "Tron Netter acting as an AI governance analyst: drafting AI governance documents with a signed-in user from their answers and public research.",
    },
    memoryMode: "do_not_store",
    // NO requester (nothing persists), NO groupName (site-wide rule §5.9).
    markdownMode: "strip",
    disabledTools: [],
    response_format: { type: "json_object" },
    invocation: { maxOrchestratorPhase: 1 },
  };
}

/** GET /health preflight (5 s) — run before every synchronous turn. */
export async function brainHealthy(): Promise<boolean> {
  if (process.env.BRAIN_STUB === "1") return true;
  const base = process.env.BRAIN_BASE_URL || "http://127.0.0.1:3211";
  try {
    const res = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// In-flight concurrency semaphore: the brain is ONE process shared with
// latency-sensitive Twilio voice, so governance never holds more than two
// simultaneous completions regardless of daily budgets. Per-process is exact
// here (single PM2 fork; the detached research script self-limits to
// sequential calls).
let inFlight = 0;
const waiters: (() => void)[] = [];
const MAX_IN_FLIGHT = 2;

async function acquire(): Promise<void> {
  if (inFlight < MAX_IN_FLIGHT) {
    inFlight++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  inFlight++;
}

function release(): void {
  inFlight--;
  const next = waiters.shift();
  if (next) next();
}

/**
 * One governance JSON completion. Returns the raw answer text (JSON expected
 * but not yet parsed) or null on transport/HTTP failure.
 */
export async function callGovernanceBrain(
  envelope: Record<string, unknown>,
  timeoutMs: number
): Promise<string | null> {
  await acquire();
  try {
    const res = await callBrain(siteConfig, envelope, { timeoutMs });
    if (!res.ok) return null;
    const answer = extractAnswer(await res.json());
    return answer?.trim() ? answer : null;
  } catch {
    return null;
  } finally {
    release();
  }
}
