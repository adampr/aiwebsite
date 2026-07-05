// The Brain runs from the packages/brain submodule as a local PM2 process
// (see deploy/ecosystem.config.cjs). It is reached over loopback only. Since
// brain v1.91 the API is fail-closed: every non-Twilio, non-/health endpoint
// requires a Bearer token from BRAIN_API_KEYS (shared via the same .env).
// Only /twilio/* webhook paths are exposed publicly via nginx + the
// Cloudflare tunnel, and those validate Twilio signatures.
const BRAIN_BASE_URL = process.env.BRAIN_BASE_URL || "http://127.0.0.1:3211";
// BRAIN_API_KEYS may hold several comma-separated keys; send the first.
const BRAIN_API_KEY = (process.env.BRAIN_API_KEYS || "").split(",")[0]!.trim();
/** Spread into fetch headers for any brain-api call. Empty when no key is configured. */
export const BRAIN_AUTH_HEADERS: Record<string, string> = BRAIN_API_KEY
  ? { Authorization: `Bearer ${BRAIN_API_KEY}` }
  : {};

interface BrainRequestOptions {
  sessionId: string;
  promptId: string;
  prompt: string;
  brainIdentity: { brainName: string; personality: string; purpose: string };
  groupName?: string;
  responseFormat?: { type: string };
  timeoutMs: number;
  maxAttempts?: number;
}

/**
 * Calls the Brain API with automatic retry on transient failures.
 * Retries up to `maxAttempts` times with increasing backoff delays
 * (0s, 5s, 15s) to survive PM2 memory-restart cycles (~5-10s).
 */
export async function callBrainWithRetry(opts: BrainRequestOptions): Promise<string> {
  const { maxAttempts = 3, timeoutMs } = opts;
  const delays = [0, 5_000, 15_000];

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...BRAIN_AUTH_HEADERS,
  };

  const body = JSON.stringify({
    sessionId: opts.sessionId,
    promptId: opts.promptId,
    messages: [{ role: "user", content: opts.prompt }],
    brainIdentity: opts.brainIdentity,
    groupName: opts.groupName ?? "aiwebsite",
    memoryMode: "none",
    ...(opts.responseFormat && { response_format: opts.responseFormat }),
  });

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (delays[attempt]) await new Promise((r) => setTimeout(r, delays[attempt]));
    try {
      const res = await fetch(`${BRAIN_BASE_URL}/v1/chat/completions`, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`Brain API error: ${res.status}`);
      const data = await res.json();
      return data.choices?.[0]?.message?.content || "";
    } catch (err) {
      if (attempt === maxAttempts - 1) throw err;
      console.warn(
        `[brain-client] Attempt ${attempt + 1} failed, retrying in ${delays[attempt + 1]! / 1000}s: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  throw new Error("callBrainWithRetry: unreachable");
}

/**
 * Polls Brain's /health endpoint to confirm it's responsive.
 * Returns true if Brain responds within the deadline, false otherwise.
 */
export async function waitForBrainReady(maxWaitMs = 60_000, intervalMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  const attempts = Math.ceil(maxWaitMs / intervalMs);

  for (let i = 0; i < attempts && Date.now() < deadline; i++) {
    try {
      const res = await fetch(`${BRAIN_BASE_URL}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) return true;
    } catch {
      // Brain not ready yet
    }
    if (i < attempts - 1 && Date.now() + intervalMs < deadline) {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  return false;
}
