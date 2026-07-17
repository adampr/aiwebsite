// Stale-bundle detection (§5.12): a long-lived /governance tab is an SPA
// with a poll loop and runs its deploy-time bundle forever; nothing told
// the user a newer build shipped (owner reports rode exactly this). The
// build script stamps NEXT_PUBLIC_BUILD_ID with a unix epoch (package.json
// "build"; one shell evaluation, so every build worker inlines the SAME
// value, and the watchdog's bare `npm run build` restamps too). The client
// bundle inlines it; the server reads the same inline from its own bundle;
// the view carries the server's value on every poll. Client-safe.

export const BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID ?? "";

/**
 * Pure staleness rule, test-pinned. Fires only when BOTH ids parse as
 * positive integers (dev/next-dev/unset disable detection), the server's
 * is NEWER (a draining old pm2 worker answering one poll has server <
 * client and must never fire - ordering, not equality), and either the
 * gap is comfortably past a deploy window (>= 120s) or two consecutive
 * evaluations disagreed (a tab loaded seconds before a deploy finished).
 */
export function staleBundleSignal(
  clientId: string,
  serverId: string | undefined,
  consecutiveMismatches: number
): boolean {
  if (!clientId || !serverId) return false;
  const c = Number(clientId);
  const s = Number(serverId);
  if (!Number.isInteger(c) || !Number.isInteger(s) || c <= 0 || s <= 0)
    return false;
  if (s <= c) return false;
  return s - c >= 120 || consecutiveMismatches >= 2;
}
