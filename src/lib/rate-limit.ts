type RateLimitEntry = {
  count: number;
  expiresAt: number;
};

const store = new Map<string, RateLimitEntry>();

const CLEANUP_INTERVAL = 60_000;
let lastCleanup = Date.now();

function cleanup() {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL) return;
  lastCleanup = now;
  for (const [key, entry] of store) {
    if (entry.expiresAt < now) store.delete(key);
  }
}

export interface RateLimitConfig {
  /** Window in seconds */
  windowSec: number;
  /** Max requests per window */
  max: number;
}

export function checkRateLimit(
  key: string,
  config: RateLimitConfig
): { allowed: boolean; remaining: number; retryAfterSec: number } {
  cleanup();
  const now = Date.now();
  const entry = store.get(key);

  if (!entry || entry.expiresAt < now) {
    store.set(key, { count: 1, expiresAt: now + config.windowSec * 1000 });
    return { allowed: true, remaining: config.max - 1, retryAfterSec: 0 };
  }

  if (entry.count >= config.max) {
    const retryAfterSec = Math.ceil((entry.expiresAt - now) / 1000);
    return { allowed: false, remaining: 0, retryAfterSec };
  }

  entry.count++;
  return { allowed: true, remaining: config.max - entry.count, retryAfterSec: 0 };
}

export const RATE_LIMITS = {
  oauthStartPerIp: { windowSec: 60, max: 20 },
  // Verification-code sends cost real money (Twilio) — keep these tight.
  textingStartPerUser: { windowSec: 600, max: 3 },
  textingStartPerPhone: { windowSec: 600, max: 3 },
  textingVerifyPerUser: { windowSec: 600, max: 10 },
  smsPromptPerUser: { windowSec: 600, max: 20 },
} as const;
