import { BRAIN_INTERNAL_TOOLS_FALLBACK } from "@/lib/tron-netter/persona";

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

// Every internal brain tool is disabled for public Tron Netter channels
// (webchat + SMS): visitors must not browse the web, place calls, or mine
// stored memories through him. The live list from GET /v1/tools covers tools
// added by future brain upgrades; cached per process, falling back to the
// v1.91 snapshot in persona.ts.
let disabledToolsCache: string[] | null = null;
export async function getDisabledBrainTools(): Promise<string[]> {
  if (disabledToolsCache) return disabledToolsCache;
  try {
    const res = await fetch(`${BRAIN_BASE_URL}/v1/tools`, {
      headers: BRAIN_AUTH_HEADERS,
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const data = await res.json();
      const names = (data.tools ?? [])
        .map((t: { name?: string }) => t.name)
        .filter((n: unknown): n is string => typeof n === "string");
      if (names.length) {
        disabledToolsCache = names;
        return names;
      }
    }
  } catch {
    // fall through to the static snapshot
  }
  return BRAIN_INTERNAL_TOOLS_FALLBACK;
}
